import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { Workbook } from '@fortune-sheet/react';
import type { WorkbookInstance } from '@fortune-sheet/react';
import type { Sheet as FortuneSheet, Op, Selection, Presence } from '@fortune-sheet/core';
import '@fortune-sheet/react/dist/index.css';
import * as XLSX from 'xlsx';
import {
  FolderOpen, Save, Download, X, Plus, FileSpreadsheet, Loader2, History, Users, Info,
} from 'lucide-react';
import { getFileMeta, fetchFileBlob } from '../utils/store';
import { workbookToFortuneSheets, ensureSheetCelldata } from '../utils/sheetBridge';
import { useToast } from '../components/Toast';
import { useCollaboration } from '../context/CollaborationContext';
import { AddFilesButton } from '../components/documents/AddFilesButton';
import { CLIENT_SESSION_ID } from '../utils/clientSession';

// ── Types ─────────────────────────────────────────────────────────────────────

interface PrintoutSource {
  projectId: string;
  printoutId?: string;
  fileId: string;
}

interface FileTab {
  id: string;
  fileName: string;
  sheets: FortuneSheet[];
  source?: PrintoutSource;
}

// ── IDB helpers ───────────────────────────────────────────────────────────────
//
// IDB tab-persistence now covers ad-hoc (no-source) tabs ONLY (contract item
// 6). A fileId-backed tab's source of truth is the shared collab session —
// on reload it's re-hydrated via joinSheet, not restored from IDB — so it's
// deliberately excluded from what gets written/read here.

const IDB_NAME = 'frugal-spreadsheet-editor';
const IDB_VERSION = 2; // bumped from v1 (jspreadsheet) to avoid stale stores

const openIDB = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      // Clear old stores if upgrading from jspreadsheet schema
      for (const name of Array.from(db.objectStoreNames)) {
        db.deleteObjectStore(name);
      }
      db.createObjectStore('ss-tabs');
      db.createObjectStore('ss-state');
    };
    req.onsuccess = (e) => resolve((e.target as IDBOpenDBRequest).result);
    req.onerror = (e) => reject((e.target as IDBOpenDBRequest).error);
  });

const idbGet = <T,>(db: IDBDatabase, store: string, key: string): Promise<T | undefined> =>
  new Promise((res, rej) => {
    const r = db.transaction(store, 'readonly').objectStore(store).get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });

const idbPut = (db: IDBDatabase, store: string, key: string, value: unknown): Promise<void> =>
  new Promise((res, rej) => {
    const r = db.transaction(store, 'readwrite').objectStore(store).put(value, key);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  });

const idbDel = (db: IDBDatabase, store: string, key: string): Promise<void> =>
  new Promise((res, rej) => {
    const r = db.transaction(store, 'readwrite').objectStore(store).delete(key);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  });

// ── Import / export helpers ──────────────────────────────────────────────────
//
// xlsx reading goes through the fidelity bridge (workbookToFortuneSheets,
// ExcelJS-backed — see sheetBridge.ts) instead of SheetJS now — contract item
// 1. csv is explicitly out of collab scope and stays values-only; SheetJS is
// kept around for it (simplest option per the brief) and for the export/
// download path below, which is unchanged from before this rebuild.

const XLS_READONLY_MESSAGE = 'Legacy .xls — open in Excel and save as .xlsx to edit here';

const isLegacyXls = (name: string, mime?: string): boolean => {
  const lower = name.toLowerCase();
  if (lower.endsWith('.xlsx')) return false;
  if (lower.endsWith('.xls')) return true;
  return mime === 'application/vnd.ms-excel';
};

// Values-only CSV import (no formulas/styles — CSV never carries either).
const csvToFortuneSheets = (text: string, fileName: string): FortuneSheet[] => {
  const wb = XLSX.read(text, { type: 'string' });
  const wsName = wb.SheetNames[0];
  const ws = wb.Sheets[wsName];
  const celldata: FortuneSheet['celldata'] = [];

  for (const ref in ws) {
    if (ref[0] === '!') continue;
    const addr = XLSX.utils.decode_cell(ref);
    const cell = ws[ref] as XLSX.CellObject;
    if (cell.v == null) continue;
    celldata.push({
      r: addr.r,
      c: addr.c,
      v: { v: cell.v as string | number | boolean, m: String(cell.w ?? cell.v ?? '') },
    });
  }

  const sheetName = fileName.replace(/\.csv$/i, '') || 'Sheet1';
  return [{ name: sheetName, id: 'sheet_0_csv', status: 1, order: 0, celldata } as FortuneSheet];
};

const fortuneSheetsToXlsxBytes = (sheets: FortuneSheet[]): Uint8Array => {
  const wb = XLSX.utils.book_new();

  for (const sheet of sheets) {
    const ws: XLSX.WorkSheet = {};
    let maxR = 0;
    let maxC = 0;
    let hasData = false;

    for (const cell of sheet.celldata ?? []) {
      const { r, c, v } = cell;
      if (!v || (v.v == null && !v.f)) continue;
      const cellRef = XLSX.utils.encode_cell({ r, c });
      const value = v.v;
      ws[cellRef] = {
        v: value as XLSX.CellObject['v'],
        t: typeof value === 'number' ? 'n' : typeof value === 'boolean' ? 'b' : 's',
      };
      if (v.f) ws[cellRef].f = v.f.startsWith('=') ? v.f.slice(1) : v.f;
      maxR = Math.max(maxR, r);
      maxC = Math.max(maxC, c);
      hasData = true;
    }

    ws['!ref'] = hasData
      ? XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } })
      : 'A1';
    XLSX.utils.book_append_sheet(wb, ws, sheet.name);
  }

  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as Uint8Array;
};

