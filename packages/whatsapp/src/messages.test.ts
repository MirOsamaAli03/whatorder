import { describe, expect, it } from 'vitest';
import { buttonsMessage, countRows, listMessage, textMessage } from './messages';
import { WHATSAPP_LIMITS, truncate } from './provider';

describe('truncate', () => {
  it('leaves a short value alone', () => {
    expect(truncate('Fries', 20)).toBe('Fries');
  });

  it('marks a clipped value so it still reads as one', () => {
    const clipped = truncate('Chicken Malai Boti Handi (Family Size)', 20);
    // At most the limit — a space before the ellipsis is trimmed, so it can
    // come in one short.
    expect(clipped.length).toBeLessThanOrEqual(20);
    expect(clipped.endsWith('…')).toBe(true);
    expect(clipped).not.toContain(' …');
  });

  it('trims before measuring', () => {
    expect(truncate('  Fries  ', 20)).toBe('Fries');
  });
});

describe('buttonsMessage', () => {
  it('keeps three buttons and drops the rest', () => {
    // A fourth button makes WhatsApp reject the whole message, so the customer
    // would see nothing at all. Dropping it is the lesser failure, and callers
    // list buttons in priority order.
    const message = buttonsMessage({
      to: '+923001234567',
      body: 'How would you like your order?',
      buttons: [
        { id: 'type:DELIVERY', title: 'Delivery' },
        { id: 'type:PICKUP', title: 'Pickup' },
        { id: 'type:DINE_IN', title: 'Dine in' },
        { id: 'cancel', title: 'Cancel' },
      ],
    });

    expect(message.buttons).toHaveLength(3);
    expect(message.buttons.map((button) => button.id)).not.toContain('cancel');
  });

  it('shortens a button title past the limit', () => {
    const message = buttonsMessage({
      to: '+923001234567',
      body: 'Pick one',
      buttons: [{ id: 'item:1', title: 'Chicken Malai Boti Handi (Family Size)' }],
    });

    expect(message.buttons[0]!.title.length).toBeLessThanOrEqual(WHATSAPP_LIMITS.buttonTitle);
    // The id is never touched: it is the contract that makes the tap readable.
    expect(message.buttons[0]!.id).toBe('item:1');
  });
});

describe('listMessage', () => {
  function rows(count: number, prefix = 'item') {
    return Array.from({ length: count }, (_, index) => ({
      id: `${prefix}:${index}`,
      title: `Item ${index}`,
    }));
  }

  it('keeps ten rows across all sections, not ten per section', () => {
    // The easy thing to get wrong when a menu has several categories — and it
    // fails as a rejected message rather than as a truncated one.
    const message = listMessage({
      to: '+923001234567',
      body: 'Our menu',
      buttonLabel: 'View menu',
      sections: [
        { title: 'Starters', rows: rows(6, 'a') },
        { title: 'Mains', rows: rows(6, 'b') },
        { title: 'Drinks', rows: rows(6, 'c') },
      ],
    });

    expect(countRows(message)).toBe(10);
    expect(message.sections[0]!.rows).toHaveLength(6);
    expect(message.sections[1]!.rows).toHaveLength(4);
    // A section with nothing left is dropped: an empty one is also a rejection.
    expect(message.sections).toHaveLength(2);
  });

  it('shortens row titles and descriptions', () => {
    const message = listMessage({
      to: '+923001234567',
      body: 'Our menu',
      buttonLabel: 'View menu',
      sections: [
        {
          title: 'A very long section title indeed, far too long',
          rows: [
            {
              id: 'item:1',
              title: 'Chicken Malai Boti Handi (Family Size)',
              description: 'x'.repeat(200),
            },
          ],
        },
      ],
    });

    const row = message.sections[0]!.rows[0]!;
    expect(row.title.length).toBeLessThanOrEqual(WHATSAPP_LIMITS.rowTitle);
    expect(row.description!.length).toBeLessThanOrEqual(WHATSAPP_LIMITS.rowDescription);
    expect(message.sections[0]!.title.length).toBeLessThanOrEqual(WHATSAPP_LIMITS.sectionTitle);
    expect(row.id).toBe('item:1');
  });

  it('omits a description that was not given', () => {
    const message = listMessage({
      to: '+923001234567',
      body: 'Our menu',
      buttonLabel: 'View',
      sections: [{ title: 'Mains', rows: [{ id: 'item:1', title: 'Fries' }] }],
    });

    expect(message.sections[0]!.rows[0]).not.toHaveProperty('description');
  });
});

describe('textMessage', () => {
  it('stays within the body limit', () => {
    const message = textMessage('+923001234567', 'x'.repeat(2000));
    expect(message.body.length).toBeLessThanOrEqual(WHATSAPP_LIMITS.body);
    expect(message.kind).toBe('text');
  });
});
