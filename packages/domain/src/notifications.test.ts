import {
  ConsentStatus,
  NotificationChannel,
  OrderStatus,
  WhatsAppSendMode,
  WhatsAppTemplateCategory,
  WhatsAppTemplateStatus,
} from '@restaurant-os/types';
import { describe, expect, it } from 'vitest';
import {
  ESCALATION_NOTIFICATION,
  MAX_NOTIFICATION_ATTEMPTS,
  NOTIFYING_ORDER_STATUSES,
  WHATSAPP_SERVICE_WINDOW_MS,
  hasAttemptsLeft,
  isServiceWindowOpen,
  nextRetryAt,
  notificationForOrderStatus,
  renderMessageBody,
  resolveWhatsAppSendMode,
  serviceWindowRemainingMs,
  templateVariables,
} from './notifications';

const NOW = new Date('2026-09-12T12:00:00Z');

function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 3_600_000);
}

describe('the 24-hour service window (plan 2.2)', () => {
  it('is 24 hours', () => {
    expect(WHATSAPP_SERVICE_WINDOW_MS).toBe(86_400_000);
  });

  it('is open just inside the window', () => {
    expect(isServiceWindowOpen(hoursAgo(23.9), NOW)).toBe(true);
  });

  it('is shut just outside it', () => {
    expect(isServiceWindowOpen(hoursAgo(24.1), NOW)).toBe(false);
  });

  it('is shut for a customer who has never messaged', () => {
    // The case that matters: an order placed by phone or at the counter gives
    // no inbound message, so there is no window at all.
    expect(isServiceWindowOpen(null, NOW)).toBe(false);
  });

  it('reports the time remaining', () => {
    expect(serviceWindowRemainingMs(hoursAgo(20), NOW)).toBe(4 * 3_600_000);
    expect(serviceWindowRemainingMs(hoursAgo(30), NOW)).toBe(0);
    expect(serviceWindowRemainingMs(null, NOW)).toBe(0);
  });
});

describe('resolveWhatsAppSendMode', () => {
  const base = {
    now: NOW,
    category: WhatsAppTemplateCategory.UTILITY,
    templateStatus: WhatsAppTemplateStatus.APPROVED,
    marketingConsent: null,
  };

  it('prefers a free session message inside the window', () => {
    // Cheaper, needs no approval, and reads naturally.
    const decision = resolveWhatsAppSendMode({ ...base, lastInboundAt: hoursAgo(2) });
    expect(decision.mode).toBe(WhatsAppSendMode.SESSION);
  });

  it('falls back to an approved template outside the window', () => {
    const decision = resolveWhatsAppSendMode({ ...base, lastInboundAt: hoursAgo(30) });
    expect(decision.mode).toBe(WhatsAppSendMode.TEMPLATE);
  });

  it('refuses when the window is shut and the template is not approved', () => {
    for (const status of [
      WhatsAppTemplateStatus.PENDING,
      WhatsAppTemplateStatus.REJECTED,
      WhatsAppTemplateStatus.PAUSED,
      WhatsAppTemplateStatus.DRAFT,
    ]) {
      const decision = resolveWhatsAppSendMode({
        ...base,
        lastInboundAt: hoursAgo(30),
        templateStatus: status,
      });

      // Substituting a session message here would be rejected by the provider
      // and burn a retry, so it is refused with a reason instead.
      expect(decision.mode, status).toBeNull();
      expect(decision.reason).toContain(status);
    }
  });

  it('refuses when the window is shut and no template exists', () => {
    const decision = resolveWhatsAppSendMode({
      ...base,
      lastInboundAt: hoursAgo(30),
      templateStatus: null,
    });

    expect(decision.mode).toBeNull();
    expect(decision.reason).toContain('no template is configured');
  });

  it('still sends a transactional message without marketing consent', () => {
    // An order update is not marketing: the customer asked for the food.
    const decision = resolveWhatsAppSendMode({
      ...base,
      lastInboundAt: hoursAgo(30),
      marketingConsent: null,
    });
    expect(decision.mode).toBe(WhatsAppSendMode.TEMPLATE);
  });

  it('refuses marketing without opt-in, even inside the window', () => {
    // Meta requires opt-IN, which is stricter than §51's "respect opt-out".
    const decision = resolveWhatsAppSendMode({
      ...base,
      category: WhatsAppTemplateCategory.MARKETING,
      lastInboundAt: hoursAgo(1),
      marketingConsent: null,
    });

    expect(decision.mode).toBeNull();
    expect(decision.reason).toContain('opt-in');
  });

  it('refuses marketing after opt-out', () => {
    const decision = resolveWhatsAppSendMode({
      ...base,
      category: WhatsAppTemplateCategory.MARKETING,
      lastInboundAt: hoursAgo(1),
      marketingConsent: ConsentStatus.REVOKED,
    });
    expect(decision.mode).toBeNull();
  });

  it('allows marketing with opt-in', () => {
    const decision = resolveWhatsAppSendMode({
      ...base,
      category: WhatsAppTemplateCategory.MARKETING,
      lastInboundAt: hoursAgo(1),
      marketingConsent: ConsentStatus.GRANTED,
    });
    expect(decision.mode).toBe(WhatsAppSendMode.SESSION);
  });
});