const downloadFile = (bytes: Uint8Array, name: string) => {
  const blob = new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
};

const uid = () => Math.random().toString(36).slice(2, 10);

// ── SpreadsheetEditor ─────────────────────────────────────────────────────────

export const SpreadsheetEditor: React.FC = () => {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { toast } = useToast();
  const {
    socket, sessions, mySessionId,
    joinSheet, sendSheetOp, sendSheetState, requestSheetSnapshot, sendSheetPresence, onSheetEvent,
  } = useCollaboration();

  const [tabs, setTabs] = useState<FileTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  // FortuneSheet's current sheet data — updated via onChange on every edit
  const [currentSheets, setCurrentSheets] = useState<FortuneSheet[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [snapshotting, setSnapshotting] = useState(false);
  const [importWarning, setImportWarning] = useState<string | null>(null);

  // Collab session status for the currently active fileId tab (item 5's
  // autosave chip + item 7's participant count read these).
  const [collabJoining, setCollabJoining] = useState(false);
  const [collabLive, setCollabLive] = useState(false);
  // I5: flipped by the flush engine's failed/recovered broadcast for this
  // fileId (see the 'flush-status' branch below) — surfaces autosave
  // failures that were previously console-only on the server.
  const [autosaveFailing, setAutosaveFailing] = useState(false);
  // Bumped on every successful (re)join for a fileId tab. Folded into the
  // Workbook's `key` below so a rehydrate — including a reconnect-triggered
  // one, where `activeTab.id` alone doesn't change — always forces a fresh
  // mount. Required because FortuneSheet only seeds its internal document
  // from the `data` prop while that internal state is still empty (see the
  // applyOp-echo/tab-switch finding in the report); an already-mounted
  // instance silently ignores a new `data` prop, so setting `currentSheets`
  // alone on a live reconnect would leave the visible document stale while
  // the journal-tail replay landed on top of it — non-idempotent for
  // structural ops (row/col insert/delete, sheet add/remove).
  const [hydrationEpoch, setHydrationEpoch] = useState(0);

  const idbRef = useRef<IDBDatabase | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const workbookRef = useRef<WorkbookInstance | null>(null);

  // Stable refs for use inside callbacks without stale closure issues
  const tabsRef = useRef<FileTab[]>([]);
  const activeTabIdRef = useRef<string | null>(null);
  const currentSheetsRef = useRef<FortuneSheet[]>([]);

  useEffect(() => { tabsRef.current = tabs; }, [tabs]);
  useEffect(() => { activeTabIdRef.current = activeTabId; }, [activeTabId]);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  // Invariant: a tab only ever carries `source` for an xlsx file (csv/xls
  // never reach addTabFromSheets with one — see openFile below), so this is
  // a safe proxy for "this tab has a live collab session".
  const collabFileId = activeTab?.source?.fileId;

  // ── Collab: applyOp-echo guard ────────────────────────────────────────────
  //
  // VERIFIED FINDING (contract item 4): calling the Workbook ref's applyOp
  // DOES re-fire onOp. Traced through node_modules/@fortune-sheet/react/dist/
  // index.esm.js:
  //   - generateAPIs's `applyOp` (line ~9767) calls the `setContext` it was
  //     given with a plain recipe function, no `options` argument.
  //   - The Workbook component passes `setContextWithProduce` as that
  //     `setContext` (generateAPIs call site, line ~11252) — the SAME
  //     wrapper local edits go through.
  //   - `setContextWithProduce` (line ~10940) calls `emitOp(result,
  //     filteredPatches, options)` (line ~10992) whenever
  //     `patches.length > 0 && !options.noHistory` — and since applyOp's call
  //     passes no options, `noHistory` is always falsy, so emitOp always
  //     fires when applyOp actually mutates the document.
  //   - `emitOp` (line ~10884) calls `onOp(patchToOp(...))` directly.
  // So every ref.applyOp() call for a REMOTE op would normally re-emit onOp
  // and get re-sent to the server as if it were a local edit — an echo loop.
  // Guarded here: `applyingRemoteRef` is set around every ref.applyOp() call
  // (both the initial journal-tail replay and live foreign-op application),
  // and the onOp handler below (`handleOp`) no-ops while it's true.
  //
  // Separately, `onChange` fires from a plain `useEffect` on
  // `context.luckysheetfile` (line ~11076) — unconditional, NOT gated by
  // onOp/emitOp at all — so applying a remote op also fires onChange. That
  // one isn't a problem: `localDirtyRef` (set only inside `handleOp`, which
  // itself no-ops during remote application) is what onChange's debounced
  // sync checks before deciding to sendSheetState, so a remote-driven
  // onChange correctly results in no re-broadcast.
  const applyingRemoteRef = useRef(false);

  // Ops received via `sheet-join`'s journal tail (contract item 2) can't be
  // applied until the Workbook ref for the freshly-hydrated tab exists, which
  // only happens after the mount this data triggers commits. Queued here and
  // flushed by the effect below, which depends on `currentSheets` — the same
  // state update that causes the mount/update in the first place.
  const pendingTailOpsRef = useRef<Op[][]>([]);
  useEffect(() => {
    if (!pendingTailOpsRef.current.length) return;
    const wb = workbookRef.current;
    if (!wb) return;
    const batches = pendingTailOpsRef.current;
    pendingTailOpsRef.current = [];
    applyingRemoteRef.current = true;
    try {
      for (const batch of batches) wb.applyOp(batch);
    } finally {
      applyingRemoteRef.current = false;
    }
  }, [currentSheets]);

  // Send-side collab bookkeeping.
  const localDirtyRef = useRef(false); // set by handleOp, cleared once sendSheetState succeeds
  const stateSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const opSendQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const lastOpErrorToastRef = useRef(0);
  const joinAbortRef = useRef<string | null>(null);

  // Presence bookkeeping (item 7) — kept in refs, not state: presence
  // updates are frequent and purely imperative (pushed straight to the
  // Workbook ref via addPresences/removePresences), so there's no need to
  // re-render this component for them.
  const presencesRef = useRef<Map<string, Presence>>(new Map());
  const prevPresentSessionIdsRef = useRef<Set<string>>(new Set());

  // ── IDB persistence (ad-hoc tabs only) ────────────────────────────────────

  const saveStateToIDB = useCallback(async () => {
    const db = idbRef.current;
    if (!db) return;

    const currentId = activeTabIdRef.current;
    // Flush live FortuneSheet data into the active tab
    let allTabs = tabsRef.current;
    if (currentId) {
      allTabs = allTabs.map((t) =>
        t.id === currentId ? { ...t, sheets: currentSheetsRef.current } : t,
      );
    }

    // fileId-backed tabs are excluded — their source of truth is the shared
    // collab session, re-hydrated via joinSheet on reload (contract item 6).
    const adhoc = allTabs.filter((t) => !t.source);

    await idbPut(db, 'ss-state', 'current', {
      activeTabId: adhoc.some((t) => t.id === currentId) ? currentId : null,
      tabOrder: adhoc.map((t) => t.id),
    });
    for (const tab of adhoc) {
      await idbPut(db, 'ss-tabs', tab.id, tab);
    }
  }, []);

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveStateToIDB();
    }, 1500);
  }, [saveStateToIDB]);

  // ── FortuneSheet onChange / onOp ───────────────────────────────────────────

  const handleChange = useCallback(
    (data: FortuneSheet[]) => {
      setCurrentSheets(data);
      currentSheetsRef.current = data;
      scheduleSave(); // no-op for fileId tabs (saveStateToIDB filters them out)

      const tab = tabsRef.current.find((t) => t.id === activeTabIdRef.current);
      const fileId = tab?.source?.fileId;
      if (!fileId) return;

      // Debounced authoritative state sync (contract item 3). Receivers'
      // own applyOp also fires this same onChange (see the applyOp-echo
      // note above), so this only actually sends when a LOCAL op set the
      // dirty flag since the last successful sync.
      if (stateSyncTimerRef.current) clearTimeout(stateSyncTimerRef.current);
      stateSyncTimerRef.current = setTimeout(() => {
        stateSyncTimerRef.current = null;
        if (!localDirtyRef.current) return;
        // I2 fix: localDirtyRef is cleared ONLY on ack success now (was
        // cleared unconditionally before the send). An offline/failed send
        // used to still clear it, so any transport blip lasting >2s (this
        // timer's own debounce) made `handleReconnect` below see dirty=false
        // and take the `runJoin` path — whose hydrationEpoch remount visibly
        // replaced these unsent local edits with stale server state.
        sendSheetState(fileId, JSON.stringify(currentSheetsRef.current)).then((res) => {
          if ('error' in res) {
            if (res.error !== 'offline') {
              toast('Sync issue — changes may not be saved to the shared session', { type: 'warning' });
            }
            return; // leave localDirtyRef set — handleReconnect will push it authoritatively
          }
          localDirtyRef.current = false;
        }).catch(() => {});
      }, 2000);
    },
    [scheduleSave, sendSheetState, toast],
  );

  const handleOp = useCallback(
    (ops: Op[]) => {
      if (applyingRemoteRef.current) return; // our own remote-op replay — not a local edit
      const tab = tabsRef.current.find((t) => t.id === activeTabIdRef.current);
      const fileId = tab?.source?.fileId;
      if (!fileId) return; // ad-hoc tab — no collab op to send

      localDirtyRef.current = true;
      const opsJson = JSON.stringify(ops);
      // Chained onto the running queue so ops are sent (and acked) strictly
      // in order even if several batches fire in quick succession (contract
      // item 3).
      opSendQueueRef.current = opSendQueueRef.current
        .then(() => sendSheetOp(fileId, opsJson))
        .then((res) => {
          if ('error' in res && res.error !== 'offline') {
            const now = Date.now();
            if (now - lastOpErrorToastRef.current > 10_000) {
              lastOpErrorToastRef.current = now;
              toast('Live sync issue — your edits may not reach other viewers', { type: 'warning' });
            }
          }
        })
        .catch(() => {});
    },
    [sendSheetOp, toast],
  );

  // ── Collab: cell presence (contract item 7) ───────────────────────────────

  const lastPresenceSentRef = useRef(0);
  const presenceThrottleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSelectionChange = useCallback(
    (sheetId: string, selection: Selection) => {
      const tab = tabsRef.current.find((t) => t.id === activeTabIdRef.current);
      const fileId = tab?.source?.fileId;
      if (!fileId) return;

      const r = selection.row_focus ?? selection.row[0] ?? 0;
      const c = selection.column_focus ?? selection.column[0] ?? 0;
      const send = () => {
        lastPresenceSentRef.current = Date.now();
        sendSheetPresence(fileId, { sheetId, r, c });
      };

      const elapsed = Date.now() - lastPresenceSentRef.current;
      if (elapsed >= 200) {
        send();
      } else {
        if (presenceThrottleTimerRef.current) clearTimeout(presenceThrottleTimerRef.current);
        presenceThrottleTimerRef.current = setTimeout(send, 200 - elapsed);
      }
    },
    [sendSheetPresence],
  );

  // ── Collab: session join / live ops / presence relay ─────────────────────
  //
  // NOTE (contract item 8): no useCollabEditing banner here on purpose — that
  // hook/banner exists for editors with no other live-presence UI. Sheets
  // already surface a live participant count via the autosave chip below, so
  // a second "so-and-so is also editing" banner would be redundant.
  useEffect(() => {
    const fileId = collabFileId;

    if (!fileId) {
      setCollabJoining(false);
      setCollabLive(false);
      return undefined;
    }

    let cancelled = false;
    joinAbortRef.current = fileId;
    setCollabJoining(true);
    setCollabLive(false);
    setAutosaveFailing(false);

    const applyForeignOp = (opsJson: string) => {
      let ops: Op[];
      try {
        ops = JSON.parse(opsJson) as Op[];
      } catch {
        return; // malformed — nothing to apply or queue
      }
      // I3 fix: during the join-ack->mount window and every hydrationEpoch
      // remount, workbookRef is briefly null — a foreign op arriving in that
      // window used to be silently dropped here. The sender still shows it
      // locally, but this receiver's NEXT debounced state-sync folds the
      // journal and becomes authoritative — erasing the dropped op from
      // server state and then from disk. Queuing into pendingTailOpsRef
      // (the same mechanism the join's own journal-tail replay uses) lets
      // the effect below apply it as soon as the Workbook ref exists.
      if (!workbookRef.current) {
        pendingTailOpsRef.current.push(ops);
        return;
      }
      applyingRemoteRef.current = true;
      try {
        workbookRef.current.applyOp(ops);
      } finally {
        applyingRemoteRef.current = false;
      }
    };

    const unsubscribe = onSheetEvent((ev) => {
      if (cancelled || ev.fileId !== fileId) return;
      if (ev.kind === 'flush-status') {
        setAutosaveFailing(ev.status === 'failed');
        return;
      }
      if (ev.kind === 'presence') {
        if (ev.sessionId === mySessionId) return; // defensive; server already excludes the sender
        presencesRef.current.set(ev.sessionId, {
          sheetId: ev.presence.sheetId,
          username: ev.name,
          // Repurposes Presence.userId to carry the socket sessionId (not
          // the app's authenticated user id) so each of a person's sessions
          // — e.g. two open tabs — gets its own independently removable
          // presence marker rather than colliding on one shared identity.
          userId: ev.sessionId,
          color: ev.color,
          selection: { r: ev.presence.r, c: ev.presence.c },
        });
        // Rebuild-array approach per the brief: simplest correct way to keep
        // FortuneSheet's presence overlay in sync without diffing ourselves.
        workbookRef.current?.addPresences(Array.from(presencesRef.current.values()));
        return;
      }
      if (ev.bySessionId === CLIENT_SESSION_ID) return; // defensive; socket.to() already excludes us
      applyForeignOp(ev.ops);
    });

    const runJoin = async () => {
      const seed = currentSheetsRef.current;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (cancelled) return;
        const res = await joinSheet(fileId);
        if (cancelled || joinAbortRef.current !== fileId) return;

        // `'error' in res` (not `if (res.ok)`) — this project builds without
        // strictNullChecks, under which plain truthiness narrowing on a
        // boolean-literal discriminant silently fails to narrow the other
        // branch (see the identical convention/comment in CanvasView.tsx).
        if ('error' in res) {
          if (res.error === 'not_in_sheet' && attempt < 3) {
            // Room membership ('set-location', owned by CollaborationContext)
            // and this join can race on first mount / fast tab-switch — a
            // child component's effects can commit before an ancestor
            // provider's updated effect re-emits 'set-location' for the new
            // route. Short retry with backoff rather than surfacing a
            // spurious error for what's usually resolved within one tick.
            await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
            continue;
          }

          setCollabJoining(false);
          setCollabLive(false);
          if (res.error !== 'offline') {
            toast('Could not start the live editing session — showing the last opened copy', { type: 'warning' });
          }
          return;
        }

        let sheets: FortuneSheet[];
        if (res.state != null) {
          try {
            sheets = JSON.parse(res.state) as FortuneSheet[];
          } catch {
            sheets = seed;
          }
        } else {
          // First writer — no one has ever synced state for this file yet.
          // Seed it from what's already imported/shown for this tab. Awaited
          // (with one retry) rather than fire-and-forget: if this silently
          // never reaches the server, every other joiner keeps seeing
          // state:null and re-seeds independently from their OWN possibly-
          // different copy — exactly the divergence this seed exists to
          // prevent. Doesn't block hydration on a second failure — we still
          // render locally, just warn that the shared session may be stale.
          sheets = seed;
          const seedJson = JSON.stringify(sheets);
          let seedRes = await sendSheetState(fileId, seedJson);
          if (cancelled || joinAbortRef.current !== fileId) return;
          if ('error' in seedRes) {
            seedRes = await sendSheetState(fileId, seedJson);
            if (cancelled || joinAbortRef.current !== fileId) return;
          }
          if ('error' in seedRes) {
            toast('Live collaboration may be out of sync — edits still save to this tab', { type: 'warning' });
          }
        }
        pendingTailOpsRef.current = res.ops.map((s) => {
          try { return JSON.parse(s) as Op[]; } catch { return []; }
        });
        // A rejoin's `res.state` may be `data`-shaped (a prior live edit's
        // onChange payload, round-tripped through the server as opaque
        // JSON) — FortuneSheet's own fresh-mount import only trusts
        // `celldata` and silently blanks a sheet that lacks it (see
        // ensureSheetCelldata's comment). Cheap no-op for the celldata-
        // shaped `seed` branch above.
        sheets = sheets.map(ensureSheetCelldata);
        currentSheetsRef.current = sheets;
        setCurrentSheets(sheets);
        // Always a fresh mount on a successful (re)join — see the
        // hydrationEpoch declaration for why this must not be skipped even
        // when `activeTab.id` itself hasn't changed (the reconnect path).
        setHydrationEpoch((e) => e + 1);
        setCollabLive(true);
        setCollabJoining(false);
        return;
      }
    };

    void runJoin();

    // Mirrors the CanvasView precedent (joinCanvas re-called on reconnect) —
    // a dropped/restored socket needs to resync. If there's local work the
    // server never saw (sendSheetOp silently failing while offline), push it
    // as authoritative instead of pulling server state over it, which would
    // otherwise silently discard that work.
    const handleReconnect = () => {
      if (localDirtyRef.current) {
        sendSheetState(fileId, JSON.stringify(currentSheetsRef.current)).then(async (res) => {
          if ('error' in res) return; // still failing — stay dirty, the next reconnect retries
          localDirtyRef.current = false;
          if (cancelled || joinAbortRef.current !== fileId) return;
          // I8 fix: an authoritative push alone never calls store.join on the
          // server (only 'sheet-join' does), so this client's session
          // membership silently goes stale after ANY reconnect-while-dirty —
          // participants stay off by one, this session gets no version
          // archive on the next flush (needsSessionSnapshot stays keyed to
          // whoever last actually joined), no leave-flush when this client
          // eventually departs, and the chip is stuck showing "Offline" even
          // though ops keep relaying fine. Re-join to restore membership —
          // but deliberately discard its hydration payload (state/ops tail):
          // the state we just pushed IS authoritative here, so remounting
          // from the join response would be redundant and could visibly
          // flicker/regress a newer local edit made during the push.
          const joinRes = await joinSheet(fileId);
          if (cancelled || joinAbortRef.current !== fileId) return;
          if ('error' in joinRes) {
            setCollabLive(false);
            return;
          }
          setCollabLive(true);
          setCollabJoining(false);
        }).catch(() => {});
        return;
      }
      void runJoin();
    };
    const handleDisconnect = () => setCollabLive(false);
    socket?.on('connect', handleReconnect);
    socket?.on('disconnect', handleDisconnect);

    return () => {
      cancelled = true;
      joinAbortRef.current = null;
      unsubscribe();
      socket?.off('connect', handleReconnect);
      socket?.off('disconnect', handleDisconnect);
      presencesRef.current = new Map();
      prevPresentSessionIdsRef.current = new Set();
      if (stateSyncTimerRef.current) { clearTimeout(stateSyncTimerRef.current); stateSyncTimerRef.current = null; }
      if (localDirtyRef.current) {
        localDirtyRef.current = false;
        sendSheetState(fileId, JSON.stringify(currentSheetsRef.current)).catch(() => {});
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collabFileId]);

  // Presence removal on session departure (contract item 7) — watches the
  // shared sessions list for anyone who WAS present on this file and no
  // longer is (navigated away, disconnected, etc).
  useEffect(() => {
    const fileId = collabFileId;
    if (!fileId) return;
    const currentIds = new Set(
      sessions.filter((s) => s.location?.fileId === fileId).map((s) => s.sessionId),
    );
    const departed = [...prevPresentSessionIdsRef.current].filter((id) => !currentIds.has(id));
    for (const id of departed) {
      const p = presencesRef.current.get(id);
      if (p) {
        presencesRef.current.delete(id);
        workbookRef.current?.removePresences([{ username: p.username, userId: p.userId }]);
      }
    }
    prevPresentSessionIdsRef.current = currentIds;
  }, [sessions, collabFileId]);

  const participantCount = collabFileId
    ? sessions.filter((s) => s.location?.fileId === collabFileId).length
    : 0;

  // ── Open a file ───────────────────────────────────────────────────────────

  // Build a tab directly from FortuneSheet JSON (no re-parse) and make it
  // active. Shared by every import path below.
  const addTabFromSheets = useCallback(
    (fileName: string, sheets: FortuneSheet[], source?: PrintoutSource) => {
      const tabId = uid();
      const newTab: FileTab = { id: tabId, fileName, sheets, source };

      const updated = [...tabsRef.current, newTab];
      setTabs(updated);
      tabsRef.current = updated;
      setActiveTabId(tabId);
      activeTabIdRef.current = tabId;
      setCurrentSheets(sheets);
      currentSheetsRef.current = sheets;
      scheduleSave();
    },
    [scheduleSave],
  );

  const openFile = useCallback(
    async (file: File, source?: PrintoutSource) => {
      if (isLegacyXls(file.name, file.type)) {
        toast(XLS_READONLY_MESSAGE, { type: 'warning' });
        return;
      }
      setLoading(true);
      try {
        if (file.name.toLowerCase().endsWith('.csv')) {
          const text = await file.text();
          const sheets = csvToFortuneSheets(text, file.name);
          addTabFromSheets(file.name, sheets, undefined); // csv is out of collab scope — never carries a source
          return;
        }
        const buf = await file.arrayBuffer();
        const { sheets, warnings } = await workbookToFortuneSheets(buf);
        if (!sheets.length) throw new Error('No sheets found');
        // M1: mentions rich text/hyperlinks alongside charts/images/
        // validation — all four are things the bridge preserves-or-flattens
        // without rendering, surfaced via the same warnings mechanism.
        if (warnings.length) {
          setImportWarning('Charts/images preserved but not shown. Rich text and hyperlinks are flattened to plain text.');
        }
        addTabFromSheets(file.name, sheets, source);
      } catch (err) {
        console.error('Failed to open file', err);
        toast('Failed to open file', { type: 'error' });
      } finally {
        setLoading(false);
      }
    },
    [addTabFromSheets, toast],
  );

  // Open a workbook that is already stored, by id. Shared by the ?fileId=
  // entry point and the toolbar's documents picker — the picker can't just
  // push a new ?fileId=, because the entry point below only runs on mount.
  const openFileById = useCallback(
    async (fileId: string) => {
      try {
        const [meta, blob] = await Promise.all([
          getFileMeta(fileId),
          fetchFileBlob(fileId),
        ]);
        const base = meta?.name || `file-${fileId}`;
        if (isLegacyXls(base, meta?.mime)) {
          toast(XLS_READONLY_MESSAGE, { type: 'warning' });
          return;
        }
        const fname = base.toLowerCase().endsWith('.xlsx') ? base : `${base}.xlsx`;
        const src: PrintoutSource = { projectId: meta?.projectId ?? '', fileId };
        const f = new File([blob], fname, {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        });
        await openFile(f, src);
      } catch (e) {
        console.error('Failed to open file by id:', e);
        toast('Could not open the file', { type: 'error' });
      }
    },
    [openFile, toast],
  );

  // ── Auto-open + IDB restore on mount ──────────────────────────────────────

  useEffect(() => {
    const state = location.state as { file?: File; source?: PrintoutSource } | null;
    const incoming = state?.file;

    const init = async () => {
      const db = await openIDB();
      idbRef.current = db;

      // Load any existing tabs from IDB (ad-hoc only — see saveStateToIDB)
      const saved = await idbGet<{ activeTabId: string | null; tabOrder: string[] }>(
        db, 'ss-state', 'current',
      );
      const restoredTabs: FileTab[] = [];
      if (saved?.tabOrder.length) {
        for (const id of saved.tabOrder) {
          const tab = await idbGet<FileTab>(db, 'ss-tabs', id);
          if (tab) restoredTabs.push(tab);
        }
      }

      if (incoming instanceof File) {
        window.history.replaceState({}, '');
        if (restoredTabs.length) {
          setTabs(restoredTabs);
          tabsRef.current = restoredTabs;
        }
        await openFile(incoming, state?.source);
        return;
      }

      // Entry by file id (?fileId=) — Documents/Printouts open files by reference.
      const fileIdParam = searchParams.get('fileId');
      if (fileIdParam) {
        if (restoredTabs.length) {
          setTabs(restoredTabs);
          tabsRef.current = restoredTabs;
        }
        await openFileById(fileIdParam);
        return;
      }

      if (!restoredTabs.length) return;

      const active = restoredTabs.find((t) => t.id === saved?.activeTabId) ?? restoredTabs[0];
      setTabs(restoredTabs);
      tabsRef.current = restoredTabs;
      setActiveTabId(active.id);
      activeTabIdRef.current = active.id;
      // Same fresh-mount concern as switchTab/closeTab (see their comments):
      // an ad-hoc tab persisted to IDB while `data`-shaped (before this fix,
      // or from a tab that was never re-normalized) must not seed a blank
      // mount on the next app open.
      const activeSheets = active.sheets.map(ensureSheetCelldata);
      setCurrentSheets(activeSheets);
      currentSheetsRef.current = activeSheets;
    };

    init().catch(console.error);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Switch tab ────────────────────────────────────────────────────────────

  const switchTab = useCallback((tabId: string) => {
    if (tabId === activeTabIdRef.current) return;

    // Flush live data into the outgoing tab. Normalized here (not just on
    // load below) because this is the point where a `data`-shaped live
    // document — FortuneSheet's own onChange payload, see
    // ensureSheetCelldata's comment — first gets written into tab state:
    // fixing it here means every LATER read of this tab (another switch
    // back, a close-tab fallback, or an IDB restore next session) already
    // sees celldata-shaped sheets without needing to re-derive it.
    const outId = activeTabIdRef.current;
    if (outId) {
      const flushed = tabsRef.current.map((t) =>
        t.id === outId ? { ...t, sheets: currentSheetsRef.current.map(ensureSheetCelldata) } : t,
      );
      setTabs(flushed);
      tabsRef.current = flushed;
    }

    const target = tabsRef.current.find((t) => t.id === tabId);
    if (!target) return;

    // The Workbook remounts on every tab switch (its `key` includes
    // `activeTab.id`), so the incoming tab's sheets are about to become a
    // FRESH mount's seed — normalize here too as a second, independent
    // guard (e.g. a tab restored from IDB before this fix existed could
    // still be `data`-shaped on disk).
    const targetSheets = target.sheets.map(ensureSheetCelldata);
    setActiveTabId(tabId);
    activeTabIdRef.current = tabId;
    setCurrentSheets(targetSheets);
    currentSheetsRef.current = targetSheets;
    scheduleSave();
  }, [scheduleSave]);

  // ── Close tab ─────────────────────────────────────────────────────────────

  const closeTab = useCallback((tabId: string) => {
    const all = tabsRef.current;
    const remaining = all.filter((t) => t.id !== tabId);

    if (idbRef.current) idbDel(idbRef.current, 'ss-tabs', tabId).catch(() => {});

    if (!remaining.length) {
      setTabs([]);
      setActiveTabId(null);
      setCurrentSheets([]);
      tabsRef.current = [];
      activeTabIdRef.current = null;
      currentSheetsRef.current = [];
      if (idbRef.current) {
        idbPut(idbRef.current, 'ss-state', 'current', { activeTabId: null, tabOrder: [] }).catch(() => {});
      }
      return;
    }

    const wasActive = tabId === activeTabIdRef.current;
    const newActive = wasActive
      ? remaining[Math.min(all.findIndex((t) => t.id === tabId), remaining.length - 1)]
      : all.find((t) => t.id === activeTabIdRef.current)!;

    setTabs(remaining);
    tabsRef.current = remaining;

    if (wasActive) {
      // Same fresh-mount concern as switchTab's load side — see its comment.
      const newActiveSheets = newActive.sheets.map(ensureSheetCelldata);
      setActiveTabId(newActive.id);
      activeTabIdRef.current = newActive.id;
      setCurrentSheets(newActiveSheets);
      currentSheetsRef.current = newActiveSheets;
    }
    scheduleSave();
  }, [scheduleSave]);

  // ── Save (ad-hoc tabs only — fileId tabs use the autosave chip + Snapshot) ─

  const handleSave = async () => {
    if (!activeTab || activeTab.source) return;
    setSaving(true);
    try {
      const bytes = fortuneSheetsToXlsxBytes(currentSheetsRef.current);
      downloadFile(bytes, activeTab.fileName);
    } catch (err) {
      console.error('Save failed', err);
      toast('Save failed', { type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  // ── Save As ───────────────────────────────────────────────────────────────

  const handleSaveAs = async () => {
    if (!activeTab) return;
    setSaving(true);
    try {
      const bytes = fortuneSheetsToXlsxBytes(currentSheetsRef.current);
      const base = activeTab.fileName.replace(/\.(xlsx|xls|csv)$/i, '');
      downloadFile(bytes, `${base}_edited.xlsx`);
    } catch (err) {
      console.error('Save As failed', err);
      toast('Save As failed', { type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  // ── Snapshot version (fileId xlsx tabs — contract item 5) ─────────────────

  const handleSnapshot = async () => {
    if (!collabFileId) return;
    setSnapshotting(true);
    try {
      const res = await requestSheetSnapshot(collabFileId);
      if ('error' in res) {
        toast(
          res.error === 'offline' ? 'Offline — cannot save a version right now' : 'Snapshot failed',
          { type: 'warning' },
        );
      } else {
        toast('Version saved', { type: 'success' });
      }
    } finally {
      setSnapshotting(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  const btnBase =
    'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-40';

  return (
    <div className="h-screen flex flex-col bg-raised overflow-hidden">
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,.xls,.csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) openFile(f);
          e.target.value = '';
        }}
      />

      {/* ── Toolbar ── */}
      <div className="h-12 flex items-center gap-1 px-3 bg-raised border-b border-edge shrink-0 z-10">
        <button
          onClick={() => fileInputRef.current?.click()}
          className={`${btnBase} bg-sunken hover:bg-hover text-ink-soft`}
        >
          <FolderOpen size={16} /> Open
        </button>
        <AddFilesButton
          label="Open from documents"
          accept="spreadsheet"
          multi={false}
          size="sm"
          title="Open a workbook already filed under Documents"
          onPick={rows => { const r = rows[0]; if (r) void openFileById(r.id); }}
        />

        <div className="w-px h-6 bg-sunken mx-1" />

        {collabFileId ? (
          <>
            <span
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm ${
                collabLive && autosaveFailing
                  ? 'text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/30'
                  : 'text-ink-soft bg-sunken '
              }`}
            >
              {collabJoining ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Users size={14} />
              )}
              {collabJoining
                ? 'Connecting…'
                : collabLive && autosaveFailing
                  ? 'Autosave failing — changes held in session'
                  : `Autosaves to file · ${collabLive ? 'Live' : 'Offline'}${
                      collabLive && participantCount > 1 ? ` · ${participantCount} viewing` : ''
                    }`}
            </span>
            <button
              onClick={handleSnapshot}
              disabled={!collabLive || snapshotting}
              className={`${btnBase} bg-accent-600 text-white hover:bg-accent-700`}
            >
              {snapshotting ? <Loader2 size={16} className="animate-spin" /> : <History size={16} />}
              Snapshot version
            </button>
          </>
        ) : (
          <button
            onClick={handleSave}
            disabled={!activeTab || saving}
            className={`${btnBase} bg-accent-600 text-white hover:bg-accent-700`}
          >
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            Download
          </button>
        )}

        <button
          onClick={handleSaveAs}
          disabled={!activeTab || saving}
          className={`${btnBase} bg-raised border border-edge hover:bg-hover text-ink-soft`}
        >
          <Download size={16} /> Save As
        </button>

        {loading && (
          <span className="flex items-center gap-1.5 ml-3 text-sm text-ink-faint">
            <Loader2 size={15} className="animate-spin" /> Opening…
          </span>
        )}
      </div>

      {/* ── Import warning banner ── */}
      {importWarning && (
        <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-amber-50 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200 text-xs border-b border-amber-200 dark:border-amber-800 shrink-0">
          <span className="flex items-center gap-1.5"><Info size={13} /> {importWarning}</span>
          <button onClick={() => setImportWarning(null)} className="opacity-70 hover:opacity-100">
            <X size={12} />
          </button>
        </div>
      )}

      {/* ── File tabs ── */}
      {tabs.length > 0 && (
        <div className="flex items-center gap-1 px-3 py-1.5 bg-raised border-b border-edge overflow-x-auto shrink-0 z-10">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => switchTab(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-sm whitespace-nowrap transition-colors ${
                tab.id === activeTabId
                  ? 'bg-accent-600 text-white'
                  : 'bg-sunken text-ink-soft hover:bg-hover'
              }`}
            >
              <FileSpreadsheet size={13} className="shrink-0" />
              <span className="truncate max-w-[160px]">{tab.fileName}</span>
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); closeTab(tab.id); } }}
                className="ml-0.5 shrink-0 opacity-60 hover:opacity-100"
              >
                <X size={12} />
              </span>
            </button>
          ))}

          <button
            onClick={() => fileInputRef.current?.click()}
            title="Open another file"
            className="p-1.5 rounded-lg text-ink-faint hover:text-ink hover:bg-sunken shrink-0"
          >
            <Plus size={15} />
          </button>
        </div>
      )}

      {/* ── Spreadsheet or empty state ── */}
      <div className="flex-1 overflow-hidden relative">
        {collabFileId && collabJoining ? (
          <div className="h-full flex flex-col items-center justify-center gap-3 text-ink-faint">
            <Loader2 size={32} className="animate-spin" />
            <p className="text-sm">Joining live session…</p>
          </div>
        ) : currentSheets.length > 0 ? (
          <Workbook
            key={activeTab ? `${activeTab.id}:${hydrationEpoch}` : undefined}
            ref={workbookRef}
            data={currentSheets}
            onChange={handleChange}
            onOp={handleOp}
            hooks={{ afterSelectionChange: handleSelectionChange }}
            lang="en"
            showToolbar
            allowEdit
            showSheetTabs
          />
        ) : (
          <div className="h-full flex flex-col items-center justify-center gap-5 text-ink-faint">
            <FileSpreadsheet size={60} className="opacity-20" />
            <p className="text-lg font-medium">No file open</p>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2 px-5 py-2.5 bg-accent-600 text-white rounded-xl hover:bg-accent-700 text-sm font-medium shadow-sm"
            >
              <FolderOpen size={16} /> Open Spreadsheet
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
