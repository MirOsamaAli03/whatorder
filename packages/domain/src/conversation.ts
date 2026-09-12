import {
  ConversationIntent,
  ConversationState,
  OrderType,
} from '@restaurant-os/types';

/**
 * The WhatsApp conversation engine's rules (ENGINEERING_SPEC.md 21, 22, 23).
 *
 * Pure functions, for the same reason the order state machine is: what a
 * message *means* and where a conversation may go next are decisions worth
 * testing exhaustively, and neither needs a database, a provider or a clock.
 *
 * ENGINEERING_SPEC.md §21 is the constraint that shapes all of this —
 * "WhatsApp-specific code must not contain core order business logic". So
 * nothing here prices anything, checks availability, or decides what an order
 * costs. This layer decides only which *command* the customer just issued; the
 * cart and order services then validate and execute it exactly as they do for
 * the POS and the dashboard.
 *
 * Phase 6 is deliberately deterministic — no model in the path. Plan §2.2: a
 * tapped list row is more reliable, cheaper and faster than classifying free
 * text, and the channel keeps working when the LLM is down. Phase 11's AI layer
 * becomes a *fallback* for text this file returns UNKNOWN for, and produces the
 * same intents validated by the same services.
 */

// ---------------------------------------------------------------------------
// Where a conversation may go
// ---------------------------------------------------------------------------

/**
 * Legal state transitions, as data rather than as branching code.
 *
 * The same technique as ORDER_TRANSITIONS, and for the same reason: a matrix
 * can be tested exhaustively — every state against every state — where a tree
 * of `if` statements can only be tested where somebody thought to look.
 *
 * Every state may return to IDLE, because a customer can always abandon what
 * they were doing and start again, and a conversation that could get stuck is
 * a conversation that loses an order.
 */
export const CONVERSATION_TRANSITIONS: Readonly<
  Record<ConversationState, readonly ConversationState[]>
> = {
  [ConversationState.IDLE]: [
    ConversationState.BROWSING_MENU,
    ConversationState.BUILDING_CART,
    ConversationState.TRACKING_ORDER,
    ConversationState.RESERVATION_FLOW,
    ConversationState.HUMAN_HANDOFF,
    ConversationState.IDLE,
  ],
  [ConversationState.BROWSING_MENU]: [
    ConversationState.BROWSING_MENU,
    ConversationState.BUILDING_CART,
    ConversationState.TRACKING_ORDER,
    ConversationState.HUMAN_HANDOFF,
    ConversationState.IDLE,
  ],
  [ConversationState.BUILDING_CART]: [
    ConversationState.BROWSING_MENU,
    ConversationState.BUILDING_CART,
    ConversationState.SELECTING_ORDER_TYPE,
    ConversationState.TRACKING_ORDER,
    ConversationState.HUMAN_HANDOFF,
    ConversationState.IDLE,
  ],
  [ConversationState.SELECTING_ORDER_TYPE]: [
    ConversationState.ASKING_ADDRESS,
    ConversationState.CONFIRMING_ORDER,
    // Back to the cart: "actually, add one more thing".
    ConversationState.BUILDING_CART,
    ConversationState.SELECTING_ORDER_TYPE,
    ConversationState.HUMAN_HANDOFF,
    ConversationState.IDLE,
  ],
  [ConversationState.ASKING_ADDRESS]: [
    ConversationState.CONFIRMING_ORDER,
    ConversationState.ASKING_ADDRESS,
    ConversationState.SELECTING_ORDER_TYPE,
    ConversationState.HUMAN_HANDOFF,
    ConversationState.IDLE,
  ],
  [ConversationState.CONFIRMING_ORDER]: [
    // Cash orders go straight to tracking; card orders will stop at
    // AWAITING_PAYMENT once Phase 8 lands.
    ConversationState.TRACKING_ORDER,
    ConversationState.AWAITING_PAYMENT,
    ConversationState.BUILDING_CART,
    ConversationState.CONFIRMING_ORDER,
    ConversationState.HUMAN_HANDOFF,
    ConversationState.IDLE,
  ],
  [ConversationState.AWAITING_PAYMENT]: [
    ConversationState.TRACKING_ORDER,
    ConversationState.AWAITING_PAYMENT,
    ConversationState.HUMAN_HANDOFF,
    ConversationState.IDLE,
  ],
  [ConversationState.TRACKING_ORDER]: [
    ConversationState.BROWSING_MENU,
    ConversationState.TRACKING_ORDER,
    ConversationState.HUMAN_HANDOFF,
    ConversationState.IDLE,
  ],
  [ConversationState.RESERVATION_FLOW]: [
    ConversationState.RESERVATION_FLOW,
    ConversationState.HUMAN_HANDOFF,
    ConversationState.IDLE,
  ],
  /**
   * A handed-off conversation is a dead end for the bot, on purpose.
   *
   * Once a person is involved, the bot replying over the top of them is worse
   * than the bot saying nothing. Only a human ending the handoff returns the
   * conversation to IDLE.
   */
  [ConversationState.HUMAN_HANDOFF]: [ConversationState.IDLE],
};

