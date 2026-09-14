import { Injectable, Logger } from '@nestjs/common';
import type { TransactionClient } from '@restaurant-os/database';
import {
  CONVERSATION_TTL_MS,
  ORDER_TYPE_LABELS,
  ReplyAction,
  addedToCartMessage,
  askAddressMessage,
  askOrderTypeMessage,
  askQuantityMessage,
  cancelledMessage,
  cartMessage,
  confirmOrderMessage,
  emptyCartMessage,
  emptyMenuMessage,
  encodeReplyId,
  greetingMessage,
  handoffMessage,
  hasNextPage,
  isConversationExpired,
  itemUnavailableMessage,
  noOrdersMessage,
  noSearchResultsMessage,
  orderPlacedMessage,
  orderStatusMessage,
  pageSlice,
  resolveIntent,
  unknownMessage,
  type CartSummary,
  type ConversationContext,
  type NormalizedInput,
} from '@restaurant-os/domain';
import {
  ConversationChannel,
  ConversationIntent,
  ConversationState,
  MenuItemAvailability,
  OrderSource,
  OrderType,
  PaymentMethod,
  type AuthContext,
} from '@restaurant-os/types';
import { buttonsMessage, listMessage, textMessage, type OutboundMessage } from '@restaurant-os/whatsapp';
import { randomUUID } from 'node:crypto';
import { CartService } from '../cart/cart.service';
import { getRequestId, runWithRequestContext } from '../common/request-context';
import { MenuService } from '../menu/menu.service';
import { OrdersService } from '../orders/orders.service';
import { PrismaService } from '../prisma/prisma.service';
import { BotIdentityService } from './bot-identity.service';

/** One inbound message, already routed to a tenant and a branch. */
export interface ConversationTurn {
  tenantId: string;
  branchId: string;
  /** The customer's number in E.164 — their identity on this channel. */
  contactNumber: string;
  text: string;
  replyId?: string | null;
}

/**
 * The WhatsApp conversation engine (ENGINEERING_SPEC.md 21, 22, 23).
 *
 * ## What it is not
 *
 * It contains no order logic. It does not price anything, does not decide
 * whether a dish is available, does not compute a total and does not choose an
 * order's status. Every one of those is asked of CartService, MenuService and
 * OrdersService — the same services the dashboard and the POS call — which is
 * §21's "WhatsApp-specific code must not contain core order business logic" and
 * §87's ban on a parallel `WhatsAppOrderService`, enforced by there simply not
 * being anywhere else for the logic to live.
 *
 * What it does own is the *conversation*: what the customer just asked for,
 * what to say back, and where that leaves them. Those decisions are in
 * @restaurant-os/domain, tested without a database.
 *
 * ## Deterministic, by choice
 *
 * No model is in this path (plan §2.2). A customer taps a row whose id already
 * names the menu item, so the common case needs no language understanding at
 * all — it is faster, cheaper, and it keeps working when an LLM is down. Phase
 * 11 adds a model as a *fallback* for the text this engine returns UNKNOWN for,
 * producing the same intents, validated by the same services, executing as the
 * same narrowly-scoped principal.
 *
 * ## Replies are returned, not sent
 *
 * `handle` produces messages; the caller sends them. That keeps the whole
 * engine testable without a provider, and means a send failure is handled in
 * one place rather than at every branch of the conversation.
 */
