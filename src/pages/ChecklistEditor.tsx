import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CheckSquare, Plus, Trash2, Camera, MapPin,
  FileText, Printer, Download, Eye, ClipboardList,
  ChevronDown, ChevronUp, X, Edit2, Check, Share2,
  GripVertical, MessageSquare, Loader2,
} from 'lucide-react';
import { jsPDF } from 'jspdf';
import { saveFile, getFile, createShare, getSettings, getChecklists, saveChecklist, deleteChecklist } from '../utils/store';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import { useShareLink } from '../components/ShareLinkModal';

// ─── IDB helpers ─────────────────────────────────────────────────────────────
// The legacy 'checklist-db' stored everything locally. New code uses the server.
// 'checklist-pdfs' is kept as a local cache for generated PDF blobs only.

const PDF_DB_NAME = 'checklist-pdfs';
const PDF_DB_VERSION = 1;
const LEGACY_DB_NAME = 'checklist-db';

function openPdfIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PDF_DB_NAME, PDF_DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains('pdfs')) db.createObjectStore('pdfs');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Opens the legacy IDB if it exists (returns null if absent or on error).
function openLegacyIDB(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    const probe = indexedDB.open(LEGACY_DB_NAME);
    probe.onupgradeneeded = () => {
      // DB didn't exist — abort so we leave no trace
      probe.transaction?.abort();
      probe.result.close();
      resolve(null);
    };
    probe.onsuccess = () => resolve(probe.result);
    probe.onerror = () => resolve(null);
  });
}

function idbGetAllKeysFromStore(db: IDBDatabase, store: string): Promise<string[]> {
  return new Promise((resolve) => {
    try {
      if (!db.objectStoreNames.contains(store)) { resolve([]); return; }
      const req = db.transaction(store, 'readonly').objectStore(store).getAllKeys();
      req.onsuccess = () => resolve(req.result as string[]);
      req.onerror = () => resolve([]);
    } catch { resolve([]); }
  });
}

function idbGetFromStore<T>(db: IDBDatabase, store: string, key: string): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      if (!db.objectStoreNames.contains(store)) { resolve(null); return; }
      const req = db.transaction(store, 'readonly').objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

// One-time migration: read all data from legacy IDB and push to server.
// Runs only if localStorage flag 'checklist-migrated' is not set.
async function migrateFromLegacyIDB(): Promise<Checklist[]> {
  if (localStorage.getItem('checklist-migrated')) return [];
  const db = await openLegacyIDB();
  if (!db) { localStorage.setItem('checklist-migrated', '1'); return []; }

  try {
    const keys = await idbGetAllKeysFromStore(db, 'checklists');
    if (keys.length === 0) { localStorage.setItem('checklist-migrated', '1'); return []; }

    const migrated: Checklist[] = [];
    for (const key of keys) {
      const list = await idbGetFromStore<Checklist>(db, 'checklists', key);
      if (!list) continue;

      // Migrate photos: read from legacy 'photos' store and upload to server
      for (const item of list.items) {
        const newBeforeIds: string[] = [];
        for (const pid of item.beforePhotoIds ?? []) {
          const dataUrl = await idbGetFromStore<string>(db, 'photos', pid);
          if (dataUrl) {
            const newId = `checklist-photo-${nanoid()}`;
            await saveFile(newId, dataUrl).catch(() => {});
            newBeforeIds.push(newId);
          }
        }
        if (newBeforeIds.length) item.beforePhotoIds = newBeforeIds;

        const newAfterIds: string[] = [];
        for (const pid of item.afterPhotoIds ?? []) {
          const dataUrl = await idbGetFromStore<string>(db, 'photos', pid);
          if (dataUrl) {
            const newId = `checklist-photo-${nanoid()}`;
            await saveFile(newId, dataUrl).catch(() => {});
            newAfterIds.push(newId);
          }
        }
        if (newAfterIds.length) item.afterPhotoIds = newAfterIds;
      }

      await saveChecklist(list).catch(() => {});
      migrated.push(list);
    }

    localStorage.setItem('checklist-migrated', '1');
    return migrated;
  } catch {
    return [];
  } finally {
    db.close();
  }
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
  inProgressPhotoIds?: string[];
  afterPhotoIds?: string[];
  comments?: string;
  createdAt: number;
}

