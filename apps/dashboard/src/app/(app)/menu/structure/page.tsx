'use client';

import { Permission } from '@restaurant-os/types';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertIcon, CheckIcon, MenuIcon } from '@/components/icons';
import { MenuTabs } from '@/components/menu-tabs';
import { OverflowMenu } from '@/components/overflow-menu';
import { ApiError, api } from '@/lib/api-client';
import { useBranches } from '@/lib/branch';
import { categoryStyle } from '@/lib/category-style';
import { useSession } from '@/lib/session';
import type { Menu, MenuCategory, MenuItem, MenuVariant } from '@/lib/types';

/**
 * Building the menu itself: categories, dishes, and the sizes a dish is sold in.
 *
 * This screen did not exist. Everything on it was already supported by the API
 * and enforced correctly when a customer orders — but with no screen, a menu
 * could only be built by a developer calling endpoints by hand, which made the
 * product unusable by the people it is for.
 *
 * Three panes, narrowing left to right: which section, which dish, and then the
 * dish itself. The ordering of categories is not cosmetic — it is the order the
 * customer scrolls through on WhatsApp — so it is editable here and nowhere
 * else.
 */

/** An option group as the library lists it. */
interface LibraryGroup {
  id: string;
  name: string;
  required: boolean;
  minSelections: number;
  maxSelections: number;
  options: Array<{ id: string }>;
  usedByCount: number;
}

/** A size being edited. `id` is absent until it has been saved once. */
interface DraftSize {
  key: string;
  id?: string;
  name: string;
  price: string;
  isDefault: boolean;
}

function toDraft(variant: MenuVariant): DraftSize {
  return {
    key: variant.id,
    id: variant.id,
    name: variant.name,
    price: variant.price,
    isDefault: variant.isDefault,
  };
}