@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bot: BotIdentityService,
    private readonly menu: MenuService,
    private readonly cart: CartService,
    private readonly orders: OrdersService,
  ) {}

  async handle(turn: ConversationTurn): Promise<OutboundMessage[]> {
    const auth = await this.bot.contextFor(turn.tenantId, turn.branchId);

    /**
     * The rest of the turn runs as the bot.
     *
     * The webhook is a public route, so the ambient request context carries no
     * caller — and AuditService reads the actor from exactly there. Without
     * this, every order a customer placed over WhatsApp would be audited with a
     * null actor: the one channel taking instructions from the public internet
     * would be the one with no attribution.
     *
     * Entering the context here rather than threading an actor through every
     * service call also means anything else that reads the ambient caller —
     * log enrichment, the outbox's actor column — sees the same principal.
     */
    return runWithRequestContext(
      { requestId: getRequestId() ?? randomUUID(), auth },
      () => this.turn(auth, turn),
    );
  }

  private async turn(auth: AuthContext, turn: ConversationTurn): Promise<OutboundMessage[]> {
    const session = await this.loadSession(turn);

    // A handed-off conversation is deliberately silent. Once a person is
    // involved, a bot replying over the top of them is worse than a bot saying
    // nothing at all, and a customer who has asked for help does not want to be
    // answered by the thing they gave up on.
    if (session.state === ConversationState.HUMAN_HANDOFF) {
      await this.touch(turn, session.id);
      return [];
    }

    const input: NormalizedInput = { text: turn.text, replyId: turn.replyId };
    const resolved = resolveIntent(input, session.state, session.context);

    try {
      const outcome = await this.dispatch(auth, turn, session, resolved);

      // Derived from the messages actually going out, rather than set by each
      // handler. Nine call sites would each have to remember, and the one that
      // forgot would leave a customer typing "2" at a list that silently
      // resolved against whatever was on screen two turns ago.
      await this.save(turn, session.id, outcome.state, {
        ...outcome.context,
        shownReplyIds: shownReplyIdsFrom(outcome.messages),
      });

      return outcome.messages;
    } catch (error) {
      // A failure here is a conversation that stops mid-order, which the
      // customer experiences as the restaurant ignoring them. Say something,
      // and keep the session where it was so they can retry.
      this.logger.error(
        { err: error, tenantId: turn.tenantId, intent: resolved.intent },
        'Conversation turn failed',
      );

      return [
        textMessage(
          turn.contactNumber,
          'Sorry, something went wrong on our side. Please try again, or reply "agent" to reach the team.',
        ),
      ];
    }
  }

  // -------------------------------------------------------------------------
  // Intent dispatch
  // -------------------------------------------------------------------------

  private async dispatch(
    auth: AuthContext,
    turn: ConversationTurn,
    session: LoadedSession,
    resolved: ReturnType<typeof resolveIntent>,
  ): Promise<Outcome> {
    const context = session.context;

    switch (resolved.intent) {
      case ConversationIntent.GREETING:
        return this.greet(auth, turn, context);

      case ConversationIntent.BROWSE_MENU:
        return this.browse(auth, turn, context, resolved.reply);

      case ConversationIntent.SEARCH_MENU:
        return this.search(auth, turn, context, resolved.query ?? '');

      case ConversationIntent.ADD_TO_CART:
        return this.add(auth, turn, context, resolved.reply);

      case ConversationIntent.VIEW_CART:
        return this.showCart(auth, turn, context);

      case ConversationIntent.CHECKOUT:
        return this.startCheckout(auth, turn, context);

      case ConversationIntent.SELECT_ORDER_TYPE:
        return this.selectOrderType(auth, turn, context, resolved.reply?.value);

      case ConversationIntent.PROVIDE_ADDRESS:
        return this.provideAddress(auth, turn, context, resolved.query ?? '');

      case ConversationIntent.CONFIRM:
        return this.placeOrder(auth, turn, context);

      case ConversationIntent.CANCEL:
        return {
          state: ConversationState.IDLE,
          // The cart is left where it is rather than deleted: it expires on its
          // own, and a customer who changes their mind back has not lost it.
          context: { lastOrderId: context.lastOrderId, lastOrderNumber: context.lastOrderNumber },
          messages: [textMessage(turn.contactNumber, cancelledMessage()), this.mainMenu(turn)],
        };

      case ConversationIntent.TRACK_ORDER:
        return this.track(auth, turn, context);

      case ConversationIntent.HUMAN_HANDOFF:
        return this.handoff(auth, turn, context);

      default:
        return {
          state: session.state,
          context,
          messages: [textMessage(turn.contactNumber, unknownMessage()), this.mainMenu(turn)],
        };
    }
  }

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  private async greet(
    auth: AuthContext,
    turn: ConversationTurn,
    context: ConversationContext,
  ): Promise<Outcome> {
    const [organization, customer] = await Promise.all([
      this.organization(auth),
      this.findCustomer(auth, turn.contactNumber),
    ]);

    return {
      state: ConversationState.IDLE,
      context,
      messages: [
        textMessage(turn.contactNumber, greetingMessage(organization.name, customer?.name)),
        this.mainMenu(turn),
      ],
    };
  }

  /**
   * Shows the menu: categories first, then the items in one.
   *
   * A restaurant with a single category skips straight to its items — making
   * somebody tap through a list of one is the kind of thing that reads as a bot
   * written by somebody who never used it.
   */
  private async browse(
    auth: AuthContext,
    turn: ConversationTurn,
    context: ConversationContext,
    reply?: { action: string; value?: string },
  ): Promise<Outcome> {
    const menu = await this.menu.getMenu(auth, { branchId: turn.branchId });

    const categories = menu.categories.filter((category) =>
      category.items.some((item) => this.orderable(item)),
    );
    const loose = menu.uncategorized.filter((item) => this.orderable(item));

    if (categories.length === 0 && loose.length === 0) {
      const organization = await this.organization(auth);
      return {
        state: ConversationState.IDLE,
        context,
        messages: [textMessage(turn.contactNumber, emptyMenuMessage(organization.name))],
      };
    }

    // "Show more" keeps the category and advances the page.
    const paging = reply?.action === ReplyAction.MORE;
    const categoryId = paging ? context.categoryId : reply?.value;
    const page = paging ? (context.page ?? 0) + 1 : 0;

    const chosen = categoryId
      ? categories.find((category) => category.id === categoryId)
      : categories.length === 1
        ? categories[0]
        : null;

    if (!chosen && categories.length > 0) {
      return {
        state: ConversationState.BROWSING_MENU,
        context: { ...context, categoryId: undefined, page: 0 },
        messages: [
          listMessage({
            to: turn.contactNumber,
            body: 'Here is what we have. Pick a section to see the dishes.',
            buttonLabel: 'View menu',
            sections: [
              {
                title: 'Menu',
                rows: numberedRows(
                  pageSlice(categories, 0).map((category) => ({
                    id: encodeReplyId(ReplyAction.CATEGORY, category.id),
                    title: category.name,
                    ...(category.description ? { description: category.description } : {}),
                  })),
                ),
              },
            ],
          }),
        ],
      };
    }

    const items = (chosen ? chosen.items : loose).filter((item) => this.orderable(item));
    const rows = pageSlice(items, page).map((item) => ({
      id: encodeReplyId(ReplyAction.ITEM, item.id),
      title: item.name,
      description: `${item.currency} ${item.price}`,
    }));

    if (hasNextPage(items.length, page)) {
      rows.push({
        id: encodeReplyId(ReplyAction.MORE),
        title: 'Show more',
        description: 'See the rest of this section',
      });
    }

    return {
      state: ConversationState.BROWSING_MENU,
      context: { ...context, categoryId: chosen?.id, page },
      messages: [
        listMessage({
          to: turn.contactNumber,
          body: chosen
            ? `${chosen.name} — tap a dish, or reply with its number.`
            : 'Tap a dish, or reply with its number.',
          buttonLabel: 'View dishes',
          sections: [{ title: chosen?.name ?? 'Menu', rows: numberedRows(rows) }],
        }),
      ],
    };
  }

  private async search(
    auth: AuthContext,
    turn: ConversationTurn,
    context: ConversationContext,
    query: string,
  ): Promise<Outcome> {
    const menu = await this.menu.getMenu(auth, { branchId: turn.branchId });

    const needle = query.toLowerCase();
    const matches = [...menu.categories.flatMap((category) => category.items), ...menu.uncategorized]
      .filter((item) => this.orderable(item))
      .filter((item) => item.name.toLowerCase().includes(needle));

    if (matches.length === 0) {
      return {
        state: ConversationState.BROWSING_MENU,
        context,
        messages: [
          textMessage(turn.contactNumber, noSearchResultsMessage(query)),
          this.mainMenu(turn),
        ],
      };
    }

    return {
      state: ConversationState.BROWSING_MENU,
      context: { ...context, page: 0, categoryId: undefined },
      messages: [
        listMessage({
          to: turn.contactNumber,
          body: `Here is what I found for "${query}".`,
          buttonLabel: 'View dishes',
          sections: [
            {
              title: 'Matches',
              rows: numberedRows(
                pageSlice(matches, 0).map((item) => ({
                  id: encodeReplyId(ReplyAction.ITEM, item.id),
                  title: item.name,
                  description: `${item.currency} ${item.price}`,
                })),
              ),
            },
          ],
        }),
      ],
    };
  }

  /**
   * Adds a dish — in two steps, because a quantity has to come from somewhere.
   *
   * Tapping a dish sets it aside and asks how many; the answer then adds it.
   * The dish is held in the session rather than encoded into the quantity
   * buttons so that a customer who types "3" instead of tapping is understood
   * identically.
   */
  private async add(
    auth: AuthContext,
    turn: ConversationTurn,
    context: ConversationContext,
    reply?: { action: string; value?: string },
  ): Promise<Outcome> {
    if (reply?.action === ReplyAction.ITEM && reply.value) {
      const item = await this.menu.getItem(auth, reply.value, turn.branchId).catch(() => null);

      if (!item || !this.orderable(item)) {
        return {
          state: ConversationState.BROWSING_MENU,
          context,
          messages: [
            textMessage(turn.contactNumber, itemUnavailableMessage(item?.name ?? 'that dish')),
          ],
        };
      }

      return {
        state: ConversationState.BUILDING_CART,
        context: { ...context, pendingItemId: item.id, pendingItemName: item.name },
        messages: [
          buttonsMessage({
            to: turn.contactNumber,
            body: askQuantityMessage(item.name),
            buttons: [
              { id: encodeReplyId(ReplyAction.QUANTITY, '1'), title: '1' },
              { id: encodeReplyId(ReplyAction.QUANTITY, '2'), title: '2' },
              { id: encodeReplyId(ReplyAction.QUANTITY, '3'), title: '3' },
            ],
          }),
        ],
      };
    }

    const quantity = Number(reply?.value ?? '1');
    if (!context.pendingItemId || !Number.isInteger(quantity) || quantity < 1) {
      return this.browse(auth, turn, context);
    }

    const cartId = await this.ensureCart(auth, turn, context);

    // The cart service validates availability and the item's own modifier
    // rules. Nothing here second-guesses it.
    await this.cart.addItem(auth, cartId, {
      menuItemId: context.pendingItemId,
      quantity,
    });

    const summary = await this.cartSummary(auth, cartId);
    const name = context.pendingItemName ?? 'that';

    return {
      state: ConversationState.BUILDING_CART,
      context: {
        ...context,
        cartId,
        pendingItemId: undefined,
        pendingItemName: undefined,
      },
      messages: [
        buttonsMessage({
          to: turn.contactNumber,
          body: `${addedToCartMessage(name, quantity)}\n\n${cartMessage(summary)}`,
          buttons: [
            { id: encodeReplyId(ReplyAction.BROWSE), title: 'Add more' },
            { id: encodeReplyId(ReplyAction.CHECKOUT), title: 'Checkout' },
            { id: encodeReplyId(ReplyAction.CANCEL), title: 'Cancel' },
          ],
        }),
      ],
    };
  }

  private async showCart(
    auth: AuthContext,
    turn: ConversationTurn,
    context: ConversationContext,
  ): Promise<Outcome> {
    if (!context.cartId) {
      return {
        state: ConversationState.IDLE,
        context,
        messages: [textMessage(turn.contactNumber, emptyCartMessage()), this.mainMenu(turn)],
      };
    }

    const summary = await this.cartSummary(auth, context.cartId);

    return {
      state: ConversationState.BUILDING_CART,
      context,
      messages: [
        buttonsMessage({
          to: turn.contactNumber,
          body: cartMessage(summary),
          buttons: [
            { id: encodeReplyId(ReplyAction.BROWSE), title: 'Add more' },
            { id: encodeReplyId(ReplyAction.CHECKOUT), title: 'Checkout' },
            { id: encodeReplyId(ReplyAction.CANCEL), title: 'Cancel' },
          ],
        }),
      ],
    };
  }

  private async startCheckout(
    auth: AuthContext,
    turn: ConversationTurn,
    context: ConversationContext,
  ): Promise<Outcome> {
    if (!context.cartId) {
      return {
        state: ConversationState.IDLE,
        context,
        messages: [textMessage(turn.contactNumber, emptyCartMessage()), this.mainMenu(turn)],
      };
    }

    const summary = await this.cartSummary(auth, context.cartId);
    if (summary.lines.length === 0) {
      return {
        state: ConversationState.IDLE,
        context,
        messages: [textMessage(turn.contactNumber, emptyCartMessage()), this.mainMenu(turn)],
      };
    }

    // Only the order types this branch actually offers. Offering pickup at a
    // delivery-only kitchen wastes a tap and then has to be refused.
    const branch = await this.branch(auth, turn.branchId);
    const buttons = [
      ...(branch.deliveryEnabled
        ? [{ id: encodeReplyId(ReplyAction.ORDER_TYPE, OrderType.DELIVERY), title: 'Delivery' }]
        : []),
      ...(branch.pickupEnabled
        ? [{ id: encodeReplyId(ReplyAction.ORDER_TYPE, OrderType.PICKUP), title: 'Pickup' }]
        : []),
      ...(branch.dineInEnabled
        ? [{ id: encodeReplyId(ReplyAction.ORDER_TYPE, OrderType.DINE_IN), title: 'Dine in' }]
        : []),
    ];

    return {
      state: ConversationState.SELECTING_ORDER_TYPE,
      context,
      messages: [
        buttonsMessage({ to: turn.contactNumber, body: askOrderTypeMessage(), buttons }),
      ],
    };
  }

  private async selectOrderType(
    auth: AuthContext,
    turn: ConversationTurn,
    context: ConversationContext,
    value?: string,
  ): Promise<Outcome> {
    const orderType = value as OrderType | undefined;

    if (!context.cartId || !orderType || !Object.values(OrderType).includes(orderType)) {
      return this.startCheckout(auth, turn, context);
    }

    await this.cart.update(auth, context.cartId, { orderType });

    if (orderType === OrderType.DELIVERY) {
      return {
        state: ConversationState.ASKING_ADDRESS,
        context: { ...context, orderType },
        messages: [textMessage(turn.contactNumber, askAddressMessage())],
      };
    }

    return this.askForConfirmation(auth, turn, { ...context, orderType });
  }

  private async provideAddress(
    auth: AuthContext,
    turn: ConversationTurn,
    context: ConversationContext,
    address: string,
  ): Promise<Outcome> {
    if (address.trim().length < 8) {
      // Short enough to be a typo rather than an address. Asking again is
      // better than sending a rider to "dha".
      return {
        state: ConversationState.ASKING_ADDRESS,
        context,
        messages: [
          textMessage(
            turn.contactNumber,
            'That looks a little short. Please send the full address — house or flat number, street, and area.',
          ),
        ],
      };
    }

    return this.askForConfirmation(auth, turn, { ...context, address: address.trim() });
  }

  private async askForConfirmation(
    auth: AuthContext,
    turn: ConversationTurn,
    context: ConversationContext,
  ): Promise<Outcome> {
    if (!context.cartId) return this.browse(auth, turn, context);

    const summary = await this.cartSummary(auth, context.cartId);
    const label = ORDER_TYPE_LABELS[context.orderType ?? OrderType.PICKUP] ?? 'Pickup';

    return {
      state: ConversationState.CONFIRMING_ORDER,
      context,
      messages: [
        buttonsMessage({
          to: turn.contactNumber,
          body: confirmOrderMessage(summary, label),
          buttons: [
            { id: encodeReplyId(ReplyAction.CONFIRM), title: 'Place order' },
            { id: encodeReplyId(ReplyAction.BROWSE), title: 'Add more' },
            { id: encodeReplyId(ReplyAction.CANCEL), title: 'Cancel' },
          ],
        }),
      ],
    };
  }

  /**
   * Places the order — through OrdersService.checkout, exactly as the POS does.
   *
   * Nothing about the total, the tax or the status is decided here or sent from
   * the conversation. The cart id and the customer's number go in; a priced,
   * numbered order comes back (§27, §28, invariant 4).
   */
  private async placeOrder(
    auth: AuthContext,
    turn: ConversationTurn,
    context: ConversationContext,
  ): Promise<Outcome> {
    if (!context.cartId) {
      return {
        state: ConversationState.IDLE,
        context,
        messages: [textMessage(turn.contactNumber, emptyCartMessage()), this.mainMenu(turn)],
      };
    }

    const order = await this.orders.checkout(auth, {
      cartId: context.cartId,
      customerPhone: turn.contactNumber,
      paymentMethod: PaymentMethod.CASH,
      ...(context.address ? { deliveryAddress: context.address } : {}),
    });

    return {
      state: ConversationState.TRACKING_ORDER,
      context: {
        lastOrderId: order.id,
        lastOrderNumber: order.orderNumber,
      },
      messages: [
        textMessage(
          turn.contactNumber,
          orderPlacedMessage(order.orderNumber, order.totals.total, order.currency),
        ),
      ],
    };
  }

  private async track(
    auth: AuthContext,
    turn: ConversationTurn,
    context: ConversationContext,
  ): Promise<Outcome> {
    const customer = await this.findCustomer(auth, turn.contactNumber);

    const recent = customer
      ? await this.orders.findAll(auth, { customerId: customer.id, limit: 1 })
      : null;

    const order = recent?.orders[0];
    if (!order) {
      return {
        state: ConversationState.IDLE,
        context,
        messages: [textMessage(turn.contactNumber, noOrdersMessage()), this.mainMenu(turn)],
      };
    }

    return {
      state: ConversationState.TRACKING_ORDER,
      context: { ...context, lastOrderId: order.id, lastOrderNumber: order.orderNumber },
      messages: [
        textMessage(turn.contactNumber, orderStatusMessage(order.orderNumber, order.status)),
      ],
    };
  }

  /**
   * Hands the conversation to a person.
   *
   * The bot then says nothing at all until somebody ends the handoff — see the
   * guard at the top of `handle`. The restaurant sees the conversation in the
   * dashboard's inbox, which is where B-24 picks this up.
   */
  private async handoff(
    auth: AuthContext,
    turn: ConversationTurn,
    context: ConversationContext,
  ): Promise<Outcome> {
    const organization = await this.organization(auth);

    return {
      state: ConversationState.HUMAN_HANDOFF,
      context: { ...context, handoffAt: new Date().toISOString() },
      messages: [textMessage(turn.contactNumber, handoffMessage(organization.name))],
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** The three things a customer can start from, offered whenever we pause. */
  private mainMenu(turn: ConversationTurn) {
    return buttonsMessage({
      to: turn.contactNumber,
      body: 'What would you like to do?',
      buttons: [
        { id: encodeReplyId(ReplyAction.BROWSE), title: 'Browse menu' },
        { id: encodeReplyId(ReplyAction.TRACK), title: 'Track order' },
        { id: encodeReplyId(ReplyAction.HANDOFF), title: 'Talk to us' },
      ],
    });
  }

  /** Visible to a customer and not sold out. */
  private orderable(item: { isVisible?: boolean; availability: string }): boolean {
    return (
      (item.isVisible ?? true) &&
      item.availability !== MenuItemAvailability.OUT_OF_STOCK &&
      item.availability !== MenuItemAvailability.HIDDEN
    );
  }

  private async ensureCart(
    auth: AuthContext,
    turn: ConversationTurn,
    context: ConversationContext,
  ): Promise<string> {
    if (context.cartId) {
      // Still usable? A cart that was checked out or expired cannot take items,
      // and a customer ordering twice in a day hits exactly that.
      const existing = await this.cart.findOne(auth, context.cartId).catch(() => null);
      if (existing && existing.status === 'ACTIVE') return existing.id;
    }

    const customer = await this.findCustomer(auth, turn.contactNumber);

    const created = await this.cart.create(auth, {
      branchId: turn.branchId,
      source: OrderSource.WHATSAPP,
      // Provisional. The customer chooses at checkout, and the branch may not
      // offer delivery at all — which startCheckout accounts for.
      orderType: OrderType.PICKUP,
      ...(customer ? { customerId: customer.id } : {}),
    });

    return created.id;
  }

  private async cartSummary(auth: AuthContext, cartId: string): Promise<CartSummary> {
    const cart = await this.cart.findOne(auth, cartId);

    return {
      lines: cart.items.map((item) => ({
        name: item.variantName ? `${item.name} (${item.variantName})` : item.name,
        quantity: item.quantity,
        lineTotal: item.lineTotal,
      })),
      subtotal: cart.totals.subtotal,
      deliveryFee: cart.totals.deliveryFee,
      tax: cart.totals.taxAmount,
      total: cart.totals.total,
      currency: cart.currency,
    };
  }

  private async organization(auth: AuthContext): Promise<{ name: string }> {
    return this.prisma.forTenant(auth.tenantId, (tx) =>
      tx.organization.findUniqueOrThrow({
        where: { id: auth.tenantId },
        select: { name: true },
      }),
    );
  }

  private async branch(auth: AuthContext, branchId: string) {
    return this.prisma.forTenant(auth.tenantId, (tx) =>
      tx.branch.findUniqueOrThrow({
        where: { id: branchId },
        select: { deliveryEnabled: true, pickupEnabled: true, dineInEnabled: true },
      }),
    );
  }

  private async findCustomer(
    auth: AuthContext,
    phone: string,
  ): Promise<{ id: string; name: string | null } | null> {
    return this.prisma.forTenant(auth.tenantId, (tx) =>
      tx.customer.findFirst({
        where: { OR: [{ phone }, { whatsappNumber: phone }] },
        select: { id: true, name: true },
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Session persistence
  // -------------------------------------------------------------------------

  private async loadSession(turn: ConversationTurn): Promise<LoadedSession> {
    return this.prisma.forTenant(turn.tenantId, async (tx) => {
      const existing = await tx.conversationSession.findUnique({
        where: {
          tenantId_channel_externalUserId: {
            tenantId: turn.tenantId,
            channel: ConversationChannel.WHATSAPP,
            externalUserId: turn.contactNumber,
          },
        },
      });

      const now = new Date();

      if (existing && !isConversationExpired(existing.expiresAt, now)) {
        return {
          id: existing.id,
          state: existing.state as ConversationState,
          context: (existing.context ?? {}) as ConversationContext,
        };
      }

      if (existing) {
        // Expired: start again rather than resuming a day-old cart whose prices
        // and availability have moved on.
        const reset = await tx.conversationSession.update({
          where: { id: existing.id },
          data: {
            state: ConversationState.IDLE,
            context: {},
            branchId: turn.branchId,
            expiresAt: new Date(now.getTime() + CONVERSATION_TTL_MS),
            lastInboundAt: now,
          },
        });
        return { id: reset.id, state: ConversationState.IDLE, context: {} };
      }

      const created = await this.createSession(tx, turn, now);
      return { id: created, state: ConversationState.IDLE, context: {} };
    });
  }

  private async createSession(
    tx: TransactionClient,
    turn: ConversationTurn,
    now: Date,
  ): Promise<string> {
    const id = randomUUID();

    // createMany, not create: INSERT ... RETURNING re-checks the SELECT policy,
    // and the id is already known, so there is nothing to read back.
    await tx.conversationSession.createMany({
      data: [
        {
          id,
          tenantId: turn.tenantId,
          branchId: turn.branchId,
          channel: ConversationChannel.WHATSAPP,
          externalUserId: turn.contactNumber,
          state: ConversationState.IDLE,
          context: {},
          expiresAt: new Date(now.getTime() + CONVERSATION_TTL_MS),
          lastInboundAt: now,
        },
      ],
      skipDuplicates: true,
    });

    return id;
  }

  private async save(
    turn: ConversationTurn,
    id: string,
    state: ConversationState,
    context: ConversationContext,
  ): Promise<void> {
    await this.prisma.forTenant(turn.tenantId, (tx) =>
      tx.conversationSession.updateMany({
        where: { id },
        data: {
          state,
          context: context as never,
          branchId: turn.branchId,
          expiresAt: new Date(Date.now() + CONVERSATION_TTL_MS),
          lastInboundAt: new Date(),
        },
      }),
    );
  }

  private async touch(turn: ConversationTurn, id: string): Promise<void> {
    await this.prisma.forTenant(turn.tenantId, (tx) =>
      tx.conversationSession.updateMany({
        where: { id },
        data: {
          lastInboundAt: new Date(),
          expiresAt: new Date(Date.now() + CONVERSATION_TTL_MS),
        },
      }),
    );
  }
}

/**
 * Numbers the rows of a list, so typing "2" is discoverable.
 *
 * WhatsApp truncates a row title at 24 characters and the prefix eats three of
 * them, which is the trade: a slightly shorter dish name in exchange for a list
 * that can be answered without tapping. Customers type the number constantly.
 */
function numberedRows(
  rows: Array<{ id: string; title: string; description?: string }>,
): Array<{ id: string; title: string; description?: string }> {
  return rows.map((row, index) => ({ ...row, title: `${index + 1}. ${row.title}` }));
}

/**
 * The reply ids on the customer's screen after this turn, in order.
 *
 * Only the last interactive message counts: if a turn sends a sentence and then
 * a set of buttons, the buttons are what they are looking at.
 */
function shownReplyIdsFrom(messages: readonly OutboundMessage[]): string[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;

    if (message.kind === 'list') {
      return message.sections.flatMap((section) => section.rows.map((row) => row.id));
    }
    if (message.kind === 'buttons') {
      return message.buttons.map((button) => button.id);
    }
  }
  return [];
}

interface LoadedSession {
  id: string;
  state: ConversationState;
  context: ConversationContext;
}

interface Outcome {
  state: ConversationState;
  context: ConversationContext;
  messages: OutboundMessage[];
}