type PhotoStage = 'before' | 'in_progress' | 'after';

const PHOTO_STAGE_LABEL: Record<PhotoStage, string> = {
  before: 'Before',
  in_progress: 'In Progress',
  after: 'After',
};

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
  type: PhotoStage;
  label: string;
  photos: string[];
  inputRef: React.RefObject<HTMLInputElement>;
  onPhotoUpload: (type: PhotoStage, file: File) => void;
  onRemovePhoto: (type: PhotoStage, index: number) => void;
  onClickPhoto: (src: string) => void;
}

const PhotoSection: React.FC<PhotoSectionProps> = ({
  type, label, photos, inputRef, onPhotoUpload, onRemovePhoto, onClickPhoto,
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
              <img
                src={src}
                onClick={() => onClickPhoto(src)}
                className="w-full h-24 object-cover rounded-lg border border-slate-200 dark:border-slate-700 cursor-zoom-in"
                alt={`${type} ${idx + 1}`}
              />
              <button
                onClick={(e) => { e.stopPropagation(); onRemovePhoto(type, idx); }}
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
        {dragOver ? 'Drop to upload' : `Add ${PHOTO_STAGE_LABEL[type]} Photo`}
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
  inProgressPhotos?: string[];
  afterPhotos?: string[];
  onToggle: () => void;
  onExpand: () => void;
  onUpdate: (patch: Partial<ChecklistItem>) => void;
  onDelete: () => void;
  onPhotoUpload: (type: PhotoStage, file: File) => void;
  onRemovePhoto: (type: PhotoStage, index: number) => void;
  onClickPhoto: (src: string) => void;
  // Drag/drop reorder
  onDragHandleStart: (e: React.DragEvent) => void;
  onDragOverItem: (e: React.DragEvent) => void;
  onDropOnItem: (e: React.DragEvent) => void;
  onDragEndItem: () => void;
  isDraggedOver: boolean;
}

const ItemCard: React.FC<ItemCardProps> = ({
  item, expanded, beforePhotos, inProgressPhotos, afterPhotos,
  onToggle, onExpand, onUpdate, onDelete, onPhotoUpload, onRemovePhoto, onClickPhoto,
  onDragHandleStart, onDragOverItem, onDropOnItem, onDragEndItem, isDraggedOver,
}) => {
  const beforeRef = useRef<HTMLInputElement>(null);
  const inProgressRef = useRef<HTMLInputElement>(null);
  const afterRef = useRef<HTMLInputElement>(null);
  const bPhotos = beforePhotos ?? [];
  const iPhotos = inProgressPhotos ?? [];
  const aPhotos = afterPhotos ?? [];
  const totalThumbs = bPhotos.length + iPhotos.length + aPhotos.length;

  return (
    <div
      onDragOver={onDragOverItem}
      onDrop={onDropOnItem}
      onDragEnd={onDragEndItem}
      className={`bg-white dark:bg-slate-900 rounded-xl border transition-all ${
        isDraggedOver ? 'border-accent-500 ring-2 ring-accent-200 dark:ring-accent-900/40' :
        item.done ? 'border-green-200 dark:border-green-800/40' : 'border-slate-200 dark:border-slate-700'
      }`}
    >
      {/* Row */}
      <div className="flex items-center gap-2 px-2 py-3 sm:gap-3 sm:px-4">
        {/* Drag handle */}
        <button
          draggable
          onDragStart={onDragHandleStart}
          onDragEnd={onDragEndItem}
          title="Drag to reorder"
          className="shrink-0 cursor-grab active:cursor-grabbing text-slate-300 hover:text-slate-500 dark:text-slate-600 dark:hover:text-slate-400 touch-none"
        >
          <GripVertical size={16} />
        </button>

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
          <div className="flex items-center gap-3 mt-0.5 text-xs text-slate-400 dark:text-slate-500">
            {item.location && (
              <span className="flex items-center gap-1 truncate">
                <MapPin size={11} />{item.location}
              </span>
            )}
            {item.comments && item.comments.trim() && (
              <span className="flex items-center gap-1 shrink-0">
                <MessageSquare size={11} /> Note
              </span>
            )}
          </div>
        </button>

        {/* Photo thumbnails */}
        <div className="flex items-center gap-1.5 shrink-0">
          {bPhotos.slice(0, 2).map((src, i) => (
            <button
              key={`b${i}`}
              onClick={(e) => { e.stopPropagation(); onClickPhoto(src); }}
              className="w-7 h-7 rounded overflow-hidden border border-slate-200 dark:border-slate-700 cursor-zoom-in"
            >
              <img src={src} className="w-full h-full object-cover" alt="before" />
            </button>
          ))}
          {iPhotos.slice(0, 1).map((src, i) => (
            <button
              key={`i${i}`}
              onClick={(e) => { e.stopPropagation(); onClickPhoto(src); }}
              className="w-7 h-7 rounded overflow-hidden border border-amber-300 dark:border-amber-700 cursor-zoom-in"
            >
              <img src={src} className="w-full h-full object-cover" alt="in progress" />
            </button>
          ))}
          {aPhotos.slice(0, 2).map((src, i) => (
            <button
              key={`a${i}`}
              onClick={(e) => { e.stopPropagation(); onClickPhoto(src); }}
              className="w-7 h-7 rounded overflow-hidden border border-slate-200 dark:border-slate-700 cursor-zoom-in"
            >
              <img src={src} className="w-full h-full object-cover" alt="after" />
            </button>
          ))}
          {totalThumbs > 5 && (
            <div className="h-7 px-1.5 rounded bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-[10px] font-medium text-slate-500">
              +{totalThumbs - 5}
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

          <div>
            <label className="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
              <MessageSquare size={11} /> Comments
            </label>
            <textarea
              value={item.comments ?? ''}
              onChange={e => onUpdate({ comments: e.target.value })}
              rows={2}
              placeholder="Notes, blockers, reasons this can't be completed yet..."
              className="w-full text-sm px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder-slate-400 resize-none focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-transparent"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <PhotoSection
              type="before"
              label="Before Photos"
              photos={bPhotos}
              inputRef={beforeRef}
              onPhotoUpload={onPhotoUpload}
              onRemovePhoto={onRemovePhoto}
              onClickPhoto={onClickPhoto}
            />
            <PhotoSection
              type="in_progress"
              label="In-Progress Photos"
              photos={iPhotos}
              inputRef={inProgressRef}
              onPhotoUpload={onPhotoUpload}
              onRemovePhoto={onRemovePhoto}
              onClickPhoto={onClickPhoto}
            />
            <PhotoSection
              type="after"
              label="After Photos"
              photos={aPhotos}
              inputRef={afterRef}
              onPhotoUpload={onPhotoUpload}
              onRemovePhoto={onRemovePhoto}
              onClickPhoto={onClickPhoto}
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
  const { toast } = useToast();
  const confirm = useConfirm();
  const shareLink = useShareLink();
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'items' | 'printouts'>('items');
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [beforePhotos, setBeforePhotos] = useState<Record<string, string[]>>({});
  const [inProgressPhotos, setInProgressPhotos] = useState<Record<string, string[]>>({});
  const [afterPhotos, setAfterPhotos] = useState<Record<string, string[]>>({});
  const [draggingItemId, setDraggingItemId] = useState<string | null>(null);
  const [dragOverItemId, setDragOverItemId] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateMsg, setGenerateMsg] = useState('');
  const [loading, setLoading] = useState(true);
  // Captures any error from the checklists fetch so it's visible to the user
  // (and to us via console) instead of being silently swallowed into an
  // empty-state-looking UI when the server is reachable but returning
  // something the client can't read.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);

  useEffect(() => {
    if (!lightboxImage) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightboxImage(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxImage]);

  const pdfDbRef = useRef<IDBDatabase | null>(null);
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
      // Open PDF IDB cache
      pdfDbRef.current = await openPdfIDB().catch(() => null);

      // One-time migration from legacy local-only IDB to server storage
      await migrateFromLegacyIDB().catch(console.error);

      // Load checklists from server. Don't swallow errors — surface them so
      // the user (and we) can see when the request fails for a real reason
      // rather than landing in the "no checklist yet" empty state by default.
      let loaded: Checklist[] = [];
      try {
        const raw = await getChecklists();
        if (!Array.isArray(raw)) {
          throw new Error(`Server returned ${typeof raw} instead of an array`);
        }
        loaded = raw as Checklist[];
        setLoadError(null);
      } catch (err: any) {
        // eslint-disable-next-line no-console
        console.error('[Checklists] Failed to load from server:', err);
        setLoadError(err?.message || 'Unknown error');
      }
      setChecklists(loaded);

      // Restore last active list from localStorage
      const savedId = localStorage.getItem('checklist-activeId');
      const aid = (savedId && loaded.find(c => c.id === savedId)) ? savedId : loaded[0]?.id ?? null;
      setActiveId(aid);

      if (aid) {
        const list = loaded.find(c => c.id === aid);
        if (list) await loadPhotosForList(list);
      }
      setLoading(false);
    })().catch(console.error);
  }, []);

  const loadPhotosForList = async (list: Checklist) => {
    const allIds = list.items.flatMap(item => [
      ...(item.beforePhotoIds ?? []).map(pid => ({ pid, itemId: item.id, type: 'before' as PhotoStage })),
      ...(item.inProgressPhotoIds ?? []).map(pid => ({ pid, itemId: item.id, type: 'in_progress' as PhotoStage })),
      ...(item.afterPhotoIds ?? []).map(pid => ({ pid, itemId: item.id, type: 'after' as PhotoStage })),
    ]);
    const before: Record<string, string[]> = {};
    const inProgress: Record<string, string[]> = {};
    const after: Record<string, string[]> = {};
    await Promise.all(allIds.map(async ({ pid, itemId, type }) => {
      const url = await getFile(pid).catch(() => null);
      if (!url) return;
      if (type === 'before') before[itemId] = [...(before[itemId] ?? []), url];
      else if (type === 'in_progress') inProgress[itemId] = [...(inProgress[itemId] ?? []), url];
      else after[itemId] = [...(after[itemId] ?? []), url];
    }));
    setBeforePhotos(before);
    setInProgressPhotos(inProgress);
    setAfterPhotos(after);
  };

  // ── Persistence ─────────────────────────────────────────────────────────────
  const persist = useCallback((lists: Checklist[]) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const aid = activeIdRef.current;
      const list = lists.find(c => c.id === aid);
      if (list) await saveChecklist(list).catch(console.error);
    }, 700);
  }, []);

  const setLists = useCallback((updated: Checklist[]) => {
    setChecklists(updated);
    persist(updated);
  }, [persist]);

  // ── Checklist CRUD ──────────────────────────────────────────────────────────
  const handleNew = async () => {
    const id = nanoid();
    const list: Checklist = {
      id, name: `Checklist ${checklists.length + 1}`,
      createdAt: Date.now(), items: [], printouts: [],
    };
    await saveChecklist(list).catch(console.error);
    const updated = [...checklists, list];
    setChecklists(updated);
    setActiveId(id);
    localStorage.setItem('checklist-activeId', id);
    setActiveTab('items');
    setExpandedItemId(null);
    setBeforePhotos({});
    setAfterPhotos({});
  };

  const handleDeleteList = async (id: string) => {
    if (!await confirm({ title: 'Delete checklist', message: 'Delete this checklist and all its items?', confirmLabel: 'Delete', tone: 'danger' })) return;
    const list = checklists.find(c => c.id === id);
    // Photos are stored in /api/images under their photo IDs; leave them for now
    // (the images endpoint has no delete in the current server design)
    await deleteChecklist(id).catch(console.error);
    const updated = checklists.filter(c => c.id !== id);
    setChecklists(updated);
    if (activeId === id) {
      const next = updated[0]?.id ?? null;
      setActiveId(next);
      if (next) {
        localStorage.setItem('checklist-activeId', next);
        const nextList = updated.find(c => c.id === next);
        if (nextList) await loadPhotosForList(nextList);
      } else {
        localStorage.removeItem('checklist-activeId');
        setBeforePhotos({});
        setAfterPhotos({});
      }
    }
    void list; // suppress unused warning
  };

  const switchList = async (id: string) => {
    setActiveId(id);
    localStorage.setItem('checklist-activeId', id);
    setActiveTab('items');
    setExpandedItemId(null);
    const list = checklistsRef.current.find(c => c.id === id);
    if (list) await loadPhotosForList(list);
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
    setBeforePhotos(p => { const n = { ...p }; delete n[itemId]; return n; });
    setInProgressPhotos(p => { const n = { ...p }; delete n[itemId]; return n; });
    setAfterPhotos(p => { const n = { ...p }; delete n[itemId]; return n; });
    setLists(checklists.map(c => c.id !== activeId ? c : {
      ...c, items: c.items.filter(i => i.id !== itemId),
    }));
    if (expandedItemId === itemId) setExpandedItemId(null);
  };

  // ── Photos ──────────────────────────────────────────────────────────────────
  const handlePhotoUpload = async (itemId: string, type: PhotoStage, file: File) => {
    if (!file.type.startsWith('image/')) return;
    const dataUrl = await normalizeImage(file);
    const photoId = `checklist-photo-${nanoid()}`;

    // Save to server so it's accessible cross-device
    await saveFile(photoId, dataUrl).catch(console.error);

    const list = checklistsRef.current.find(c => c.id === activeIdRef.current);
    const currentItem = list?.items.find(i => i.id === itemId);
    if (!currentItem) return;

    if (type === 'before') {
      const newIds = [...(currentItem.beforePhotoIds ?? []), photoId];
      setBeforePhotos(p => ({ ...p, [itemId]: [...(p[itemId] ?? []), dataUrl] }));
      updateItem(itemId, { beforePhotoIds: newIds });
    } else if (type === 'in_progress') {
      const newIds = [...(currentItem.inProgressPhotoIds ?? []), photoId];
      setInProgressPhotos(p => ({ ...p, [itemId]: [...(p[itemId] ?? []), dataUrl] }));
      updateItem(itemId, { inProgressPhotoIds: newIds });
    } else {
      const newIds = [...(currentItem.afterPhotoIds ?? []), photoId];
      setAfterPhotos(p => ({ ...p, [itemId]: [...(p[itemId] ?? []), dataUrl] }));
      updateItem(itemId, { afterPhotoIds: newIds });
    }
  };

  const handleRemovePhoto = async (itemId: string, type: PhotoStage, index: number) => {
    const list = checklistsRef.current.find(c => c.id === activeIdRef.current);
    const currentItem = list?.items.find(i => i.id === itemId);
    if (!currentItem) return;

    if (type === 'before') {
      const ids = currentItem.beforePhotoIds ?? [];
      setBeforePhotos(p => {
        const photos = [...(p[itemId] ?? [])];
        photos.splice(index, 1);
        return { ...p, [itemId]: photos };
      });
      updateItem(itemId, { beforePhotoIds: ids.filter((_, i) => i !== index) });
    } else if (type === 'in_progress') {
      const ids = currentItem.inProgressPhotoIds ?? [];
      setInProgressPhotos(p => {
        const photos = [...(p[itemId] ?? [])];
        photos.splice(index, 1);
        return { ...p, [itemId]: photos };
      });
      updateItem(itemId, { inProgressPhotoIds: ids.filter((_, i) => i !== index) });
    } else {
      const ids = currentItem.afterPhotoIds ?? [];
      setAfterPhotos(p => {
        const photos = [...(p[itemId] ?? [])];
        photos.splice(index, 1);
        return { ...p, [itemId]: photos };
      });
      updateItem(itemId, { afterPhotoIds: ids.filter((_, i) => i !== index) });
    }
  };

  // ── Reorder ─────────────────────────────────────────────────────────────────
  const handleReorder = (draggedId: string, targetId: string) => {
    if (!active || draggedId === targetId) return;

    // Compute the visible order (pending first, then completed) and renumber
    // contiguously after splicing the dragged item to its new slot. Cross-section
    // drops are allowed; the dragged item's `done` state is not changed.
    const ordered = [
      ...active.items.filter(i => !i.done).sort((a, b) => a.order - b.order),
      ...active.items.filter(i => i.done).sort((a, b) => a.order - b.order),
    ];
    const fromIdx = ordered.findIndex(i => i.id === draggedId);
    const toIdx = ordered.findIndex(i => i.id === targetId);
    if (fromIdx < 0 || toIdx < 0) return;

    const [moved] = ordered.splice(fromIdx, 1);
    ordered.splice(toIdx, 0, moved);

    const orderMap = new Map(ordered.map((it, idx) => [it.id, idx]));
    setLists(checklists.map(c => c.id !== activeId ? c : {
      ...c,
      items: c.items.map(i => ({ ...i, order: orderMap.get(i.id) ?? i.order })),
    }));
  };

  // ── PDF Generation ──────────────────────────────────────────────────────────
  const handlePrint = async () => {
    if (!active || generating) return;
    setGenerating(true);
    setGenerateMsg('Building checklist PDF…');
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
        const iPhotosArr = inProgressPhotos[item.id] ?? [];
        const aPhotosArr = afterPhotos[item.id] ?? [];
        const hasPhotos = bPhotosArr.length > 0 || iPhotosArr.length > 0 || aPhotosArr.length > 0;
        const photoGroupCount = (bPhotosArr.length > 0 ? 1 : 0) + (iPhotosArr.length > 0 ? 1 : 0) + (aPhotosArr.length > 0 ? 1 : 0);
        const interGroupGap = Math.max(0, photoGroupCount - 1) * 6;

        const photosTotalH =
          photoGroupH(bPhotosArr.length) +
          photoGroupH(iPhotosArr.length) +
          photoGroupH(aPhotosArr.length) +
          interGroupGap;

        // Optional comments block
        const commentTw = W - margin * 2 - 44;
        const commentLines = item.comments && item.comments.trim()
          ? pdf.splitTextToSize(item.comments.trim(), commentTw) as string[]
          : [];
        const commentH = commentLines.length > 0 ? 14 + commentLines.length * 11 + 4 : 0;

        const baseH = hasPhotos ? 52 + photosTotalH + 12 : 72;
        const boxH = baseH + commentH;

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
            photoY += used + (iPhotosArr.length > 0 || aPhotosArr.length > 0 ? 6 : 0);
          }
          if (iPhotosArr.length > 0) {
            const used = drawPhotoGroup('IN PROGRESS', iPhotosArr, tx, photoY, photoMaxW);
            photoY += used + (aPhotosArr.length > 0 ? 6 : 0);
          }
          if (aPhotosArr.length > 0) {
            drawPhotoGroup('AFTER', aPhotosArr, tx, photoY, photoMaxW);
          }
        }

        // Comments block (rendered at the bottom of the box)
        if (commentLines.length > 0) {
          const commentY = y + baseH;
          pdf.setFontSize(7);
          pdf.setFont('helvetica', 'bold');
          pdf.setTextColor(148, 163, 184);
          pdf.text('NOTES', margin + 12, commentY + 9);
          pdf.setFontSize(9);
          pdf.setFont('helvetica', 'italic');
          pdf.setTextColor(71, 85, 105);
          pdf.text(commentLines, margin + 12, commentY + 20);
        }

        y += boxH + 8;
      };

      if (undone.length > 0) {
        drawSection('Pending', undone.length);
        undone.forEach((item, i) => {
          setGenerateMsg(`Drawing item ${i + 1} of ${totalCount}…`);
          drawItem(item, i, false);
        });
      }

      if (done.length > 0) {
        if (undone.length > 0) y += 8;
        drawSection('Completed', done.length);
        done.forEach((item, i) => {
          setGenerateMsg(`Drawing item ${undone.length + i + 1} of ${totalCount}…`);
          drawItem(item, i, true);
        });
      }

      if (totalCount === 0) {
        pdf.setFontSize(12);
        pdf.setTextColor(148, 163, 184);
        pdf.text('No items in this checklist.', W / 2, y + 40, { align: 'center' });
      }

      setGenerateMsg('Saving…');
      const pdfDataUrl = pdf.output('datauristring');
      const printoutId = nanoid();
      const printoutName = `${active.name} — ${new Date().toLocaleString()}`;
      const fileId = `checklist-${printoutId}`;

      // Save to the server so the PDF editor and share links can retrieve it.
      // Also keep a local IDB copy as an offline fallback.
      try { await saveFile(fileId, pdfDataUrl); } catch (err) { console.warn('saveFile failed', err); }
      const pdfDb = pdfDbRef.current;
      if (pdfDb) await idbPut(pdfDb, 'pdfs', pdfDataUrl, printoutId).catch(() => {});

      const po: ChecklistPrintout = { id: printoutId, name: printoutName, createdAt: Date.now(), fileId };
      const updated = checklists.map(c => c.id !== activeId ? c : {
        ...c, printouts: [...c.printouts, po],
      });
      setLists(updated);
      setActiveTab('printouts');
    } finally {
      setGenerating(false);
      setGenerateMsg('');
    }
  };

  // ── Printout actions ────────────────────────────────────────────────────────
  const getPdfDataUrl = async (po: ChecklistPrintout): Promise<string | undefined> => {
    if (po.fileId) {
      const fromServer = await getFile(po.fileId).catch(() => null);
      if (fromServer) return fromServer;
    }
    // Fall back to local IDB cache (e.g. offline or pre-migration printouts)
    const pdfDb = pdfDbRef.current;
    return pdfDb ? idbGet<string>(pdfDb, 'pdfs', po.id) : undefined;
  };

  const handleViewPrintout = async (po: ChecklistPrintout) => {
    const dataUrl = await getPdfDataUrl(po);
    if (!dataUrl) return;
    const fileName = po.name.endsWith('.pdf') ? po.name : `${po.name}.pdf`;
    const file = await dataUrlToFile(dataUrl, fileName, 'application/pdf');
    const source = po.fileId
      ? { projectId: activeIdRef.current ?? '', printoutId: po.id, fileId: po.fileId }
      : undefined;
    navigate('/tools/pdf', { state: { file, source } });
  };

  const handleDownloadPrintout = async (po: ChecklistPrintout) => {
    const data = await getPdfDataUrl(po);
    if (!data) return;
    const a = document.createElement('a');
    a.href = data;
    a.download = po.name.endsWith('.pdf') ? po.name : `${po.name}.pdf`;
    a.click();
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
      shareLink(`${host}/share/${id}`, po.name);
    } catch {
      toast('Failed to create share link', { type: 'error' });
    }
  };

  const handleDeletePrintout = async (printoutId: string) => {
    const pdfDb = pdfDbRef.current;
    if (pdfDb) await idbDelete(pdfDb, 'pdfs', printoutId).catch(() => {});
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

      {/* ── Photo lightbox ── */}
      {lightboxImage && (
        <div
          onClick={() => setLightboxImage(null)}
          className="fixed inset-0 z-[1000] bg-black/85 flex items-center justify-center p-4 cursor-zoom-out"
        >
          <img
            src={lightboxImage}
            onClick={(e) => e.stopPropagation()}
            className="max-w-full max-h-full object-contain rounded shadow-2xl cursor-default"
            alt=""
          />
          <button
            onClick={() => setLightboxImage(null)}
            title="Close (Esc)"
            className="absolute top-4 right-4 p-2 bg-black/40 hover:bg-black/60 text-white rounded-full transition-colors"
          >
            <X size={22} />
          </button>
        </div>
      )}

      {/* ── PDF generation progress overlay ── */}
      {generating && (
        <div className="fixed inset-0 z-[999] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl p-8 w-full max-w-xs mx-4 flex flex-col items-center gap-5">
            <Loader2 size={44} className="text-accent-600 animate-spin" />
            <div className="text-center space-y-2">
              <p className="font-semibold text-slate-800 dark:text-slate-100 text-base">Generating PDF…</p>
              {generateMsg && (
                <p className="text-sm text-slate-500 dark:text-slate-400">{generateMsg}</p>
              )}
              <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">This may take a moment for large checklists</p>
            </div>
          </div>
        </div>
      )}
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
          {loading ? (
            <div className="flex-1 flex items-center justify-center text-slate-400 dark:text-slate-500">
              <p className="text-sm">Loading...</p>
            </div>
          ) : !active ? (
            /* Empty state — or load-error state if the fetch failed. */
            <div className="flex-1 flex flex-col items-center justify-center gap-5 text-slate-400 dark:text-slate-500">
              <ClipboardList size={60} className="opacity-20" />
              {loadError ? (
                <>
                  <p className="text-lg font-medium text-red-500 dark:text-red-400">Couldn't load your checklists</p>
                  <p className="text-sm max-w-md text-center text-slate-500 dark:text-slate-400">
                    {loadError}
                  </p>
                  <p className="text-xs max-w-md text-center text-slate-400 dark:text-slate-500">
                    Your saved lists are still on the server — they're not gone.
                    Check the browser DevTools Network tab for the request to
                    <code className="font-mono mx-1">/api/checklists</code> for a more specific error,
                    and try a hard refresh (Ctrl/Cmd+Shift+R).
                  </p>
                  <button
                    onClick={() => window.location.reload()}
                    className="flex items-center gap-2 px-5 py-2.5 bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-xl hover:bg-slate-300 dark:hover:bg-slate-600 text-sm font-medium"
                  >
                    Reload
                  </button>
                </>
              ) : (
                <>
                  <p className="text-lg font-medium">No checklist yet</p>
                  <button
                    onClick={handleNew}
                    className="flex items-center gap-2 px-5 py-2.5 bg-accent-600 text-white rounded-xl hover:bg-accent-700 text-sm font-medium shadow-sm"
                  >
                    <Plus size={16} /> Create your first checklist
                  </button>
                </>
              )}
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
                        inProgressPhotos={inProgressPhotos[item.id]}
                        afterPhotos={afterPhotos[item.id]}
                        onToggle={() => updateItem(item.id, { done: true })}
                        onExpand={() => setExpandedItemId(expandedItemId === item.id ? null : item.id)}
                        onUpdate={patch => updateItem(item.id, patch)}
                        onDelete={() => deleteItem(item.id)}
                        onPhotoUpload={(type, file) => handlePhotoUpload(item.id, type, file)}
                        onRemovePhoto={(type, index) => handleRemovePhoto(item.id, type, index)}
                        onClickPhoto={setLightboxImage}
                        onDragHandleStart={(e) => {
                          setDraggingItemId(item.id);
                          e.dataTransfer.effectAllowed = 'move';
                          e.dataTransfer.setData('text/plain', item.id);
                        }}
                        onDragOverItem={(e) => {
                          if (!draggingItemId || draggingItemId === item.id) return;
                          e.preventDefault();
                          e.dataTransfer.dropEffect = 'move';
                          if (dragOverItemId !== item.id) setDragOverItemId(item.id);
                        }}
                        onDropOnItem={(e) => {
                          e.preventDefault();
                          if (draggingItemId) handleReorder(draggingItemId, item.id);
                          setDraggingItemId(null);
                          setDragOverItemId(null);
                        }}
                        onDragEndItem={() => { setDraggingItemId(null); setDragOverItemId(null); }}
                        isDraggedOver={dragOverItemId === item.id && draggingItemId !== item.id}
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
                          inProgressPhotos={inProgressPhotos[item.id]}
                          afterPhotos={afterPhotos[item.id]}
                          onToggle={() => updateItem(item.id, { done: false })}
                          onExpand={() => setExpandedItemId(expandedItemId === item.id ? null : item.id)}
                          onUpdate={patch => updateItem(item.id, patch)}
                          onDelete={() => deleteItem(item.id)}
                          onPhotoUpload={(type, file) => handlePhotoUpload(item.id, type, file)}
                          onRemovePhoto={(type, index) => handleRemovePhoto(item.id, type, index)}
                          onClickPhoto={setLightboxImage}
                          onDragHandleStart={(e) => {
                            setDraggingItemId(item.id);
                            e.dataTransfer.effectAllowed = 'move';
                            e.dataTransfer.setData('text/plain', item.id);
                          }}
                          onDragOverItem={(e) => {
                            if (!draggingItemId || draggingItemId === item.id) return;
                            e.preventDefault();
                            e.dataTransfer.dropEffect = 'move';
                            if (dragOverItemId !== item.id) setDragOverItemId(item.id);
                          }}
                          onDropOnItem={(e) => {
                            e.preventDefault();
                            if (draggingItemId) handleReorder(draggingItemId, item.id);
                            setDraggingItemId(null);
                            setDragOverItemId(null);
                          }}
                          onDragEndItem={() => { setDraggingItemId(null); setDragOverItemId(null); }}
                          isDraggedOver={dragOverItemId === item.id && draggingItemId !== item.id}
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
