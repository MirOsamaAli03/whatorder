'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiUrl } from './api-client';
import type { KdsSnapshot, RealtimeEvent } from './types';

/** Two missed heartbeats means the stream is dead even if the socket is open. */
const STALE_AFTER_MS = 35_000;
/** Reconciliation poll, the safety net beneath the stream. */
const RECONCILE_MS = 30_000;

export type StreamHealth = 'connecting' | 'live' | 'stale' | 'down';

export interface KdsStreamState {
  snapshot: KdsSnapshot | null;
  health: StreamHealth;
  error: string | null;
  /** Increments whenever a new order arrives, for the audible alert. */
  newOrderSignal: number;
  refresh: () => Promise<void>;
}

/**
 * Drives a kitchen screen (plan §2.8).
 *
 * A socket-only screen is *worse* than a polling one, because a silently dead
 * connection loses orders invisibly. So this hook treats the snapshot as the
 * source of truth and the stream as an optimisation on top:
 *
 *   1. Load a snapshot; it carries the server's current sequence.
 *   2. Apply live events, each carrying its own sequence.
 *   3. Reload whenever anything looks wrong — a sequence gap, a dropped
 *      connection, or no heartbeat for two intervals.
 *   4. Reconcile on a slow timer regardless, so even a stream that is broken in
 *      a way nobody anticipated cannot leave the screen stale for long.
 *
 * The sequence check is what makes step 3 reliable: an event numbered further
 * ahead than expected proves events were missed, which a socket that merely
 * *looks* connected would never reveal.
 */
export function useKdsStream(branchId: string | null): KdsStreamState {
  const [snapshot, setSnapshot] = useState<KdsSnapshot | null>(null);
  const [health, setHealth] = useState<StreamHealth>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [newOrderSignal, setNewOrderSignal] = useState(0);

  const sourceRef = useRef<EventSource | null>(null);
  const lastSequenceRef = useRef<bigint>(0n);
  const lastMessageRef = useRef<number>(Date.now());
  const knownOrderIdsRef = useRef<Set<string>>(new Set());

  const loadSnapshot = useCallback(async () => {
    if (!branchId) return;

    try {
      const next = await api<KdsSnapshot>(`/kds/branches/${branchId}/snapshot`);

      const ids = new Set(
        Object.values(next.columns)
          .flat()
          .map((card) => card.id),
      );

      // Only signal for orders this screen has genuinely not seen, so a
      // reconnect does not set off the alert for everything on the board.
      const isFirstLoad = knownOrderIdsRef.current.size === 0;
      const arrivals = [...ids].filter((id) => !knownOrderIdsRef.current.has(id));
      knownOrderIdsRef.current = ids;

      if (!isFirstLoad && arrivals.length > 0) {
        setNewOrderSignal((value) => value + 1);
      }

      lastSequenceRef.current = BigInt(next.sequence);
      setSnapshot(next);
      setError(null);
    } catch {
      setError('Could not load the kitchen screen');
    }
  }, [branchId]);

  // --- the live stream ------------------------------------------------------
  useEffect(() => {
    if (!branchId) return;

    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    async function connect() {
      if (cancelled) return;

      try {
        // EventSource cannot send an Authorization header, so the stream is
        // opened with a single-use ticket rather than the access token. See
        // StreamTicketService on the API side.
        const { ticket } = await api<{ ticket: string; expiresIn: number }>(
          `/kds/branches/${branchId}/ticket`,
          { method: 'POST', body: {} },
        );
        if (cancelled) return;

        const source = new EventSource(
          `${apiUrl()}/api/v1/kds/stream?ticket=${encodeURIComponent(ticket)}`,
        );
        sourceRef.current = source;

        source.addEventListener('connected', () => {
          if (cancelled) return;
          attempt = 0;
          lastMessageRef.current = Date.now();
          setHealth('live');
          // Always resync on (re)connect: whatever happened while the stream
          // was down is exactly what this screen does not know about.
          void loadSnapshot();
        });

        source.addEventListener('event', (message) => {
          if (cancelled) return;
          lastMessageRef.current = Date.now();
          setHealth('live');

          const event = JSON.parse((message as MessageEvent<string>).data) as RealtimeEvent;
          const sequence = BigInt(event.sequence);

          // A jump of more than one means events were missed. Refetching is
          // cheaper and cannot be wrong, so do not try to patch around it.
          if (sequence > lastSequenceRef.current + 1n) {
            void loadSnapshot();
            return;
          }

          lastSequenceRef.current = sequence;
          void loadSnapshot();
        });

        source.onerror = () => {
          if (cancelled) return;
          setHealth('down');
          source.close();
          sourceRef.current = null;

          // Exponential backoff, capped, so a restarting API is not hammered
          // by every screen in the building at once.
          attempt += 1;
          const delay = Math.min(1000 * 2 ** Math.min(attempt, 5), 30_000);
          reconnectTimer = setTimeout(() => void connect(), delay);
        };
      } catch {
        if (cancelled) return;
        setHealth('down');
        attempt += 1;
        const delay = Math.min(1000 * 2 ** Math.min(attempt, 5), 30_000);
        reconnectTimer = setTimeout(() => void connect(), delay);
      }
    }

    void loadSnapshot();
    void connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [branchId, loadSnapshot]);

  // --- staleness watch ------------------------------------------------------
  useEffect(() => {
    const timer = setInterval(() => {
      const silent = Date.now() - lastMessageRef.current;
      // The socket can look perfectly healthy while nothing is arriving. Only
      // the absence of heartbeats reveals it.
      setHealth((current) => {
        if (current === 'down') return current;
        return silent > STALE_AFTER_MS ? 'stale' : current;
      });
    }, 5_000);

    return () => clearInterval(timer);
  }, []);

  // --- reconciliation poll --------------------------------------------------
  useEffect(() => {
    const timer = setInterval(() => void loadSnapshot(), RECONCILE_MS);
    return () => clearInterval(timer);
  }, [loadSnapshot]);

  return { snapshot, health, error, newOrderSignal, refresh: loadSnapshot };
}
