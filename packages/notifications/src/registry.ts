import { NotificationChannel } from '@restaurant-os/types';
import type { WhatsAppProviderRegistry } from '@restaurant-os/whatsapp';
import { DashboardChannelAdapter, LogChannelAdapter, WhatsAppChannelAdapter } from './adapters';
import type { NotificationChannelAdapter } from './channel';

/** Looks up the adapter for a channel. */
export class NotificationChannelRegistry {
  private readonly adapters = new Map<NotificationChannel, NotificationChannelAdapter>();

  constructor(adapters: NotificationChannelAdapter[] = []) {
    for (const adapter of adapters) this.adapters.set(adapter.channel, adapter);
  }

  register(adapter: NotificationChannelAdapter): void {
    this.adapters.set(adapter.channel, adapter);
  }

  /**
   * The adapter for a channel, or undefined.
   *
   * Undefined rather than a throw: a channel with no adapter is a
   * configuration state, not a bug, and the dispatcher records it as a
   * suppression with a reason. A tenant who has enabled PUSH before push
   * notifications exist should see exactly that, rather than a stack trace in
   * the worker log.
   */
  get(channel: NotificationChannel): NotificationChannelAdapter | undefined {
    return this.adapters.get(channel);
  }

  channels(): NotificationChannel[] {
    return [...this.adapters.keys()];
  }
}

/**
 * The registry a development process starts with: WhatsApp over whichever
 * providers are registered, the dashboard, and logging stand-ins for SMS and
 * email until those have real accounts.
 */
export function createDefaultChannelRegistry(
  whatsapp: WhatsAppProviderRegistry,
  log?: (message: string, detail: unknown) => void,
): NotificationChannelRegistry {
  return new NotificationChannelRegistry([
    new WhatsAppChannelAdapter(whatsapp),
    new DashboardChannelAdapter(),
    new LogChannelAdapter(NotificationChannel.SMS, log),
    new LogChannelAdapter(NotificationChannel.EMAIL, log),
  ]);
}
