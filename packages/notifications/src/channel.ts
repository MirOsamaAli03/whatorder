import type { NotificationChannel } from '@restaurant-os/types';
import type { OutboundMessage, WhatsAppCredentials } from '@restaurant-os/whatsapp';

/**
 * The channel abstraction (plan Phase 5).
 *
 * ENGINEERING_SPEC.md §31 lists WhatsApp, SMS, email, push and the dashboard as
 * notification channels. They differ enormously in what they cost, what they
 * require and how they fail, and the dispatcher must not know any of that: its
 * job is to decide *who* gets told *what*, and then hand the result to whichever
 * channel the tenant has enabled.
 *
 * The interface is therefore deliberately thin. Everything channel-specific —
 * WhatsApp's session-versus-template rule above all — is resolved before a
 * request reaches here.
 */

export interface ChannelSendRequest {
  /** A phone number in E.164, an email address, or a user id for DASHBOARD. */
  destination: string;
  /** The message as plain text. Every channel can carry at least this. */
  body: string;
  /** Our message key, e.g. `order_confirmed`. Used for logging and templates. */
  templateKey: string;
  /**
   * WhatsApp needs more than a body: which mode, which approved template, and
   * whose credentials. Optional rather than part of a union because every other
   * channel genuinely does need nothing but a destination and a body, and a
   * union here would push a `switch` into every adapter.
   */
  whatsapp?: {
    providerName: string;
    message: OutboundMessage;
    credentials: WhatsAppCredentials;
  };
}

export interface ChannelSendResult {
  /** The provider's id, when it has one. Delivery callbacks quote it. */
  providerMessageId?: string;
  /** The provider's immediate acknowledgement, e.g. `accepted`, `logged`. */
  status: string;
}

/**
 * A send that failed.
 *
 * `retryable` decides whether the backoff ladder applies. A rate limit or an
 * outage deserves it; a malformed address does not — retrying that six times
 * only delays somebody noticing. Classification belongs to the adapter, which
 * is the only layer that understands the provider's error vocabulary.
 */
export class ChannelSendError extends Error {
  readonly retryable: boolean;
  readonly providerCode?: string;

  constructor(
    message: string,
    options: { retryable: boolean; providerCode?: string; cause?: unknown } = { retryable: true },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ChannelSendError';
    this.retryable = options.retryable;
    this.providerCode = options.providerCode;
  }
}

export interface NotificationChannelAdapter {
  readonly channel: NotificationChannel;
  send(request: ChannelSendRequest): Promise<ChannelSendResult>;
}