export function canTransitionConversation(
  from: ConversationState,
  to: ConversationState,
): boolean {
  return CONVERSATION_TRANSITIONS[from].includes(to);
}

/**
 * How long a conversation stays where it was left.
 *
 * Matched to WhatsApp's own 24-hour service window: outside it the bot cannot
 * reply free-form anyway, so a session that outlived the window would resume a
 * half-built cart it has no way to talk about. A customer returning later is
 * greeted afresh, which is also the more honest behaviour — prices and
 * availability have moved on.
 */
export const CONVERSATION_TTL_MS = 24 * 60 * 60 * 1000;

export function isConversationExpired(expiresAt: Date | null, now: Date): boolean {
  if (!expiresAt) return true;
  return expiresAt.getTime() <= now.getTime();
}

// ---------------------------------------------------------------------------
// Reply ids
// ---------------------------------------------------------------------------

/**
 * The ids carried by interactive list rows and reply buttons.
 *
 * WhatsApp hands back the `id` of whatever the customer tapped, and that id is
 * the entire reason this phase needs no language understanding: the customer
 * does not type "the chicken burger please", they tap a row whose id already
 * names the menu item.
 *
 * Encoded and parsed in one place so the two halves cannot drift — a message
 * built with one spelling and read with another fails silently, as an
 * unrecognised tap.
 */
export const ReplyAction = {
  CATEGORY: 'cat',
  ITEM: 'item',
  QUANTITY: 'qty',
  ORDER_TYPE: 'type',
  VIEW_CART: 'cart',
  CHECKOUT: 'checkout',
  CONFIRM: 'confirm',
  CANCEL: 'cancel',
  BROWSE: 'browse',
  TRACK: 'track',
  HANDOFF: 'agent',
  MORE: 'more',
} as const;
export type ReplyAction = (typeof ReplyAction)[keyof typeof ReplyAction];

export interface ParsedReply {
  action: ReplyAction;
  /** The id or value after the action, when there is one. */
  value?: string;
}

export function encodeReplyId(action: ReplyAction, value?: string): string {
  return value === undefined ? action : `${action}:${value}`;
}

export function parseReplyId(id: string | null | undefined): ParsedReply | null {
  if (!id) return null;

  const separator = id.indexOf(':');
  const action = (separator === -1 ? id : id.slice(0, separator)) as ReplyAction;

  if (!Object.values(ReplyAction).includes(action)) return null;

  const value = separator === -1 ? undefined : id.slice(separator + 1);
  return value ? { action, value } : { action };
}

// ---------------------------------------------------------------------------
// What the customer just said
// ---------------------------------------------------------------------------

/**
 * One inbound message, stripped of everything provider-specific.
 *
 * The normalizer produces this; nothing downstream of it knows what a Meta
 * payload looks like (ENGINEERING_SPEC.md 21).
 */
