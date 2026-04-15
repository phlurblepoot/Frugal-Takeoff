import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import * as XLSX from 'xlsx';
import jspreadsheet from 'jspreadsheet-ce';
import 'jspreadsheet-ce/dist/jspreadsheet.css';
import 'jsuites/dist/jsuites.css';
import {
  FolderOpen, Save, Download, X, Plus, FileSpreadsheet, Loader2,
} from 'lucide-react';
import { saveFile } from '../utils/store';
import { useToast } from '../components/Toast';

// ── Types ─────────────────────────────────────────────────────────────────────

interface PrintoutSource {
  projectId: string;
  printoutId: string;
  fileId: string;
}

interface SheetData {
  name: string;
  data: (string | number | boolean)[][];
}

interface TabSnapshot {
  id: string;
  fileName: string;
  sheets: SheetData[];
  source?: PrintoutSource;
}

// ── IDB helpers ───────────────────────────────────────────────────────────────

const IDB_NAME = 'frugal-spreadsheet-editor';
const IDB_VERSION = 1;

const openIDB = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      ['ss-tabs', 'ss-state'].forEach((s) => {
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
      });
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

// ── Conversion helpers ────────────────────────────────────────────────────────

const uid = () => Math.random().toString(36).slice(2, 10);

const xlsxBufToSheets = (buffer: ArrayBuffer): SheetData[] => {
  const wb = XLSX.read(new Uint8Array(buffer), { type: 'array' });
  return wb.SheetNames.map((name) => ({
    name,
    data: (XLSX.utils.sheet_to_json(wb.Sheets[name], {
      header: 1,
      defval: '',
    }) as (string | number | boolean)[][]),
  }));
};

const sheetsToXlsxBytes = (sheets: SheetData[]): Uint8Array => {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(s.data);
    XLSX.utils.book_append_sheet(wb, ws, s.name);
  }
  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as Uint8Array;
};

