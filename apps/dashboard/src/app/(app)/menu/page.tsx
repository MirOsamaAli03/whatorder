'use client';

import { MenuItemAvailability, Permission } from '@restaurant-os/types';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ItemEditor } from '@/components/item-editor';
import { Modal } from '@/components/modal';
import { MenuTabs } from '@/components/menu-tabs';
import { AlertIcon, MenuIcon } from '@/components/icons';
import { OverflowMenu, type OverflowAction } from '@/components/overflow-menu';
import { ApiError, api } from '@/lib/api-client';
import { BranchPicker, useBranches } from '@/lib/branch';
import { categoryStyle } from '@/lib/category-style';
import { formatMoney } from '@/lib/format';
import { useSession } from '@/lib/session';
import type { Menu, MenuItem } from '@/lib/types';

const AVAILABILITY_LABEL: Record<MenuItemAvailability, string> = {
  AVAILABLE: 'Available',
  OUT_OF_STOCK: 'Sold out',
  HIDDEN: 'Hidden',
};

/** A category as this screen renders it, whether or not it has a real one. */
interface Section {
  id: string;
  name: string;
  nameUrdu?: string;
  isActive: boolean;
  items: MenuItem[];
}

export default function MenuPage() {
  const session = useSession();
  const { selected, loading: branchesLoading } = useBranches();

  const [menu, setMenu] = useState<Menu | null>(null);
  const [editing, setEditing] = useState<MenuItem | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [soldOutOnly, setSoldOutOnly] = useState(false);

  const canUpdate = session.can(Permission.MENU_UPDATE);
  const canCreate = session.can(Permission.MENU_CREATE);

  const load = useCallback(async () => {
    if (!selected) return;

    try {
      // includeHidden: this is a management screen, so hidden and archived
      // entries must be visible — otherwise there is no way to un-hide them.
      const next = await api<Menu>(`/menu?branchId=${selected.id}&includeHidden=true`);
      setMenu(next);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load the menu');
    } finally {
      setLoading(false);
    }
  }, [selected]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Sets availability for the selected branch only.
   *
   * This is the common floor decision — "we are out of biryani tonight" — and
   * it must not affect the rest of the chain (spec §86).
   */
  async function setAvailability(item: MenuItem, availability: MenuItemAvailability) {
    if (!selected) return;
    setBusy(item.id);
    setError(null);

    try {
      await api(`/menu/items/${item.id}/availability`, {
        method: 'POST',
        body: { availability, branchId: selected.id },
      });
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not update availability');
    } finally {
      setBusy(null);
    }
  }

  async function setBranchPrice(item: MenuItem, price: string | null) {
    if (!selected) return;
    setBusy(item.id);
    setError(null);

    try {
      if (price === null) {
        await api(`/menu/items/${item.id}/branches/${selected.id}`, { method: 'DELETE' });
      } else {
        await api(`/menu/items/${item.id}/branches/${selected.id}`, {
          method: 'PUT',
          body: { price },
        });
      }
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not update the price');
    } finally {
      setBusy(null);
    }
  }

  function promptBranchPrice(item: MenuItem) {
    const entered = window.prompt(
      `Price at ${selected?.name}. Leave empty to use the chain price of ${item.basePrice}.`,
      item.hasBranchOverride ? item.price : '',
    );
    if (entered === null) return;
    void setBranchPrice(item, entered.trim() === '' ? null : entered.trim());
  }

  const sections: Section[] = useMemo(() => {
    const categories = (menu?.categories ?? []).map((category) => ({
      id: category.id,
      name: category.name,
      nameUrdu: category.nameLocalized?.UR,
      isActive: category.isActive,
      items: category.items,
    }));

    const loose = menu?.uncategorized ?? [];
    return loose.length > 0
      ? [...categories, { id: 'uncategorized', name: 'Uncategorised', isActive: true, items: loose }]
      : categories;
  }, [menu]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();

    return sections
      .map((section) => ({
        ...section,
        items: section.items.filter((item) => {
          if (soldOutOnly && item.availability === MenuItemAvailability.AVAILABLE) return false;
          if (!needle) return true;
          // English or Urdu, because the search box says so.
          return (
            item.name.toLowerCase().includes(needle) ||
            (item.nameLocalized?.UR ?? '').includes(query.trim())
          );
        }),
      }))
      .filter((section) => section.items.length > 0);
  }, [sections, query, soldOutOnly]);

  const totals = useMemo(() => {
    const items = sections.flatMap((section) => section.items);
    return {
      dishes: items.length,
      categories: sections.length,
      soldOut: items.filter((item) => item.availability !== MenuItemAvailability.AVAILABLE).length,
    };
  }, [sections]);

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

  return (
    <>
      <div className="page-head">
        <div className="page-title">
          <h1>Menu</h1>
          <p className="page-sub">
            {selected?.name ?? 'This branch'} · {totals.dishes} dish
            {totals.dishes === 1 ? '' : 'es'} in {totals.categories} categor
            {totals.categories === 1 ? 'y' : 'ies'}
            {totals.soldOut > 0 ? ` · ${totals.soldOut} sold out here` : ''}
          </p>
        </div>

        <div className="page-tools">
          <div className="hide-phone">
            <BranchPicker id="menu-branch" />
          </div>
          <div className="field" style={{ minWidth: 240 }}>
            <label className="field-label" htmlFor="menu-search">
              Find a dish
            </label>
            <input
              id="menu-search"
              className="input"
              placeholder="English or اردو"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {canCreate ? (
            <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
              New dish
            </button>
          ) : null}
        </div>
      </div>

      <MenuTabs />

      {error ? (
        <div className="alert alert-danger" role="alert">
          <AlertIcon />
          <div>{error}</div>
        </div>
      ) : null}

      {editing ? (
        <Modal title={editing === 'new' ? 'New dish' : `Edit ${editing.name}`} onClose={() => setEditing(null)} wide>
          <ItemEditor
            /*
             * Keyed on the dish, so switching from one to another remounts the
             * form instead of keeping the previous dish's values in it. Without
             * this the fields are initialised once and never again: opening
             * Chicken Tikka and then Beef Seekh Kebab showed the kebab's title
             * above Chicken Tikka's name and price, and saving would have
             * written one dish's details onto the other.
             */
            key={editing === 'new' ? 'new' : editing.id}
            item={editing === 'new' ? null : editing}
            categories={sections
              .filter((section) => section.id !== 'uncategorized')
              .map((section) => ({ id: section.id, name: section.name }))}
            onClose={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              void load();
            }}
          />
        </Modal>
      ) : null}

      {sections.length > 0 ? (
        <div className="chips" role="group" aria-label="Jump to category">
          {sections.map((section) => (
            <a key={section.id} href={`#category-${section.id}`} className="chip">
              {section.name} <span className="chip-count">{section.items.length}</span>
            </a>
          ))}
          <button
            type="button"
            className="chip"
            aria-pressed={soldOutOnly}
            onClick={() => setSoldOutOnly((was) => !was)}
          >
            <span className="dot" style={{ background: 'var(--text)' }} />
            Sold out here <span className="chip-count">{totals.soldOut}</span>
          </button>
        </div>
      ) : null}

      {shown.length === 0 ? (
        <div className="card">
          <div className="empty">
            <div className="empty-icon" aria-hidden="true">
              <MenuIcon className="icon-lg" />
            </div>
            <h2 className="empty-title">
              {sections.length === 0 ? 'Nothing on the menu yet' : 'Nothing matches that'}
            </h2>
            <p className="empty-body">
              {sections.length === 0
                ? 'This page is for the daily job — sold out, back on, a branch price. First the menu itself has to exist: categories, dishes, sizes and choices.'
                : 'Try a different word, or clear the filter.'}
            </p>
            <div className="empty-actions">
              {sections.length === 0 && canCreate ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => setEditing('new')}
                >
                  Add the first dish
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    setQuery('');
                    setSoldOutOnly(false);
                  }}
                >
                  Show the whole menu
                </button>
              )}
            </div>
          </div>
        </div>
      ) : (
        shown.map((section, index) => {
          const { Icon, tint } = categoryStyle(`${section.name} ${section.nameUrdu ?? ''}`, index);
          const soldOutHere = section.items.filter(
            (item) => item.availability !== MenuItemAvailability.AVAILABLE,
          ).length;

          return (
            <section key={section.id} id={`category-${section.id}`} className="card" aria-label={section.name}>
              <div className="cat-head">
                <span className={`cat-tile ${tint}`} aria-hidden="true">
                  <Icon />
                </span>
                <div className="stack" style={{ minWidth: 0 }}>
                  <span className="row" style={{ gap: 10 }}>
                    <h2 className="cat-name">{section.name}</h2>
                    {section.nameUrdu ? (
                      <span className="ur ur-sm muted" lang="ur">
                        {section.nameUrdu}
                      </span>
                    ) : null}
                    {!section.isActive ? <span className="pill">Archived</span> : null}
                  </span>
                  <span className="cat-meta">
                    {section.items.length} dish{section.items.length === 1 ? '' : 'es'}
                    {soldOutHere > 0 ? ` · ${soldOutHere} sold out at ${selected?.name}` : ''}
                  </span>
                </div>
              </div>

              {section.items.map((item) => {
                const soldOut = item.availability !== MenuItemAvailability.AVAILABLE;
                const onSale = item.availability === MenuItemAvailability.AVAILABLE;

                const actions: OverflowAction[] = canUpdate
                  ? [
                      {
                        key: 'price',
                        label: item.hasBranchOverride
                          ? `Change the price at ${selected?.name}`
                          : `Set a price for ${selected?.name}`,
                        onSelect: () => promptBranchPrice(item),
                      },
                      ...(item.hasBranchOverride
                        ? [
                            {
                              key: 'clear-price',
                              label: 'Use the chain price again',
                              hint: formatMoney(item.basePrice, item.currency),
                              onSelect: () => void setBranchPrice(item, null),
                            },
                          ]
                        : []),
                      {
                        key: 'hide',
                        label: 'Hide from the menu',
                        danger: true,
                        onSelect: () =>
                          void setAvailability(item, MenuItemAvailability.HIDDEN),
                      },
                    ]
                  : [];

                return (
                  <div key={item.id} className={`dish ${tint}${soldOut ? ' is-soldout' : ''}`}>
                    <div className="dish-img" role="img" aria-label={`No photo yet for ${item.name}`}>
                      <Icon className="icon-lg" />
                      {soldOut ? (
                        <span className="soldout-flag" aria-hidden="true">
                          {item.availability === MenuItemAvailability.HIDDEN ? 'HIDDEN' : 'SOLD OUT'}
                        </span>
                      ) : null}
                    </div>

                    <div className="dish-names">
                      <span className="dish-name">
                        {item.name}
                        {!item.isActive ? <span className="pill"> Archived</span> : null}
                      </span>
                      {item.nameLocalized?.UR ? (
                        <span className="ur dish-ur" lang="ur">
                          {item.nameLocalized.UR}
                        </span>
                      ) : null}
                      {item.modifiers.length > 0 ? (
                        <span className="dish-opts">
                          {/* Named for what they are to a customer. "Spice level ·
                              Add-ons" as a bare subtitle told the owner nothing
                              about why it was there. */}
                          <span className="dish-opts-lbl">Customer picks:</span>
                          {item.modifiers.map((modifier) => (
                            <span key={modifier.id} className="tag">
                              {modifier.name}
                            </span>
                          ))}
                        </span>
                      ) : null}
                    </div>

                    <div className="dish-price">
                      {/*
                        Both figures when they differ: the chain price and what
                        this branch actually charges. Showing only one is how a
                        manager ends up changing the wrong number.
                      */}
                      <span className="price">{formatMoney(item.price, item.currency)}</span>
                      {item.hasBranchOverride ? (
                        // The big number is what this branch charges. The note
                        // is the chain price it departs from — naming both
                        // avoids the manager changing the wrong one.
                        <span className="price-note">
                          Chain: <b>{formatMoney(item.basePrice, item.currency)}</b>
                        </span>
                      ) : null}
                      {item.availability !== item.baseAvailability ? (
                        <span className="price-note">
                          Chain: <b>{AVAILABILITY_LABEL[item.baseAvailability]}</b>
                        </span>
                      ) : null}
                    </div>

                    <div className="dish-actions">
                      {canUpdate ? (
                        <label className="switch">
                          <input
                            type="checkbox"
                            role="switch"
                            checked={onSale}
                            disabled={busy === item.id}
                            onChange={() =>
                              void setAvailability(
                                item,
                                onSale
                                  ? MenuItemAvailability.OUT_OF_STOCK
                                  : MenuItemAvailability.AVAILABLE,
                              )
                            }
                          />
                          <span className="switch-track">
                            <span className="switch-thumb" />
                          </span>
                          <span className="switch-label">
                            {onSale ? 'On sale' : AVAILABILITY_LABEL[item.availability]}
                          </span>
                        </label>
                      ) : null}

                      {canUpdate ? (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => setEditing(item)}
                        >
                          Edit
                        </button>
                      ) : (
                        <span className="faint sm">View only</span>
                      )}

                      <OverflowMenu
                        label={`More actions for ${item.name}`}
                        actions={actions}
                        disabled={busy === item.id}
                      />
                    </div>
                  </div>
                );
              })}
            </section>
          );
        })
      )}
    </>
  );
}