export interface NormalizedInput {
  /** The message text, or the title of the row or button that was tapped. */
  text: string;
  /** The id of the tapped row or button, when the customer tapped one. */
  replyId?: string | null;
}

/**
 * Keyword fallbacks for a customer who types instead of tapping.
 *
 * Roman Urdu is listed alongside English deliberately (plan §2.3, which the
 * spec omits entirely): in this market customers write "menu dikhao" and
 * "mera order kahan hai" far more often than they write clean English, and a
 * bot that only understands English reads as a bot that does not work.
 *
 * Matched as whole words against a lower-cased message. This is not language
 * understanding and does not pretend to be — it covers the handful of things
 * people type instead of tapping, and anything else returns UNKNOWN so the
 * reply can offer the buttons again rather than guess.
 */
const KEYWORDS: ReadonlyArray<{ intent: ConversationIntent; words: readonly string[] }> = [
  // ORDER MATTERS: the first entry whose word appears wins, so the list runs
  // from most specific to least. "mera order kahan hai" contains both "order"
  // and "kahan", and reading it as a menu request because BROWSE_MENU came
  // first is exactly the kind of thing that makes a bot feel broken.
  {
    intent: ConversationIntent.HUMAN_HANDOFF,
    words: ['agent', 'human', 'person', 'complaint', 'manager', 'baat', 'help'],
  },
  {
    intent: ConversationIntent.TRACK_ORDER,
    words: ['track', 'status', 'where', 'kahan', 'kidhar'],
  },
  {
    intent: ConversationIntent.CANCEL,
    words: ['cancel', 'stop', 'no', 'nahi', 'nahin'],
  },
  {
    intent: ConversationIntent.CHECKOUT,
    words: ['checkout', 'confirm', 'place', 'done', 'finish'],
  },
  {
    intent: ConversationIntent.VIEW_CART,
    words: ['cart', 'basket', 'total'],
  },
  {
    // "order" lives here rather than with tracking because "order karna hai"
    // ("I want to order") is far commoner than a bare "order" meaning an
    // existing one — and anything asking *where* an order is has already
    // matched above.
    intent: ConversationIntent.BROWSE_MENU,
    words: ['menu', 'order', 'food', 'khana', 'dikhao', 'kya', 'list'],
  },
  {
    // Last, because it is the least specific: "hi, menu dikhao" is a menu
    // request, not a greeting.
    intent: ConversationIntent.GREETING,
    words: ['hi', 'hello', 'hey', 'salam', 'salaam', 'assalam', 'assalamualaikum', 'aoa', 'start'],
  },
];

/** Maps a tapped reply id to the intent it represents. */
const REPLY_INTENTS: Readonly<Record<ReplyAction, ConversationIntent>> = {
  [ReplyAction.CATEGORY]: ConversationIntent.BROWSE_MENU,
  [ReplyAction.ITEM]: ConversationIntent.ADD_TO_CART,
  [ReplyAction.QUANTITY]: ConversationIntent.ADD_TO_CART,
  [ReplyAction.ORDER_TYPE]: ConversationIntent.SELECT_ORDER_TYPE,
  [ReplyAction.VIEW_CART]: ConversationIntent.VIEW_CART,
  [ReplyAction.CHECKOUT]: ConversationIntent.CHECKOUT,
  [ReplyAction.CONFIRM]: ConversationIntent.CONFIRM,
  [ReplyAction.CANCEL]: ConversationIntent.CANCEL,
  [ReplyAction.BROWSE]: ConversationIntent.BROWSE_MENU,
  [ReplyAction.TRACK]: ConversationIntent.TRACK_ORDER,
  [ReplyAction.HANDOFF]: ConversationIntent.HUMAN_HANDOFF,
  [ReplyAction.MORE]: ConversationIntent.BROWSE_MENU,
};

export interface ResolvedIntent {
  intent: ConversationIntent;
  /** The parsed reply, when the customer tapped rather than typed. */
  reply?: ParsedReply;
  /** Free text worth searching the menu for, on SEARCH_MENU. */
  query?: string;
}