const bytesToDataUrl = (bytes: Uint8Array): string => {
  const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return `data:${mime};base64,${btoa(binary)}`;
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

// ── SpreadsheetEditor ─────────────────────────────────────────────────────────

export const SpreadsheetEditor: React.FC = () => {
  const location = useLocation();
  const { toast } = useToast();

  const [tabs, setTabs] = useState<TabSnapshot[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ssRef = useRef<any>(null);
  const idbRef = useRef<IDBDatabase | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Deferred init: stores sheets that need to be handed to jspreadsheet once the
  // container div is in the DOM (it is only rendered when tabs.length > 0).
  const pendingInitRef = useRef<SheetData[] | null>(null);

  // Stable refs so callbacks don't go stale
  const tabsRef = useRef<TabSnapshot[]>([]);
  const activeTabIdRef = useRef<string | null>(null);

  useEffect(() => { tabsRef.current = tabs; }, [tabs]);
  useEffect(() => { activeTabIdRef.current = activeTabId; }, [activeTabId]);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  // ── Deferred jspreadsheet init ─────────────────────────────────────────────
  // The container div is only rendered when tabs.length > 0, so we cannot call
  // initSpreadsheet synchronously inside openXlsx/switchTab (containerRef is null
  // at that point). Instead, store sheets in pendingInitRef and initialize here
  // after React has committed the new tabs to the DOM.
  useEffect(() => {
    if (pendingInitRef.current !== null && containerRef.current) {
      const toInit = pendingInitRef.current;
      pendingInitRef.current = null;
      initSpreadsheet(toInit);
    }
  // initSpreadsheet is stable (useCallback); activeTabId change triggers this after re-render
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId]);

  // ── Capture current jspreadsheet data ─────────────────────────────────────

  const captureCurrentSheets = useCallback((): SheetData[] | null => {
    if (!ssRef.current) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return ssRef.current.worksheets.map((ws: any, i: number) => ({
      name: (ws.options?.worksheetName as string | undefined) || `Sheet${i + 1}`,
      data: ws.getData() as (string | number | boolean)[][],
    }));
  }, []);

  // ── IDB: persist state ─────────────────────────────────────────────────────

  const saveStateToIDB = useCallback(async () => {
    const db = idbRef.current;
    if (!db) return;

    const currentTabId = activeTabIdRef.current;
    let allTabs = tabsRef.current;

    // Flush live jspreadsheet data into the active tab snapshot
    if (currentTabId && ssRef.current) {
      const live = captureCurrentSheets();
      if (live) {
        allTabs = allTabs.map((t) =>
          t.id === currentTabId ? { ...t, sheets: live } : t,
        );
      }
    }

    await idbPut(db, 'ss-state', 'current', {
      activeTabId: currentTabId,
      tabOrder: allTabs.map((t) => t.id),
    });

    for (const tab of allTabs) {
      await idbPut(db, 'ss-tabs', tab.id, tab);
    }
  }, [captureCurrentSheets]);

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => saveStateToIDB(), 1500);
  }, [saveStateToIDB]);

  // ── Init / destroy jspreadsheet ────────────────────────────────────────────

  const initSpreadsheet = useCallback(
    (sheets: SheetData[]) => {
      if (!containerRef.current) return;

      // Destroy any existing instance first
      if (ssRef.current) {
        try { jspreadsheet.destroy(containerRef.current as never); } catch { /* ignore */ }
        ssRef.current = null;
      }
      containerRef.current.innerHTML = '';

      if (!sheets.length) return;

      const ss = jspreadsheet(containerRef.current, {
        worksheets: sheets.map((s) => ({
          worksheetName: s.name,
          data: s.data as never,
          minDimensions: [
            Math.max(10, (s.data[0]?.length ?? 0) + 2),
            Math.max(30, s.data.length + 5),
          ],
          tableOverflow: true,
          tableHeight: 'calc(100vh - 96px)',
        })),
        onchange: () => scheduleSave(),
      });

      ssRef.current = ss;
    },
    [scheduleSave],
  );

  // ── Open a file ────────────────────────────────────────────────────────────

  const openXlsx = useCallback(
    async (file: File, source?: PrintoutSource) => {
      setLoading(true);
      try {
        const buf = await file.arrayBuffer();
        const sheets = xlsxBufToSheets(buf);
        if (!sheets.length) throw new Error('No sheets found');

        const tabId = uid();
        const newTab: TabSnapshot = { id: tabId, fileName: file.name, sheets, source };

        const updated = [...tabsRef.current, newTab];
        setTabs(updated);
        setActiveTabId(tabId);
        tabsRef.current = updated;
        activeTabIdRef.current = tabId;

        pendingInitRef.current = sheets;
        scheduleSave();
      } catch (err) {
        console.error('Failed to open file', err);
        toast('Failed to open file', { type: 'error' });
      } finally {
        setLoading(false);
      }
    },
    [initSpreadsheet, scheduleSave, toast],
  );

  // ── Auto-open from router state (e.g. Printouts tab) ──────────────────────

  useEffect(() => {
    const state = location.state as { file?: File; source?: PrintoutSource } | null;
    const incoming = state?.file;
    if (incoming instanceof File) {
      window.history.replaceState({}, '');
      openIDB().then((db) => { idbRef.current = db; }).catch(() => {});
      openXlsx(incoming, state?.source);
    }
  // Only run on mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Restore persisted state from IDB on mount ──────────────────────────────

  useEffect(() => {
    const hasIncoming = !!(location.state as { file?: File } | null)?.file;
    if (hasIncoming) return;

    const restore = async () => {
      const db = await openIDB();
      idbRef.current = db;

      const state = await idbGet<{ activeTabId: string | null; tabOrder: string[] }>(
        db, 'ss-state', 'current',
      );
      if (!state?.tabOrder.length) return;

      const restored: TabSnapshot[] = [];
      for (const id of state.tabOrder) {
        const tab = await idbGet<TabSnapshot>(db, 'ss-tabs', id);
        if (tab) restored.push(tab);
      }
      if (!restored.length) return;

      const active = restored.find((t) => t.id === state.activeTabId) ?? restored[0];

      setTabs(restored);
      setActiveTabId(active.id);
      tabsRef.current = restored;
      activeTabIdRef.current = active.id;
      pendingInitRef.current = active.sheets;
    };

    restore().catch(console.error);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Switch tab ─────────────────────────────────────────────────────────────

  const switchTab = useCallback(
    (tabId: string) => {
      if (tabId === activeTabIdRef.current) return;

      // Flush live data into current tab before switching
      const currentId = activeTabIdRef.current;
      if (currentId) {
        const live = captureCurrentSheets();
        if (live) {
          const flushed = tabsRef.current.map((t) =>
            t.id === currentId ? { ...t, sheets: live } : t,
          );
          setTabs(flushed);
          tabsRef.current = flushed;
        }
      }

      const target = tabsRef.current.find((t) => t.id === tabId);
      if (!target) return;

      pendingInitRef.current = target.sheets;
      setActiveTabId(tabId);
      activeTabIdRef.current = tabId;
      scheduleSave();
    },
    [captureCurrentSheets, initSpreadsheet, scheduleSave],
  );

  // ── Close tab ──────────────────────────────────────────────────────────────

  const closeTab = useCallback(
    (tabId: string) => {
      const all = tabsRef.current;
      const remaining = all.filter((t) => t.id !== tabId);

      if (idbRef.current) {
        idbDel(idbRef.current, 'ss-tabs', tabId).catch(() => {});
      }

      if (!remaining.length) {
        setTabs([]);
        setActiveTabId(null);
        tabsRef.current = [];
        activeTabIdRef.current = null;
        if (containerRef.current && ssRef.current) {
          try { jspreadsheet.destroy(containerRef.current as never); } catch { /* ignore */ }
          ssRef.current = null;
          containerRef.current.innerHTML = '';
        }
        if (idbRef.current) {
          idbPut(idbRef.current, 'ss-state', 'current', {
            activeTabId: null, tabOrder: [],
          }).catch(() => {});
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
        pendingInitRef.current = newActive.sheets;
        setActiveTabId(newActive.id);
        activeTabIdRef.current = newActive.id;
      }
      scheduleSave();
    },
    [initSpreadsheet, scheduleSave],
  );

  // ── Save ───────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!activeTab) return;
    setSaving(true);
    try {
      const sheets = captureCurrentSheets() ?? activeTab.sheets;
      const bytes = sheetsToXlsxBytes(sheets);

      if (activeTab.source) {
        await saveFile(activeTab.source.fileId, bytesToDataUrl(bytes));
        toast('Saved to Printouts', { type: 'success' });
      } else {
        downloadFile(bytes, activeTab.fileName);
      }
    } catch (err) {
      console.error('Save failed', err);
      toast('Save failed', { type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  // ── Save As ────────────────────────────────────────────────────────────────

  const handleSaveAs = async () => {
    if (!activeTab) return;
    setSaving(true);
    try {
      const sheets = captureCurrentSheets() ?? activeTab.sheets;
      const bytes = sheetsToXlsxBytes(sheets);
      const base = activeTab.fileName.replace(/\.(xlsx|xls|csv)$/i, '');
      downloadFile(bytes, `${base}_edited.xlsx`);
    } catch (err) {
      console.error('Save As failed', err);
      toast('Save As failed', { type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  const btnBase =
    'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-40';

  return (
    <div className="h-screen flex flex-col bg-white dark:bg-slate-900 overflow-hidden">
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,.xls,.csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) openXlsx(f);
          e.target.value = '';
        }}
      />

      {/* ── Toolbar ── */}
      <div className="h-12 flex items-center gap-1 px-3 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700 shrink-0">
        <button
          onClick={() => fileInputRef.current?.click()}
          className={`${btnBase} bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200`}
        >
          <FolderOpen size={16} /> Open
        </button>

        <div className="w-px h-6 bg-slate-200 dark:bg-slate-700 mx-1" />

        <button
          onClick={handleSave}
          disabled={!activeTab || saving}
          className={`${btnBase} bg-accent-600 text-white hover:bg-accent-700`}
        >
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
          {activeTab?.source ? 'Save' : 'Download'}
        </button>

        <button
          onClick={handleSaveAs}
          disabled={!activeTab || saving}
          className={`${btnBase} bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200`}
        >
          <Download size={16} /> Save As
        </button>

        {loading && (
          <span className="flex items-center gap-1.5 ml-3 text-sm text-slate-400">
            <Loader2 size={15} className="animate-spin" /> Opening…
          </span>
        )}
      </div>

      {/* ── File tabs ── */}
      {tabs.length > 0 && (
        <div className="flex items-center gap-1 px-3 py-1.5 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700 overflow-x-auto shrink-0">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => switchTab(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-sm max-w-[200px] whitespace-nowrap transition-colors ${
                tab.id === activeTabId
                  ? 'bg-accent-600 text-white'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
              }`}
            >
              <FileSpreadsheet size={13} className="shrink-0" />
              <span className="truncate max-w-[140px]">{tab.fileName}</span>
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
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
          >
            <Plus size={15} />
          </button>
        </div>
      )}

      {/* ── Spreadsheet canvas or empty state ── */}
      <div className="flex-1 overflow-hidden">
        {tabs.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center gap-5 text-slate-400 dark:text-slate-500">
            <FileSpreadsheet size={60} className="opacity-20" />
            <p className="text-lg font-medium">No file open</p>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2 px-5 py-2.5 bg-accent-600 text-white rounded-xl hover:bg-accent-700 text-sm font-medium shadow-sm"
            >
              <FolderOpen size={16} /> Open Spreadsheet
            </button>
          </div>
        ) : (
          <div ref={containerRef} className="h-full w-full" />
        )}
      </div>
    </div>
  );
};
