import { describe, expect, it } from 'vitest';
import {
  chooseOption,
  chosenInGroup,
  describeChoices,
  emptyChoices,
  finishGroup,
  isGroupSatisfied,
  nextItemQuestion,
  type ChoosableItem,
  type ChoosableModifier,
} from './item-choices';

function option(id: string, name: string, isAvailable = true) {
  return { id, name, priceDelta: '0.00', isAvailable };
}

function modifier(over: Partial<ChoosableModifier> = {}): ChoosableModifier {
  return {
    id: 'm1',
    name: 'Toppings',
    required: false,
    minSelections: 0,
    maxSelections: 1,
    options: [option('o1', 'Cheese'), option('o2', 'Olives')],
    ...over,
  };
}

function item(over: Partial<ChoosableItem> = {}): ChoosableItem {
  return {
    id: 'i1',
    name: 'Pizza',
    currency: 'PKR',
    price: '900.00',
    variants: [],
    modifiers: [],
    ...over,
  };
}

const SIZES = [
  { id: 'v1', name: 'Small', price: '700.00' },
  { id: 'v2', name: 'Large', price: '1200.00' },
];

describe('what to ask next', () => {
  it('asks for a quantity when there is nothing to choose', () => {
    expect(nextItemQuestion(item(), emptyChoices()).kind).toBe('quantity');
  });

  it('asks for a size when there is more than one', () => {
    const question = nextItemQuestion(item({ variants: SIZES }), emptyChoices());
    expect(question.kind).toBe('variant');
  });

  it('does not ask about a size there is only one of', () => {
    // Making somebody confirm the only option reads as a bot that does not
    // know what it is doing.
    const single = item({ variants: [SIZES[0]!] });
    expect(nextItemQuestion(single, emptyChoices()).kind).toBe('quantity');
  });

  it('asks the size before the toppings', () => {
    const pizza = item({ variants: SIZES, modifiers: [modifier({ required: true })] });
    expect(nextItemQuestion(pizza, emptyChoices()).kind).toBe('variant');

    const sized = { ...emptyChoices(), variantId: 'v2' };
    expect(nextItemQuestion(pizza, sized).kind).toBe('modifier');
  });

  it('asks a required group and will not move past it unanswered', () => {
    const pizza = item({ modifiers: [modifier({ required: true, minSelections: 1 })] });
    const question = nextItemQuestion(pizza, emptyChoices());

    expect(question.kind).toBe('modifier');
    if (question.kind !== 'modifier') return;
    expect(question.modifier.name).toBe('Toppings');
  });

  it('asks an optional group too, but only once', () => {
    // Optional still means offered — a customer who wants extra cheese should
    // be asked. Choosing nothing must not loop, which it would if "satisfied"
    // were the only test.
    const pizza = item({ modifiers: [modifier()] });

    expect(nextItemQuestion(pizza, emptyChoices()).kind).toBe('modifier');

    const skipped = { ...emptyChoices(), groupIndex: 1 };
    expect(nextItemQuestion(pizza, skipped).kind).toBe('quantity');
  });

  it('steps over a group whose options are all sold out', () => {
    // A question with no answers is worse than no question. If the group was
    // required, checkout refuses the order and says why.
    const soldOut = modifier({
      required: true,
      minSelections: 1,
      options: [option('o1', 'Cheese', false), option('o2', 'Olives', false)],
    });

    expect(nextItemQuestion(item({ modifiers: [soldOut] }), emptyChoices()).kind).toBe('quantity');
  });

  it('walks several groups in order', () => {
    const pizza = item({
      modifiers: [
        modifier({ id: 'm1', name: 'Crust', required: true, minSelections: 1 }),
        modifier({ id: 'm2', name: 'Extras', options: [option('o3', 'Chilli')] }),
      ],
    });

    let choices = emptyChoices();
    let question = nextItemQuestion(pizza, choices);
    expect(question.kind === 'modifier' && question.modifier.name).toBe('Crust');

    choices = chooseOption(pizza.modifiers[0]!, choices, 'o1');
    question = nextItemQuestion(pizza, choices);
    expect(question.kind === 'modifier' && question.modifier.name).toBe('Extras');

    choices = finishGroup(pizza.modifiers[1]!, choices).choices;
    expect(nextItemQuestion(pizza, choices).kind).toBe('quantity');
  });
});

