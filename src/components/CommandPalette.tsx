import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useLocation, matchPath } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import {
  Search, FolderOpen, FileText, Ruler, Plus, Home, Settings as SettingsIcon,
  FileSpreadsheet, CheckSquare, Clock, CornerDownLeft, X, Keyboard,
} from 'lucide-react';
import { searchAll, SearchResult, getMyTimeEntries, clockIn, clockOut } from '../utils/store';
import { useToast } from './Toast';

type Action = {
  id: string;
  type: 'action';
  title: string;
  subtitle?: string;
  icon: React.ReactNode;
  run: () => void;
};

type Item = Action | (SearchResult & { icon?: React.ReactNode });

const typeIcon = (type: SearchResult['type']) => {
  switch (type) {
    case 'project': return <FolderOpen size={16} />;
    case 'page': return <FileText size={16} />;
    case 'takeoff': return <Ruler size={16} />;
  }
};

const typeLabel: Record<SearchResult['type'], string> = {
  project: 'Project',
  page: 'Page',
  takeoff: 'Takeoff',
};

const isTyping = () => {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
};

// Global command palette (Cmd/Ctrl-K) plus a lightweight shortcut layer and a
// "?" help overlay, mounted once near the app root.
export const CommandPalette: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const reqId = useRef(0);

  // On the canvas page the single-key shortcuts belong to the drawing tools, so
  // only the modifier-based palette shortcut is active there.
  const onCanvas = !!matchPath('/project/:projectId/page/:pageId', location.pathname);

  const close = useCallback(() => { setOpen(false); setQuery(''); setResults([]); setSelected(0); }, []);

  const staticActions: Action[] = useMemo(() => [
    { id: 'a:new', type: 'action', title: 'New project', icon: <Plus size={16} />, run: () => navigate('/new') },
    { id: 'a:home', type: 'action', title: 'Dashboard', icon: <Home size={16} />, run: () => navigate('/dashboard') },
    { id: 'a:projects', type: 'action', title: 'Projects', icon: <FolderOpen size={16} />, run: () => navigate('/projects') },
    { id: 'a:settings', type: 'action', title: 'Settings', icon: <SettingsIcon size={16} />, run: () => navigate('/settings') },
    { id: 'a:pdf', type: 'action', title: 'PDF editor', icon: <FileText size={16} />, run: () => navigate('/tools/pdf') },
    { id: 'a:sheet', type: 'action', title: 'Spreadsheet editor', icon: <FileSpreadsheet size={16} />, run: () => navigate('/tools/sheets') },
    { id: 'a:checklist', type: 'action', title: 'Checklists', icon: <CheckSquare size={16} />, run: () => navigate('/checklist') },
    { id: 'a:time', type: 'action', title: 'Time tracking', icon: <Clock size={16} />, run: () => navigate('/time') },
    {
      id: 'a:clock', type: 'action', title: 'Clock in / out', icon: <Clock size={16} />,
      run: async () => {
        try {
          const entries = await getMyTimeEntries();
          const open = entries.find(e => e.clockOut === null);
          if (open) { await clockOut(); toast('Clocked out', { type: 'success' }); }
          else { await clockIn(); toast('Clocked in', { type: 'success' }); }
        } catch { toast('Clock action failed', { type: 'error' }); }
      },
    },
  ], [navigate, toast]);

  // Debounced search.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) { setResults([]); setLoading(false); return; }
    setLoading(true);
    const id = ++reqId.current;
    const t = setTimeout(async () => {
      try {
        const r = await searchAll(q);
        if (id === reqId.current) setResults(r);
      } catch {
        if (id === reqId.current) setResults([]);
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [query, open]);

  const filteredActions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return staticActions;
    return staticActions.filter(a => a.title.toLowerCase().includes(q));
  }, [staticActions, query]);

  const items: Item[] = useMemo(
    () => [...filteredActions, ...results.map(r => ({ ...r, icon: typeIcon(r.type) }))],
    [filteredActions, results],
  );

  useEffect(() => { setSelected(0); }, [items.length]);

  const runItem = useCallback((item: Item) => {
    close();
    if (item.type === 'action') { item.run(); return; }
    switch (item.type) {
      case 'project': navigate(`/project/${item.projectId}`); break;
      case 'page': navigate(`/project/${item.projectId}/page/${item.pageId}`); break;
      case 'takeoff': navigate(`/project/${item.projectId}`, { state: { activeTab: 'takeoffs' } }); break;
    }
  }, [close, navigate]);

  // Global key handling.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setHelpOpen(false);
        setOpen(o => !o);
        return;
      }
      if (open) {
        if (e.key === 'Escape') { e.preventDefault(); close(); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(s => Math.min(s + 1, Math.max(items.length - 1, 0))); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(s => Math.max(s - 1, 0)); return; }
        if (e.key === 'Enter') { e.preventDefault(); if (items[selected]) runItem(items[selected]); return; }
        return;
      }
      if (helpOpen && e.key === 'Escape') { setHelpOpen(false); return; }
      // Single-key shortcuts: only when not typing and not on the canvas.
      if (isTyping() || onCanvas) return;
      if (e.key === '/') { e.preventDefault(); setOpen(true); return; }
      if (e.key === '?') { e.preventDefault(); setHelpOpen(h => !h); return; }
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); navigate('/new'); return; }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, helpOpen, items, selected, onCanvas, navigate, close, runItem]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 10);
  }, [open]);

  // Lets other UI (e.g. the side dock search button) open the palette.
  useEffect(() => {
    const openHandler = () => { setHelpOpen(false); setOpen(true); };
    window.addEventListener('open-command-palette', openHandler);
    return () => window.removeEventListener('open-command-palette', openHandler);
  }, []);

  const shortcuts = [
    { keys: ['⌘/Ctrl', 'K'], label: 'Open command palette / search' },
    { keys: ['/'], label: 'Search (when not typing)' },
    { keys: ['n'], label: 'New project' },
    { keys: ['?'], label: 'Show this help' },
    { keys: ['↑', '↓'], label: 'Move through results' },
    { keys: ['↵'], label: 'Open selected result' },
    { keys: ['Esc'], label: 'Close' },
  ];

  return (
    <>
      <AnimatePresence>
        {open && (
          <motion.div
            className="fixed inset-0 z-[400] flex items-start justify-center p-4 pt-[12vh] bg-black/50 backdrop-blur-sm"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={close} role="dialog" aria-modal="true" aria-label="Command palette"
          >
            <motion.div
              className="w-full max-w-xl bg-white dark:bg-slate-800 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 overflow-hidden"
              initial={{ opacity: 0, scale: 0.97, y: -8 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97, y: -8 }}
              transition={{ duration: 0.15 }} onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-3 px-4 border-b border-slate-100 dark:border-slate-700">
                <Search size={18} className="text-slate-400 shrink-0" />
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search projects, pages, takeoffs…"
                  aria-label="Search"
                  className="flex-1 py-4 bg-transparent outline-none text-slate-900 dark:text-white placeholder-slate-400 text-sm"
                />
                {loading && <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-accent-600 shrink-0" />}
              </div>
              <div className="max-h-[50vh] overflow-y-auto py-2">
                {items.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-slate-400">
                    {query.trim().length < 2 ? 'Type to search…' : 'No matches found.'}
                  </div>
                ) : (
                  items.map((item, i) => (
                    <button
                      key={item.id}
                      onMouseEnter={() => setSelected(i)}
                      onClick={() => runItem(item)}
                      className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                        i === selected ? 'bg-accent-50 dark:bg-accent-900/30' : 'hover:bg-slate-50 dark:hover:bg-slate-700/50'
                      }`}
                    >
                      <span className={`shrink-0 ${i === selected ? 'text-accent-600' : 'text-slate-400'}`}>
                        {('icon' in item && item.icon) || <Search size={16} />}
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block truncate text-sm text-slate-900 dark:text-white">{item.title}</span>
                        {'subtitle' in item && item.subtitle && (
                          <span className="block truncate text-xs text-slate-400">{item.subtitle}</span>
                        )}
                      </span>
                      {item.type !== 'action' && (
                        <span className="shrink-0 text-[10px] uppercase tracking-wider font-semibold text-slate-400 bg-slate-100 dark:bg-slate-700 rounded px-1.5 py-0.5">
                          {typeLabel[item.type]}
                        </span>
                      )}
                      {i === selected && <CornerDownLeft size={14} className="shrink-0 text-slate-400" />}
                    </button>
                  ))
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {helpOpen && (
          <motion.div
            className="fixed inset-0 z-[400] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setHelpOpen(false)} role="dialog" aria-modal="true" aria-label="Keyboard shortcuts"
          >
            <motion.div
              className="w-full max-w-md bg-white dark:bg-slate-800 rounded-2xl shadow-xl border border-slate-200 dark:border-slate-700 overflow-hidden"
              initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.15 }} onClick={(e) => e.stopPropagation()}
            >
              <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between">
                <h2 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <Keyboard size={18} className="text-accent-600" /> Keyboard shortcuts
                </h2>
                <button onClick={() => setHelpOpen(false)} aria-label="Close" className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700">
                  <X size={18} />
                </button>
              </div>
              <div className="p-6 space-y-3">
                {shortcuts.map((s, i) => (
                  <div key={i} className="flex items-center justify-between gap-4 text-sm">
                    <span className="text-slate-600 dark:text-slate-300">{s.label}</span>
                    <span className="flex items-center gap-1 shrink-0">
                      {s.keys.map((k, j) => (
                        <kbd key={j} className="px-2 py-1 rounded-md bg-slate-100 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-xs font-mono text-slate-700 dark:text-slate-200">{k}</kbd>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};
