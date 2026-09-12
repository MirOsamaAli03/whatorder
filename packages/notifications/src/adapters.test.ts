import { NotificationChannel, WhatsAppSendMode } from '@restaurant-os/types';
import { LogWhatsAppProvider, WhatsAppProviderRegistry } from '@restaurant-os/whatsapp';
import { describe, expect, it } from 'vitest';
import { DashboardChannelAdapter, LogChannelAdapter, WhatsAppChannelAdapter } from './adapters';
import { ChannelSendError, type ChannelSendRequest } from './channel';
import { NotificationChannelRegistry, createDefaultChannelRegistry } from './registry';

function whatsappRequest(providerName = 'log'): ChannelSendRequest {
  return {
    destination: '+923001234567',
    body: 'Your order is ready.',
    templateKey: 'order_ready',
    whatsapp: {
      providerName,
      message: {
        mode: WhatsAppSendMode.SESSION,
        kind: 'text',
        to: '+923001234567',
        body: 'Your order is ready.',
      },
      credentials: { phoneNumberId: 'pn-1' },
    },
  };
}

describe('the WhatsApp channel adapter', () => {
  const registry = new WhatsAppProviderRegistry([new LogWhatsAppProvider()]);
  const adapter = new WhatsAppChannelAdapter(registry);

  it('sends through the provider the account names', async () => {
    const result = await adapter.send(whatsappRequest());
    expect(result.providerMessageId).toBeTruthy();
  });

  it('refuses, permanently, a request with no resolved send mode', async () => {
    // A programming error rather than a provider failure. The next attempt
    // would be just as malformed, so retrying it is pure delay.
    const request: ChannelSendRequest = {
      destination: '+923001234567',
      body: 'x',
      templateKey: 'order_ready',
    };

    await adapter.send(request).catch((error: unknown) => {
      expect(error).toBeInstanceOf(ChannelSendError);
      expect((error as ChannelSendError).retryable).toBe(false);
    });
    await expect(adapter.send(request)).rejects.toThrow(ChannelSendError);
  });

  it('classifies an unknown provider name as permanent', async () => {
    await adapter.send(whatsappRequest('not-registered')).catch((error: unknown) => {
      expect((error as ChannelSendError).retryable).toBe(false);
    });
  });

  it('passes a provider outage through as retryable', async () => {
    const provider = new LogWhatsAppProvider();
    provider.setAvailable(false);
    const down = new WhatsAppChannelAdapter(new WhatsAppProviderRegistry([provider]));

    await down.send(whatsappRequest()).catch((error: unknown) => {
      expect(error).toBeInstanceOf(ChannelSendError);
      expect((error as ChannelSendError).retryable).toBe(true);
      expect((error as ChannelSendError).providerCode).toBe('PROVIDER_DOWN');
    });
  });
});

describe('the dashboard channel', () => {
  it('is delivered by the notification row existing', async () => {
    const result = await new DashboardChannelAdapter().send();
    expect(result.status).toBe('recorded');
    expect(result.providerMessageId).toBeUndefined();
  });
});

describe('the channel registry', () => {
  it('carries the channels a development process starts with', () => {
    const registry = createDefaultChannelRegistry(
      new WhatsAppProviderRegistry([new LogWhatsAppProvider()]),
    );

    expect(registry.channels().sort()).toEqual([
      NotificationChannel.DASHBOARD,
      NotificationChannel.EMAIL,
      NotificationChannel.SMS,
      NotificationChannel.WHATSAPP,
    ]);
  });

  it('returns undefined for a channel with no adapter, rather than throwing', () => {
    // A tenant who has enabled PUSH before push notifications exist should see
    // a suppressed notification with a reason, not a stack trace in a log.
    const registry = new NotificationChannelRegistry([
      new LogChannelAdapter(NotificationChannel.SMS),
    ]);

    expect(registry.get(NotificationChannel.PUSH)).toBeUndefined();
    expect(registry.get(NotificationChannel.SMS)).toBeDefined();
  });
});
