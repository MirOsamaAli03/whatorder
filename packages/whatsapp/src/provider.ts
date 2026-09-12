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

/** A message sent inside the 24-hour customer service window. */
export interface SessionMessage {
  mode: typeof WhatsAppSendMode.SESSION;
  /** Recipient in E.164, e.g. `+923001234567`. */
  to: string;
  body: string;
}

/** A pre-approved template, the only thing sendable outside the window. */
export interface TemplateMessage {
  mode: typeof WhatsAppSendMode.TEMPLATE;
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

export type OutboundMessage = SessionMessage | TemplateMessage;

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
