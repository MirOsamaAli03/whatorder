import { LogWhatsAppProvider } from './log-provider';
import type { WhatsAppProvider } from './provider';

/**
 * Chooses the sending adapter for a `whatsapp_accounts` row.
 *
 * A registry rather than a switch statement so that adding a BSP is a
 * registration, and so that a tenant on a different provider is a row in the
 * database rather than a branch in the code (ENGINEERING_SPEC.md §74: never
 * hard-code tenant behaviour).
 */
export class WhatsAppProviderRegistry {
  private readonly providers = new Map<string, WhatsAppProvider>();

  constructor(providers: WhatsAppProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: WhatsAppProvider): void {
    this.providers.set(provider.name, provider);
  }

  /**
   * Returns the provider for a name, or throws.
   *
   * Throwing beats silently falling back to the log provider: a production
   * tenant whose provider name is misspelled would otherwise appear to send
   * every message successfully while no customer ever received one.
   */
  get(name: string): WhatsAppProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      const known = [...this.providers.keys()].join(', ') || 'none';
      throw new Error(
        `No WhatsApp provider registered under "${name}". Registered providers: ${known}.`,
      );
    }
    return provider;
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }
}

/** The registry a development or test process starts with. */
export function createDefaultRegistry(
  log?: (message: string, detail: unknown) => void,
): WhatsAppProviderRegistry {
  return new WhatsAppProviderRegistry([new LogWhatsAppProvider(log)]);
}
