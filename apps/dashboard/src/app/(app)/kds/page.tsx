'use client';

import { KDS_COLUMNS, urgencyFor, type KdsColumn } from '@restaurant-os/domain';
import { OrderStatus, Permission } from '@restaurant-os/types';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertIcon,
  ArrowRightIcon,
  AutoThemeIcon,
  BellIcon,
  CheckCircleIcon,
  ClockIcon,
  DeliveryIcon,
  ExitIcon,
  MoonIcon,
  PickupIcon,
  SoundOffIcon,
  SoundOnIcon,
  StopwatchIcon,
  SunIcon,
  TextSizeIcon,
  WarningIcon,
} from '@/components/icons';
import { useAlertSound } from '@/lib/alert-sound';
import { ApiError, api } from '@/lib/api-client';
import { useBranches } from '@/lib/branch';
import { formatElapsed, humanize } from '@/lib/format';
import { useKdsStream, type StreamHealth } from '@/lib/kds-stream';
import { useSession } from '@/lib/session';
import type { KdsCard } from '@/lib/types';

/** The action that moves a card out of each column. */
const ADVANCE: Record<KdsColumn, { label: string; status: OrderStatus; to: string } | null> = {
  NEW: { label: 'Accept', status: OrderStatus.ACCEPTED, to: 'accepted' },
  ACCEPTED: { label: 'Start cooking', status: OrderStatus.PREPARING, to: 'preparing' },
  PREPARING: { label: 'Ready', status: OrderStatus.READY, to: 'ready' },
  // READY splits by order type — a delivery is dispatched, everything else is
  // handed over — so the button is chosen per card rather than per column.
  READY: null,
};

const HEALTH_LABEL: Record<StreamHealth, string> = {
  connecting: 'Connecting…',
  live: 'Live',
  stale: 'No updates — polling',
  down: 'Disconnected — reconnecting',
};

/** Light for a bright kitchen, dark for a dim one, or whatever the tablet says. */
type Screen = 'light' | 'dark' | 'auto';

const THEME_KEY = 'kds.theme';
const SCALE_KEY = 'kds.scale';

/**
 * A setting remembered on the device, not the account.
 *
 * The kitchen tablet is shared and never signs out; the office laptop that
 * occasionally opens this screen wants its own answer. Both reads are wrapped
 * because a kiosk browser with storage disabled must still render the screen.
 */
function useDeviceSetting<T extends string>(key: string, fallback: T): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(fallback);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(key);
      if (stored) setValue(stored as T);
    } catch {
      // Private window, or storage switched off. The default is fine.
    }
  }, [key]);

  return [
    value,
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, next);
      } catch {
        // Not worth telling a cook about.
      }
    },
  ];
}

