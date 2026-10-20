'use client';

import { Permission } from '@restaurant-os/types';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertIcon, CheckIcon, ConversationsIcon } from '@/components/icons';
import { ApiError, api } from '@/lib/api-client';
import { useBranches } from '@/lib/branch';
import { formatDateTime } from '@/lib/format';
import { useSession } from '@/lib/session';
import type { NotificationPreference, WhatsAppAccount, WhatsAppTemplate } from '@/lib/types';

/**
 * Notification and WhatsApp settings.
 *
 * The screen that decides whether a restaurant can be onboarded without an
 * engineer. Two things on it matter more than the rest:
 *
 *   * connecting a WhatsApp number, which is otherwise a row somebody has to
 *     insert by hand;
 *   * the approval status of each message template — because until one is
 *     APPROVED no order update can reach a customer whose 24-hour window has
 *     closed, and a REJECTED one is the reason their customers went quiet
 *     (plan §2.2). Meta's rejection reason is shown verbatim, since it is the
 *     only thing that says how to fix it.
 */

const TEMPLATE_STATUS_CLASS: Record<string, string> = {
  APPROVED: 'pill pill-ready',
  REJECTED: 'pill pill-cancelled',
  PAUSED: 'pill pill-cancelled',
  DISABLED: 'pill pill-cancelled',
  PENDING: 'pill pill-warning',
  DRAFT: 'pill',
};

/**
 * Channels, in the order the grid shows them, named as a person would.
 *
 * The old screen printed the database's own values — `whatsapp`, `sms`,
 * `push`, `dashboard` — in lower case, which is the kind of detail that tells
 * a restaurant owner this software was not finished for them.
 */
const CHANNELS: Array<{ key: string; label: string }> = [
  { key: 'WHATSAPP', label: 'WhatsApp' },
  { key: 'SMS', label: 'Text message' },
  { key: 'EMAIL', label: 'Email' },
  { key: 'PUSH', label: 'Phone alert' },
  { key: 'DASHBOARD', label: 'This dashboard' },
];

/** Who can be told, and what that means. */
const RECIPIENTS: Record<string, { name: string; description: string }> = {
  CUSTOMER: { name: 'The customer', description: 'Order confirmed, being cooked, on the way' },
  STAFF: { name: 'Your team', description: 'New orders, and anything nobody has noticed' },
  MANAGER: { name: 'Managers', description: 'Escalations when an order is left waiting' },
  OWNER: { name: 'You', description: 'The last rung, when nobody else has answered' },
};

