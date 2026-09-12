'use client';

import { MenuItemAvailability, Permission } from '@restaurant-os/types';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/api-client';
import { BranchPicker, useBranches } from '@/lib/branch';
import { formatMoney } from '@/lib/format';
import { useSession } from '@/lib/session';
import type { Menu, MenuItem } from '@/lib/types';
import { ItemEditor } from '@/components/item-editor';

const AVAILABILITY_LABEL: Record<MenuItemAvailability, string> = {
  AVAILABLE: 'Available',
  OUT_OF_STOCK: 'Sold out',
  HIDDEN: 'Hidden',
};

export default function MenuPage() {
  const session = useSession();
  const { selected, loading: branchesLoading } = useBranches();

  const [menu, setMenu] = useState<Menu | null>(null);
  const [editing, setEditing] = useState<MenuItem | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const canUpdate = session.can(Permission.MENU_UPDATE);
  const canCreate = session.can(Permission.MENU_CREATE);

  const load = useCallback(async () => {
    if (!selected) return;

    try {
      // includeHidden: this is a management screen, so hidden and archived
      // entries must be visible — otherwise there is no way to un-hide them.
      const next = await api<Menu>(
        `/menu?branchId=${selected.id}&includeHidden=true`,
      );
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

  if (branchesLoading || loading) {
    return <p className="muted">Loading menu…</p>;
  }

  const categories = menu?.categories ?? [];
  const uncategorized = menu?.uncategorized ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Menu</h1>
          <p>
            Prices and availability shown for {selected?.name ?? 'this branch'}. Changes here
            affect this branch only unless stated.
          </p>
        </div>
        <div className="row">
          <BranchPicker />
          {canCreate ? (
            <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
              New item
            </button>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      ) : null}

      {editing ? (
        <ItemEditor
          item={editing === 'new' ? null : editing}
          categories={categories.map((category) => ({ id: category.id, name: category.name }))}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      ) : null}

      <div className="menu-grid">
        {[
          ...categories,
          ...(uncategorized.length > 0
            ? [
                {
                  id: '__uncategorized__',
                  name: 'Uncategorized',
                  description: null,
                  sortOrder: 9999,
                  isActive: true,
                  items: uncategorized,
                },
              ]
            : []),
        ].map((category) => (
          <section key={category.id} className="card" style={{ padding: 0 }}>
            <header
              className="row"
              style={{
                justifyContent: 'space-between',
                padding: '12px 16px',
                borderBottom: '1px solid var(--border)',
              }}
            >
              <h2>
                {category.name}{' '}
                {!category.isActive ? <span className="pill">Archived</span> : null}
              </h2>
              <span className="faint">
                {category.items.length} item{category.items.length === 1 ? '' : 's'}
              </span>
            </header>

            {category.items.length === 0 ? (
              <p className="faint" style={{ padding: 16 }}>
                No items in this category.
              </p>
            ) : (
              <div>
                {category.items.map((item) => (
                  <div key={item.id} className="item-row">
                    <div className="item-name">
                      <strong>
                        {item.name}
                        {!item.isActive ? <span className="pill"> Archived</span> : null}
                      </strong>
                      {item.nameLocalized?.UR ? (
                        <span className="faint">{item.nameLocalized.UR}</span>
                      ) : null}
                      {item.modifiers.length > 0 ? (
                        <span className="faint">
                          {item.modifiers.map((modifier) => modifier.name).join(' · ')}
                        </span>
                      ) : null}
                    </div>

                    <div className="mono">
                      {/*
                        Both figures are shown when they differ: the chain price
                        and what this branch actually charges. Displaying only
                        one is how a manager ends up changing the wrong number.
                      */}
                      <div className={item.hasBranchOverride ? 'price-override' : ''}>
                        {formatMoney(item.price, item.currency)}
                      </div>
                      {item.hasBranchOverride ? (
                        <div className="faint">chain {formatMoney(item.basePrice, item.currency)}</div>
                      ) : null}
                    </div>

                    <div>
                      <span
                        className={
                          item.availability === 'AVAILABLE'
                            ? 'pill pill-ok'
                            : item.availability === 'OUT_OF_STOCK'
                              ? 'pill pill-warn'
                              : 'pill'
                        }
                      >
                        {AVAILABILITY_LABEL[item.availability]}
                      </span>
                      {item.availability !== item.baseAvailability ? (
                        <div className="faint">chain: {AVAILABILITY_LABEL[item.baseAvailability]}</div>
                      ) : null}
                    </div>

                    <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                      {canUpdate ? (
                        <>
                          {item.availability === 'AVAILABLE' ? (
                            <button
                              type="button"
                              className="btn btn-sm"
                              disabled={busy === item.id}
                              onClick={() => void setAvailability(item, MenuItemAvailability.OUT_OF_STOCK)}
                            >
                              Sold out
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-sm"
                              disabled={busy === item.id}
                              onClick={() => void setAvailability(item, MenuItemAvailability.AVAILABLE)}
                            >
                              Available
                            </button>
                          )}

                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={busy === item.id}
                            onClick={() => {
                              const entered = window.prompt(
                                `Price at ${selected?.name}. Leave empty to use the chain price of ${item.basePrice}.`,
                                item.hasBranchOverride ? item.price : '',
                              );
                              if (entered === null) return;
                              void setBranchPrice(item, entered.trim() === '' ? null : entered.trim());
                            }}
                          >
                            Branch price
                          </button>

                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => setEditing(item)}
                          >
                            Edit
                          </button>
                        </>
                      ) : (
                        <span className="faint">View only</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        ))}

        {categories.length === 0 && uncategorized.length === 0 ? (
          <div className="empty">
            No menu yet.{' '}
            {canCreate ? 'Create your first item to get started.' : 'Ask an owner to add items.'}
          </div>
        ) : null}
      </div>
    </>
  );
}