/**
 * What the customer meant.
 *
 * A tap always wins over the text: WhatsApp sends the row's title as the text
 * of an interactive reply, so a row titled "Cancel my order" would otherwise be
 * read twice — once correctly from its id, and once by keyword.
 *
 * The state matters for bare text. While ASKING_ADDRESS, an unrecognised line
 * is the address, not an unknown command; while BUILDING_CART, a bare number is
 * a quantity. Reading either without the state would mean asking the customer
 * to repeat themselves, which is where conversational ordering usually dies.
 */
export function resolveIntent(
  input: NormalizedInput,
  state: ConversationState,
): ResolvedIntent {
  const reply = parseReplyId(input.replyId);
  if (reply) {
    return { intent: REPLY_INTENTS[reply.action], reply };
  }

  const text = input.text.trim();
  const lowered = text.toLowerCase();

  // An address is prose. Anything typed here is the address, except an explicit
  // cancellation — otherwise "House 5, Street 2, Phase 4" would be read as a
  // menu search for "phase".
  if (state === ConversationState.ASKING_ADDRESS && text.length > 0) {
    if (matches(lowered, [ConversationIntent.CANCEL, ConversationIntent.HUMAN_HANDOFF])) {
      return { intent: matchedIntent(lowered)! };
    }
    return { intent: ConversationIntent.PROVIDE_ADDRESS, query: text };
  }

  // A bare number is a list selection or a quantity, depending on where we are.
  if (/^\d{1,2}$/.test(lowered)) {
    if (state === ConversationState.BUILDING_CART) {
      return {
        intent: ConversationIntent.ADD_TO_CART,
        reply: { action: ReplyAction.QUANTITY, value: lowered },
      };
    }
    if (state === ConversationState.SELECTING_ORDER_TYPE) {
      const orderType = ORDER_TYPE_BY_INDEX[lowered];
      if (orderType) {
        return {
          intent: ConversationIntent.SELECT_ORDER_TYPE,
          reply: { action: ReplyAction.ORDER_TYPE, value: orderType },
        };
      }
    }
  }

  const keyword = matchedIntent(lowered);
  if (keyword) {
    // "yes" during confirmation is a confirmation, not a checkout request.
    if (keyword === ConversationIntent.CHECKOUT && state === ConversationState.CONFIRMING_ORDER) {
      return { intent: ConversationIntent.CONFIRM };
    }
    return { intent: keyword };
  }

  if (AFFIRMATIVES.has(lowered)) {
    return {
      intent:
        state === ConversationState.CONFIRMING_ORDER
          ? ConversationIntent.CONFIRM
          : ConversationIntent.GREETING,
    };
  }

  // Long enough to be a dish name rather than a typo, and we are somewhere a
  // search makes sense.
  if (text.length >= 3 && SEARCHABLE_STATES.has(state)) {
    return { intent: ConversationIntent.SEARCH_MENU, query: text };
  }

  return { intent: ConversationIntent.UNKNOWN };
}

const AFFIRMATIVES = new Set(['yes', 'y', 'ok', 'okay', 'haan', 'han', 'ji', 'theek', 'sure']);

const SEARCHABLE_STATES: ReadonlySet<ConversationState> = new Set([
  ConversationState.IDLE,
  ConversationState.BROWSING_MENU,
  ConversationState.BUILDING_CART,
]);

/** Positions in the order-type prompt, so "1" works as well as a tap. */
const ORDER_TYPE_BY_INDEX: Readonly<Record<string, OrderType>> = {
  '1': OrderType.DELIVERY,
  '2': OrderType.PICKUP,
  '3': OrderType.DINE_IN,
};

function matchedIntent(lowered: string): ConversationIntent | null {
  const words = new Set(lowered.split(/[^a-z0-9]+/).filter(Boolean));

  for (const entry of KEYWORDS) {
    if (entry.words.some((word) => words.has(word))) return entry.intent;
  }
  return null;
}

