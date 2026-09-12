import { WhatsAppSendMode } from '@restaurant-os/types';
import { describe, expect, it } from 'vitest';
import { LogWhatsAppProvider } from './log-provider';
import { WhatsAppProviderRegistry, createDefaultRegistry } from './registry';
import { WhatsAppSendError, type OutboundMessage } from './provider';

const credentials = { phoneNumberId: 'pn-1' };

const session: OutboundMessage = {
  mode: WhatsAppSendMode.SESSION,
  kind: 'text',
  to: '+923001234567',
  body: 'Your order is ready.',
};

describe('the log provider', () => {
  it('records what would have been sent', async () => {
    const provider = new LogWhatsAppProvider();
    const result = await provider.send(session, credentials);

    expect(result.providerMessageId).toBeTruthy();
    expect(provider.messages()).toHaveLength(1);
    expect(provider.lastMessage()?.phoneNumberId).toBe('pn-1');
  });

  it('can be taken down and brought back', async () => {
    // The Phase 5 exit criterion needs a provider that can be hard-down; a
    // provider that always works cannot demonstrate a retry.
    const provider = new LogWhatsAppProvider();
    provider.setAvailable(false);

    await expect(provider.send(session, credentials)).rejects.toThrow(WhatsAppSendError);

    provider.setAvailable(true);
    await expect(provider.send(session, credentials)).resolves.toBeTruthy();
  });

  it('reports an outage as retryable', async () => {
    // The distinction drives the backoff ladder: retrying a malformed number
    // six times only delays somebody noticing.
    const provider = new LogWhatsAppProvider();
    provider.setAvailable(false);

    await provider.send(session, credentials).catch((error: unknown) => {
      expect(error).toBeInstanceOf(WhatsAppSendError);
      expect((error as WhatsAppSendError).retryable).toBe(true);
    });
  });

  it('fails a fixed number of times and then behaves', async () => {
    const provider = new LogWhatsAppProvider();
    provider.failNext(2);

    await expect(provider.send(session, credentials)).rejects.toThrow();
    await expect(provider.send(session, credentials)).rejects.toThrow();
    await expect(provider.send(session, credentials)).resolves.toBeTruthy();
  });
});

describe('the provider registry', () => {
  it('resolves a registered provider by name', () => {
    const registry = createDefaultRegistry();
    expect(registry.get('log').name).toBe('log');
    expect(registry.has('log')).toBe(true);
  });

  it('throws on an unknown name rather than falling back', () => {
    // Falling back to the log provider would make a production tenant with a
    // misspelled provider name appear to send every message successfully while
    // no customer ever received one.
    const registry = new WhatsAppProviderRegistry([new LogWhatsAppProvider()]);

    expect(() => registry.get('360dialog')).toThrow(/No WhatsApp provider registered/);
    expect(() => registry.get('360dialog')).toThrow(/log/);
  });
});
