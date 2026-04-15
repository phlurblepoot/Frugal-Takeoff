import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { Workbook } from '@fortune-sheet/react';
import type { Sheet as FortuneSheet } from '@fortune-sheet/core';
import '@fortune-sheet/react/dist/index.css';
import * as XLSX from 'xlsx';
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

interface FileTab {
  id: string;
  fileName: string;
  sheets: FortuneSheet[];
  source?: PrintoutSource;
}

// ── IDB helpers ───────────────────────────────────────────────────────────────

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

// ── xlsx ↔ FortuneSheet conversion ────────────────────────────────────────────

const xlsxToFortuneSheets = (buffer: ArrayBuffer): FortuneSheet[] => {
  const wb = XLSX.read(new Uint8Array(buffer), { type: 'array' });
  return wb.SheetNames.map((name, i) => {
    const ws = wb.Sheets[name];
    const celldata: FortuneSheet['celldata'] = [];

    for (const ref in ws) {
      if (ref[0] === '!') continue;
      const addr = XLSX.utils.decode_cell(ref);
      const cell = ws[ref] as XLSX.CellObject;
      if (cell.v == null && !cell.f) continue;
      celldata.push({
        r: addr.r,
        c: addr.c,
        v: {
          v: cell.v as string | number | boolean | undefined,
          m: String(cell.w ?? cell.v ?? ''),
          ...(cell.f ? { f: '=' + cell.f } : {}),
        },
      });
    }

    return {
      name,
      id: `sheet_${i}_${name}`,
      status: i === 0 ? 1 : 0,
      order: i,
      celldata,
    } as FortuneSheet;
  });
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

const uid = () => Math.random().toString(36).slice(2, 10);

// ── SpreadsheetEditor ─────────────────────────────────────────────────────────

export const SpreadsheetEditor: React.FC = () => {
  const location = useLocation();
  const { toast } = useToast();

  const [tabs, setTabs] = useState<FileTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  // FortuneSheet's current sheet data — updated via onChange on every edit
  const [currentSheets, setCurrentSheets] = useState<FortuneSheet[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const idbRef = useRef<IDBDatabase | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Stable refs for use inside callbacks without stale closure issues
  const tabsRef = useRef<FileTab[]>([]);
  const activeTabIdRef = useRef<string | null>(null);
  const currentSheetsRef = useRef<FortuneSheet[]>([]);

  useEffect(() => { tabsRef.current = tabs; }, [tabs]);
  useEffect(() => { activeTabIdRef.current = activeTabId; }, [activeTabId]);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  // ── IDB persistence ───────────────────────────────────────────────────────

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

    await idbPut(db, 'ss-state', 'current', {
      activeTabId: currentId,
      tabOrder: allTabs.map((t) => t.id),
    });
    for (const tab of allTabs) {
      await idbPut(db, 'ss-tabs', tab.id, tab);
    }
  }, []);

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => saveStateToIDB(), 1500);
  }, [saveStateToIDB]);

  // ── FortuneSheet onChange ─────────────────────────────────────────────────

  const handleChange = useCallback(
    (data: FortuneSheet[]) => {
      setCurrentSheets(data);
      currentSheetsRef.current = data;
      scheduleSave();
    },
    [scheduleSave],
  );

  // ── Open a file ───────────────────────────────────────────────────────────

  const openXlsx = useCallback(
    async (file: File, source?: PrintoutSource) => {
      setLoading(true);
      try {
        const buf = await file.arrayBuffer();
        const sheets = xlsxToFortuneSheets(buf);
        if (!sheets.length) throw new Error('No sheets found');

        const tabId = uid();
        const newTab: FileTab = { id: tabId, fileName: file.name, sheets, source };

        const updated = [...tabsRef.current, newTab];
        setTabs(updated);
        tabsRef.current = updated;
        setActiveTabId(tabId);
        activeTabIdRef.current = tabId;
        setCurrentSheets(sheets);
        currentSheetsRef.current = sheets;
        scheduleSave();
      } catch (err) {
        console.error('Failed to open file', err);
        toast('Failed to open file', { type: 'error' });
      } finally {
        setLoading(false);
      }
    },
    [scheduleSave, toast],
  );

  // ── Auto-open + IDB restore on mount ──────────────────────────────────────

  useEffect(() => {
    const state = location.state as { file?: File; source?: PrintoutSource } | null;
    const incoming = state?.file;

    const init = async () => {
      const db = await openIDB();
      idbRef.current = db;

      // Load any existing tabs from IDB
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
        await openXlsx(incoming, state?.source);
        return;
      }

      if (!restoredTabs.length) return;

      const active = restoredTabs.find((t) => t.id === saved?.activeTabId) ?? restoredTabs[0];
      setTabs(restoredTabs);
      tabsRef.current = restoredTabs;
      setActiveTabId(active.id);
      activeTabIdRef.current = active.id;
      setCurrentSheets(active.sheets);
      currentSheetsRef.current = active.sheets;
    };

    init().catch(console.error);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Switch tab ────────────────────────────────────────────────────────────

  const switchTab = useCallback((tabId: string) => {
    if (tabId === activeTabIdRef.current) return;

    // Flush live data into the outgoing tab
    const outId = activeTabIdRef.current;
    if (outId) {
      const flushed = tabsRef.current.map((t) =>
        t.id === outId ? { ...t, sheets: currentSheetsRef.current } : t,
      );
      setTabs(flushed);
      tabsRef.current = flushed;
    }

    const target = tabsRef.current.find((t) => t.id === tabId);
    if (!target) return;

    setActiveTabId(tabId);
    activeTabIdRef.current = tabId;
    setCurrentSheets(target.sheets);
    currentSheetsRef.current = target.sheets;
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
      setActiveTabId(newActive.id);
      activeTabIdRef.current = newActive.id;
      setCurrentSheets(newActive.sheets);
      currentSheetsRef.current = newActive.sheets;
    }
    scheduleSave();
  }, [scheduleSave]);

  // ── Save ──────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!activeTab) return;
    setSaving(true);
    try {
      const bytes = fortuneSheetsToXlsxBytes(currentSheetsRef.current);
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

  // ── Render ────────────────────────────────────────────────────────────────

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
      <div className="h-12 flex items-center gap-1 px-3 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700 shrink-0 z-10">
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
        <div className="flex items-center gap-1 px-3 py-1.5 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700 overflow-x-auto shrink-0 z-10">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => switchTab(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-sm whitespace-nowrap transition-colors ${
                tab.id === activeTabId
                  ? 'bg-accent-600 text-white'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
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
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
          >
            <Plus size={15} />
          </button>
        </div>
      )}

      {/* ── Spreadsheet or empty state ── */}
      <div className="flex-1 overflow-hidden relative">
        {currentSheets.length > 0 ? (
          <Workbook
            data={currentSheets}
            onChange={handleChange}
            lang="en"
            showToolbar
            allowEdit
            showSheetTabs
          />
        ) : (
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
        )}
      </div>
    </div>
  );
};
