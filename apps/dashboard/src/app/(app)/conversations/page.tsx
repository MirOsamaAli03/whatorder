'use client';

import { Permission } from '@restaurant-os/types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api-client';
import { BranchPicker, useBranches } from '@/lib/branch';
import { formatElapsed, formatDateTime } from '@/lib/format';
import { useSession } from '@/lib/session';
import type { ConversationSummary, ConversationThread } from '@/lib/types';

/**
 * The staff inbox for WhatsApp conversations.
 *
 * This screen exists because of one sentence the bot says: "I have passed this
 * conversation to the team — somebody will reply here shortly." Without
 * somewhere for that to land, it is a promise the software does not keep, and
 * it is made at the worst possible moment — when a customer has already given
 * up on the bot.
 *
 * So the list is sorted by who has been waiting longest, the waiting time is
 * the loudest thing on each row, and nothing here computes anything: the API
 * decides how long somebody has waited and whether a reply is still permitted.
 */

/** Waiting longer than this is called out in red. */
const URGENT_SECONDS = 300;

export default function ConversationsPage() {
  const session = useSession();
  const { selected, loading: branchesLoading } = useBranches();

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [thread, setThread] = useState<ConversationThread | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);

  const canReply = session.can(Permission.CUSTOMERS_UPDATE);
  const bottom = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    if (!selected) return;

    try {
      const query = new URLSearchParams({ branchId: selected.id });
      if (showAll) query.set('state', 'ALL');

      setConversations(await api<ConversationSummary[]>(`/conversations?${query.toString()}`));
      setError(null);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not load conversations');
    } finally {
      setLoading(false);
    }
  }, [selected, showAll]);

  const loadThread = useCallback(async (id: string) => {
    try {
      setThread(await api<ConversationThread>(`/conversations/${id}`));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not load the conversation');
    }
  }, []);

  // Polled rather than streamed. The KDS earns a live socket because a cook is
  // watching one screen; an inbox checked every few seconds is indistinguishable
  // to a person and costs nothing to get right.
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5_000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!openId) {
      setThread(null);
      return;
    }
    void loadThread(openId);
    const timer = setInterval(() => void loadThread(openId), 5_000);
    return () => clearInterval(timer);
  }, [openId, loadThread]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [thread?.messages.length]);

  async function reply(event: React.FormEvent) {
    event.preventDefault();
    if (!openId || !draft.trim()) return;

    setBusy(true);
    setError(null);

    try {
      setThread(
        await api<ConversationThread>(`/conversations/${openId}/reply`, {
          method: 'POST',
          body: { body: draft.trim() },
        }),
      );
      setDraft('');
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not send the reply');
    } finally {
      setBusy(false);
    }
  }

  async function handBack() {
    if (!openId) return;
    setBusy(true);

    try {
      await api(`/conversations/${openId}/resolve`, { method: 'POST' });
      setOpenId(null);
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not end the handoff');
    } finally {
      setBusy(false);
    }
  }

  if (branchesLoading || loading) {
    return <p className="muted">Loading…</p>;
  }

  const waiting = conversations.filter((row) => row.waitingSeconds !== null);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Conversations</h1>
          <p className="muted">
            {waiting.length === 0
              ? 'Nobody is waiting for a reply.'
              : `${waiting.length} ${waiting.length === 1 ? 'customer is' : 'customers are'} waiting for a reply.`}
          </p>
        </div>
        <div className="page-actions">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(event) => setShowAll(event.target.checked)}
            />
            Show all conversations
          </label>
          <BranchPicker />
        </div>
      </header>

      {error ? <p className="error" role="status">{error}</p> : null}

      <div className="inbox">
        <ul className="inbox-list">
          {conversations.length === 0 ? (
            <li className="muted inbox-empty">
              {showAll ? 'No conversations yet.' : 'No one is waiting.'}
            </li>
          ) : null}

          {conversations.map((row) => {
            const urgent = (row.waitingSeconds ?? 0) >= URGENT_SECONDS;

            return (
              <li key={row.id}>
                <button
                  type="button"
                  className={`inbox-row${openId === row.id ? ' is-open' : ''}`}
                  onClick={() => setOpenId(row.id)}
                  aria-current={openId === row.id ? 'true' : undefined}
                >
                  <span className="inbox-who">
                    {row.customerName ?? row.contactNumber}
                    {row.customerName ? (
                      <small className="muted"> {row.contactNumber}</small>
                    ) : null}
                  </span>

                  <span className="inbox-preview muted">
                    {row.lastMessage?.body?.slice(0, 80) ?? 'No messages yet'}
                  </span>

                  {row.waitingSeconds !== null ? (
                    <span className={urgent ? 'pill pill-danger' : 'pill pill-warn'}>
                      waiting {formatElapsed(row.waitingSeconds)}
                    </span>
                  ) : (
                    <span className="pill">{row.state.replace(/_/g, ' ').toLowerCase()}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>

        <section className="inbox-thread">
          {!thread ? (
            <p className="muted">Pick a conversation to read it.</p>
          ) : (
            <>
              <header className="thread-head">
                <div>
                  <strong>{thread.customer?.name ?? thread.contactNumber}</strong>
                  <p className="muted">
                    {thread.contactNumber} · last heard from{' '}
                    {formatDateTime(thread.lastInboundAt)}
                  </p>
                </div>

                {thread.state === 'HUMAN_HANDOFF' && canReply ? (
                  <button type="button" className="secondary" onClick={handBack} disabled={busy}>
                    Hand back to the bot
                  </button>
                ) : null}
              </header>

              <div className="thread-messages">
                {thread.messages.map((message) => (
                  <article
                    key={message.id}
                    className={
                      message.direction === 'INBOUND' ? 'bubble bubble-in' : 'bubble bubble-out'
                    }
                  >
                    <p>{message.body ?? <em className="muted">(no text)</em>}</p>
                    <footer className="muted">
                      {formatDateTime(message.occurredAt)}
                      {message.direction === 'OUTBOUND' && message.status
                        ? ` · ${message.status}`
                        : ''}
                    </footer>
                  </article>
                ))}
                <div ref={bottom} />
              </div>

              {canReply ? (
                <form className="thread-reply" onSubmit={reply}>
                  <textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder={
                      thread.canReply
                        ? 'Type a reply…'
                        : 'WhatsApp will not accept a reply until this customer messages again'
                    }
                    rows={2}
                    maxLength={1000}
                    disabled={!thread.canReply || busy}
                  />
                  <button type="submit" disabled={!thread.canReply || busy || !draft.trim()}>
                    Send
                  </button>
                </form>
              ) : null}

              {!thread.canReply ? (
                <p className="muted thread-note">
                  This customer last messaged more than 24 hours ago. WhatsApp only allows a
                  pre-approved template after that, so they will need to message again before you
                  can reply here.
                </p>
              ) : null}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
