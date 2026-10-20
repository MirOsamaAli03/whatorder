'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ChevronDownIcon } from '@/components/icons';
import { api } from './api-client';
import type { Branch } from './types';

interface BranchState {
  branches: Branch[];
  selected: Branch | null;
  selectBranch: (branchId: string) => void;
  loading: boolean;
  error: string | null;
}

const BranchContext = createContext<BranchState | null>(null);

const STORAGE_KEY = 'restaurant-os:branch';

/**
 * The branch the user is currently looking at.
 *
 * `GET /branches` already returns only the branches this user may act on — a
 * branch-scoped cashier receives exactly one — so there is nothing to filter
 * here. The selection is remembered per browser as a convenience; it is never
 * treated as authority, because every request is re-checked server-side against
 * the session (spec §7).
 */
export function BranchProvider({ children }: { children: ReactNode }) {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const list = await api<Branch[]>('/branches');
        if (cancelled) return;

        setBranches(list);

        const remembered =
          typeof window === 'undefined' ? null : window.localStorage.getItem(STORAGE_KEY);

        // A remembered branch the user can no longer access falls back to the
        // first one they can, rather than leaving the page stuck on a 403.
        const usable = list.find((branch) => branch.id === remembered) ?? list[0] ?? null;
        setSelectedId(usable?.id ?? null);
      } catch {
        if (!cancelled) setError('Could not load branches');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const selectBranch = useCallback((branchId: string) => {
    setSelectedId(branchId);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, branchId);
    }
  }, []);

  const value = useMemo<BranchState>(
    () => ({
      branches,
      selected: branches.find((branch) => branch.id === selectedId) ?? null,
      selectBranch,
      loading,
      error,
    }),
    [branches, selectedId, selectBranch, loading, error],
  );

  return <BranchContext.Provider value={value}>{children}</BranchContext.Provider>;
}

export function useBranches(): BranchState {
  const context = useContext(BranchContext);
  if (!context) {
    throw new Error('useBranches must be used inside a BranchProvider');
  }
  return context;
}

/** A branch picker, hidden when there is only one to choose from. */
/**
 * The branch switcher, label and all.
 *
 * It owns its own label rather than letting each page supply one. That is what
 * went wrong before: pages put a bare "Branch" next to the control in a flex
 * row, and on three screens it ended up visually clipped against the dropdown.
 * Keeping the two together means the label is always attached to the thing it
 * names, and there is never a `for=` pointing at a control that was not
 * rendered.
 *
 * A restaurant with one branch gets a plain pill. Asking somebody to choose
 * between one option reads as a form that does not know what it is doing.
 */
export function BranchPicker({ id = 'branch-picker' }: { id?: string }) {
  const { branches, selected, selectBranch } = useBranches();

  if (branches.length <= 1) {
    return selected ? <span className="pill pill-outline">{selected.name}</span> : null;
  }

  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        Branch
      </label>
      <div className="select-wrap">
        <select
          id={id}
          className="select"
          value={selected?.id ?? ''}
          onChange={(event) => selectBranch(event.target.value)}
        >
          {branches.map((branch) => (
            <option key={branch.id} value={branch.id}>
              {branch.name}
            </option>
          ))}
        </select>
        <ChevronDownIcon />
      </div>
    </div>
  );
}
