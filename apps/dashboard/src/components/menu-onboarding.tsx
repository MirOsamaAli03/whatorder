'use client';

import { browseCategoriesMessage } from '@restaurant-os/domain';
import { useMemo, useState } from 'react';
import { AlertIcon, CheckIcon } from '@/components/icons';
import { ApiError, api } from '@/lib/api-client';

/**
 * The first thing a new restaurant sees on an empty menu.
 *
 * An empty menu is this product's onboarding whether or not anybody designed
 * it as such: nothing else works until the menu exists, and building one from
 * nothing is the longest job in the product. So the empty state is a wizard
 * rather than a sentence and a button.
 *
 * It starts with categories because that is what the customer scrolls through
 * first, and it offers the ones a Pakistani kitchen is most likely to serve so
 * that the common case is a few taps rather than nine rounds of typing.
 */

/** Suggestions, not a taxonomy. Every one is renameable afterwards. */
const COMMON = [
  'BBQ',
  'Karahi',
  'Rice & Biryani',
  'Burgers',
  'Pizza',
  'Handi',
  'Naan & Roti',
  'Beverages',
  'Desserts',
];

/**
 * Groups almost every kitchen needs, offered up front.
 *
 * Created empty where the options are the restaurant's own business — nobody
 * can guess what somebody's extras cost — but with real options where the
 * answer is near-universal.
 */
const STARTERS: Array<{
  key: string;
  name: string;
  summary: string;
  required: boolean;
  minSelections: number;
  maxSelections: number;
  selectionType: 'SINGLE' | 'MULTIPLE';
  options: string[];
}> = [
  {
    key: 'spice',
    name: 'Spice level',
    summary: 'Mild, Medium, Hot · must choose one',
    required: true,
    minSelections: 1,
    maxSelections: 1,
    selectionType: 'SINGLE',
    options: ['Mild', 'Medium', 'Hot'],
  },
  {
    key: 'drink',
    name: 'Drink size',
    summary: 'Regular, 1.5 litre · must choose one',
    required: true,
    minSelections: 1,
    maxSelections: 1,
    selectionType: 'SINGLE',
    options: ['Regular', '1.5 litre'],
  },
  {
    key: 'extras',
    name: 'Extras',
    summary: 'Empty — you fill it · optional',
    required: false,
    minSelections: 0,
    maxSelections: 4,
    selectionType: 'MULTIPLE',
    options: [],
  },
];

export function MenuOnboarding({ onDone }: { onDone: () => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [typed, setTyped] = useState('');
  const [starters, setStarters] = useState<string[]>(['spice']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const names = useMemo(() => {
    const extra = typed
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    // De-duplicated case-insensitively: tapping "Pizza" and also typing it
    // should not create the section twice.
    const seen = new Set<string>();
    return [...picked, ...extra].filter((name) => {
      const key = name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [picked, typed]);

  async function create() {
    if (names.length === 0) return;
    setBusy(true);
    setError(null);

    try {
      // In order, so sortOrder matches what is on screen — which is the order
      // the customer will scroll through.
      for (const [index, name] of names.entries()) {
        await api('/menu/categories', { method: 'POST', body: { name, sortOrder: index } });
      }

      for (const key of starters) {
        const starter = STARTERS.find((candidate) => candidate.key === key);
        if (!starter) continue;

        await api('/menu/modifiers', {
          method: 'POST',
          body: {
            name: starter.name,
            selectionType: starter.selectionType,
            required: starter.required,
            minSelections: starter.minSelections,
            maxSelections: starter.maxSelections,
            options: starter.options.map((option) => ({ name: option, priceDelta: '0.00' })),
          },
        });
      }

      onDone();
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : 'Could not set the menu up. Nothing was lost.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="onb">
      <div className="card card-pad stack" style={{ gap: 20 }}>
        <div className="onb-progress">
          <span className="onb-step" aria-current="step">
            <span className="step-n">1</span>Categories
          </span>
          <span className="onb-step">
            <span className="step-n">2</span>Dishes &amp; prices
          </span>
          <span className="onb-step">
            <span className="step-n">3</span>Sizes &amp; choices
          </span>
        </div>

        <div className="stack" style={{ gap: 8 }}>
          <h2 className="empty-title" style={{ fontSize: 30, lineHeight: '36px' }}>
            Let&rsquo;s build your menu
          </h2>
          <p className="empty-body" style={{ textAlign: 'left' }}>
            Start with the sections customers scroll through on WhatsApp. Tap the ones you serve —
            you can rename and reorder them later.
          </p>
        </div>

        {error ? (
          <div className="alert alert-danger" role="alert">
            <AlertIcon />
            <div>{error}</div>
          </div>
        ) : null}

        <div className="stack" style={{ gap: 8 }}>
          <span className="field-label">Common categories</span>
          <div className="chips">
            {COMMON.map((name) => {
              const on = picked.includes(name);
              return (
                <button
                  key={name}
                  type="button"
                  className="chip"
                  aria-pressed={on}
                  onClick={() =>
                    setPicked(on ? picked.filter((row) => row !== name) : [...picked, name])
                  }
                >
                  {on ? <CheckIcon className="icon-sm" /> : null}
                  {name}
                </button>
              );
            })}
          </div>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="own-categories">
            Or type your own — one per line
          </label>
          <textarea
            id="own-categories"
            className="textarea"
            rows={3}
            placeholder={'Chef’s specials\nFamily deals'}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>

        <div className="row-wrap">
          <button
            type="button"
            className="btn btn-primary btn-lg"
            disabled={names.length === 0 || busy}
            onClick={() => void create()}
          >
            {busy
              ? 'Setting up…'
              : names.length === 0
                ? 'Pick at least one'
                : `Add ${names.length} categor${names.length === 1 ? 'y' : 'ies'}`}
          </button>
          <span className="sm muted">Next: add dishes to each one.</span>
        </div>
      </div>

      <div className="stack" style={{ gap: 16 }}>
        <div className="card card-pad stack" style={{ gap: 12 }}>
          <span className="sec-title">What the customer will see</span>
          <div className="wa-bubble">
            <b>{browseCategoriesMessage()}</b>
            {names.length > 0 ? (
              <>
                {'\n'}
                {names.map((name, index) => (
                  <span key={name} className="opt">
                    {index + 1}. {name}
                  </span>
                ))}
              </>
            ) : (
              <span className="opt faint">Pick a category to see this fill in.</span>
            )}
          </div>
          <span className="wa-note">
            Updates as you tap. The wording is the bot&rsquo;s own, so this is what gets sent.
          </span>
        </div>

        <div className="card card-pad stack" style={{ gap: 12 }}>
          <span className="sec-title">Starter option groups</span>
          <p className="sm muted">
            Most kitchens need these. Add them to your library now and attach them to dishes as you
            go.
          </p>

          {STARTERS.map((starter) => {
            const on = starters.includes(starter.key);
            return (
              <label key={starter.key} className="check">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() =>
                    setStarters(
                      on
                        ? starters.filter((key) => key !== starter.key)
                        : [...starters, starter.key],
                    )
                  }
                />
                <span className="check-box" aria-hidden="true">
                  <CheckIcon />
                </span>
                <span className="check-label">
                  <b>{starter.name}</b> — {starter.summary}
                </span>
              </label>
            );
          })}
        </div>
      </div>
    </div>
  );
}