export default function SettingsPage() {
  const session = useSession();
  const { branches } = useBranches();

  const [preferences, setPreferences] = useState<NotificationPreference[]>([]);
  const [accounts, setAccounts] = useState<WhatsAppAccount[]>([]);
  const [templates, setTemplates] = useState<WhatsAppTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const [form, setForm] = useState({
    phoneNumberId: '',
    displayNumber: '',
    wabaId: '',
    branchId: '',
    accessToken: '',
  });

  const canManage = session.can(Permission.ORGANIZATION_MANAGE);

  const load = useCallback(async () => {
    try {
      const [prefs, connected, registered] = await Promise.all([
        api<NotificationPreference[]>('/notifications/preferences'),
        api<WhatsAppAccount[]>('/notifications/whatsapp/accounts'),
        api<WhatsAppTemplate[]>('/notifications/whatsapp/templates'),
      ]);

      setPreferences(prefs);
      setAccounts(connected);
      setTemplates(registered);
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not load settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function togglePreference(recipientType: string, channel: string, enabled: boolean) {
    setBusy(true);
    setNotice(null);

    try {
      setPreferences(
        await api<NotificationPreference[]>('/notifications/preferences', {
          method: 'PUT',
          body: { preferences: [{ recipientType, channel, enabled }] },
        }),
      );
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not save that');
    } finally {
      setBusy(false);
    }
  }

  async function connect(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);

    try {
      await api('/notifications/whatsapp/accounts', {
        method: 'POST',
        body: {
          phoneNumberId: form.phoneNumberId.trim(),
          displayNumber: form.displayNumber.trim(),
          ...(form.wabaId.trim() ? { wabaId: form.wabaId.trim() } : {}),
          ...(form.branchId ? { branchId: form.branchId } : {}),
          ...(form.accessToken.trim()
            ? { credentials: { accessToken: form.accessToken.trim() } }
            : {}),
        },
      });

      setForm({ phoneNumberId: '', displayNumber: '', wabaId: '', branchId: '', accessToken: '' });
      setNotice('Number connected.');
      setConnecting(false);
      setError(null);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not connect that number');
    } finally {
      setBusy(false);
    }
  }

  async function setActive(account: WhatsAppAccount, isActive: boolean) {
    setBusy(true);
    try {
      await api(`/notifications/whatsapp/accounts/${account.id}`, {
        method: 'PATCH',
        body: { isActive },
      });
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not update that number');
    } finally {
      setBusy(false);
    }
  }

  /** The flat preference list, pivoted into the grid the screen shows. */
  const grid = useMemo(() => {
    const recipients = [...new Set(preferences.map((row) => row.recipientType))];

    return recipients.map((recipientType) => ({
      recipientType,
      ...(RECIPIENTS[recipientType] ?? {
        name: recipientType.toLowerCase(),
        description: '',
      }),
      cells: CHANNELS.map((channel) => ({
        channel: channel.key,
        label: channel.label,
        // Absent means the channel is not offered to that recipient at all —
        // a customer has no dashboard to be notified in. A dash says so,
        // rather than an unticked box that looks like a setting.
        preference: preferences.find(
          (row) => row.recipientType === recipientType && row.channel === channel.key,
        ),
      })),
    }));
  }, [preferences]);

  if (loading) {
    return (
      <div className="page-head">
        <div className="page-title">
          <h1>Settings</h1>
          <p className="page-sub">Loading…</p>
        </div>
      </div>
    );
  }

  const rejected = templates.filter(
    (template) => template.status === 'REJECTED' || template.status === 'PAUSED',
  );

  return (
    <>
      <div className="page-head">
        <div className="page-title">
          <h1>Settings</h1>
          <p className="page-sub">
            {session.user?.organization.name} · applies to every branch · changes save as you make
            them
          </p>
        </div>
      </div>

      {error ? (
        <div className="alert alert-danger" role="alert">
          <AlertIcon />
          <div>{error}</div>
        </div>
      ) : null}
      {notice ? (
        <div className="alert alert-success" role="status">
          <div>{notice}</div>
        </div>
      ) : null}

      {rejected.length > 0 ? (
        <div className="alert alert-danger" role="alert">
          <AlertIcon />
          <div>
            <span className="alert-title">
              {rejected.length} template{rejected.length === 1 ? '' : 's'} not usable.
            </span>{' '}
            Order updates cannot reach a customer who has been quiet for 24 hours until Meta
            approves them.
          </div>
        </div>
      ) : null}

      <div className="set">
        <section className="set-section" aria-labelledby="settings-whatsapp">
          <div className="set-intro">
            <h2 id="settings-whatsapp">WhatsApp number</h2>
            <p>
              The number customers message to order. Replies from Conversations are sent from it
              too.
            </p>
          </div>

          <div className="card card-pad stack" style={{ gap: 16 }}>
            {accounts.length === 0 ? (
              <>
                <div className="alert alert-warning" role="status">
                  <AlertIcon />
                  <div>
                    <span className="alert-title">No number connected.</span> Customers cannot
                    order until you connect one.
                  </div>
                </div>

                <div className="steps" style={{ maxWidth: 'none' }}>
                  <div className="step">
                    <span className="step-n">1</span>
                    <div className="stack">
                      <span className="step-t">Have the number ready</span>
                      <span className="step-d">A WhatsApp Business number your shop owns.</span>
                    </div>
                  </div>
                  <div className="step">
                    <span className="step-n">2</span>
                    <div className="stack">
                      <span className="step-t">Verify with a code</span>
                      <span className="step-d">Sent to that phone by SMS or call.</span>
                    </div>
                  </div>
                  <div className="step">
                    <span className="step-n">3</span>
                    <div className="stack">
                      <span className="step-t">Start taking orders</span>
                      <span className="step-d">The bot answers using your menu.</span>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              accounts.map((account) => (
                <div key={account.id} className="wa-status">
                  <span className="cat-tile t-mint" aria-hidden="true">
                    <ConversationsIcon />
                  </span>
                  <div className="stack" style={{ minWidth: 0 }}>
                    <span className="wa-num">{account.displayNumber}</span>
                    <span className="sm muted">
                      {account.branchId
                        ? `Used by ${branches.find((b) => b.id === account.branchId)?.name ?? 'one branch'}`
                        : 'Used by every branch'}
                      {account.hasCredentials ? '' : ' · no access token stored'}
                    </span>
                  </div>
                  <span className={account.isActive ? 'pill pill-ready' : 'pill pill-outline'}>
                    {account.isActive ? 'Connected' : 'Paused'}
                  </span>
                  {canManage ? (
                    <button
                      type="button"
                      className={account.isActive ? 'btn btn-danger' : 'btn'}
                      disabled={busy}
                      onClick={() => void setActive(account, !account.isActive)}
                    >
                      {account.isActive ? 'Disconnect' : 'Reconnect'}
                    </button>
                  ) : null}
                </div>
              ))
            )}

            {canManage && !connecting ? (
              <div>
                <button
                  type="button"
                  className={accounts.length === 0 ? 'btn btn-primary btn-lg' : 'btn'}
                  onClick={() => setConnecting(true)}
                >
                  {accounts.length === 0 ? 'Connect a WhatsApp number' : 'Connect another number'}
                </button>
              </div>
            ) : null}

            {canManage && connecting ? (
              <form className="stack" style={{ gap: 14 }} onSubmit={connect}>
                <h3>Connect a number</h3>

                <div className="field">
                  <label className="field-label" htmlFor="phoneNumberId">
                    Phone number ID
                  </label>
                  <input
                    id="phoneNumberId"
                    className="input"
                    required
                    placeholder="From your WhatsApp Business account"
                    value={form.phoneNumberId}
                    onChange={(event) =>
                      setForm({ ...form, phoneNumberId: event.target.value })
                    }
                  />
                </div>

                <div className="field">
                  <label className="field-label" htmlFor="displayNumber">
                    Number
                  </label>
                  <input
                    id="displayNumber"
                    className="input"
                    required
                    placeholder="03001234567"
                    value={form.displayNumber}
                    onChange={(event) =>
                      setForm({ ...form, displayNumber: event.target.value })
                    }
                  />
                </div>

                <div className="field">
                  <label className="field-label" htmlFor="wabaId">
                    WhatsApp Business Account ID
                  </label>
                  <input
                    id="wabaId"
                    className="input"
                    placeholder="Optional"
                    value={form.wabaId}
                    onChange={(event) => setForm({ ...form, wabaId: event.target.value })}
                  />
                </div>

                <div className="field">
                  <label className="field-label" htmlFor="accountBranch">
                    Branch
                  </label>
                  <div className="select-wrap">
                    <select
                      id="accountBranch"
                      className="select"
                      value={form.branchId}
                      onChange={(event) => setForm({ ...form, branchId: event.target.value })}
                    >
                      <option value="">All branches</option>
                      {branches.map((branch) => (
                        <option key={branch.id} value={branch.id}>
                          {branch.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="field">
                  <label className="field-label" htmlFor="accessToken">
                    Access token
                  </label>
                  <input
                    id="accessToken"
                    className="input"
                    type="password"
                    placeholder="Stored encrypted; never shown again"
                    value={form.accessToken}
                    onChange={(event) => setForm({ ...form, accessToken: event.target.value })}
                  />
                </div>

                <div className="row-wrap" style={{ gap: 10 }}>
                  <button type="submit" className="btn btn-primary" disabled={busy}>
                    Connect
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => setConnecting(false)}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : null}
          </div>
        </section>

        <section className="set-section" aria-labelledby="settings-templates">
          <div className="set-intro">
            <h2 id="settings-templates">Message templates</h2>
            <p>
              WhatsApp only allows a pre-approved template once a customer has been quiet for 24
              hours. Approval is Meta&rsquo;s decision and can take a day, or be refused.
            </p>
          </div>

          <div className="card" style={{ overflow: 'hidden' }}>
            {templates.length === 0 ? (
              <div className="empty" style={{ padding: '36px 24px' }}>
                <p className="empty-body">
                  No templates registered. Order updates will only reach customers who have
                  messaged in the last 24 hours.
                </p>
              </div>
            ) : (
              templates.map((template) => (
                <div key={template.id} className="tpl">
                  <div className="stack" style={{ minWidth: 0, gap: 2 }}>
                    <span className="tpl-name">{template.templateKey}</span>
                    <span className="tpl-prev">{template.providerName}</span>
                    {template.rejectionReason ? (
                      <span className="field-error">
                        <AlertIcon className="icon-sm" />
                        {template.rejectionReason}
                      </span>
                    ) : null}
                  </div>
                  <span className={TEMPLATE_STATUS_CLASS[template.status] ?? 'pill'}>
                    {template.status.toLowerCase()}
                  </span>
                  <span className="sm faint">{formatDateTime(template.approvedAt)}</span>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="set-section" aria-labelledby="settings-notifications">
          <div className="set-intro">
            <h2 id="settings-notifications">Who hears about orders, and how</h2>
            <p>
              Tick a box to send that person updates on that channel. A dash means the channel
              cannot reach them. A channel with no provider configured is recorded but not
              delivered.
            </p>
          </div>

          <div className="card" style={{ overflow: 'hidden' }}>
            <table className="ngrid">
              <thead>
                <tr>
                  <th scope="col" style={{ textAlign: 'left' }}>
                    Send to
                  </th>
                  {CHANNELS.map((channel) => (
                    <th key={channel.key} scope="col">
                      {channel.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {grid.map((row) => (
                  <tr key={row.recipientType}>
                    <th scope="row">
                      {row.name}
                      <span>{row.description}</span>
                    </th>
                    {row.cells.map((cell) => (
                      <td key={cell.channel}>
                        {cell.preference ? (
                          <label className="check">
                            <input
                              type="checkbox"
                              checked={cell.preference.enabled}
                              disabled={busy || !canManage}
                              onChange={(event) =>
                                void togglePreference(
                                  row.recipientType,
                                  cell.channel,
                                  event.target.checked,
                                )
                              }
                            />
                            <span className="check-box" aria-hidden="true">
                              <CheckIcon />
                            </span>
                            <span className="sr-only">
                              {cell.label} for {row.name}
                            </span>
                          </label>
                        ) : (
                          <span className="na" aria-label={`${cell.label} cannot reach ${row.name}`}>
                            —
                          </span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </>
  );
}
