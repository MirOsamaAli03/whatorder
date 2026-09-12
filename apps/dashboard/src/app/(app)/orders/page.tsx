'use client';

import { OrderStatus, Permission } from '@restaurant-os/types';
import { useCallback, useEffect, useState } from 'react';
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

function statusPillClass(status: OrderStatus): string {
  if (status === OrderStatus.CONFIRMED) return 'pill pill-warn';
  if (status === OrderStatus.DELIVERY_FAILED) return 'pill pill-danger';
  if (status === OrderStatus.READY) return 'pill pill-ok';
  return 'pill';
}

export default function OrdersPage() {
  const session = useSession();
  const { selected, loading: branchesLoading } = useBranches();

  const [orders, setOrders] = useState<Order[]>([]);
  const [alarm, setAlarm] = useState<UnacknowledgedReport | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const canUpdate = session.can(Permission.ORDERS_UPDATE);

  const load = useCallback(async () => {
    if (!selected) return;

    try {
      const query = new URLSearchParams({ branchId: selected.id, limit: '100' });
      for (const status of ACTIVE) query.append('status', status);

      const [list, unacknowledged] = await Promise.all([
        api<{ orders: Order[]; total: number }>(`/orders?${query.toString()}`),
        api<UnacknowledgedReport>(`/kds/unacknowledged?branchId=${selected.id}`),
      ]);

      setOrders(list.orders);
      setAlarm(unacknowledged);
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
    if (status === OrderStatus.CANCELLED || status === OrderStatus.REJECTED) {
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

  if (branchesLoading || loading) {
    return <p className="muted">Loading orders…</p>;
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Live orders</h1>
          <p>{selected ? selected.name : 'No branch selected'}</p>
        </div>
        <div className="row">
          <BranchPicker />
          <button type="button" className="btn btn-sm" onClick={() => void load()}>
            Refresh
          </button>
        </div>
      </div>

      {error ? (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      ) : null}

      {alarm && alarm.count > 0 ? (
        <div className="banner banner-warn" role="status">
          <strong>
            {alarm.count} order{alarm.count === 1 ? '' : 's'} not acknowledged
          </strong>{' '}
          for more than {formatElapsed(alarm.thresholdSeconds)}.{' '}
          {alarm.orders
            .slice(0, 4)
            .map((order) => `${order.orderNumber} (${formatElapsed(order.waitingSeconds)})`)
            .join(', ')}
          {alarm.orders.some((order) => order.escalations.length > 0) ? (
            <span>
              {' '}
              · escalated to{' '}
              {[
                ...new Set(
                  alarm.orders.flatMap((order) =>
                    order.escalations.map((escalation) => humanize(escalation.target)),
                  ),
                ),
              ].join(', ')}
            </span>
          ) : null}
        </div>
      ) : null}

      {orders.length === 0 ? (
        <div className="empty">No live orders at this branch.</div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Placed</th>
                <th>Type</th>
                <th>Status</th>
                <th>Payment</th>
                <th style={{ textAlign: 'right' }}>Total</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <>
                  <tr key={order.id}>
                    <td>
                      <button
                        type="button"
                        className="btn btn-sm mono"
                        onClick={() => setExpanded(expanded === order.id ? null : order.id)}
                        aria-expanded={expanded === order.id}
                      >
                        {order.orderNumber}
                      </button>
                    </td>
                    <td className="faint">{formatDateTime(order.timestamps.createdAt)}</td>
                    <td>
                      <span className="pill">{humanize(order.orderType)}</span>
                    </td>
                    <td>
                      <span className={statusPillClass(order.status)}>
                        {humanize(order.status)}
                      </span>
                    </td>
                    <td>
                      <span
                        className={
                          order.paymentStatus === 'PAID' ? 'pill pill-ok' : 'pill'
                        }
                      >
                        {humanize(order.paymentStatus)}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right' }} className="mono">
                      {formatMoney(order.totals.total, order.currency)}
                    </td>
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        {/*
                          The buttons come from the API's own state machine via
                          `allowedTransitions`. The UI never decides what is
                          legal — it renders what the server says is possible
                          (spec §16).
                        */}
                        {canUpdate ? (
                          order.allowedTransitions.map((status) => (
                            <button
                              key={status}
                              type="button"
                              className={
                                status === OrderStatus.CANCELLED || status === OrderStatus.REJECTED
                                  ? 'btn btn-sm btn-danger'
                                  : 'btn btn-sm btn-primary'
                              }
                              disabled={busy === order.id}
                              onClick={() => void transition(order.id, status)}
                            >
                              {humanize(status)}
                            </button>
                          ))
                        ) : (
                          <span className="faint">View only</span>
                        )}
                      </div>
                    </td>
                  </tr>

                  {expanded === order.id ? (
                    <tr key={`${order.id}-detail`}>
                      <td colSpan={7} style={{ background: 'var(--bg)' }}>
                        <div className="row" style={{ alignItems: 'flex-start', gap: 32 }}>
                          <div style={{ minWidth: 260 }}>
                            <h3>Items</h3>
                            <ul style={{ paddingLeft: 18, margin: '8px 0 0' }}>
                              {order.items.map((item) => (
                                <li key={item.id}>
                                  {item.quantity} × {item.name}
                                  {item.variantName ? ` (${item.variantName})` : ''}
                                  {item.modifiers.length > 0 ? (
                                    <div className="faint">
                                      {item.modifiers
                                        .map((modifier) => modifier.optionName)
                                        .join(', ')}
                                    </div>
                                  ) : null}
                                  {item.notes ? <div className="faint">“{item.notes}”</div> : null}
                                </li>
                              ))}
                            </ul>
                          </div>

                          <div style={{ minWidth: 220 }}>
                            <h3>Totals</h3>
                            <table style={{ marginTop: 8 }}>
                              <tbody>
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
                                  <tr key={label}>
                                    <td className="faint">{label}</td>
                                    <td className="mono" style={{ textAlign: 'right' }}>
                                      {formatMoney(amount, order.currency)}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>

                          <div style={{ minWidth: 220 }}>
                            <h3>Customer</h3>
                            <p className="faint" style={{ marginTop: 8 }}>
                              {order.customerName ?? 'Walk-in'}
                              <br />
                              <span className="mono">{order.customerPhone}</span>
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
                          </div>

                          <div style={{ minWidth: 220 }}>
                            <h3>History</h3>
                            <ul style={{ paddingLeft: 18, margin: '8px 0 0' }} className="faint">
                              {order.history.map((entry, index) => (
                                <li key={index}>
                                  {humanize(entry.toStatus)} · {formatDateTime(entry.at)}
                                  {entry.reason ? ` — ${entry.reason}` : ''}
                                </li>
                              ))}
                            </ul>
                          </div>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
