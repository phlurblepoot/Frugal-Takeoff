import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import {
  Stage, Layer, Line, Rect, Ellipse,
  Text as KonvaText, Image as KonvaImage, Arrow, Transformer,
} from 'react-konva';
import useImage from 'use-image';
import { PDFDocument, rgb } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
// @ts-ignore
import pdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import {
  FolderOpen, Save, Download, MousePointer, Pen, Minus, ArrowRight,
  Square, Circle, Type, Image as ImageIcon, PenLine,
  ChevronDown, ChevronLeft, ChevronRight,
  Undo2, Redo2, Trash2, Plus, X,
  ZoomIn, ZoomOut, Layers, BookOpen,
  PanelLeft, PanelLeftClose, GripVertical,
} from 'lucide-react';
import {
  getFileMeta, fetchFileBlob, saveFileVersion, getDraft, putDraft, deleteDraft,
} from '../utils/store';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import { AddFilesButton } from '../components/documents/AddFilesButton';
import { viewBox } from '../utils/pdfOverlayTransform';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

// ── Types ─────────────────────────────────────────────────────────────────────

type DrawTool = 'freehand' | 'line' | 'arrow' | 'rect' | 'ellipse' | 'text' | 'image' | 'signature';
type ToolType = 'select' | DrawTool;

interface Annotation {
  id: string;
  pageIndex: number;
  type: DrawTool;
  x: number;
  y: number;
  width?: number;
  height?: number;
  points?: number[];
  color: string;
  strokeWidth: number;
  text?: string;
  fontSize?: number;
  imageDataUrl?: string;
}

interface Signature {
  id: string;
  name: string;
  dataUrl: string;
  naturalWidth: number;
  naturalHeight: number;
}

interface RenderedPage {
  // Full-page JPEG; legacy field kept optional so persisted tabs from older builds still load.
  // New tabs leave this undefined — pages are rendered on-demand from the live PDFDocumentProxy.
  dataUrl?: string;
  thumbUrl: string;
  width: number;
  height: number;
  rotation: number;
}

interface PrintoutSource {
  projectId: string;
  printoutId?: string;
  fileId: string;
}

interface TabSnapshot {
  id: string;
  fileName: string;
  pdfBytes: ArrayBuffer;
  renderedPages: RenderedPage[];
  annotations: Annotation[];
  history: Annotation[][];
  histIdx: number;
  source?: PrintoutSource;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const removeWhiteBackground = (dataUrl: string): Promise<string> =>
  new Promise((resolve) => {
    const img = new window.Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = data.data;
      for (let i = 0; i < d.length; i += 4) {
        const min = Math.min(d[i], d[i + 1], d[i + 2]);
        if (min > 220) {
          d[i + 3] = 0;
        } else if (min > 170) {
          d[i + 3] = Math.round(d[i + 3] * (220 - min) / 50);
        }
      }
      ctx.putImageData(data, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    img.src = dataUrl;
  });

const hexToRgb = (hex: string) => {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return rgb(r, g, b);
};

const dataUrlToBytes = (dataUrl: string): Uint8Array => {
  const base64 = dataUrl.split(',')[1];
  const bin = atob(base64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
};

const uid = () => Math.random().toString(36).slice(2, 10);

const loadImgEl = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve) => {
    const img = new window.Image();
    img.onload = () => resolve(img);
    img.src = src;
  });

const SIGS_KEY = 'pdfEditorSignatures';
const loadSigs = (): Signature[] => {
  try { return JSON.parse(localStorage.getItem(SIGS_KEY) || '[]'); } catch { return []; }
};
const saveSigs = (s: Signature[]) => localStorage.setItem(SIGS_KEY, JSON.stringify(s));

// ── IndexedDB persistence ────────────────────────────────────────────────────

const IDB_NAME = 'frugal-pdf-editor';
const IDB_VERSION = 1;

const openIDB = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      ['tabs', 'pdfs', 'rendered', 'editorState'].forEach((s) => {
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

const idbGetAllKeys = (db: IDBDatabase, store: string): Promise<string[]> =>
  new Promise((res, rej) => {
    const r = db.transaction(store, 'readonly').objectStore(store).getAllKeys();
    r.onsuccess = () => res(r.result as string[]);
    r.onerror = () => rej(r.error);
  });

// ── ImageAnnotationNode ───────────────────────────────────────────────────────
// Separate component so the useImage hook is called per annotation instance.

const ImageAnnotationNode: React.FC<{
  ann: Annotation;
  selected: boolean;
  onSelect: () => void;
  onChange: (a: Annotation) => void;
}> = ({ ann, selected, onSelect, onChange }) => {
  const [img] = useImage(ann.imageDataUrl || '');
  const shapeRef = useRef<any>(null);
  const trRef = useRef<any>(null);

  useEffect(() => {
    if (!trRef.current) return;
    if (selected && shapeRef.current) {
      trRef.current.nodes([shapeRef.current]);
      trRef.current.getLayer()?.batchDraw();
    } else {
      trRef.current.nodes([]);
    }
  }, [selected]);

  return (
    <>
      <KonvaImage
        ref={shapeRef}
        image={img}
        x={ann.x} y={ann.y}
        width={ann.width ?? 150}
        height={ann.height ?? 80}
        draggable
        onClick={onSelect}
        onTap={onSelect}
        onDragEnd={(e) => onChange({ ...ann, x: e.target.x(), y: e.target.y() })}
        onTransformEnd={() => {
          const n = shapeRef.current;
          if (!n) return;
          onChange({
            ...ann,
            x: n.x(), y: n.y(),
            width: Math.max(10, n.width() * n.scaleX()),
            height: Math.max(10, n.height() * n.scaleY()),
          });
          n.scaleX(1); n.scaleY(1);
        }}
      />
      {selected && (
        <Transformer
          ref={trRef}
          rotateEnabled={false}
          boundBoxFunc={(_, nb) => ({
            ...nb,
            width: Math.max(10, nb.width),
            height: Math.max(10, nb.height),
          })}
        />
      )}
    </>
  );
};

// ── PdfPageCanvas ─────────────────────────────────────────────────────────────
// Renders a single PDF page from a live PDFDocumentProxy directly into a canvas
// at the current display zoom, so text and vectors stay crisp at every zoom level
// (no intermediate JPEG cache). Uses IntersectionObserver so off-screen pages of
// long documents don't render until they scroll into view.

const PdfPageCanvas: React.FC<{
  pdfProxy: any;        // pdfjsLib.PDFDocumentProxy (typed as any to keep this file free of pdfjs type imports)
  pageIndex: number;    // 0-based
  displayWidth: number; // CSS pixels
  displayHeight: number;
}> = ({ pdfProxy, pageIndex, displayWidth, displayHeight }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { rootMargin: '600px 0px 600px 0px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (!pdfProxy || !visible || displayWidth <= 0 || displayHeight <= 0) return;
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<void> } | null = null;
    let page: any = null;
    (async () => {
      try {
        page = await pdfProxy.getPage(pageIndex + 1);
        if (cancelled) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        // Cap DPR so very high-DPI screens don't blow up memory on big pages.
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        // Natural viewport at scale=1; derive the scale needed to hit displayWidth in CSS px.
        const naturalVp = page.getViewport({ scale: 1 });
        const cssScale = displayWidth / naturalVp.width;
        const renderVp = page.getViewport({ scale: cssScale * dpr });
        canvas.width = Math.max(1, Math.round(renderVp.width));
        canvas.height = Math.max(1, Math.round(renderVp.height));
        canvas.style.width = `${displayWidth}px`;
        canvas.style.height = `${displayHeight}px`;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        renderTask = page.render({ canvasContext: ctx, viewport: renderVp });
        await renderTask!.promise;
      } catch (e: any) {
        if (e?.name !== 'RenderingCancelledException') {
          // Page may have been removed (deletePage) before the proxy refreshed — silent.
          // eslint-disable-next-line no-console
          if (!String(e?.message || '').includes('Page index')) console.error(e);
        }
      } finally {
        if (page) { try { page.cleanup(); } catch { /* noop */ } }
      }
    })();
    return () => {
      cancelled = true;
      if (renderTask) { try { renderTask.cancel(); } catch { /* noop */ } }
    };
  }, [pdfProxy, pageIndex, displayWidth, displayHeight, visible]);

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute', top: 0, left: 0,
        width: displayWidth, height: displayHeight,
        pointerEvents: 'none',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute', top: 0, left: 0,
          width: displayWidth, height: displayHeight,
          display: 'block', userSelect: 'none',
        }}
      />
    </div>
  );
};

// ── PdfEditor ─────────────────────────────────────────────────────────────────

