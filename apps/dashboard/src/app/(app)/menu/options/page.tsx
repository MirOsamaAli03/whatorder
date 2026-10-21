'use client';

import { askModifierMessage } from '@restaurant-os/domain';
import { Permission } from '@restaurant-os/types';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertIcon, CheckIcon, MenuIcon } from '@/components/icons';
import { MenuTabs } from '@/components/menu-tabs';
import { ApiError, api } from '@/lib/api-client';
import { useSession } from '@/lib/session';

/**
 * The option groups library.
 *
 * A group is shared: "Spice level" is defined once and attached to fifteen
 * dishes, so editing it edits all fifteen and deleting it removes a question
 * from all fifteen. Everything on this screen is arranged around making that
 * reach visible before somebody changes something — the count is on every row,
 * the dishes are named above the editor, and the save button says how far the
 * save goes.
 */

interface LibraryOption {
  id: string;
  name: string;
  priceDelta: string;
  isDefault: boolean;
  isAvailable: boolean;
}

interface LibraryGroup {
  id: string;
  name: string;
  selectionType: string;
  required: boolean;
  minSelections: number;
  maxSelections: number;
  options: LibraryOption[];
  usedByCount: number;
  usedBy: Array<{ id: string; name: string }>;
}

/** The three behaviours, in the words a restaurant owner would use. */
type Behaviour = 'one' | 'one-or-skip' | 'several';

const BEHAVIOURS: Array<{ key: Behaviour; title: string; example: string }> = [
  { key: 'one', title: 'Choose exactly one', example: 'Like spice level. They cannot skip it.' },
  { key: 'one-or-skip', title: 'Choose one, or skip', example: 'Like a free drink they may not want.' },
  { key: 'several', title: 'Choose several', example: 'Like add-ons. You set the limits.' },
];

function behaviourOf(group: {
  required: boolean;
  minSelections: number;
  maxSelections: number;
}): Behaviour {
  if (Math.max(1, group.maxSelections) > 1) return 'several';
  return group.required || group.minSelections > 0 ? 'one' : 'one-or-skip';
}

/** The rule in one sentence, which is the only form anybody should have to read. */
function describeRule(group: {
  required: boolean;
  minSelections: number;
  maxSelections: number;
}): string {
  const required = group.required || group.minSelections > 0;
  const maximum = Math.max(1, group.maxSelections);
  const minimum = Math.max(1, group.minSelections);

  if (maximum === 1) return required ? 'Must choose exactly one' : 'One, or skip';
  if (!required) return `Can add up to ${maximum}, or none`;
  if (minimum === maximum) return `Must choose exactly ${minimum}`;
  return `Must choose between ${minimum} and ${maximum}`;
}

