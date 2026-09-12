import {
  ConversationIntent,
  ConversationState,
  OrderType,
} from '@restaurant-os/types';
import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_TRANSITIONS,
  CONVERSATION_TTL_MS,
  MENU_PAGE_SIZE,
  ORDER_TYPE_LABELS,
  ReplyAction,
  WHATSAPP_BUTTON_LIMIT,
  WHATSAPP_LIST_ROW_LIMIT,
  canTransitionConversation,
  cartMessage,
  confirmOrderMessage,
  encodeReplyId,
  hasNextPage,
  isConversationExpired,
  orderStatusMessage,
  pageSlice,
  parseReplyId,
  resolveIntent,
  unknownMessage,
} from './conversation';

const ALL_STATES = Object.values(ConversationState);

describe('the conversation state machine (spec 22)', () => {
  it('covers every state', () => {
    // A state missing from the matrix would throw at runtime the first time a
    // customer reached it, which is the worst possible moment to find out.
    expect(Object.keys(CONVERSATION_TRANSITIONS).sort()).toEqual([...ALL_STATES].sort());
  });

  it('lets every state be abandoned back to IDLE', () => {
    // A customer can always give up and start again. A conversation that can
    // get stuck is a conversation that loses an order.
    for (const state of ALL_STATES) {
      expect(canTransitionConversation(state, ConversationState.IDLE), state).toBe(true);
    }
  });

  it('exhaustively rejects the transitions it does not allow', () => {
    // Every state against every state, the same treatment the order state
    // machine gets.
    let rejected = 0;

    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        const allowed = CONVERSATION_TRANSITIONS[from].includes(to);
        expect(canTransitionConversation(from, to), `${from} -> ${to}`).toBe(allowed);
        if (!allowed) rejected += 1;
      }
    }

    // Proves the matrix is actually restrictive rather than accidentally
    // permitting everything.
    expect(rejected).toBeGreaterThan(30);
  });

  it('does not let the bot climb out of a human handoff', () => {
    // Once a person is involved, a bot replying over the top of them is worse
    // than a bot saying nothing.
    for (const to of ALL_STATES) {
      const allowed = to === ConversationState.IDLE;
      expect(canTransitionConversation(ConversationState.HUMAN_HANDOFF, to), to).toBe(allowed);
    }
  });

  it('cannot skip the address when the order is a delivery', () => {
    // ASKING_ADDRESS is reachable only from SELECTING_ORDER_TYPE, so a delivery
    // cannot arrive at confirmation without having been asked.
    // The self-transition is the re-ask after an address we could not use, so
    // it is excluded: what matters is that nothing else leads here.
    const reachesAddress = ALL_STATES.filter(
      (state) =>
        state !== ConversationState.ASKING_ADDRESS &&
        canTransitionConversation(state, ConversationState.ASKING_ADDRESS),
    );
    expect(reachesAddress).toEqual([ConversationState.SELECTING_ORDER_TYPE]);
  });

  it('expires a conversation after a day, matching the service window', () => {
    const now = new Date('2026-09-12T12:00:00Z');
    expect(CONVERSATION_TTL_MS).toBe(86_400_000);
    expect(isConversationExpired(new Date(now.getTime() + 1000), now)).toBe(false);
    expect(isConversationExpired(new Date(now.getTime() - 1000), now)).toBe(true);
    // No session is an expired session, not an error.
    expect(isConversationExpired(null, now)).toBe(true);
  });
});

describe('reply ids', () => {
  it('round-trips', () => {
    const id = encodeReplyId(ReplyAction.ITEM, 'a3f1c2d4');
    expect(id).toBe('item:a3f1c2d4');
    expect(parseReplyId(id)).toEqual({ action: ReplyAction.ITEM, value: 'a3f1c2d4' });
  });

  it('round-trips an action with no value', () => {
    expect(parseReplyId(encodeReplyId(ReplyAction.CHECKOUT))).toEqual({
      action: ReplyAction.CHECKOUT,
    });
  });

  it('keeps a value containing a colon intact', () => {
    // Split on the FIRST colon only; a uuid never contains one today, but an
    // id format that did would otherwise be silently truncated.
    expect(parseReplyId('item:a:b')).toEqual({ action: ReplyAction.ITEM, value: 'a:b' });
  });

  it('refuses an id it did not write', () => {
    // A tap we cannot read must be UNKNOWN, never mistaken for something else.
    expect(parseReplyId('nonsense:1')).toBeNull();
    expect(parseReplyId('')).toBeNull();
    expect(parseReplyId(null)).toBeNull();
    expect(parseReplyId(undefined)).toBeNull();
  });
});

