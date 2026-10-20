'use client';

import { OrderStatus, Permission } from '@restaurant-os/types';
import Link from 'next/link';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { AlertIcon, KitchenIcon, OrdersIcon } from '@/components/icons';
import { OverflowMenu, type OverflowAction } from '@/components/overflow-menu';
import { ApiError, api } from '@/lib/api-client';
import { BranchPicker, useBranches } from '@/lib/branch';
import { formatDateTime, formatElapsed, formatMoney, humanize } from '@/lib/format';
import { useSession } from '@/lib/session';
import type { Order, UnacknowledgedReport } from '@/lib/types';

/** Statuses that count as live work. Mirrors the API's ACTIVE_ORDER_STATUSES. */
const ACTIVE: OrderStatus[] = [
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.CONFIRMED,
  OrderStatus.ACCEPTED,
  OrderStatus.PREPARING,
  OrderStatus.READY,
  OrderStatus.OUT_FOR_DELIVERY,
  OrderStatus.DELIVERY_FAILED,
];

/**
 * Thirteen statuses, six colours.
 *
 * The design gives one colour per *stage of the journey*, not one per status,
 * and that is the right granularity for a glance: somebody scanning this list
 * wants to know whether an order is waiting on the kitchen, in it, or done with
 * — not to distinguish DELIVERED from COMPLETED at ten feet. The exact status
 * is still written inside the pill.
 */
const PILL: Record<string, string> = {
  [OrderStatus.DRAFT]: 'pill',
  [OrderStatus.PENDING_PAYMENT]: 'pill pill-warning',
  [OrderStatus.CONFIRMED]: 'pill pill-new',
  [OrderStatus.ACCEPTED]: 'pill pill-accepted',
  [OrderStatus.PREPARING]: 'pill pill-preparing',
  [OrderStatus.READY]: 'pill pill-ready',
  [OrderStatus.OUT_FOR_DELIVERY]: 'pill pill-preparing',
  [OrderStatus.DELIVERED]: 'pill pill-delivered',
  [OrderStatus.COMPLETED]: 'pill pill-delivered',
  [OrderStatus.DELIVERY_FAILED]: 'pill pill-cancelled',
  [OrderStatus.RETURNED]: 'pill pill-cancelled',
  [OrderStatus.CANCELLED]: 'pill pill-cancelled',
  [OrderStatus.REJECTED]: 'pill pill-cancelled',
};

/** The filter chips, and which statuses each one gathers. */
const FILTERS: Array<{ key: string; label: string; dot?: string; statuses: OrderStatus[] }> = [
  { key: 'all', label: 'All', statuses: [] },
  { key: 'new', label: 'New', dot: 'var(--st-new)', statuses: [OrderStatus.CONFIRMED, OrderStatus.PENDING_PAYMENT] },
  { key: 'accepted', label: 'Accepted', dot: 'var(--st-accepted)', statuses: [OrderStatus.ACCEPTED] },
  { key: 'preparing', label: 'Preparing', dot: 'var(--st-preparing)', statuses: [OrderStatus.PREPARING] },
  { key: 'ready', label: 'Ready', dot: 'var(--st-ready)', statuses: [OrderStatus.READY, OrderStatus.OUT_FOR_DELIVERY] },
  { key: 'attention', label: 'Needs attention', dot: 'var(--st-cancelled)', statuses: [OrderStatus.DELIVERY_FAILED] },
];

/** Cancelling and rejecting are the two the API demands a reason for. */
function needsReason(status: OrderStatus): boolean {
  return status === OrderStatus.CANCELLED || status === OrderStatus.REJECTED;
}

/** How old an order is, and whether that is worth colouring. */
function age(order: Order, thresholdSeconds: number): { text: string; className: string } {
  const createdAt = order.timestamps.createdAt;
  if (!createdAt) return { text: '', className: 'o-age' };

  const seconds = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000));
  const text = formatElapsed(seconds);

  if (seconds >= thresholdSeconds * 2) return { text, className: 'o-age is-critical' };
  if (seconds >= thresholdSeconds) return { text, className: 'o-age is-warning' };
  return { text, className: 'o-age' };
}