export default function KdsPage() {
  const session = useSession();
  const { selected, loading: branchesLoading } = useBranches();
  const { snapshot, health, error, newOrderSignal, refresh } = useKdsStream(selected?.id ?? null);
  const sound = useAlertSound();

  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [screen, setScreen] = useDeviceSetting<Screen>(THEME_KEY, 'light');
  const [scale, setScale] = useDeviceSetting<'normal' | 'large'>(SCALE_KEY, 'normal');

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

  // The wall clock in the header. Rendered only after mount, since the server
  // and the tablet will not agree and React would call that a hydration error.
  const [clock, setClock] = useState<string | null>(null);
  useEffect(() => {
    const show = () =>
      setClock(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    show();
    const timer = setInterval(show, 10_000);
    return () => clearInterval(timer);
  }, []);

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

  const counts = KDS_COLUMNS.map((column) => ({
    column,
    count: snapshot?.columns[column]?.length ?? 0,
  }));
  const nothingOutstanding = counts.every((entry) => entry.count === 0);

  return (
    <div
      className="app kds"
      // `auto` means: inherit the document, which follows the device.
      {...(screen === 'auto' ? {} : { 'data-theme': screen })}
      style={{ ['--kds-scale' as string]: scale === 'large' ? 1.25 : 1 }}
    >
      <header className="kds-head">
        <div className="kds-title">
          <b>Kitchen</b>
          <span>
            {session.user?.organization.name} · {snapshot?.branchName ?? selected?.name ?? '—'}
          </span>
        </div>

        <span className="kds-live hide-phone">
          <span
            className={
              health === 'live'
                ? 'dot dot-live'
                : health === 'down'
                  ? 'dot dot-down'
                  : 'dot dot-stale'
            }
            aria-hidden="true"
          />
          {HEALTH_LABEL[health]}
        </span>

        <div className="kds-clock num" role="timer" aria-label={`Current time ${clock ?? ''}`}>
          {clock ?? ''}
        </div>

        <div className="kds-tools">
          <div className="seg hide-tablet-down" role="group" aria-label="Screen brightness">
            <button
              type="button"
              aria-pressed={screen === 'light'}
              onClick={() => setScreen('light')}
            >
              <SunIcon />
              Bright kitchen
            </button>
            <button
              type="button"
              aria-pressed={screen === 'dark'}
              onClick={() => setScreen('dark')}
            >
              <MoonIcon />
              Dim kitchen
            </button>
            <button
              type="button"
              aria-pressed={screen === 'auto'}
              onClick={() => setScreen('auto')}
            >
              <AutoThemeIcon />
              Follow device
            </button>
          </div>

          <button
            type="button"
            className="btn show-tablet-down"
            aria-label={`Screen brightness: switch to ${screen === 'dark' ? 'bright' : 'dim'}`}
            onClick={() => setScreen(screen === 'dark' ? 'light' : 'dark')}
          >
            {screen === 'dark' ? <MoonIcon /> : <SunIcon />}
            <span className="lbl">Theme</span>
          </button>

          <button
            type="button"
            className="btn"
            aria-label={sound.enabled ? 'Sound is on. Turn it off' : 'Sound is off. Turn it on'}
            onClick={() => (sound.enabled ? sound.disable() : void sound.enable())}
          >
            {sound.enabled ? <SoundOnIcon /> : <SoundOffIcon />}
            <span className="lbl">{sound.enabled ? 'Sound on' : 'Sound off'}</span>
          </button>

          <button
            type="button"
            className="btn"
            aria-label={`Text size: ${scale}. Change it`}
            onClick={() => setScale(scale === 'large' ? 'normal' : 'large')}
          >
            <TextSizeIcon />
            <span className="lbl">{scale === 'large' ? 'Large text' : 'Normal text'}</span>
          </button>

          <Link href="/orders" className="btn" aria-label="Exit the kitchen display">
            <ExitIcon />
            <span className="lbl">Exit</span>
          </Link>
        </div>
      </header>

      {/* Phone only: the four columns become one scroller, so these are how you
          get to a stage without swiping through the ones before it. */}
      <nav className="kds-stages" aria-label="Jump to a column">
        {counts.map(({ column, count }) => (
          <a
            key={column}
            href={`#col-${column.toLowerCase()}`}
            className={`kds-stage ${column.toLowerCase()}`}
          >
            {humanize(column)} <span className="num">{count}</span>
          </a>
        ))}
      </nav>

      {error || actionError ? (
        <div className="alert alert-danger" role="alert" style={{ margin: 12 }}>
          <AlertIcon />
          <div>{actionError ?? error}</div>
        </div>
      ) : null}

      {nothingOutstanding && snapshot ? (
        <div className="kds-clear" role="status">
          <CheckCircleIcon className="icon-lg" />
          <div className="stack">
            Kitchen is clear
            <span>Nothing is waiting. A new order will chime.</span>
          </div>
        </div>
      ) : null}

      <main className="kds-board">
        {KDS_COLUMNS.map((column) => {
          const cards = snapshot?.columns[column] ?? [];
          const key = column.toLowerCase();

          return (
            <section
              key={column}
              id={`col-${key}`}
              className={`kds-col ${key}`}
              aria-label={`${humanize(column)}, ${cards.length} orders`}
            >
              <h2 className="kds-col-head">
                {humanize(column)} <span className="num">{cards.length}</span>
              </h2>

              <div className="kds-col-body">
                {cards.length === 0 ? (
                  <div className="kds-empty">
                    <CheckCircleIcon />
                    Nothing here
                    <span>
                      {column === 'NEW'
                        ? 'New orders land here with a chime.'
                        : 'Orders arrive as the stage before finishes.'}
                    </span>
                  </div>
                ) : null}

                {cards.map((card) => {
                  const elapsed = card.elapsedSeconds + driftSeconds;
                  // Re-banded client-side so the colour keeps up with the
                  // ticking timer, using the same thresholds the API sent.
                  const urgency = snapshot ? urgencyFor(elapsed, snapshot.urgency) : card.urgency;

                  const action =
                    column === 'READY'
                      ? card.orderType === 'DELIVERY'
                        ? {
                            label: 'Picked up',
                            status: OrderStatus.OUT_FOR_DELIVERY,
                            to: 'delivered',
                          }
                        : {
                            label: 'Handed over',
                            status: OrderStatus.COMPLETED,
                            to: 'delivered',
                          }
                      : ADVANCE[column];

                  const word = card.isUnacknowledged
                    ? 'Not seen'
                    : urgency === 'CRITICAL'
                      ? 'Late'
                      : urgency === 'WARNING'
                        ? 'Late soon'
                        : column === 'READY'
                          ? 'Waiting'
                          : 'On time';

                  return (
                    <article
                      key={card.id}
                      className={`kds-card${urgency === 'WARNING' ? ' is-warning' : urgency === 'CRITICAL' ? ' is-critical' : ''}${
                        card.isUnacknowledged ? ' is-unack' : ''
                      }`}
                      aria-label={`Order ${card.orderNumber}, ${word}`}
                    >
                      <div className="kds-timer">
                        <span className="t" role="timer">
                          {formatElapsed(elapsed)}
                        </span>
                        <span className="w">
                          {card.isUnacknowledged ? (
                            <BellIcon />
                          ) : urgency === 'CRITICAL' ? (
                            <WarningIcon />
                          ) : urgency === 'WARNING' ? (
                            <StopwatchIcon />
                          ) : (
                            <ClockIcon />
                          )}
                          {word}
                        </span>
                      </div>

                      <div className="kds-card-body">
                        <div className="kds-order">
                          {/*
                            Only the tail is shown large. Every card on this
                            screen is from the same branch, so the "CLIFTO-"
                            prefix is identical on all of them and carries no
                            information — but it is eleven characters that
                            forced the number down to a size nobody can read
                            across a kitchen. The full number stays in the
                            card's accessible name.
                          */}
                          <span className="kds-no">
                            {card.orderNumber.includes('-') ? (
                              <>
                                <span className="kds-no-prefix">
                                  {card.orderNumber.slice(0, card.orderNumber.lastIndexOf('-') + 1)}
                                </span>
                                {card.orderNumber.slice(card.orderNumber.lastIndexOf('-') + 1)}
                              </>
                            ) : (
                              card.orderNumber
                            )}
                          </span>
                          <span className="kds-type">
                            {card.orderType === 'DELIVERY' ? <DeliveryIcon /> : <PickupIcon />}
                            {card.tableLabel
                              ? `Table ${card.tableLabel}`
                              : humanize(card.orderType)}
                          </span>
                        </div>

                        <ul className="kds-items">
                          {card.items.map((item) => (
                            <li key={item.id} className="kds-item">
                              <span className="kds-q">{item.quantity}×</span>
                              <span className="kds-n">
                                {item.name}
                                {item.variantName ? ` · ${item.variantName}` : ''}
                              </span>
                              {item.modifiers.length > 0 ? (
                                <span className="kds-m">{item.modifiers.join(' · ')}</span>
                              ) : null}
                              {item.notes ? <span className="kds-m">“{item.notes}”</span> : null}
                            </li>
                          ))}
                        </ul>

                        {card.notes ? (
                          <div className="kds-note">
                            <AlertIcon className="icon-sm" />
                            {card.notes}
                          </div>
                        ) : null}

                        {canUpdate && action ? (
                          <button
                            type="button"
                            className={`kds-act to-${action.to}`}
                            disabled={busy === card.id}
                            onClick={() => void advance(card, action.status)}
                          >
                            {busy === card.id ? 'Working…' : action.label}
                            <ArrowRightIcon />
                          </button>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          );
        })}
      </main>
    </div>
  );
}