export const PdfEditor: React.FC = () => {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [renderedPages, setRenderedPages] = useState<RenderedPage[]>([]);
  const [pdfBytes, setPdfBytes] = useState<ArrayBuffer | null>(null);
  const [fileName, setFileName] = useState('');
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [history, setHistory] = useState<Annotation[][]>([[]]);
  const [histIdx, setHistIdx] = useState(0);
  const [activeTool, setActiveTool] = useState<ToolType>('select');
  const [color, setColor] = useState('#e53e3e');
  const [strokeWidth, setStrokeWidth] = useState(2);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [currentAnn, setCurrentAnn] = useState<Annotation | null>(null);
  const [signatures, setSignatures] = useState<Signature[]>(loadSigs);
  const [showSigMenu, setShowSigMenu] = useState(false);
  const [pendingSig, setPendingSig] = useState<Signature | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadMsg, setLoadMsg] = useState('');
  const [saving, setSaving] = useState(false);
  const [zoom, setZoom] = useState(1.0);
  const [viewMode, setViewMode] = useState<'scroll' | 'single'>('scroll');
  const [currentPage, setCurrentPage] = useState(0);
  const [showZoomMenu, setShowZoomMenu] = useState(false);
  const [tabs, setTabs] = useState<TabSnapshot[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [editingText, setEditingText] = useState<{ pageIndex: number; x: number; y: number; text: string } | null>(null);
  const [currentSource, setCurrentSource] = useState<PrintoutSource | null>(null);
  const [draggingPageIdx, setDraggingPageIdx] = useState<number | null>(null);
  const [dragOverPageIdx, setDragOverPageIdx] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const idbRef = useRef<IDBDatabase | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Live PDFDocumentProxy used by PdfPageCanvas for on-demand vector rendering.
  // proxyForBytesRef tracks which ArrayBuffer the current proxy was built from,
  // so openPdf can hand off a proxy it just built (avoiding a redundant reload).
  const [pdfProxy, setPdfProxy] = useState<any>(null);
  const pdfProxyRef = useRef<any>(null);
  const proxyForBytesRef = useRef<ArrayBuffer | null>(null);

  // Focus textarea whenever editingText changes
  useEffect(() => {
    if (editingText) {
      // rAF ensures the textarea is in the DOM before we call focus()
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [editingText]);

  // Auto-open from router state AND restore from IDB — single combined effect so opening a
  // new file from the Printouts tab preserves any previously-open tabs rather than wiping them.
  useEffect(() => {
    const state = location.state as { file?: File; source?: PrintoutSource } | null;
    const incoming = state?.file;

    const init = async () => {
      const db = await openIDB();
      idbRef.current = db;

      // Always load any existing tabs from IDB first
      const savedState = await idbGet<{ activeTabId: string | null; tabOrder: string[] }>(db, 'editorState', 'current');
      const restoredTabs: TabSnapshot[] = [];

      if (savedState?.tabOrder.length) {
        for (const tabId of savedState.tabOrder) {
          const meta = await idbGet<{ id: string; fileName: string; source?: PrintoutSource; annotations: Annotation[]; history: Annotation[][]; histIdx: number }>(db, 'tabs', tabId);
          const pdfBuf = await idbGet<ArrayBuffer>(db, 'pdfs', tabId);
          if (!meta || !pdfBuf) continue;
          const rendered = await idbGet<RenderedPage[]>(db, 'rendered', tabId);
          restoredTabs.push({
            id: meta.id, fileName: meta.fileName, source: meta.source,
            pdfBytes: pdfBuf, renderedPages: rendered ?? [],
            annotations: meta.annotations, history: meta.history, histIdx: meta.histIdx,
          });
        }
      }

      if (incoming instanceof File) {
        // Clear router state so navigating back doesn't re-open
        window.history.replaceState({}, '');
        // Pre-populate the tab bar with any already-open tabs before rendering the new file
        if (restoredTabs.length) setTabs(restoredTabs);
        // Open new file; pass null currentTabId so we don't overwrite restored annotations
        await openPdf(incoming, null, restoredTabs, state?.source);
        return;
      }

      // Entry by file id (?fileId=) — Documents/Printouts open files by reference.
      const fileIdParam = searchParams.get('fileId');
      if (fileIdParam) {
        if (restoredTabs.length) setTabs(restoredTabs);
        await openPdfByFileId(fileIdParam, null, restoredTabs);
        return;
      }

      // No incoming file — just restore persisted state
      if (!restoredTabs.length) return;

      const ordered = savedState!.tabOrder
        .map((id) => restoredTabs.find((t) => t.id === id)!)
        .filter(Boolean);

      const activeTab = ordered.find((t) => t.id === savedState?.activeTabId) ?? ordered[0];
      annotationsRef.current = activeTab.annotations;
      historyRef.current = activeTab.history;
      histIdxRef.current = activeTab.histIdx;
      renderedPagesRef.current = activeTab.renderedPages;
      sourceRef.current = activeTab.source ?? null;

      setTabs(ordered);
      setActiveTabId(activeTab.id);
      setAnnotations(activeTab.annotations);
      setHistory(activeTab.history);
      setHistIdx(activeTab.histIdx);
      setRenderedPages(activeTab.renderedPages);
      setPdfBytes(activeTab.pdfBytes);
      setFileName(activeTab.fileName);
      setCurrentSource(activeTab.source ?? null);

      if (!activeTab.renderedPages.length && activeTab.pdfBytes.byteLength > 0) {
        const file = new File([activeTab.pdfBytes], activeTab.fileName, { type: 'application/pdf' });
        await openPdf(file, null, ordered.filter((t) => t.id !== activeTab.id), activeTab.source);
      } else {
        requestAnimationFrame(() => {
          const container = scrollContainerRef.current;
          if (!container || !activeTab.renderedPages.length) return;
          setZoom(clampZoom((container.clientWidth - 48) / activeTab.renderedPages[0].width));
        });
      }
    };

    init().catch(console.error);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refs mirror state so event handlers always see current values
  const annotationsRef = useRef(annotations);
  const historyRef = useRef(history);
  const histIdxRef = useRef(histIdx);
  const activeToolRef = useRef(activeTool);
  const colorRef = useRef(color);
  const swRef = useRef(strokeWidth);
  const drawingRef = useRef(false);
  const currentAnnRef = useRef<Annotation | null>(null);
  const pendingSigRef = useRef<Signature | null>(pendingSig);
  const selectedIdRef = useRef<string | null>(selectedId);
  const renderedPagesRef = useRef(renderedPages);
  const sourceRef = useRef<PrintoutSource | null>(null);

  useEffect(() => { annotationsRef.current = annotations; }, [annotations]);
  useEffect(() => { historyRef.current = history; }, [history]);
  useEffect(() => { histIdxRef.current = histIdx; }, [histIdx]);
  useEffect(() => { activeToolRef.current = activeTool; }, [activeTool]);
  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { swRef.current = strokeWidth; }, [strokeWidth]);
  useEffect(() => { pendingSigRef.current = pendingSig; }, [pendingSig]);
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);
  useEffect(() => { renderedPagesRef.current = renderedPages; }, [renderedPages]);
  useEffect(() => { sourceRef.current = currentSource; }, [currentSource]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const sigInputRef = useRef<HTMLInputElement>(null);
  const importPageInputRef = useRef<HTMLInputElement>(null);
  const sigMenuRef = useRef<HTMLDivElement>(null);
  const zoomMenuRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const sidebarListRef = useRef<HTMLDivElement>(null);
  const sidebarThumbRefs = useRef<(HTMLDivElement | null)[]>([]);
  const draggingPageIdxRef = useRef<number | null>(null);
  const dragOverPageRef = useRef<number | null>(null);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (sigMenuRef.current && !sigMenuRef.current.contains(e.target as Node)) {
        setShowSigMenu(false);
      }
      if (zoomMenuRef.current && !zoomMenuRef.current.contains(e.target as Node)) {
        setShowZoomMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // ── Zoom helpers ──────────────────────────────────────────────────────────────

  const clampZoom = (z: number) => Math.min(5, Math.max(0.1, Math.round(z * 100) / 100));

  const applyZoom = (z: number) => setZoom(clampZoom(z));

  const fitWidth = () => {
    const container = scrollContainerRef.current;
    const pages = renderedPagesRef.current;
    if (!container || !pages.length) return;
    const page = pages[viewMode === 'single' ? currentPage : 0];
    applyZoom((container.clientWidth - 48) / page.width);
  };

  const fitHeight = () => {
    const container = scrollContainerRef.current;
    const pages = renderedPagesRef.current;
    if (!container || !pages.length) return;
    const page = pages[viewMode === 'single' ? currentPage : 0];
    applyZoom((container.clientHeight - 48) / page.height);
  };

  const fitPage = () => {
    const container = scrollContainerRef.current;
    const pages = renderedPagesRef.current;
    if (!container || !pages.length) return;
    const page = pages[viewMode === 'single' ? currentPage : 0];
    applyZoom(Math.min(
      (container.clientWidth - 48) / page.width,
      (container.clientHeight - 48) / page.height,
    ));
  };

  // ── History ──────────────────────────────────────────────────────────────────

  const pushHistory = useCallback((next: Annotation[]) => {
    const trimmed = historyRef.current.slice(0, histIdxRef.current + 1);
    const newH = [...trimmed, next];
    historyRef.current = newH;
    histIdxRef.current = newH.length - 1;
    annotationsRef.current = next;
    setHistory(newH);
    setHistIdx(newH.length - 1);
    setAnnotations(next);
  }, []);

  const undo = useCallback(() => {
    const idx = histIdxRef.current;
    if (idx <= 0) return;
    const newIdx = idx - 1;
    const prev = historyRef.current[newIdx];
    histIdxRef.current = newIdx;
    annotationsRef.current = prev;
    setHistIdx(newIdx);
    setAnnotations(prev);
  }, []);

  const redo = useCallback(() => {
    const idx = histIdxRef.current;
    const h = historyRef.current;
    if (idx >= h.length - 1) return;
    const newIdx = idx + 1;
    const next = h[newIdx];
    histIdxRef.current = newIdx;
    annotationsRef.current = next;
    setHistIdx(newIdx);
    setAnnotations(next);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const inInput = document.activeElement instanceof HTMLInputElement
        || document.activeElement instanceof HTMLTextAreaElement;
      if (!inInput && (e.key === 'Delete' || e.key === 'Backspace')) {
        const sid = selectedIdRef.current;
        if (sid) {
          pushHistory(annotationsRef.current.filter((a) => a.id !== sid));
          setSelectedId(null);
        }
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') {
        e.preventDefault(); undo();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) {
        e.preventDefault(); redo();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault(); setZoom((z) => clampZoom(z + 0.1));
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault(); setZoom((z) => clampZoom(z - 0.1));
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault(); setZoom(1);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [undo, redo, pushHistory]);

  // Ctrl+wheel to zoom
  useEffect(() => {
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom((z) => clampZoom(z - e.deltaY * 0.001));
    };
    const el = scrollContainerRef.current;
    el?.addEventListener('wheel', handler, { passive: false });
    return () => el?.removeEventListener('wheel', handler);
  });

  const saveStateToIDB = useCallback(async () => {
    const db = idbRef.current;
    if (!db) return;
    // Persist editor-level state
    await idbPut(db, 'editorState', 'current', { activeTabId, tabOrder: tabs.map((t) => t.id) });
    // Persist each tab's metadata
    for (const tab of tabs) {
      await idbPut(db, 'tabs', tab.id, {
        id: tab.id, fileName: tab.fileName, source: tab.source ?? null,
        annotations: tab.annotations, history: tab.history, histIdx: tab.histIdx,
      });
    }
  }, [tabs, activeTabId]);

  // Debounced IDB save on every state change
  useEffect(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => { saveStateToIDB(); }, 1500);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [annotations, tabs, activeTabId, saveStateToIDB]);

  // Mirror the active tab's annotations to a server-side draft (spec §6 —
  // crash/refresh safe). Only file-backed tabs draft; standalone tabs keep
  // IndexedDB-only persistence.
  useEffect(() => {
    const tab = tabs.find((t) => t.id === activeTabId);
    const fileId = tab?.source?.fileId;
    if (!fileId) return;
    const handle = setTimeout(() => {
      // Empty == "no draft" (consistent with the restore gate). Don't persist
      // empty rows on mere open or post-save bake; clear any existing draft instead.
      if (annotations.length > 0) {
        putDraft(fileId, 'pdf', JSON.stringify({ annotations })).catch(() => {});
      } else {
        deleteDraft(fileId).catch(() => {});
      }
    }, 2000);
    return () => clearTimeout(handle);
  }, [annotations, activeTabId, tabs]);

  // Keep the live PDFDocumentProxy in sync with pdfBytes. openPdf may pre-populate
  // the ref so the first render reuses the proxy it already built; otherwise (e.g.
  // after deletePage / reorderPages / importPages mutate pdfBytes, or on tab switch),
  // load a fresh proxy from the new bytes and destroy the previous one.
  useEffect(() => {
    if (!pdfBytes) {
      if (pdfProxyRef.current) {
        pdfProxyRef.current.destroy().catch(() => {});
        pdfProxyRef.current = null;
        proxyForBytesRef.current = null;
        setPdfProxy(null);
      }
      return;
    }
    if (proxyForBytesRef.current === pdfBytes && pdfProxyRef.current) {
      // openPdf (or a previous run) already built a proxy for these exact bytes.
      if (pdfProxy !== pdfProxyRef.current) setPdfProxy(pdfProxyRef.current);
      return;
    }
    let cancelled = false;
    let createdProxy: any = null;
    (async () => {
      try {
        const data = new Uint8Array(pdfBytes.slice(0));
        const proxy = await pdfjsLib.getDocument({ data }).promise;
        if (cancelled) {
          proxy.destroy().catch(() => {});
          return;
        }
        createdProxy = proxy;
        if (pdfProxyRef.current && pdfProxyRef.current !== proxy) {
          pdfProxyRef.current.destroy().catch(() => {});
        }
        pdfProxyRef.current = proxy;
        proxyForBytesRef.current = pdfBytes;
        setPdfProxy(proxy);
      } catch (err) {
        console.error('Failed to load PDF proxy', err);
      }
    })();
    return () => {
      cancelled = true;
      // If this effect's proxy never became the active one, dispose it.
      if (createdProxy && pdfProxyRef.current !== createdProxy) {
        createdProxy.destroy().catch(() => {});
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfBytes]);

  // Destroy the active proxy on unmount.
  useEffect(() => () => {
    if (pdfProxyRef.current) {
      pdfProxyRef.current.destroy().catch(() => {});
      pdfProxyRef.current = null;
    }
  }, []);

  // ── Tab management ────────────────────────────────────────────────────────────

  const saveCurrentTabState = useCallback((tabId: string) => {
    setTabs((prev) => prev.map((t) =>
      t.id === tabId
        ? { ...t, annotations: annotationsRef.current, history: historyRef.current, histIdx: histIdxRef.current, source: sourceRef.current ?? undefined }
        : t,
    ));
  }, []);

  const switchTab = useCallback((tabId: string, currentId: string | null) => {
    if (tabId === currentId) return;
    if (currentId) saveCurrentTabState(currentId);

    setTabs((prev) => {
      const tab = prev.find((t) => t.id === tabId);
      if (!tab) return prev;
      // Load tab state
      annotationsRef.current = tab.annotations;
      historyRef.current = tab.history;
      histIdxRef.current = tab.histIdx;
      renderedPagesRef.current = tab.renderedPages;
      sourceRef.current = tab.source ?? null;
      setActiveTabId(tabId);
      setAnnotations(tab.annotations);
      setHistory(tab.history);
      setHistIdx(tab.histIdx);
      setRenderedPages(tab.renderedPages);
      setPdfBytes(tab.pdfBytes);
      setFileName(tab.fileName);
      setCurrentSource(tab.source ?? null);
      setSelectedId(null);
      setCurrentAnn(null);
      setCurrentPage(0);
      return prev;
    });
  }, [saveCurrentTabState]);

  const closeTab = useCallback((tabId: string, currentId: string | null, allTabs: TabSnapshot[]) => {
    const remaining = allTabs.filter((t) => t.id !== tabId);
    setTabs(remaining);
    // Clean up IDB data for closed tab
    if (idbRef.current) {
      const db = idbRef.current;
      idbDel(db, 'tabs', tabId).catch(() => {});
      idbDel(db, 'pdfs', tabId).catch(() => {});
      idbDel(db, 'rendered', tabId).catch(() => {});
    }
    if (tabId !== currentId) return; // closing a non-active tab — no state change needed

    if (remaining.length === 0) {
      // Last tab closed — reset to empty
      setActiveTabId(null);
      annotationsRef.current = []; historyRef.current = [[]]; histIdxRef.current = 0;
      renderedPagesRef.current = [];
      sourceRef.current = null;
      setAnnotations([]); setHistory([[]]); setHistIdx(0);
      setRenderedPages([]); setPdfBytes(null); setFileName('');
      setCurrentSource(null);
      setSelectedId(null); setCurrentAnn(null); setCurrentPage(0);
    } else {
      // Switch to the nearest remaining tab
      const newTab = remaining[Math.min(allTabs.findIndex((t) => t.id === tabId), remaining.length - 1)];
      annotationsRef.current = newTab.annotations;
      historyRef.current = newTab.history;
      histIdxRef.current = newTab.histIdx;
      renderedPagesRef.current = newTab.renderedPages;
      sourceRef.current = newTab.source ?? null;
      setActiveTabId(newTab.id);
      setAnnotations(newTab.annotations); setHistory(newTab.history); setHistIdx(newTab.histIdx);
      setRenderedPages(newTab.renderedPages); setPdfBytes(newTab.pdfBytes); setFileName(newTab.fileName);
      setCurrentSource(newTab.source ?? null);
      setSelectedId(null); setCurrentAnn(null); setCurrentPage(0);
    }
  }, []);

  // ── PDF Loading ───────────────────────────────────────────────────────────────

  const openPdf = async (
    file: File,
    currentTabId: string | null,
    currentTabs: TabSnapshot[],
    source?: PrintoutSource,
    initialAnnotations?: Annotation[],
  ) => {
    setLoading(true);
    setLoadMsg('Loading PDF…');

    const buf = await file.arrayBuffer();
    // pdf.js may detach the buffer it's given; pass an independent copy so `buf`
    // stays usable for pdf-lib / IndexedDB / etc.
    const pdfData = new Uint8Array(buf.slice(0));
    const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
    const pages: RenderedPage[] = [];
    const thumbCanvas = document.createElement('canvas');
    const renderCanvas = document.createElement('canvas');
    const thumbCtx = thumbCanvas.getContext('2d')!;
    const renderCtx = renderCanvas.getContext('2d')!;
    const THUMB_W = 148;

    // Render each page once at 2.0× to produce a thumbnail and capture the
    // page's "base" dimensions (kept at scale=2.0 so existing annotation coords
    // continue to work unchanged). The full-page raster is NOT cached — pages
    // are rendered on-demand by PdfPageCanvas from the live proxy below.
    for (let i = 1; i <= pdf.numPages; i++) {
      setLoadMsg(`Preparing page ${i} of ${pdf.numPages}…`);
      const page = await pdf.getPage(i);
      const vp = page.getViewport({ scale: 2.0 });
      const thumbH = Math.round(THUMB_W * vp.height / vp.width);
      // Render at thumbnail resolution directly — much cheaper than rendering full-size
      // and then downscaling, which was the previous approach.
      const thumbScale = THUMB_W / page.getViewport({ scale: 1 }).width;
      const thumbVp = page.getViewport({ scale: thumbScale });
      renderCanvas.width = Math.round(thumbVp.width);
      renderCanvas.height = Math.round(thumbVp.height);
      renderCtx.fillStyle = '#ffffff';
      renderCtx.fillRect(0, 0, renderCanvas.width, renderCanvas.height);
      await page.render({ canvasContext: renderCtx, viewport: thumbVp } as any).promise;
      thumbCanvas.width = THUMB_W; thumbCanvas.height = thumbH;
      thumbCtx.drawImage(renderCanvas, 0, 0, THUMB_W, thumbH);
      pages.push({
        thumbUrl: thumbCanvas.toDataURL('image/jpeg', 0.75),
        width: vp.width, height: vp.height,
        rotation: vp.rotation,
      });
      page.cleanup();
    }

    // Keep `pdf` alive — hand it to the proxy lifecycle so the on-demand renderer
    // reuses it instead of reloading the same bytes a second time.
    if (pdfProxyRef.current && pdfProxyRef.current !== pdf) {
      pdfProxyRef.current.destroy().catch(() => {});
    }
    pdfProxyRef.current = pdf;
    proxyForBytesRef.current = buf;
    setPdfProxy(pdf);
    renderCanvas.width = 0; renderCanvas.height = 0;
    thumbCanvas.width = 0; thumbCanvas.height = 0;

    const seededAnns = initialAnnotations ?? [];
    const newTabId = uid();
    const newTab: TabSnapshot = {
      id: newTabId, fileName: file.name, pdfBytes: buf,
      renderedPages: pages, annotations: seededAnns, history: [seededAnns], histIdx: 0,
      source,
    };

    if (currentTabs.length === 0) {
      // First file — save current snapshot state too
      setTabs([newTab]);
    } else {
      // Save current tab before adding new one
      if (currentTabId) saveCurrentTabState(currentTabId);
      setTabs((prev) => [...prev.map((t) =>
        t.id === currentTabId
          ? { ...t, annotations: annotationsRef.current, history: historyRef.current, histIdx: histIdxRef.current }
          : t,
      ), newTab]);
    }

    // Load new tab into flat state
    setActiveTabId(newTabId);
    annotationsRef.current = seededAnns; historyRef.current = [seededAnns]; histIdxRef.current = 0;
    renderedPagesRef.current = pages;
    sourceRef.current = source ?? null;
    setAnnotations(seededAnns); setHistory([seededAnns]); setHistIdx(0);
    setRenderedPages(pages); setPdfBytes(buf); setFileName(file.name);
    setCurrentSource(source ?? null);
    setSelectedId(null); setCurrentAnn(null); setCurrentPage(0);
    setLoading(false);

    // Persist to IndexedDB
    if (idbRef.current) {
      const db = idbRef.current;
      await idbPut(db, 'pdfs', newTabId, buf);
      await idbPut(db, 'rendered', newTabId, pages);
    }

    // Auto fit-width after load
    requestAnimationFrame(() => {
      const container = scrollContainerRef.current;
      if (!container || !pages.length) return;
      setZoom(clampZoom((container.clientWidth - 48) / pages[0].width));
    });
  };

  // Open a stored PDF by id, draft-restore prompt and all. Shared by the
  // ?fileId= entry point (which only runs on mount, so the toolbar picker
  // can't reach it by pushing a new query string) and the toolbar's
  // "Open from documents" button.
  const openPdfByFileId = async (
    fileId: string,
    currentTabId: string | null,
    currentTabs: TabSnapshot[],
  ) => {
    try {
      const [meta, blob, draft] = await Promise.all([
        getFileMeta(fileId),
        fetchFileBlob(fileId),
        getDraft(fileId).catch(() => null),
      ]);
      const base = meta?.name || `file-${fileId}`;
      const fname = base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`;
      const f = new File([blob], fname, { type: 'application/pdf' });
      const src: PrintoutSource = { projectId: meta?.projectId ?? '', fileId };

      let seed: Annotation[] | undefined;
      if (draft?.kind === 'pdf') {
        try {
          const parsed = JSON.parse(draft.data) as { annotations?: Annotation[] };
          if (parsed.annotations?.length) {
            const restore = await confirm({
              title: 'Restore draft?',
              message: 'You have unsaved annotations on this file from a previous session. Restore them?',
              confirmLabel: 'Restore',
              cancelLabel: 'Discard',
            });
            if (restore) seed = parsed.annotations;
            else deleteDraft(fileId).catch(() => {});
          }
        } catch { /* unreadable draft — ignore */ }
      }
      await openPdf(f, currentTabId, currentTabs, src, seed);
    } catch (e) {
      console.error('Failed to open file by id:', e);
      toast('Could not open the file', { type: 'error' });
    }
  };

  // ── Konva Event Handlers ──────────────────────────────────────────────────────

  const getPos = (e: any) => {
    const stage = e.target.getStage();
    if (!stage) return null;
    const p = stage.getPointerPosition();
    if (!p) return null;
    return { x: p.x / (stage.scaleX() || 1), y: p.y / (stage.scaleY() || 1) };
  };

  const handleMouseDown = useCallback((e: any, pageIndex: number) => {
    const tool = activeToolRef.current;
    const pos = getPos(e);
    if (!pos) return;

    if (tool === 'select') {
      if (e.target === e.target.getStage()) setSelectedId(null);
      return;
    }

    if (tool === 'text') {
      e.evt?.preventDefault(); // prevent canvas from stealing focus from the textarea
      setEditingText({ pageIndex, x: pos.x, y: pos.y, text: '' });
      return;
    }

    if (tool === 'signature') {
      const sig = pendingSigRef.current;
      if (!sig) return;
      const sigW = 200;
      const sigH = sig.naturalWidth > 0 ? sigW * (sig.naturalHeight / sig.naturalWidth) : 80;
      const ann: Annotation = {
        id: uid(), pageIndex, type: 'signature',
        x: pos.x - sigW / 2, y: pos.y - sigH / 2,
        width: sigW, height: sigH,
        color: colorRef.current, strokeWidth: swRef.current,
        imageDataUrl: sig.dataUrl,
      };
      pushHistory([...annotationsRef.current, ann]);
      setPendingSig(null); pendingSigRef.current = null;
      setActiveTool('select'); activeToolRef.current = 'select';
      return;
    }

    const base: Annotation = {
      id: uid(), pageIndex, type: tool as DrawTool,
      x: pos.x, y: pos.y,
      color: colorRef.current, strokeWidth: swRef.current,
    };

    let ann: Annotation;
    if (tool === 'freehand') {
      ann = { ...base, points: [pos.x, pos.y] };
    } else if (tool === 'line' || tool === 'arrow') {
      ann = { ...base, points: [pos.x, pos.y, pos.x, pos.y] };
    } else {
      ann = { ...base, width: 0, height: 0 };
    }

    currentAnnRef.current = ann;
    setCurrentAnn(ann);
    drawingRef.current = true;
  }, [pushHistory]);

  const handleMouseMove = useCallback((e: any, pageIndex: number) => {
    if (!drawingRef.current || !currentAnnRef.current) return;
    if (currentAnnRef.current.pageIndex !== pageIndex) return;
    const pos = getPos(e);
    if (!pos) return;

    const prev = currentAnnRef.current;
    const tool = activeToolRef.current;
    let updated: Annotation;

    if (tool === 'freehand') {
      updated = { ...prev, points: [...(prev.points || []), pos.x, pos.y] };
    } else if (tool === 'line' || tool === 'arrow') {
      const pts = [...(prev.points || [])];
      pts[2] = pos.x; pts[3] = pos.y;
      updated = { ...prev, points: pts };
    } else {
      updated = { ...prev, width: pos.x - prev.x, height: pos.y - prev.y };
    }

    currentAnnRef.current = updated;
    setCurrentAnn(updated);
  }, []);

  const handleMouseUp = useCallback(() => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    const ann = currentAnnRef.current;
    if (ann) {
      const meaningful = ann.points
        ? ann.points.length > 2
        : Math.abs(ann.width ?? 0) > 4 || Math.abs(ann.height ?? 0) > 4;
      if (meaningful) pushHistory([...annotationsRef.current, ann]);
    }
    currentAnnRef.current = null;
    setCurrentAnn(null);
  }, [pushHistory]);

  // ── Image Insertion ───────────────────────────────────────────────────────────

  const insertImageFile = (file: File) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const id = uid();
      const ann: Annotation = {
        id, pageIndex: 0, type: 'image',
        x: 50, y: 50, width: 200, height: 150,
        color: colorRef.current, strokeWidth: swRef.current,
        imageDataUrl: reader.result as string,
      };
      pushHistory([...annotationsRef.current, ann]);
      setSelectedId(id);
      setActiveTool('select');
      activeToolRef.current = 'select';
    };
    reader.readAsDataURL(file);
  };

  // ── Signature Management ──────────────────────────────────────────────────────

  const addSignature = async (file: File) => {
    const dataUrl = await new Promise<string>((res) => {
      const reader = new FileReader();
      reader.onloadend = () => res(reader.result as string);
      reader.readAsDataURL(file);
    });
    const cleaned = await removeWhiteBackground(dataUrl);
    const img = await loadImgEl(cleaned);
    const sig: Signature = {
      id: uid(),
      name: file.name.replace(/\.[^/.]+$/, '') || 'Signature',
      dataUrl: cleaned,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
    };
    const next = [...loadSigs(), sig];
    setSignatures(next);
    saveSigs(next);
    setShowSigMenu(false);
  };

  const deleteSig = (id: string) => {
    const next = signatures.filter((s) => s.id !== id);
    setSignatures(next);
    saveSigs(next);
  };

  // ── PDF Export ────────────────────────────────────────────────────────────────
  // Renders annotations to a transparent canvas overlay per page, then embeds
  // the overlay as a PNG. This avoids coordinate-mapping issues with rotated PDFs.

  const renderOverlay = async (pageIndex: number): Promise<HTMLCanvasElement | null> => {
    const anns = annotationsRef.current.filter((a) => a.pageIndex === pageIndex);
    if (anns.length === 0) return null;
    const rp = renderedPagesRef.current[pageIndex];
    const c = document.createElement('canvas');
    c.width = rp.width; c.height = rp.height;
    const ctx = c.getContext('2d')!;

    for (const ann of anns) {
      ctx.strokeStyle = ann.color;
      ctx.fillStyle = ann.color;
      ctx.lineWidth = ann.strokeWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      if ((ann.type === 'freehand' || ann.type === 'line') && ann.points && ann.points.length >= 4) {
        ctx.beginPath();
        ctx.moveTo(ann.points[0], ann.points[1]);
        for (let i = 2; i < ann.points.length; i += 2) ctx.lineTo(ann.points[i], ann.points[i + 1]);
        ctx.stroke();
      } else if (ann.type === 'arrow' && ann.points && ann.points.length >= 4) {
        const pts = ann.points;
        ctx.beginPath(); ctx.moveTo(pts[0], pts[1]); ctx.lineTo(pts[2], pts[3]); ctx.stroke();
        const angle = Math.atan2(pts[3] - pts[1], pts[2] - pts[0]);
        ctx.beginPath(); ctx.moveTo(pts[2], pts[3]);
        ctx.lineTo(pts[2] - 12 * Math.cos(angle - 0.4), pts[3] - 12 * Math.sin(angle - 0.4));
        ctx.lineTo(pts[2] - 12 * Math.cos(angle + 0.4), pts[3] - 12 * Math.sin(angle + 0.4));
        ctx.closePath(); ctx.fill();
      } else if (ann.type === 'rect') {
        const w = ann.width ?? 0, h = ann.height ?? 0;
        ctx.strokeRect(ann.x + (w < 0 ? w : 0), ann.y + (h < 0 ? h : 0), Math.abs(w), Math.abs(h));
      } else if (ann.type === 'ellipse') {
        const w = ann.width ?? 0, h = ann.height ?? 0;
        ctx.beginPath();
        ctx.ellipse(ann.x + w / 2, ann.y + h / 2, Math.abs(w / 2) || 1, Math.abs(h / 2) || 1, 0, 0, 2 * Math.PI);
        ctx.stroke();
      } else if (ann.type === 'text' && ann.text) {
        ctx.font = `${ann.fontSize ?? 16}px sans-serif`;
        ctx.fillText(ann.text, ann.x, ann.y + (ann.fontSize ?? 16));
      } else if ((ann.type === 'image' || ann.type === 'signature') && ann.imageDataUrl) {
        try {
          const img = await loadImgEl(ann.imageDataUrl);
          ctx.drawImage(img, ann.x, ann.y, ann.width ?? 150, ann.height ?? 80);
        } catch { /* skip */ }
      }
    }
    return c;
  };

  // Bakes current annotations into the original PDF bytes and returns the new bytes.
  // Shared between Save (overwrite origin) and Save As (download a copy).
  const buildAnnotatedPdf = async (): Promise<Uint8Array | null> => {
    if (!pdfBytes) return null;
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pdfPages = pdfDoc.getPages();

    for (let i = 0; i < pdfPages.length; i++) {
      const rp = renderedPagesRef.current[i];
      if (!rp) continue;
      const overlay = await renderOverlay(i);
      if (!overlay) continue;

      const page = pdfPages[i];
      // The overlay canvas covers what pdf.js rendered — the page's view box
      // (CropBox ∩ MediaBox), which may not start at (0,0) in user space
      // (center-origin CAD MediaBoxes, inset CropBoxes). Place the flattened
      // image into that box, not an assumed (0,0)+MediaBox rect.
      const view = viewBox(page.getMediaBox(), page.getCropBox());
      const rot = page.getRotation().angle;

      // pdfjs already renders the page with /Rotate applied visually, so our overlay
      // is in the rendered (visual) orientation. pdf-lib's drawImage internally handles
      // the y-axis difference (PDF y-up) — embedded images are NOT vertically flipped.
      //
      // For rotated pages, however, the viewer will apply /Rotate CW to whatever we
      // embed, so we must counter-rotate the overlay (CCW) back to raw PDF orientation
      // first. The viewer's later CW rotation then restores the correct visual layout.
      const prepareCanvas = (src: HTMLCanvasElement, undoCCW: number): HTMLCanvasElement => {
        if (undoCCW === 0) return src;
        const swap = undoCCW === 90 || undoCCW === 270;
        const out = document.createElement('canvas');
        out.width  = swap ? src.height : src.width;
        out.height = swap ? src.width  : src.height;
        const octx = out.getContext('2d')!;
        octx.translate(out.width / 2, out.height / 2);
        octx.rotate((-undoCCW * Math.PI) / 180); // negative = CCW in canvas 2D
        octx.drawImage(src, -src.width / 2, -src.height / 2);
        return out;
      };

      const prepared = prepareCanvas(overlay, rot);
      if (prepared !== overlay) { overlay.width = 0; overlay.height = 0; }

      const overlayBytes = dataUrlToBytes(prepared.toDataURL('image/png'));
      prepared.width = 0; prepared.height = 0;
      const overlayImg = await pdfDoc.embedPng(overlayBytes);

      // Place over the full view rect (counter-rotated above, so the rect is
      // the unrotated view box); viewer then applies /Rotate visually.
      page.drawImage(overlayImg, {
        x: view.x0, y: view.y0,
        width: view.x1 - view.x0, height: view.y1 - view.y0,
      });
    }

    return await pdfDoc.save();
  };

  const downloadBytes = (bytes: Uint8Array, downloadName: string) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadName;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Save: if the file originated from a Printout, overwrite it on the server.
  // Otherwise, download locally using the original filename (no suffix).
  const savePdf = async () => {
    if (!pdfBytes) return;
    setSaving(true);
    try {
      const bytes = await buildAnnotatedPdf();
      if (!bytes) return;
      if (currentSource) {
        await saveFileVersion(currentSource.fileId, new Blob([bytes], { type: 'application/pdf' }));
        deleteDraft(currentSource.fileId).catch(() => {});
        // Replace the tab's pdfBytes so subsequent saves build from the annotated version,
        // and clear the annotations/history since they are now baked into the PDF.
        const newBuf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        setPdfBytes(newBuf);
        annotationsRef.current = []; historyRef.current = [[]]; histIdxRef.current = 0;
        setAnnotations([]); setHistory([[]]); setHistIdx(0);
        setSelectedId(null);
        toast('Saved — new version created', { type: 'success' });
      } else {
        downloadBytes(bytes, fileName || 'document.pdf');
      }
    } catch (err) {
      console.error('Save failed', err);
      toast('Save failed', { type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  // Save As: use File System Access API when available (gives the user a save dialog),
  // then fall back to <a download> for browsers that don't support it (e.g. Android Chrome).
  const saveAsPdf = async () => {
    if (!pdfBytes) return;
    setSaving(true);
    try {
      const bytes = await buildAnnotatedPdf();
      if (!bytes) return;
      const base = (fileName || 'document').replace(/\.pdf$/i, '');
      const suggestedName = `${base}_annotated.pdf`;

      if ('showSaveFilePicker' in window) {
        try {
          const handle = await (window as any).showSaveFilePicker({
            suggestedName,
            types: [{ description: 'PDF Document', accept: { 'application/pdf': ['.pdf'] } }],
          });
          const writable = await handle.createWritable();
          await writable.write(new Blob([bytes], { type: 'application/pdf' }));
          await writable.close();
          return;
        } catch (err: any) {
          if (err.name === 'AbortError') return; // user cancelled picker
          // fall through to <a download>
        }
      }
      downloadBytes(bytes, suggestedName);
    } catch (err) {
      console.error('Save As failed', err);
      toast('Save As failed', { type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  // ── Page Management ───────────────────────────────────────────────────────────

  const deletePage = async (idx: number) => {
    const pages = renderedPagesRef.current;
    if (pages.length <= 1) { toast('Cannot delete the only page', { type: 'error' }); return; }
    if (pdfBytes) {
      try {
        const pdfDoc = await PDFDocument.load(pdfBytes);
        pdfDoc.removePage(idx);
        const saved = await pdfDoc.save();
        const newBuf = saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength) as ArrayBuffer;
        setPdfBytes(newBuf);
      } catch { /* non-fatal — annotations still exported correctly */ }
    }
    const newPages = pages.filter((_, i) => i !== idx);
    const newAnnotations = annotationsRef.current
      .filter((a) => a.pageIndex !== idx)
      .map((a) => a.pageIndex > idx ? { ...a, pageIndex: a.pageIndex - 1 } : a);
    renderedPagesRef.current = newPages;
    setRenderedPages(newPages);
    pushHistory(newAnnotations);
    setCurrentPage((p) => Math.min(p, Math.max(0, newPages.length - 1)));
  };

  const reorderPages = async (fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx) return;
    if (pdfBytes) {
      try {
        const srcDoc = await PDFDocument.load(pdfBytes);
        const count = srcDoc.getPageCount();
        const order = Array.from({ length: count }, (_, i) => i);
        order.splice(fromIdx, 1);
        order.splice(toIdx, 0, fromIdx);
        const newDoc = await PDFDocument.create();
        const copied = await newDoc.copyPages(srcDoc, order);
        copied.forEach((p) => newDoc.addPage(p));
        const saved = await newDoc.save();
        const newBuf = saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength) as ArrayBuffer;
        setPdfBytes(newBuf);
      } catch { /* non-fatal */ }
    }
    const pages = [...renderedPagesRef.current];
    const [removed] = pages.splice(fromIdx, 1);
    pages.splice(toIdx, 0, removed);
    const newAnnotations = annotationsRef.current.map((a) => {
      const pi = a.pageIndex;
      if (pi === fromIdx) return { ...a, pageIndex: toIdx };
      if (fromIdx < toIdx && pi > fromIdx && pi <= toIdx) return { ...a, pageIndex: pi - 1 };
      if (fromIdx > toIdx && pi >= toIdx && pi < fromIdx) return { ...a, pageIndex: pi + 1 };
      return a;
    });
    renderedPagesRef.current = pages;
    setRenderedPages(pages);
    pushHistory(newAnnotations);
    setCurrentPage((p) => {
      if (p === fromIdx) return toIdx;
      if (fromIdx < toIdx && p > fromIdx && p <= toIdx) return p - 1;
      if (fromIdx > toIdx && p >= toIdx && p < fromIdx) return p + 1;
      return p;
    });
  };

  const importPages = async (file: File) => {
    setLoading(true);
    const renderCanvas = document.createElement('canvas');
    const thumbCanvas = document.createElement('canvas');
    const THUMB_W = 148;
    const newPages: RenderedPage[] = [];
    try {
      if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
        const buf = await file.arrayBuffer();
        const pdfData = new Uint8Array(buf.slice(0));
        const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
        const ctx = renderCanvas.getContext('2d')!;
        const thumbCtx = thumbCanvas.getContext('2d')!;
        for (let i = 1; i <= pdf.numPages; i++) {
          setLoadMsg(`Preparing imported page ${i} of ${pdf.numPages}…`);
          const page = await pdf.getPage(i);
          const vp = page.getViewport({ scale: 2.0 });
          // Render at thumbnail resolution only; full-page rendering is on-demand.
          const thumbScale = THUMB_W / page.getViewport({ scale: 1 }).width;
          const thumbVp = page.getViewport({ scale: thumbScale });
          renderCanvas.width = Math.round(thumbVp.width);
          renderCanvas.height = Math.round(thumbVp.height);
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, renderCanvas.width, renderCanvas.height);
          await page.render({ canvasContext: ctx, viewport: thumbVp } as any).promise;
          const thumbH = Math.round(THUMB_W * vp.height / vp.width);
          thumbCanvas.width = THUMB_W; thumbCanvas.height = thumbH;
          thumbCtx.drawImage(renderCanvas, 0, 0, THUMB_W, thumbH);
          newPages.push({
            thumbUrl: thumbCanvas.toDataURL('image/jpeg', 0.75),
            width: vp.width, height: vp.height, rotation: vp.rotation,
          });
          page.cleanup();
        }
        await pdf.destroy();
        if (pdfBytes) {
          const existingDoc = await PDFDocument.load(pdfBytes);
          const newDoc = await PDFDocument.load(buf);
          const indices = Array.from({ length: newDoc.getPageCount() }, (_, i) => i);
          const copied = await existingDoc.copyPages(newDoc, indices);
          copied.forEach((p) => existingDoc.addPage(p));
          const saved = await existingDoc.save();
          const newBuf = saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength) as ArrayBuffer;
          setPdfBytes(newBuf);
        }
      } else {
        setLoadMsg('Loading image…');
        const dataUrl = await new Promise<string>((res) => {
          const reader = new FileReader();
          reader.onloadend = () => res(reader.result as string);
          reader.readAsDataURL(file);
        });
        const img = await loadImgEl(dataUrl);
        const scale = 2.0;
        const w = img.naturalWidth * scale;
        const h = img.naturalHeight * scale;
        renderCanvas.width = w; renderCanvas.height = h;
        const ctx = renderCanvas.getContext('2d')!;
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        const thumbH = Math.round(THUMB_W * h / w);
        thumbCanvas.width = THUMB_W; thumbCanvas.height = thumbH;
        thumbCanvas.getContext('2d')!.drawImage(renderCanvas, 0, 0, THUMB_W, thumbH);
        newPages.push({
          dataUrl: renderCanvas.toDataURL('image/jpeg', 0.92),
          thumbUrl: thumbCanvas.toDataURL('image/jpeg', 0.75),
          width: w, height: h, rotation: 0,
        });
        if (pdfBytes) {
          const pdfDoc = await PDFDocument.load(pdfBytes);
          const imgBytes = dataUrlToBytes(dataUrl);
          const embedded = dataUrl.includes('image/png')
            ? await pdfDoc.embedPng(imgBytes)
            : await pdfDoc.embedJpg(imgBytes);
          const page = pdfDoc.addPage([img.naturalWidth, img.naturalHeight]);
          page.drawImage(embedded, { x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight });
          const saved = await pdfDoc.save();
          const newBuf = saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength) as ArrayBuffer;
          setPdfBytes(newBuf);
        }
      }
    } catch (err) {
      console.error('Import failed', err);
      toast('Import failed', { type: 'error' });
    } finally {
      renderCanvas.width = 0; renderCanvas.height = 0;
      thumbCanvas.width = 0; thumbCanvas.height = 0;
    }
    const combined = [...renderedPagesRef.current, ...newPages];
    renderedPagesRef.current = combined;
    setRenderedPages(combined);
    setLoading(false);
  };

  // ── Render Annotation ─────────────────────────────────────────────────────────

  const renderAnnotation = (ann: Annotation) => {
    const sel = ann.id === selectedId;
    const canDrag = activeTool === 'select';
    const selProps = {
      onClick: () => { if (activeToolRef.current === 'select') setSelectedId(ann.id); },
      onTap: () => { if (activeToolRef.current === 'select') setSelectedId(ann.id); },
    };

    if (ann.type === 'freehand' || ann.type === 'line') return (
      <Line key={ann.id}
        points={ann.points ?? []}
        stroke={sel ? '#3b82f6' : ann.color}
        strokeWidth={ann.strokeWidth}
        tension={ann.type === 'freehand' ? 0.5 : 0}
        lineCap="round" lineJoin="round"
        draggable={canDrag}
        {...selProps}
        onDragEnd={(e) => {
          const dx = e.target.x(), dy = e.target.y();
          e.target.x(0); e.target.y(0);
          pushHistory(annotationsRef.current.map((a) =>
            a.id === ann.id
              ? { ...a, points: a.points?.map((v, i) => i % 2 === 0 ? v + dx : v + dy) }
              : a,
          ));
        }}
      />
    );

    if (ann.type === 'arrow') return (
      <Arrow key={ann.id}
        points={ann.points ?? []}
        stroke={sel ? '#3b82f6' : ann.color}
        fill={sel ? '#3b82f6' : ann.color}
        strokeWidth={ann.strokeWidth}
        pointerLength={12} pointerWidth={8}
        draggable={canDrag}
        {...selProps}
        onDragEnd={(e) => {
          const dx = e.target.x(), dy = e.target.y();
          e.target.x(0); e.target.y(0);
          pushHistory(annotationsRef.current.map((a) =>
            a.id === ann.id
              ? { ...a, points: a.points?.map((v, i) => i % 2 === 0 ? v + dx : v + dy) }
              : a,
          ));
        }}
      />
    );

    if (ann.type === 'rect') {
      const w = ann.width ?? 0, h = ann.height ?? 0;
      return (
        <Rect key={ann.id}
          x={ann.x + (w < 0 ? w : 0)} y={ann.y + (h < 0 ? h : 0)}
          width={Math.abs(w)} height={Math.abs(h)}
          stroke={sel ? '#3b82f6' : ann.color}
          strokeWidth={ann.strokeWidth} fill="transparent"
          draggable={canDrag}
          {...selProps}
          onDragEnd={(e) => {
            const nx = e.target.x(), ny = e.target.y();
            e.target.x(ann.x + (w < 0 ? w : 0));
            e.target.y(ann.y + (h < 0 ? h : 0));
            pushHistory(annotationsRef.current.map((a) =>
              a.id === ann.id ? { ...a, x: nx - (w < 0 ? w : 0), y: ny - (h < 0 ? h : 0) } : a,
            ));
          }}
        />
      );
    }

    if (ann.type === 'ellipse') {
      const w = ann.width ?? 0, h = ann.height ?? 0;
      return (
        <Ellipse key={ann.id}
          x={ann.x + w / 2} y={ann.y + h / 2}
          radiusX={Math.abs(w / 2)} radiusY={Math.abs(h / 2)}
          stroke={sel ? '#3b82f6' : ann.color}
          strokeWidth={ann.strokeWidth} fill="transparent"
          draggable={canDrag}
          {...selProps}
          onDragEnd={(e) => {
            const nx = e.target.x(), ny = e.target.y();
            e.target.x(ann.x + w / 2); e.target.y(ann.y + h / 2);
            pushHistory(annotationsRef.current.map((a) =>
              a.id === ann.id ? { ...a, x: nx - w / 2, y: ny - h / 2 } : a,
            ));
          }}
        />
      );
    }

    if (ann.type === 'text') return (
      <KonvaText key={ann.id}
        x={ann.x} y={ann.y}
        text={ann.text ?? ''}
        fontSize={ann.fontSize ?? 16}
        fill={sel ? '#3b82f6' : ann.color}
        draggable={canDrag}
        {...selProps}
        onDragEnd={(e) => {
          pushHistory(annotationsRef.current.map((a) =>
            a.id === ann.id ? { ...a, x: e.target.x(), y: e.target.y() } : a,
          ));
        }}
      />
    );

    if (ann.type === 'image' || ann.type === 'signature') return (
      <ImageAnnotationNode key={ann.id}
        ann={ann}
        selected={sel && canDrag}
        onSelect={() => { if (canDrag) setSelectedId(ann.id); }}
        onChange={(updated) =>
          pushHistory(annotationsRef.current.map((a) => a.id === updated.id ? updated : a))
        }
      />
    );

    return null;
  };

  // ── Toolbar Helpers ───────────────────────────────────────────────────────────

  const setTool = (t: ToolType) => {
    setActiveTool(t);
    activeToolRef.current = t;
    setSelectedId(null);
    setPendingSig(null);
    pendingSigRef.current = null;
  };

  const ToolBtn = ({ tool, icon, label }: { tool: ToolType; icon: React.ReactNode; label: string }) => (
    <button
      title={label}
      onClick={() => setTool(tool)}
      className={`p-2 rounded-lg transition-colors ${
        activeTool === tool
          ? 'bg-accent-600 text-white shadow-sm'
          : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'
      }`}
    >
      {icon}
    </button>
  );

  const hasPdf = renderedPages.length > 0;

  // ── JSX ───────────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col bg-slate-100 dark:bg-slate-950 font-sans overflow-hidden" style={{ height: '100dvh' }}>
      {/* Hidden file inputs */}
      <input ref={fileInputRef} type="file" accept=".pdf" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) openPdf(f, activeTabId, tabs); e.target.value = ''; }} />

      {/* ── Tab Bar ── */}
      {tabs.length > 0 && (
        <div className="flex items-end gap-0.5 px-2 pt-1 bg-slate-200 dark:bg-slate-900 border-b border-slate-300 dark:border-slate-700 flex-shrink-0 overflow-x-auto no-scrollbar">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-t-lg text-sm font-medium cursor-pointer select-none flex-shrink-0 max-w-[200px] border border-b-0 transition-colors ${
                  isActive
                    ? 'bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 border-slate-300 dark:border-slate-600'
                    : 'bg-slate-100 dark:bg-slate-850 text-slate-500 dark:text-slate-400 border-transparent hover:bg-slate-50 dark:hover:bg-slate-800/60'
                }`}
                onClick={() => switchTab(tab.id, activeTabId)}
              >
                <span className="truncate min-w-0">{tab.fileName}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); closeTab(tab.id, activeTabId, tabs); }}
                  className="flex-shrink-0 p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>
      )}
      <input ref={imageInputRef} type="file" accept="image/*" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) insertImageFile(f); e.target.value = ''; }} />
      <input ref={sigInputRef} type="file" accept="image/*" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) addSignature(f); e.target.value = ''; }} />
      <input ref={importPageInputRef} type="file" accept=".pdf,image/*" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) importPages(f); e.target.value = ''; }} />

      {/* ── Toolbar ── */}
      <div className="flex items-center gap-1 px-3 py-2 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 shadow-sm flex-shrink-0 flex-wrap">
        {/* Sidebar toggle */}
        <button
          onClick={() => setSidebarOpen((v) => !v)}
          title={sidebarOpen ? 'Hide page panel' : 'Show page panel'}
          className="p-2 rounded-lg text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
        >
          {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeft size={16} />}
        </button>

        <div className="w-px h-6 bg-slate-200 dark:bg-slate-700 mx-1" />

        {/* File */}
        <button
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent-600 text-white text-sm font-medium hover:bg-accent-700 transition-colors"
        >
          <FolderOpen size={16} /> Open
        </button>
        <AddFilesButton
          label="Open from documents"
          accept="pdf"
          multi={false}
          size="sm"
          title="Open a PDF already filed under Documents"
          onPick={rows => { const r = rows[0]; if (r) void openPdfByFileId(r.id, activeTabId, tabs); }}
        />
        <button
          onClick={savePdf}
          disabled={!hasPdf || saving}
          title={currentSource ? 'Save over the original Printout' : 'Save a local copy'}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 dark:bg-slate-600 text-white text-sm font-medium hover:bg-slate-700 disabled:opacity-40 transition-colors"
        >
          <Save size={16} /> {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          onClick={saveAsPdf}
          disabled={!hasPdf || saving}
          title="Save a local copy with a new name"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-700 dark:bg-slate-700 text-white text-sm font-medium hover:bg-slate-600 disabled:opacity-40 transition-colors"
        >
          <Download size={16} /> Save As
        </button>

        <div className="w-px h-6 bg-slate-200 dark:bg-slate-700 mx-1" />

        {/* Drawing tools */}
        <ToolBtn tool="select"   icon={<MousePointer size={16} />} label="Select / Move" />
        <ToolBtn tool="freehand" icon={<Pen size={16} />}          label="Freehand pen" />
        <ToolBtn tool="line"     icon={<Minus size={16} />}        label="Line" />
        <ToolBtn tool="arrow"    icon={<ArrowRight size={16} />}   label="Arrow" />
        <ToolBtn tool="rect"     icon={<Square size={16} />}       label="Rectangle" />
        <ToolBtn tool="ellipse"  icon={<Circle size={16} />}       label="Ellipse" />
        <ToolBtn tool="text"     icon={<Type size={16} />}         label="Text" />

        {/* Image insert */}
        <button
          title="Insert Image"
          onClick={() => { setTool('image'); imageInputRef.current?.click(); }}
          className={`p-2 rounded-lg transition-colors ${
            activeTool === 'image'
              ? 'bg-accent-600 text-white shadow-sm'
              : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'
          }`}
        >
          <ImageIcon size={16} />
        </button>
        <AddFilesButton
          label="Insert image"
          accept="image"
          multi={false}
          returnBlobs
          size="sm"
          variant="ghost"
          title="Insert an image already filed under Documents"
          onPickBlobs={picked => {
            const p = picked[0];
            if (p) insertImageFile(new File([p.blob], p.row.name ?? 'image', { type: p.row.mime }));
          }}
        />

        {/* Signature dropdown */}
        <div className="relative" ref={sigMenuRef}>
          <button
            title="Signature"
            onClick={() => setShowSigMenu((v) => !v)}
            className={`flex items-center gap-0.5 p-2 rounded-lg transition-colors ${
              activeTool === 'signature'
                ? 'bg-accent-600 text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'
            }`}
          >
            <PenLine size={16} />
            <ChevronDown size={12} />
          </button>

          {showSigMenu && (
            <div className="absolute top-full left-0 mt-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl z-50 min-w-[220px] py-1">
              <button
                onClick={() => sigInputRef.current?.click()}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
              >
                <Plus size={14} /> Add Signature
              </button>
              {signatures.length > 0 && (
                <div className="border-t border-slate-100 dark:border-slate-700 my-1" />
              )}
              {signatures.map((sig) => (
                <div key={sig.id} className="flex items-center gap-1 px-2 py-1 hover:bg-slate-50 dark:hover:bg-slate-700">
                  <button
                    className="flex-1 flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200 text-left min-w-0"
                    onClick={() => {
                      setPendingSig(sig); pendingSigRef.current = sig;
                      setActiveTool('signature'); activeToolRef.current = 'signature';
                      setShowSigMenu(false);
                    }}
                  >
                    <img
                      src={sig.dataUrl} alt={sig.name}
                      className="h-7 w-auto max-w-[80px] object-contain bg-slate-100 dark:bg-slate-600 rounded px-1 flex-shrink-0"
                    />
                    <span className="truncate">{sig.name}</span>
                  </button>
                  <button
                    onClick={() => deleteSig(sig.id)}
                    className="p-1 text-slate-400 hover:text-red-500 rounded flex-shrink-0"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="w-px h-6 bg-slate-200 dark:bg-slate-700 mx-1" />

        {/* Color + stroke */}
        <input
          type="color" value={color} title="Color"
          onChange={(e) => { setColor(e.target.value); colorRef.current = e.target.value; }}
          className="w-8 h-8 rounded cursor-pointer border border-slate-200 dark:border-slate-600 p-0.5 bg-transparent"
        />
        <select
          value={strokeWidth} title="Stroke width"
          onChange={(e) => { const v = Number(e.target.value); setStrokeWidth(v); swRef.current = v; }}
          className="text-sm px-2 py-1.5 rounded-lg border border-slate-200 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
        >
          {[1, 2, 3, 5, 8].map((w) => <option key={w} value={w}>{w}px</option>)}
        </select>

        <div className="w-px h-6 bg-slate-200 dark:bg-slate-700 mx-1" />

        {/* Undo / Redo / Delete */}
        <button onClick={undo} disabled={histIdx <= 0} title="Undo (Ctrl+Z)"
          className="p-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-30 transition-colors">
          <Undo2 size={16} />
        </button>
        <button onClick={redo} disabled={histIdx >= history.length - 1} title="Redo (Ctrl+Y)"
          className="p-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-30 transition-colors">
          <Redo2 size={16} />
        </button>
        {selectedId && (
          <button
            title="Delete selected (Del)"
            onClick={() => {
              pushHistory(annotationsRef.current.filter((a) => a.id !== selectedId));
              setSelectedId(null);
            }}
            className="p-2 rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
          >
            <Trash2 size={16} />
          </button>
        )}

        {pendingSig && (
          <span className="ml-2 text-xs font-medium text-accent-600 dark:text-accent-400 animate-pulse">
            Click on page to place signature
          </span>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* View mode toggle */}
        <button
          title={viewMode === 'scroll' ? 'Switch to single-page view' : 'Switch to scroll view'}
          onClick={() => { setViewMode((m) => m === 'scroll' ? 'single' : 'scroll'); setCurrentPage(0); }}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
        >
          {viewMode === 'scroll' ? <BookOpen size={15} /> : <Layers size={15} />}
          <span className="hidden sm:inline">{viewMode === 'scroll' ? 'Single' : 'All Pages'}</span>
        </button>

        <div className="w-px h-6 bg-slate-200 dark:bg-slate-700 mx-1" />

        {/* Zoom controls */}
        <button
          onClick={() => setZoom((z) => clampZoom(Math.round((z - 0.1) * 10) / 10))}
          title="Zoom out (Ctrl+-)"
          className="p-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
        >
          <ZoomOut size={16} />
        </button>

        <div className="relative" ref={zoomMenuRef}>
          <button
            onClick={() => setShowZoomMenu((v) => !v)}
            className="min-w-[56px] px-2 py-1.5 rounded-lg text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors text-center"
            title="Zoom level"
          >
            {Math.round(zoom * 100)}%
          </button>
          {showZoomMenu && (
            <div className="absolute top-full right-0 mt-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl z-50 py-1 min-w-[140px]">
              {[
                { label: '50%',  value: 0.5 },
                { label: '75%',  value: 0.75 },
                { label: '100%', value: 1 },
                { label: '125%', value: 1.25 },
                { label: '150%', value: 1.5 },
                { label: '200%', value: 2 },
              ].map(({ label, value }) => (
                <button key={value} onClick={() => { applyZoom(value); setShowZoomMenu(false); }}
                  className={`w-full px-3 py-1.5 text-sm text-left transition-colors hover:bg-slate-50 dark:hover:bg-slate-700 ${Math.round(zoom * 100) === Math.round(value * 100) ? 'text-accent-600 dark:text-accent-400 font-semibold' : 'text-slate-700 dark:text-slate-200'}`}>
                  {label}
                </button>
              ))}
              <div className="border-t border-slate-100 dark:border-slate-700 my-1" />
              <button onClick={() => { fitWidth(); setShowZoomMenu(false); }}
                className="w-full px-3 py-1.5 text-sm text-left text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors">
                Fit Width
              </button>
              <button onClick={() => { fitHeight(); setShowZoomMenu(false); }}
                className="w-full px-3 py-1.5 text-sm text-left text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors">
                Fit Height
              </button>
              <button onClick={() => { fitPage(); setShowZoomMenu(false); }}
                className="w-full px-3 py-1.5 text-sm text-left text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors">
                Fit Page
              </button>
            </div>
          )}
        </div>

        <button
          onClick={() => setZoom((z) => clampZoom(Math.round((z + 0.1) * 10) / 10))}
          title="Zoom in (Ctrl++)"
          className="p-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
        >
          <ZoomIn size={16} />
        </button>
      </div>

      {/* ── Main content: sidebar + canvas ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── Page Thumbnail Sidebar ── */}
        {sidebarOpen && (
          <div className="w-44 flex-shrink-0 bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 flex flex-col overflow-hidden">
            <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-800 flex-shrink-0 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Pages</span>
                <button
                  title="Import pages from PDF or image"
                  onClick={() => importPageInputRef.current?.click()}
                  className="p-1 rounded-lg text-slate-400 hover:text-accent-600 dark:hover:text-accent-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                >
                  <Plus size={14} />
                </button>
              </div>
              <AddFilesButton
                label="Import pages"
                accept="any"
                multi={false}
                returnBlobs
                size="sm"
                variant="ghost"
                className="w-full"
                title="Import pages from a document already on file"
                onPickBlobs={picked => {
                  const p = picked[0];
                  if (p) void importPages(new File([p.blob], p.row.name ?? 'import', { type: p.row.mime }));
                }}
              />
            </div>
            <div
              ref={sidebarListRef}
              className="flex-1 overflow-y-auto py-2 px-2 space-y-2"
              style={{ touchAction: draggingPageIdx !== null ? 'none' : undefined }}
              onPointerDown={(e) => {
                const el = e.target as HTMLElement;
                if (!el.closest('[data-drag-handle]')) return;
                for (let i = 0; i < renderedPages.length; i++) {
                  if (sidebarThumbRefs.current[i]?.contains(el)) {
                    e.preventDefault();
                    draggingPageIdxRef.current = i;
                    dragOverPageRef.current = i;
                    setDraggingPageIdx(i);
                    setDragOverPageIdx(i);
                    sidebarListRef.current?.setPointerCapture(e.pointerId);
                    break;
                  }
                }
              }}
              onPointerMove={(e) => {
                if (draggingPageIdxRef.current === null) return;
                const el = document.elementFromPoint(e.clientX, e.clientY);
                for (let i = 0; i < renderedPages.length; i++) {
                  const ref = sidebarThumbRefs.current[i];
                  if (ref && ref.contains(el as Node)) {
                    if (dragOverPageRef.current !== i) {
                      dragOverPageRef.current = i;
                      setDragOverPageIdx(i);
                    }
                    break;
                  }
                }
              }}
              onPointerUp={(e) => {
                const from = draggingPageIdxRef.current;
                const to = dragOverPageRef.current;
                draggingPageIdxRef.current = null;
                dragOverPageRef.current = null;
                setDraggingPageIdx(null);
                setDragOverPageIdx(null);
                sidebarListRef.current?.releasePointerCapture(e.pointerId);
                if (from !== null && to !== null && from !== to) reorderPages(from, to);
              }}
              onPointerCancel={() => {
                draggingPageIdxRef.current = null;
                dragOverPageRef.current = null;
                setDraggingPageIdx(null);
                setDragOverPageIdx(null);
              }}
            >
              {renderedPages.map((page, idx) => {
                const isActive = viewMode === 'single' ? idx === currentPage : false;
                const isDragging = draggingPageIdx === idx;
                const isDragOver = dragOverPageIdx === idx && draggingPageIdx !== null && draggingPageIdx !== idx;
                return (
                  <div
                    key={idx}
                    ref={(el) => { sidebarThumbRefs.current[idx] = el; }}
                    className={`relative rounded-lg overflow-hidden border-2 transition-all group ${
                      isDragOver
                        ? 'border-accent-500 ring-2 ring-accent-400/40'
                        : isActive
                        ? 'border-accent-500'
                        : isDragging
                        ? 'border-accent-300 opacity-40'
                        : 'border-transparent hover:border-slate-300 dark:hover:border-slate-600'
                    }`}
                  >
                    {/* Drag handle */}
                    <div
                      data-drag-handle="true"
                      title="Drag to reorder"
                      className="absolute top-1 left-1 z-10 p-0.5 bg-white/80 dark:bg-slate-700/80 rounded cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity"
                      style={{ touchAction: 'none' }}
                    >
                      <GripVertical size={10} className="text-slate-500 dark:text-slate-300" />
                    </div>

                    {/* Thumbnail (click to navigate) */}
                    <button
                      className="w-full"
                      onClick={() => {
                        if (draggingPageIdxRef.current !== null) return;
                        if (viewMode === 'single') {
                          setCurrentPage(idx);
                        } else {
                          pageRefs.current[idx]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        }
                      }}
                    >
                      <img
                        src={page.thumbUrl}
                        alt={`Page ${idx + 1}`}
                        className="w-full block"
                        draggable={false}
                      />
                      <div className={`text-center text-xs py-0.5 ${
                        isActive
                          ? 'text-accent-600 dark:text-accent-400 font-semibold'
                          : 'text-slate-400 dark:text-slate-500'
                      }`}>
                        {idx + 1}
                      </div>
                    </button>

                    {/* Delete button */}
                    <button
                      title={`Delete page ${idx + 1}`}
                      onClick={(e) => { e.stopPropagation(); deletePage(idx); }}
                      className="absolute top-1 right-1 z-10 p-0.5 bg-white/80 dark:bg-slate-700/80 rounded text-red-400 hover:text-red-600 opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <Trash2 size={10} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Right column: optional nav bar + canvas ── */}
        <div className="flex flex-col flex-1 overflow-hidden">
          {/* Single-page navigation bar */}
          {viewMode === 'single' && hasPdf && (
            <div className="flex items-center justify-center gap-3 px-4 py-1.5 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 flex-shrink-0">
              <button
                onClick={() => setCurrentPage((p) => Math.max(0, p - 1))}
                disabled={currentPage === 0}
                className="p-1.5 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-30 transition-colors"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="text-sm font-medium text-slate-600 dark:text-slate-300 min-w-[100px] text-center">
                Page {currentPage + 1} of {renderedPages.length}
              </span>
              <button
                onClick={() => setCurrentPage((p) => Math.min(renderedPages.length - 1, p + 1))}
                disabled={currentPage === renderedPages.length - 1}
                className="p-1.5 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-30 transition-colors"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          )}

      {/* ── Canvas Area ── */}
      <div ref={scrollContainerRef} className="flex-1 overflow-auto flex flex-col items-center py-6 gap-4 bg-slate-300 dark:bg-slate-950">
        {loading && (
          <div className="flex flex-col items-center gap-3 py-20">
            <div className="w-8 h-8 border-4 border-accent-600 border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-slate-500 dark:text-slate-400">{loadMsg}</p>
          </div>
        )}

        {!loading && !hasPdf && (
          <div className="flex flex-col items-center gap-4 py-20 text-center">
            <div className="w-20 h-20 bg-white dark:bg-slate-800 rounded-2xl flex items-center justify-center shadow-md">
              <FolderOpen size={40} className="text-accent-600 dark:text-accent-400" />
            </div>
            <div>
              <p className="text-lg font-semibold text-slate-700 dark:text-slate-200">Open a PDF to get started</p>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Annotate, sign, and export — entirely in your browser</p>
            </div>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="px-5 py-2.5 bg-accent-600 hover:bg-accent-700 text-white rounded-xl font-medium text-sm transition-colors"
            >
              Open PDF
            </button>
          </div>
        )}

        {(viewMode === 'scroll' ? renderedPages : renderedPages.slice(currentPage, currentPage + 1))
          .map((page, idx) => {
          const pageIndex = viewMode === 'scroll' ? idx : currentPage;
          const displayW = Math.round(page.width * zoom);
          const displayH = Math.round(page.height * zoom);
          return (
          <div
            key={pageIndex}
            ref={(el) => { pageRefs.current[pageIndex] = el; }}
            style={{ position: 'relative', width: displayW, height: displayH }}
            className="shadow-xl rounded-sm flex-shrink-0 bg-white"
          >
            {/* Fallback raster for legacy persisted tabs / image-imported pages.
                Sits underneath the live canvas so it shows through until the
                on-demand render paints — and stays as the visible content if no
                proxy can render this page (e.g. images appended before pdfBytes
                was rebuilt). */}
            {page.dataUrl && (
              <img
                src={page.dataUrl}
                alt={`Page ${pageIndex + 1}`}
                draggable={false}
                style={{
                  position: 'absolute', top: 0, left: 0,
                  width: displayW, height: displayH,
                  display: 'block', userSelect: 'none', pointerEvents: 'none',
                }}
              />
            )}

            {/* Live vector render from the PDFDocumentProxy — crisp at every zoom. */}
            <PdfPageCanvas
              pdfProxy={pdfProxy}
              pageIndex={pageIndex}
              displayWidth={displayW}
              displayHeight={displayH}
            />

            {/* Konva annotation layer — scaleX/Y maps annotation coords to display coords */}
            <Stage
              width={displayW}
              height={displayH}
              scaleX={zoom}
              scaleY={zoom}
              style={{
                position: 'absolute', top: 0, left: 0,
                cursor: activeTool === 'select' ? 'default' : 'crosshair',
              }}
              onMouseDown={(e) => handleMouseDown(e, pageIndex)}
              onMouseMove={(e) => handleMouseMove(e, pageIndex)}
              onMouseUp={() => handleMouseUp()}
            >
              <Layer>
                {/* Finalized annotations */}
                {annotations
                  .filter((a) => a.pageIndex === pageIndex)
                  .map(renderAnnotation)}

                {/* In-progress preview */}
                {currentAnn?.pageIndex === pageIndex && (() => {
                  const a = currentAnn;
                  if (a.type === 'freehand') return (
                    <Line points={a.points ?? []} stroke={a.color} strokeWidth={a.strokeWidth}
                      tension={0.5} lineCap="round" lineJoin="round" listening={false} />
                  );
                  if (a.type === 'line') return (
                    <Line points={a.points ?? []} stroke={a.color} strokeWidth={a.strokeWidth}
                      lineCap="round" listening={false} />
                  );
                  if (a.type === 'arrow') return (
                    <Arrow points={a.points ?? []} stroke={a.color} fill={a.color}
                      strokeWidth={a.strokeWidth} pointerLength={12} pointerWidth={8} listening={false} />
                  );
                  if (a.type === 'rect') {
                    const w = a.width ?? 0, h = a.height ?? 0;
                    return <Rect x={a.x + (w < 0 ? w : 0)} y={a.y + (h < 0 ? h : 0)}
                      width={Math.abs(w)} height={Math.abs(h)}
                      stroke={a.color} strokeWidth={a.strokeWidth} fill="transparent" listening={false} />;
                  }
                  if (a.type === 'ellipse') {
                    const w = a.width ?? 0, h = a.height ?? 0;
                    return <Ellipse x={a.x + w / 2} y={a.y + h / 2}
                      radiusX={Math.abs(w / 2)} radiusY={Math.abs(h / 2)}
                      stroke={a.color} strokeWidth={a.strokeWidth} fill="transparent" listening={false} />;
                  }
                  return null;
                })()}
              </Layer>
            </Stage>

            {/* In-place text editor */}
            {editingText?.pageIndex === pageIndex && (
              <textarea
                ref={textareaRef}
                value={editingText.text}
                onChange={(e) => setEditingText((prev) => prev ? { ...prev, text: e.target.value } : null)}
                onBlur={() => {
                  if (editingText.text.trim()) {
                    const ann: Annotation = {
                      id: uid(), pageIndex, type: 'text',
                      x: editingText.x, y: editingText.y,
                      color: colorRef.current, strokeWidth: swRef.current,
                      text: editingText.text, fontSize: 16,
                    };
                    pushHistory([...annotationsRef.current, ann]);
                  }
                  setEditingText(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setEditingText(null);
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    (e.target as HTMLTextAreaElement).blur();
                  }
                }}
                style={{
                  position: 'absolute',
                  left: editingText.x * zoom,
                  top: editingText.y * zoom,
                  fontSize: 16 * zoom,
                  lineHeight: 1.2,
                  minWidth: 80 * zoom,
                  minHeight: 20 * zoom,
                  color: colorRef.current,
                }}
                className="bg-transparent border border-accent-400 rounded px-1 outline-none resize-none z-50 font-sans"
              />
            )}

            {/* Page number badge — only in scroll mode (single mode has nav bar) */}
            {viewMode === 'scroll' && renderedPages.length > 1 && (
              <div className="absolute bottom-2 right-3 text-xs text-slate-500 bg-white/80 dark:bg-slate-900/80 rounded px-1.5 py-0.5 pointer-events-none select-none">
                {pageIndex + 1} / {renderedPages.length}
              </div>
            )}
          </div>
          );
        })}
      </div>
        </div> {/* end right column */}
      </div> {/* end main content flex-row */}
    </div>
  );
};
