import { NotificationChannel } from '@restaurant-os/types';
import { WhatsAppSendError, type WhatsAppProviderRegistry } from '@restaurant-os/whatsapp';
import {
  ChannelSendError,
  type ChannelSendRequest,
  type ChannelSendResult,
  type NotificationChannelAdapter,
} from './channel';

/**
 * WhatsApp, over whichever provider the tenant's account names.
 *
 * The adapter resolves the provider per request rather than per process,
 * because `whatsapp_accounts.provider` is per tenant: two restaurants on the
 * same deployment may be on different BSPs, and one of them moving must not
 * require a restart.
 */
export class WhatsAppChannelAdapter implements NotificationChannelAdapter {
  readonly channel = NotificationChannel.WHATSAPP;

  constructor(private readonly registry: WhatsAppProviderRegistry) {}

  async send(request: ChannelSendRequest): Promise<ChannelSendResult> {
    if (!request.whatsapp) {
      // A programming error rather than a provider failure: something built a
      // WhatsApp notification without deciding how to send it. Never retryable
      // — the next attempt would be just as malformed.
      throw new ChannelSendError(
        'A WhatsApp notification reached the channel without a resolved send mode',
        { retryable: false, providerCode: 'MISSING_SEND_MODE' },
      );
    }

    const { providerName, message, credentials } = request.whatsapp;

    try {
      const provider = this.registry.get(providerName);
      const result = await provider.send(message, credentials);
      return { providerMessageId: result.providerMessageId, status: result.status };
    } catch (error) {
      if (error instanceof WhatsAppSendError) {
        throw new ChannelSendError(error.message, {
          retryable: error.retryable,
          providerCode: error.providerCode,
          cause: error,
        });
      }
      // An unregistered provider name, or anything else unexpected. Retrying a
      // misspelled provider name forever helps nobody.
      throw new ChannelSendError(error instanceof Error ? error.message : String(error), {
        retryable: false,
        cause: error,
      });
    }
  }
}

/**
 * The dashboard channel.
 *
 * There is nothing to send: the notification row *is* the delivery, and the
 * dashboard reads it. Modelling it as a channel rather than as a special case
 * keeps the dispatcher uniform, and means a tenant can turn the in-app alert
 * off the same way they turn SMS off.
 */
export class DashboardChannelAdapter implements NotificationChannelAdapter {
  readonly channel = NotificationChannel.DASHBOARD;

  async send(): Promise<ChannelSendResult> {
    return { status: 'recorded' };
  }
}

/**
 * A stand-in for a channel with no contracted provider yet.
 *
 * SMS and email are both in ENGINEERING_SPEC.md §31 and both need a commercial
 * account that does not exist during development. Rather than leave those
 * channels unimplemented — which would make the escalation ladder's off-channel
 * fallback (plan §2.8) untestable — they log and report success, and the
 * backlog records that a real provider is still owed.
 */
export class LogChannelAdapter implements NotificationChannelAdapter {
  constructor(
    readonly channel: NotificationChannel,
    private readonly log: (message: string, detail: unknown) => void = () => {},
  ) {}

  async send(request: ChannelSendRequest): Promise<ChannelSendResult> {
    this.log(`${this.channel} notification (log adapter)`, {
      to: request.destination,
      templateKey: request.templateKey,
    });
    return { status: 'logged' };
  }
}
