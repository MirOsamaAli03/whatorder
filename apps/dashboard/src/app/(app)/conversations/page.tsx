'use client';

import { Permission } from '@restaurant-os/types';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertIcon,
  BackIcon,
  ClockIcon,
  ConversationsIcon,
  SendIcon,
} from '@/components/icons';
import { ApiError, api } from '@/lib/api-client';
import { BranchPicker, useBranches } from '@/lib/branch';
import { formatDateTime, formatElapsed } from '@/lib/format';
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
/** And longer than this turns the wait badge amber on the way there. */
const WARNING_SECONDS = 120;

/** Somebody's initials, for the thread avatar. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return ((parts[0]?.charAt(0) ?? '') + (parts.length > 1 ? parts[parts.length - 1]!.charAt(0) : ''))
    .toUpperCase();
}

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
    return (
      <div className="page-head">
        <div className="page-title">
          <h1>Conversations</h1>
          <p className="page-sub">Loading…</p>
        </div>
      </div>
    );
  }

  const waiting = conversations.filter((row) => row.waitingSeconds !== null);
  const who = thread?.customer?.name ?? thread?.contactNumber ?? '';

  return (
    <>
      <div className="page-head">
        <div className="page-title">
          <h1>Conversations</h1>
          <p className="page-sub">
            {waiting.length === 0
              ? 'Nobody is waiting for a reply.'
              : `${waiting.length} ${waiting.length === 1 ? 'customer is' : 'customers are'} waiting for a reply.`}
          </p>
        </div>
        <div className="page-tools hide-phone">
          <BranchPicker id="conversations-branch" />
        </div>
      </div>

      {error ? (
        <div className="alert alert-danger" role="alert">
          <AlertIcon />
          <div>{error}</div>
        </div>
      ) : null}

      {/* On a phone the two panes become one: the list, until a conversation is
          opened, and then the thread with a back button. */}
      <div className={`inbox${openId ? ' show-thread' : ''}`}>
        <section className="inbox-list" aria-label="Customers waiting">
          <div className="inbox-list-head">
            <div className="row">
              <b>Waiting for a person</b>
              <span className="sm faint">Longest first</span>
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={showAll}
                onChange={(event) => setShowAll(event.target.checked)}
              />
              <span className="check-box" aria-hidden="true" />
              <span className="check-label">
                Show all conversations, including ones the bot finished
              </span>
            </label>
          </div>

          {conversations.length === 0 ? (
            <div className="empty" style={{ padding: '48px 24px' }}>
              <div
                className="empty-icon"
                aria-hidden="true"
                style={{ background: 'var(--st-ready-soft)', color: 'var(--st-ready-fg)' }}
              >
                <ConversationsIcon className="icon-lg" />
              </div>
              <h2 className="empty-title" style={{ fontSize: 24, lineHeight: '30px' }}>
                {showAll ? 'No conversations yet' : 'No one is waiting'}
              </h2>
              <p className="empty-body">
                When a customer asks to speak to a person on WhatsApp, they appear here — longest
                wait first, with the wait in big numbers.
              </p>
            </div>
          ) : null}

          {conversations.map((row) => {
            const seconds = row.waitingSeconds ?? 0;
            const waitClass =
              seconds >= URGENT_SECONDS
                ? 'wait is-critical'
                : seconds >= WARNING_SECONDS
                  ? 'wait is-warning'
                  : 'wait';
            const name = row.customerName ?? row.contactNumber;

            return (
              <button
                key={row.id}
                type="button"
                className="inbox-row"
                aria-current={openId === row.id ? 'true' : undefined}
                aria-label={
                  row.waitingSeconds !== null
                    ? `${name}, waiting ${formatElapsed(row.waitingSeconds)}`
                    : name
                }
                onClick={() => setOpenId(row.id)}
              >
                {/* The wait is the loudest thing on the row, on purpose: an
                    inbox that does not make waiting visible is a list nobody
                    triages. */}
                {row.waitingSeconds !== null ? (
                  <span className={waitClass}>
                    <b>{Math.max(1, Math.round(row.waitingSeconds / 60))}</b>
                    <span>min</span>
                  </span>
                ) : (
                  <span className="wait" style={{ background: 'var(--surface-2)' }}>
                    <b>·</b>
                    <span>bot</span>
                  </span>
                )}

                <span className="inbox-who">
                  <span className="inbox-name">{name}</span>
                  <span className="inbox-preview">
                    {row.lastMessage?.body?.slice(0, 80) ?? 'No messages yet'}
                  </span>
                  <span className="inbox-meta">
                    {row.customerName ? `${row.contactNumber} · ` : ''}
                    {row.state.replace(/_/g, ' ').toLowerCase()}
                  </span>
                </span>
              </button>
            );
          })}
        </section>

        <section className="thread" aria-label="Conversation">
          {!thread ? (
            <div className="empty" style={{ margin: 'auto' }}>
              <p className="empty-body">
                Nothing to reply to. The bot is handling every chat right now.
              </p>
            </div>
          ) : (
            <>
              <div className="thread-head">
                <button
                  type="button"
                  className="btn btn-icon btn-ghost back-btn"
                  aria-label="Back to the waiting list"
                  onClick={() => setOpenId(null)}
                >
                  <BackIcon />
                </button>
                <span className="avatar" aria-hidden="true">
                  {initials(who)}
                </span>
                <div className="who">
                  <b>{who}</b>
                  <span className="sm muted num">
                    {thread.contactNumber} · last heard from {formatDateTime(thread.lastInboundAt)}
                  </span>
                </div>
                <div className="acts">
                  {thread.state === 'HUMAN_HANDOFF' && canReply ? (
                    <button type="button" className="btn" onClick={handBack} disabled={busy}>
                      Hand back to the bot
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="thread-body">
                {thread.messages.map((message) => {
                  const inbound = message.direction === 'INBOUND';

                  /*
                   * The design gives the bot its own dashed bubble, and it
                   * should have one — staff need to know whether the last
                   * reply came from a colleague or from the machine. It is not
                   * rendered here because `whatsapp_messages` does not record
                   * who sent an outbound message; there is no field to read.
                   * Inventing the distinction from `templateKey` or `sendMode`
                   * would be a guess shown as fact, so every outbound message
                   * looks the same until the column exists.
                   */
                  return (
                    <div key={message.id} className={`msg ${inbound ? 'msg-in' : 'msg-out'}`}>
                      <div className="bubble">
                        {message.body ?? <em className="muted">(no text)</em>}
                      </div>
                      <span className="msg-meta num">
                        {formatDateTime(message.occurredAt)}
                        {!inbound && message.status ? ` · ${message.status.toLowerCase()}` : ''}
                      </span>
                    </div>
                  );
                })}

                {thread.state === 'HUMAN_HANDOFF' && thread.lastInboundAt ? (
                  <span className="sys-note" role="status">
                    <ClockIcon className="icon-sm" />
                    Asked for a person at {formatDateTime(thread.lastInboundAt)}
                  </span>
                ) : null}

                <div ref={bottom} />
              </div>

              {canReply ? (
                <form className="composer" onSubmit={reply}>
                  <div className="composer-row">
                    <label htmlFor="reply" className="sr-only">
                      Reply to {who} on WhatsApp
                    </label>
                    <textarea
                      id="reply"
                      className="textarea"
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      placeholder={
                        thread.canReply
                          ? `Reply to ${who} on WhatsApp…`
                          : 'WhatsApp will not accept a reply until this customer messages again'
                      }
                      rows={2}
                      maxLength={1000}
                      disabled={!thread.canReply || busy}
                    />
                    <button
                      type="submit"
                      className="btn btn-primary btn-lg"
                      disabled={!thread.canReply || busy || !draft.trim()}
                    >
                      <SendIcon />
                      Send
                    </button>
                  </div>

                  <span className="cap faint">
                    {thread.canReply
                      ? 'Sent on WhatsApp from your number. The bot stays paused until you hand back.'
                      : 'This customer last messaged more than 24 hours ago. WhatsApp only allows a pre-approved template after that, so they will need to message again before you can reply here.'}
                  </span>
                </form>
              ) : null}
            </>
          )}
        </section>
      </div>
    </>
  );
}