function matches(lowered: string, intents: readonly ConversationIntent[]): boolean {
  const found = matchedIntent(lowered);
  return found !== null && intents.includes(found);
}

// ---------------------------------------------------------------------------
// What the conversation carries between messages
// ---------------------------------------------------------------------------

/**
 * The working state of a conversation (`conversation_sessions.context`).
 *
 * Deliberately small, and deliberately holds *ids* rather than copies. The cart
 * is the cart service's cart; the price is whatever the pricing engine says it
 * is now. Caching either here would be a second source of truth for the two
 * things ENGINEERING_SPEC.md is most emphatic must have only one (§27: never
 * accept a total from the client).
 */
export interface ConversationContext {
  cartId?: string;
  /** The item a quantity is about to be given for. */
  pendingItemId?: string;
  pendingItemName?: string;
  /** The category currently being browsed, for a "more" page. */
  categoryId?: string;
  /** Which page of a long list the customer is on. */
  page?: number;
  /** The order type chosen at checkout, for the confirmation wording. */
  orderType?: string;
  /**
   * The delivery address as the customer typed it.
   *
   * Held here only until checkout, which passes it to the order service to be
   * validated, geocoded and stored. This is the draft, not the record.
   */
  address?: string;
  /** The order just placed, for tracking replies. */
  lastOrderId?: string;
  lastOrderNumber?: string;
  /** Set when the customer asks for a person, so the reply is not repeated. */
  handoffAt?: string;
}

/** WhatsApp's own limits on interactive messages (plan §2.2). */
export const WHATSAPP_LIST_ROW_LIMIT = 10;
export const WHATSAPP_BUTTON_LIMIT = 3;

/**
 * How many rows of content fit on one page.
 *
 * One row of the ten is spent on "Show more" whenever there is a next page, so
 * a full page of content is nine. Getting this wrong means the provider rejects
 * the whole message and the customer sees nothing at all.
 */
export const MENU_PAGE_SIZE = WHATSAPP_LIST_ROW_LIMIT - 1;

export function hasNextPage(total: number, page: number): boolean {
  return total > (page + 1) * MENU_PAGE_SIZE;
}

export function pageSlice<T>(items: readonly T[], page: number): T[] {
  const start = page * MENU_PAGE_SIZE;
  return items.slice(start, start + MENU_PAGE_SIZE);
}

// ---------------------------------------------------------------------------
// What the bot says
// ---------------------------------------------------------------------------

/**
 * The conversation's wording, in one place.
 *
 * Here rather than in the service for the same reason the notification copy is:
 * it is the part most likely to be changed by somebody who is not reading the
 * control flow, and it is worth being able to test what a customer actually
 * sees without standing up a database.
 *
 * Every prompt ends by telling the customer what they can do next. A
 * conversational interface with no visible affordances is a command line
 * nobody was given the manual for.
 */

export interface CartLine {
  name: string;
  quantity: number;
  /** Already formatted, e.g. "1,200.00". Money never becomes a number here. */
  lineTotal: string;
}

export interface CartSummary {
  lines: readonly CartLine[];
  subtotal: string;
  deliveryFee?: string | null;
  tax?: string | null;
  total: string;
  currency: string;
}

export function greetingMessage(restaurantName: string, customerName?: string | null): string {
  const who = customerName ? ` ${customerName}` : '';
  return (
    `Assalam-o-Alaikum${who}! Welcome to ${restaurantName}. ` +
    `I can show you our menu, take your order, or check on an order you have already placed.`
  );
}

export function emptyMenuMessage(restaurantName: string): string {
  return `${restaurantName} has no items on the menu right now. Please try again a little later.`;
}

export function emptyCartMessage(): string {
  return 'Your cart is empty. Tap Browse menu to add something.';
}

