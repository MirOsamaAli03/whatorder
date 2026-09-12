'use client';

import { Permission } from '@restaurant-os/types';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/api-client';
import { useBranches } from '@/lib/branch';
import { formatDateTime } from '@/lib/format';
import { useSession } from '@/lib/session';
import type {
  NotificationPreference,
  WhatsAppAccount,
  WhatsAppTemplate,
} from '@/lib/types';

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
  APPROVED: 'pill pill-ok',
  REJECTED: 'pill pill-danger',
  PAUSED: 'pill pill-danger',
  DISABLED: 'pill pill-danger',
  PENDING: 'pill pill-warn',
  DRAFT: 'pill',
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

  async function togglePreference(preference: NotificationPreference) {
    setBusy(true);
    setNotice(null);

    try {
      setPreferences(
        await api<NotificationPreference[]>('/notifications/preferences', {
          method: 'PUT',
          body: {
            preferences: [
              {
                recipientType: preference.recipientType,
                channel: preference.channel,
                enabled: !preference.enabled,
              },
            ],
          },
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

  if (loading) return <p className="muted">Loading…</p>;

  const rejected = templates.filter(
    (template) => template.status === 'REJECTED' || template.status === 'PAUSED',
  );
  const unapproved = templates.filter((template) => template.status !== 'APPROVED');

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">How your customers and your team are told about orders.</p>
        </div>
      </header>

      {error ? <p className="error" role="status">{error}</p> : null}
      {notice ? <p className="notice" role="status">{notice}</p> : null}

      {/*
        Surfaced at the top rather than buried in the table: a rejected template
        is the single likeliest reason a restaurant's customers stop hearing
        from them, and it fails silently everywhere else.
      */}
      {rejected.length > 0 ? (
        <p className="error" role="status">
          {rejected.length} message {rejected.length === 1 ? 'template has' : 'templates have'} been
          rejected or paused by WhatsApp. Until they are approved, customers whose last message was
          over 24 hours ago will not receive those updates.
        </p>
      ) : null}

      <section className="card">
        <h2>WhatsApp numbers</h2>

        {accounts.length === 0 ? (
          <p className="muted">
            No number is connected yet, so nothing can be sent or received over WhatsApp. See the
            onboarding guide before moving a number that is currently in the WhatsApp Business app.
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Number</th>
                <th>Branch</th>
                <th>Provider</th>
                <th>Credentials</th>
                <th>Status</th>
                {canManage ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.id}>
                  <td>
                    {account.displayNumber}
                    <br />
                    <small className="muted">{account.phoneNumberId}</small>
                  </td>
                  <td>
                    {branches.find((branch) => branch.id === account.branchId)?.name ??
                      'All branches'}
                  </td>
                  <td>{account.provider}</td>
                  <td>
                    {/* Never the value: a settings page showing a provider
                        access token is one screenshot away from leaking it. */}
                    {account.hasCredentials ? 'Set' : <span className="muted">Not set</span>}
                  </td>
                  <td>
                    <span className={account.isActive ? 'pill pill-ok' : 'pill'}>
                      {account.isActive ? 'active' : 'inactive'}
                    </span>
                  </td>
                  {canManage ? (
                    <td>
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        onClick={() => void setActive(account, !account.isActive)}
                      >
                        {account.isActive ? 'Deactivate' : 'Activate'}
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {canManage ? (
          <form className="form-grid" onSubmit={connect}>
            <h3>Connect a number</h3>

            <label>
              Phone number ID
              <input
                value={form.phoneNumberId}
                onChange={(event) => setForm({ ...form, phoneNumberId: event.target.value })}
                required
                placeholder="From your WhatsApp Business account"
              />
            </label>

            <label>
              Number
              <input
                value={form.displayNumber}
                onChange={(event) => setForm({ ...form, displayNumber: event.target.value })}
                required
                placeholder="03001234567"
              />
            </label>

            <label>
              WhatsApp Business Account ID
              <input
                value={form.wabaId}
                onChange={(event) => setForm({ ...form, wabaId: event.target.value })}
                placeholder="Optional"
              />
            </label>

            <label>
              Branch
              <select
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
            </label>

            <label>
              Access token
              <input
                type="password"
                value={form.accessToken}
                onChange={(event) => setForm({ ...form, accessToken: event.target.value })}
                placeholder="Stored encrypted; never shown again"
              />
            </label>

            <button type="submit" disabled={busy}>
              Connect
            </button>
          </form>
        ) : null}
      </section>

      <section className="card">
        <h2>Message templates</h2>
        <p className="muted">
          WhatsApp only allows a pre-approved template once a customer has been quiet for 24 hours.
          Approval is Meta&apos;s decision and can take a day or be refused.
          {unapproved.length > 0
            ? ` ${unapproved.length} of ${templates.length} are not approved yet.`
            : ''}
        </p>

        {templates.length === 0 ? (
          <p className="muted">
            No templates registered. Order updates will only reach customers who have messaged in
            the last 24 hours.
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Message</th>
                <th>Language</th>
                <th>Category</th>
                <th>Status</th>
                <th>Approved</th>
              </tr>
            </thead>
            <tbody>
              {templates.map((template) => (
                <tr key={template.id}>
                  <td>
                    {template.templateKey}
                    <br />
                    <small className="muted">{template.providerName}</small>
                    {template.rejectionReason ? (
                      <p className="error-inline">{template.rejectionReason}</p>
                    ) : null}
                  </td>
                  <td>{template.language}</td>
                  <td>{template.category}</td>
                  <td>
                    <span className={TEMPLATE_STATUS_CLASS[template.status] ?? 'pill'}>
                      {template.status.toLowerCase()}
                    </span>
                  </td>
                  <td className="muted">{formatDateTime(template.approvedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Notifications</h2>
        <p className="muted">
          Which channels are used, and for whom. A channel with no provider configured is recorded
          but not delivered.
        </p>

        <table className="table">
          <thead>
            <tr>
              <th>Recipient</th>
              <th>Channel</th>
              <th>Enabled</th>
            </tr>
          </thead>
          <tbody>
            {preferences.map((preference) => (
              <tr key={`${preference.recipientType}:${preference.channel}`}>
                <td>{preference.recipientType.toLowerCase()}</td>
                <td>{preference.channel.toLowerCase()}</td>
                <td>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={preference.enabled}
                      disabled={!canManage || busy}
                      onChange={() => void togglePreference(preference)}
                      aria-label={`${preference.channel} for ${preference.recipientType}`}
                    />
                  </label>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