export default function OptionGroupsPage() {
  const session = useSession();

  const [groups, setGroups] = useState<LibraryGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  // The form, held apart from the loaded list so a half-typed name survives a
  // reload and is not written to the server before Save.
  const [name, setName] = useState('');
  const [behaviour, setBehaviour] = useState<Behaviour>('one');
  const [minimum, setMinimum] = useState(1);
  const [maximum, setMaximum] = useState(1);
  const [options, setOptions] = useState<LibraryOption[]>([]);
  const [bulk, setBulk] = useState('');
  const [dirty, setDirty] = useState(false);

  const canEdit = session.can(Permission.MENU_UPDATE);
  const canCreate = session.can(Permission.MENU_CREATE);

  const load = useCallback(async () => {
    try {
      setGroups(await api<LibraryGroup[]>('/menu/modifiers'));
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not load the option groups');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const open = groups.find((group) => group.id === openId) ?? null;

  const show = useCallback((group: LibraryGroup | null) => {
    setOpenId(group?.id ?? null);
    setName(group?.name ?? '');
    setBehaviour(group ? behaviourOf(group) : 'one');
    setMinimum(group?.minSelections ?? 1);
    setMaximum(Math.max(1, group?.maxSelections ?? 1));
    setOptions(group?.options ?? []);
    setBulk('');
    setDirty(false);
  }, []);

  useEffect(() => {
    if (!openId && groups.length > 0) show(groups[0]!);
  }, [groups, openId, show]);

  // Keep the form in step with the list after a save.
  useEffect(() => {
    if (!openId || dirty) return;
    const fresh = groups.find((group) => group.id === openId);
    if (fresh) setOptions(fresh.options);
  }, [groups, openId, dirty]);

  async function run<T>(work: () => Promise<T>, failure: string): Promise<T | null> {
    setBusy(true);
    setError(null);
    try {
      return await work();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : failure);
      return null;
    } finally {
      setBusy(false);
    }
  }

  /** The three behaviours, turned back into the numbers the API stores. */
  function rulesFor(): { required: boolean; minSelections: number; maxSelections: number; selectionType: string } {
    if (behaviour === 'one') {
      return { required: true, minSelections: 1, maxSelections: 1, selectionType: 'SINGLE' };
    }
    if (behaviour === 'one-or-skip') {
      return { required: false, minSelections: 0, maxSelections: 1, selectionType: 'SINGLE' };
    }
    return {
      required: minimum > 0,
      minSelections: minimum,
      maxSelections: Math.max(minimum, maximum, 2),
      selectionType: 'MULTIPLE',
    };
  }

  async function createGroup() {
    const entered = window.prompt('What is this group called? For example, Spice level.');
    if (!entered?.trim()) return;

    const created = await run(
      () =>
        api<LibraryGroup>('/menu/modifiers', {
          method: 'POST',
          body: {
            name: entered.trim(),
            selectionType: 'SINGLE',
            required: true,
            minSelections: 1,
            maxSelections: 1,
            options: [],
          },
        }),
      'Could not create that group',
    );

    if (created) {
      await load();
      show(created);
    }
  }

  async function save() {
    if (!open) return;

    const ok = await run(async () => {
      await api(`/menu/modifiers/${open.id}`, {
        method: 'PATCH',
        body: { name: name.trim(), ...rulesFor() },
      });

      const removed = open.options.filter(
        (existing) => !options.some((option) => option.id === existing.id),
      );
      for (const option of removed) {
        await api(`/menu/options/${option.id}`, { method: 'DELETE' });
      }

      for (const [index, option] of options.entries()) {
        const body = {
          name: option.name.trim(),
          priceDelta: option.priceDelta.trim() || '0.00',
          isAvailable: option.isAvailable,
          sortOrder: index,
        };

        if (option.id.startsWith('new-')) {
          await api(`/menu/modifiers/${open.id}/options`, { method: 'POST', body });
        } else {
          await api(`/menu/options/${option.id}`, { method: 'PATCH', body });
        }
      }

      return true;
    }, 'Could not save that group');

    await load();
    if (ok) setDirty(false);
  }

  async function remove() {
    if (!open) return;
    const reach =
      open.usedByCount > 0
        ? `Delete "${open.name}"? It is used by ${open.usedByCount} dish${open.usedByCount === 1 ? '' : 'es'}, and the question disappears from all of them.`
        : `Delete "${open.name}"?`;
    if (!window.confirm(reach)) return;

    await run(
      () => api(`/menu/modifiers/${open.id}`, { method: 'DELETE' }),
      'Could not delete that group',
    );
    show(null);
    await load();
  }

  /** "Extra naan, 60" per line — the fast path when first setting a menu up. */
  function addBulk() {
    const added: LibraryOption[] = [];

    for (const line of bulk.split('\n')) {
      const text = line.trim();
      if (!text) continue;

      const comma = text.lastIndexOf(',');
      const hasPrice = comma > 0 && !Number.isNaN(Number(text.slice(comma + 1).trim()));

      added.push({
        id: `new-${Date.now()}-${added.length}`,
        name: (hasPrice ? text.slice(0, comma) : text).trim(),
        priceDelta: hasPrice ? Number(text.slice(comma + 1).trim()).toFixed(2) : '0.00',
        isDefault: false,
        isAvailable: true,
      });
    }

    if (added.length === 0) return;
    setOptions([...options, ...added]);
    setBulk('');
    setDirty(true);
  }

  const rules = rulesFor();

  /**
   * What the customer will actually be asked.
   *
   * Rendered by calling the bot's own copy function rather than by writing the
   * sentence again here, so the preview cannot drift from what is sent. The
   * design's version showed a different interaction — "reply with up to 3
   * numbers, like 1,3" — which this bot does not support: it re-sends the list
   * with the chosen rows ticked and a Done row, so that is what is shown.
   */
  const preview = useMemo(() => {
    const available = options.filter((option) => option.isAvailable);
    const multiple = Math.max(1, rules.maxSelections) > 1;
    const optional = !rules.required && rules.minSelections === 0;

    const rows = available.map(
      (option, index) =>
        `${index + 1}. ${option.name || '…'}${
          option.priceDelta && option.priceDelta !== '0.00' ? ` — + PKR ${option.priceDelta}` : ''
        }`,
    );

    if (multiple || optional) {
      rows.push(`${rows.length + 1}. ${optional ? 'Skip' : 'Done'}`);
    }

    return {
      body: askModifierMessage('Chicken Karahi', name || 'This group', rules),
      rows,
      hidden: options.length - available.length,
    };
  }, [options, name, rules]);

  if (loading) {
    return (
      <div className="page-head">
        <div className="page-title">
          <h1>Menu</h1>
          <p className="page-sub">Loading…</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="page-head">
        <div className="page-title">
          <h1>Menu</h1>
          <p className="page-sub">
            Option groups are defined once and shared by every dish they are attached to
          </p>
        </div>
      </div>

      <MenuTabs optionGroupCount={groups.length} />

      {error ? (
        <div className="alert alert-danger" role="alert">
          <AlertIcon />
          <div>{error}</div>
        </div>
      ) : null}

      <div className="lib">
        <section className="ed-pane" aria-label="Option groups">
          <div className="pane-head">
            <span className="pane-title">
              Library
              <small>
                {groups.length} group{groups.length === 1 ? '' : 's'}
              </small>
            </span>
            {canCreate ? (
              <button type="button" className="btn btn-sm" onClick={() => void createGroup()}>
                New
              </button>
            ) : null}
          </div>

          {groups.length === 0 ? (
            <div className="pane-body">
              <p className="sm muted">
                No groups yet. A group is a question the bot asks — spice level, crust, extras.
              </p>
            </div>
          ) : null}

          {groups.map((group) => (
            <button
              key={group.id}
              type="button"
              className="lib-row"
              aria-current={group.id === openId ? 'true' : undefined}
              onClick={() => show(group)}
              style={{ width: '100%', background: 'none', border: 0, cursor: 'pointer' }}
            >
              <span style={{ minWidth: 0, textAlign: 'left' }}>
                <b>{group.name}</b>
                <span>{describeRule(group)}</span>
              </span>
              <span className="uses">{group.usedByCount}</span>
            </button>
          ))}
        </section>

        <section className="ed-pane" aria-label="Group">
          {!open ? (
            <div className="empty" style={{ padding: '56px 24px' }}>
              <div className="empty-icon" aria-hidden="true">
                <MenuIcon className="icon-lg" />
              </div>
              <h2 className="empty-title" style={{ fontSize: 24, lineHeight: '30px' }}>
                Pick a group
              </h2>
              <p className="empty-body">
                Or create one. A group is a question a customer is asked when they order a dish it
                is attached to.
              </p>
            </div>
          ) : (
            <>
              <div className="pane-head">
                <span className="pane-title">
                  {open.name}
                  <small>Library group — edits apply everywhere it is used</small>
                </span>
                {canEdit ? (
                  <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove()}>
                    Delete group
                  </button>
                ) : null}
              </div>

              <div className="form-sec">
                {/* The reach of an edit, stated before the fields that make one. */}
                <div className="alert alert-info" role="status">
                  <AlertIcon />
                  <div>
                    <span className="alert-title">
                      {open.usedByCount === 0
                        ? 'Not attached to any dish yet.'
                        : `Shared by ${open.usedByCount} dish${open.usedByCount === 1 ? '' : 'es'}.`}
                    </span>{' '}
                    {open.usedByCount > 0 ? 'Anything you change here changes all of them.' : ''}
                    {open.usedBy.length > 0 ? (
                      <span className="row-wrap" style={{ marginTop: 8 }}>
                        {open.usedBy.map((dish) => (
                          <span key={dish.id} className="tag">
                            {dish.name}
                          </span>
                        ))}
                        {open.usedByCount > open.usedBy.length ? (
                          <span className="tag">+{open.usedByCount - open.usedBy.length} more</span>
                        ) : null}
                      </span>
                    ) : null}
                  </div>
                </div>

                <div className="field">
                  <label className="field-label" htmlFor="group-name">
                    Group name
                  </label>
                  <input
                    id="group-name"
                    className="input"
                    value={name}
                    disabled={!canEdit}
                    onChange={(event) => {
                      setName(event.target.value);
                      setDirty(true);
                    }}
                  />
                  <span className="field-hint">Shown as the question title.</span>
                </div>
              </div>

              <div className="form-sec">
                <div className="sec-head">
                  <span className="sec-title">What does the customer do?</span>
                  <span className="sec-help">Pick the behaviour; the numbers follow from it.</span>
                </div>

                <div className="rule-cards" role="radiogroup" aria-label="What does the customer do?">
                  {BEHAVIOURS.map((option) => (
                    <button
                      key={option.key}
                      type="button"
                      className="rcard"
                      role="radio"
                      aria-checked={behaviour === option.key}
                      disabled={!canEdit}
                      onClick={() => {
                        setBehaviour(option.key);
                        if (option.key === 'several') {
                          setMinimum(0);
                          setMaximum(Math.max(2, maximum));
                        }
                        setDirty(true);
                      }}
                    >
                      <b>{option.title}</b>
                      <span>{option.example}</span>
                    </button>
                  ))}
                </div>

                {behaviour === 'several' ? (
                  <div className="limits">
                    <label htmlFor="group-min">At least</label>
                    <div className="stepper">
                      <button
                        type="button"
                        aria-label="Fewer"
                        disabled={minimum <= 0 || !canEdit}
                        onClick={() => {
                          setMinimum(minimum - 1);
                          setDirty(true);
                        }}
                      >
                        −
                      </button>
                      <output id="group-min">{minimum}</output>
                      <button
                        type="button"
                        aria-label="More"
                        disabled={minimum >= maximum || !canEdit}
                        onClick={() => {
                          setMinimum(minimum + 1);
                          setDirty(true);
                        }}
                      >
                        +
                      </button>
                    </div>

                    <label htmlFor="group-max">Up to</label>
                    <div className="stepper">
                      <button
                        type="button"
                        aria-label="Fewer"
                        disabled={maximum <= Math.max(2, minimum) || !canEdit}
                        onClick={() => {
                          setMaximum(maximum - 1);
                          setDirty(true);
                        }}
                      >
                        −
                      </button>
                      <output id="group-max">{maximum}</output>
                      <button
                        type="button"
                        aria-label="More"
                        disabled={!canEdit}
                        onClick={() => {
                          setMaximum(maximum + 1);
                          setDirty(true);
                        }}
                      >
                        +
                      </button>
                    </div>
                  </div>
                ) : null}

                {/* The outcome in a sentence, so nobody has to reason about
                    minSelections and maxSelections to know what will happen. */}
                <div className="outcome">
                  <CheckIcon className="icon" />
                  <div>
                    <b>{describeRule(rules)}</b>
                    <span className="row-wrap" style={{ marginTop: 6 }}>
                      <span className="tag">{rules.required ? 'Required' : 'Optional'}</span>
                      <span className="tag">
                        {rules.maxSelections > 1 ? 'Pick several' : 'Pick one'}
                      </span>
                      <span className="tag">Min {rules.minSelections}</span>
                      <span className="tag">Max {rules.maxSelections}</span>
                    </span>
                  </div>
                </div>
              </div>

              <div className="form-sec">
                <div className="sec-head">
                  <span className="sec-title">Options</span>
                  <span className="sec-help">
                    Price is added to the dish. Use 0 for no extra cost, or a minus for a discount.
                  </span>
                </div>

                <div className="vtable">
                  <div className="vrow head">
                    <span />
                    <span>Name</span>
                    <span>Price change</span>
                    <span>Available</span>
                    <span />
                  </div>

                  {options.map((option, index) => (
                    <div key={option.id} className="vrow">
                      <span className="grip" aria-hidden="true">
                        ⋮⋮
                      </span>
                      <input
                        className="input"
                        aria-label={`Name of option ${index + 1}`}
                        value={option.name}
                        disabled={!canEdit}
                        onChange={(event) => {
                          setOptions(
                            options.map((row) =>
                              row.id === option.id ? { ...row, name: event.target.value } : row,
                            ),
                          );
                          setDirty(true);
                        }}
                      />
                      <input
                        className="input num"
                        aria-label={`Price change for ${option.name || `option ${index + 1}`}`}
                        inputMode="decimal"
                        value={option.priceDelta}
                        disabled={!canEdit}
                        onChange={(event) => {
                          setOptions(
                            options.map((row) =>
                              row.id === option.id
                                ? { ...row, priceDelta: event.target.value }
                                : row,
                            ),
                          );
                          setDirty(true);
                        }}
                      />
                      <label className="switch">
                        <input
                          type="checkbox"
                          role="switch"
                          checked={option.isAvailable}
                          disabled={!canEdit}
                          onChange={(event) => {
                            setOptions(
                              options.map((row) =>
                                row.id === option.id
                                  ? { ...row, isAvailable: event.target.checked }
                                  : row,
                              ),
                            );
                            setDirty(true);
                          }}
                        />
                        <span className="switch-track">
                          <span className="switch-thumb" />
                        </span>
                        <span className="sr-only">
                          {option.name || `Option ${index + 1}`} is available
                        </span>
                      </label>
                      <button
                        type="button"
                        className="btn btn-icon btn-ghost"
                        aria-label={`Remove ${option.name || `option ${index + 1}`}`}
                        disabled={!canEdit}
                        onClick={() => {
                          setOptions(options.filter((row) => row.id !== option.id));
                          setDirty(true);
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>

                {canEdit ? (
                  <>
                    <button
                      type="button"
                      className="add-row"
                      onClick={() => {
                        setOptions([
                          ...options,
                          {
                            id: `new-${Date.now()}`,
                            name: '',
                            priceDelta: '0.00',
                            isDefault: false,
                            isAvailable: true,
                          },
                        ]);
                        setDirty(true);
                      }}
                    >
                      + Add an option
                    </button>

                    <div className="field">
                      <label className="field-label" htmlFor="bulk-options">
                        Add several at once — one per line: name, price
                      </label>
                      <textarea
                        id="bulk-options"
                        className="textarea"
                        rows={3}
                        placeholder={'Extra kebab, 180\nPickle, 0\nDouble raita, 120'}
                        value={bulk}
                        onChange={(event) => setBulk(event.target.value)}
                      />
                      <div className="row" style={{ marginTop: 8 }}>
                        <button
                          type="button"
                          className="btn"
                          disabled={!bulk.trim()}
                          onClick={addBulk}
                        >
                          Add these options
                        </button>
                        <span className="cap faint">
                          Setting a menu up is a long job done once; this is the short way through
                          it.
                        </span>
                      </div>
                    </div>
                  </>
                ) : null}
              </div>

              {canEdit ? (
                <div className="savebar">
                  {dirty ? (
                    <span className="msg-dirty">
                      <AlertIcon className="icon-sm" />
                      Unsaved changes
                    </span>
                  ) : (
                    <span className="msg-dirty faint">Saved</span>
                  )}
                  <span className="spacer" />
                  <button
                    type="button"
                    className="btn"
                    disabled={!dirty || busy}
                    onClick={() => show(open)}
                  >
                    Discard
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!dirty || busy}
                    onClick={() => void save()}
                  >
                    {busy
                      ? 'Saving…'
                      : open.usedByCount > 0
                        ? `Save for all ${open.usedByCount} dish${open.usedByCount === 1 ? '' : 'es'}`
                        : 'Save'}
                  </button>
                </div>
              ) : null}
            </>
          )}
        </section>

        <section className="ed-pane hide-tablet-down" aria-label="What the customer sees">
          <div className="pane-head">
            <span className="pane-title">
              Customer sees on WhatsApp
              <small>Updates live</small>
            </span>
          </div>

          <div className="pane-body stack" style={{ gap: 10 }}>
            <div className="wa-bubble">
              <b>{preview.body}</b>
              {preview.rows.length > 0 ? (
                <>
                  {'\n'}
                  {preview.rows.map((row) => (
                    <span key={row} className="opt">
                      {row}
                    </span>
                  ))}
                </>
              ) : null}
            </div>
            <span className="wa-note">
              {preview.hidden > 0
                ? `${preview.hidden} unavailable option${preview.hidden === 1 ? '' : 's'} hidden while off.`
                : 'Wording comes from the bot itself, so this is exactly what is sent.'}
            </span>
          </div>
        </section>
      </div>
    </>
  );
}