export function cartMessage(cart: CartSummary): string {
  if (cart.lines.length === 0) return emptyCartMessage();

  const lines = cart.lines.map(
    (line) => `${line.quantity} x ${line.name} — ${cart.currency} ${line.lineTotal}`,
  );

  const parts = [`Your order so far:`, ...lines, ``, `Subtotal: ${cart.currency} ${cart.subtotal}`];

  // Shown only when non-zero. A "Delivery: PKR 0.00" line on a pickup order
  // invites a question nobody needs to answer.
  if (cart.deliveryFee && cart.deliveryFee !== '0.00') {
    parts.push(`Delivery: ${cart.currency} ${cart.deliveryFee}`);
  }
  if (cart.tax && cart.tax !== '0.00') {
    parts.push(`Tax: ${cart.currency} ${cart.tax}`);
  }

  parts.push(`Total: ${cart.currency} ${cart.total}`);
  return parts.join('\n');
}

export function addedToCartMessage(name: string, quantity: number): string {
  return `Added ${quantity} x ${name}.`;
}

export function askQuantityMessage(name: string): string {
  return `How many ${name} would you like? Reply with a number, or tap one below.`;
}

export function askOrderTypeMessage(): string {
  return 'How would you like your order?';
}

export function askAddressMessage(): string {
  return 'Please send your delivery address — house or flat number, street, and area.';
}

export function confirmOrderMessage(cart: CartSummary, orderTypeLabel: string): string {
  return (
    `${cartMessage(cart)}\n\n` +
    `${orderTypeLabel}. Payment is cash on delivery.\n` +
    `Shall I place this order?`
  );
}

export function orderPlacedMessage(orderNumber: string, total: string, currency: string): string {
  return (
    `Your order ${orderNumber} is placed. Total ${currency} ${total}, payable in cash.\n` +
    `We will message you as it progresses. Reply "track" any time to check on it.`
  );
}

/**
 * Where an order has got to, in words a customer understands.
 *
 * Deliberately not the raw status. "ACCEPTED" means nothing to somebody waiting
 * for food, and PREPARING and ACCEPTED are the same news to them.
 */
export function orderStatusMessage(orderNumber: string, status: string): string {
  const wording: Record<string, string> = {
    DRAFT: 'is not placed yet',
    PENDING_PAYMENT: 'is waiting for payment',
    CONFIRMED: 'has been received and is awaiting the kitchen',
    ACCEPTED: 'has been accepted and is being prepared',
    PREPARING: 'is being prepared now',
    READY: 'is ready',
    OUT_FOR_DELIVERY: 'is on its way to you',
    DELIVERED: 'has been delivered',
    COMPLETED: 'is complete',
    CANCELLED: 'has been cancelled',
    REJECTED: 'could not be accepted',
    DELIVERY_FAILED: 'could not be delivered — we will be in touch',
  };

  return `Order ${orderNumber} ${wording[status] ?? 'is being looked at'}.`;
}

export function noOrdersMessage(): string {
  return 'I cannot find a recent order for this number. Tap Browse menu to place one.';
}

export function handoffMessage(restaurantName: string): string {
  return (
    `I have passed this conversation to the team at ${restaurantName}. ` +
    `Somebody will reply here shortly.`
  );
}

export function cancelledMessage(): string {
  return 'No problem — I have cleared that. Tap Browse menu whenever you are ready.';
}

/**
 * The reply when nothing matched.
 *
 * It says what it *can* do rather than apologising, because a customer who is
 * told only that they were not understood has no idea what to try next.
 */
export function unknownMessage(): string {
  return (
    'Sorry, I did not catch that. I can show you the menu, take your order, ' +
    'check an order for you, or put you through to the team.'
  );
}

export function itemUnavailableMessage(name: string): string {
  return `Sorry, ${name} is not available right now. Please pick something else.`;
}

export function noSearchResultsMessage(query: string): string {
  return `I could not find anything matching "${query}". Tap Browse menu to see everything we have.`;
}

/** Labels for the order-type prompt, in the order the buttons appear. */
export const ORDER_TYPE_LABELS: Readonly<Record<string, string>> = {
  DELIVERY: 'Delivery',
  PICKUP: 'Pickup',
  DINE_IN: 'Dine in',
};
