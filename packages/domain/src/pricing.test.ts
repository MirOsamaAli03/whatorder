import { describe, expect, it } from 'vitest';
import { ValidationError } from './errors';
import { Money } from './money';
import { computeBusinessDate, computeOrderTotals, haversineMetres } from './pricing';

function line(price: string, quantity = 1) {
  return { unitPrice: Money.fromDecimalString(price), quantity };
}

describe('computeOrderTotals', () => {
  it('sums line totals into a subtotal', () => {
    const totals = computeOrderTotals({
      lines: [line('700.00', 2), line('450.00'), line('120.00', 3)],
      rules: { taxPercent: 0 },
    });

    // 1400 + 450 + 360
    expect(totals.subtotal.toDecimalString()).toBe('2210.00');
    expect(totals.total.toDecimalString()).toBe('2210.00');
  });

  it('applies 15% GST', () => {
    const totals = computeOrderTotals({
      lines: [line('700.00', 2)],
      rules: { taxPercent: 15 },
    });

    expect(totals.subtotal.toDecimalString()).toBe('1400.00');
    expect(totals.taxAmount.toDecimalString()).toBe('210.00');
    expect(totals.total.toDecimalString()).toBe('1610.00');
  });

  it('taxes the discounted subtotal, not the original', () => {
    const totals = computeOrderTotals({
      lines: [line('1000.00')],
      discount: Money.fromDecimalString('200.00'),
      rules: { taxPercent: 15 },
    });

    // The customer is not taxed on money they did not pay: 15% of 800, not 1000.
    expect(totals.discountAmount.toDecimalString()).toBe('200.00');
    expect(totals.taxAmount.toDecimalString()).toBe('120.00');
    expect(totals.total.toDecimalString()).toBe('920.00');
  });

  it('never lets a discount push the bill below zero', () => {
    const totals = computeOrderTotals({
      lines: [line('500.00')],
      discount: Money.fromDecimalString('900.00'),
      rules: { taxPercent: 15 },
    });

    // The discount is capped at the subtotal; it never becomes a credit.
    expect(totals.discountAmount.toDecimalString()).toBe('500.00');
    expect(totals.taxAmount.toDecimalString()).toBe('0.00');
    expect(totals.total.toDecimalString()).toBe('0.00');
  });

  it('adds the delivery fee after tax by default', () => {
    const totals = computeOrderTotals({
      lines: [line('1000.00')],
      deliveryFee: Money.fromDecimalString('150.00'),
      rules: { taxPercent: 15 },
    });

    // Tax on 1000 only, then the fee on top.
    expect(totals.taxAmount.toDecimalString()).toBe('150.00');
    expect(totals.deliveryFee.toDecimalString()).toBe('150.00');
    expect(totals.total.toDecimalString()).toBe('1300.00');
  });

  it('taxes the delivery fee when the tenant is configured that way', () => {
    const totals = computeOrderTotals({
      lines: [line('1000.00')],
      deliveryFee: Money.fromDecimalString('150.00'),
      rules: { taxPercent: 15, taxAppliesToDeliveryFee: true },
    });

    // 15% of 1150
    expect(totals.taxAmount.toDecimalString()).toBe('172.50');
    expect(totals.total.toDecimalString()).toBe('1322.50');
  });

  it('applies a service charge before tax', () => {
    const totals = computeOrderTotals({
      lines: [line('1000.00')],
      rules: { taxPercent: 15, serviceChargePercent: 5 },
    });

    expect(totals.serviceCharge.toDecimalString()).toBe('50.00');
    // 15% of 1050
    expect(totals.taxAmount.toDecimalString()).toBe('157.50');
    expect(totals.total.toDecimalString()).toBe('1207.50');
  });

  it('computes the service charge on the discounted subtotal', () => {
    const totals = computeOrderTotals({
      lines: [line('1000.00')],
      discount: Money.fromDecimalString('200.00'),
      rules: { taxPercent: 0, serviceChargePercent: 10 },
    });

    expect(totals.serviceCharge.toDecimalString()).toBe('80.00');
    expect(totals.total.toDecimalString()).toBe('880.00');
  });

  it('combines every component in the right order', () => {
    const totals = computeOrderTotals({
      lines: [line('650.00', 2), line('120.00')],
      discount: Money.fromDecimalString('100.00'),
      deliveryFee: Money.fromDecimalString('150.00'),
      rules: { taxPercent: 15, serviceChargePercent: 5 },
    });

    // subtotal 1420, discounted 1320, service 66, tax 15% of 1386 = 207.90
    expect(totals.subtotal.toDecimalString()).toBe('1420.00');
    expect(totals.discountAmount.toDecimalString()).toBe('100.00');
    expect(totals.serviceCharge.toDecimalString()).toBe('66.00');
    expect(totals.taxAmount.toDecimalString()).toBe('207.90');
    expect(totals.total.toDecimalString()).toBe('1743.90');
  });

  it('keeps the total exactly equal to the sum of its parts', () => {
    // The property a receipt has to satisfy, whatever the rounding.
    const totals = computeOrderTotals({
      lines: [line('333.33', 3), line('66.67')],
      discount: Money.fromDecimalString('99.99'),
      deliveryFee: Money.fromDecimalString('149.99'),
      rules: { taxPercent: 17, serviceChargePercent: 7 },
    });

    const rebuilt = totals.subtotal
      .subtract(totals.discountAmount)
      .add(totals.serviceCharge)
      .add(totals.taxAmount)
      .add(totals.deliveryFee);

    expect(rebuilt.toDecimalString()).toBe(totals.total.toDecimalString());
  });

  it('handles an empty order', () => {
    const totals = computeOrderTotals({ lines: [], rules: { taxPercent: 15 } });
    expect(totals.subtotal.toDecimalString()).toBe('0.00');
    expect(totals.total.toDecimalString()).toBe('0.00');
  });

  it('rejects a non-positive or fractional quantity', () => {
    for (const quantity of [0, -1, 1.5]) {
      expect(() =>
        computeOrderTotals({
          lines: [{ unitPrice: Money.fromDecimalString('100.00'), quantity }],
          rules: { taxPercent: 0 },
        }),
      ).toThrow(ValidationError);
    }
  });

  it('rejects a negative discount or delivery fee', () => {
    expect(() =>
      computeOrderTotals({
        lines: [line('100.00')],
        discount: Money.fromMinor(-100),
        rules: { taxPercent: 0 },
      }),
    ).toThrow(ValidationError);

    expect(() =>
      computeOrderTotals({
        lines: [line('100.00')],
        deliveryFee: Money.fromMinor(-100),
        rules: { taxPercent: 0 },
      }),
    ).toThrow(ValidationError);
  });
});