describe('choosing options', () => {
  it('advances immediately on a single-choice group', () => {
    const crust = modifier({ required: true, minSelections: 1, maxSelections: 1 });
    const choices = chooseOption(crust, emptyChoices(), 'o1');

    expect(choices.optionIds).toEqual(['o1']);
    expect(choices.groupIndex).toBe(1);
  });

  it('replaces rather than appends when the group takes one', () => {
    // Picking Large after Medium is a correction, not a second size.
    const crust = modifier({ maxSelections: 1 });
    let choices = chooseOption(crust, emptyChoices(), 'o1');
    choices = chooseOption(crust, { ...choices, groupIndex: 0 }, 'o2');

    expect(choices.optionIds).toEqual(['o2']);
  });

  it('stays put on a multi-select so a second topping can be added', () => {
    const extras = modifier({ maxSelections: 3 });
    const choices = chooseOption(extras, emptyChoices(), 'o1');

    expect(choices.optionIds).toEqual(['o1']);
    expect(choices.groupIndex).toBe(0);
  });

  it('lets a tapped option be untapped', () => {
    const extras = modifier({ maxSelections: 3 });
    let choices = chooseOption(extras, emptyChoices(), 'o1');
    choices = chooseOption(extras, choices, 'o1');

    expect(choices.optionIds).toEqual([]);
  });

  it('moves on once the group is full', () => {
    const extras = modifier({ maxSelections: 2 });
    let choices = chooseOption(extras, emptyChoices(), 'o1');
    choices = chooseOption(extras, choices, 'o2');

    expect(chosenInGroup(extras, choices)).toEqual(['o1', 'o2']);
    expect(choices.groupIndex).toBe(1);
  });

  it('ignores an option that is not on offer', () => {
    // A stale tap from an older message must not put a sold-out topping on
    // an order.
    const extras = modifier({ options: [option('o1', 'Cheese', false)] });
    expect(chooseOption(extras, emptyChoices(), 'o1').optionIds).toEqual([]);
    expect(chooseOption(extras, emptyChoices(), 'nonsense').optionIds).toEqual([]);
  });
});

describe('finishing a group', () => {
  it('refuses to move past a required group with nothing chosen', () => {
    const crust = modifier({ required: true, minSelections: 1 });
    const result = finishGroup(crust, emptyChoices());

    // Building an item checkout will refuse is worse than asking again.
    expect(result.moved).toBe(false);
    expect(result.choices.groupIndex).toBe(0);
  });

  it('refuses while a minimum of two is half met', () => {
    const pair = modifier({ required: true, minSelections: 2, maxSelections: 3 });
    const choices = chooseOption(pair, emptyChoices(), 'o1');

    expect(isGroupSatisfied(pair, choices)).toBe(false);
    expect(finishGroup(pair, choices).moved).toBe(false);
  });

  it('lets an optional group be skipped', () => {
    const result = finishGroup(modifier(), emptyChoices());
    expect(result.moved).toBe(true);
    expect(result.choices.groupIndex).toBe(1);
  });
});

describe('describing what was built', () => {
  it('names the size and the extras in menu order', () => {
    const pizza = item({
      variants: SIZES,
      modifiers: [modifier({ maxSelections: 3 })],
    });

    const choices = { variantId: 'v2', optionIds: ['o2', 'o1'], groupIndex: 1 };

    // Menu order, not tap order: the customer reads it as a description of a
    // dish, not a log of what they did.
    expect(describeChoices(pizza, choices)).toBe('Pizza (Large, Cheese, Olives)');
  });

  it('is just the name when nothing was chosen', () => {
    expect(describeChoices(item(), emptyChoices())).toBe('Pizza');
  });
});