export default function OrdersPage() {
  const session = useSession();
  const { selected, loading: branchesLoading } = useBranches();

  const [orders, setOrders] = useState<Order[]>([]);
  const [alarm, setAlarm] = useState<UnacknowledgedReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const canUpdate = session.can(Permission.ORDERS_UPDATE);

  const load = useCallback(async () => {
    if (!selected) return;

    try {
      const search = new URLSearchParams({ branchId: selected.id, limit: '100' });
      for (const status of ACTIVE) search.append('status', status);

      const [list, unacknowledged] = await Promise.all([
        api<{ orders: Order[]; total: number }>(`/orders?${search.toString()}`),
        api<UnacknowledgedReport>(`/kds/unacknowledged?branchId=${selected.id}`),
      ]);

      setOrders(list.orders);
      setAlarm(unacknowledged);
      setUpdatedAt(new Date());
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load orders');
    } finally {
      setLoading(false);
    }
  }, [selected]);

  useEffect(() => {
    void load();

    /**
     * A slow reconciliation poll, deliberately.
     *
     * The kitchen display consumes the live stream; this list is the calmer
     * management view and does not need a socket of its own. Polling every ten
     * seconds keeps it honest without a second long-lived connection per open
     * tab (plan §2.8: the stream is an optimisation over a correct baseline).
     */
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  async function transition(orderId: string, status: OrderStatus) {
    // The API requires a reason for these, and refuses without one.
    let reason: string | undefined;
    if (needsReason(status)) {
      const entered = window.prompt(`Why is this order being ${humanize(status).toLowerCase()}?`);
      if (!entered) return;
      reason = entered;
    }

    setBusy(orderId);
    setError(null);

    try {
      await api(`/orders/${orderId}/transition`, {
        method: 'POST',
        body: { status, ...(reason ? { reason } : {}) },
      });
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not update the order');
    } finally {
      setBusy(null);
    }
  }

  const counts = useMemo(() => {
    const result: Record<string, number> = { all: orders.length };
    for (const chip of FILTERS) {
      if (chip.key === 'all') continue;
      result[chip.key] = orders.filter((order) =>
        chip.statuses.includes(order.status as OrderStatus),
      ).length;
    }
    return result;
  }, [orders]);

  const shown = useMemo(() => {
    const chip = FILTERS.find((candidate) => candidate.key === filter);
    const needle = query.trim().toLowerCase();

    return orders.filter((order) => {
      if (chip && chip.statuses.length > 0 && !chip.statuses.includes(order.status as OrderStatus)) {
        return false;
      }
      if (!needle) return true;

      // Name, phone or order number — the three things somebody standing at the
      // counter actually has to hand.
      return (
        order.orderNumber.toLowerCase().includes(needle) ||
        (order.customerName ?? '').toLowerCase().includes(needle) ||
        (order.customerPhone ?? '').toLowerCase().includes(needle)
      );
    });
  }, [orders, filter, query]);

  if (branchesLoading || loading) {
    return (
      <div className="page-head">
        <div className="page-title">
          <h1>Live orders</h1>
          <p className="page-sub">Loading…</p>
        </div>
      </div>
    );
  }

  const threshold = alarm?.thresholdSeconds ?? 600;

  return (
    <>
      <div className="page-head">
        <div className="page-title">
          <h1>Live orders</h1>
          <p className="page-sub row" style={{ gap: 8 }}>
            <span className="dot-live" aria-hidden="true" />
            Today · {selected ? selected.name : 'No branch selected'}
            {updatedAt ? ` · updated ${formatDateTime(updatedAt.toISOString())}` : ''}
          </p>
        </div>

        <div className="page-tools">
          <div className="hide-phone">
            <BranchPicker id="orders-branch" />
          </div>
          <div className="field" style={{ minWidth: 260 }}>
            <label className="field-label" htmlFor="orders-search">
              Find an order
            </label>
            <input
              id="orders-search"
              className="input"
              placeholder="Name, phone or order #"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="toolbar">
        <div className="chips" role="group" aria-label="Filter by status">
          {FILTERS.map((chip) => (
            <button
              key={chip.key}
              type="button"
              className="chip"
              aria-pressed={filter === chip.key}
              onClick={() => setFilter(chip.key)}
            >
              {chip.dot ? <span className="dot" style={{ background: chip.dot }} /> : null}
              {chip.label} <span className="chip-count">{counts[chip.key] ?? 0}</span>
            </button>
          ))}
        </div>
        <Link href="/kds" className="btn hide-phone">
          <KitchenIcon />
          Open kitchen display
        </Link>
      </div>

      {error ? (
        <div className="alert alert-danger" role="alert">
          <AlertIcon />
          <div>{error}</div>
        </div>
      ) : null}

      {alarm && alarm.count > 0 ? (
        <div className="alert alert-warning" role="status">
          <AlertIcon />
          <div>
            <span className="alert-title">
              {alarm.count} order{alarm.count === 1 ? '' : 's'} not acknowledged for more than{' '}
              {formatElapsed(alarm.thresholdSeconds)}.
            </span>{' '}
            {alarm.orders
              .slice(0, 4)
              .map((order) => `${order.orderNumber} (${formatElapsed(order.waitingSeconds)})`)
              .join(', ')}
            {alarm.orders.some((order) => order.escalations.length > 0)
              ? ` · escalated to ${[
                  ...new Set(
                    alarm.orders.flatMap((order) =>
                      order.escalations.map((escalation) => humanize(escalation.target)),
                    ),
                  ),
                ].join(', ')}`
              : ''}
          </div>
        </div>
      ) : null}

      {shown.length === 0 ? (
        <div className="card" style={{ padding: '8px 0 32px' }}>
          <div className="empty">
            <div className="empty-icon" aria-hidden="true">
              <OrdersIcon className="icon-lg" />
            </div>
            <h2 className="empty-title">
              {orders.length === 0 ? 'No orders yet today' : 'Nothing matches that'}
            </h2>
            <p className="empty-body">
              {orders.length === 0
                ? 'Orders appear here the moment a customer confirms on WhatsApp, with a chime. Leave this screen open on the counter.'
                : 'Try a different status, or clear the search.'}
            </p>
            <div className="empty-actions">
              {orders.length === 0 ? (
                <>
                  <Link href="/kds" className="btn btn-primary">
                    Open kitchen display
                  </Link>
                  <Link href="/settings" className="btn">
                    Check WhatsApp connection
                  </Link>
                </>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    setFilter('all');
                    setQuery('');
                  }}
                >
                  Show all orders
                </button>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="card" style={{ overflow: 'hidden' }}>
          <table className="otable">
            <thead>
              <tr>
                <th scope="col">Order</th>
                <th scope="col">Customer</th>
                <th scope="col" className="col-items">
                  Items
                </th>
                <th scope="col" style={{ textAlign: 'right' }}>
                  Total
                </th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((order) => {
                const items = order.items
                  .map(
                    (item) =>
                      `${item.quantity}× ${item.name}${item.variantName ? ` · ${item.variantName}` : ''}`,
                  )
                  .join(', ');

                /*
                  The buttons come from the API's own state machine via
                  `allowedTransitions`. The UI never decides what is legal — it
                  renders what the server says is possible (spec §16). The first
                  is the obvious next step and gets the button; the rest go in
                  the menu, because a row cannot carry five buttons without
                  wrapping.
                */
                const allowed = canUpdate ? order.allowedTransitions : [];
                const [primary, ...rest] = allowed;
                const overflow: OverflowAction[] = rest.map((status) => ({
                  key: status,
                  label: humanize(status),
                  danger: needsReason(status),
                  onSelect: () => void transition(order.id, status),
                }));
                const when = age(order, threshold);

                return (
                  <Fragment key={order.id}>
                  <tr>
                    <td className="c-no">
                      {/* The number is the disclosure, as it was before the
                          redesign: the breakdown and the history are what
                          somebody reaches for when a customer queries a bill,
                          and the design had no place for them because it did
                          not know they existed. */}
                      <button
                        type="button"
                        className="o-no o-disclose"
                        aria-expanded={expanded === order.id}
                        onClick={() => setExpanded(expanded === order.id ? null : order.id)}
                      >
                        {order.orderNumber}
                      </button>
                      <div className="o-sub">
                        {humanize(order.orderType)} ·{' '}
                        <span className="num">{formatDateTime(order.timestamps.createdAt)}</span>
                      </div>
                    </td>

                    <td className="c-cust">
                      <div className="o-cust">{order.customerName ?? 'Walk-in'}</div>
                      <div className="o-sub num hide-tablet-down">{order.customerPhone}</div>
                      <div className="o-items only-narrow">{items}</div>
                    </td>

                    <td className="col-items">
                      <div className="o-items">{items}</div>
                    </td>

                    <td className="c-total">
                      <div className="o-total">
                        {formatMoney(order.totals.total, order.currency)}
                      </div>
                    </td>

                    <td className="c-status">
                      <span className={PILL[order.status] ?? 'pill'}>{humanize(order.status)}</span>
                      <div className={when.className}>{when.text}</div>
                    </td>

                    <td className="c-act">
                      <div className="o-actions">
                        {primary ? (
                          <button
                            type="button"
                            className="btn btn-primary"
                            disabled={busy === order.id}
                            onClick={() => void transition(order.id, primary)}
                          >
                            {humanize(primary)}
                          </button>
                        ) : null}
                        <OverflowMenu
                          label={`More actions for order ${order.orderNumber}`}
                          actions={overflow}
                          disabled={busy === order.id}
                        />
                        {allowed.length === 0 ? <span className="faint sm">View only</span> : null}
                      </div>
                    </td>
                  </tr>

                  {expanded === order.id ? (
                    <tr className="o-detail-row">
                      <td colSpan={6}>
                        <div className="o-detail">
                          <section>
                            <h3>Items</h3>
                            <ul className="o-detail-list">
                              {order.items.map((item) => (
                                <li key={item.id}>
                                  <span className="num">{item.quantity}×</span> {item.name}
                                  {item.variantName ? ` · ${item.variantName}` : ''}
                                  {item.modifiers.length > 0 ? (
                                    <div className="faint sm">
                                      {item.modifiers
                                        .map((modifier) => modifier.optionName)
                                        .join(', ')}
                                    </div>
                                  ) : null}
                                  {item.notes ? (
                                    <div className="faint sm">&ldquo;{item.notes}&rdquo;</div>
                                  ) : null}
                                </li>
                              ))}
                            </ul>
                          </section>

                          <section>
                            <h3>Totals</h3>
                            <dl className="o-totals">
                              {(
                                [
                                  ['Subtotal', order.totals.subtotal],
                                  ['Discount', order.totals.discountAmount],
                                  ['Service', order.totals.serviceCharge],
                                  ['Delivery', order.totals.deliveryFee],
                                  ['Tax', order.totals.taxAmount],
                                  ['Total', order.totals.total],
                                ] as const
                              ).map(([label, amount]) => (
                                <div key={label}>
                                  <dt className="faint">{label}</dt>
                                  <dd className="num">{formatMoney(amount, order.currency)}</dd>
                                </div>
                              ))}
                            </dl>
                          </section>

                          <section>
                            <h3>Customer</h3>
                            <p className="muted sm">
                              {order.customerName ?? 'Walk-in'}
                              <br />
                              <span className="num">{order.customerPhone}</span>
                              {order.deliveryAddress ? (
                                <>
                                  <br />
                                  {order.deliveryAddress}
                                </>
                              ) : null}
                              {order.tableLabel ? (
                                <>
                                  <br />
                                  Table {order.tableLabel}
                                </>
                              ) : null}
                            </p>
                          </section>

                          <section>
                            <h3>History</h3>
                            <ul className="o-detail-list muted sm">
                              {order.history.map((entry, index) => (
                                <li key={index}>
                                  {humanize(entry.toStatus)} · {formatDateTime(entry.at)}
                                  {entry.reason ? ` — ${entry.reason}` : ''}
                                </li>
                              ))}
                            </ul>
                          </section>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