describe('resolveIntent', () => {
  const idle = ConversationState.IDLE;

  it('reads a tap from its id, not from its label', () => {
    // WhatsApp sends the row's title as the text of an interactive reply, so a
    // row labelled "Cancel my order" would otherwise be read twice.
    const resolved = resolveIntent(
      { text: 'Cancel my order', replyId: encodeReplyId(ReplyAction.ITEM, 'burger-1') },
      idle,
    );

    expect(resolved.intent).toBe(ConversationIntent.ADD_TO_CART);
    expect(resolved.reply?.value).toBe('burger-1');
  });

  it('greets in English and in Roman Urdu', () => {
    for (const text of ['Hi', 'hello', 'Assalam o Alaikum', 'AOA', 'salam']) {
      expect(resolveIntent({ text }, idle).intent, text).toBe(ConversationIntent.GREETING);
    }
  });

  it('understands a menu request in Roman Urdu', () => {
    // The spec never mentions language; in this market customers write
    // "menu dikhao" far more often than clean English (plan 2.3).
    for (const text of ['menu', 'menu dikhao', 'khana', 'order karna hai']) {
      expect(resolveIntent({ text }, idle).intent, text).toBe(ConversationIntent.BROWSE_MENU);
    }
  });

  it('understands a tracking request in Roman Urdu', () => {
    for (const text of ['track', 'mera order kahan hai', 'order kidhar hai', 'status']) {
      expect(resolveIntent({ text }, idle).intent, text).toBe(ConversationIntent.TRACK_ORDER);
    }
  });

  it('asks for a person when the customer does', () => {
    for (const text of ['agent', 'I want to talk to a human', 'manager se baat karni hai']) {
      expect(resolveIntent({ text }, idle).intent, text).toBe(ConversationIntent.HUMAN_HANDOFF);
    }
  });

  it('treats a bare number as a quantity while building a cart', () => {
    const resolved = resolveIntent({ text: '3' }, ConversationState.BUILDING_CART);
    expect(resolved.intent).toBe(ConversationIntent.ADD_TO_CART);
    expect(resolved.reply).toEqual({ action: ReplyAction.QUANTITY, value: '3' });
  });

  it('treats the same number as an order type while choosing one', () => {
    // The state is what makes "1" readable at all.
    const resolved = resolveIntent({ text: '1' }, ConversationState.SELECTING_ORDER_TYPE);
    expect(resolved.intent).toBe(ConversationIntent.SELECT_ORDER_TYPE);
    expect(resolved.reply?.value).toBe(OrderType.DELIVERY);
  });

  it('takes anything typed at the address prompt as the address', () => {
    // "House 5, Street 2, Phase 4" must not be read as a menu search for
    // "phase", which is exactly what a stateless matcher would do.
    const resolved = resolveIntent(
      { text: 'House 5, Street 2, Phase 4, DHA' },
      ConversationState.ASKING_ADDRESS,
    );

    expect(resolved.intent).toBe(ConversationIntent.PROVIDE_ADDRESS);
    expect(resolved.query).toBe('House 5, Street 2, Phase 4, DHA');
  });

  it('still lets the customer escape the address prompt', () => {
    expect(resolveIntent({ text: 'cancel' }, ConversationState.ASKING_ADDRESS).intent).toBe(
      ConversationIntent.CANCEL,
    );
    expect(resolveIntent({ text: 'agent please' }, ConversationState.ASKING_ADDRESS).intent).toBe(
      ConversationIntent.HUMAN_HANDOFF,
    );
  });

  it('reads "yes" as confirmation only where a confirmation was asked for', () => {
    expect(resolveIntent({ text: 'yes' }, ConversationState.CONFIRMING_ORDER).intent).toBe(
      ConversationIntent.CONFIRM,
    );
    expect(resolveIntent({ text: 'haan' }, ConversationState.CONFIRMING_ORDER).intent).toBe(
      ConversationIntent.CONFIRM,
    );
    // Elsewhere it is just a hello, not an order being placed.
    expect(resolveIntent({ text: 'yes' }, idle).intent).not.toBe(ConversationIntent.CONFIRM);
  });

  it('reads "confirm" at the confirmation step as a confirmation, not a checkout', () => {
    expect(resolveIntent({ text: 'confirm' }, ConversationState.CONFIRMING_ORDER).intent).toBe(
      ConversationIntent.CONFIRM,
    );
    expect(resolveIntent({ text: 'checkout' }, ConversationState.BUILDING_CART).intent).toBe(
      ConversationIntent.CHECKOUT,
    );
  });

  it('searches the menu for a dish name while browsing', () => {
    const resolved = resolveIntent({ text: 'chicken tikka' }, ConversationState.BROWSING_MENU);
    expect(resolved.intent).toBe(ConversationIntent.SEARCH_MENU);
    expect(resolved.query).toBe('chicken tikka');
  });

  it('gives up rather than guessing', () => {
    // A wrong guess in an ordering flow costs an order; UNKNOWN costs a
    // sentence that lists what the bot can do.
    expect(resolveIntent({ text: '???' }, ConversationState.CONFIRMING_ORDER).intent).toBe(
      ConversationIntent.UNKNOWN,
    );
    expect(unknownMessage()).toContain('menu');
  });
});

