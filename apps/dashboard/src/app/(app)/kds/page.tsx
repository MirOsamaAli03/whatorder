'use client';

import { KDS_COLUMNS, urgencyFor, type KdsColumn } from '@restaurant-os/domain';
import { OrderStatus, Permission } from '@restaurant-os/types';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api-client';
import { useAlertSound } from '@/lib/alert-sound';
import { BranchPicker, useBranches } from '@/lib/branch';
import { formatElapsed, humanize } from '@/lib/format';
import { useKdsStream, type StreamHealth } from '@/lib/kds-stream';
import { useSession } from '@/lib/session';
import type { KdsCard } from '@/lib/types';

/** The action that moves a card out of each column. */
const ADVANCE: Record<KdsColumn, { label: string; status: OrderStatus } | null> = {
  NEW: { label: 'Accept', status: OrderStatus.ACCEPTED },
  ACCEPTED: { label: 'Start', status: OrderStatus.PREPARING },
  PREPARING: { label: 'Ready', status: OrderStatus.READY },
  // READY splits by order type — a delivery is dispatched, everything else is
  // handed over — so the button is chosen per card rather than per column.
  READY: null,
};

const HEALTH_LABEL: Record<StreamHealth, string> = {
  connecting: 'Connecting…',
  live: 'Live',
  stale: 'No updates — falling back to polling',
  down: 'Disconnected — reconnecting',
};

