import type { WhatsAppSendMode } from '@restaurant-os/types';

/**
 * The seam between Restaurant OS and whoever actually puts a message on
 * WhatsApp (plan §1, "Decisions locked this session").
 *
 * Per-tenant numbers are provisioned through a Business Solution Provider
 * today — 360dialog, Twilio, Interakt — and moving a tenant to Meta's Cloud API
 * directly, or between BSPs, must be a change of configuration rather than a
 * change of code. Hence one narrow interface, and `whatsapp_accounts.provider`
 * choosing the implementation per account.
 *
 * Everything above this interface is provider-agnostic: the dispatcher decides
 * *whether* and *how* to send (packages/domain/src/notifications.ts), and the
 * provider only carries it out.
 */

/** Plain text, sent inside the 24-hour customer service window. */
export interface SessionMessage {
  mode: typeof WhatsAppSendMode.SESSION;
  kind: 'text';
  /** Recipient in E.164, e.g. `+923001234567`. */
  to: string;
  body: string;
}

/**
 * WhatsApp's interactive messages: reply buttons and list pickers.
 *
 * These are what make deterministic ordering work (plan 2.2). A customer taps a
 * row whose id already names the menu item, so the bot needs no language
 * understanding for the common path, and the channel keeps working when the
 * LLM is down.
 *
 * Both forms are free-form messages, so — like any session message — they can
 * only be sent inside the 24-hour window. Outside it there is nothing
 * equivalent: a template cannot carry a menu. That is why an order update
 * outside the window is a plain templated sentence rather than a prompt.
 */
export interface InteractiveButton {
  /** Echoed back verbatim when tapped. See encodeReplyId in the domain package. */
  id: string;
  title: string;
}

export interface InteractiveRow {
  id: string;
  title: string;
  description?: string;
}

export interface InteractiveSection {
  title: string;
  rows: InteractiveRow[];
}

/** Up to three reply buttons. Beyond that WhatsApp requires a list. */
export interface ButtonsMessage {
  mode: typeof WhatsAppSendMode.SESSION;
  kind: 'buttons';
  to: string;
  body: string;
  header?: string;
  footer?: string;
  buttons: InteractiveButton[];
}

/** A tappable list, opened by a button. Up to ten rows in total. */
export interface ListMessage {
  mode: typeof WhatsAppSendMode.SESSION;
  kind: 'list';
  to: string;
  body: string;
  header?: string;
  footer?: string;
  /** The label on the button that opens the list, e.g. "View menu". */
  buttonLabel: string;
  sections: InteractiveSection[];
}

/** A pre-approved template, the only thing sendable outside the window. */
export interface TemplateMessage {
  mode: typeof WhatsAppSendMode.TEMPLATE;
  kind: 'template';
  to: string;
  /** The provider's name for the template, not our internal key. */
  templateName: string;
  /** BCP-47-ish language tag as the provider expects it, e.g. `en`, `ur`. */
  language: string;
  /**
   * Positional body variables filling `{{1}}`, `{{2}}`, … Order is part of the
   * template's contract; see templateVariables() in the domain package.
   */
  variables: string[];
  /**
   * The same message as plain text. Not sent — recorded against
   * `whatsapp_messages.body`, so support can read what a customer received
   * without reconstructing it from a template and an array.
   */
  renderedBody: string;
}

export type OutboundMessage =
  | SessionMessage
  | ButtonsMessage
  | ListMessage
  | TemplateMessage;

/**
 * WhatsApp's length limits on interactive elements.
 *
 * Exceeding any of them makes the provider reject the *whole* message, so the
 * customer sees nothing rather than something truncated — which is why these
 * are enforced when a message is built rather than left to a long dish name to
 * discover in production.
 */
export const WHATSAPP_LIMITS = {
  buttonTitle: 20,
  rowTitle: 24,
  rowDescription: 72,
  sectionTitle: 24,
  body: 1024,
  header: 60,
  footer: 60,
} as const;

/** Shortens with an ellipsis, so a clipped name still reads as one. */
export function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

export interface WhatsAppCredentials {
  /** Provider identifier for the sending number; also the webhook's routing key. */
  phoneNumberId: string;
  accessToken?: string;
  apiKey?: string;
  baseUrl?: string;
  [key: string]: unknown;
}

export interface SendResult {
  /** The provider's id for the message. Delivery callbacks quote it. */
  providerMessageId: string;
  /** Provider's immediate acknowledgement, e.g. `accepted`. Never `delivered`. */
  status: string;
}

/**
 * A send that did not happen.
 *
 * `retryable` is the field that matters. An outage, a rate limit or a timeout
 * deserves the backoff ladder; a malformed number or an unapproved template
 * will fail identically six times in a row and only delay the failure being
 * seen. Providers report both as errors, so classifying them is the adapter's
 * job and not the dispatcher's.
 */
export class WhatsAppSendError extends Error {
  readonly retryable: boolean;
  readonly providerCode?: string;

  constructor(message: string, options: { retryable: boolean; providerCode?: string } = { retryable: true }) {
    super(message);
    this.name = 'WhatsAppSendError';
    this.retryable = options.retryable;
    this.providerCode = options.providerCode;
  }
}

export interface WhatsAppProvider {
  /** Matches `whatsapp_accounts.provider`. */
  readonly name: string;

  /**
   * Sends one message.
   *
   * Throws WhatsAppSendError on failure. Returning a result means the provider
   * accepted the message, not that anybody received it — delivery is reported
   * asynchronously through a callback against `whatsapp_messages`.
   */
  send(message: OutboundMessage, credentials: WhatsAppCredentials): Promise<SendResult>;
}
