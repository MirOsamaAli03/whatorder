import { WhatsAppSendMode } from '@restaurant-os/types';
import {
  WHATSAPP_LIMITS,
  truncate,
  type ButtonsMessage,
  type InteractiveButton,
  type InteractiveSection,
  type ListMessage,
  type SessionMessage,
} from './provider';

/**
 * Builders for outbound WhatsApp messages.
 *
 * Their job is to make a message that the provider will actually accept. Every
 * one of WhatsApp's limits — three buttons, ten rows, twenty characters on a
 * button title — rejects the *entire* message when exceeded, so the customer
 * sees nothing at all rather than something slightly wrong. A dish named
 * "Chicken Malai Boti Handi (Family Size)" is enough to trigger it.
 *
 * Enforcing that here means callers compose what they want to say, and cannot
 * accidentally build something unsendable.
 */

/** Three, from WhatsApp. Beyond this a list is required instead. */
const MAX_BUTTONS = 3;
/** Ten rows in total across all sections, also from WhatsApp. */
const MAX_ROWS = 10;

export function textMessage(to: string, body: string): SessionMessage {
  return {
    mode: WhatsAppSendMode.SESSION,
    kind: 'text',
    to,
    body: truncate(body, WHATSAPP_LIMITS.body),
  };
}

export interface ButtonsInput {
  to: string;
  body: string;
  buttons: InteractiveButton[];
  header?: string;
  footer?: string;
}

/**
 * Reply buttons.
 *
 * Extra buttons are dropped rather than throwing: a caller that offers four
 * choices has made a design mistake, but failing the send would turn it into a
 * customer receiving silence. The first three are the ones that matter, because
 * callers list them in priority order.
 */
export function buttonsMessage(input: ButtonsInput): ButtonsMessage {
  return {
    mode: WhatsAppSendMode.SESSION,
    kind: 'buttons',
    to: input.to,
    body: truncate(input.body, WHATSAPP_LIMITS.body),
    ...(input.header ? { header: truncate(input.header, WHATSAPP_LIMITS.header) } : {}),
    ...(input.footer ? { footer: truncate(input.footer, WHATSAPP_LIMITS.footer) } : {}),
    buttons: input.buttons.slice(0, MAX_BUTTONS).map((button) => ({
      id: button.id,
      title: truncate(button.title, WHATSAPP_LIMITS.buttonTitle),
    })),
  };
}

export interface ListInput {
  to: string;
  body: string;
  buttonLabel: string;
  sections: InteractiveSection[];
  header?: string;
  footer?: string;
}

/**
 * A list picker.
 *
 * The ten-row limit applies across *all* sections together, not per section,
 * which is the easy thing to get wrong when a menu has several categories. Rows
 * are taken in order until the budget is spent, and a section left with no rows
 * is dropped entirely — an empty section is also a rejection.
 */
export function listMessage(input: ListInput): ListMessage {
  let remaining = MAX_ROWS;
  const sections: InteractiveSection[] = [];

  for (const section of input.sections) {
    if (remaining <= 0) break;

    const rows = section.rows.slice(0, remaining).map((row) => ({
      id: row.id,
      title: truncate(row.title, WHATSAPP_LIMITS.rowTitle),
      ...(row.description
        ? { description: truncate(row.description, WHATSAPP_LIMITS.rowDescription) }
        : {}),
    }));

    if (rows.length === 0) continue;

    remaining -= rows.length;
    sections.push({ title: truncate(section.title, WHATSAPP_LIMITS.sectionTitle), rows });
  }

  return {
    mode: WhatsAppSendMode.SESSION,
    kind: 'list',
    to: input.to,
    body: truncate(input.body, WHATSAPP_LIMITS.body),
    ...(input.header ? { header: truncate(input.header, WHATSAPP_LIMITS.header) } : {}),
    ...(input.footer ? { footer: truncate(input.footer, WHATSAPP_LIMITS.footer) } : {}),
    buttonLabel: truncate(input.buttonLabel, WHATSAPP_LIMITS.buttonTitle),
    sections,
  };
}

/** Total rows across every section, for tests and for callers that page. */
export function countRows(message: ListMessage): number {
  return message.sections.reduce((total, section) => total + section.rows.length, 0);
}