export default function KdsPage() {
  const session = useSession();
  const { selected, loading: branchesLoading } = useBranches();
  const { snapshot, health, error, newOrderSignal, refresh } = useKdsStream(selected?.id ?? null);
  const sound = useAlertSound();

  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const canUpdate = session.can(Permission.ORDERS_UPDATE);

  // Ticks the timers between snapshots so a card's age is never visibly frozen.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const lastSignalRef = useRef(newOrderSignal);
  useEffect(() => {
    if (newOrderSignal !== lastSignalRef.current) {
      lastSignalRef.current = newOrderSignal;
      sound.play();
    }
  }, [newOrderSignal, sound]);

  /**
   * How far the snapshot's `elapsedSeconds` has drifted since it was taken.
   *
   * Measured against the server's own clock, so a kitchen tablet with a wrong
   * time still shows the right age.
   */
  const driftSeconds = useMemo(() => {
    if (!snapshot) return 0;
    return Math.max(0, Math.floor((Date.now() - new Date(snapshot.serverTime).getTime()) / 1000));
  }, [snapshot, tick]);

  async function advance(card: KdsCard, status: OrderStatus) {
    setBusy(card.id);
    setActionError(null);

    try {
      await api(`/orders/${card.id}/transition`, { method: 'POST', body: { status } });
      await refresh();
    } catch (caught) {
      setActionError(caught instanceof ApiError ? caught.message : 'Could not update the order');
    } finally {
      setBusy(null);
    }
  }

  if (branchesLoading) {
    return <p className="muted">Loading…</p>;
  }

  return (
    <div className="kds" style={{ margin: '-24px -28px -48px' }}>
      <div className="kds-bar">
        <div className="row">
          <h1 style={{ fontSize: 18 }}>Kitchen · {snapshot?.branchName ?? selected?.name ?? '—'}</h1>
          <BranchPicker />
        </div>

        <div className="row" style={{ gap: 16 }}>
          <span className="kds-status">
            <span
              className={`dot ${
                health === 'live' ? 'dot-live' : health === 'stale' ? 'dot-stale' : 'dot-down'
              }`}
            />
            {HEALTH_LABEL[health]}
          </span>

          {/*
            Sound is armed explicitly. Browsers refuse to play audio before a
            user gesture, so a screen that never asks is a screen with no
            audible alert — and it would never say so.
          */}
          {sound.enabled ? (
            <span className="kds-status">
              <span className="dot dot-live" /> Sound on
            </span>
          ) : (
            <button type="button" className="btn btn-sm" onClick={() => void sound.enable()}>
              {sound.blocked ? 'Sound blocked — retry' : 'Enable sound'}
            </button>
          )}

          <button type="button" className="btn btn-sm" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
      </div>

      {sound.blocked ? (
        <div className="banner banner-warn" style={{ margin: 12 }} role="status">
          This browser is blocking audio, so new orders arrive silently. Press
          &ldquo;Sound blocked — retry&rdquo; after interacting with the page.
        </div>
      ) : null}

      {health === 'stale' ? (
        <div className="banner banner-warn" style={{ margin: 12 }} role="status">
          No updates received recently. The screen is still refreshing on a timer, but the live
          connection may be broken.
        </div>
      ) : null}

      {error || actionError ? (
        <div className="banner banner-error" style={{ margin: 12 }} role="alert">
          {actionError ?? error}
        </div>
      ) : null}

      {snapshot && snapshot.unacknowledged > 0 ? (
        <div className="banner banner-error" style={{ margin: 12 }} role="alert">
          <strong>
            {snapshot.unacknowledged} order{snapshot.unacknowledged === 1 ? '' : 's'} not yet
            accepted
          </strong>{' '}
          — past {formatElapsed(snapshot.acknowledgementTimeoutSeconds)}.
        </div>
      ) : null}

      <div className="kds-columns">
        {KDS_COLUMNS.map((column) => {
          const cards = snapshot?.columns[column] ?? [];

          return (
            <section key={column} className="kds-column" aria-label={humanize(column)}>
              <header className="kds-column-head">
                <span>{humanize(column)}</span>
                <span>{cards.length}</span>
              </header>

              <div className="kds-column-body">
                {cards.length === 0 ? (
                  <p className="faint" style={{ textAlign: 'center', padding: 16 }}>
                    Empty
                  </p>
                ) : null}

                {cards.map((card) => {
                  const elapsed = card.elapsedSeconds + driftSeconds;
                  // Re-banded client-side so the colour keeps up with the
                  // ticking timer, using the same thresholds the API sent.
                  const urgency = snapshot
                    ? urgencyFor(elapsed, snapshot.urgency)
                    : card.urgency;

                  const advanceAction =
                    column === 'READY'
                      ? card.orderType === 'DELIVERY'
                        ? { label: 'Dispatch', status: OrderStatus.OUT_FOR_DELIVERY }
                        : { label: 'Handed over', status: OrderStatus.COMPLETED }
                      : ADVANCE[column];

                  return (
                    <article
                      key={card.id}
                      className={`kds-card urgency-${urgency}${
                        card.isUnacknowledged ? ' unacknowledged' : ''
                      }`}
                    >
                      <div className="kds-card-head">
                        <span className="kds-order-number">{card.orderNumber}</span>
                        <span className="kds-timer">{formatElapsed(elapsed)}</span>
                      </div>

                      <div className="row" style={{ gap: 6 }}>
                        <span className="pill">{humanize(card.orderType)}</span>
                        <span className="pill">{humanize(card.source)}</span>
                        {card.tableLabel ? (
                          <span className="pill">Table {card.tableLabel}</span>
                        ) : null}
                      </div>

                      <ul className="kds-items">
                        {card.items.map((item) => (
                          <li key={item.id}>
                            <span className="kds-qty">{item.quantity}×</span>
                            {item.name}
                            {item.variantName ? ` · ${item.variantName}` : ''}
                            {item.modifiers.length > 0 ? (
                              <span className="kds-modifiers">{item.modifiers.join(' · ')}</span>
                            ) : null}
                            {item.notes ? <span className="kds-note">“{item.notes}”</span> : null}
                          </li>
                        ))}
                      </ul>

                      {card.notes ? <p className="kds-note">Order note: {card.notes}</p> : null}

                      {canUpdate && advanceAction ? (
                        <div className="kds-card-foot">
                          <button
                            type="button"
                            className="btn btn-primary"
                            disabled={busy === card.id}
                            onClick={() => void advance(card, advanceAction.status)}
                          >
                            {busy === card.id ? 'Working…' : advanceAction.label}
                          </button>
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