export default function MenuStructurePage() {
  const session = useSession();
  const { selected, loading: branchesLoading } = useBranches();

  const [menu, setMenu] = useState<Menu | null>(null);
  const [library, setLibrary] = useState<LibraryGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [dishId, setDishId] = useState<string | null>(null);

  // The dish form, held apart from the loaded menu so a half-typed name is not
  // thrown away by the next poll and not written to the server either.
  const [name, setName] = useState('');
  const [nameUrdu, setNameUrdu] = useState('');
  const [basePrice, setBasePrice] = useState('');
  const [sizes, setSizes] = useState<DraftSize[]>([]);
  const [dirty, setDirty] = useState(false);

  const canEdit = session.can(Permission.MENU_UPDATE);
  const canCreate = session.can(Permission.MENU_CREATE);

  const load = useCallback(async () => {
    if (!selected) return;
    try {
      const [loaded, groups] = await Promise.all([
        api<Menu>(`/menu?branchId=${selected.id}&includeHidden=true`),
        api<LibraryGroup[]>('/menu/modifiers'),
      ]);
      setMenu(loaded);
      setLibrary(groups);
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not load the menu');
    } finally {
      setLoading(false);
    }
  }, [selected]);

  useEffect(() => {
    void load();
  }, [load]);

  const categories: MenuCategory[] = useMemo(() => menu?.categories ?? [], [menu]);

  // Keep a selection once the menu arrives, and after a category is deleted.
  useEffect(() => {
    if (categories.length === 0) return;
    if (!categoryId || !categories.some((category) => category.id === categoryId)) {
      setCategoryId(categories[0]!.id);
    }
  }, [categories, categoryId]);

  const category = categories.find((candidate) => candidate.id === categoryId) ?? null;
  const dish = category?.items.find((item) => item.id === dishId) ?? null;

  /** Library groups this dish does not already ask about. */
  const unattached = library.filter(
    (group) => !(dish?.modifiers ?? []).some((attached) => attached.id === group.id),
  );

  /** Loads a dish into the form. Discards whatever was being typed. */
  const openDish = useCallback((item: MenuItem | null) => {
    setDishId(item?.id ?? null);
    setName(item?.name ?? '');
    setNameUrdu(item?.nameLocalized?.UR ?? '');
    setBasePrice(item?.basePrice ?? '');
    setSizes((item?.variants ?? []).map(toDraft));
    setDirty(false);
  }, []);

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

  async function addCategory() {
    const entered = window.prompt('What is this section called? For example, BBQ or Karahi.');
    if (!entered?.trim()) return;

    const created = await run(
      () =>
        api<MenuCategory>('/menu/categories', {
          method: 'POST',
          body: { name: entered.trim(), sortOrder: categories.length },
        }),
      'Could not add that section',
    );
    if (created) {
      await load();
      setCategoryId(created.id);
    }
  }

  async function renameCategory(target: MenuCategory) {
    const entered = window.prompt('Rename this section', target.name);
    if (entered === null || !entered.trim()) return;

    const urdu = window.prompt('Name in Urdu (optional)', target.nameLocalized?.UR ?? '');

    await run(
      () =>
        api(`/menu/categories/${target.id}`, {
          method: 'PATCH',
          body: {
            name: entered.trim(),
            ...(urdu !== null ? { nameLocalized: urdu.trim() ? { UR: urdu.trim() } : {} } : {}),
          },
        }),
      'Could not rename that section',
    );
    await load();
  }

  async function deleteCategory(target: MenuCategory) {
    const count = target.items.length;
    const warning =
      count > 0
        ? `Delete "${target.name}"? It has ${count} dish${count === 1 ? '' : 'es'} in it.`
        : `Delete "${target.name}"?`;
    if (!window.confirm(warning)) return;

    await run(
      () => api(`/menu/categories/${target.id}`, { method: 'DELETE' }),
      'Could not delete that section',
    );
    await load();
  }

  /**
   * Moves a category up or down, by writing both affected sort orders.
   *
   * Two calls rather than one, because the API sorts on a number per category
   * and has no "reorder" endpoint. If the second fails the first has already
   * landed, so the list is reloaded either way and the screen shows whatever
   * actually happened rather than what was intended.
   */
  async function moveCategory(index: number, by: -1 | 1) {
    const target = categories[index];
    const swap = categories[index + by];
    if (!target || !swap) return;

    await run(async () => {
      await api(`/menu/categories/${target.id}`, {
        method: 'PATCH',
        body: { sortOrder: swap.sortOrder },
      });
      await api(`/menu/categories/${swap.id}`, {
        method: 'PATCH',
        body: { sortOrder: target.sortOrder },
      });
    }, 'Could not reorder the sections');
    await load();
  }

  async function addDish() {
    if (!category) return;
    const entered = window.prompt(`Add a dish to ${category.name}`);
    if (!entered?.trim()) return;

    const created = await run(
      () =>
        api<MenuItem>('/menu/items', {
          method: 'POST',
          body: { name: entered.trim(), basePrice: '0.00', categoryId: category.id },
        }),
      'Could not add that dish',
    );

    if (created) {
      await load();
      openDish(created);
    }
  }

  /**
   * Saves the dish: its names, its price, and every size.
   *
   * Several calls, not one — the API has an endpoint per entity, so a dish with
   * two edited sizes is three writes. They run in sequence and stop at the
   * first failure, and the menu is reloaded afterwards either way, so the form
   * shows what the server actually holds rather than what was typed.
   */
  /**
   * Attaches or detaches an option group.
   *
   * One PUT carrying the whole list, which is what the API offers and is the
   * right shape anyway: attaching is a change to the set of questions a dish
   * asks, and a set is replaced atomically rather than edited one id at a
   * time. Saved immediately rather than queued behind the form's Save button,
   * because it is one call that either happens or does not — there is no
   * half-attached state to leave somebody in.
   */
  async function setGroups(dishId: string, modifierIds: string[]) {
    await run(
      () => api(`/menu/items/${dishId}/modifiers`, { method: 'PUT', body: { modifierIds } }),
      'Could not change the option groups on this dish',
    );
    await load();
  }

  async function saveDish() {
    if (!dish) return;

    const ok = await run(async () => {
      await api(`/menu/items/${dish.id}`, {
        method: 'PATCH',
        body: {
          name: name.trim(),
          nameLocalized: nameUrdu.trim() ? { UR: nameUrdu.trim() } : {},
          ...(sizes.length === 0 && basePrice.trim() ? { basePrice: basePrice.trim() } : {}),
        },
      });

      const removed = dish.variants.filter(
        (variant) => !sizes.some((size) => size.id === variant.id),
      );
      for (const variant of removed) {
        await api(`/menu/variants/${variant.id}`, { method: 'DELETE' });
      }

      for (const [index, size] of sizes.entries()) {
        const body = {
          name: size.name.trim(),
          price: size.price.trim(),
          isDefault: size.isDefault,
          sortOrder: index,
        };

        if (size.id) {
          await api(`/menu/variants/${size.id}`, { method: 'PATCH', body });
        } else {
          await api(`/menu/items/${dish.id}/variants`, { method: 'POST', body });
        }
      }

      return true;
    }, 'Could not save that dish');

    await load();
    if (ok) setDirty(false);
  }

  // Re-open the saved dish so the form picks up server-assigned ids.
  useEffect(() => {
    if (!dishId || dirty) return;
    const fresh = categories.flatMap((c) => c.items).find((item) => item.id === dishId);
    if (fresh) {
      setSizes(fresh.variants.map(toDraft));
    }
  }, [categories, dishId, dirty]);

  if (branchesLoading || loading) {
    return (
      <div className="page-head">
        <div className="page-title">
          <h1>Menu</h1>
          <p className="page-sub">Loading…</p>
        </div>
      </div>
    );
  }

  const dishCount = categories.reduce((total, c) => total + c.items.length, 0);

  return (
    <>
      <div className="page-head">
        <div className="page-title">
          <h1>Menu</h1>
          <p className="page-sub">
            {categories.length} categor{categories.length === 1 ? 'y' : 'ies'} · {dishCount} dish
            {dishCount === 1 ? '' : 'es'} · changes reach WhatsApp when you save
          </p>
        </div>
      </div>

      <MenuTabs />

      {error ? (
        <div className="alert alert-danger" role="alert">
          <AlertIcon />
          <div>{error}</div>
        </div>
      ) : null}

      <div className="ed">
        <section className="ed-pane" aria-label="Categories">
          <div className="pane-head">
            <span className="pane-title">
              Categories
              <small>Same order as on WhatsApp</small>
            </span>
            {canCreate ? (
              <button type="button" className="btn btn-sm" onClick={() => void addCategory()}>
                Add
              </button>
            ) : null}
          </div>

          {categories.length === 0 ? (
            <div className="pane-body">
              <p className="sm muted">
                No sections yet. A section is a heading customers scroll past — BBQ, Karahi,
                Drinks.
              </p>
            </div>
          ) : null}

          {categories.map((candidate, index) => (
            <div
              key={candidate.id}
              className="sort-row"
              aria-current={candidate.id === categoryId ? 'true' : undefined}
            >
              <button
                type="button"
                className="sort-name"
                onClick={() => {
                  setCategoryId(candidate.id);
                  openDish(null);
                }}
                style={{ background: 'none', border: 0, textAlign: 'left', cursor: 'pointer' }}
              >
                <b>{candidate.name}</b>
                <span>
                  {candidate.items.length} dish{candidate.items.length === 1 ? '' : 'es'}
                </span>
              </button>

              {canEdit ? (
                <div className="updown">
                  <button
                    type="button"
                    className="btn btn-icon"
                    aria-label={`Move ${candidate.name} up`}
                    disabled={index === 0 || busy}
                    onClick={() => void moveCategory(index, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="btn btn-icon"
                    aria-label={`Move ${candidate.name} down`}
                    disabled={index === categories.length - 1 || busy}
                    onClick={() => void moveCategory(index, 1)}
                  >
                    ↓
                  </button>
                </div>
              ) : null}

              <OverflowMenu
                label={`More actions for ${candidate.name}`}
                actions={
                  canEdit
                    ? [
                        {
                          key: 'rename',
                          label: 'Rename',
                          onSelect: () => void renameCategory(candidate),
                        },
                        {
                          key: 'delete',
                          label: 'Delete',
                          danger: true,
                          onSelect: () => void deleteCategory(candidate),
                        },
                      ]
                    : []
                }
              />
            </div>
          ))}
        </section>

        <section className="ed-pane" aria-label="Dishes">
          <div className="pane-head">
            <span className="pane-title">
              {category?.name ?? 'Dishes'}
              <small>
                {category ? `${category.items.length} dish${category.items.length === 1 ? '' : 'es'}` : 'Pick a section'}
              </small>
            </span>
            {canCreate && category ? (
              <button type="button" className="btn btn-sm" onClick={() => void addDish()}>
                Dish
              </button>
            ) : null}
          </div>

          {(category?.items ?? []).map((item) => {
            const { Icon, tint } = categoryStyle(category?.name ?? '', 0);
            // Rounded, and without the decimals, because this column shares a
            // 284px pane with the dish's name — "Rs 2,400.00+" squeezed
            // "BBQ Platter" down to "BBQ …". The exact figure is one click
            // away in the editor, and on the Availability tab in full.
            const lowest =
              item.variants.length > 0
                ? item.variants.reduce(
                    (least, variant) => (Number(variant.price) < Number(least) ? variant.price : least),
                    item.variants[0]!.price,
                  )
                : item.basePrice;
            const priceLabel = `Rs ${Math.round(Number(lowest)).toLocaleString('en-PK')}${
              item.variants.length > 1 ? '+' : ''
            }`;

            return (
              <button
                key={item.id}
                type="button"
                className="dish-mini"
                aria-current={item.id === dishId ? 'true' : undefined}
                onClick={() => openDish(item)}
                style={{ width: '100%', background: 'none', border: 0, textAlign: 'left', cursor: 'pointer' }}
              >
                <span className={`dish-img ${tint}`} aria-hidden="true">
                  <Icon />
                </span>
                <span className="sort-name">
                  <b>{item.name}</b>
                  <span>
                    {item.variants.length > 0
                      ? `${item.variants.length} size${item.variants.length === 1 ? '' : 's'}`
                      : 'One price'}
                    {item.modifiers.length > 0
                      ? ` · ${item.modifiers.length} group${item.modifiers.length === 1 ? '' : 's'}`
                      : ''}
                  </span>
                </span>
                <span className="strong num">{priceLabel}</span>
              </button>
            );
          })}

          {category && category.items.length === 0 ? (
            <div className="pane-body">
              {canCreate ? (
                <button type="button" className="add-row" onClick={() => void addDish()}>
                  + Add a dish to {category.name}
                </button>
              ) : (
                <p className="sm muted">No dishes in this section.</p>
              )}
            </div>
          ) : null}
        </section>

        <section className="ed-pane" aria-label="Dish">
          {!dish ? (
            <div className="empty" style={{ padding: '56px 24px' }}>
              <div className="empty-icon" aria-hidden="true">
                <MenuIcon className="icon-lg" />
              </div>
              <h2 className="empty-title" style={{ fontSize: 24, lineHeight: '30px' }}>
                Pick a dish
              </h2>
              <p className="empty-body">
                Choose one on the left to set its name, its sizes and the choices a customer is
                asked for.
              </p>
            </div>
          ) : (
            <>
              <div className="pane-head">
                <span className="pane-title">
                  {dish.name}
                  <small>In {category?.name}</small>
                </span>
              </div>

              <div className="form-sec">
                <div className="sec-head">
                  <span className="sec-title">Name</span>
                  <span className="sec-help">Both appear on WhatsApp</span>
                </div>
                <div className="bi">
                  <div className="field">
                    <label className="field-label" htmlFor="dish-name">
                      English
                    </label>
                    <input
                      id="dish-name"
                      className="input"
                      value={name}
                      disabled={!canEdit}
                      onChange={(event) => {
                        setName(event.target.value);
                        setDirty(true);
                      }}
                    />
                  </div>
                  <div className="field">
                    <label className="field-label" htmlFor="dish-name-ur">
                      Urdu · اردو
                    </label>
                    <input
                      id="dish-name-ur"
                      className="input input-ur"
                      lang="ur"
                      dir="rtl"
                      value={nameUrdu}
                      disabled={!canEdit}
                      onChange={(event) => {
                        setNameUrdu(event.target.value);
                        setDirty(true);
                      }}
                    />
                  </div>
                </div>
              </div>

              <div className="form-sec">
                <div className="sec-head">
                  <span className="sec-title">Sizes</span>
                  <span className="sec-help">
                    Only for this dish. With one size the customer is not asked; with two or more
                    they must pick one, and the size price replaces the dish price.
                  </span>
                </div>

                {sizes.length > 1 ? (
                  <div className="outcome">
                    <CheckIcon className="icon" />
                    <div>
                      <b>
                        Customer must pick a size: {sizes.map((size) => size.name || '…').join(' or ')}
                      </b>
                      <span>
                        {sizes.find((size) => size.isDefault)?.name
                          ? `${sizes.find((size) => size.isDefault)!.name} is selected unless they choose otherwise.`
                          : 'No default set, so nothing is pre-selected.'}
                      </span>
                    </div>
                  </div>
                ) : null}

                <div className="vtable">
                  <div className="vrow head">
                    <span>Size name</span>
                    <span>Price</span>
                    <span>Default</span>
                    <span />
                  </div>

                  {sizes.map((size, index) => (
                    <div key={size.key} className="vrow">
                      <input
                        className="input"
                        aria-label={`Name of size ${index + 1}`}
                        placeholder="Half, Large…"
                        value={size.name}
                        disabled={!canEdit}
                        onChange={(event) => {
                          setSizes(
                            sizes.map((row) =>
                              row.key === size.key ? { ...row, name: event.target.value } : row,
                            ),
                          );
                          setDirty(true);
                        }}
                      />
                      <input
                        className="input num"
                        aria-label={`Price of ${size.name || `size ${index + 1}`}`}
                        inputMode="decimal"
                        placeholder="1250.00"
                        value={size.price}
                        disabled={!canEdit}
                        onChange={(event) => {
                          setSizes(
                            sizes.map((row) =>
                              row.key === size.key ? { ...row, price: event.target.value } : row,
                            ),
                          );
                          setDirty(true);
                        }}
                      />
                      <label className="radio">
                        <input
                          type="radio"
                          name="default-size"
                          checked={size.isDefault}
                          disabled={!canEdit}
                          onChange={() => {
                            setSizes(
                              sizes.map((row) => ({ ...row, isDefault: row.key === size.key })),
                            );
                            setDirty(true);
                          }}
                        />
                        <span className="radio-dot" aria-hidden="true" />
                        <span className="sr-only">
                          Make {size.name || `size ${index + 1}`} the default
                        </span>
                      </label>
                      <button
                        type="button"
                        className="btn btn-icon btn-ghost"
                        aria-label={`Remove ${size.name || `size ${index + 1}`}`}
                        disabled={!canEdit}
                        onClick={() => {
                          setSizes(sizes.filter((row) => row.key !== size.key));
                          setDirty(true);
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>

                {canEdit ? (
                  <button
                    type="button"
                    className="add-row"
                    onClick={() => {
                      setSizes([
                        ...sizes,
                        {
                          key: `new-${Date.now()}`,
                          name: '',
                          price: '',
                          isDefault: sizes.length === 0,
                        },
                      ]);
                      setDirty(true);
                    }}
                  >
                    + Add a size
                  </button>
                ) : null}

                <div className="field" style={{ maxWidth: 260 }}>
                  <label className="field-label" htmlFor="dish-price">
                    Dish price
                  </label>
                  <input
                    id="dish-price"
                    className="input num"
                    inputMode="decimal"
                    value={sizes.length > 0 ? '' : basePrice}
                    placeholder={sizes.length > 0 ? 'Set by sizes' : '900.00'}
                    disabled={!canEdit || sizes.length > 0}
                    onChange={(event) => {
                      setBasePrice(event.target.value);
                      setDirty(true);
                    }}
                  />
                  <span className="field-hint">Used again if you go back to one size.</span>
                </div>
              </div>

              <div className="form-sec">
                <div className="sec-head">
                  <span className="sec-title">Option groups on this dish</span>
                  <span className="sec-help">
                    Groups live in the Option groups library and are shared. Attaching one links it
                    here — it is not copied — so editing it changes every dish that uses it.
                  </span>
                </div>

                {dish.modifiers.length === 0 ? (
                  <p className="sm muted">
                    No choices asked for. Add a group to ask about spice level, extras or a crust.
                  </p>
                ) : (
                  dish.modifiers.map((group) => (
                    <div key={group.id} className="gcard">
                      <span />
                      <span className="g-tile" aria-hidden="true">
                        <MenuIcon />
                      </span>
                      <span className="stack" style={{ minWidth: 0 }}>
                        <span className="g-name">{group.name}</span>
                        <span className="g-rule">
                          {group.required || group.minSelections > 0
                            ? group.maxSelections <= 1
                              ? 'Must choose exactly one'
                              : `Must choose between ${Math.max(1, group.minSelections)} and ${group.maxSelections}`
                            : group.maxSelections <= 1
                              ? 'One, or skip'
                              : `Can add up to ${group.maxSelections}, or none`}{' '}
                          · {group.options.length} option{group.options.length === 1 ? '' : 's'}
                        </span>
                      </span>
                      {canEdit ? (
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={busy}
                          onClick={() =>
                            void setGroups(
                              dish.id,
                              dish.modifiers.filter((m) => m.id !== group.id).map((m) => m.id),
                            )
                          }
                        >
                          Detach
                        </button>
                      ) : null}
                    </div>
                  ))
                )}

                <div className="attach-row">
                  {canEdit && unattached.length > 0 ? (
                    <OverflowMenu
                      label="Attach an option group from the library"
                      triggerClassName="btn"
                      actions={unattached.map((group) => ({
                        key: group.id,
                        label: group.name,
                        hint: group.usedByCount > 0 ? `on ${group.usedByCount}` : 'unused',
                        onSelect: () =>
                          void setGroups(dish.id, [
                            ...dish.modifiers.map((m) => m.id),
                            group.id,
                          ]),
                      }))}
                    >
                      Attach from library
                    </OverflowMenu>
                  ) : null}
                  <a className="btn" href="/menu/options">
                    {library.length === 0 ? 'Create an option group' : 'Manage option groups'}
                  </a>
                </div>
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
                    onClick={() => openDish(dish)}
                  >
                    Discard
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!dirty || busy}
                    onClick={() => void saveDish()}
                  >
                    {busy ? 'Saving…' : 'Save'}
                  </button>
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>
    </>
  );
}
