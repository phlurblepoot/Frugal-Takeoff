import React, { useEffect, useState, useRef, useMemo } from 'react';
import { useParams, Link, useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { ArrowLeft, FileImage, Settings, Plus, Trash2, ChevronRight, Edit2, Check, X, Loader2, Upload, Search, Printer, Eye, FileText, Hash, ZoomIn, ZoomOut, Maximize, FileSpreadsheet, Calendar, Building2, MapPin, Clock, Link as LinkIcon, Mail, LayoutGrid, List, Star, HardDrive, Layers, History, GitCompare, Copy, SlidersHorizontal } from 'lucide-react';
import { Project, MeasurementTakeoff, ProjectPage, Printout, TakeoffTemplate, CustomCost, ProjectNote } from '../types';
import { getProject, saveProject, getImageUrl, saveImage, saveFile, saveBinaryFile, getFile, getTemplates, getActivePages, getProjectNotes, saveProjectNotes, getSettings, getUserPreferences, saveUserPreferences, createShare, getProjectStorage, formatBytes, ProjectStorage, recordRecentProject } from '../utils/store';
import { formatRealValue, UNIT_LABELS, calculateTakeoffTotalCost, evaluateMathExpression, calculateTakeoffCostDetails, roundUpTo100 } from '../utils/math';
import { allocateSubsetCost, allocateSubsetDetails, SubsetCostDetail } from '../utils/costAllocation';
import { loadPdfPagesGenerator, detectPageInfo } from '../utils/pdf';
import { computeRevisionModel, orderedPlanSets, summarizePlanSet, sheetKey } from '../utils/planSets';
import { PlanSetManager } from '../components/PlanSetManager';
import { PlanSetRevisions } from '../components/PlanSetRevisions';
import { PlanSetCompare } from '../components/PlanSetCompare';
import { PageNamingStep } from '../components/PageNamingStep';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
// @ts-ignore
import pdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;
import { v4 as uuidv4 } from 'uuid';
import * as XLSX from 'xlsx';
import { NewTakeoffModal } from '../components/NewTakeoffModal';
import { UploadFailuresModal, UploadFailure } from '../components/UploadFailuresModal';
import { StickyNote } from 'lucide-react';
import { useNotes } from '../context/NotesContext';
import { useCollaboration } from '../context/CollaborationContext';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import { useShareLink } from '../components/ShareLinkModal';
import { Skeleton } from '../components/Skeleton';
import { ProjectStageControl } from '../components/ProjectStageControl';
import { CustomCostRow } from '../components/CustomCostRow';
import {
  buildHighlightsPdf,
  computeTakeoffTotals,
  HIGHLIGHT_QUALITY_PRESETS,
  HighlightQuality,
} from './project/proposal/proposalGenerator';
import { EmailTab } from './project/EmailTab';

// Renders `text` with the first case-insensitive occurrence of `term` wrapped
// in <mark> so search hits visibly pop out of page titles and snippets. No
// match → text renders unchanged. Multi-occurrence highlighting is overkill
// for page titles (one match is enough) and we keep snippets short anyway.
const HighlightedText: React.FC<{ text: string; term: string }> = ({ text, term }) => {
  if (!term) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(term.toLowerCase());
  if (idx < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-yellow-200 dark:bg-yellow-600/40 text-inherit rounded px-0.5">
        {text.slice(idx, idx + term.length)}
      </mark>
      {text.slice(idx + term.length)}
    </>
  );
};

const PROJECT_TAB_VALUES = ['pages', 'takeoffs', 'email'] as const;
type ProjectTab = (typeof PROJECT_TAB_VALUES)[number];

export const ProjectView: React.FC = () => {
  const { openNotes } = useNotes();
  const { setPageName } = useCollaboration();
  const { toast } = useToast();
  const confirm = useConfirm();
  const shareLink = useShareLink();
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const searchTerm = searchParams.get('search') || '';
  const setSearchTerm = (term: string) => {
    if (term) {
      searchParams.set('search', term);
    } else {
      searchParams.delete('search');
    }
    setSearchParams(searchParams, { replace: true });
  };
  const [project, setProject] = useState<Project | null>(null);
  const [takeoffToDelete, setTakeoffToDelete] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showDeleteAllConfirm, setShowDeleteAllConfirm] = useState(false);
  // Tab lives in the URL so the project sidebar can highlight the section,
  // refresh/back preserve it, and links can target a tab directly.
  const tabParam = searchParams.get('tab');
  const activeTab: ProjectTab = (PROJECT_TAB_VALUES as readonly string[]).includes(tabParam ?? '')
    ? (tabParam as ProjectTab)
    : 'pages';
  const setActiveTab = (tab: ProjectTab) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (tab === 'pages') next.delete('tab');
      else next.set('tab', tab);
      return next;
    }, { replace: true });
  };
  const [isLoading, setIsLoading] = useState(true);
  const [projectStorage, setProjectStorage] = useState<ProjectStorage | null>(null);
  const [projectNote, setProjectNote] = useState<ProjectNote | null>(null);
  const [showTakeoffModal, setShowTakeoffModal] = useState(false);
  const [templates, setTemplates] = useState<TakeoffTemplate[]>([]);

  const [selectedTakeoffIds, setSelectedTakeoffIds] = useState<Set<string>>(new Set());
  const [selectedPageIds, setSelectedPageIds] = useState<Set<string>>(new Set());
  // Pages-tab layout: grid is the default (thumbnail-first browsing), list is
  // better when descriptions matter more than the visual since the grid cell
  // truncates them. Persisted per-user via getUserPreferences (see the load
  // effect that hydrates other preferences).
  const [pagesViewMode, setPagesViewMode] = useState<'grid' | 'list'>('grid');
  // Sort order for the pages list. Numeric sort by pageNumber is the default
  // (matches typical drawing-set conventions: A-101 before A-201 etc.).
  // Persisted per-user under 'pages-sortMode'.
  type PagesSortMode = 'pageNumber' | 'description' | 'highlightsDesc';
  const [pagesSortMode, setPagesSortMode] = useState<PagesSortMode>('pageNumber');
  // Right-click context menu for page tiles/rows. Stored as viewport coords
  // so the menu renders correctly regardless of the underlying page card's
  // position. Cleared on any outside click or Escape.
  const [pageContextMenu, setPageContextMenu] = useState<{ pageId: string; x: number; y: number } | null>(null);
  const pageSearchInputRef = useRef<HTMLInputElement>(null);
  // Per-user, per-project favorites. Stored in userPreferences under
  // `pages-favorites-{projectId}` as a JSON array; loaded on project mount
  // and saved on every toggle. Favorited pages sort to the top of the page
  // list inside whatever sort mode is active.
  const [favoritePageIds, setFavoritePageIds] = useState<Set<string>>(new Set());
  const pagesScrollRef = useRef<HTMLDivElement>(null);
  const [editTakeoffPricePackage, setEditTakeoffPricePackage] = useState('');
  const [isPrinting, setIsPrinting] = useState(false);
  const [isExportingExcel, setIsExportingExcel] = useState(false);
  const [progressMessage, setProgressMessage] = useState('');
  // Blueprint print quality for the Print (highlighted plans) export. Persisted
  // per-user via the proposal-prefs effect below since it's shared with the
  // proposal section's highlight quality.
  const [highlightQuality, setHighlightQuality] = useState<HighlightQuality>('standard');

  // ── Scroll position memory for pages tab ─────────────────────────────────
  const scrollKey = `projectView-scroll-${projectId}`;
  // Wait for content to load before restoring — firing during isLoading=true
  // restores onto an empty page which then gets reset when content appears.
  useEffect(() => {
    if (activeTab !== 'pages' || isLoading) return;
    const saved = sessionStorage.getItem(scrollKey);
    if (saved) {
      requestAnimationFrame(() => window.scrollTo({ top: parseInt(saved, 10), behavior: 'instant' as ScrollBehavior }));
    }
  }, [activeTab, isLoading]);

  useEffect(() => {
    if (activeTab !== 'pages') return;
    const onScroll = () => sessionStorage.setItem(scrollKey, String(Math.round(window.scrollY)));
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [activeTab, scrollKey]);

  // Update collaboration page name when project loads
  useEffect(() => {
    if (project) setPageName(project.name);
  }, [project, setPageName]);

  // Load saved prefs on mount from the server (source of truth). The proposal
  // section owns the bulk of proposal preferences now; ProjectView only still
  // reads the shared blueprint print quality (used by the Print export) plus
  // the pages-tab view/sort modes.
  useEffect(() => {
    getUserPreferences().then(prefs => {
      if (prefs['proposal-highlightQuality'])             setHighlightQuality(prefs['proposal-highlightQuality'] as HighlightQuality);
      if (prefs['pages-viewMode'] === 'grid' || prefs['pages-viewMode'] === 'list') setPagesViewMode(prefs['pages-viewMode']);
      const sort = prefs['pages-sortMode'];
      // 'name' was an earlier option that effectively duplicated pageNumber
      // sort (the auto-built name string is prefixed by the page number, so
      // it dominated the order). Anyone who picked it back then is promoted
      // to description sort, which is what the option was meant to do.
      if (sort === 'pageNumber' || sort === 'description' || sort === 'highlightsDesc') setPagesSortMode(sort);
      else if (sort === 'name') setPagesSortMode('description');
    }).catch(() => { /* offline — defaults already applied */ });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist the pages-tab view mode + sort separately from the proposal
  // prefs — these are UI preferences, not part of proposal generation.
  useEffect(() => {
    saveUserPreferences({ 'pages-viewMode': pagesViewMode, 'pages-sortMode': pagesSortMode }).catch(() => {});
  }, [pagesViewMode, pagesSortMode]);

  // Keyboard shortcut: "/" focuses the search box (GitHub-style). Skip if the
  // user is already typing into something — we don't want to clobber an in-
  // progress rename or note. Also skip when the Pages tab isn't active since
  // there's no search input on screen to focus.
  useEffect(() => {
    if (activeTab !== 'pages') return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
      }
      e.preventDefault();
      pageSearchInputRef.current?.focus();
      pageSearchInputRef.current?.select();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeTab]);

  // Close the page-card context menu on outside click or Escape.
  useEffect(() => {
    if (!pageContextMenu) return;
    const onClick = () => setPageContextMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPageContextMenu(null); };
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [pageContextMenu]);

  // Persist the shared blueprint print quality to the server (cross-browser).
  // The proposal section owns the rest of the proposal preferences.
  useEffect(() => {
    saveUserPreferences({ 'proposal-highlightQuality': highlightQuality }).catch(() => {});
  }, [highlightQuality]);

  const [editingTakeoff, setEditingTakeoff] = useState<MeasurementTakeoff | null>(null);
  const [editTakeoffName, setEditTakeoffName] = useState('');
  const [editTakeoffColor, setEditTakeoffColor] = useState('');
  const [editTakeoffUnit, setEditTakeoffUnit] = useState('');
  const [editTakeoffCostPerUnit, setEditTakeoffCostPerUnit] = useState<number | ''>('');
  const [isEditTakeoffAdvanced, setIsEditTakeoffAdvanced] = useState(false);
  const [editTakeoffCustomCosts, setEditTakeoffCustomCosts] = useState<any[]>([]);

  const [expandedTakeoffs, setExpandedTakeoffs] = useState<Record<string, boolean>>({});
  const [expandedTakeoffPages, setExpandedTakeoffPages] = useState<Record<string, boolean>>({});
  const [editingPageId, setEditingPageId] = useState<string | null>(null);
  const [editingPageName, setEditingPageName] = useState('');
  const [editingPageNumber, setEditingPageNumber] = useState('');
  const [editingPageDescription, setEditingPageDescription] = useState('');
  const [isAddingPages, setIsAddingPages] = useState(false);
  const [addProgress, setAddProgress] = useState({ status: '', current: 0, total: 0, currentFile: 0, totalFiles: 0 });
  const [selectedPlanSetId, setSelectedPlanSetId] = useState<string>('');
  const [showAddPagesModal, setShowAddPagesModal] = useState(false);
  const [addPagesStep, setAddPagesStep] = useState<'details' | 'name_pages'>('details');
  const [isNamingExistingPages, setIsNamingExistingPages] = useState(false);
  const [pendingPages, setPendingPages] = useState<any[]>([]);
  const [pendingThumbnails, setPendingThumbnails] = useState<Record<string, string>>({});
  const [newPlanSetName, setNewPlanSetName] = useState('');
  const [newPlanSetDate, setNewPlanSetDate] = useState(new Date().toISOString().split('T')[0]);
  const [newPlanSetFiles, setNewPlanSetFiles] = useState<File[]>([]);
  const [useExistingPlanSet, setUseExistingPlanSet] = useState(false);
  const [targetPlanSetId, setTargetPlanSetId] = useState('');
  const [showManagePlanSets, setShowManagePlanSets] = useState(false);
  const [showRevisionsForPageId, setShowRevisionsForPageId] = useState<string | null>(null);
  const [comparePageId, setComparePageId] = useState<string | null>(null);

  // Upload-failures modal state (mirrors NewProject.tsx) — keeps source File
  // objects so the user can retry missing pages from the existing flow.
  const [uploadFailures, setUploadFailures] = useState<UploadFailure[]>([]);
  const [uploadFilesByName, setUploadFilesByName] = useState<Map<string, File>>(new Map());
  const [uploadTotals, setUploadTotals] = useState({ processed: 0, expected: 0 });
  const [showUploadFailuresModal, setShowUploadFailuresModal] = useState(false);
  const [isRetryingUpload, setIsRetryingUpload] = useState(false);
  const [retryProgress, setRetryProgress] = useState({ status: '', current: 0, total: 0, fileName: '' });
  const [retryPlanSetId, setRetryPlanSetId] = useState<string>('');
  // Project name/contractor/address/due-date are edited in the admin Project
  // Settings section (/project/:id/settings); the header shows them read-only.
  const isAdmin = (() => {
    try { return JSON.parse(localStorage.getItem('user') || '{}').role === 'admin'; }
    catch { return false; }
  })();
  const [isOptimizingThumbnails, setIsOptimizingThumbnails] = useState(false);
  const [optimizeProgress, setOptimizeProgress] = useState({ current: 0, total: 0 });
  const [activePages, setActivePages] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageContainerRef = useRef<HTMLDivElement>(null);

  const removeNewPlanSetFile = (indexToRemove: number) => {
    setNewPlanSetFiles(newPlanSetFiles.filter((_, index) => index !== indexToRemove));
  };

  // Rename / re-date a plan set in place. Optimistic with rollback.
  const handleUpdatePlanSet = async (id: string, patch: { name?: string; date?: string }) => {
    if (!project) return;
    const previous = project;
    const updated = {
      ...project,
      planSets: (project.planSets || []).map(ps => ps.id === id ? { ...ps, ...patch } : ps),
    };
    setProject(updated);
    try {
      await saveProject(updated);
    } catch {
      setProject(previous);
      toast('Failed to update plan set', { type: 'error' });
    }
  };

  // Delete a plan set and every page that belongs to it. Destructive, so it's
  // gated behind a confirm. Measurements on those pages go with them.
  const handleDeletePlanSet = async (id: string) => {
    if (!project) return;
    const set = (project.planSets || []).find(ps => ps.id === id);
    const pageCount = project.pages.filter(p => p.planSetId === id).length;
    if (!await confirm({
      title: 'Delete plan set',
      message: `Delete "${set?.name || 'this plan set'}" and its ${pageCount} page${pageCount === 1 ? '' : 's'} (including any measurements on them)? This cannot be undone.`,
      confirmLabel: 'Delete plan set',
      tone: 'danger',
    })) return;
    const previous = project;
    const updated = {
      ...project,
      planSets: (project.planSets || []).filter(ps => ps.id !== id),
      pages: project.pages.filter(p => p.planSetId !== id),
    };
    setProject(updated);
    if (selectedPlanSetId === id) setSelectedPlanSetId('');
    try {
      await saveProject(updated);
      toast('Plan set deleted', { type: 'success' });
    } catch {
      setProject(previous);
      toast('Failed to delete plan set', { type: 'error' });
    }
  };

  // Copy the previous revision's measurements + scale onto a sheet's current
  // revision so takeoffs don't have to be redrawn after a reissue.
  const handleCopyMeasurementsForward = async (targetPageId: string): Promise<number> => {
    if (!project) return 0;
    const target = project.pages.find(p => p.id === targetPageId);
    const key = target ? sheetKey(target) : null;
    if (!target || !key) return 0;
    const revs = revisionModel.revisionsBySheet.get(key) || [];
    const idx = revs.findIndex(p => p.id === targetPageId);
    const source = idx > 0 ? revs[idx - 1] : undefined;
    if (!source || source.measurements.length === 0) return 0;
    const copied = source.measurements.map(m => ({
      ...m,
      id: uuidv4(),
      planSetId: target.planSetId,
      segments: m.segments ? m.segments.map(s => ({ ...s })) : m.segments,
    }));
    const previous = project;
    const updated = {
      ...project,
      pages: project.pages.map(p => p.id === targetPageId
        ? { ...p, measurements: [...p.measurements, ...copied], scaleConfig: p.scaleConfig || source.scaleConfig, scaleRegions: p.scaleRegions || source.scaleRegions, isMultiRegion: p.isMultiRegion ?? source.isMultiRegion }
        : p),
    };
    setProject(updated);
    try {
      await saveProject(updated);
      return copied.length;
    } catch {
      setProject(previous);
      toast('Failed to copy measurements', { type: 'error' });
      return 0;
    }
  };

  useEffect(() => {
    if (projectId) {
      loadProject(projectId);
    }
    loadTemplates();

    // Poll for active pages
    const fetchActivePages = async () => {
      try {
        const pages = await getActivePages();
        setActivePages(pages);
      } catch (error) {
        console.error('Failed to fetch active pages:', error);
      }
    };
    
    fetchActivePages();
    const interval = setInterval(fetchActivePages, 5000);
    return () => clearInterval(interval);
  }, [projectId]);

  useEffect(() => {
    if (location.state?.activeTab) {
      setActiveTab(location.state.activeTab);
    }
  }, [location.state]);

  // Per-project storage usage. Recomputed when the page/printout count changes
  // (uploads and deletes are what actually move the number), since that's what
  // the server attributes a project's image bytes from.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    getProjectStorage(projectId)
      .then(s => { if (!cancelled) setProjectStorage(s); })
      .catch(() => { if (!cancelled) setProjectStorage(null); });
    return () => { cancelled = true; };
  }, [projectId, project?.pages?.length, project?.printouts?.length]);

  // Backfill the search text cache from each page's source PDF. Vector pages
  // uploaded under earlier code paths may have OCR-derived extractedText
  // (less accurate) or none at all; pull text directly out of the PDF's
  // embedded text layer instead. Each page is marked searchTextIndexed=true
  // once handled, so this is a one-shot per page — subsequent project opens
  // are zero-cost. Pages without a source PDF are skipped (legacy projects
  // have no vector source to read from). Errors per page are swallowed; the
  // worst case is we just keep the existing extractedText for that page.
  useEffect(() => {
    if (!project) return;
    const needsReindex = project.pages.filter(
      p => p.sourcePdfFileId && p.sourcePdfPageNum && !p.searchTextIndexed,
    );
    if (needsReindex.length === 0) return;

    let cancelled = false;
    (async () => {
      const proxyCache = new Map<string, any>();
      const extractedByPageId = new Map<string, string>();
      try {
        for (const page of needsReindex) {
          if (cancelled) break;
          try {
            let proxy = proxyCache.get(page.sourcePdfFileId!);
            if (!proxy) {
              proxy = await pdfjsLib.getDocument({ url: getImageUrl(page.sourcePdfFileId!) }).promise;
              proxyCache.set(page.sourcePdfFileId!, proxy);
            }
            const pdfPage = await proxy.getPage(page.sourcePdfPageNum!);
            const textContent = await pdfPage.getTextContent();
            const text = (textContent.items as any[])
              .map(item => (item.str ?? '').trim())
              .filter(Boolean)
              .join(' ');
            extractedByPageId.set(page.id, text);
          } catch (e) {
            console.warn(`Failed to reindex page ${page.id} from source PDF`, e);
          }
        }
      } finally {
        for (const p of proxyCache.values()) {
          try { await p.destroy(); } catch { /* noop */ }
        }
      }

      if (cancelled || extractedByPageId.size === 0) return;

      setProject(prev => {
        if (!prev) return prev;
        const updatedPages = prev.pages.map(pg => {
          if (!extractedByPageId.has(pg.id)) return pg;
          const text = extractedByPageId.get(pg.id)!;
          // Keep the previous extractedText if the vector layer returned
          // nothing — likely an image-only page where the OCR fallback at
          // upload time produced a better string than the empty vector
          // result would.
          return {
            ...pg,
            extractedText: text || pg.extractedText,
            searchTextIndexed: true,
          };
        });
        const updated = { ...prev, pages: updatedPages };
        saveProject(updated).catch(e => console.warn('Failed to save reindexed project', e));
        return updated;
      });
    })();

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  // Load this user's favorited page ids for the current project. Stored as a
  // JSON-encoded array under `pages-favorites-{projectId}` in user prefs.
  useEffect(() => {
    if (!project?.id) {
      setFavoritePageIds(new Set());
      return;
    }
    const key = `pages-favorites-${project.id}`;
    getUserPreferences().then(prefs => {
      const raw = prefs[key];
      if (!raw) { setFavoritePageIds(new Set()); return; }
      try {
        const ids = JSON.parse(raw);
        if (Array.isArray(ids)) setFavoritePageIds(new Set(ids.filter((s): s is string => typeof s === 'string')));
      } catch { /* malformed — ignore and start empty */ }
    }).catch(() => { /* offline: empty set */ });
  }, [project?.id]);

  // Toggles `pageId` in the favorites set and persists. Optimistic — the
  // local set updates immediately so the star re-renders without waiting on
  // the server round-trip, and the persistence call is fire-and-forget.
  const toggleFavorite = (pageId: string) => {
    if (!project?.id) return;
    setFavoritePageIds(prev => {
      const next = new Set(prev);
      if (next.has(pageId)) next.delete(pageId);
      else next.add(pageId);
      saveUserPreferences({ [`pages-favorites-${project.id}`]: JSON.stringify([...next]) }).catch(() => {});
      return next;
    });
  };

  const loadTemplates = async () => {
    const data = await getTemplates();
    setTemplates(data);
  };

  const loadProject = async (id: string) => {
    setIsLoading(true);
    const data = await getProject(id);
    if (!data) {
      navigate('/projects');
      return;
    }
    setProject(data);
    recordRecentProject(data.id, data.name);

    if (data.planSets && data.planSets.length > 0) {
      setSelectedPlanSetId('');
    }

    setIsLoading(false);
  };

  const handleDeleteTakeoff = async (takeoffId: string) => {
    setTakeoffToDelete(takeoffId);
    setShowDeleteConfirm(true);
  };

  const confirmDeleteTakeoff = async () => {
    if (!project || !takeoffToDelete) return;

    const updatedProject = {
      ...project,
      takeoffs: project.takeoffs.filter(g => g.id !== takeoffToDelete),
      pages: project.pages.map(page => ({
        ...page,
        measurements: page.measurements.map(m => 
          m.takeoffId === takeoffToDelete ? { ...m, takeoffId: undefined } : m
        )
      }))
    };

    await saveProject(updatedProject);
    setProject(updatedProject);
    setShowDeleteConfirm(false);
    setTakeoffToDelete(null);
  };

  const confirmDeleteAllTakeoffs = async () => {
    if (!project) return;
    const updatedProject = {
      ...project,
      takeoffs: [],
      pages: project.pages.map(page => ({
        ...page,
        measurements: page.measurements.map(m => ({ ...m, takeoffId: undefined }))
      }))
    };
    await saveProject(updatedProject);
    setProject(updatedProject);
    setShowDeleteAllConfirm(false);
  };

  const handleEditTakeoff = (takeoff: MeasurementTakeoff) => {
    const rawTakeoff = project?.takeoffs.find(t => t.id === takeoff.id) || takeoff;
    setEditingTakeoff(rawTakeoff);
    setEditTakeoffName(rawTakeoff.name);
    setEditTakeoffColor(rawTakeoff.color);
    setEditTakeoffUnit(rawTakeoff.unit || '');
    setEditTakeoffCostPerUnit(rawTakeoff.costPerUnit ?? '');
    setIsEditTakeoffAdvanced(rawTakeoff.isAdvancedCost || false);
    setEditTakeoffCustomCosts(rawTakeoff.customCosts || []);
    setEditTakeoffPricePackage(rawTakeoff.pricePackage || '');
  };

  const handleSaveEditTakeoff = async () => {
    if (!project || !editingTakeoff || !editTakeoffName) return;

    const updatedProject = {
      ...project,
      takeoffs: project.takeoffs.map(g => 
        g.id === editingTakeoff.id 
          ? {
              ...g,
              name: editTakeoffName,
              color: editTakeoffColor,
              unit: editTakeoffUnit || undefined,
              costPerUnit: !isEditTakeoffAdvanced && editTakeoffCostPerUnit !== '' ? Number(editTakeoffCostPerUnit) : undefined,
              isAdvancedCost: isEditTakeoffAdvanced,
              customCosts: isEditTakeoffAdvanced ? editTakeoffCustomCosts.map(c => ({
                ...c,
                cost: evaluateMathExpression(c.cost?.toString() || '') ?? 0,
                yield: evaluateMathExpression(c.yield?.toString() || '') ?? 0,
                costPerUnit: evaluateMathExpression(c.costPerUnit?.toString() || '') ?? 0,
                amount: evaluateMathExpression(c.amount?.toString() || '') ?? 0,
                perUnits: evaluateMathExpression(c.perUnits?.toString() || '') ?? 0,
              })) : undefined,
              pricePackage: editTakeoffPricePackage.trim() || undefined,
            }
          : g
      ),
      pages: project.pages.map(page => ({
        ...page,
        measurements: page.measurements.map(m => 
          m.takeoffId === editingTakeoff.id 
            ? { ...m, color: editTakeoffColor }
            : m
        )
      }))
    };

    await saveProject(updatedProject);
    setProject(updatedProject);
    setEditingTakeoff(null);
  };

  const toggleTakeoffExpanded = (takeoffId: string) => {
    setExpandedTakeoffs(prev => ({
      ...prev,
      [takeoffId]: !prev[takeoffId]
    }));
  };

  const toggleTakeoffPageExpanded = (takeoffId: string, pageId: string) => {
    const key = `${takeoffId}__${pageId}`;
    setExpandedTakeoffPages(prev => ({
      ...prev,
      [key]: !prev[key]
    }));
  };

  const handleStartRenamePage = (e: React.MouseEvent, page: ProjectPage) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (activePages.includes(page.id)) {
      toast('This page is currently being viewed by another user and cannot be renamed.', { type: 'warning' });
      return;
    }
    
    setEditingPageId(page.id);
    setEditingPageName(page.name);
    setEditingPageNumber(page.pageNumber || '');
    setEditingPageDescription(page.description || '');
  };

  const handleSaveRenamePage = async (e: React.MouseEvent, pageId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (!project) return;

    const num = editingPageNumber.trim();
    const desc = editingPageDescription.trim();
    const newName = num && desc ? `${num} - ${desc}` : (num || desc || editingPageName.trim());

    if (!newName) return;

    const updatedProject = {
      ...project,
      pages: project.pages.map(p => p.id === pageId ? { 
        ...p, 
        name: newName,
        pageNumber: num,
        description: desc
      } : p)
    };

    await saveProject(updatedProject);
    setProject(updatedProject);
    setEditingPageId(null);
  };

  const handleCancelRenamePage = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setEditingPageId(null);
  };

  const handleAddPages = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPlanSetFiles.length === 0 || !project || (!newPlanSetName && !useExistingPlanSet)) return;

    setIsAddingPages(true);
    try {
      const planSetId = useExistingPlanSet ? targetPlanSetId : uuidv4();
      let updatedProject = { 
        ...project,
        pages: [...project.pages]
      };

      if (!useExistingPlanSet) {
        const newPlanSet = {
          id: planSetId,
          name: newPlanSetName,
          date: newPlanSetDate,
          createdAt: Date.now(),
        };
        updatedProject = {
          ...updatedProject,
          planSets: [...(updatedProject.planSets || []), newPlanSet]
        };
      }

      const extractedPages: any[] = [];
      const thumbnails: Record<string, string> = {};

      // Build map of existing page numbers for revision detection
      const existingPageNums = new Map<string, string>(); // normalised → display
      for (const pg of project.pages) {
        if (pg.pageNumber?.trim()) {
          existingPageNums.set(pg.pageNumber.trim().toLowerCase(), pg.pageNumber.trim());
        }
      }

      let startingPageNum = updatedProject.pages.length + 1;
      const failures: Array<{ fileName: string; pageNum: number | null; reason: string }> = [];
      let totalExpected = 0;
      let totalProcessed = 0;

      for (let i = 0; i < newPlanSetFiles.length; i++) {
        const file = newPlanSetFiles[i];
        setAddProgress(prev => ({ ...prev, currentFile: i + 1, totalFiles: newPlanSetFiles.length }));

        // Upload the source PDF once for this file. Stream the File directly
        // to the server instead of materializing a base64 dataUrl in the
        // browser — see NewProject.handleProcessFiles for the same pattern.
        let sourcePdfFileId: string | undefined;
        const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
        if (isPdf) {
          try {
            setAddProgress(prev => ({ ...prev, status: 'uploading source PDF', current: 0, total: 0 }));
            sourcePdfFileId = uuidv4();
            const pdfBlob = file.type === 'application/pdf' ? file : new Blob([file], { type: 'application/pdf' });
            await saveBinaryFile(sourcePdfFileId, pdfBlob);
          } catch (pdfErr) {
            console.warn(`Failed to upload source PDF for ${file.name} — falling back to raster only`, pdfErr);
            sourcePdfFileId = undefined;
          }
        }

        let fileExpected = 0;
        let fileYielded = 0;

        try {
          const generator = loadPdfPagesGenerator(file, (status, current, total) => {
            if (total > 0) fileExpected = total;
            setAddProgress(prev => ({ ...prev, status, current, total }));
          }, undefined, { includeFullPageRaster: !sourcePdfFileId });

          for await (const pageData of generator) {
            fileYielded++;

            if (pageData.error) {
              failures.push({ fileName: file.name, pageNum: pageData.pageNum, reason: pageData.error });
              continue;
            }

            setAddProgress(prev => ({ ...prev, status: 'uploading', current: pageData.pageNum, total: prev.total }));

            try {
              const thumbnailId = uuidv4();
              await saveImage(thumbnailId, pageData.thumbnailDataUrl);

              let imageId = '';
              if (!sourcePdfFileId && pageData.dataUrl) {
                imageId = uuidv4();
                await saveImage(imageId, pageData.dataUrl);
              }
              // Thumbnails are keyed by `thumbnailId` (always set) so naming-step
              // lookups work uniformly for vector and legacy pages.
              thumbnails[thumbnailId] = pageData.thumbnailDataUrl;

              const detected = detectPageInfo(pageData.suggestedName, file.name, pageData.extractedText, { pageNumber: pageData.detectedPageNumber, description: pageData.detectedDescription });
              const normNum = detected.pageNumber.trim().toLowerCase();
              const revisionOf = detected.pageNumber && existingPageNums.has(normNum)
                ? existingPageNums.get(normNum)!
                : undefined;

              const newPage = {
                id: uuidv4(),
                name: detected.pageNumber && detected.description
                  ? `${detected.pageNumber} - ${detected.description}`
                  : detected.pageNumber || detected.description || pageData.suggestedName || `Page ${startingPageNum}`,
                pageNumber: detected.pageNumber,
                description: detected.description,
                imageId,
                thumbnailId,
                imageWidth: pageData.width,
                imageHeight: pageData.height,
                sourcePdfFileId,
                sourcePdfPageNum: sourcePdfFileId ? pageData.pageNum : undefined,
                searchTextIndexed: !!sourcePdfFileId,
                extractedText: pageData.extractedText,
                revisionOf,
              };

              extractedPages.push(newPage);

              const newProjectPage = {
                id: newPage.id,
                name: newPage.name,
                pageNumber: newPage.pageNumber,
                description: newPage.description,
                imageId: newPage.imageId,
                thumbnailId: newPage.thumbnailId,
                imageWidth: newPage.imageWidth,
                imageHeight: newPage.imageHeight,
                sourcePdfFileId: newPage.sourcePdfFileId,
                sourcePdfPageNum: newPage.sourcePdfPageNum,
                searchTextIndexed: !!newPage.sourcePdfFileId,
                extractedText: newPage.extractedText,
                measurements: [],
                scaleConfig: null,
                planSetId,
              };

              updatedProject = {
                ...updatedProject,
                pages: [...updatedProject.pages, newProjectPage]
              };

              totalProcessed++;

              if (startingPageNum % 5 === 0) {
                try {
                  await saveProject(updatedProject);
                  setProject(updatedProject);
                } catch (saveErr) {
                  console.warn('Periodic saveProject failed', saveErr);
                }
              }

              startingPageNum++;
            } catch (perPageErr) {
              console.warn(`Save failed for ${file.name} page ${pageData.pageNum}`, perPageErr);
              failures.push({
                fileName: file.name,
                pageNum: pageData.pageNum,
                reason: String((perPageErr as any)?.message || perPageErr),
              });
            }
          }
        } catch (genErr) {
          console.error(`PDF processing aborted for ${file.name}`, genErr);
          failures.push({
            fileName: file.name,
            pageNum: null,
            reason: `Processing aborted: ${String((genErr as any)?.message || genErr)}`,
          });
        }

        totalExpected += fileExpected;

        if (fileExpected > fileYielded) {
          for (let p = fileYielded + 1; p <= fileExpected; p++) {
            failures.push({
              fileName: file.name,
              pageNum: p,
              reason: 'Page was never reached during processing',
            });
          }
        }

        try {
          await saveProject(updatedProject);
          setProject(updatedProject);
        } catch (saveErr) {
          console.warn('End-of-file saveProject failed', saveErr);
          failures.push({
            fileName: file.name,
            pageNum: null,
            reason: `Could not save project after processing ${file.name}: ${String((saveErr as any)?.message || saveErr)}`,
          });
        }
      }

      const hasFailures = failures.length > 0 || totalProcessed !== totalExpected;
      if (hasFailures) {
        const filesByName = new Map<string, File>();
        for (const f of newPlanSetFiles) filesByName.set(f.name, f);
        setUploadFilesByName(filesByName);
        setUploadFailures(failures);
        setUploadTotals({ processed: totalProcessed, expected: totalExpected });
        setRetryPlanSetId(planSetId);
        setShowUploadFailuresModal(true);
      }

      if (totalProcessed === 0) {
        setIsAddingPages(false);
        setAddProgress({ status: '', current: 0, total: 0, currentFile: 0, totalFiles: 0 });
        return;
      }

      setPendingPages(extractedPages);
      setPendingThumbnails(thumbnails);
      setAddPagesStep('name_pages');
    } catch (error) {
      console.error('Error processing PDFs:', error);
      toast('Failed to process PDF. Please try another file.', { type: 'error' });
    } finally {
      setIsAddingPages(false);
      setAddProgress({ status: '', current: 0, total: 0, currentFile: 0, totalFiles: 0 });
    }
  };

  // Re-render and re-import each failure in the modal. Same per-page logic
  // as the original upload, with page-level failures using the pageNums
  // filter and file-level failures re-running the full file.
  const handleRetryFailedPages = async () => {
    if (!project || uploadFailures.length === 0 || !retryPlanSetId) return;
    setIsRetryingUpload(true);
    setRetryProgress({ status: '', current: 0, total: 0, fileName: '' });

    try {
      const freshProject = await getProject(project.id);
      if (!freshProject) throw new Error('Project not found');
      let workingProject: Project = freshProject;

      const existingPageNums = new Map<string, string>();
      for (const pg of workingProject.pages) {
        if (pg.pageNumber?.trim()) {
          existingPageNums.set(pg.pageNumber.trim().toLowerCase(), pg.pageNumber.trim());
        }
      }

      const byFile = new Map<string, { pageNums: number[]; allPages: boolean }>();
      for (const f of uploadFailures) {
        const entry = byFile.get(f.fileName) ?? { pageNums: [], allPages: false };
        if (f.pageNum == null) entry.allPages = true;
        else entry.pageNums.push(f.pageNum);
        byFile.set(f.fileName, entry);
      }

      const remainingFailures: UploadFailure[] = [];
      const newPendingPages: any[] = [];
      const newThumbnails: Record<string, string> = {};
      let newlyProcessed = 0;
      let nextPageNum = (workingProject.pages.length || 0) + 1;

      for (const [fileName, info] of byFile) {
        const file = uploadFilesByName.get(fileName);
        if (!file) {
          if (info.allPages) {
            remainingFailures.push({ fileName, pageNum: null, reason: 'Source file no longer available for retry' });
          }
          for (const p of info.pageNums) {
            remainingFailures.push({ fileName, pageNum: p, reason: 'Source file no longer available for retry' });
          }
          continue;
        }

        // Re-upload the source PDF for this retry so the recovered pages take
        // the vector pipeline like NewProject.handleProcessFiles does. Without
        // this, retried vector pages end up with no imageId AND no
        // sourcePdfFileId, so the canvas has nothing to render.
        let sourcePdfFileId: string | undefined;
        const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
        if (isPdf) {
          try {
            sourcePdfFileId = uuidv4();
            const pdfBlob = file.type === 'application/pdf' ? file : new Blob([file], { type: 'application/pdf' });
            await saveBinaryFile(sourcePdfFileId, pdfBlob);
          } catch (pdfErr) {
            console.warn(`Retry: source PDF upload failed for ${fileName}`, pdfErr);
            sourcePdfFileId = undefined;
          }
        }

        const pageNumsArg = info.allPages ? undefined : info.pageNums;
        const requestedCount = info.allPages ? 0 : info.pageNums.length;
        const succeeded = new Set<number>();
        let yielded = 0;
        let expectedFromGenerator = 0;

        try {
          const generator = loadPdfPagesGenerator(file, (status, current, total) => {
            if (info.allPages && total > 0) expectedFromGenerator = total;
            setRetryProgress({
              status,
              current,
              total: info.allPages ? total : requestedCount,
              fileName,
            });
          }, pageNumsArg, { includeFullPageRaster: !sourcePdfFileId });

          for await (const pageData of generator) {
            yielded++;

            if (pageData.error) {
              remainingFailures.push({ fileName, pageNum: pageData.pageNum, reason: pageData.error });
              continue;
            }

            try {
              const thumbnailId = uuidv4();
              await saveImage(thumbnailId, pageData.thumbnailDataUrl);

              let imageId = '';
              if (!sourcePdfFileId && pageData.dataUrl) {
                imageId = uuidv4();
                await saveImage(imageId, pageData.dataUrl);
              }
              newThumbnails[thumbnailId] = pageData.thumbnailDataUrl;

              const detected = detectPageInfo(pageData.suggestedName, fileName, pageData.extractedText, { pageNumber: pageData.detectedPageNumber, description: pageData.detectedDescription });
              const normNum = detected.pageNumber.trim().toLowerCase();
              const revisionOf = detected.pageNumber && existingPageNums.has(normNum)
                ? existingPageNums.get(normNum)!
                : undefined;

              const newPage = {
                id: uuidv4(),
                name: detected.pageNumber && detected.description
                  ? `${detected.pageNumber} - ${detected.description}`
                  : detected.pageNumber || detected.description || pageData.suggestedName || `Page ${nextPageNum}`,
                pageNumber: detected.pageNumber,
                description: detected.description,
                imageId,
                thumbnailId,
                imageWidth: pageData.width,
                imageHeight: pageData.height,
                sourcePdfFileId,
                sourcePdfPageNum: sourcePdfFileId ? pageData.pageNum : undefined,
                searchTextIndexed: !!sourcePdfFileId,
                extractedText: pageData.extractedText,
                revisionOf,
              };

              newPendingPages.push(newPage);

              const newProjectPage = {
                id: newPage.id,
                name: newPage.name,
                pageNumber: newPage.pageNumber,
                description: newPage.description,
                imageId: newPage.imageId,
                thumbnailId: newPage.thumbnailId,
                imageWidth: newPage.imageWidth,
                imageHeight: newPage.imageHeight,
                sourcePdfFileId: newPage.sourcePdfFileId,
                sourcePdfPageNum: newPage.sourcePdfPageNum,
                searchTextIndexed: !!newPage.sourcePdfFileId,
                extractedText: newPage.extractedText,
                measurements: [],
                scaleConfig: null,
                planSetId: retryPlanSetId,
              };

              workingProject = {
                ...workingProject,
                pages: [...workingProject.pages, newProjectPage],
              };

              nextPageNum++;
              newlyProcessed++;
              succeeded.add(pageData.pageNum);
            } catch (saveErr) {
              remainingFailures.push({
                fileName,
                pageNum: pageData.pageNum,
                reason: String((saveErr as any)?.message || saveErr),
              });
            }
          }
        } catch (genErr) {
          remainingFailures.push({
            fileName,
            pageNum: null,
            reason: `Retry aborted: ${String((genErr as any)?.message || genErr)}`,
          });
          if (!info.allPages) {
            for (const p of info.pageNums) {
              if (!succeeded.has(p)) {
                remainingFailures.push({ fileName, pageNum: p, reason: 'Page was never reached during retry' });
              }
            }
          }
          continue;
        }

        if (!info.allPages) {
          for (const p of info.pageNums) {
            const alreadyRecorded = remainingFailures.some(f => f.fileName === fileName && f.pageNum === p);
            if (!succeeded.has(p) && !alreadyRecorded) {
              remainingFailures.push({ fileName, pageNum: p, reason: 'Page was not produced during retry' });
            }
          }
        } else if (expectedFromGenerator > yielded) {
          for (let p = yielded + 1; p <= expectedFromGenerator; p++) {
            remainingFailures.push({ fileName, pageNum: p, reason: 'Page was never reached during retry' });
          }
        }
      }

      try {
        await saveProject(workingProject);
        setProject(workingProject);
      } catch (saveErr) {
        remainingFailures.push({
          fileName: '(project save)',
          pageNum: null,
          reason: `Could not save retried pages: ${String((saveErr as any)?.message || saveErr)}`,
        });
      }

      if (newPendingPages.length > 0) {
        setPendingPages(prev => [...prev, ...newPendingPages]);
        setPendingThumbnails(prev => ({ ...prev, ...newThumbnails }));
        if (addPagesStep !== 'name_pages') setAddPagesStep('name_pages');
      }

      setUploadFailures(remainingFailures);
      setUploadTotals(prev => ({ processed: prev.processed + newlyProcessed, expected: prev.expected }));

      if (remainingFailures.length === 0) {
        setShowUploadFailuresModal(false);
      }
    } catch (err) {
      console.error('Retry failed', err);
      toast(`Retry failed: ${(err as any)?.message || err}`, { type: 'error' });
    } finally {
      setIsRetryingUpload(false);
      setRetryProgress({ status: '', current: 0, total: 0, fileName: '' });
    }
  };

  const toggleTakeoffSelection = (takeoffId: string) => {
    setSelectedTakeoffIds(prev => {
      const next = new Set(prev);
      if (next.has(takeoffId)) {
        next.delete(takeoffId);
      } else {
        next.add(takeoffId);
      }
      return next;
    });
  };

  const handlePrint = async () => {
    if (!project || selectedTakeoffIds.size === 0) return;
    setIsPrinting(true);
    setProgressMessage('Preparing pages…');

    try {
      const pdfBuffer = await buildHighlightsPdf(
        project,
        selectedTakeoffIds,
        highlightQuality,
        (msg) => setProgressMessage(msg),
        revisionModel.currentPageIds,
      );

      if (!pdfBuffer) {
        toast('No pages found with the selected takeoffs.', { type: 'warning' });
        setIsPrinting(false);
        setProgressMessage('');
        return;
      }

      setProgressMessage('Saving…');
      const pdfBlob = new Blob([pdfBuffer], { type: 'application/pdf' });
      const reader = new FileReader();
      reader.readAsDataURL(pdfBlob);
      reader.onloadend = async () => {
        const base64data = reader.result as string;
        const fileId = uuidv4();
        await saveFile(fileId, base64data);

        const newPrintout: Printout = {
          id: uuidv4(),
          name: `Printout - ${new Date().toLocaleString()}`,
          fileId,
          createdAt: Date.now(),
          type: 'pdf',
        };

        const updatedProject = {
          ...project,
          printouts: [...(project.printouts || []), newPrintout],
        };

        await saveProject(updatedProject);
        setProject(updatedProject);
        setIsPrinting(false);
        setProgressMessage('');
        setSelectedTakeoffIds(new Set());
        // Printout history now lives in the Proposal section.
        navigate(`/project/${projectId}/proposal`);
      };
    } catch (error) {
      console.error('Error generating PDF:', error);
      toast('Failed to generate PDF.', { type: 'error' });
      setIsPrinting(false);
      setProgressMessage('');
    }
  };

  const handleExportExcel = async () => {
    if (!project || selectedTakeoffIds.size === 0) return;
    setIsExportingExcel(true);

    try {
      const selectedTakeoffs = getTakeoffTotals().filter(t => selectedTakeoffIds.has(t.id));

      // Build rows as array-of-arrays for full control over layout
      const rows: any[][] = [];
      rows.push(['Takeoff Name', 'Type', 'Qty', 'Unit Cost', 'Total Cost']);

      // Group by price package (mirrors the UI)
      const packageOrder: string[] = [];
      const packageMap: Record<string, typeof selectedTakeoffs> = {};
      const ungrouped: typeof selectedTakeoffs = [];
      for (const t of selectedTakeoffs) {
        if (t.pricePackage) {
          if (!packageMap[t.pricePackage]) {
            packageMap[t.pricePackage] = [];
            packageOrder.push(t.pricePackage);
          }
          packageMap[t.pricePackage].push(t);
        } else {
          ungrouped.push(t);
        }
      }

      const addTakeoffRows = (takeoff: typeof selectedTakeoffs[0]) => {
        const formatQty = (value: number, unit: string | undefined) => value > 0
          ? formatRealValue(value, takeoff.type as 'length' | 'area' | 'count', unit?.replace('sq ', '') || takeoff.unit?.replace('sq ', '') || 'ft', takeoff, false)
          : '-';

        const buildUnitCost = (subsetValue: number, subsetCost: number) => {
          if (takeoff.isAdvancedCost) {
            return subsetCost > 0 ? `$${(subsetCost / (subsetValue || 1)).toFixed(2)} avg/unit` : '-';
          }
          return takeoff.costPerUnit ? `$${takeoff.costPerUnit.toFixed(2)}` : '-';
        };

        const addAdvancedDetailRows = (
          details: SubsetCostDetail[],
          subsetQtyFormatted: string,
          indent: string,
        ) => {
          details.forEach(d => {
            if (d.quantity !== undefined && d.quantity > 0) {
              const itemUnitCost = d.type === 'yield'
                ? `$${(d.cost || 0).toFixed(2)}/unit`
                : d.type === 'amount_per_units'
                  ? `$${(d.amount || 0).toFixed(2)}/unit`
                  : '';
              rows.push([
                `${indent}└ ${d.name}`,
                '',
                `${d.quantity.toFixed(2)} ${d.quantityUnit || 'units'}`,
                itemUnitCost,
                `$${d.costValue.toFixed(2)}`,
              ]);
            } else if (d.type === 'flat') {
              rows.push([`${indent}└ ${d.name}`, '', 'flat (prorated)', '', `$${d.costValue.toFixed(2)}`]);
            } else if (d.type === 'unit') {
              rows.push([
                `${indent}└ ${d.name}`,
                '',
                subsetQtyFormatted,
                `$${(d.costPerUnit || 0).toFixed(2)}/unit`,
                `$${d.costValue.toFixed(2)}`,
              ]);
            }
          });
        };

        const totalCost = allocateSubsetCost(takeoff, takeoff.totalRealValue);
        const totalDetails = allocateSubsetDetails(takeoff, takeoff.totalRealValue);
        const qtyFormatted = formatQty(takeoff.totalRealValue, takeoff.unit);

        // Main takeoff row
        rows.push([takeoff.name, takeoff.type, qtyFormatted, buildUnitCost(takeoff.totalRealValue, totalCost), totalCost > 0 ? `$${roundUpTo100(totalCost).toLocaleString()}` : '-']);

        // Takeoff-level advanced pricing detail sub-rows
        if (takeoff.isAdvancedCost && totalDetails.length > 0) {
          addAdvancedDetailRows(totalDetails, qtyFormatted, '  ');
        }

        // Page rows (and nested measurement rows)
        takeoff.pageBreakdown.forEach(pb => {
          const pageCost = allocateSubsetCost(takeoff, pb.realValue);
          const pageDetails = allocateSubsetDetails(takeoff, pb.realValue);
          const pageQtyFormatted = formatQty(pb.realValue, pb.unit);

          rows.push([
            `  └ ${pb.pageName}`,
            '',
            pageQtyFormatted,
            buildUnitCost(pb.realValue, pageCost),
            pageCost > 0 ? `$${roundUpTo100(pageCost).toLocaleString()}` : '-',
          ]);

          if (takeoff.isAdvancedCost && pageDetails.length > 0) {
            addAdvancedDetailRows(pageDetails, pageQtyFormatted, '      ');
          }

          pb.measurements.forEach(meas => {
            const measCost = allocateSubsetCost(takeoff, meas.realValue);
            const measDetails = allocateSubsetDetails(takeoff, meas.realValue);
            const measQtyFormatted = formatQty(meas.realValue, meas.unit);

            rows.push([
              `      • ${meas.name || 'Measurement'}`,
              '',
              measQtyFormatted,
              buildUnitCost(meas.realValue, measCost),
              measCost > 0 ? `$${roundUpTo100(measCost).toLocaleString()}` : '-',
            ]);

            if (takeoff.isAdvancedCost && measDetails.length > 0) {
              addAdvancedDetailRows(measDetails, measQtyFormatted, '          ');
            }
          });
        });
      };

      for (const pkg of packageOrder) {
        rows.push([`── ${pkg} ──`, '', '', '', '']);
        packageMap[pkg].forEach(addTakeoffRows);
      }
      ungrouped.forEach(addTakeoffRows);

      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws['!cols'] = [
        { wch: 48 },
        { wch: 10 },
        { wch: 22 },
        { wch: 22 },
        { wch: 18 },
      ];

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Takeoffs");
      
      const excelBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const excelBlob = new Blob([excelBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      
      const reader = new FileReader();
      reader.readAsDataURL(excelBlob);
      reader.onloadend = async () => {
        const base64data = reader.result as string;
        const fileId = uuidv4();
        await saveFile(fileId, base64data);
        
        const newPrintout: Printout = {
          id: uuidv4(),
          name: `Excel Export - ${new Date().toLocaleString()}`,
          fileId,
          createdAt: Date.now(),
          type: 'excel',
        };
        
        const updatedProject = {
          ...project,
          printouts: [...(project.printouts || []), newPrintout],
        };
        
        await saveProject(updatedProject);
        setProject(updatedProject);
        setIsExportingExcel(false);
        setSelectedTakeoffIds(new Set());
        // Printout history now lives in the Proposal section.
        navigate(`/project/${projectId}/proposal`);
      };
    } catch (error) {
      console.error('Error generating Excel:', error);
      toast('Failed to generate Excel.', { type: 'error' });
      setIsExportingExcel(false);
    }
  };

  // Pops the share modal (copy button + QR code) for a freshly created link.
  const showShareUrl = (url: string, title?: string) => shareLink(url, title);

  const handleSharePage = async (page: { imageId: string; name?: string; description?: string }) => {
    try {
      const name = page.name || page.description || 'Page';
      const id = await createShare('page', page.imageId, name);
      const settings = await getSettings();
      const host = (settings.publicHost || window.location.origin).replace(/\/$/, '');
      showShareUrl(`${host}/share/${id}`, name);
    } catch {
      toast('Failed to create share link', { type: 'error' });
    }
  };

  // Permanently removes a page from the project.
  // Orphaned image rows are intentionally left in storage; cleanup is handled
  // separately by the admin storage-reclaim tool, which verifies no other page
  // (across plan-set revisions) references the same imageId / thumbnailId /
  // sourcePdfFileId before deleting.
  const handleDeletePage = async (page: { id: string; name?: string; pageNumber?: string }) => {
    if (!project) return;
    const label = page.pageNumber || page.name || 'this page';
    if (!await confirm({ title: 'Delete page', message: `Delete ${label}? Any measurements on it will be lost.`, confirmLabel: 'Delete', tone: 'danger' })) return;
    const updated = { ...project, pages: project.pages.filter(p => p.id !== page.id) };
    await saveProject(updated);
    setProject(updated);
    setSelectedPageIds(prev => {
      if (!prev.has(page.id)) return prev;
      const next = new Set(prev);
      next.delete(page.id);
      return next;
    });
  };

  const handleShareSelectedPages = async () => {
    if (!project || selectedPageIds.size === 0) return;
    try {
      const settings = await getSettings();
      const host = (settings.publicHost || window.location.origin).replace(/\/$/, '');

      if (selectedPageIds.size === 1) {
        // Single page — use the simple per-image share
        const pid = [...selectedPageIds][0];
        const pg = project.pages.find(p => p.id === pid);
        if (!pg) return;
        const id = await createShare('page', pg.imageId, pg.name || 'Page');
        showShareUrl(`${host}/share/${id}`, pg.name || 'Page');
        return;
      }

      // Multiple pages — create one combined share
      const orderedPages = project.pages.filter(p => selectedPageIds.has(p.id));
      const payload = orderedPages.map(p => ({
        imageId: p.imageId,
        name: p.name || 'Page',
        pageNumber: p.pageNumber,
      }));
      // Deduplicate by sorted imageId list so the same selection reuses the existing share
      const resourceId = JSON.stringify(payload);
      const id = await createShare('pages', resourceId, project.name);
      showShareUrl(`${host}/share/${id}`, `${selectedPageIds.size} pages`);
    } catch {
      toast('Failed to create share link', { type: 'error' });
    }
  };

  const handleOpenNamePages = () => {
    if (!project) return;
    
    // Populate pendingPages with existing filtered pages
    const existingPages = filteredPages.map(p => ({
      ...p,
      pageNumber: p.pageNumber || '',
      description: p.description || p.name || '',
    }));
    
    const thumbnails: Record<string, string> = {};
    filteredPages.forEach(p => {
      thumbnails[p.imageId] = getImageUrl(p.thumbnailId || p.imageId);
    });
    
    setPendingPages(existingPages);
    setPendingThumbnails(thumbnails);
    setAddPagesStep('name_pages');
    setIsNamingExistingPages(true);
    setShowAddPagesModal(true);
  };

  const handleConfirmAddPages = async () => {
    if (!project) return;
    setIsAddingPages(true);
    try {
      // The pages are already added to the project, we just need to update their names
      const updatedProject = { 
        ...project,
        pages: [...project.pages]
      };
      
      pendingPages.forEach(p => {
        const pageIndex = updatedProject.pages.findIndex(pp => pp.id === p.id);
        if (pageIndex !== -1) {
          updatedProject.pages[pageIndex] = {
            ...updatedProject.pages[pageIndex],
            name: p.pageNumber && p.description ? `${p.pageNumber} - ${p.description}` : (p.pageNumber || p.description || p.name),
            pageNumber: p.pageNumber,
            description: p.description,
          };
        }
      });

      await saveProject(updatedProject);
      setProject(updatedProject);

      const wasNewSet = !isNamingExistingPages;
      const addedPageIds = pendingPages.map(p => p.id);

      if (wasNewSet) {
        // Find the planSetId from the first pending page
        const planSetId = updatedProject.pages.find(p => p.id === pendingPages[0]?.id)?.planSetId;
        if (planSetId) {
          setSelectedPlanSetId(planSetId);
        }
      }

      setShowAddPagesModal(false);
      setAddPagesStep('details');
      setIsNamingExistingPages(false);
      setNewPlanSetName('');
      setNewPlanSetFiles([]);
      setPendingPages([]);
      setPendingThumbnails({});
      setUseExistingPlanSet(false);
      setTargetPlanSetId('');
      setIsAddingPages(false);

      // If any newly added sheet is a reissue of a sheet that already had
      // measurements, offer to carry those measurements (and scale) forward so
      // the takeoffs don't have to be redrawn.
      if (wasNewSet) {
        await maybeOfferCarryForward(updatedProject, addedPageIds);
      }
    } catch (error) {
      console.error('Error adding pages:', error);
      toast('Failed to add pages.', { type: 'error' });
      setIsAddingPages(false);
    }
  };

  // Detects reissued sheets among the just-added pages and, with the user's
  // confirmation, copies the previous revision's measurements + scale onto
  // them in a single batched update.
  const maybeOfferCarryForward = async (proj: Project, addedPageIds: string[]) => {
    const model = computeRevisionModel(proj, '');
    const added = new Set(addedPageIds);
    const candidates: { targetId: string; source: ProjectPage }[] = [];
    for (const pageId of addedPageIds) {
      const target = proj.pages.find(p => p.id === pageId);
      const key = target ? sheetKey(target) : null;
      if (!target || !key || target.measurements.length > 0) continue;
      const revs = model.revisionsBySheet.get(key) || [];
      const idx = revs.findIndex(p => p.id === pageId);
      // Walk back to the most recent earlier revision that actually has work on it.
      let source: ProjectPage | undefined;
      for (let j = idx - 1; j >= 0; j--) {
        if (!added.has(revs[j].id) && revs[j].measurements.length > 0) { source = revs[j]; break; }
      }
      if (source) candidates.push({ targetId: pageId, source });
    }
    if (candidates.length === 0) return;

    const totalM = candidates.reduce((a, c) => a + c.source.measurements.length, 0);
    const ok = await confirm({
      title: 'Carry over measurements?',
      message: `${candidates.length} reissued sheet${candidates.length === 1 ? '' : 's'} had measurements on the previous revision. Copy ${totalM} measurement${totalM === 1 ? '' : 's'} (and scale calibration) onto the new revision${candidates.length === 1 ? '' : 's'}? You can adjust them afterward.`,
      confirmLabel: 'Copy measurements',
    });
    if (!ok) return;

    const carried = {
      ...proj,
      pages: proj.pages.map(p => {
        const c = candidates.find(x => x.targetId === p.id);
        if (!c) return p;
        const copied = c.source.measurements.map(m => ({
          ...m,
          id: uuidv4(),
          planSetId: p.planSetId,
          segments: m.segments ? m.segments.map(s => ({ ...s })) : m.segments,
        }));
        return {
          ...p,
          measurements: [...p.measurements, ...copied],
          scaleConfig: p.scaleConfig || c.source.scaleConfig,
          scaleRegions: p.scaleRegions || c.source.scaleRegions,
          isMultiRegion: p.isMultiRegion ?? c.source.isMultiRegion,
        };
      }),
    };
    const previous = proj;
    setProject(carried);
    try {
      await saveProject(carried);
      toast(`Copied ${totalM} measurement${totalM === 1 ? '' : 's'} onto ${candidates.length} sheet${candidates.length === 1 ? '' : 's'}`, { type: 'success' });
    } catch {
      setProject(previous);
      toast('Failed to copy measurements forward', { type: 'error' });
    }
  };


  // Shared plan-set revision model: which pages are the current revision for
  // the selected set, full per-sheet history, and supersession status. Drives
  // the pages grid, takeoff totals, revision badges, and the compare view.
  const revisionModel = useMemo(
    () => computeRevisionModel(project, selectedPlanSetId),
    [project, selectedPlanSetId],
  );

  // Calculate totals for takeoffs. Only the current revision of each sheet (for
  // the selected plan set) counts, so measurements stranded on superseded
  // sheets don't inflate the totals.
  // Single shared implementation lives in proposalGenerator.computeTakeoffTotals;
  // ProjectView and the /proposal section both call it so totals never diverge.
  const getTakeoffTotals = () => {
    if (!project) return [];
    return computeTakeoffTotals(project, revisionModel.currentPageIds);
  };

  const handleOptimizeThumbnails = async () => {
    if (!project) return;
    
    const pagesToOptimize = project.pages.filter(p => !p.thumbnailId);
    if (pagesToOptimize.length === 0) return;

    setIsOptimizingThumbnails(true);
    setOptimizeProgress({ current: 0, total: pagesToOptimize.length });

    const updatedPages = [...project.pages];

    for (let i = 0; i < pagesToOptimize.length; i++) {
      const page = pagesToOptimize[i];
      setOptimizeProgress({ current: i + 1, total: pagesToOptimize.length });
      
      try {
        // Load the full image
        const imgUrl = await getFile(page.imageId);
        if (!imgUrl) continue;

        const img = new Image();
        img.src = imgUrl;
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
        });

        // Generate thumbnail
        const thumbCanvas = document.createElement('canvas');
        const thumbCtx = thumbCanvas.getContext('2d');
        const thumbScale = 400 / Math.max(img.width, img.height);
        thumbCanvas.width = img.width * thumbScale;
        thumbCanvas.height = img.height * thumbScale;
        
        if (thumbCtx) {
          thumbCtx.drawImage(img, 0, 0, thumbCanvas.width, thumbCanvas.height);
          const thumbnailDataUrl = thumbCanvas.toDataURL('image/jpeg', 0.7);
          
          const thumbnailId = uuidv4();
          await saveImage(thumbnailId, thumbnailDataUrl);
          
          // Update page
          const pageIndex = updatedPages.findIndex(p => p.id === page.id);
          if (pageIndex !== -1) {
            updatedPages[pageIndex] = { ...updatedPages[pageIndex], thumbnailId };
          }
        }
      } catch (err) {
        console.error(`Failed to optimize thumbnail for page ${page.name}`, err);
      }
    }

    const updatedProject = { ...project, pages: updatedPages };
    await saveProject(updatedProject);
    setProject(updatedProject);
    setIsOptimizingThumbnails(false);
  };

  const getDueDateColor = () => {
    if (!project || project.submitted || !project.bidDueDate) return 'text-slate-500';
    
    const now = Date.now();
    const diff = project.bidDueDate - now;
    const days = diff / (1000 * 60 * 60 * 24);

    if (days < 0) return 'text-purple-600 font-bold';
    if (days <= 3) return 'text-red-600 font-bold';
    if (days <= 14) return 'text-amber-600 font-bold';
    
    return 'text-slate-500';
  };

  // Pages that are visible at the current plan-set selection after
  // revision-dedup, *before* search filtering. Exposed separately so the
  // search-result badge can show "X of Y matches" (Y = visiblePages.length).
  const visiblePages = revisionModel.visiblePages;

  const filteredPages = useMemo(() => {
    const searchLower = searchTerm.toLowerCase();
    const matched = searchLower
      ? visiblePages.filter(page =>
          page.name.toLowerCase().includes(searchLower) ||
          (page.pageNumber && page.pageNumber.toLowerCase().includes(searchLower)) ||
          (page.description && page.description.toLowerCase().includes(searchLower)) ||
          (page.extractedText && page.extractedText.toLowerCase().includes(searchLower)),
        )
      : visiblePages;

    const sorted = [...matched];
    // Favorites always group at the top, then the chosen sort order applies
    // inside both the favorites and non-favorites groups. This is a stable
    // pre-step before the sort below, hence the staged partition.
    const isFav = (p: ProjectPage) => favoritePageIds.has(p.id);
    // Comparator for the active sort mode. Favorites then ride on top of
    // this via favSort below.
    let baseCmp: (a: ProjectPage, b: ProjectPage) => number;
    if (pagesSortMode === 'description') {
      // Pages without a description sink to the bottom so the meaningful
      // entries stay grouped; among those with one, tie-break by pageNumber
      // so two "Floor Plan" pages still come out in drawing-set order.
      baseCmp = (a, b) => {
        const da = (a.description || '').trim();
        const db = (b.description || '').trim();
        if (!da && !db) return 0;
        if (!da) return 1;
        if (!db) return -1;
        const cmp = da.localeCompare(db, undefined, { numeric: true, sensitivity: 'base' });
        if (cmp !== 0) return cmp;
        return (a.pageNumber || '').localeCompare(b.pageNumber || '', undefined, { numeric: true, sensitivity: 'base' });
      };
    } else if (pagesSortMode === 'highlightsDesc') {
      baseCmp = (a, b) => b.measurements.length - a.measurements.length;
    } else {
      // Default: numeric sort by pageNumber (drawing-set convention).
      baseCmp = (a, b) => {
        const nameA = a.pageNumber || a.name || '';
        const nameB = b.pageNumber || b.name || '';
        return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' });
      };
    }
    // Favorites always sort to the top; the active sort applies inside the
    // favorites group and inside the non-favorites group.
    sorted.sort((a, b) => {
      const fa = isFav(a), fb = isFav(b);
      if (fa !== fb) return fa ? -1 : 1;
      return baseCmp(a, b);
    });
    return sorted;
  }, [visiblePages, searchTerm, pagesSortMode, favoritePageIds]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-900 p-4 md:p-8 font-sans">
        <div className="max-w-7xl mx-auto space-y-6">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-9 w-2/3 max-w-md" />
          <div className="flex flex-wrap gap-3">
            <Skeleton className="h-7 w-24 rounded-full" />
            <Skeleton className="h-7 w-24 rounded-full" />
            <Skeleton className="h-7 w-28 rounded-full" />
          </div>
          <div className="flex flex-wrap gap-4">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-40" />
          </div>
          <div className="flex gap-6 border-b border-slate-200 dark:border-slate-700 pb-px">
            <Skeleton className="h-8 w-16" />
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-8 w-20" />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="aspect-[3/4] w-full rounded-xl" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!project) return null;

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 p-4 md:p-8 font-sans">

      {/* ── PDF generation progress overlay ── */}
      {(isPrinting || isExportingExcel) && (
        <div className="fixed inset-0 z-[999] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl p-8 w-full max-w-xs mx-4 flex flex-col items-center gap-5">
            <Loader2 size={44} className="text-accent-600 animate-spin" />
            <div className="text-center space-y-2">
              <p className="font-semibold text-slate-800 dark:text-slate-100 text-base">
                {isPrinting
                  ? 'Generating PDF…'
                  : 'Exporting to Excel…'}
              </p>
              {progressMessage && (
                <p className="text-sm text-slate-500 dark:text-slate-400">{progressMessage}</p>
              )}
              <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">This may take a moment for large documents</p>
            </div>
          </div>
        </div>
      )}

      <div className="max-w-5xl mx-auto">
        <Link to="/projects" className="inline-flex items-center gap-2 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 mb-4 md:mb-6 transition-colors font-medium text-sm md:text-base">
          <ArrowLeft size={18} />
          Back to Projects
        </Link>
        
        <div className="flex flex-col md:flex-row justify-between items-start md:items-end mb-6 md:mb-8 gap-4 md:gap-6">
          <div className="w-full">
            <div className="flex items-center gap-3">
              <h1 className="text-xl md:text-3xl font-bold text-slate-900 dark:text-white break-words leading-tight">{project.name}</h1>
              {isAdmin && (
                <button
                  onClick={() => navigate(`/project/${projectId}/settings`)}
                  className="p-1.5 text-slate-400 hover:text-accent-600 transition-all rounded-lg hover:bg-accent-50 flex-shrink-0"
                  title="Project settings"
                  aria-label="Project settings"
                >
                  <SlidersHorizontal size={18} />
                </button>
              )}
            </div>
            <ProjectStageControl
              projectId={project.id}
              version={project.version}
              status={project.status}
              onChanged={(version, status) => setProject(p => (p ? { ...p, version, status } : p))}
            />

            <div className="flex flex-wrap gap-2 mt-3 md:mt-4">
              <button
                onClick={() => projectId && openNotes(projectId)}
                className="px-3 py-1 rounded-full text-[10px] md:text-xs font-bold uppercase tracking-wider transition-all border bg-white text-accent-600 border-accent-200 hover:border-accent-400 hover:bg-accent-50 flex items-center gap-1.5 shadow-sm"
              >
                <StickyNote size={14} />
                Notes Board
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:flex lg:flex-wrap lg:items-center gap-3 md:gap-4 mt-4 text-xs md:text-sm text-slate-500 dark:text-slate-400">
              <div className="flex items-center gap-2 bg-white/50 dark:bg-slate-700/50 p-2 rounded-lg lg:bg-transparent lg:dark:bg-transparent lg:p-0">
                <Calendar size={14} className="text-slate-400 flex-shrink-0" />
                <span className="truncate">Created {new Date(project.createdAt).toLocaleDateString()}</span>
              </div>
              
              <div className="flex items-center gap-2 bg-white/50 dark:bg-slate-700/50 p-2 rounded-lg lg:bg-transparent lg:dark:bg-transparent lg:p-0">
                <Building2 size={14} className="text-slate-400 flex-shrink-0" />
                <span className="truncate">{project.contractor || 'No contractor'}</span>
              </div>

              <div className="flex items-center gap-2 bg-white/50 dark:bg-slate-700/50 p-2 rounded-lg lg:bg-transparent lg:dark:bg-transparent lg:p-0">
                <MapPin size={14} className="text-slate-400 flex-shrink-0" />
                {project.address ? (
                  <a
                    href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(project.address)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-accent-600 hover:underline transition-colors truncate"
                  >
                    {project.address}
                  </a>
                ) : (
                  <span className="truncate">No address</span>
                )}
              </div>

              <div className="flex items-center gap-2 bg-white/50 dark:bg-slate-700/50 p-2 rounded-lg lg:bg-transparent lg:dark:bg-transparent lg:p-0">
                <Clock size={14} className="text-slate-400 flex-shrink-0" />
                <span className={`${getDueDateColor()} truncate`}>
                  Due: {project.bidDueDate ? new Date(project.bidDueDate).toLocaleDateString() : 'Not set'}
                </span>
              </div>

              {projectStorage && (
                <div
                  className="flex items-center gap-2 bg-white/50 dark:bg-slate-700/50 p-2 rounded-lg lg:bg-transparent lg:dark:bg-transparent lg:p-0"
                  title={`${formatBytes(projectStorage.imageBytes)} in ${projectStorage.imageCount} file${projectStorage.imageCount === 1 ? '' : 's'}, ${formatBytes(projectStorage.dataBytes)} project data, ${formatBytes(projectStorage.noteBytes)} notes`}
                >
                  <HardDrive size={14} className="text-slate-400 flex-shrink-0" />
                  <span className="truncate">{formatBytes(projectStorage.totalBytes)} stored</span>
                </div>
              )}
            </div>
          </div>
          {project.planSets && project.planSets.length > 0 && (
            <div className="flex flex-col items-stretch md:items-end gap-1.5 w-full md:w-auto mt-2 md:mt-0">
              <div className="flex items-center gap-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 shadow-sm w-full md:w-auto">
                <Layers size={15} className="text-accent-600 shrink-0" />
                <span className="text-xs md:text-sm text-slate-500 dark:text-slate-400 font-medium whitespace-nowrap">Plan Set:</span>
                <select
                  value={selectedPlanSetId}
                  onChange={(e) => setSelectedPlanSetId(e.target.value)}
                  className="bg-transparent dark:bg-transparent text-xs md:text-sm font-medium text-slate-700 dark:text-slate-300 outline-none w-full md:min-w-[160px]"
                >
                  <option value="">Current (all sets)</option>
                  {orderedPlanSets(project).slice().reverse().map(ps => (
                    <option key={ps.id} value={ps.id}>
                      {ps.name}{ps.date ? ` · ${ps.date}` : ''}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => setShowManagePlanSets(true)}
                  aria-label="Manage plan sets"
                  title="Manage plan sets"
                  className="shrink-0 p-1 rounded-md text-slate-400 hover:text-accent-600 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                >
                  <Settings size={15} />
                </button>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-slate-400 dark:text-slate-500 px-1">
                {selectedPlanSetId ? (() => {
                  const s = summarizePlanSet(project, selectedPlanSetId);
                  return <span>Viewing as of this set · {s.newCount} new, {s.revisedCount} revised{s.total ? ` (${s.total} sheets reissued)` : ''}</span>;
                })() : (
                  <span>Showing the latest revision of each sheet · {visiblePages.length} sheet{visiblePages.length === 1 ? '' : 's'}</span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-200 dark:border-slate-700 mb-6 overflow-x-auto no-scrollbar -mx-4 px-4 md:mx-0 md:px-0">
          <button
            onClick={() => setActiveTab('pages')}
            className={`px-4 md:px-6 py-3 text-sm font-medium transition-colors relative whitespace-nowrap ${
              activeTab === 'pages' ? 'text-accent-600' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
            }`}
          >
            Pages
            {activeTab === 'pages' && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent-600" />
            )}
          </button>
          <button
            onClick={() => setActiveTab('takeoffs')}
            className={`px-4 md:px-6 py-3 text-sm font-medium transition-colors relative whitespace-nowrap ${
              activeTab === 'takeoffs' ? 'text-accent-600' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
            }`}
          >
            Takeoffs
            {activeTab === 'takeoffs' && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent-600" />
            )}
          </button>
          {project.email && (
            <button
              onClick={() => setActiveTab('email')}
              className={`px-4 md:px-6 py-3 text-sm font-medium transition-colors relative whitespace-nowrap flex items-center gap-1.5 ${
                activeTab === 'email' ? 'text-accent-600' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
              }`}
            >
              <Mail size={14} /> Email
              {project.emails && project.emails.length > 1 && (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-accent-100 dark:bg-accent-900/40 text-accent-700 dark:text-accent-300">
                  {project.emails.length}
                </span>
              )}
              {activeTab === 'email' && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent-600" />
              )}
            </button>
          )}
        </div>

        {activeTab === 'pages' ? (
          <div className="space-y-6">
            <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4">
              <div className="flex-1 w-full max-w-md flex flex-col gap-1">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                  <input
                    ref={pageSearchInputRef}
                    type="text"
                    placeholder="Search pages and text...  ( / )"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Escape' && searchTerm) setSearchTerm(''); }}
                    className={`w-full pl-10 ${searchTerm ? 'pr-10' : 'pr-4'} py-2.5 bg-white dark:bg-slate-800/50 border border-slate-200 dark:border-slate-600 rounded-xl text-sm dark:text-white dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-accent-500 shadow-sm`}
                  />
                  {searchTerm && (
                    <button
                      type="button"
                      onClick={() => setSearchTerm('')}
                      title="Clear search (Esc)"
                      aria-label="Clear search"
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-full text-slate-400 hover:text-slate-700 hover:bg-slate-100 dark:hover:text-slate-200 dark:hover:bg-slate-700 transition-colors"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
                {searchTerm && (
                  <div className="px-1 text-xs text-slate-500 dark:text-slate-400">
                    {filteredPages.length === 0
                      ? `No matches in ${visiblePages.length} page${visiblePages.length === 1 ? '' : 's'}`
                      : `${filteredPages.length} of ${visiblePages.length} page${visiblePages.length === 1 ? '' : 's'}`}
                  </div>
                )}
              </div>
              <div className="flex flex-wrap gap-2 w-full lg:w-auto">
                <select
                  value={pagesSortMode}
                  onChange={(e) => setPagesSortMode(e.target.value as PagesSortMode)}
                  title="Sort order"
                  className="text-sm px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800/50 dark:text-white focus:outline-none focus:ring-2 focus:ring-accent-500 shadow-sm"
                >
                  <option value="pageNumber">Page number</option>
                  <option value="description">Description</option>
                  <option value="highlightsDesc">Most highlights</option>
                </select>
                {/* Grid / list view toggle for the pages tab. Persisted per-user. */}
                <div className="flex items-center gap-0.5 bg-white dark:bg-slate-800/50 border border-slate-200 dark:border-slate-600 rounded-lg p-0.5 shadow-sm">
                  <button
                    type="button"
                    onClick={() => setPagesViewMode('grid')}
                    title="Grid view"
                    aria-pressed={pagesViewMode === 'grid'}
                    className={`p-1.5 rounded-md transition-colors ${
                      pagesViewMode === 'grid'
                        ? 'bg-accent-600 text-white'
                        : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 dark:hover:text-slate-200'
                    }`}
                  >
                    <LayoutGrid size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setPagesViewMode('list')}
                    title="List view"
                    aria-pressed={pagesViewMode === 'list'}
                    className={`p-1.5 rounded-md transition-colors ${
                      pagesViewMode === 'list'
                        ? 'bg-accent-600 text-white'
                        : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 dark:hover:text-slate-200'
                    }`}
                  >
                    <List size={16} />
                  </button>
                </div>
                {selectedPageIds.size > 0 && (
                  <>
                    <button
                      onClick={handleShareSelectedPages}
                      className="flex-1 lg:flex-none px-4 py-2 bg-accent-600 text-white rounded-lg text-sm font-medium hover:bg-accent-700 transition-colors flex items-center justify-center gap-2 shadow-sm"
                    >
                      <LinkIcon size={16} />
                      Share ({selectedPageIds.size})
                    </button>
                    <button
                      onClick={() => setSelectedPageIds(new Set())}
                      className="flex-1 lg:flex-none px-4 py-2 bg-slate-100 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-200 transition-colors flex items-center justify-center gap-2 shadow-sm"
                    >
                      <X size={16} />
                      Deselect All
                    </button>
                  </>
                )}
                {project.pages.some(p => !p.thumbnailId) && (
                  <button
                    onClick={handleOptimizeThumbnails}
                    disabled={isOptimizingThumbnails}
                    className="flex-1 lg:flex-none px-4 py-2 bg-slate-100 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-200 transition-colors flex items-center justify-center gap-2 shadow-sm disabled:opacity-50"
                  >
                    {isOptimizingThumbnails ? (
                      <><Loader2 size={16} className="animate-spin" /> ({optimizeProgress.current}/{optimizeProgress.total})</>
                    ) : (
                      <><Settings size={16} /> Optimize</>
                    )}
                  </button>
                )}
                <button
                  onClick={handleOpenNamePages}
                  className="flex-1 lg:flex-none px-4 py-2 bg-slate-100 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-200 transition-colors flex items-center justify-center gap-2 shadow-sm"
                >
                  <Edit2 size={16} />
                  Name Pages
                </button>
                <button
                  onClick={() => setShowAddPagesModal(true)}
                  className="flex-1 lg:flex-none px-4 py-2 bg-accent-600 text-white rounded-lg text-sm font-medium hover:bg-accent-700 transition-colors flex items-center justify-center gap-2 shadow-sm"
                >
                  <Plus size={16} />
                  Add Pages
                </button>
              </div>
            </div>

            {filteredPages.length === 0 ? (
              <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-12 text-center">
                <div className="w-16 h-16 bg-slate-50 dark:bg-slate-900 rounded-full flex items-center justify-center mx-auto mb-4 text-slate-400 dark:text-slate-500">
                  <FileImage size={32} />
                </div>
                <h3 className="text-lg font-semibold text-slate-900 dark:text-white mb-1">No pages found</h3>
                <p className="text-slate-500 dark:text-slate-400 text-sm max-w-xs mx-auto">
                  {searchTerm ? `No pages match your search "${searchTerm}"` : 'This plan set has no pages yet. Add some to get started.'}
                </p>
                {!searchTerm && (
                  <button
                    onClick={() => setShowAddPagesModal(true)}
                    className="mt-6 px-4 py-2 text-accent-600 font-medium hover:bg-accent-50 rounded-lg transition-colors"
                  >
                    Add your first page
                  </button>
                )}
              </div>
            ) : pagesViewMode === 'list' ? (
              <div className="flex flex-col gap-2">
                {filteredPages.map((page) => {
                  const isPageSelected = selectedPageIds.has(page.id);
                  const isEditing = editingPageId === page.id;
                  const isFavorite = favoritePageIds.has(page.id);
                  const matchIdx = searchTerm && page.extractedText
                    ? page.extractedText.toLowerCase().indexOf(searchTerm.toLowerCase())
                    : -1;
                  const showSnippet = matchIdx >= 0 && !page.name.toLowerCase().includes(searchTerm.toLowerCase());
                  return (
                    <Link
                      key={page.id}
                      to={`/project/${project.id}/page/${page.id}${searchTerm ? `?search=${encodeURIComponent(searchTerm)}` : ''}`}
                      state={{ pageIds: filteredPages.map(p => p.id) }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setPageContextMenu({ pageId: page.id, x: e.clientX, y: e.clientY });
                      }}
                      className={`bg-white dark:bg-slate-800 rounded-xl border overflow-hidden hover:shadow-md transition-all flex items-stretch group ${
                        isPageSelected
                          ? 'border-accent-500 shadow-md ring-2 ring-accent-400'
                          : 'border-slate-200 dark:border-slate-700 hover:border-accent-300 dark:hover:border-accent-500'
                      }`}
                    >
                      <div className="relative w-32 h-24 flex-shrink-0 bg-slate-100 dark:bg-slate-700 border-r border-slate-200 dark:border-slate-600 overflow-hidden">
                        <img
                          src={getImageUrl(page.thumbnailId || page.imageId)}
                          alt={page.name}
                          className="w-full h-full object-cover object-top opacity-90 group-hover:opacity-100 transition-opacity"
                          referrerPolicy="no-referrer"
                        />
                        <button
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setSelectedPageIds(prev => {
                              const next = new Set(prev);
                              if (next.has(page.id)) next.delete(page.id);
                              else next.add(page.id);
                              return next;
                            });
                          }}
                          className={`absolute top-1.5 left-1.5 w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all ${
                            isPageSelected
                              ? 'bg-accent-600 border-accent-600 opacity-100'
                              : 'bg-white/80 border-slate-300 opacity-0 group-hover:opacity-100'
                          }`}
                          title={isPageSelected ? 'Deselect' : 'Select'}
                        >
                          {isPageSelected && <Check size={12} className="text-white" />}
                        </button>
                        {(revisionModel.revisionNumberByPageId.get(page.id) || 1) > 1 && (
                          <button
                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShowRevisionsForPageId(page.id); }}
                            title="View revision history"
                            className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded-md bg-accent-600/90 text-white text-[10px] font-bold tracking-wide shadow-sm hover:bg-accent-700"
                          >
                            Rev {revisionModel.revisionNumberByPageId.get(page.id)}
                          </button>
                        )}
                      </div>
                      <div className="flex-1 min-w-0 p-3 flex flex-col justify-center gap-1">
                        {isEditing ? (
                          <div className="flex flex-col sm:flex-row gap-2" onClick={e => e.preventDefault()}>
                            <input
                              type="text"
                              value={editingPageNumber}
                              onChange={(e) => setEditingPageNumber(e.target.value)}
                              className="sm:w-32 border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500"
                              placeholder="Number"
                              autoFocus
                              onClick={e => e.stopPropagation()}
                            />
                            <input
                              type="text"
                              value={editingPageDescription}
                              onChange={(e) => setEditingPageDescription(e.target.value)}
                              className="flex-1 border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500"
                              placeholder="Description"
                              onClick={e => e.stopPropagation()}
                              onKeyDown={e => {
                                if (e.key === 'Enter') handleSaveRenamePage(e as any, page.id);
                                if (e.key === 'Escape') handleCancelRenamePage(e as any);
                              }}
                            />
                            <div className="flex gap-1">
                              <button onClick={(e) => handleSaveRenamePage(e, page.id)} className="text-green-600 hover:bg-green-50 px-2 py-1 rounded text-xs font-bold flex items-center gap-1">
                                <Check size={14} /> Save
                              </button>
                              <button onClick={handleCancelRenamePage} className="text-slate-400 hover:bg-slate-100 px-2 py-1 rounded text-xs font-bold flex items-center gap-1">
                                <X size={14} /> Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <h3 className="font-semibold text-slate-900 dark:text-slate-100 group-hover:text-accent-600 dark:group-hover:text-accent-400 transition-colors">
                                <HighlightedText text={page.name} term={searchTerm} />
                              </h3>
                              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                                {page.measurements.length} highlights
                                {page.pageNumber && page.name !== page.pageNumber && (
                                  <span className="ml-2 text-slate-400">·  {page.pageNumber}</span>
                                )}
                              </p>
                            </div>
                            <div className="flex items-center gap-0.5 flex-shrink-0">
                              <button
                                onClick={(e) => { e.preventDefault(); toggleFavorite(page.id); }}
                                title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                                aria-pressed={isFavorite}
                                className={`p-1 rounded transition-opacity ${
                                  isFavorite
                                    ? 'opacity-100'
                                    : 'opacity-0 group-hover:opacity-100 hover:bg-amber-50 dark:hover:bg-amber-900/20'
                                }`}
                              >
                                <Star
                                  size={14}
                                  className={isFavorite ? 'text-amber-500 fill-amber-400' : 'text-slate-400 hover:text-amber-500'}
                                />
                              </button>
                              <button
                                onClick={(e) => { e.preventDefault(); handleSharePage(page); }}
                                className="text-slate-400 hover:text-accent-600 p-1 rounded hover:bg-accent-50 opacity-0 group-hover:opacity-100 transition-opacity"
                                title="Copy share link"
                              >
                                <LinkIcon size={14} />
                              </button>
                              <button
                                onClick={(e) => handleStartRenamePage(e, page)}
                                className="text-slate-400 hover:text-accent-600 p-1 rounded hover:bg-accent-50 opacity-0 group-hover:opacity-100 transition-opacity"
                                title="Rename"
                              >
                                <Edit2 size={14} />
                              </button>
                            </div>
                          </div>
                        )}
                        {showSnippet && (
                          <div className="text-xs text-slate-500 bg-slate-50 dark:bg-slate-900/40 px-2 py-1 rounded border border-slate-100 dark:border-slate-700 italic line-clamp-1">
                            ...<HighlightedText
                              text={page.extractedText!.substring(Math.max(0, matchIdx - 30), matchIdx + searchTerm.length + 30)}
                              term={searchTerm}
                            />...
                          </div>
                        )}
                      </div>
                    </Link>
                  );
                })}
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                {filteredPages.map((page) => {
                  const isPageSelected = selectedPageIds.has(page.id);
                  const isFavorite = favoritePageIds.has(page.id);
                  return (
                  <Link
                    key={page.id}
                    to={`/project/${project.id}/page/${page.id}${searchTerm ? `?search=${encodeURIComponent(searchTerm)}` : ''}`}
                    state={{ pageIds: filteredPages.map(p => p.id) }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setPageContextMenu({ pageId: page.id, x: e.clientX, y: e.clientY });
                    }}
                    className={`bg-white dark:bg-slate-800 rounded-xl border overflow-hidden hover:shadow-md transition-all flex flex-col group ${
                      isPageSelected
                        ? 'border-accent-500 shadow-md ring-2 ring-accent-400'
                        : 'border-slate-200 dark:border-slate-700 hover:border-accent-300 dark:hover:border-accent-500'
                    }`}
                  >
                    <div className="h-40 bg-slate-100 dark:bg-slate-700 relative overflow-hidden border-b border-slate-200 dark:border-slate-600">
                      <img
                        src={getImageUrl(page.thumbnailId || page.imageId)}
                        alt={page.name}
                        className="w-full h-full object-cover object-top opacity-90 group-hover:opacity-100 transition-opacity"
                        referrerPolicy="no-referrer"
                      />
                      <button
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setSelectedPageIds(prev => {
                            const next = new Set(prev);
                            if (next.has(page.id)) next.delete(page.id);
                            else next.add(page.id);
                            return next;
                          });
                        }}
                        className={`absolute top-2 left-2 w-6 h-6 rounded-md border-2 flex items-center justify-center transition-all ${
                          isPageSelected
                            ? 'bg-accent-600 border-accent-600 opacity-100'
                            : 'bg-white/80 border-slate-300 opacity-0 group-hover:opacity-100'
                        }`}
                        title={isPageSelected ? 'Deselect' : 'Select'}
                      >
                        {isPageSelected && <Check size={14} className="text-white" />}
                      </button>
                      <button
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleFavorite(page.id); }}
                        title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                        aria-pressed={isFavorite}
                        className={`absolute top-2 right-2 p-1 rounded-md transition-all ${
                          isFavorite
                            ? 'bg-white/80 opacity-100'
                            : 'bg-white/0 opacity-0 group-hover:opacity-100 group-hover:bg-white/80'
                        }`}
                      >
                        <Star
                          size={16}
                          className={isFavorite ? 'text-amber-500 fill-amber-400' : 'text-slate-500'}
                        />
                      </button>
                      {(revisionModel.revisionNumberByPageId.get(page.id) || 1) > 1 && (
                        <button
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShowRevisionsForPageId(page.id); }}
                          title="View revision history"
                          className="absolute bottom-2 right-2 px-2 py-0.5 rounded-md bg-accent-600/90 text-white text-[10px] font-bold tracking-wide shadow-sm hover:bg-accent-700"
                        >
                          Rev {revisionModel.revisionNumberByPageId.get(page.id)}
                        </button>
                      )}
                    </div>
                    <div className="p-4 flex-1 flex flex-col justify-between">
                      <div>
                        {editingPageId === page.id ? (
                          <div className="flex flex-col gap-2 mb-2" onClick={e => e.preventDefault()}>
                            <div className="flex flex-col gap-1">
                              <label className="text-[10px] font-bold text-slate-400 uppercase">Number</label>
                              <input
                                type="text"
                                value={editingPageNumber}
                                onChange={(e) => setEditingPageNumber(e.target.value)}
                                className="w-full border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500"
                                placeholder="e.g. A-01"
                                autoFocus
                                onClick={e => e.stopPropagation()}
                              />
                            </div>
                            <div className="flex flex-col gap-1">
                              <label className="text-[10px] font-bold text-slate-400 uppercase">Description</label>
                              <input
                                type="text"
                                value={editingPageDescription}
                                onChange={(e) => setEditingPageDescription(e.target.value)}
                                className="w-full border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500"
                                placeholder="e.g. Floor Plan"
                                onClick={e => e.stopPropagation()}
                                onKeyDown={e => {
                                  if (e.key === 'Enter') handleSaveRenamePage(e as any, page.id);
                                  if (e.key === 'Escape') handleCancelRenamePage(e as any);
                                }}
                              />
                            </div>
                            <div className="flex justify-end gap-2 mt-1">
                              <button onClick={(e) => handleSaveRenamePage(e, page.id)} className="text-green-600 hover:bg-green-50 px-2 py-1 rounded text-xs font-bold flex items-center gap-1">
                                <Check size={14} /> Save
                              </button>
                              <button onClick={handleCancelRenamePage} className="text-slate-400 hover:bg-slate-100 px-2 py-1 rounded text-xs font-bold flex items-center gap-1">
                                <X size={14} /> Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center justify-between mb-1">
                            <h3 className="font-semibold text-slate-900 dark:text-slate-100 group-hover:text-accent-600 dark:group-hover:text-accent-400 transition-colors line-clamp-1">
                              <HighlightedText text={page.name} term={searchTerm} />
                            </h3>
                            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button
                                onClick={(e) => { e.preventDefault(); handleSharePage(page); }}
                                className="text-slate-400 hover:text-accent-600 p-1 rounded hover:bg-accent-50"
                                title="Copy share link"
                              >
                                <LinkIcon size={14} />
                              </button>
                              <button
                                onClick={(e) => handleStartRenamePage(e, page)}
                                className="text-slate-400 hover:text-accent-600 p-1 rounded hover:bg-accent-50"
                              >
                                <Edit2 size={14} />
                              </button>
                            </div>
                          </div>
                        )}
                        <p className="text-sm text-slate-500">
                          {page.measurements.length} highlights
                        </p>
                        {searchTerm && page.extractedText && page.extractedText.toLowerCase().includes(searchTerm.toLowerCase()) && !page.name.toLowerCase().includes(searchTerm.toLowerCase()) && (
                          <div className="mt-2 text-xs text-slate-500 bg-slate-50 p-2 rounded border border-slate-100 line-clamp-2 italic">
                            ...<HighlightedText
                              text={page.extractedText.substring(Math.max(0, page.extractedText.toLowerCase().indexOf(searchTerm.toLowerCase()) - 30), page.extractedText.toLowerCase().indexOf(searchTerm.toLowerCase()) + searchTerm.length + 30)}
                              term={searchTerm}
                            />...
                          </div>
                        )}
                      </div>
                    </div>
                  </Link>
                  );
                })}
              </div>
            )}
            {pageContextMenu && (() => {
              const ctxPage = filteredPages.find(p => p.id === pageContextMenu.pageId)
                ?? project.pages.find(p => p.id === pageContextMenu.pageId);
              if (!ctxPage) return null;
              const pageHref = `/project/${project.id}/page/${ctxPage.id}`;
              return (
                <div
                  className="fixed z-50 min-w-[180px] bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl py-1 text-sm"
                  style={{ left: pageContextMenu.x, top: pageContextMenu.y }}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <button
                    onClick={() => { setPageContextMenu(null); navigate(pageHref); }}
                    className="w-full text-left px-3 py-1.5 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2"
                  >
                    <Eye size={14} /> Open
                  </button>
                  <button
                    onClick={() => { setPageContextMenu(null); window.open(pageHref, '_blank', 'noopener'); }}
                    className="w-full text-left px-3 py-1.5 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2"
                  >
                    <LinkIcon size={14} /> Open in new tab
                  </button>
                  <div className="my-1 border-t border-slate-100 dark:border-slate-700" />
                  <button
                    onClick={() => { setPageContextMenu(null); toggleFavorite(ctxPage.id); }}
                    className="w-full text-left px-3 py-1.5 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2"
                  >
                    <Star size={14} className={favoritePageIds.has(ctxPage.id) ? 'text-amber-500 fill-amber-400' : ''} />
                    {favoritePageIds.has(ctxPage.id) ? 'Remove from favorites' : 'Add to favorites'}
                  </button>
                  <button
                    onClick={() => { setPageContextMenu(null); handleSharePage(ctxPage as any); }}
                    className="w-full text-left px-3 py-1.5 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2"
                  >
                    <LinkIcon size={14} /> Copy share link
                  </button>
                  <button
                    onClick={(e) => { setPageContextMenu(null); handleStartRenamePage(e as any, ctxPage); }}
                    className="w-full text-left px-3 py-1.5 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2"
                  >
                    <Edit2 size={14} /> Rename
                  </button>
                  {(() => {
                    const key = sheetKey(ctxPage);
                    const revs = key ? (revisionModel.revisionsBySheet.get(key) || []) : [];
                    if (revs.length < 2) return null;
                    const idx = revs.findIndex(p => p.id === ctxPage.id);
                    const hasPrior = idx > 0 && revs[idx - 1].measurements.length > 0;
                    return (
                      <>
                        <div className="my-1 border-t border-slate-100 dark:border-slate-700" />
                        <button
                          onClick={() => { setPageContextMenu(null); setShowRevisionsForPageId(ctxPage.id); }}
                          className="w-full text-left px-3 py-1.5 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2"
                        >
                          <History size={14} /> Revision history
                        </button>
                        {hasPrior && (
                          <button
                            onClick={async () => {
                              setPageContextMenu(null);
                              const n = await handleCopyMeasurementsForward(ctxPage.id);
                              if (n > 0) toast(`Copied ${n} measurement${n === 1 ? '' : 's'} from the previous revision`, { type: 'success' });
                              else if (n === 0) toast('No measurements to copy from the previous revision', { type: 'info' });
                            }}
                            className="w-full text-left px-3 py-1.5 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2"
                          >
                            <Copy size={14} /> Copy measurements from previous revision
                          </button>
                        )}
                      </>
                    );
                  })()}
                  <div className="my-1 border-t border-slate-100 dark:border-slate-700" />
                  <button
                    onClick={() => { setPageContextMenu(null); handleDeletePage(ctxPage); }}
                    className="w-full text-left px-3 py-1.5 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 flex items-center gap-2"
                  >
                    <Trash2 size={14} /> Delete page
                  </button>
                </div>
              );
            })()}
          </div>
        ) : activeTab === 'takeoffs' ? (
          <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden shadow-sm">
            <div className="p-4 md:p-6 border-b border-slate-100 dark:border-slate-700 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-slate-50/50 dark:bg-slate-800/50">
              <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100">Takeoffs Inventory</h2>
              <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
                {selectedTakeoffIds.size > 0 && (
                  <div className="flex items-center gap-2 w-full sm:w-auto">
                    <select
                      value={highlightQuality}
                      onChange={e => setHighlightQuality(e.target.value as HighlightQuality)}
                      title="Blueprint print quality"
                      className="text-xs px-2 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 dark:text-white focus:ring-1 focus:ring-accent-500 outline-none transition-colors"
                    >
                      {(Object.entries(HIGHLIGHT_QUALITY_PRESETS) as [HighlightQuality, { label: string }][]).map(([k, v]) => (
                        <option key={k} value={k}>{v.label}</option>
                      ))}
                    </select>
                    <button
                      onClick={handlePrint}
                      disabled={isPrinting || isExportingExcel}
                      className="flex-1 sm:flex-none px-3 py-2 bg-emerald-600 text-white rounded-lg text-xs font-medium hover:bg-emerald-700 transition-colors flex items-center justify-center gap-2 shadow-sm disabled:opacity-50"
                    >
                      {isPrinting ? <Loader2 size={14} className="animate-spin" /> : <Printer size={14} />}
                      Print ({selectedTakeoffIds.size})
                    </button>
                    <button
                      onClick={handleExportExcel}
                      disabled={isPrinting || isExportingExcel}
                      className="flex-1 sm:flex-none px-3 py-2 bg-accent-600 text-white rounded-lg text-xs font-medium hover:bg-accent-700 transition-colors flex items-center justify-center gap-2 shadow-sm disabled:opacity-50"
                    >
                      {isExportingExcel ? <Loader2 size={14} className="animate-spin" /> : <FileSpreadsheet size={14} />}
                      Excel ({selectedTakeoffIds.size})
                    </button>
                    <button
                      onClick={() => navigate(`/project/${projectId}/proposal`)}
                      className="flex-1 sm:flex-none px-3 py-2 bg-violet-600 text-white rounded-lg text-xs font-medium hover:bg-violet-700 transition-colors flex items-center justify-center gap-2 shadow-sm"
                    >
                      <FileText size={14} />
                      Proposal
                    </button>
                  </div>
                )}
                <div className="flex items-center gap-2 w-full sm:w-auto">
                  {project.takeoffs.length > 0 && (
                    <button
                      onClick={() => setShowDeleteAllConfirm(true)}
                      className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg transition-colors"
                      title="Delete All Takeoffs"
                    >
                      <Trash2 size={20} />
                    </button>
                  )}
                  <button
                    onClick={() => setShowTakeoffModal(true)}
                    className="flex-1 sm:flex-none px-4 py-2 bg-accent-600 text-white rounded-lg text-sm font-medium hover:bg-accent-700 transition-colors flex items-center justify-center gap-2 shadow-sm"
                  >
                    <Plus size={16} />
                    New Takeoff
                  </button>
                </div>
              </div>
            </div>
            
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-800 text-left text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest border-b border-slate-200 dark:border-slate-700">
                    <th className="px-6 py-4 w-10">
                      <input 
                        type="checkbox" 
                        className="rounded border-slate-300 dark:border-slate-600 text-accent-600 focus:ring-accent-500"
                        checked={selectedTakeoffIds.size === project.takeoffs.length && project.takeoffs.length > 0}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedTakeoffIds(new Set(project.takeoffs.map(t => t.id)));
                          } else {
                            setSelectedTakeoffIds(new Set());
                          }
                        }}
                      />
                    </th>
                    <th className="px-6 py-4">Takeoff</th>
                    <th className="px-6 py-4">Type</th>
                    <th className="px-6 py-4 text-right">Qty</th>
                    <th className="px-6 py-4 text-right">Unit Cost</th>
                    <th className="px-6 py-4 text-right">Total Cost</th>
                    <th className="px-6 py-4 w-24"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                  {(() => {
                    const totals = getTakeoffTotals();
                    const packageOrder: string[] = [];
                    const packageMap: Record<string, typeof totals> = {};
                    const ungrouped: typeof totals = [];
                    for (const t of totals) {
                      if (t.pricePackage) {
                        if (!packageMap[t.pricePackage]) {
                          packageMap[t.pricePackage] = [];
                          packageOrder.push(t.pricePackage);
                        }
                        packageMap[t.pricePackage].push(t);
                      } else {
                        ungrouped.push(t);
                      }
                    }
                    const renderRow = (takeoff: typeof totals[0]) => {
                      const totalCost = calculateTakeoffTotalCost(takeoff, takeoff.totalRealValue);
                      const costDetails = calculateTakeoffCostDetails(takeoff, takeoff.totalRealValue);
                      return (
                        <React.Fragment key={takeoff.id}>
                          <tr className="hover:bg-slate-50/80 dark:hover:bg-slate-800/50 transition-colors group border-l-4" style={{ borderLeftColor: takeoff.color }}>
                            <td className="px-6 py-4">
                              <input
                                type="checkbox"
                                className="rounded border-slate-300 dark:border-slate-600 text-accent-600 focus:ring-accent-500"
                                checked={selectedTakeoffIds.has(takeoff.id)}
                                onChange={() => toggleTakeoffSelection(takeoff.id)}
                              />
                            </td>
                            <td className="px-6 py-4">
                              <div className="flex items-center gap-3 cursor-pointer" onClick={() => toggleTakeoffExpanded(takeoff.id)}>
                                <div className={`transition-transform duration-200 ${expandedTakeoffs[takeoff.id] ? 'rotate-90' : ''}`}>
                                  <ChevronRight size={16} className="text-slate-400" />
                                </div>
                                <div className="w-4 h-4 rounded-full shadow-sm shrink-0" style={{ backgroundColor: takeoff.color }} />
                                <span className="font-semibold text-slate-900 dark:text-slate-100">{takeoff.name}</span>
                              </div>
                            </td>
                            <td className="px-6 py-4 text-sm text-slate-500 dark:text-slate-400 capitalize font-medium">
                              {takeoff.type}
                            </td>
                            <td className="px-6 py-4 text-right font-bold text-slate-900 dark:text-slate-100">
                              {takeoff.totalRealValue > 0 ? formatRealValue(takeoff.totalRealValue, takeoff.type as 'length' | 'area' | 'count', takeoff.unit?.replace('sq ', '') || 'ft', takeoff, false) : '-'}
                            </td>
                            <td className="px-6 py-4 text-right text-sm text-slate-600 dark:text-slate-400 font-medium">
                              {takeoff.isAdvancedCost ? (
                                <div className="flex flex-col items-end">
                                  <span className="text-accent-600 dark:text-accent-400 font-bold">${(totalCost / (takeoff.totalRealValue || 1)).toFixed(2)}</span>
                                  <span className="text-[10px] text-slate-400 uppercase">Avg / Unit</span>
                                </div>
                              ) : (
                                takeoff.costPerUnit ? `$${takeoff.costPerUnit.toFixed(2)}` : '-'
                              )}
                            </td>
                            <td className="px-6 py-4 text-right font-bold text-accent-600 dark:text-accent-400">
                              <div className="flex flex-col items-end">
                                <span>{totalCost > 0 ? `$${roundUpTo100(totalCost).toLocaleString()}` : '-'}</span>
                                {takeoff.isAdvancedCost && costDetails.map((d, i) => (
                                  d.quantity !== undefined && d.quantity > 0 && (
                                    <span key={i} className="text-[10px] text-slate-500 dark:text-slate-400 font-normal">
                                      {d.quantity.toFixed(2)} {d.quantityUnit || 'units'} of {d.name}
                                    </span>
                                  )
                                ))}
                              </div>
                            </td>
                            <td className="px-6 py-4 text-right">
                              <div className="flex items-center justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                                <button
                                  onClick={() => handleEditTakeoff(takeoff)}
                                  className="text-slate-400 hover:text-accent-600 p-2 rounded-lg hover:bg-accent-50 dark:hover:bg-accent-900/30 transition-colors"
                                  title="Edit Takeoff"
                                >
                                  <Edit2 size={16} />
                                </button>
                                <button
                                  onClick={() => handleDeleteTakeoff(takeoff.id)}
                                  className="text-slate-400 hover:text-red-600 p-2 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors"
                                  title="Delete Takeoff"
                                >
                                  <Trash2 size={16} />
                                </button>
                              </div>
                            </td>
                          </tr>
                          {expandedTakeoffs[takeoff.id] && (
                            <tr>
                              <td colSpan={11} className="px-0 py-0 bg-slate-50/30 dark:bg-slate-800/30">
                                <div className="border-l-4 border-accent-500/20 ml-6 my-2 divide-y divide-slate-100 dark:divide-slate-700">
                                  {(() => {
                                    return takeoff.pageBreakdown.map(pb => {
                                      const pageKey = `${takeoff.id}__${pb.pageId}`;
                                      const isPageExpanded = !!expandedTakeoffPages[pageKey];
                                      const pageTotalCost = allocateSubsetCost(takeoff, pb.realValue);
                                      const pageCostDetails = allocateSubsetDetails(takeoff, pb.realValue);
                                      return (
                                        <div key={pb.pageId}>
                                          <div className="py-3 pl-8 pr-6 grid grid-cols-[minmax(0,1fr)_140px_140px_180px] gap-4 items-start hover:bg-white dark:hover:bg-slate-800 transition-colors">
                                            <div className="flex items-center gap-2 min-w-0">
                                              <button
                                                type="button"
                                                onClick={() => toggleTakeoffPageExpanded(takeoff.id, pb.pageId)}
                                                className="p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-700"
                                                title={isPageExpanded ? 'Hide measurements' : 'Show measurements'}
                                              >
                                                <div className={`transition-transform duration-200 ${isPageExpanded ? 'rotate-90' : ''}`}>
                                                  <ChevronRight size={14} className="text-slate-400" />
                                                </div>
                                              </button>
                                              <Link
                                                to={`/project/${project.id}/page/${pb.pageId}${searchTerm ? `?search=${encodeURIComponent(searchTerm)}` : ''}`}
                                                state={{ pageIds: takeoff.pageBreakdown.map(p => p.pageId) }}
                                                className="text-sm text-accent-600 dark:text-accent-400 hover:text-accent-800 font-semibold flex items-center gap-2 min-w-0"
                                              >
                                                <FileImage size={14} className="text-slate-400 shrink-0" />
                                                <span className="truncate">{pb.pageName}</span>
                                              </Link>
                                            </div>
                                            <div className="text-right text-sm font-bold text-slate-700 dark:text-slate-300">
                                              {pb.realValue > 0 ? formatRealValue(pb.realValue, takeoff.type as 'length' | 'area' | 'count', pb.unit?.replace('sq ', '') || 'ft', takeoff, false) : '-'}
                                            </div>
                                            <div className="text-right text-sm text-slate-600 dark:text-slate-400 font-medium">
                                              {takeoff.isAdvancedCost ? (
                                                <div className="flex flex-col items-end">
                                                  <span className="text-accent-600 dark:text-accent-400 font-semibold">${(pageTotalCost / (pb.realValue || 1)).toFixed(2)}</span>
                                                  <span className="text-[10px] text-slate-400 uppercase">Avg / Unit</span>
                                                </div>
                                              ) : (
                                                takeoff.costPerUnit ? `$${takeoff.costPerUnit.toFixed(2)}` : '-'
                                              )}
                                            </div>
                                            <div className="text-right">
                                              <div className="flex flex-col items-end">
                                                <span className="text-sm font-bold text-accent-600 dark:text-accent-400">
                                                  {pageTotalCost > 0 ? `$${roundUpTo100(pageTotalCost).toLocaleString()}` : '-'}
                                                </span>
                                                {takeoff.isAdvancedCost && pageCostDetails.map((d, i) => (
                                                  <span key={i} className="text-[10px] text-slate-500 dark:text-slate-400 font-normal">
                                                    {d.quantity !== undefined && d.quantity > 0
                                                      ? `${d.quantity.toFixed(2)} ${d.quantityUnit || 'units'} of ${d.name}`
                                                      : `${d.name}: $${(d.costValue || 0).toFixed(2)}`}
                                                  </span>
                                                ))}
                                              </div>
                                            </div>
                                          </div>
                                          {isPageExpanded && (
                                            <div className="bg-white/60 dark:bg-slate-900/40 border-t border-slate-100 dark:border-slate-700/60 divide-y divide-slate-100/80 dark:divide-slate-700/60">
                                              {pb.measurements.map(meas => {
                                                const measTotalCost = allocateSubsetCost(takeoff, meas.realValue);
                                                const measCostDetails = allocateSubsetDetails(takeoff, meas.realValue);
                                                return (
                                                  <div key={meas.id} className="py-2 pl-16 pr-6 grid grid-cols-[minmax(0,1fr)_140px_140px_180px] gap-4 items-start text-xs">
                                                    <span className="text-slate-600 dark:text-slate-300 truncate">{meas.name || 'Measurement'}</span>
                                                    <div className="text-right font-semibold text-slate-700 dark:text-slate-300">
                                                      {meas.realValue > 0 ? formatRealValue(meas.realValue, takeoff.type as 'length' | 'area' | 'count', meas.unit?.replace('sq ', '') || 'ft', takeoff, false) : '-'}
                                                    </div>
                                                    <div className="text-right text-slate-600 dark:text-slate-400 font-medium">
                                                      {takeoff.isAdvancedCost ? (
                                                        <div className="flex flex-col items-end">
                                                          <span className="text-accent-600 dark:text-accent-400 font-semibold">${(measTotalCost / (meas.realValue || 1)).toFixed(2)}</span>
                                                          <span className="text-[9px] text-slate-400 uppercase">Avg / Unit</span>
                                                        </div>
                                                      ) : (
                                                        takeoff.costPerUnit ? `$${takeoff.costPerUnit.toFixed(2)}` : '-'
                                                      )}
                                                    </div>
                                                    <div className="text-right">
                                                      <div className="flex flex-col items-end">
                                                        <span className="font-semibold text-accent-600 dark:text-accent-400">
                                                          {measTotalCost > 0 ? `$${roundUpTo100(measTotalCost).toLocaleString()}` : '-'}
                                                        </span>
                                                        {takeoff.isAdvancedCost && measCostDetails.map((d, i) => (
                                                          <span key={i} className="text-[9px] text-slate-500 dark:text-slate-400 font-normal">
                                                            {d.quantity !== undefined && d.quantity > 0
                                                              ? `${d.quantity.toFixed(2)} ${d.quantityUnit || 'units'} of ${d.name}`
                                                              : `${d.name}: $${(d.costValue || 0).toFixed(2)}`}
                                                          </span>
                                                        ))}
                                                      </div>
                                                    </div>
                                                  </div>
                                                );
                                              })}
                                              {pb.measurements.length === 0 && (
                                                <div className="py-2 pl-16 text-xs text-slate-400 italic">No measurements.</div>
                                              )}
                                            </div>
                                          )}
                                        </div>
                                      );
                                    });
                                  })()}
                                  {takeoff.pageBreakdown.length === 0 && (
                                    <div className="py-4 pl-8 text-sm text-slate-400 dark:text-slate-500 italic">No measurements found for this takeoff.</div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    };
                    return (
                      <>
                        {packageOrder.map(pkg => (
                          <React.Fragment key={`pkg-${pkg}`}>
                            <tr className="bg-slate-50/70 dark:bg-slate-800/70">
                              <td colSpan={7} className="px-6 py-2">
                                <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">{pkg}</span>
                              </td>
                            </tr>
                            {packageMap[pkg].map(renderRow)}
                          </React.Fragment>
                        ))}
                        {ungrouped.map(renderRow)}
                      </>
                    );
                  })()}
                </tbody>
              </table>
            </div>

            {/* Mobile Takeoff Cards */}
            <div className="md:hidden divide-y divide-slate-100 dark:divide-slate-700">
              {(() => {
                const totals = getTakeoffTotals();
                const packageOrder: string[] = [];
                const packageMap: Record<string, typeof totals> = {};
                const ungrouped: typeof totals = [];
                for (const t of totals) {
                  if (t.pricePackage) {
                    if (!packageMap[t.pricePackage]) {
                      packageMap[t.pricePackage] = [];
                      packageOrder.push(t.pricePackage);
                    }
                    packageMap[t.pricePackage].push(t);
                  } else {
                    ungrouped.push(t);
                  }
                }
                const renderCard = (takeoff: typeof totals[0]) => {
                  const totalCost = calculateTakeoffTotalCost(takeoff, takeoff.totalRealValue);
                  return (
                    <div key={takeoff.id} className="p-4 bg-white dark:bg-slate-900 border-l-4" style={{ borderLeftColor: takeoff.color }}>
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center gap-3">
                          <input
                            type="checkbox"
                            className="rounded border-slate-300 dark:border-slate-600 text-accent-600 focus:ring-accent-500"
                            checked={selectedTakeoffIds.has(takeoff.id)}
                            onChange={() => toggleTakeoffSelection(takeoff.id)}
                          />
                          <div className="w-3 h-3 rounded-full shadow-sm shrink-0" style={{ backgroundColor: takeoff.color }} />
                          <span className="font-bold text-slate-900 dark:text-slate-100">{takeoff.name}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => handleEditTakeoff(takeoff)}
                            className="p-1.5 text-slate-400 hover:text-accent-600"
                          >
                            <Edit2 size={16} />
                          </button>
                          <button
                            onClick={() => handleDeleteTakeoff(takeoff.id)}
                            className="p-1.5 text-slate-400 hover:text-red-600"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-y-2 text-sm mb-3">
                        <div className="text-slate-500 dark:text-slate-400">Type</div>
                        <div className="text-slate-900 dark:text-slate-100 font-medium capitalize text-right">{takeoff.type}</div>

                        <div className="text-slate-500 dark:text-slate-400">Quantity</div>
                        <div className="text-slate-900 dark:text-slate-100 font-bold text-right">
                          {takeoff.totalRealValue > 0 ? formatRealValue(takeoff.totalRealValue, takeoff.type as 'length' | 'area' | 'count', takeoff.unit?.replace('sq ', '') || 'ft', takeoff, false) : '-'}
                        </div>

                        <div className="text-slate-500 dark:text-slate-400">Total Cost</div>
                        <div className="text-accent-600 dark:text-accent-400 font-bold text-right">
                          {totalCost > 0 ? `$${roundUpTo100(totalCost).toLocaleString()}` : '-'}
                        </div>
                      </div>

                      <button
                        onClick={() => toggleTakeoffExpanded(takeoff.id)}
                        className="w-full py-2 bg-slate-50 dark:bg-slate-800 rounded-lg text-xs font-semibold text-slate-600 dark:text-slate-300 flex items-center justify-center gap-2"
                      >
                        {expandedTakeoffs[takeoff.id] ? 'Hide' : 'Show'} Page Breakdown
                        <div className={`transition-transform duration-200 ${expandedTakeoffs[takeoff.id] ? 'rotate-90' : ''}`}>
                          <ChevronRight size={14} />
                        </div>
                      </button>

                      {expandedTakeoffs[takeoff.id] && (() => {
                        const renderStats = (subsetValue: number, unit: string, small: boolean) => {
                          const subsetCost = allocateSubsetCost(takeoff, subsetValue);
                          const subsetDetails = allocateSubsetDetails(takeoff, subsetValue);
                          return (
                            <div className={`grid grid-cols-3 gap-2 ${small ? 'text-[10px]' : 'text-[11px]'}`}>
                              <div>
                                <div className="text-slate-500 dark:text-slate-400 uppercase tracking-wide">Qty</div>
                                <div className="font-bold text-slate-700 dark:text-slate-200">
                                  {subsetValue > 0 ? formatRealValue(subsetValue, takeoff.type as 'length' | 'area' | 'count', unit?.replace('sq ', '') || 'ft', takeoff, false) : '-'}
                                </div>
                              </div>
                              <div>
                                <div className="text-slate-500 dark:text-slate-400 uppercase tracking-wide">Unit Cost</div>
                                <div className="font-semibold text-slate-700 dark:text-slate-200">
                                  {takeoff.isAdvancedCost ? (
                                    <span className="text-accent-600 dark:text-accent-400">${(subsetCost / (subsetValue || 1)).toFixed(2)}<span className="text-[9px] text-slate-400 ml-0.5">avg</span></span>
                                  ) : (
                                    takeoff.costPerUnit ? `$${takeoff.costPerUnit.toFixed(2)}` : '-'
                                  )}
                                </div>
                              </div>
                              <div>
                                <div className="text-slate-500 dark:text-slate-400 uppercase tracking-wide">Total</div>
                                <div className="font-bold text-accent-600 dark:text-accent-400">
                                  {subsetCost > 0 ? `$${roundUpTo100(subsetCost).toLocaleString()}` : '-'}
                                </div>
                              </div>
                              {takeoff.isAdvancedCost && subsetDetails.length > 0 && (
                                <div className="col-span-3 mt-1 pt-1 border-t border-slate-100 dark:border-slate-700/60 space-y-0.5">
                                  {subsetDetails.map((d, i) => (
                                    <div key={i} className="flex justify-between text-[9px] text-slate-500 dark:text-slate-400">
                                      <span className="truncate">{d.name}</span>
                                      <span className="shrink-0 ml-2">
                                        {d.quantity !== undefined && d.quantity > 0
                                          ? `${d.quantity.toFixed(2)} ${d.quantityUnit || 'units'} · $${(d.costValue || 0).toFixed(2)}`
                                          : `$${(d.costValue || 0).toFixed(2)}`}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        };
                        return (
                          <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-700 divide-y divide-slate-100 dark:divide-slate-700">
                            {takeoff.pageBreakdown.map(pb => {
                              const pageKey = `${takeoff.id}__${pb.pageId}`;
                              const isPageExpanded = !!expandedTakeoffPages[pageKey];
                              return (
                                <div key={pb.pageId} className="py-3">
                                  <div className="flex items-center gap-2 mb-2 text-xs">
                                    <button
                                      type="button"
                                      onClick={() => toggleTakeoffPageExpanded(takeoff.id, pb.pageId)}
                                      className="p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-700"
                                      title={isPageExpanded ? 'Hide measurements' : 'Show measurements'}
                                    >
                                      <div className={`transition-transform duration-200 ${isPageExpanded ? 'rotate-90' : ''}`}>
                                        <ChevronRight size={12} className="text-slate-400" />
                                      </div>
                                    </button>
                                    <Link
                                      to={`/project/${project.id}/page/${pb.pageId}${searchTerm ? `?search=${encodeURIComponent(searchTerm)}` : ''}`}
                                      className="text-accent-600 dark:text-accent-400 font-semibold truncate"
                                    >
                                      {pb.pageName}
                                    </Link>
                                  </div>
                                  {renderStats(pb.realValue, pb.unit, false)}
                                  {isPageExpanded && (
                                    <div className="mt-2 ml-5 pl-3 border-l border-slate-200 dark:border-slate-700 space-y-2">
                                      {pb.measurements.map(meas => (
                                        <div key={meas.id}>
                                          <div className="text-[11px] text-slate-600 dark:text-slate-300 font-medium truncate mb-1">
                                            {meas.name || 'Measurement'}
                                          </div>
                                          {renderStats(meas.realValue, meas.unit, true)}
                                        </div>
                                      ))}
                                      {pb.measurements.length === 0 && (
                                        <div className="text-[11px] text-slate-400 italic">No measurements.</div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        );
                      })()}
                    </div>
                  );
                };
                return (
                  <>
                    {packageOrder.map(pkg => (
                      <React.Fragment key={`pkg-${pkg}`}>
                        <div className="px-4 py-2 bg-slate-50 dark:bg-slate-800/70">
                          <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">{pkg}</span>
                        </div>
                        {packageMap[pkg].map(renderCard)}
                      </React.Fragment>
                    ))}
                    {ungrouped.map(renderCard)}
                  </>
                );
              })()}
            </div>

            {project.takeoffs.length === 0 && (
              <div className="px-6 py-12 text-center text-slate-500">
                No takeoffs created yet. <button onClick={() => setShowTakeoffModal(true)} className="text-accent-600 dark:text-accent-400 font-bold hover:underline">Create one</button> to start estimating.
              </div>
            )}
          </div>
        ) : (
          /* Email tab — only reachable when project.email exists */
          <EmailTab project={project} onOpenProposal={() => navigate(`/project/${projectId}/proposal`)} />
        )}
      </div>

      {showDeleteAllConfirm && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-[60]">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
            <div className="p-6 border-b border-slate-100">
              <h3 className="text-lg font-semibold text-slate-900 text-red-600">Delete All Takeoffs</h3>
            </div>
            <div className="p-6">
              <p className="text-slate-600">
                Are you sure you want to delete ALL takeoffs in this project? This will ungroup all measurements. This action is permanent and cannot be undone.
              </p>
            </div>
            <div className="p-6 border-t border-slate-100 bg-slate-50 flex justify-end gap-3">
              <button
                onClick={() => setShowDeleteAllConfirm(false)}
                className="px-5 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-200 rounded-xl transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDeleteAllTakeoffs}
                className="px-5 py-2.5 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-xl transition-colors shadow-sm"
              >
                Delete All
              </button>
            </div>
          </div>
        </div>
      )}

      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-[60]">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
            <div className="p-6 border-b border-slate-100">
              <h3 className="text-lg font-semibold text-slate-900">Delete Takeoff</h3>
            </div>
            <div className="p-6">
              <p className="text-slate-600">
                Are you sure you want to delete this takeoff? All measurements associated with it will be ungrouped. This action cannot be undone.
              </p>
            </div>
            <div className="p-6 border-t border-slate-100 bg-slate-50 flex justify-end gap-3">
              <button
                onClick={() => { setShowDeleteConfirm(false); setTakeoffToDelete(null); }}
                className="px-5 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-200 rounded-xl transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDeleteTakeoff}
                className="px-5 py-2.5 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-xl transition-colors shadow-sm"
              >
                Delete Takeoff
              </button>
            </div>
          </div>
        </div>
      )}

      <NewTakeoffModal
        open={showTakeoffModal}
        onClose={() => setShowTakeoffModal(false)}
        project={project}
        templates={templates}
        onCreateTakeoff={async (newTakeoff) => {
          const updatedProject = {
            ...project,
            takeoffs: [...project.takeoffs, newTakeoff],
          };
          await saveProject(updatedProject);
          setProject(updatedProject);
          setShowTakeoffModal(false);
        }}
      />

      {editingTakeoff && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
            <div className="p-6 border-b border-slate-100">
              <h3 className="text-lg font-semibold text-slate-900">Edit Measurement Takeoff</h3>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Takeoff Name</label>
                <input
                  type="text"
                  value={editTakeoffName}
                  onChange={(e) => setEditTakeoffName(e.target.value)}
                  className="w-full border border-slate-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent-500"
                  placeholder="e.g. Hardwood Flooring"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                  Price Package <span className="text-slate-400 font-normal">(optional)</span>
                </label>
                <input
                  type="text"
                  list="price-package-options-edit"
                  value={editTakeoffPricePackage}
                  onChange={(e) => setEditTakeoffPricePackage(e.target.value)}
                  className="w-full border border-slate-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent-500"
                  placeholder="e.g. Flooring Package"
                />
                <datalist id="price-package-options-edit">
                  {Array.from(new Set(project.takeoffs.map(t => t.pricePackage).filter(Boolean))).map(pkg => (
                    <option key={pkg} value={pkg} />
                  ))}
                </datalist>
                <p className="mt-1 text-xs text-slate-400">Takeoffs with the same package name are grouped together.</p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Measurement Type</label>
                  <input
                    type="text"
                    value={editingTakeoff.type}
                    disabled
                    className="w-full border border-slate-200 rounded-xl px-4 py-2.5 bg-slate-50 text-slate-500 capitalize"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Color</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={editTakeoffColor}
                      onChange={(e) => setEditTakeoffColor(e.target.value)}
                      className="h-11 w-full rounded-lg cursor-pointer border border-slate-300 p-1"
                    />
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Unit</label>
                  <select
                    value={editTakeoffUnit}
                    onChange={(e) => setEditTakeoffUnit(e.target.value)}
                    className="w-full border border-slate-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-white"
                  >
                    <option value="">Default (Scale Unit)</option>
                    {editingTakeoff.type === 'length' && (
                      <>
                        <option value="in">Inches (in)</option>
                        <option value="ft">Feet (ft)</option>
                        <option value="yd">Yards (yd)</option>
                        <option value="cm">Centimeters (cm)</option>
                        <option value="m">Meters (m)</option>
                      </>
                    )}
                    {editingTakeoff.type === 'area' && (
                      <>
                        <option value="sqin">Square Inches (sq in)</option>
                        <option value="sqft">Square Feet (sq ft)</option>
                        <option value="sqyd">Square Yards (sq yd)</option>
                        <option value="sqcm">Square Centimeters (sq cm)</option>
                        <option value="sqm">Square Meters (sq m)</option>
                      </>
                    )}
                    {editingTakeoff.type === 'count' && (
                      <option value="each">Each</option>
                    )}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Cost Per Unit ($)</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    disabled={isEditTakeoffAdvanced}
                    value={isEditTakeoffAdvanced ? '' : editTakeoffCostPerUnit}
                    onChange={(e) => setEditTakeoffCostPerUnit(e.target.value === '' ? '' : Number(e.target.value))}
                    className="w-full border border-slate-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent-500 disabled:bg-slate-50 disabled:text-slate-400"
                    placeholder={isEditTakeoffAdvanced ? "Disabled in Advanced" : "0.00"}
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 py-2">
                <input
                  type="checkbox"
                  id="isEditTakeoffAdvanced"
                  checked={isEditTakeoffAdvanced}
                  onChange={(e) => setIsEditTakeoffAdvanced(e.target.checked)}
                  className="w-4 h-4 text-accent-600 rounded border-slate-300 focus:ring-accent-500"
                />
                <label htmlFor="isEditTakeoffAdvanced" className="text-sm font-medium text-slate-700 cursor-pointer">
                  Advanced Costing (Custom Items)
                </label>
              </div>

              {isEditTakeoffAdvanced && (
                <div className="space-y-3 p-4 bg-slate-50 rounded-xl border border-slate-200">
                  <div className="flex justify-between items-center mb-2">
                    <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider">Custom Cost Items</h4>
                    <button
                      onClick={() => setEditTakeoffCustomCosts([...editTakeoffCustomCosts, { id: uuidv4(), name: '', type: 'unit', costPerUnit: 0 }])}
                      className="text-accent-600 hover:text-accent-700 p-1 rounded-full hover:bg-accent-50 transition-colors"
                      title="Add Cost Item"
                    >
                      <Plus size={16} />
                    </button>
                  </div>
                  
                  {editTakeoffCustomCosts.length === 0 ? (
                    <p className="text-xs text-slate-400 italic text-center py-2">No custom items added. Click + to add.</p>
                  ) : (
                    <div className="space-y-3">
                      {editTakeoffCustomCosts.map((item, index) => (
                        <CustomCostRow
                          key={item.id}
                          item={item}
                          index={index}
                          unitLabel={UNIT_LABELS[editTakeoffUnit] || editTakeoffUnit || (editingTakeoff?.type === 'area' ? 'sq ft' : editingTakeoff?.type === 'length' ? 'ft' : 'ea')}
                          onChange={(idx, updated) => {
                            const newCosts = [...editTakeoffCustomCosts];
                            newCosts[idx] = updated;
                            setEditTakeoffCustomCosts(newCosts);
                          }}
                          onRemove={(idx) => {
                            setEditTakeoffCustomCosts(editTakeoffCustomCosts.filter((_, i) => i !== idx));
                          }}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="p-6 border-t border-slate-100 bg-slate-50 flex justify-end gap-3">
              <button
                onClick={() => setEditingTakeoff(null)}
                className="px-5 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-200 rounded-xl transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveEditTakeoff}
                disabled={!editTakeoffName}
                className="px-5 py-2.5 text-sm font-medium text-white bg-accent-600 hover:bg-accent-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl transition-colors shadow-sm"
              >
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}

      {showManagePlanSets && project && (
        <PlanSetManager
          project={project}
          selectedPlanSetId={selectedPlanSetId}
          onClose={() => setShowManagePlanSets(false)}
          onSelect={setSelectedPlanSetId}
          onUpdate={handleUpdatePlanSet}
          onDelete={handleDeletePlanSet}
          onAddNew={() => { setShowManagePlanSets(false); setShowAddPagesModal(true); }}
        />
      )}

      {showRevisionsForPageId && project && (
        <PlanSetRevisions
          project={project}
          pageId={showRevisionsForPageId}
          onClose={() => setShowRevisionsForPageId(null)}
          onOpenPage={(pid) => { setShowRevisionsForPageId(null); navigate(`/project/${project.id}/page/${pid}`); }}
          onCompare={() => { setComparePageId(showRevisionsForPageId); setShowRevisionsForPageId(null); }}
        />
      )}

      {comparePageId && project && (
        <PlanSetCompare
          project={project}
          pageId={comparePageId}
          onClose={() => setComparePageId(null)}
        />
      )}

      {showAddPagesModal && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className={`bg-white rounded-2xl shadow-xl w-full ${addPagesStep === 'name_pages' ? 'max-w-4xl' : 'max-w-md'} overflow-hidden flex flex-col max-h-[90vh]`}>
            <div className="p-6 border-b border-slate-100 flex justify-between items-center">
              <div>
                <h3 className="text-xl font-bold text-slate-900">
                  {addPagesStep === 'details' ? 'Add New Plan Set' : 'Name Pages'}
                </h3>
                <p className="text-sm text-slate-500 mt-1">
                  {addPagesStep === 'details' ? 'Upload a revised or new set of blueprints' : 'Review and rename the imported pages'}
                </p>
              </div>
              <button 
                onClick={() => {
                  setShowAddPagesModal(false);
                  setAddPagesStep('details');
                  setIsNamingExistingPages(false);
                  setNewPlanSetName('');
                  setNewPlanSetFiles([]);
                  setPendingPages([]);
                  setPendingThumbnails({});
                  setUseExistingPlanSet(false);
                  setTargetPlanSetId('');
                }}
                className="text-slate-400 hover:text-slate-600 transition-colors"
              >
                <X size={24} />
              </button>
            </div>
            
            {addPagesStep === 'details' ? (
              <form onSubmit={handleAddPages} className="flex flex-col overflow-hidden">
                <div className="p-6 space-y-5 overflow-y-auto">
                  <div className="flex items-center gap-4 p-1 bg-slate-100 rounded-lg w-fit mb-2">
                    <button
                      type="button"
                      onClick={() => setUseExistingPlanSet(false)}
                      className={`px-4 py-1.5 text-xs font-semibold rounded-md transition-all ${!useExistingPlanSet ? 'bg-white text-accent-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                    >
                      New Plan Set
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setUseExistingPlanSet(true);
                        if (project.planSets && project.planSets.length > 0 && !targetPlanSetId) {
                          setTargetPlanSetId(project.planSets[0].id);
                        }
                      }}
                      className={`px-4 py-1.5 text-xs font-semibold rounded-md transition-all ${useExistingPlanSet ? 'bg-white text-accent-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                    >
                      Existing Plan Set
                    </button>
                  </div>

                  {useExistingPlanSet ? (
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1.5">Select Plan Set</label>
                      <select
                        value={targetPlanSetId}
                        onChange={(e) => setTargetPlanSetId(e.target.value)}
                        className="w-full border border-slate-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-white"
                        required
                      >
                        {project.planSets?.map(ps => (
                          <option key={ps.id} value={ps.id}>{ps.name} ({new Date(ps.date).toLocaleDateString()})</option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-1.5">Plan Set Name</label>
                        <input
                          type="text"
                          value={newPlanSetName}
                          onChange={(e) => setNewPlanSetName(e.target.value)}
                          className="w-full border border-slate-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent-500"
                          placeholder="e.g. Revised Floor Plan"
                          required={!useExistingPlanSet}
                          disabled={isAddingPages}
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-1.5">Plan Set Date</label>
                        <input
                          type="date"
                          value={newPlanSetDate}
                          onChange={(e) => setNewPlanSetDate(e.target.value)}
                          className="w-full border border-slate-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent-500"
                          required={!useExistingPlanSet}
                          disabled={isAddingPages}
                        />
                      </div>
                    </div>
                  )}
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">Blueprint PDFs</label>
                    <div 
                      className={`border-2 border-dashed rounded-xl p-6 text-center transition-colors ${
                        newPlanSetFiles.length > 0 ? 'border-accent-300 bg-accent-50' : 'border-slate-300 hover:border-accent-400 bg-slate-50 hover:bg-slate-100 cursor-pointer'
                      }`}
                      onClick={() => !isAddingPages && newPlanSetFiles.length === 0 && fileInputRef.current?.click()}
                    >
                      {newPlanSetFiles.length > 0 ? (
                        <div className="flex flex-col items-center w-full">
                          <div className="w-full space-y-2 mb-3">
                            {newPlanSetFiles.map((file, index) => (
                              <div key={`${file.name}-${index}`} className="flex items-center justify-between bg-white p-2 rounded-lg border border-accent-200 shadow-sm">
                                <div className="flex items-center gap-2 overflow-hidden">
                                  <FileImage size={16} className="text-accent-500 shrink-0" />
                                  <div className="text-left overflow-hidden">
                                    <p className="text-xs font-medium text-slate-900 truncate" title={file.name}>{file.name}</p>
                                  </div>
                                </div>
                                {!isAddingPages && (
                                  <button 
                                    type="button" 
                                    onClick={(e) => { e.stopPropagation(); removeNewPlanSetFile(index); }}
                                    className="p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-md transition-colors shrink-0"
                                    title="Remove file"
                                  >
                                    <Trash2 size={14} />
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                          {!isAddingPages && (
                            <button 
                              type="button" 
                              onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                              className="mt-1 text-sm text-accent-600 hover:text-accent-700 font-medium flex items-center gap-1"
                            >
                              <Plus size={14} /> Add more PDFs
                            </button>
                          )}
                        </div>
                      ) : (
                        <div className="flex flex-col items-center">
                          <Upload size={32} className="text-slate-400 mb-2" />
                          <p className="text-sm font-medium text-slate-900">Click to select PDFs</p>
                        </div>
                      )}
                    </div>
                    <input
                      type="file"
                      ref={fileInputRef}
                      onChange={(e) => {
                        const selectedFiles = Array.from(e.target.files || []);
                        if (selectedFiles.length > 0) {
                          setNewPlanSetFiles(prev => [...prev, ...selectedFiles]);
                          if (!newPlanSetName) {
                            setNewPlanSetName(selectedFiles[0].name.replace('.pdf', ''));
                          }
                        }
                      }}
                      accept="application/pdf"
                      className="hidden"
                      multiple
                      required={newPlanSetFiles.length === 0}
                      disabled={isAddingPages}
                    />
                  </div>
                </div>
                <div className="p-6 border-t border-slate-100 bg-slate-50 flex justify-end gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddPagesModal(false);
                      setIsNamingExistingPages(false);
                      setNewPlanSetName('');
                      setNewPlanSetFiles([]);
                      setUseExistingPlanSet(false);
                      setTargetPlanSetId('');
                    }}
                    disabled={isAddingPages}
                    className="px-5 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-200 rounded-xl transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={(!newPlanSetName && !useExistingPlanSet) || (useExistingPlanSet && !targetPlanSetId) || newPlanSetFiles.length === 0 || isAddingPages}
                    className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-accent-600 hover:bg-accent-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl transition-colors shadow-sm"
                  >
                    {isAddingPages ? (
                      <>
                        <Loader2 size={16} className="animate-spin" />
                        {addProgress.status ? `${addProgress.status} ` : 'Adding '}
                        {addProgress.totalFiles > 1 ? `File ${addProgress.currentFile}/${addProgress.totalFiles} ` : ''}
                        {addProgress.total > 0 ? `(${addProgress.current}/${addProgress.total})` : '...'}
                      </>
                    ) : (
                      'Next Step'
                    )}
                  </button>
                </div>
              </form>
            ) : (
              <PageNamingStep
                pendingPages={pendingPages}
                setPendingPages={setPendingPages}
                pendingThumbnails={pendingThumbnails}
                onConfirm={handleConfirmAddPages}
                isConfirming={isAddingPages}
                confirmLabel={isNamingExistingPages ? 'Save Changes' : 'Add Pages'}
                title="Name Pages"
                subtitle="Review and rename the imported pages."
              />
            )}
          </div>
        </div>
      )}


      <UploadFailuresModal
        open={showUploadFailuresModal}
        failures={uploadFailures}
        totalProcessed={uploadTotals.processed}
        totalExpected={uploadTotals.expected}
        isRetrying={isRetryingUpload}
        retryStatus={retryProgress.status}
        retryCurrent={retryProgress.current}
        retryTotal={retryProgress.total}
        retryFileName={retryProgress.fileName}
        canRetry={uploadFilesByName.size > 0}
        onRetry={handleRetryFailedPages}
        onClose={() => setShowUploadFailuresModal(false)}
      />
    </div>
  );
};
