import { describe, expect, it } from 'vitest';
import { Money, MoneyError } from './money';

describe('Money', () => {
  describe('construction', () => {
    it('rejects non-integer minor units', () => {
      expect(() => Money.fromMinor(10.5)).toThrow(MoneyError);
    });

    it('parses decimal strings without touching a float', () => {
      expect(Money.fromDecimalString('1250.75').minor).toBe(125075);
      expect(Money.fromDecimalString('0.05').minor).toBe(5);
      expect(Money.fromDecimalString('0.5').minor).toBe(50);
      expect(Money.fromDecimalString('700').minor).toBe(70000);
      expect(Money.fromDecimalString('-25.30').minor).toBe(-2530);
    });

    it('rejects malformed decimal strings rather than guessing', () => {
      for (const bad of ['', 'abc', '1.234', '1,250.00', '1.2.3', 'Rs 700']) {
        expect(() => Money.fromDecimalString(bad), bad).toThrow(MoneyError);
      }
    });

    it('round-trips through a decimal string', () => {
      for (const value of ['0.00', '0.01', '9.99', '1250.75', '-25.30']) {
        expect(Money.fromDecimalString(value).toDecimalString()).toBe(value);
      }
    });
  });

  describe('arithmetic', () => {
    // The whole reason this class exists.
    it('does not accumulate float error where raw numbers would', () => {
      expect(0.1 + 0.2).not.toBe(0.3);
      const sum = Money.fromMajor(0.1).add(Money.fromMajor(0.2));
      expect(sum.minor).toBe(30);
      expect(sum.toDecimalString()).toBe('0.30');
    });

    it('stays exact across a thousand additions', () => {
      let total = Money.zero();
      for (let i = 0; i < 1000; i += 1) {
        total = total.add(Money.fromDecimalString('0.07'));
      }
      expect(total.toDecimalString()).toBe('70.00');
    });

    it('multiplies by whole quantities exactly', () => {
      expect(Money.fromDecimalString('349.99').multiply(3).toDecimalString()).toBe('1049.97');
    });

    it('refuses fractional quantities', () => {
      expect(() => Money.fromMajor(100).multiply(2.5)).toThrow(MoneyError);
    });

    it('applies percentages with half-away-from-zero rounding', () => {
      // 15% GST on Rs 700.00 is exactly 105.00
      expect(Money.fromDecimalString('700.00').percentage(15).toDecimalString()).toBe('105.00');
      // 17% on Rs 349.99 is 59.4983 -> 59.50
      expect(Money.fromDecimalString('349.99').percentage(17).toDecimalString()).toBe('59.50');
      // Exact half rounds up, not to even.
      expect(Money.fromMinor(5).rate(0.5).minor).toBe(3);
    });

    it('sums a list of line totals', () => {
      const lines = [
        Money.fromDecimalString('700.00').multiply(2),
        Money.fromDecimalString('250.50'),
        Money.fromDecimalString('120.25'),
      ];
      expect(Money.sum(lines).toDecimalString()).toBe('1770.75');
    });

    it('rejects mixing currencies', () => {
      const pkr = Money.fromMajor(100, 'PKR');
      const usd = Money.fromMajor(100, 'USD');
      expect(() => pkr.add(usd)).toThrow(MoneyError);
    });

    it('treats zero as currency-compatible so sums can be seeded', () => {
      const usd = Money.fromMajor(10, 'USD');
      const result = Money.zero().add(usd);
      expect(result.currency).toBe('USD');
      expect(result.minor).toBe(1000);
    });
  });

  describe('allocate', () => {
    it('never loses a paisa when splitting', () => {
      const shares = Money.fromDecimalString('10.00').allocate(3);
      expect(shares.map((s) => s.toDecimalString())).toEqual(['3.34', '3.33', '3.33']);
      expect(Money.sum(shares).toDecimalString()).toBe('10.00');
    });

    it('splits evenly when it divides cleanly', () => {
      const shares = Money.fromDecimalString('100.00').allocate(4);
      expect(shares.every((s) => s.toDecimalString() === '25.00')).toBe(true);
    });

    it('handles negative amounts without losing a paisa', () => {
      const shares = Money.fromDecimalString('-10.00').allocate(3);
      expect(Money.sum(shares).toDecimalString()).toBe('-10.00');
    });

    it('rejects a non-positive part count', () => {
      expect(() => Money.fromMajor(10).allocate(0)).toThrow(MoneyError);
    });
  });

  describe('comparison and clamping', () => {
    it('clamps a discount that exceeds the subtotal', () => {
      const subtotal = Money.fromDecimalString('500.00');
      const discount = Money.fromDecimalString('700.00');
      expect(subtotal.subtract(discount).clampToZero().toDecimalString()).toBe('0.00');
    });

    it('compares values', () => {
      const a = Money.fromMajor(100);
      const b = Money.fromMajor(200);
      expect(a.lessThan(b)).toBe(true);
      expect(b.greaterThan(a)).toBe(true);
      expect(a.equals(Money.fromMajor(100))).toBe(true);
      expect(Money.zero().isZero()).toBe(true);
    });
  });
});
