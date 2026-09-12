import {
  WhatsAppSendError,
  type OutboundMessage,
  type SendResult,
  type WhatsAppCredentials,
  type WhatsAppProvider,
} from './provider';

export interface LoggedMessage {
  message: OutboundMessage;
  phoneNumberId: string;
  providerMessageId: string;
  at: Date;
}

/**
 * The development and test WhatsApp provider.
 *
 * It sends nothing. It records what *would* have been sent and hands back a
 * plausible provider message id, which is enough to exercise every path above
 * it: the send-mode decision, the message log, the delivery callback, the
 * retry ladder.
 *
 * The outage switch exists because of the plan's Phase 5 exit criterion —
 * *"order creation succeeds while the WhatsApp provider is hard-down (invariant
 * 8), and the notification retries and eventually delivers when it recovers"*.
 * That is not a property you can test against a provider that always works, and
 * a mock injected only in tests would prove the mock behaves, not the
 * dispatcher. So the real dev provider can be taken down and brought back.
 */
export class LogWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'log';

  private readonly sent: LoggedMessage[] = [];
  private available = true;
  private failures = 0;
  private counter = 0;

  constructor(private readonly log: (message: string, detail: unknown) => void = () => {}) {}

  async send(message: OutboundMessage, credentials: WhatsAppCredentials): Promise<SendResult> {
    if (!this.available) {
      throw new WhatsAppSendError('WhatsApp provider is unavailable (simulated outage)', {
        retryable: true,
        providerCode: 'PROVIDER_DOWN',
      });
    }

    if (this.failures > 0) {
      this.failures -= 1;
      throw new WhatsAppSendError('Transient provider failure (simulated)', {
        retryable: true,
        providerCode: 'TRANSIENT',
      });
    }

    this.counter += 1;
    const providerMessageId = `log-${Date.now().toString(36)}-${this.counter}`;

    this.sent.push({
      message,
      phoneNumberId: credentials.phoneNumberId,
      providerMessageId,
      at: new Date(),
    });

    this.log('WhatsApp message (log provider)', {
      to: message.to,
      mode: message.mode,
      providerMessageId,
    });

    return { providerMessageId, status: 'accepted' };
  }

  // --- controls, for tests and for demonstrating an outage in dev ---

  /** Takes the provider down, or brings it back. */
  setAvailable(available: boolean): void {
    this.available = available;
  }

  /** Fails the next `count` sends with a retryable error, then behaves. */
  failNext(count: number): void {
    this.failures = count;
  }

  messages(): readonly LoggedMessage[] {
    return this.sent;
  }

  lastMessage(): LoggedMessage | undefined {
    return this.sent[this.sent.length - 1];
  }

  reset(): void {
    this.sent.length = 0;
    this.available = true;
    this.failures = 0;
  }
}
