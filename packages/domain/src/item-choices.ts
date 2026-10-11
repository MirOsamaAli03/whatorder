/**
 * Assembling one menu item over a conversation (backlog B-26).
 *
 * A pizza is not a thing you tap once. It has a size, it may have a crust, and
 * it may have extras — and WhatsApp can only ask one question at a time. This
 * decides which question comes next, given what the customer has chosen so
 * far.
 *
 * Pure, and deliberately so: "which question next" is the kind of rule that is
 * tedious to reason about and cheap to test exhaustively — a required group
 * with one option, an optional group with none, a multi-select whose minimum
 * is not yet met. The conversation service asks and records; this decides.
 *
 * Until this existed, a dish needing any choice was hidden from the WhatsApp
 * menu entirely, because the flow added items at base price and checkout would
 * refuse them at the final step. For a menu sold by size — a pizza place —
 * that meant almost nothing was orderable.
 */

export interface ChoosableOption {
  id: string;
  name: string;
  priceDelta: string;
  isAvailable: boolean;
}

export interface ChoosableModifier {
  id: string;
  name: string;
  required: boolean;
  minSelections: number;
  maxSelections: number;
  options: ChoosableOption[];
}

export interface ChoosableVariant {
  id: string;
  name: string;
  price: string;
}

export interface ChoosableItem {
  id: string;
  name: string;
  currency: string;
  price: string;
  variants: ChoosableVariant[];
  modifiers: ChoosableModifier[];
}

/** What the customer has picked so far for the item being assembled. */
export interface ItemChoices {
  variantId?: string;
  /** Option ids chosen, across every group. */
  optionIds: string[];
  /** The modifier group currently being asked about, by index. */
  groupIndex: number;
}

export type ItemQuestion =
  | { kind: 'variant'; variants: ChoosableVariant[] }
  | { kind: 'modifier'; groupIndex: number; modifier: ChoosableModifier }
  | { kind: 'quantity' };

export function emptyChoices(): ItemChoices {
  return { optionIds: [], groupIndex: 0 };
}

/** Options of this group that the customer has already chosen. */
export function chosenInGroup(modifier: ChoosableModifier, choices: ItemChoices): string[] {
  const ids = new Set(modifier.options.map((option) => option.id));
  return choices.optionIds.filter((id) => ids.has(id));
}

/** Only options that can actually be picked. A sold-out topping is not a choice. */
export function availableOptions(modifier: ChoosableModifier): ChoosableOption[] {
  return modifier.options.filter((option) => option.isAvailable);
}

/**
 * Whether a group has been answered sufficiently to move past it.
 *
 * A required group needs at least its minimum. An optional one is satisfied
 * immediately — the customer may add nothing, and asking again would trap
 * them.
 */
export function isGroupSatisfied(modifier: ChoosableModifier, choices: ItemChoices): boolean {
  const required = modifier.required || modifier.minSelections > 0;
  if (!required) return true;

  return chosenInGroup(modifier, choices).length >= Math.max(1, modifier.minSelections);
}

/** Whether this group can take another option, or is already full. */
export function isGroupFull(modifier: ChoosableModifier, choices: ItemChoices): boolean {
  return chosenInGroup(modifier, choices).length >= Math.max(1, modifier.maxSelections);
}

/** A group that offers exactly one thing, or at most one. */
export function isSingleChoice(modifier: ChoosableModifier): boolean {
  return Math.max(1, modifier.maxSelections) === 1;
}

/**
 * The next thing to ask, or `quantity` when the item is fully specified.
 *
 * Groups are walked from `groupIndex` so the customer is never taken back to a
 * question they have already answered — including an optional one they chose
 * to skip, which is indistinguishable from an unanswered one by the choices
 * alone.
 */
export function nextItemQuestion(item: ChoosableItem, choices: ItemChoices): ItemQuestion {
  // A size, when there is a decision to make. One variant is not a choice,
  // and making somebody confirm it reads as a bot that does not know what it
  // is doing.
  if (item.variants.length > 1 && !choices.variantId) {
    return { kind: 'variant', variants: item.variants };
  }

  for (let index = choices.groupIndex; index < item.modifiers.length; index += 1) {
    const modifier = item.modifiers[index]!;

    // A group whose every option is sold out cannot be asked about. If it was
    // required, that is a menu problem rather than a conversation one — the
    // order will be refused at checkout and say why, which is better than a
    // question with no answers.
    if (availableOptions(modifier).length === 0) continue;

    if (!isGroupSatisfied(modifier, choices) || !hasPassed(index, choices)) {
      return { kind: 'modifier', groupIndex: index, modifier };
    }
  }

  return { kind: 'quantity' };
}

/**
 * Whether the customer has been taken past this group already.
 *
 * `groupIndex` is the cursor: anything before it has been asked and answered
 * or skipped. Without it an optional group would be asked forever, since
 * choosing nothing leaves it satisfied but unanswered.
 */
function hasPassed(index: number, choices: ItemChoices): boolean {
  return index < choices.groupIndex;
}

/**
 * Records a chosen option and works out whether the group is finished.
 *
 * A single-choice group advances the moment something is picked. A
 * multi-select stays put until the customer says they are done or it fills up,
 * so they can add a second topping without the bot moving on.
 */
export function chooseOption(
  modifier: ChoosableModifier,
  choices: ItemChoices,
  optionId: string,
): ItemChoices {
  const valid = availableOptions(modifier).some((option) => option.id === optionId);
  if (!valid) return choices;

  if (isSingleChoice(modifier)) {
    // Replaces rather than appends: picking "Large" after "Medium" is a
    // correction, not a second size.
    const others = choices.optionIds.filter(
      (id) => !modifier.options.some((option) => option.id === id),
    );
    return { ...choices, optionIds: [...others, optionId], groupIndex: choices.groupIndex + 1 };
  }

  const already = chosenInGroup(modifier, choices).includes(optionId);
  const optionIds = already
    ? choices.optionIds.filter((id) => id !== optionId)
    : [...choices.optionIds, optionId];

  const next = { ...choices, optionIds };

  // Full means finished: there is nothing left to offer.
  return isGroupFull(modifier, next) ? { ...next, groupIndex: choices.groupIndex + 1 } : next;
}

/**
 * Moves past the current group, if the customer is allowed to.
 *
 * Returns the unchanged choices when a required minimum is unmet, so the
 * caller can ask again rather than building an item checkout will refuse.
 */
export function finishGroup(
  modifier: ChoosableModifier,
  choices: ItemChoices,
): { choices: ItemChoices; moved: boolean } {
  if (!isGroupSatisfied(modifier, choices)) return { choices, moved: false };
  return { choices: { ...choices, groupIndex: choices.groupIndex + 1 }, moved: true };
}

/** What the customer has built so far, for the confirmation line. */
export function describeChoices(item: ChoosableItem, choices: ItemChoices): string {
  const parts: string[] = [];

  const variant = item.variants.find((candidate) => candidate.id === choices.variantId);
  if (variant) parts.push(variant.name);

  for (const modifier of item.modifiers) {
    for (const option of modifier.options) {
      if (choices.optionIds.includes(option.id)) parts.push(option.name);
    }
  }

  return parts.length > 0 ? `${item.name} (${parts.join(', ')})` : item.name;
}
