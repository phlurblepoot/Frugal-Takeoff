import React, { useState, useRef, useEffect, useCallback } from 'react';
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
  FolderOpen, Save, MousePointer, Pen, Minus, ArrowRight,
  Square, Circle, Type, Image as ImageIcon, PenLine,
  ChevronDown, ChevronLeft, ChevronRight,
  Undo2, Redo2, Trash2, Plus, X,
  ZoomIn, ZoomOut, Layers, BookOpen,
  PanelLeft, PanelLeftClose,
} from 'lucide-react';

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
}

interface RenderedPage {
  dataUrl: string;
  thumbUrl: string;
  width: number;
  height: number;
}

interface TabSnapshot {
  id: string;
  fileName: string;
  pdfBytes: ArrayBuffer;
  renderedPages: RenderedPage[];
  annotations: Annotation[];
  history: Annotation[][];
  histIdx: number;
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
        if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) d[i + 3] = 0;
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

const SIGS_KEY = 'pdfEditorSignatures';
const loadSigs = (): Signature[] => {
  try { return JSON.parse(localStorage.getItem(SIGS_KEY) || '[]'); } catch { return []; }
};
const saveSigs = (s: Signature[]) => localStorage.setItem(SIGS_KEY, JSON.stringify(s));

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

// ── PdfEditor ─────────────────────────────────────────────────────────────────

