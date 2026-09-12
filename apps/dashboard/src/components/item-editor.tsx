'use client';

import { MenuItemAvailability } from '@restaurant-os/types';
import { useState, type FormEvent } from 'react';
import { ApiError, api } from '@/lib/api-client';
import type { MenuItem } from '@/lib/types';

interface Props {
  /** Null creates a new item. */
  item: MenuItem | null;
  categories: Array<{ id: string; name: string }>;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Create and edit a menu item.
 *
 * Prices are typed and sent as decimal STRINGS, and the input is `type="text"`
 * rather than `type="number"` on purpose: a number input hands back a float,
 * and `700.10` does not survive that round trip intact. The API validates the
 * string shape and parses it into integer paisa (plan §2.6).
 *
 * Everything edited here is the CHAIN-wide value. Per-branch price and
 * availability are deliberately elsewhere, on the menu row, because they are a
 * different decision made by different people at a different cadence.
 */
export function ItemEditor({ item, categories, onClose, onSaved }: Props) {
  const [name, setName] = useState(item?.name ?? '');
  const [nameUrdu, setNameUrdu] = useState(item?.nameLocalized?.UR ?? '');
  const [categoryId, setCategoryId] = useState(item?.categoryId ?? '');
  const [basePrice, setBasePrice] = useState(item?.basePrice ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [prepTime, setPrepTime] = useState(String(item?.preparationTimeMinutes ?? 15));
  const [availability, setAvailability] = useState<MenuItemAvailability>(
    item?.baseAvailability ?? MenuItemAvailability.AVAILABLE,
  );

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setFieldErrors({});

    const body: Record<string, unknown> = {
      name,
      basePrice,
      preparationTimeMinutes: Number(prepTime),
      availability,
      ...(categoryId ? { categoryId } : {}),
      ...(description ? { description } : {}),
      ...(nameUrdu ? { nameLocalized: { UR: nameUrdu } } : {}),
    };

    try {
      if (item) {
        await api(`/menu/items/${item.id}`, { method: 'PATCH', body });
      } else {
        await api('/menu/items', { method: 'POST', body });
      }
      onSaved();
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught.message);
        setFieldErrors(caught.fieldErrors);
      } else {
        setError('Could not save the item');
      }
    } finally {
      setSaving(false);
    }
  }

  async function archive() {
    if (!item) return;
    if (!window.confirm(`Archive "${item.name}"? Past orders keep their own copy of it.`)) {
      return;
    }

    setSaving(true);
    try {
      await api(`/menu/items/${item.id}`, { method: 'DELETE' });
      onSaved();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not archive the item');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="card stack" onSubmit={(event) => void save(event)} style={{ marginBottom: 16 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>{item ? `Edit ${item.name}` : 'New menu item'}</h2>
        <span className="faint">Chain-wide values</span>
      </div>

      {error ? (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      ) : null}

      <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
        <div style={{ flex: '1 1 240px' }}>
          <div className="field">
            <label htmlFor="name">Name</label>
            <input
              id="name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            {fieldErrors.name ? <p className="field-error">{fieldErrors.name}</p> : null}
          </div>

          <div className="field">
            <label htmlFor="nameUrdu">Name in Urdu (optional)</label>
            <input
              id="nameUrdu"
              dir="rtl"
              value={nameUrdu}
              onChange={(event) => setNameUrdu(event.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="category">Category</label>
            <select
              id="category"
              value={categoryId}
              onChange={(event) => setCategoryId(event.target.value)}
            >
              <option value="">Uncategorized</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ flex: '1 1 240px' }}>
          <div className="field">
            <label htmlFor="basePrice">Chain price</label>
            <input
              id="basePrice"
              // Text, not number: a number input returns a float and would
              // quietly mangle a price like 700.10.
              type="text"
              inputMode="decimal"
              placeholder="700.00"
              required
              value={basePrice}
              onChange={(event) => setBasePrice(event.target.value)}
            />
            {fieldErrors.basePrice ? (
              <p className="field-error">{fieldErrors.basePrice}</p>
            ) : (
              <p className="faint">Two decimal places, no currency symbol or separators.</p>
            )}
          </div>

          <div className="field">
            <label htmlFor="prepTime">Preparation time (minutes)</label>
            <input
              id="prepTime"
              type="number"
              min={0}
              max={600}
              value={prepTime}
              onChange={(event) => setPrepTime(event.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="availability">Availability across the chain</label>
            <select
              id="availability"
              value={availability}
              onChange={(event) => setAvailability(event.target.value as MenuItemAvailability)}
            >
              <option value={MenuItemAvailability.AVAILABLE}>Available</option>
              <option value={MenuItemAvailability.OUT_OF_STOCK}>Sold out</option>
              <option value={MenuItemAvailability.HIDDEN}>Hidden</option>
            </select>
            <p className="faint">
              A branch can restrict this further, but never loosen it — an item hidden here stays
              hidden everywhere.
            </p>
          </div>
        </div>
      </div>

      <div className="field">
        <label htmlFor="description">Description (optional)</label>
        <textarea
          id="description"
          rows={2}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>

      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="row">
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : item ? 'Save changes' : 'Create item'}
          </button>
          <button type="button" className="btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
        </div>

        {item ? (
          <button type="button" className="btn btn-danger" onClick={() => void archive()} disabled={saving}>
            Archive
          </button>
        ) : null}
      </div>
    </form>
  );
}
