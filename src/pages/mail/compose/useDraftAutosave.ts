// src/pages/mail/compose/useDraftAutosave.ts — keeps a composer draft on the
// server so a closed tab doesn't lose a half-written message.
//
// Design notes:
//  - The snapshot the hook is *mounted* with is never saved. Opening a reply
//    seeds recipients, a subject and a quote; treating that as a change would
//    litter the Drafts folder with a draft per opened reply.
//  - Saves are debounced and collapse: a burst of typing produces one write,
//    always of the latest state.
//  - The first successful save records a draft id and every later save updates
//    it in place, so the folder holds one row per composer, not one per pause.
import { useCallback, useEffect, useRef, useState } from 'react';
import { mailApi } from '../../../utils/mailApi';
import type { Addr } from '../types';

export const DRAFT_DEBOUNCE_MS = 3000;

export interface DraftSnapshot {
  to: Addr[];
  cc: Addr[];
  bcc: Addr[];
  subject: string;
  html: string;
}

export type DraftStatus = 'idle' | 'saving' | 'saved' | 'error';

export interface DraftAutosaveOptions {
  accountId: string | null;
  enabled: boolean;
  get: () => DraftSnapshot;
}

export interface DraftAutosaveState {
  draftId: string | null;
  status: DraftStatus;
  savedAt: Date | null;
  /** The snapshot has changed since the composer opened (and seeded) — i.e.
   *  there is something a navigation-away would discard. Reuses the same
   *  baseline autosave itself compares against, so "dirty" and "worth
   *  autosaving" never disagree. */
  dirty: boolean;
  discard: () => Promise<void>;
}

export function useDraftAutosave({ accountId, enabled, get }: DraftAutosaveOptions): DraftAutosaveState {
  const [draftId, setDraftId] = useState<string | null>(null);
  const [status, setStatus] = useState<DraftStatus>('idle');
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  // The snapshot is recomputed every render (the composer re-renders on every
  // keystroke); serialising it gives a cheap, stable change key for the effect.
  const snapshot = get();
  const serialized = JSON.stringify(snapshot);

  const latest = useRef(snapshot);
  latest.current = snapshot;

  const draftIdRef = useRef<string | null>(null);
  draftIdRef.current = draftId;

  // Baseline: whatever the composer opened with. Re-baselined whenever the
  // hook goes inactive so re-enabling it doesn't immediately save.
  const baseline = useRef<string | null>(null);
  const active = enabled && !!accountId;
  if (!active) baseline.current = null;
  else if (baseline.current === null) baseline.current = serialized;

  // Each composer session — and each mailbox within one — gets its own draft
  // row. Without this, closing a composer without sending and opening a new one
  // would autosave the new message on top of the old draft, and switching the
  // From account would PUT the previous account's draft id against the new one.
  useEffect(() => {
    if (!active) return;
    draftIdRef.current = null;
    setDraftId(null);
    setStatus('idle');
    setSavedAt(null);
  }, [active, accountId]);

  useEffect(() => {
    if (!active || !accountId) return;
    if (serialized === baseline.current) return;

    const t = setTimeout(() => {
      const body = { accountId, ...latest.current };
      setStatus('saving');
      mailApi.saveDraft(body, draftIdRef.current ?? undefined)
        .then(res => {
          if (res?.draftId) {
            draftIdRef.current = res.draftId;
            setDraftId(res.draftId);
          }
          setStatus('saved');
          setSavedAt(new Date());
        })
        // A failed autosave is not worth a toast — the user hasn't asked for
        // anything. The status line carries it, and the next edit retries.
        .catch(() => setStatus('error'));
    }, DRAFT_DEBOUNCE_MS);

    // Also the unmount path: a composer closed mid-debounce writes nothing.
    return () => clearTimeout(t);
  }, [serialized, active, accountId]);

  const discard = useCallback(async () => {
    const id = draftIdRef.current;
    draftIdRef.current = null;
    setDraftId(null);
    setStatus('idle');
    setSavedAt(null);
    if (!id || !accountId) return;
    try {
      await mailApi.deleteDraft(accountId, id);
    } catch {
      // The message it was backing has already been sent (or abandoned) — a
      // stray draft row is not worth interrupting the user for.
    }
  }, [accountId]);

  return { draftId, status, savedAt, dirty: active && serialized !== baseline.current, discard };
}