describe('WhatsApp interactive limits (plan 2.2)', () => {
  it('leaves a row free for "show more"', () => {
    // Exceeding ten rows makes the provider reject the whole message, so the
    // customer sees nothing at all rather than a truncated list.
    expect(WHATSAPP_LIST_ROW_LIMIT).toBe(10);
    expect(MENU_PAGE_SIZE).toBe(9);
    expect(WHATSAPP_BUTTON_LIMIT).toBe(3);
  });

  it('pages a long menu without dropping an item', () => {
    const items = Array.from({ length: 23 }, (_, index) => index);

    expect(pageSlice(items, 0)).toHaveLength(9);
    expect(pageSlice(items, 1)).toHaveLength(9);
    expect(pageSlice(items, 2)).toHaveLength(5);
    expect([...pageSlice(items, 0), ...pageSlice(items, 1), ...pageSlice(items, 2)]).toEqual(items);
  });

  it('knows when there is another page', () => {
    expect(hasNextPage(23, 0)).toBe(true);
    expect(hasNextPage(23, 2)).toBe(false);
    expect(hasNextPage(9, 0)).toBe(false);
  });
});

describe('what the customer reads', () => {
  const cart = {
    lines: [
      { name: 'Chicken Burger', quantity: 2, lineTotal: '900.00' },
      { name: 'Fries', quantity: 1, lineTotal: '250.00' },
    ],
    subtotal: '1150.00',
    deliveryFee: '150.00',
    tax: '0.00',
    total: '1300.00',
    currency: 'PKR',
  };

  it('itemises the cart with the totals the server computed', () => {
    const message = cartMessage(cart);
    expect(message).toContain('2 x Chicken Burger');
    expect(message).toContain('PKR 1300.00');
    expect(message).toContain('Delivery: PKR 150.00');
  });

  it('omits a zero line rather than showing it', () => {
    // "Tax: PKR 0.00" invites a question nobody needs to answer.
    expect(cartMessage(cart)).not.toContain('Tax:');
    expect(cartMessage({ ...cart, deliveryFee: '0.00' })).not.toContain('Delivery:');
  });

  it('says the payment method before asking for confirmation', () => {
    const message = confirmOrderMessage(cart, ORDER_TYPE_LABELS.DELIVERY!);
    expect(message).toContain('Delivery');
    expect(message).toContain('cash on delivery');
    expect(message).toContain('PKR 1300.00');
  });

  it('describes an order in words, not in status codes', () => {
    // "ACCEPTED" means nothing to somebody waiting for food.
    expect(orderStatusMessage('DHA-0042', 'OUT_FOR_DELIVERY')).toContain('on its way');
    expect(orderStatusMessage('DHA-0042', 'READY')).toContain('ready');
    expect(orderStatusMessage('DHA-0042', 'CONFIRMED')).not.toContain('CONFIRMED');
  });

  it('says something sensible about a status it has no wording for', () => {
    expect(orderStatusMessage('DHA-0042', 'SOMETHING_NEW')).toContain('DHA-0042');
  });
});
