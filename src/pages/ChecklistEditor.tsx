import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CheckSquare, Plus, Trash2, Camera, MapPin,
  FileText, Printer, Download, Eye, ClipboardList,
  ChevronDown, ChevronUp, X, Edit2, Check, Share2,
} from 'lucide-react';
import { jsPDF } from 'jspdf';
import { saveFile, getFile, createShare, getSettings } from '../utils/store';

// ─── IDB ─────────────────────────────────────────────────────────────────────

const DB_NAME = 'checklist-db';
const DB_VERSION = 1;

function openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      for (const name of ['checklists', 'photos', 'pdfs', 'state'] as const) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name);
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet<T>(db: IDBDatabase, store: string, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, store: string, value: unknown, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function idbDelete(db: IDBDatabase, store: string, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function idbGetAll<T>(db: IDBDatabase, store: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

function idbGetAllKeys(db: IDBDatabase, store: string): Promise<IDBValidKey[]> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAllKeys();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function nanoid() {
  return Math.random().toString(36).slice(2, 11) + Math.random().toString(36).slice(2, 6);
}

// ─── Image utilities ──────────────────────────────────────────────────────────

// Reads a file, applies EXIF orientation, optionally downscales, and returns a data URL.
// Using createImageBitmap with imageOrientation:'from-image' bakes the EXIF rotation
// into the pixels so downstream consumers (jsPDF, img tags, etc.) render upright.
const MAX_IMAGE_DIM = 1600;

async function normalizeImage(file: File): Promise<string> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const { width: w, height: h } = bitmap;
    const scale = Math.min(1, MAX_IMAGE_DIM / Math.max(w, h));
    const dw = Math.round(w * scale);
    const dh = Math.round(h * scale);
    const canvas = document.createElement('canvas');
    canvas.width = dw;
    canvas.height = dh;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0, dw, dh);
    bitmap.close?.();
    const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    return canvas.toDataURL(mime, mime === 'image/jpeg' ? 0.88 : undefined);
  } catch {
    // Fallback: read raw bytes as data URL (no EXIF correction, but still works)
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => resolve(e.target?.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }
}

function dataUrlToFile(dataUrl: string, fileName: string, mime: string): Promise<File> {
  return fetch(dataUrl).then(r => r.blob()).then(b => new File([b], fileName, { type: mime }));
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChecklistItem {
  id: string;
  description: string;
  location: string;
  done: boolean;
  order: number;
  beforePhotoIds?: string[];
  afterPhotoIds?: string[];
  createdAt: number;
}

interface ChecklistPrintout {
  id: string;
  name: string;
  createdAt: number;
  fileId?: string; // server file id; printouts generated before this migration may lack it
}

interface Checklist {
  id: string;
  name: string;
  createdAt: number;
  items: ChecklistItem[];
  printouts: ChecklistPrintout[];
}

// ─── Photo Section (shared by Before/After) ──────────────────────────────────

interface PhotoSectionProps {
  type: 'before' | 'after';
  label: string;
  photos: string[];
  inputRef: React.RefObject<HTMLInputElement>;
  onPhotoUpload: (type: 'before' | 'after', file: File) => void;
  onRemovePhoto: (type: 'before' | 'after', index: number) => void;
}

const PhotoSection: React.FC<PhotoSectionProps> = ({
  type, label, photos, inputRef, onPhotoUpload, onRemovePhoto,
}) => {
  const [dragOver, setDragOver] = useState(false);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
    files.forEach(f => onPhotoUpload(type, f));
  };

  return (
    <div
      onDragEnter={e => { e.preventDefault(); e.stopPropagation(); setDragOver(true); }}
      onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDragOver(true); }}
      onDragLeave={e => { e.preventDefault(); e.stopPropagation(); setDragOver(false); }}
      onDrop={handleDrop}
      className={`rounded-lg transition-colors ${dragOver ? 'ring-2 ring-accent-500 ring-offset-2 ring-offset-white dark:ring-offset-slate-900' : ''}`}
    >
      <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-2">
        {label} {photos.length > 0 && <span className="text-slate-400">({photos.length})</span>}
      </label>
      {photos.length > 0 && (
        <div className="grid grid-cols-3 sm:grid-cols-2 gap-2 mb-2">
          {photos.map((src, idx) => (
            <div key={idx} className="relative group">
              <img src={src} className="w-full h-24 object-cover rounded-lg border border-slate-200 dark:border-slate-700" alt={`${type} ${idx + 1}`} />
              <button
                onClick={() => onRemovePhoto(type, idx)}
                className="absolute top-1 right-1 p-0.5 bg-red-500 text-white rounded-full opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
      )}
      <button
        onClick={() => inputRef.current?.click()}
        className={`w-full py-2.5 border-2 border-dashed rounded-lg flex items-center justify-center gap-1.5 transition-colors text-xs font-medium ${
          dragOver
            ? 'border-accent-400 bg-accent-50 dark:bg-accent-900/20 text-accent-600'
            : 'border-slate-200 dark:border-slate-700 text-slate-400 hover:border-accent-400 hover:text-accent-500'
        }`}
      >
        <Camera size={14} />
        {dragOver ? 'Drop to upload' : `Add ${type === 'before' ? 'Before' : 'After'} Photo`}
      </button>
      <input ref={inputRef} type="file" accept="image/*" multiple className="hidden"
        onChange={e => {
          if (e.target.files) Array.from(e.target.files).forEach(f => onPhotoUpload(type, f));
          e.target.value = '';
        }} />
    </div>
  );
};

// ─── Item Card ────────────────────────────────────────────────────────────────

interface ItemCardProps {
  item: ChecklistItem;
  expanded: boolean;
  beforePhotos?: string[];
  afterPhotos?: string[];
  onToggle: () => void;
  onExpand: () => void;
  onUpdate: (patch: Partial<ChecklistItem>) => void;
  onDelete: () => void;
  onPhotoUpload: (type: 'before' | 'after', file: File) => void;
  onRemovePhoto: (type: 'before' | 'after', index: number) => void;
}

const ItemCard: React.FC<ItemCardProps> = ({
  item, expanded, beforePhotos, afterPhotos,
  onToggle, onExpand, onUpdate, onDelete, onPhotoUpload, onRemovePhoto,
}) => {
  const beforeRef = useRef<HTMLInputElement>(null);
  const afterRef = useRef<HTMLInputElement>(null);
  const bPhotos = beforePhotos ?? [];
  const aPhotos = afterPhotos ?? [];
  const totalThumbs = bPhotos.length + aPhotos.length;

  return (
    <div className={`bg-white dark:bg-slate-900 rounded-xl border transition-all ${
      item.done ? 'border-green-200 dark:border-green-800/40' : 'border-slate-200 dark:border-slate-700'
    }`}>
      {/* Row */}
      <div className="flex items-center gap-3 px-4 py-3">
        {/* Checkbox */}
        <button
          onClick={onToggle}
          className={`shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
            item.done
              ? 'bg-green-500 border-green-500 text-white'
              : 'border-slate-300 dark:border-slate-600 hover:border-green-400'
          }`}
        >
          {item.done && <Check size={12} />}
        </button>

        {/* Summary */}
        <button onClick={onExpand} className="flex-1 text-left min-w-0">
          <p className={`text-sm font-medium truncate ${
            item.done
              ? 'text-slate-400 dark:text-slate-500 line-through'
              : 'text-slate-900 dark:text-slate-100'
          }`}>
            {item.description || <span className="italic text-slate-400">No description</span>}
          </p>
          {item.location && (
            <p className="text-xs text-slate-400 dark:text-slate-500 flex items-center gap-1 mt-0.5">
              <MapPin size={11} />{item.location}
            </p>
          )}
        </button>

        {/* Photo thumbnails */}
        <div className="flex items-center gap-1.5 shrink-0">
          {bPhotos.slice(0, 2).map((src, i) => (
            <div key={`b${i}`} className="w-7 h-7 rounded overflow-hidden border border-slate-200 dark:border-slate-700">
              <img src={src} className="w-full h-full object-cover" alt="before" />
            </div>
          ))}
          {aPhotos.slice(0, 2).map((src, i) => (
            <div key={`a${i}`} className="w-7 h-7 rounded overflow-hidden border border-slate-200 dark:border-slate-700">
              <img src={src} className="w-full h-full object-cover" alt="after" />
            </div>
          ))}
          {totalThumbs > 4 && (
            <div className="h-7 px-1.5 rounded bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-[10px] font-medium text-slate-500">
              +{totalThumbs - 4}
            </div>
          )}
        </div>

        <button onClick={onExpand} className="shrink-0 p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300">
          {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
      </div>

      {/* Expanded body */}
      {expanded && (
        <div className="border-t border-slate-100 dark:border-slate-800 px-4 py-4 space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">Description</label>
            <textarea
              value={item.description}
              onChange={e => onUpdate({ description: e.target.value })}
              rows={2}
              placeholder="Describe the task..."
              className="w-full text-sm px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder-slate-400 resize-none focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-transparent"
            />
          </div>

          <div>
            <label className="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
              <MapPin size={11} /> Location
            </label>
            <input
              type="text"
              value={item.location}
              onChange={e => onUpdate({ location: e.target.value })}
              placeholder="e.g. Roof, Level 2, Unit 4..."
              className="w-full text-sm px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-transparent"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <PhotoSection
              type="before"
              label="Before Photos"
              photos={bPhotos}
              inputRef={beforeRef}
              onPhotoUpload={onPhotoUpload}
              onRemovePhoto={onRemovePhoto}
            />
            <PhotoSection
              type="after"
              label="After Photos"
              photos={aPhotos}
              inputRef={afterRef}
              onPhotoUpload={onPhotoUpload}
              onRemovePhoto={onRemovePhoto}
            />
          </div>

          <div className="flex justify-end pt-1">
            <button
              onClick={onDelete}
              className="flex items-center gap-1.5 text-xs text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20 px-2 py-1.5 rounded-lg transition-colors"
            >
              <Trash2 size={13} /> Remove item
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Main Component ───────────────────────────────────────────────────────────

export const ChecklistEditor: React.FC = () => {
  const navigate = useNavigate();
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'items' | 'printouts'>('items');
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [beforePhotos, setBeforePhotos] = useState<Record<string, string[]>>({});
  const [afterPhotos, setAfterPhotos] = useState<Record<string, string[]>>({});
  const [generating, setGenerating] = useState(false);

  const dbRef = useRef<IDBDatabase | null>(null);
  const checklistsRef = useRef(checklists);
  const activeIdRef = useRef(activeId);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { checklistsRef.current = checklists; }, [checklists]);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);

  const active = checklists.find(c => c.id === activeId) ?? null;
  const doneCount = active?.items.filter(i => i.done).length ?? 0;
  const totalCount = active?.items.length ?? 0;

  // ── Init ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const db = await openIDB();
      dbRef.current = db;

      // Checklists are stored with their id as key
      const keys = await idbGetAllKeys(db, 'checklists') as string[];
      const loaded: Checklist[] = [];
      for (const key of keys) {
        const c = await idbGet<Checklist>(db, 'checklists', key);
        if (c) loaded.push(c);
      }
      loaded.sort((a, b) => a.createdAt - b.createdAt);

      const state = await idbGet<{ activeId: string | null }>(db, 'state', 'current');
      if (loaded.length > 0) {
        setChecklists(loaded);
        const aid = state?.activeId && loaded.find(c => c.id === state.activeId)
          ? state.activeId : loaded[0].id;
        setActiveId(aid);
        const list = loaded.find(c => c.id === aid);
        if (list) await loadPhotos(db, list);
      }
    })().catch(console.error);
  }, []);

  const loadPhotos = async (db: IDBDatabase, list: Checklist) => {
    const before: Record<string, string[]> = {};
    const after: Record<string, string[]> = {};
    for (const item of list.items) {
      if (item.beforePhotoIds?.length) {
        const photos: string[] = [];
        for (const pid of item.beforePhotoIds) {
          const p = await idbGet<string>(db, 'photos', pid);
          if (p) photos.push(p);
        }
        if (photos.length) before[item.id] = photos;
      }
      if (item.afterPhotoIds?.length) {
        const photos: string[] = [];
        for (const pid of item.afterPhotoIds) {
          const p = await idbGet<string>(db, 'photos', pid);
          if (p) photos.push(p);
        }
        if (photos.length) after[item.id] = photos;
      }
    }
    setBeforePhotos(before);
    setAfterPhotos(after);
  };

  // ── Persistence ─────────────────────────────────────────────────────────────
  const persist = useCallback((lists: Checklist[], aid: string | null) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const db = dbRef.current;
      if (!db) return;
      for (const list of lists) {
        await idbPut(db, 'checklists', list, list.id);
      }
      await idbPut(db, 'state', { activeId: aid }, 'current');
    }, 700);
  }, []);

  const setLists = useCallback((updated: Checklist[]) => {
    setChecklists(updated);
    persist(updated, activeIdRef.current);
  }, [persist]);

  // ── Checklist CRUD ──────────────────────────────────────────────────────────
  const handleNew = async () => {
    const id = nanoid();
    const list: Checklist = {
      id, name: `Checklist ${checklists.length + 1}`,
      createdAt: Date.now(), items: [], printouts: [],
    };
    const updated = [...checklists, list];
    setChecklists(updated);
    setActiveId(id);
    setActiveTab('items');
    setExpandedItemId(null);
    setBeforePhotos({});
    setAfterPhotos({});
    const db = dbRef.current;
    if (db) {
      await idbPut(db, 'checklists', list, list.id);
      await idbPut(db, 'state', { activeId: id }, 'current');
    }
  };

  const handleDeleteList = async (id: string) => {
    if (!confirm('Delete this checklist and all its items?')) return;
    const db = dbRef.current;
    const list = checklists.find(c => c.id === id);
    if (db && list) {
      for (const item of list.items) {
        for (const pid of item.beforePhotoIds ?? []) await idbDelete(db, 'photos', pid);
        for (const pid of item.afterPhotoIds ?? []) await idbDelete(db, 'photos', pid);
      }
      for (const po of list.printouts) {
        await idbDelete(db, 'pdfs', po.id);
      }
      await idbDelete(db, 'checklists', id);
    }
    const updated = checklists.filter(c => c.id !== id);
    setChecklists(updated);
    if (activeId === id) {
      const next = updated[0]?.id ?? null;
      setActiveId(next);
      if (next && db) {
        await idbPut(db, 'state', { activeId: next }, 'current');
        const nextList = updated.find(c => c.id === next);
        if (nextList) await loadPhotos(db, nextList);
      }
    }
  };

  const switchList = async (id: string) => {
    setActiveId(id);
    setActiveTab('items');
    setExpandedItemId(null);
    const db = dbRef.current;
    if (db) await idbPut(db, 'state', { activeId: id }, 'current');
    const list = checklistsRef.current.find(c => c.id === id);
    if (list && db) await loadPhotos(db, list);
  };

  const commitRename = () => {
    if (!active || !nameInput.trim()) { setEditingName(false); return; }
    setLists(checklists.map(c => c.id === activeId ? { ...c, name: nameInput.trim() } : c));
    setEditingName(false);
  };

  // ── Item CRUD ───────────────────────────────────────────────────────────────
  const handleAddItem = () => {
    if (!active) return;
    const id = nanoid();
    const maxOrder = active.items.reduce((m, i) => Math.max(m, i.order), -1);
    const item: ChecklistItem = {
      id, description: '', location: '', done: false,
      order: maxOrder + 1, createdAt: Date.now(),
    };
    setLists(checklists.map(c => c.id !== activeId ? c : { ...c, items: [...c.items, item] }));
    setExpandedItemId(id);
  };

  const updateItem = (itemId: string, patch: Partial<ChecklistItem>) => {
    setLists(checklists.map(c => c.id !== activeId ? c : {
      ...c, items: c.items.map(i => i.id === itemId ? { ...i, ...patch } : i),
    }));
  };

  const deleteItem = async (itemId: string) => {
    const db = dbRef.current;
    const item = active?.items.find(i => i.id === itemId);
    if (db && item) {
      for (const pid of item.beforePhotoIds ?? []) await idbDelete(db, 'photos', pid);
      for (const pid of item.afterPhotoIds ?? []) await idbDelete(db, 'photos', pid);
    }
    setBeforePhotos(p => { const n = { ...p }; delete n[itemId]; return n; });
    setAfterPhotos(p => { const n = { ...p }; delete n[itemId]; return n; });
    setLists(checklists.map(c => c.id !== activeId ? c : {
      ...c, items: c.items.filter(i => i.id !== itemId),
    }));
    if (expandedItemId === itemId) setExpandedItemId(null);
  };

  // ── Photos ──────────────────────────────────────────────────────────────────
  const handlePhotoUpload = async (itemId: string, type: 'before' | 'after', file: File) => {
    if (!file.type.startsWith('image/')) return;
    const dataUrl = await normalizeImage(file);
    const photoId = `${itemId}_${type}_${nanoid()}`;
    const db = dbRef.current;
    if (db) await idbPut(db, 'photos', dataUrl, photoId);

    const list = checklistsRef.current.find(c => c.id === activeIdRef.current);
    const currentItem = list?.items.find(i => i.id === itemId);
    if (!currentItem) return;

    if (type === 'before') {
      const newIds = [...(currentItem.beforePhotoIds ?? []), photoId];
      setBeforePhotos(p => ({ ...p, [itemId]: [...(p[itemId] ?? []), dataUrl] }));
      updateItem(itemId, { beforePhotoIds: newIds });
    } else {
      const newIds = [...(currentItem.afterPhotoIds ?? []), photoId];
      setAfterPhotos(p => ({ ...p, [itemId]: [...(p[itemId] ?? []), dataUrl] }));
      updateItem(itemId, { afterPhotoIds: newIds });
    }
  };

  const handleRemovePhoto = async (itemId: string, type: 'before' | 'after', index: number) => {
    const db = dbRef.current;
    const list = checklistsRef.current.find(c => c.id === activeIdRef.current);
    const currentItem = list?.items.find(i => i.id === itemId);
    if (!currentItem) return;

    if (type === 'before') {
      const ids = currentItem.beforePhotoIds ?? [];
      const photoId = ids[index];
      if (db && photoId) await idbDelete(db, 'photos', photoId);
      setBeforePhotos(p => {
        const photos = [...(p[itemId] ?? [])];
        photos.splice(index, 1);
        return { ...p, [itemId]: photos };
      });
      updateItem(itemId, { beforePhotoIds: ids.filter((_, i) => i !== index) });
    } else {
      const ids = currentItem.afterPhotoIds ?? [];
      const photoId = ids[index];
      if (db && photoId) await idbDelete(db, 'photos', photoId);
      setAfterPhotos(p => {
        const photos = [...(p[itemId] ?? [])];
        photos.splice(index, 1);
        return { ...p, [itemId]: photos };
      });
      updateItem(itemId, { afterPhotoIds: ids.filter((_, i) => i !== index) });
    }
  };

  // ── PDF Generation ──────────────────────────────────────────────────────────
  const handlePrint = async () => {
    if (!active || generating) return;
    setGenerating(true);
    try {
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
      const W = pdf.internal.pageSize.getWidth();
      const H = pdf.internal.pageSize.getHeight();
      const margin = 40;

      // Header bar
      pdf.setFillColor(37, 99, 235);
      pdf.rect(0, 0, W, 82, 'F');
      pdf.setTextColor(255, 255, 255);
      pdf.setFontSize(20);
      pdf.setFont('helvetica', 'bold');
      pdf.text(active.name, margin, 36);
      pdf.setFontSize(9);
      pdf.setFont('helvetica', 'normal');
      pdf.text(`Generated: ${new Date().toLocaleString()}`, margin, 56);
      pdf.text(
        `${doneCount}/${totalCount} items completed`,
        W - margin, 56, { align: 'right' }
      );

      let y = 100;

      const undone = active.items.filter(i => !i.done).sort((a, b) => a.order - b.order);
      const done = active.items.filter(i => i.done).sort((a, b) => a.order - b.order);

      const drawSection = (label: string, count: number) => {
        if (y + 28 > H - margin) { pdf.addPage(); y = margin; }
        pdf.setFontSize(12);
        pdf.setFont('helvetica', 'bold');
        pdf.setTextColor(15, 23, 42);
        pdf.text(`${label} (${count})`, margin, y + 14);
        // underline
        pdf.setDrawColor(203, 213, 225);
        pdf.setLineWidth(0.5);
        pdf.line(margin, y + 18, W - margin, y + 18);
        y += 28;
      };

      const PHOTO_W = 95;
      const PHOTO_H = 70;
      const PHOTO_GAP = 8;
      const PHOTO_LABEL_H = 10;
      const PHOTOS_PER_ROW = 4;
      const photoRowH = PHOTO_H + PHOTO_GAP;
      const photoGroupH = (count: number) =>
        count > 0 ? PHOTO_LABEL_H + Math.ceil(count / PHOTOS_PER_ROW) * photoRowH : 0;

      const drawPhotoGroup = (
        label: string, photos: string[], startX: number, startY: number, maxWidth: number,
      ): number => {
        if (photos.length === 0) return 0;
        pdf.setFontSize(7);
        pdf.setTextColor(148, 163, 184);
        pdf.setFont('helvetica', 'bold');
        pdf.text(label, startX, startY + 7);
        let row = 0;
        let col = 0;
        const perRow = Math.max(1, Math.min(PHOTOS_PER_ROW, Math.floor((maxWidth + PHOTO_GAP) / (PHOTO_W + PHOTO_GAP))));
        for (const src of photos) {
          const px = startX + col * (PHOTO_W + PHOTO_GAP);
          const py = startY + PHOTO_LABEL_H + row * photoRowH;
          const fmt = src.startsWith('data:image/png') ? 'PNG' : 'JPEG';
          try { pdf.addImage(src, fmt, px, py, PHOTO_W, PHOTO_H); } catch { /* ignore bad image */ }
          col++;
          if (col >= perRow) { col = 0; row++; }
        }
        return PHOTO_LABEL_H + Math.ceil(photos.length / perRow) * photoRowH;
      };

      const drawItem = (item: ChecklistItem, index: number, isDone: boolean) => {
        const bPhotosArr = beforePhotos[item.id] ?? [];
        const aPhotosArr = afterPhotos[item.id] ?? [];
        const hasPhotos = bPhotosArr.length > 0 || aPhotosArr.length > 0;

        const photosTotalH =
          photoGroupH(bPhotosArr.length) +
          (bPhotosArr.length > 0 && aPhotosArr.length > 0 ? 6 : 0) +
          photoGroupH(aPhotosArr.length);

        const boxH = hasPhotos ? 52 + photosTotalH + 12 : 72;

        if (y + boxH > H - margin) { pdf.addPage(); y = margin; }

        // Box background
        if (isDone) {
          pdf.setFillColor(240, 253, 244);
          pdf.setDrawColor(187, 247, 208);
        } else {
          pdf.setFillColor(248, 250, 252);
          pdf.setDrawColor(226, 232, 240);
        }
        pdf.setLineWidth(0.75);
        pdf.rect(margin, y, W - margin * 2, boxH, 'FD');

        const cx = margin + 16;
        const cy = y + 16;

        // Checkbox
        if (isDone) {
          pdf.setFillColor(34, 197, 94);
          pdf.setDrawColor(34, 197, 94);
          pdf.rect(cx, cy, 14, 14, 'F');
          pdf.setDrawColor(255, 255, 255);
          pdf.setLineWidth(1.5);
          pdf.line(cx + 2, cy + 7, cx + 5, cy + 11);
          pdf.line(cx + 5, cy + 11, cx + 12, cy + 3);
        } else {
          pdf.setDrawColor(148, 163, 184);
          pdf.setLineWidth(1);
          pdf.rect(cx, cy, 14, 14, 'S');
        }

        // Item number
        pdf.setTextColor(148, 163, 184);
        pdf.setFontSize(8);
        pdf.setFont('helvetica', 'normal');
        pdf.text(`${index + 1}`, cx + 7, cy - 2, { align: 'center' });

        const tx = cx + 22;
        const tw = W - margin * 2 - 22 - 20 - 80;

        // Description
        pdf.setTextColor(isDone ? 71 : 15, isDone ? 85 : 23, isDone ? 105 : 42);
        pdf.setFontSize(11);
        pdf.setFont('helvetica', isDone ? 'italic' : 'bold');
        const descLines = pdf.splitTextToSize(item.description || '(No description)', tw) as string[];
        pdf.text(descLines.slice(0, 2), tx, y + 22);

        // Location
        if (item.location) {
          pdf.setFontSize(9);
          pdf.setFont('helvetica', 'normal');
          pdf.setTextColor(100, 116, 139);
          const locTrunc = item.location.length > 60 ? item.location.slice(0, 57) + '...' : item.location;
          pdf.text(`Location: ${locTrunc}`, tx, y + 37);
        }

        // Status badge
        const badgeX = W - margin - 72;
        const badgeY = y + 12;
        if (isDone) {
          pdf.setFillColor(34, 197, 94);
        } else {
          pdf.setFillColor(234, 179, 8);
        }
        pdf.rect(badgeX, badgeY, 64, 16, 'F');
        pdf.setTextColor(255, 255, 255);
        pdf.setFontSize(7);
        pdf.setFont('helvetica', 'bold');
        pdf.text(isDone ? 'COMPLETE' : 'PENDING', badgeX + 32, badgeY + 11, { align: 'center' });

        // Photos
        if (hasPhotos) {
          const photoMaxW = W - margin * 2 - (tx - margin) - 16;
          let photoY = y + 52;
          if (bPhotosArr.length > 0) {
            const used = drawPhotoGroup('BEFORE', bPhotosArr, tx, photoY, photoMaxW);
            photoY += used + (aPhotosArr.length > 0 ? 6 : 0);
          }
          if (aPhotosArr.length > 0) {
            drawPhotoGroup('AFTER', aPhotosArr, tx, photoY, photoMaxW);
          }
        }

        y += boxH + 8;
      };

      if (undone.length > 0) {
        drawSection('Pending', undone.length);
        undone.forEach((item, i) => drawItem(item, i, false));
      }

      if (done.length > 0) {
        if (undone.length > 0) y += 8;
        drawSection('Completed', done.length);
        done.forEach((item, i) => drawItem(item, i, true));
      }

      if (totalCount === 0) {
        pdf.setFontSize(12);
        pdf.setTextColor(148, 163, 184);
        pdf.text('No items in this checklist.', W / 2, y + 40, { align: 'center' });
      }

      const pdfDataUrl = pdf.output('datauristring');
      const printoutId = nanoid();
      const printoutName = `${active.name} — ${new Date().toLocaleString()}`;
      const fileId = `checklist-${printoutId}`;

      // Save to the server so the PDF editor and share links can retrieve it.
      // Also keep a local IDB copy as an offline fallback.
      try { await saveFile(fileId, pdfDataUrl); } catch (err) { console.warn('saveFile failed', err); }
      const db = dbRef.current;
      if (db) await idbPut(db, 'pdfs', pdfDataUrl, printoutId);

      const po: ChecklistPrintout = { id: printoutId, name: printoutName, createdAt: Date.now(), fileId };
      const updated = checklists.map(c => c.id !== activeId ? c : {
        ...c, printouts: [...c.printouts, po],
      });
      setLists(updated);
      setActiveTab('printouts');
    } finally {
      setGenerating(false);
    }
  };

  // ── Printout actions ────────────────────────────────────────────────────────
  const getPdfDataUrl = async (po: ChecklistPrintout): Promise<string | undefined> => {
    if (po.fileId) {
      const fromServer = await getFile(po.fileId).catch(() => null);
      if (fromServer) return fromServer;
    }
    const db = dbRef.current;
    return db ? idbGet<string>(db, 'pdfs', po.id) : undefined;
  };

  const handleViewPrintout = async (po: ChecklistPrintout) => {
    const dataUrl = await getPdfDataUrl(po);
    if (!dataUrl) return;
    const fileName = po.name.endsWith('.pdf') ? po.name : `${po.name}.pdf`;
    const file = await dataUrlToFile(dataUrl, fileName, 'application/pdf');
    const source = po.fileId
      ? { projectId: activeIdRef.current ?? '', printoutId: po.id, fileId: po.fileId }
      : undefined;
    navigate('/pdf-editor', { state: { file, source } });
  };

  const handleDownloadPrintout = async (po: ChecklistPrintout) => {
    const data = await getPdfDataUrl(po);
    if (!data) return;
    const a = document.createElement('a');
    a.href = data;
    a.download = po.name.endsWith('.pdf') ? po.name : `${po.name}.pdf`;
    a.click();
  };

  const copyShareUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      alert(`Share link copied to clipboard:\n${url}`);
    } catch {
      window.prompt('Copy this share link (Ctrl+A, Ctrl+C):', url);
    }
  };

  const handleSharePrintout = async (po: ChecklistPrintout) => {
    try {
      let fileId = po.fileId;
      // Back-fill older printouts that were stored only in IDB.
      if (!fileId) {
        const data = await getPdfDataUrl(po);
        if (!data) throw new Error('PDF unavailable');
        fileId = `checklist-${po.id}`;
        await saveFile(fileId, data);
        setLists(checklists.map(c => c.id !== activeId ? c : {
          ...c,
          printouts: c.printouts.map(p => p.id === po.id ? { ...p, fileId } : p),
        }));
      }
      const id = await createShare('printout', fileId, po.name);
      const settings = await getSettings();
      const host = (settings.publicHost || window.location.origin).replace(/\/$/, '');
      await copyShareUrl(`${host}/share/${id}`);
    } catch {
      alert('Failed to create share link');
    }
  };

  const handleDeletePrintout = async (printoutId: string) => {
    const db = dbRef.current;
    if (db) await idbDelete(db, 'pdfs', printoutId);
    setLists(checklists.map(c => c.id !== activeId ? c : {
      ...c, printouts: c.printouts.filter(p => p.id !== printoutId),
    }));
  };

  // ── Sorted items ────────────────────────────────────────────────────────────
  const sortedItems = active ? [
    ...active.items.filter(i => !i.done).sort((a, b) => a.order - b.order),
    ...active.items.filter(i => i.done).sort((a, b) => a.order - b.order),
  ] : [];
  const undoneItems = sortedItems.filter(i => !i.done);
  const doneItems = sortedItems.filter(i => i.done);

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="h-full flex flex-col bg-slate-50 dark:bg-slate-950">
      {/* Top bar */}
      <div className="shrink-0 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-3 sm:px-6 py-3 flex flex-wrap items-center gap-x-3 gap-y-2 sm:gap-4">
        {/* Mobile sidebar toggle */}
        {checklists.length > 1 && (
          <button
            onClick={() => setSidebarOpen(true)}
            className="md:hidden p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500"
            title="Switch list"
          >
            <ClipboardList size={18} />
          </button>
        )}

        <div className="hidden sm:flex items-center gap-2 text-slate-500 dark:text-slate-400">
          <ClipboardList size={20} />
          <span className="text-sm font-medium">Checklists</span>
        </div>
        <div className="hidden sm:block h-5 w-px bg-slate-200 dark:bg-slate-700" />

        {/* Checklist name */}
        {active && (
          editingName ? (
            <div className="flex items-center gap-2 min-w-0">
              <input
                autoFocus
                value={nameInput}
                onChange={e => setNameInput(e.target.value)}
                onBlur={commitRename}
                onKeyDown={e => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') setEditingName(false);
                }}
                className="text-sm font-semibold bg-transparent border-b-2 border-accent-500 outline-none text-slate-900 dark:text-slate-100 min-w-0 flex-1"
              />
              <button onClick={commitRename} className="p-1 text-accent-600"><Check size={14} /></button>
            </div>
          ) : (
            <button
              onClick={() => { setNameInput(active.name); setEditingName(true); }}
              className="flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-slate-100 hover:text-accent-600 transition-colors group min-w-0"
            >
              <span className="truncate">{active.name}</span>
              <Edit2 size={13} className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-slate-400" />
            </button>
          )
        )}

        <div className="flex-1" />

        {/* Progress bar */}
        {active && totalCount > 0 && (
          <div className="hidden sm:flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
            <div className="w-24 h-2 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-green-500 rounded-full transition-all"
                style={{ width: `${(doneCount / totalCount) * 100}%` }}
              />
            </div>
            <span>{doneCount}/{totalCount}</span>
          </div>
        )}

        {/* Print */}
        {active && (
          <button
            onClick={handlePrint}
            disabled={generating}
            className="flex items-center gap-2 px-3 sm:px-4 py-2 bg-accent-600 text-white rounded-xl hover:bg-accent-700 disabled:opacity-50 text-sm font-medium shadow-sm"
          >
            <Printer size={16} />
            <span className="hidden sm:inline">{generating ? 'Generating...' : 'Print PDF'}</span>
          </button>
        )}

        {/* New */}
        <button
          onClick={handleNew}
          className="flex items-center gap-2 px-3 sm:px-4 py-2 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-xl hover:bg-slate-200 dark:hover:bg-slate-700 text-sm font-medium"
        >
          <Plus size={16} /> <span className="hidden sm:inline">New</span>
        </button>
      </div>

      <div className="flex-1 flex overflow-hidden relative">
        {/* Mobile sidebar overlay */}
        {checklists.length > 1 && sidebarOpen && (
          <div
            className="md:hidden fixed inset-0 bg-black/40 z-40"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* Sidebar: shown when >1 list; slide-over on mobile, inline on desktop */}
        {checklists.length > 1 && (
          <div
            className={`${
              sidebarOpen
                ? 'fixed md:static inset-y-0 left-0 z-50 w-64 md:w-56 translate-x-0'
                : 'fixed md:static inset-y-0 left-0 z-50 w-64 md:w-56 -translate-x-full md:translate-x-0'
            } transition-transform duration-200 shrink-0 bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 flex flex-col overflow-y-auto`}
          >
            <div className="px-4 pt-4 pb-2 flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wide">Lists</span>
              <button
                onClick={() => setSidebarOpen(false)}
                className="md:hidden p-1 rounded text-slate-400 hover:text-slate-600"
              >
                <X size={16} />
              </button>
            </div>
            <div className="px-2 pb-4 space-y-0.5">
              {checklists.map(list => (
                <div
                  key={list.id}
                  onClick={() => { switchList(list.id); setSidebarOpen(false); }}
                  className={`group flex items-center gap-2 rounded-xl px-2 py-2 cursor-pointer transition-all ${
                    list.id === activeId
                      ? 'bg-accent-50 dark:bg-accent-900/30 text-accent-700 dark:text-accent-300'
                      : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                >
                  <ClipboardList size={15} className="shrink-0 opacity-60" />
                  <span className="flex-1 text-sm font-medium truncate">{list.name}</span>
                  <button
                    onClick={e => { e.stopPropagation(); handleDeleteList(list.id); }}
                    className="opacity-0 group-hover:opacity-100 p-0.5 text-slate-400 hover:text-red-500 transition-all"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Main area */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {!active ? (
            /* Empty state */
            <div className="flex-1 flex flex-col items-center justify-center gap-5 text-slate-400 dark:text-slate-500">
              <ClipboardList size={60} className="opacity-20" />
              <p className="text-lg font-medium">No checklist yet</p>
              <button
                onClick={handleNew}
                className="flex items-center gap-2 px-5 py-2.5 bg-accent-600 text-white rounded-xl hover:bg-accent-700 text-sm font-medium shadow-sm"
              >
                <Plus size={16} /> Create your first checklist
              </button>
            </div>
          ) : (
            <>
              {/* Sub-tabs */}
              <div className="shrink-0 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-4 sm:px-6 flex items-center gap-4 sm:gap-6 overflow-x-auto">
                {(['items', 'printouts'] as const).map(tab => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                      activeTab === tab
                        ? 'border-accent-600 text-accent-600'
                        : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-300'
                    }`}
                  >
                    {tab === 'printouts'
                      ? `Printouts (${active.printouts.length})`
                      : `Items (${totalCount})`}
                  </button>
                ))}
                {/* Mobile progress */}
                {totalCount > 0 && (
                  <div className="sm:hidden ml-auto flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                    <div className="w-16 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                      <div className="h-full bg-green-500 rounded-full" style={{ width: `${(doneCount / totalCount) * 100}%` }} />
                    </div>
                    <span>{doneCount}/{totalCount}</span>
                  </div>
                )}
              </div>

              <div className="flex-1 overflow-y-auto p-3 sm:p-6">
                {activeTab === 'items' ? (
                  /* ── Items tab ── */
                  <div className="max-w-3xl mx-auto space-y-2">
                    {totalCount === 0 && (
                      <div className="text-center py-16 text-slate-400 dark:text-slate-500">
                        <CheckSquare size={40} className="mx-auto mb-3 opacity-30" />
                        <p className="text-sm">No items yet. Add your first item below.</p>
                      </div>
                    )}

                    {/* Pending items */}
                    {undoneItems.map(item => (
                      <ItemCard
                        key={item.id}
                        item={item}
                        expanded={expandedItemId === item.id}
                        beforePhotos={beforePhotos[item.id]}
                        afterPhotos={afterPhotos[item.id]}
                        onToggle={() => updateItem(item.id, { done: true })}
                        onExpand={() => setExpandedItemId(expandedItemId === item.id ? null : item.id)}
                        onUpdate={patch => updateItem(item.id, patch)}
                        onDelete={() => deleteItem(item.id)}
                        onPhotoUpload={(type, file) => handlePhotoUpload(item.id, type, file)}
                        onRemovePhoto={(type, index) => handleRemovePhoto(item.id, type, index)}
                      />
                    ))}

                    {/* Divider before done items */}
                    {doneItems.length > 0 && undoneItems.length > 0 && (
                      <div className="flex items-center gap-3 py-2">
                        <div className="flex-1 h-px bg-slate-200 dark:bg-slate-700" />
                        <span className="text-xs font-medium text-slate-400 dark:text-slate-500 uppercase tracking-wide">
                          Completed · {doneItems.length}
                        </span>
                        <div className="flex-1 h-px bg-slate-200 dark:bg-slate-700" />
                      </div>
                    )}

                    {/* Done items */}
                    <div className={doneItems.length > 0 ? 'opacity-70 space-y-2' : ''}>
                      {doneItems.map(item => (
                        <ItemCard
                          key={item.id}
                          item={item}
                          expanded={expandedItemId === item.id}
                          beforePhotos={beforePhotos[item.id]}
                          afterPhotos={afterPhotos[item.id]}
                          onToggle={() => updateItem(item.id, { done: false })}
                          onExpand={() => setExpandedItemId(expandedItemId === item.id ? null : item.id)}
                          onUpdate={patch => updateItem(item.id, patch)}
                          onDelete={() => deleteItem(item.id)}
                          onPhotoUpload={(type, file) => handlePhotoUpload(item.id, type, file)}
                          onRemovePhoto={(type, index) => handleRemovePhoto(item.id, type, index)}
                        />
                      ))}
                    </div>

                    {/* Add item button */}
                    <button
                      onClick={handleAddItem}
                      className="w-full flex items-center justify-center gap-2 py-3 border-2 border-dashed border-slate-200 dark:border-slate-700 text-slate-400 dark:text-slate-500 rounded-xl hover:border-accent-400 hover:text-accent-500 transition-colors text-sm font-medium mt-2"
                    >
                      <Plus size={16} /> Add Item
                    </button>
                  </div>
                ) : (
                  /* ── Printouts tab ── */
                  <div className="max-w-5xl mx-auto space-y-6">
                    <div className="flex justify-between items-center">
                      <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100">Printouts</h2>
                      <p className="text-sm text-slate-500">{active.printouts.length} files saved</p>
                    </div>

                    {active.printouts.length === 0 ? (
                      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 p-12 text-center">
                        <div className="w-16 h-16 bg-slate-50 dark:bg-slate-800 rounded-full flex items-center justify-center mx-auto mb-4 text-slate-400">
                          <Printer size={32} />
                        </div>
                        <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-1">No printouts yet</h3>
                        <p className="text-slate-500 dark:text-slate-400 text-sm max-w-xs mx-auto">
                          Click "Print PDF" to generate a checklist report.
                        </p>
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
                        {[...active.printouts].sort((a, b) => b.createdAt - a.createdAt).map(po => (
                          <div key={po.id} className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden hover:shadow-md transition-all">
                            <div className="p-4 sm:p-6">
                              <div className="flex items-start justify-between mb-4">
                                <div className="w-12 h-12 bg-accent-50 dark:bg-accent-900/30 text-accent-600 rounded-xl flex items-center justify-center shrink-0">
                                  <FileText size={24} />
                                </div>
                                <div className="flex items-center gap-0.5 flex-wrap justify-end">
                                  <button
                                    onClick={() => handleSharePrintout(po)}
                                    className="p-2 text-slate-400 hover:text-accent-600 hover:bg-accent-50 dark:hover:bg-accent-900/30 rounded-lg transition-colors"
                                    title="Copy share link"
                                  >
                                    <Share2 size={18} />
                                  </button>
                                  <button
                                    onClick={() => handleViewPrintout(po)}
                                    className="p-2 text-slate-400 hover:text-accent-600 hover:bg-accent-50 dark:hover:bg-accent-900/30 rounded-lg transition-colors"
                                    title="View PDF"
                                  >
                                    <Eye size={18} />
                                  </button>
                                  <button
                                    onClick={() => handleDownloadPrintout(po)}
                                    className="p-2 text-slate-400 hover:text-accent-600 hover:bg-accent-50 dark:hover:bg-accent-900/30 rounded-lg transition-colors"
                                    title="Download PDF"
                                  >
                                    <Download size={18} />
                                  </button>
                                  <button
                                    onClick={() => handleDeletePrintout(po.id)}
                                    className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg transition-colors"
                                    title="Delete"
                                  >
                                    <Trash2 size={18} />
                                  </button>
                                </div>
                              </div>
                              <h3 className="font-semibold text-slate-900 dark:text-slate-100 mb-1 line-clamp-1">{po.name}</h3>
                              <p className="text-xs text-slate-500 dark:text-slate-400">
                                Generated on {new Date(po.createdAt).toLocaleString()}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