export const PdfEditor: React.FC = () => {
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

  useEffect(() => { annotationsRef.current = annotations; }, [annotations]);
  useEffect(() => { historyRef.current = history; }, [history]);
  useEffect(() => { histIdxRef.current = histIdx; }, [histIdx]);
  useEffect(() => { activeToolRef.current = activeTool; }, [activeTool]);
  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { swRef.current = strokeWidth; }, [strokeWidth]);
  useEffect(() => { pendingSigRef.current = pendingSig; }, [pendingSig]);
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);
  useEffect(() => { renderedPagesRef.current = renderedPages; }, [renderedPages]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const sigInputRef = useRef<HTMLInputElement>(null);
  const sigMenuRef = useRef<HTMLDivElement>(null);
  const zoomMenuRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);

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

  // ── Tab management ────────────────────────────────────────────────────────────

  const saveCurrentTabState = useCallback((tabId: string) => {
    setTabs((prev) => prev.map((t) =>
      t.id === tabId
        ? { ...t, annotations: annotationsRef.current, history: historyRef.current, histIdx: histIdxRef.current }
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
      setActiveTabId(tabId);
      setAnnotations(tab.annotations);
      setHistory(tab.history);
      setHistIdx(tab.histIdx);
      setRenderedPages(tab.renderedPages);
      setPdfBytes(tab.pdfBytes);
      setFileName(tab.fileName);
      setSelectedId(null);
      setCurrentAnn(null);
      setCurrentPage(0);
      return prev;
    });
  }, [saveCurrentTabState]);

  const closeTab = useCallback((tabId: string, currentId: string | null, allTabs: TabSnapshot[]) => {
    const remaining = allTabs.filter((t) => t.id !== tabId);
    setTabs(remaining);
    if (tabId !== currentId) return; // closing a non-active tab — no state change needed

    if (remaining.length === 0) {
      // Last tab closed — reset to empty
      setActiveTabId(null);
      annotationsRef.current = []; historyRef.current = [[]]; histIdxRef.current = 0;
      renderedPagesRef.current = [];
      setAnnotations([]); setHistory([[]]); setHistIdx(0);
      setRenderedPages([]); setPdfBytes(null); setFileName('');
      setSelectedId(null); setCurrentAnn(null); setCurrentPage(0);
    } else {
      // Switch to the nearest remaining tab
      const newTab = remaining[Math.min(allTabs.findIndex((t) => t.id === tabId), remaining.length - 1)];
      annotationsRef.current = newTab.annotations;
      historyRef.current = newTab.history;
      histIdxRef.current = newTab.histIdx;
      renderedPagesRef.current = newTab.renderedPages;
      setActiveTabId(newTab.id);
      setAnnotations(newTab.annotations); setHistory(newTab.history); setHistIdx(newTab.histIdx);
      setRenderedPages(newTab.renderedPages); setPdfBytes(newTab.pdfBytes); setFileName(newTab.fileName);
      setSelectedId(null); setCurrentAnn(null); setCurrentPage(0);
    }
  }, []);

  // ── PDF Loading ───────────────────────────────────────────────────────────────

  const openPdf = async (file: File, currentTabId: string | null, currentTabs: TabSnapshot[]) => {
    setLoading(true);
    setLoadMsg('Rendering pages…');

    const buf = await file.arrayBuffer();
    const objectUrl = URL.createObjectURL(file);
    const pdf = await pdfjsLib.getDocument({ url: objectUrl }).promise;
    const pages: RenderedPage[] = [];
    const canvas = document.createElement('canvas');
    const thumbCanvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    const thumbCtx = thumbCanvas.getContext('2d')!;
    const THUMB_W = 148;

    for (let i = 1; i <= pdf.numPages; i++) {
      setLoadMsg(`Rendering page ${i} of ${pdf.numPages}…`);
      const page = await pdf.getPage(i);
      const vp = page.getViewport({ scale: 1.5 });
      canvas.width = vp.width; canvas.height = vp.height;
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, vp.width, vp.height);
      await page.render({ canvasContext: ctx, viewport: vp } as any).promise;
      // Generate thumbnail
      const thumbH = Math.round(THUMB_W * vp.height / vp.width);
      thumbCanvas.width = THUMB_W; thumbCanvas.height = thumbH;
      thumbCtx.drawImage(canvas, 0, 0, THUMB_W, thumbH);
      pages.push({
        dataUrl: canvas.toDataURL('image/jpeg', 0.85),
        thumbUrl: thumbCanvas.toDataURL('image/jpeg', 0.75),
        width: vp.width, height: vp.height,
      });
      page.cleanup();
    }

    await pdf.destroy();
    URL.revokeObjectURL(objectUrl);
    canvas.width = 0; canvas.height = 0; thumbCanvas.width = 0; thumbCanvas.height = 0;

    const newTabId = uid();
    const newTab: TabSnapshot = {
      id: newTabId, fileName: file.name, pdfBytes: buf,
      renderedPages: pages, annotations: [], history: [[]], histIdx: 0,
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
    annotationsRef.current = []; historyRef.current = [[]]; histIdxRef.current = 0;
    renderedPagesRef.current = pages;
    setAnnotations([]); setHistory([[]]); setHistIdx(0);
    setRenderedPages(pages); setPdfBytes(buf); setFileName(file.name);
    setSelectedId(null); setCurrentAnn(null); setCurrentPage(0);
    setLoading(false);

    // Auto fit-width after load
    requestAnimationFrame(() => {
      const container = scrollContainerRef.current;
      if (!container || !pages.length) return;
      setZoom(clampZoom((container.clientWidth - 48) / pages[0].width));
    });
  };

  // ── Konva Event Handlers ──────────────────────────────────────────────────────

  const getPos = (e: any) =>
    e.target.getStage()?.getPointerPosition() as { x: number; y: number } | null;

  const handleMouseDown = useCallback((e: any, pageIndex: number) => {
    const tool = activeToolRef.current;
    const pos = getPos(e);
    if (!pos) return;

    if (tool === 'select') {
      if (e.target === e.target.getStage()) setSelectedId(null);
      return;
    }

    if (tool === 'text') {
      const text = window.prompt('Enter text:');
      if (!text) return;
      const ann: Annotation = {
        id: uid(), pageIndex, type: 'text',
        x: pos.x, y: pos.y,
        color: colorRef.current, strokeWidth: swRef.current,
        text, fontSize: 16,
      };
      pushHistory([...annotationsRef.current, ann]);
      return;
    }

    if (tool === 'signature') {
      const sig = pendingSigRef.current;
      if (!sig) return;
      const ann: Annotation = {
        id: uid(), pageIndex, type: 'signature',
        x: pos.x - 75, y: pos.y - 40,
        width: 150, height: 80,
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
      const ann: Annotation = {
        id: uid(), pageIndex: 0, type: 'image',
        x: 50, y: 50, width: 200, height: 150,
        color: colorRef.current, strokeWidth: swRef.current,
        imageDataUrl: reader.result as string,
      };
      pushHistory([...annotationsRef.current, ann]);
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
    const sig: Signature = {
      id: uid(),
      name: file.name.replace(/\.[^/.]+$/, '') || 'Signature',
      dataUrl: cleaned,
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

  const exportPdf = async () => {
    if (!pdfBytes) return;
    setSaving(true);
    try {
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const pdfPages = pdfDoc.getPages();

      for (const ann of annotationsRef.current) {
        const page = pdfPages[ann.pageIndex];
        if (!page) continue;
        const { width: pdfW, height: pdfH } = page.getSize();
        const rp = renderedPagesRef.current[ann.pageIndex];
        if (!rp) continue;
        const sx = pdfW / rp.width;
        const sy = pdfH / rp.height;
        const c = hexToRgb(ann.color);

        if (ann.type === 'rect') {
          const w = (ann.width ?? 0) * sx;
          const h = (ann.height ?? 0) * sy;
          page.drawRectangle({
            x: ann.x * sx + (w < 0 ? w : 0),
            y: pdfH - ann.y * sy - (h > 0 ? h : 0),
            width: Math.abs(w), height: Math.abs(h),
            borderColor: c, borderWidth: ann.strokeWidth,
          });
        } else if (ann.type === 'ellipse') {
          const w = (ann.width ?? 0) * sx;
          const h = (ann.height ?? 0) * sy;
          page.drawEllipse({
            x: ann.x * sx + w / 2,
            y: pdfH - ann.y * sy - h / 2,
            xScale: Math.abs(w / 2), yScale: Math.abs(h / 2),
            borderColor: c, borderWidth: ann.strokeWidth,
          });
        } else if (ann.type === 'text' && ann.text) {
          page.drawText(ann.text, {
            x: ann.x * sx,
            y: pdfH - (ann.y + (ann.fontSize ?? 16)) * sy,
            size: (ann.fontSize ?? 16) * Math.min(sx, sy),
            color: c,
          });
        } else if ((ann.type === 'image' || ann.type === 'signature') && ann.imageDataUrl) {
          try {
            const bytes = dataUrlToBytes(ann.imageDataUrl);
            const emb = ann.imageDataUrl.includes('image/png')
              ? await pdfDoc.embedPng(bytes)
              : await pdfDoc.embedJpg(bytes);
            const w = (ann.width ?? 150) * sx;
            const h = (ann.height ?? 80) * sy;
            page.drawImage(emb, {
              x: ann.x * sx,
              y: pdfH - ann.y * sy - h,
              width: w, height: h,
            });
          } catch {
            // skip if image cannot be embedded
          }
        } else if (ann.points && ann.points.length >= 4) {
          const pts = ann.points;
          for (let i = 0; i < pts.length - 2; i += 2) {
            page.drawLine({
              start: { x: pts[i] * sx, y: pdfH - pts[i + 1] * sy },
              end: { x: pts[i + 2] * sx, y: pdfH - pts[i + 3] * sy },
              color: c, thickness: ann.strokeWidth,
            });
          }
        }
      }

      const saved = await pdfDoc.save();
      const url = URL.createObjectURL(new Blob([saved], { type: 'application/pdf' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName.replace(/\.pdf$/i, '') + '_annotated.pdf';
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setSaving(false);
    }
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
    <div className="flex flex-col h-screen bg-slate-100 dark:bg-slate-950 font-sans overflow-hidden">
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
        <button
          onClick={exportPdf}
          disabled={!hasPdf || saving}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 dark:bg-slate-600 text-white text-sm font-medium hover:bg-slate-700 disabled:opacity-40 transition-colors"
        >
          <Save size={16} /> {saving ? 'Saving…' : 'Save PDF'}
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
            <div className="absolute bottom-full right-0 mb-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl z-50 py-1 min-w-[140px]">
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
            <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-800 flex-shrink-0">
              <span className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Pages</span>
            </div>
            <div className="flex-1 overflow-y-auto py-2 px-2 space-y-2">
              {renderedPages.map((page, idx) => {
                const isActive = viewMode === 'single'
                  ? idx === currentPage
                  : false; // scroll mode — no single "active" page
                return (
                  <button
                    key={idx}
                    onClick={() => {
                      if (viewMode === 'single') {
                        setCurrentPage(idx);
                      } else {
                        pageRefs.current[idx]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      }
                    }}
                    className={`w-full rounded-lg overflow-hidden border-2 transition-colors ${
                      isActive
                        ? 'border-accent-500'
                        : 'border-transparent hover:border-slate-300 dark:hover:border-slate-600'
                    }`}
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
            {/* PDF page image — non-interactive background */}
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
