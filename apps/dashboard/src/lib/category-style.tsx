import type { ComponentType } from 'react';
import {
  DishIcon,
  DrinkIcon,
  KarahiIcon,
  PizzaIcon,
  RiceIcon,
  SkewerIcon,
} from '@/components/icons';

/** The six tints the design defines, in the order they look best together. */
const TINTS = ['t-saffron', 't-mint', 't-chai', 't-aubergine', 't-indigo', 't-clay'] as const;

/**
 * Keywords to a shape and a colour, most specific first.
 *
 * The design drew a tile per category because a menu with no photographs is
 * otherwise a wall of text — but it drew them for a fixed demo menu. Real
 * categories are whatever the restaurant typed, in English or Urdu, so the
 * icon has to be guessed from the name.
 *
 * Guessing is the right trade here: a wrong-but-plausible bowl costs nothing,
 * whereas making somebody pick an icon for every category is a chore added to
 * the one job — building a menu — that is already the longest in the product.
 * A category that matches nothing falls back to a plate and still gets a
 * distinct colour, so the tiles remain tellable apart.
 */
const RULES: Array<{ match: RegExp; icon: ComponentType<{ className?: string }>; tint: string }> = [
  { match: /bbq|barbe|tikka|kabab|kebab|seekh|boti|grill|باربی|کباب/i, icon: SkewerIcon, tint: 't-clay' },
  { match: /karahi|handi|curry|qorma|korma|salan|نہاری|کڑاہی|ہانڈی/i, icon: KarahiIcon, tint: 't-saffron' },
  { match: /rice|biryani|pulao|pilaf|chawal|چاول|بریانی|پلاؤ/i, icon: RiceIcon, tint: 't-mint' },
  { match: /pizza|پیزا/i, icon: PizzaIcon, tint: 't-clay' },
  { match: /drink|beverage|juice|chai|tea|coffee|shake|soda|مشروب|چائے/i, icon: DrinkIcon, tint: 't-indigo' },
  { match: /dessert|sweet|ice.?cream|kheer|halwa|میٹھا|حلوہ/i, icon: DishIcon, tint: 't-aubergine' },
  { match: /naan|roti|bread|paratha|نان|روٹی/i, icon: DishIcon, tint: 't-chai' },
  { match: /burger|sandwich|roll|wrap|برگر/i, icon: DishIcon, tint: 't-chai' },
];

export interface CategoryStyle {
  Icon: ComponentType<{ className?: string }>;
  /** A tint class, e.g. `t-saffron`. Goes on `.cat-tile` and on each `.dish`. */
  tint: string;
}

/**
 * How a category and its dishes should be tinted.
 *
 * `index` is only used when nothing matches, so that two unrecognised
 * categories still differ from one another rather than both being grey.
 */
export function categoryStyle(name: string, index = 0): CategoryStyle {
  const rule = RULES.find((candidate) => candidate.match.test(name));
  if (rule) return { Icon: rule.icon, tint: rule.tint };

  return { Icon: DishIcon, tint: TINTS[index % TINTS.length]! };
}