describe('retry backoff (spec 32)', () => {
  it('grows exponentially', () => {
    // Fixed random so the jitter does not make the assertion flaky.
    const noJitter = () => 1;
    const delays = [1, 2, 3, 4].map((attempt) => {
      const at = nextRetryAt(attempt, NOW, noJitter)!;
      return at.getTime() - NOW.getTime();
    });

    expect(delays).toEqual([30_000, 60_000, 120_000, 240_000]);
  });

  it('caps the delay at an hour', () => {
    const at = nextRetryAt(5, NOW, () => 1)!;
    expect(at.getTime() - NOW.getTime()).toBeLessThanOrEqual(3_600_000);
  });

  it('applies jitter so a recovering provider is not thundered', () => {
    // Every queued notification fails at the same instant during an outage.
    // Without jitter they would all retry together and cause a second one.
    const earliest = nextRetryAt(3, NOW, () => 0)!.getTime();
    const latest = nextRetryAt(3, NOW, () => 1)!.getTime();

    expect(latest).toBeGreaterThan(earliest);
  });

  it('gives up after the maximum attempts', () => {
    expect(nextRetryAt(MAX_NOTIFICATION_ATTEMPTS, NOW)).toBeNull();
    expect(hasAttemptsLeft(MAX_NOTIFICATION_ATTEMPTS - 1)).toBe(true);
    expect(hasAttemptsLeft(MAX_NOTIFICATION_ATTEMPTS)).toBe(false);
  });
});

describe('which statuses notify', () => {
  it('tells the customer about the states they act on', () => {
    for (const status of [
      OrderStatus.CONFIRMED,
      OrderStatus.READY,
      OrderStatus.OUT_FOR_DELIVERY,
      OrderStatus.DELIVERED,
      OrderStatus.CANCELLED,
    ]) {
      expect(notificationForOrderStatus(status)?.notifyCustomer, status).toBe(true);
    }
  });

  it('stays quiet about kitchen-internal steps', () => {
    // A customer does not need to know the order moved to PREPARING, and
    // over-messaging is how a business gets its number blocked.
    expect(notificationForOrderStatus(OrderStatus.PREPARING)).toBeNull();
    expect(notificationForOrderStatus(OrderStatus.DRAFT)).toBeNull();
    expect(notificationForOrderStatus(OrderStatus.DELIVERY_FAILED)).toBeNull();
  });

  it('tells staff about confirmation and cancellation', () => {
    expect(notificationForOrderStatus(OrderStatus.CONFIRMED)?.notifyStaff).toBe(true);
    expect(notificationForOrderStatus(OrderStatus.CANCELLED)?.notifyStaff).toBe(true);
    expect(notificationForOrderStatus(OrderStatus.READY)?.notifyStaff).toBe(false);
  });

  it('treats every notifying status as transactional, not marketing', () => {
    // Anything categorised MARKETING would need opt-in and could be suppressed,
    // which must never happen to an order update.
    for (const status of NOTIFYING_ORDER_STATUSES) {
      expect(notificationForOrderStatus(status)!.category, status).toBe(
        WhatsAppTemplateCategory.UTILITY,
      );
    }
  });

  it('delivers an order update once, by the best channel', () => {
    // Telling a customer their food is ready over WhatsApp AND SMS is noise
    // they did not ask for and a bill the restaurant did not need.
    for (const status of NOTIFYING_ORDER_STATUSES) {
      expect(notificationForOrderStatus(status)!.deliveryMode, status).toBe('first-available');
    }
  });

  it('fans the escalation alarm out to every channel at once', () => {
    // Plan 2.8: an alert on the screen nobody is looking at is not an alert,
    // and the dashboard being ignored is exactly the situation that raised it.
    expect(ESCALATION_NOTIFICATION.deliveryMode).toBe('all-channels');
  });

  it('never sends the escalation alarm to a customer', () => {
    // It exists because the restaurant has not noticed the order; telling the
    // customer would be worse than useless.
    expect(ESCALATION_NOTIFICATION.notifyCustomer).toBe(false);
    expect(ESCALATION_NOTIFICATION.notifyStaff).toBe(true);
    expect(ESCALATION_NOTIFICATION.channels[0]).toBe(NotificationChannel.DASHBOARD);
  });
});

describe('message copy', () => {
  const variables = {
    customerName: 'Ayesha',
    orderNumber: 'DHA-0042',
    restaurantName: 'Kababjees',
    branchName: 'DHA',
    reason: 'Kitchen closed',
  };

  it('names the customer and the order', () => {
    const body = renderMessageBody('order_confirmed', variables);
    expect(body).toContain('Ayesha');
    expect(body).toContain('DHA-0042');
    expect(body).toContain('Kababjees');
  });

  it('copes with an anonymous customer', () => {
    const body = renderMessageBody('order_ready', { ...variables, customerName: null });
    expect(body).not.toContain('null');
    expect(body).toContain('DHA-0042');
  });

  it('includes the reason when an order is cancelled', () => {
    expect(renderMessageBody('order_cancelled', variables)).toContain('Kitchen closed');
  });

  it('omits the reason clause when there is none', () => {
    const body = renderMessageBody('order_cancelled', { ...variables, reason: null });
    expect(body).not.toContain('Reason:');
  });

  it('falls back to something sensible for an unknown key', () => {
    expect(renderMessageBody('not_a_real_key', variables)).toContain('DHA-0042');
  });

  it('orders template variables positionally', () => {
    // WhatsApp templates use {{1}}, {{2}}, so the order is part of the
    // template's contract — changing it silently rewrites live messages.
    expect(templateVariables('order_confirmed', variables)).toEqual([
      'Ayesha',
      'DHA-0042',
      'Kababjees',
    ]);
    expect(templateVariables('order_cancelled', variables)).toEqual([
      'Ayesha',
      'DHA-0042',
      'Kitchen closed',
    ]);
    expect(templateVariables('order_unacknowledged', variables)).toEqual(['DHA-0042', 'DHA']);
  });
});