describe('computeBusinessDate', () => {
  it('uses the tenant timezone, not UTC', () => {
    // 19:00 UTC is 00:00 the next day in Karachi (UTC+5).
    const instant = new Date('2026-09-10T19:00:00Z');
    expect(computeBusinessDate(instant, 'Asia/Karachi', 0)).toBe('2026-09-11');
    expect(computeBusinessDate(instant, 'UTC', 0)).toBe('2026-09-10');
  });

  it('puts late-night trading on the previous business day', () => {
    // 02:00 Karachi on the 11th, with the day rolling over at 04:00, belongs to
    // the 10th — the night the restaurant was actually working.
    const instant = new Date('2026-09-10T21:00:00Z');
    expect(computeBusinessDate(instant, 'Asia/Karachi', 0)).toBe('2026-09-11');
    expect(computeBusinessDate(instant, 'Asia/Karachi', 240)).toBe('2026-09-10');
  });

  it('leaves daytime trading on its own date', () => {
    // 14:00 Karachi.
    const instant = new Date('2026-09-11T09:00:00Z');
    expect(computeBusinessDate(instant, 'Asia/Karachi', 240)).toBe('2026-09-11');
  });

  it('rolls over exactly at the configured minute', () => {
    // 04:00 Karachi exactly — the first order of the new business day.
    const justAfter = new Date('2026-09-10T23:00:00Z');
    expect(computeBusinessDate(justAfter, 'Asia/Karachi', 240)).toBe('2026-09-11');

    // One minute earlier still belongs to the previous day.
    const justBefore = new Date('2026-09-10T22:59:00Z');
    expect(computeBusinessDate(justBefore, 'Asia/Karachi', 240)).toBe('2026-09-10');
  });

  it('rejects an out-of-range rollover', () => {
    const instant = new Date('2026-09-11T09:00:00Z');
    expect(() => computeBusinessDate(instant, 'Asia/Karachi', 1440)).toThrow(ValidationError);
    expect(() => computeBusinessDate(instant, 'Asia/Karachi', -1)).toThrow(ValidationError);
  });
});

describe('haversineMetres', () => {
  it('is zero for the same point', () => {
    const point = { latitude: 24.8607, longitude: 67.0011 };
    expect(haversineMetres(point, point)).toBe(0);
  });

  it('measures a known Karachi distance', () => {
    // Saddar to Clifton is roughly 5 km.
    const saddar = { latitude: 24.8607, longitude: 67.0011 };
    const clifton = { latitude: 24.8138, longitude: 67.0299 };
    const distance = haversineMetres(saddar, clifton);

    expect(distance).toBeGreaterThan(5_000);
    expect(distance).toBeLessThan(7_000);
  });

  it('is symmetric', () => {
    const a = { latitude: 24.8607, longitude: 67.0011 };
    const b = { latitude: 31.5204, longitude: 74.3587 };
    expect(haversineMetres(a, b)).toBe(haversineMetres(b, a));
  });
});
