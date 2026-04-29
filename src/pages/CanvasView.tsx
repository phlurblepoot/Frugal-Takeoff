import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, Link, useLocation, useSearchParams } from 'react-router-dom';
import { Hand, Ruler, Square, Settings, Trash2, Download, ArrowLeft, Layers, Plus, Edit2, Hash, Undo, Redo, ChevronLeft, ChevronRight, ChevronDown, Menu, StickyNote, HelpCircle, Search, BoxSelect, GitMerge, AlignStartVertical, AlignEndVertical } from 'lucide-react';
import { useToast } from '../components/Toast';
import { v4 as uuidv4 } from 'uuid';
import { PdfCanvas } from '../components/PdfCanvas';
import { NewTakeoffModal } from '../components/NewTakeoffModal';
import { Measurement, MeasurementSegment, ScaleConfig, Tool, Project, ProjectPage, MeasurementTakeoff, TakeoffTemplate, CustomCost } from '../types';
import { calculatePolylineLength, calculatePolygonArea, formatMeasurement, calculateRealValue, parseFeetAndInches, calculateSurfaceAreaPx, formatRealValue, convertUnit, evaluateMathExpression, UNIT_LABELS, isPointInPolygon, expandArcPoints } from '../utils/math';
import { getProject, saveProject, getImage, getImageUrl, getTemplates } from '../utils/store';
import { CollaborationProvider, useCollaboration } from '../context/CollaborationContext';
import { useNotes } from '../context/NotesContext';

const STANDARD_SCALES = [
  { label: '1/16" = 1\'-0"', pixelDistance: 144, realWorldDistance: 16, unit: 'ft' },
  { label: '3/32" = 1\'-0"', pixelDistance: 144, realWorldDistance: 32/3, unit: 'ft' },
  { label: '1/8" = 1\'-0"', pixelDistance: 144, realWorldDistance: 8, unit: 'ft' },
  { label: '3/16" = 1\'-0"', pixelDistance: 144, realWorldDistance: 16/3, unit: 'ft' },
  { label: '1/4" = 1\'-0"', pixelDistance: 144, realWorldDistance: 4, unit: 'ft' },
  { label: '3/8" = 1\'-0"', pixelDistance: 144, realWorldDistance: 8/3, unit: 'ft' },
  { label: '1/2" = 1\'-0"', pixelDistance: 144, realWorldDistance: 2, unit: 'ft' },
  { label: '3/4" = 1\'-0"', pixelDistance: 144, realWorldDistance: 4/3, unit: 'ft' },
  { label: '1" = 1\'-0"', pixelDistance: 144, realWorldDistance: 1, unit: 'ft' },
  { label: '1 1/2" = 1\'-0"', pixelDistance: 144, realWorldDistance: 2/3, unit: 'ft' },
  { label: '3" = 1\'-0"', pixelDistance: 144, realWorldDistance: 1/3, unit: 'ft' },
  { label: '1" = 10\'', pixelDistance: 144, realWorldDistance: 10, unit: 'ft' },
  { label: '1" = 20\'', pixelDistance: 144, realWorldDistance: 20, unit: 'ft' },
  { label: '1" = 30\'', pixelDistance: 144, realWorldDistance: 30, unit: 'ft' },
  { label: '1" = 40\'', pixelDistance: 144, realWorldDistance: 40, unit: 'ft' },
  { label: '1" = 50\'', pixelDistance: 144, realWorldDistance: 50, unit: 'ft' },
  { label: '1" = 60\'', pixelDistance: 144, realWorldDistance: 60, unit: 'ft' },
];

const CustomCostRow: React.FC<{
  item: any;
  index: number;
  unitLabel: string;
  onChange: (index: number, updated: any) => void;
  onRemove: (index: number) => void;
}> = ({ item, index, unitLabel, onChange, onRemove }) => {
  const handleMathBlur = (field: string, value: string) => {
    if (value.startsWith('=')) {
      const result = evaluateMathExpression(value);
      if (result !== null) {
        onChange(index, { ...item, [field]: result.toString() });
      }
    }
  };

  return (
    <div className="flex flex-col gap-2 p-3 bg-white rounded-lg border border-slate-200 shadow-sm">
      <div className="flex gap-2 items-center">
        <select
          value={item.type}
          onChange={(e) => onChange(index, { ...item, type: e.target.value as any })}
          className="text-xs border border-slate-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-slate-50"
        >
          <option value="flat">Flat Cost</option>
          <option value="yield">Material Yield</option>
          <option value="unit">Cost per {unitLabel}</option>
          <option value="amount_per_units">Rate per {unitLabel}s</option>
        </select>
        <input
          type="text"
          value={item.name}
          onChange={(e) => onChange(index, { ...item, name: e.target.value })}
          placeholder="Line Name"
          className="flex-1 text-xs border border-slate-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent-500"
        />
        <button
          onClick={() => onRemove(index)}
          className="p-1.5 text-slate-400 hover:text-red-500 transition-colors"
        >
          <Trash2 size={14} />
        </button>
      </div>
      
      <div className="flex gap-2 items-center pl-2 border-l-2 border-accent-100">
        {item.type === 'flat' && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold text-slate-400 uppercase">Cost:</span>
            <div className="relative">
              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-[10px]">$</span>
              <input
                type="text"
                value={item.cost || '0'}
                onChange={(e) => onChange(index, { ...item, cost: e.target.value })}
                onBlur={(e) => handleMathBlur('cost', e.target.value)}
                className="w-24 text-xs border border-slate-300 rounded-lg pl-5 pr-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent-500"
              />
            </div>
          </div>
        )}
        
        {item.type === 'yield' && (
          <>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-slate-400 uppercase">Yield:</span>
              <input
                type="text"
                value={item.yield || '0'}
                onChange={(e) => onChange(index, { ...item, yield: e.target.value })}
                onBlur={(e) => handleMathBlur('yield', e.target.value)}
                className="w-20 text-xs border border-slate-300 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent-500"
              />
              <span className="text-[10px] text-slate-500">{unitLabel} per unit</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-slate-400 uppercase">Unit:</span>
              <input
                type="text"
                value={item.unit || ''}
                onChange={(e) => onChange(index, { ...item, unit: e.target.value })}
                placeholder="e.g. bags"
                className="w-20 text-xs border border-slate-300 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent-500"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-slate-400 uppercase">Cost:</span>
              <div className="relative">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-[10px]">$</span>
                <input
                  type="text"
                  value={item.cost || '0'}
                  onChange={(e) => onChange(index, { ...item, cost: e.target.value })}
                  onBlur={(e) => handleMathBlur('cost', e.target.value)}
                  className="w-24 text-xs border border-slate-300 rounded-lg pl-5 pr-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent-500"
                />
              </div>
            </div>
          </>
        )}

        {item.type === 'unit' && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold text-slate-400 uppercase">Cost per {unitLabel}:</span>
            <div className="relative">
              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-[10px]">$</span>
              <input
                type="text"
                value={item.costPerUnit || '0'}
                onChange={(e) => onChange(index, { ...item, costPerUnit: e.target.value })}
                onBlur={(e) => handleMathBlur('costPerUnit', e.target.value)}
                className="w-24 text-xs border border-slate-300 rounded-lg pl-5 pr-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent-500"
              />
            </div>
          </div>
        )}

        {item.type === 'amount_per_units' && (
          <>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-slate-400 uppercase">Amount:</span>
              <div className="relative">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-[10px]">$</span>
                <input
                  type="text"
                  value={item.amount || '0'}
                  onChange={(e) => onChange(index, { ...item, amount: e.target.value })}
                  onBlur={(e) => handleMathBlur('amount', e.target.value)}
                  className="w-20 text-xs border border-slate-300 rounded-lg pl-5 pr-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent-500"
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-slate-400 uppercase">Per:</span>
              <input
                type="text"
                value={item.perUnits || '0'}
                onChange={(e) => onChange(index, { ...item, perUnits: e.target.value })}
                onBlur={(e) => handleMathBlur('perUnits', e.target.value)}
                className="w-16 text-xs border border-slate-300 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent-500"
              />
              <span className="text-[10px] text-slate-500">{unitLabel}s</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-slate-400 uppercase">Unit:</span>
              <input
                type="text"
                value={item.unit || ''}
                onChange={(e) => onChange(index, { ...item, unit: e.target.value })}
                placeholder="e.g. days"
                className="w-20 text-xs border border-slate-300 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent-500"
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
};

const CanvasViewInner: React.FC = () => {
  const { toast } = useToast();
  const { openNotes } = useNotes();
  const { projectId, pageId } = useParams<{ projectId: string; pageId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const searchTerm = searchParams.get('search') || '';
  
  const { socket, users, globalUsers, followedUserId, setFollowedUserId, sendCursor, sendMeasurementUpdate, sendProjectUpdate, onMeasurementSync, onProjectSync, updateUser, setPageName } = useCollaboration();

  const [project, setProject] = useState<Project | null>(null);
  const [page, setPage] = useState<ProjectPage | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const pageIds = (location.state?.pageIds as string[]) || project?.pages.map(p => p.id) || [];
  const currentPageIndex = pageIds.findIndex(id => id === pageId);
  const prevPageId = currentPageIndex > 0 ? pageIds[currentPageIndex - 1] : null;
  const nextPageId = currentPageIndex !== -1 && currentPageIndex < pageIds.length - 1 ? pageIds[currentPageIndex + 1] : null;

  useEffect(() => {
    if (project && pageId) {
      const currentPage = project.pages.find(p => p.id === pageId);
      if (currentPage) {
        setPageName(currentPage.name);
      }
    }
  }, [project, pageId, setPageName]);
  
  const [currentTool, setCurrentTool] = useState<Tool>('pan');
  const [showScaleModal, setShowScaleModal] = useState(false);
  const [pendingPixelDistance, setPendingPixelDistance] = useState<number>(0);
  const [scaleInput, setScaleInput] = useState('10');
  const [scaleUnit, setScaleUnit] = useState('ft');
  const [calibratingRegionId, setCalibratingRegionId] = useState<string | null>(null);
  
  const [selectedColor, setSelectedColor] = useState('#3b82f6');
  const [selectedTakeoffId, setSelectedTakeoffId] = useState<string | undefined>(undefined);
  const [selectedMeasurementId, setSelectedMeasurementId] = useState<string | null>(null);
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [measurementToDelete, setMeasurementToDelete] = useState<{id: string, targetPageId?: string} | null>(null);

  const [showTakeoffModal, setShowTakeoffModal] = useState(false);
  const [templates, setTemplates] = useState<TakeoffTemplate[]>([]);

  const [editingTakeoff, setEditingTakeoff] = useState<MeasurementTakeoff | null>(null);
  const [takeoffToDelete, setTakeoffToDelete] = useState<MeasurementTakeoff | null>(null);
  const [editTakeoffName, setEditTakeoffName] = useState('');
  const [editTakeoffColor, setEditTakeoffColor] = useState('');
  const [editTakeoffUnit, setEditTakeoffUnit] = useState('');
  const [editTakeoffCostPerUnit, setEditTakeoffCostPerUnit] = useState<string>('');
  const [isEditTakeoffAdvanced, setIsEditTakeoffAdvanced] = useState(false);
  const [editTakeoffCustomCosts, setEditTakeoffCustomCosts] = useState<any[]>([]);

  const [showCurrentPageOnly, setShowCurrentPageOnly] = useState(false);

  type HistoryAction =
    | { type: 'add'; measurement: Measurement }
    | { type: 'delete'; measurement: Measurement }
    | { type: 'update'; measurementId: string; before: Partial<Measurement>; after: Partial<Measurement> };

  const [history, setHistory] = useState<HistoryAction[]>([]);
  const [redoStack, setRedoStack] = useState<HistoryAction[]>([]);
  const [measurementFilter, setMeasurementFilter] = useState('');
  const [showPageJump, setShowPageJump] = useState(false);
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);
  const [resumeMeasurement, setResumeMeasurement] = useState<Measurement | null>(null);
  const [newMeasurementModal, setNewMeasurementModal] = useState<{ takeoffId: string } | null>(null);
  const [newMeasurementName, setNewMeasurementName] = useState('');
  const [newMeasurementType, setNewMeasurementType] = useState<'length' | 'area'>('area');
  const [multiSelectedIds, setMultiSelectedIds] = useState<Set<string>>(new Set());
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);

  // Clear multi-select when switching to a drawing tool
  useEffect(() => {
    if (currentTool === 'length' || currentTool === 'area' || currentTool === 'count' || currentTool === 'scale') {
      setMultiSelectedIds(new Set());
      setIsMultiSelectMode(false);
    }
  }, [currentTool]);
  const [aggregatedMeasurements, setAggregatedMeasurements] = useState<Measurement[]>([]);

  const [heightsModalMeasurementId, setHeightsModalMeasurementId] = useState<string | null>(null);
  const [toolDisabledMessage, setToolDisabledMessage] = useState<string | null>(null);

  const [isLeftSidebarOpen, setIsLeftSidebarOpen] = useState(false);
  const [isRightSidebarOpen, setIsRightSidebarOpen] = useState(window.innerWidth > 1024);
  const [expandedTakeoffs, setExpandedTakeoffs] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth < 1024) {
        // Don't automatically close if user explicitly opened it, 
        // but for initial load or large resizes it's helpful
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const pushToHistory = (action: HistoryAction) => {
    setHistory(prev => [...prev, action].slice(-50));
    setRedoStack([]);
  };

  const applyAction = (action: HistoryAction, direction: 'undo' | 'redo') => {
    if (!page) return;
    if (action.type === 'add') {
      if (direction === 'undo') {
        savePageUpdates({ measurements: page.measurements.filter(m => m.id !== action.measurement.id) });
        if (selectedMeasurementId === action.measurement.id) setSelectedMeasurementId(null);
      } else {
        savePageUpdates({ measurements: [...page.measurements, action.measurement] });
      }
    } else if (action.type === 'delete') {
      if (direction === 'undo') {
        savePageUpdates({ measurements: [...page.measurements, action.measurement] });
      } else {
        savePageUpdates({ measurements: page.measurements.filter(m => m.id !== action.measurement.id) });
      }
    } else if (action.type === 'update') {
      const patch = direction === 'undo' ? action.before : action.after;
      savePageUpdates({ measurements: page.measurements.map(m => m.id === action.measurementId ? { ...m, ...patch } : m) });
    }
  };

  const handleCopy = () => {
    if (!selectedMeasurementId) return;
    const measurement = aggregatedMeasurements.find(m => m.id === selectedMeasurementId);
    if (measurement) {
      localStorage.setItem('copiedMeasurement', JSON.stringify(measurement));
      toast(`Copied "${measurement.name}"`, { type: 'success', duration: 1500 });
    }
  };

  const handlePaste = () => {
    const copiedStr = localStorage.getItem('copiedMeasurement');
    if (!copiedStr || !page) return;
    try {
      const copiedMeasurement = JSON.parse(copiedStr) as Measurement;
      const isMultiRegionValid = page.isMultiRegion && page.scaleRegions && page.scaleRegions.length > 0;
      if (!page.scaleConfig && !isMultiRegionValid) {
        setToolDisabledMessage('Please set the scale before pasting.');
        return;
      }
      const offset = 20;
      const newPoints = copiedMeasurement.points.map(p => ({ x: p.x + offset, y: p.y + offset }));
      let regionId: string | undefined = undefined;
      if (page.isMultiRegion && page.scaleRegions) {
        const region = page.scaleRegions.find(r => isPointInPolygon(newPoints[0], r.points));
        if (region) regionId = region.id;
      }
      const newMeasurement: Measurement = {
        ...copiedMeasurement,
        id: uuidv4(),
        name: `${copiedMeasurement.name} (Copy)`,
        points: newPoints,
        planSetId: page.planSetId,
        regionId,
      };
      pushToHistory({ type: 'add', measurement: newMeasurement });
      savePageUpdates({ measurements: [...page.measurements, newMeasurement] });
      sendMeasurementUpdate(page.id, 'add', newMeasurement);
      setSelectedMeasurementId(newMeasurement.id);
      toast('Measurement pasted', { type: 'success', duration: 1500 });
    } catch (err) {
      console.error('Failed to parse copied measurement', err);
    }
  };

  const handleUndo = () => {
    if (history.length === 0 || !page) return;
    const lastAction = history[history.length - 1];
    setHistory(prev => prev.slice(0, -1));
    setRedoStack(prev => [...prev, lastAction]);
    applyAction(lastAction, 'undo');
    toast('Undone', { type: 'info', duration: 1500 });
  };

  const handleRedo = () => {
    if (redoStack.length === 0 || !page) return;
    const action = redoStack[redoStack.length - 1];
    setRedoStack(prev => prev.slice(0, -1));
    setHistory(prev => [...prev, action]);
    applyAction(action, 'redo');
    toast('Redone', { type: 'info', duration: 1500 });
  };

  const handleMultiSelectToggle = (id: string, type: string) => {
    setMultiSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        return next;
      }
      // Enforce same type — can't mix lengths and areas
      const existing = [...next].map(eid => page?.measurements.find(m => m.id === eid));
      const existingType = existing[0]?.type;
      if (existingType && existingType !== type) return prev;
      next.add(id);
      return next;
    });
  };

  const handleMergeSelected = () => {
    if (!page || multiSelectedIds.size < 2) return;
    const selectedMs = page.measurements.filter(m => multiSelectedIds.has(m.id));
    if (selectedMs.length < 2) return;

    const measurementType = selectedMs[0].type;

    const sidebarM = selectedMeasurementId
      ? page.measurements.find(m => m.id === selectedMeasurementId)
      : null;

    const target = sidebarM && sidebarM.type === measurementType ? sidebarM : selectedMs[0];
    const createNew = !sidebarM || sidebarM.type !== measurementType;

    // Measurements whose segments will be folded into target
    const sources = createNew
      ? selectedMs.filter(m => m.id !== target.id)
      : selectedMs;

    const mergedSegments: MeasurementSegment[] = [
      ...(target.segments ?? []),
      ...sources.flatMap(m => [
        { points: m.points, arcMidIndices: m.arcMidIndices } as MeasurementSegment,
        ...(m.segments ?? []),
      ]),
    ];

    updateMeasurement(
      target.id,
      {
        segments: mergedSegments.length > 0 ? mergedSegments : undefined,
        ...(createNew ? { name: `Merged ${measurementType === 'length' ? 'Length' : 'Area'}` } : {}),
      },
    );

    // Delete source measurements (keep target)
    for (const m of sources.filter(m => m.id !== target.id)) {
      deleteMeasurement(m.id);
    }

    setMultiSelectedIds(new Set());
    setIsMultiSelectMode(false);
    setSelectedMeasurementId(target.id);
  };

  useEffect(() => {
    if (projectId && pageId) {
      loadData(projectId, pageId);
    }
    loadTemplates();
  }, [projectId, pageId]);

  useEffect(() => {
    const unsubscribeMeasurement = onMeasurementSync(({ action, measurement }) => {
      setPage(prev => {
        if (!prev) return prev;
        let newMeasurements = [...prev.measurements];
        if (action === 'add') {
          // Prevent duplicates
          if (!newMeasurements.find(m => m.id === measurement.id)) {
            newMeasurements.push(measurement);
          }
        } else if (action === 'update') {
          newMeasurements = newMeasurements.map(m => m.id === measurement.id ? measurement : m);
        } else if (action === 'delete') {
          newMeasurements = newMeasurements.filter(m => m.id !== measurement.id);
        }
        return { ...prev, measurements: newMeasurements };
      });
      
      setProject(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          pages: prev.pages.map(p => {
            if (p.id !== pageId) return p;
            let newMeasurements = [...p.measurements];
            if (action === 'add') {
              if (!newMeasurements.find(m => m.id === measurement.id)) {
                newMeasurements.push(measurement);
              }
            } else if (action === 'update') {
              newMeasurements = newMeasurements.map(m => m.id === measurement.id ? measurement : m);
            } else if (action === 'delete') {
              newMeasurements = newMeasurements.filter(m => m.id !== measurement.id);
            }
            return { ...p, measurements: newMeasurements };
          })
        };
      });
    });

    const unsubscribeProject = onProjectSync(({ projectId: syncProjectId }) => {
      if (syncProjectId === projectId) {
        loadData(syncProjectId, pageId!);
      }
    });

    return () => {
      unsubscribeMeasurement();
      unsubscribeProject();
    };
  }, [projectId, pageId, onMeasurementSync, onProjectSync]);

  const loadTemplates = async () => {
    const data = await getTemplates();
    setTemplates(data);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept if user is typing in an input or textarea
      if (
        document.activeElement?.tagName === 'INPUT' ||
        document.activeElement?.tagName === 'TEXTAREA' ||
        document.activeElement?.tagName === 'SELECT'
      ) {
        return;
      }

      // Escape: close modals / deselect (priority order)
      if (e.key === 'Escape') {
        if (showShortcutsHelp) { setShowShortcutsHelp(false); return; }
        if (showScaleModal) { setShowScaleModal(false); return; }
        if (newMeasurementModal) { setNewMeasurementModal(null); return; }
        if (showDeleteConfirm) { setShowDeleteConfirm(false); setMeasurementToDelete(null); return; }
        if (showTakeoffModal) { setShowTakeoffModal(false); return; }
        if (heightsModalMeasurementId) { setHeightsModalMeasurementId(null); return; }
        if (editingTakeoff) { setEditingTakeoff(null); return; }
        if (toolDisabledMessage) { setToolDisabledMessage(null); return; }
        if (takeoffToDelete) { setTakeoffToDelete(null); return; }
        if (showPageJump) { setShowPageJump(false); return; }
        if (selectedMeasurementId) { setSelectedMeasurementId(null); return; }
        return;
      }

      // ? — keyboard shortcut help
      if (e.key === '?') {
        setShowShortcutsHelp(prev => !prev);
        return;
      }

      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedMeasurementId) {
        deleteMeasurement(selectedMeasurementId);
      }

      if ((e.key === 'p' || e.key === 'P') && selectedMeasurementId) {
        const measurement = aggregatedMeasurements.find(m => m.id === selectedMeasurementId);
        if (measurement && (measurement.type === 'length' || measurement.type === 'area')) {
          setResumeMeasurement(measurement);
          setCurrentTool(measurement.type);
          setSelectedMeasurementId(null);
        }
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 'c' && selectedMeasurementId) {
        handleCopy();
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        handlePaste();
      }

      // Redo must be checked before Undo (Shift+Z vs Z)
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'z') {
        e.preventDefault();
        handleRedo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault();
        handleRedo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        handleUndo();
      }

      // Arrow key page navigation
      if (e.key === 'ArrowLeft' && prevPageId && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        navigate(`/project/${project.id}/page/${prevPageId}`, { state: { pageIds } });
      }
      if (e.key === 'ArrowRight' && nextPageId && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        navigate(`/project/${project.id}/page/${nextPageId}`, { state: { pageIds } });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedMeasurementId, page, project, history, redoStack, aggregatedMeasurements,
      showShortcutsHelp, showScaleModal, showDeleteConfirm, showTakeoffModal,
      heightsModalMeasurementId, editingTakeoff, toolDisabledMessage, takeoffToDelete,
      showPageJump, prevPageId, nextPageId, pageIds, newMeasurementModal]);

  const loadData = async (pId: string, pgId: string) => {
    setIsLoading(true);
    const proj = await getProject(pId);
    if (!proj) {
      navigate('/');
      return;
    }
    
    const pg = proj.pages.find(p => p.id === pgId);
    if (!pg) {
      navigate(`/project/${pId}`);
      return;
    }
    
    const imgUrl = getImageUrl(pg.imageId);
    
    setProject(proj);
    setPage(pg);
    setImageUrl(imgUrl);
    setSelectedMeasurementId(null);
    setHistory([]);
    
    // Set default takeoff if available
    if (proj.takeoffs.length > 0) {
      const firstTakeoff = proj.takeoffs[0];
      setSelectedTakeoffId(firstTakeoff.id);
      setSelectedColor(firstTakeoff.color);
    }
    
    setIsLoading(false);
  };

  const savePageUpdates = async (updates: Partial<ProjectPage>) => {
    if (!project || !page) return;
    
    const updatedPage = { ...page, ...updates };
    const updatedProject = {
      ...project,
      pages: project.pages.map(p => p.id === page.id ? updatedPage : p)
    };
    
    setPage(updatedPage);
    setProject(updatedProject);
    await saveProject(updatedProject);
  };

  const handleSetScale = (pixelDistance: number) => {
    setPendingPixelDistance(pixelDistance);
    setShowScaleModal(true);
    setCurrentTool('pan');
  };

  const confirmScale = () => {
    let realWorldDistance = 0;

    if (scaleUnit === 'ft' || scaleUnit === 'in') {
      const parsedFeet = parseFeetAndInches(scaleInput, scaleUnit);
      if (parsedFeet !== null) {
        realWorldDistance = scaleUnit === 'in' ? parsedFeet * 12 : parsedFeet;
      }
    } else {
      realWorldDistance = parseFloat(scaleInput);
    }

    if (!isNaN(realWorldDistance) && realWorldDistance > 0) {
      const newScaleConfig = {
        pixelDistance: pendingPixelDistance,
        realWorldDistance,
        unit: scaleUnit,
        label: 'custom',
      };

      if (calibratingRegionId) {
        savePageUpdates({
          scaleRegions: page?.scaleRegions?.map(r => 
            r.id === calibratingRegionId ? { ...r, scaleConfig: newScaleConfig } : r
          )
        });
        setCalibratingRegionId(null);
      } else {
        savePageUpdates({
          scaleConfig: newScaleConfig
        });
      }
      setShowScaleModal(false);
    } else {
      toast('Please enter a valid distance.', { type: 'warning' });
    }
  };

  const handleStandardScaleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    if (val === 'custom' || val === '') {
      return;
    }
    const scale = STANDARD_SCALES.find(s => s.label === val);
    if (scale) {
      savePageUpdates({
        scaleConfig: {
          pixelDistance: scale.pixelDistance,
          realWorldDistance: scale.realWorldDistance,
          unit: scale.unit,
          label: scale.label,
        }
      });
    }
  };

  const pageKey = page?.pageNumber || page?.name;
  const pageVersions = project?.pages.filter(p => (p.pageNumber || p.name) === pageKey) || [];

  useEffect(() => {
    if (!project || !page) return;
    
    const allMeasurements: Measurement[] = [];
    pageVersions.forEach(pv => {
      pv.measurements.forEach(m => {
        allMeasurements.push(m);
      });
    });
    
    setAggregatedMeasurements(allMeasurements);
  }, [project, page]);

  const addMeasurement = (measurement: Measurement) => {
    if (!page) return;
    
    // Apply current takeoff and color
    const newMeasurement = {
      ...measurement,
      takeoffId: selectedTakeoffId,
      color: selectedColor,
      planSetId: page.planSetId,
    };
    
    pushToHistory({ type: 'add', measurement: newMeasurement });

    savePageUpdates({
      measurements: [...page.measurements, newMeasurement]
    });
    
    sendMeasurementUpdate(page.id, 'add', newMeasurement);

    const takeoff = project?.takeoffs.find(t => t.id === selectedTakeoffId);
    if (takeoff?.type === 'area' && measurement.type === 'length') {
      setHeightsModalMeasurementId(newMeasurement.id);
    }
  };

  const openNewMeasurementModal = (takeoffId: string) => {
    const takeoff = project?.takeoffs.find(t => t.id === takeoffId);
    if (!takeoff) return;
    // For length-typed takeoffs, only line-type measurements are valid.
    setNewMeasurementType(takeoff.type === 'length' ? 'length' : 'area');
    setNewMeasurementName('');
    setNewMeasurementModal({ takeoffId });
  };

  const confirmNewMeasurement = async () => {
    if (!project || !page || !newMeasurementModal) return;
    const trimmed = newMeasurementName.trim();
    if (!trimmed) {
      toast('Please enter a name', { type: 'warning' });
      return;
    }
    const takeoff = project.takeoffs.find(t => t.id === newMeasurementModal.takeoffId);
    if (!takeoff) return;

    const newId = uuidv4();
    const newMeasurement: Measurement = {
      id: newId,
      type: newMeasurementType,
      points: [],
      color: takeoff.color,
      name: trimmed,
      takeoffId: takeoff.id,
      planSetId: page.planSetId,
    };

    pushToHistory({ type: 'add', measurement: newMeasurement });
    await savePageUpdates({ measurements: [...page.measurements, newMeasurement] });
    sendMeasurementUpdate(page.id, 'add', newMeasurement);

    setSelectedTakeoffId(takeoff.id);
    setSelectedColor(takeoff.color);
    setSelectedMeasurementId(newId);
    setCurrentTool(newMeasurementType);
    setNewMeasurementModal(null);
  };

  const updateMeasurement = (id: string, updates: Partial<Measurement>, targetPageId?: string) => {
    if (!project || !page) return;
    
    let sourcePageId = targetPageId;
    let existingMeasurement: Measurement | undefined;
    
    if (!sourcePageId) {
      // Find which page has this measurement
      for (const p of project.pages) {
        const m = p.measurements.find(m => m.id === id);
        if (m) {
          sourcePageId = p.id;
          existingMeasurement = m;
          break;
        }
      }
    } else {
      existingMeasurement = project.pages.find(p => p.id === sourcePageId)?.measurements.find(m => m.id === id);
    }
    
    if (!sourcePageId || !existingMeasurement) return;

    const destinationPageId = page.id;
    const isMoving = sourcePageId !== destinationPageId;

    if (!isMoving) {
      const before: Partial<Measurement> = {};
      for (const key of Object.keys(updates) as (keyof Measurement)[]) {
        (before as any)[key] = (existingMeasurement as any)[key];
      }
      pushToHistory({ type: 'update', measurementId: id, before, after: updates });
    }

    const updatedMeasurement = { ...existingMeasurement, ...updates, planSetId: page.planSetId };

    const updatedProject = {
      ...project,
      pages: project.pages.map(p => {
        if (p.id === sourcePageId && isMoving) {
          return { ...p, measurements: p.measurements.filter(m => m.id !== id) };
        }
        if (p.id === destinationPageId && isMoving) {
          return { ...p, measurements: [...p.measurements, updatedMeasurement] };
        }
        if (p.id === sourcePageId && !isMoving) {
          return { ...p, measurements: p.measurements.map(m => m.id === id ? updatedMeasurement : m) };
        }
        return p;
      })
    };
    
    setProject(updatedProject);
    saveProject(updatedProject);
    setPage(updatedProject.pages.find(p => p.id === page.id) || page);
    
    if (isMoving) {
      sendMeasurementUpdate(sourcePageId, 'delete', existingMeasurement);
      sendMeasurementUpdate(destinationPageId, 'add', updatedMeasurement);
    } else {
      sendMeasurementUpdate(destinationPageId, 'update', updatedMeasurement);
    }
  };

  const deleteMeasurement = (id: string, targetPageId?: string) => {
    setMeasurementToDelete({ id, targetPageId });
    setShowDeleteConfirm(true);
  };

  const confirmDeleteMeasurement = async () => {
    if (!project || !measurementToDelete || !page) return;
    const { id, targetPageId } = measurementToDelete;
    
    let sourcePageId = targetPageId;
    let mToDelete: Measurement | undefined;
    
    if (!sourcePageId) {
      for (const p of project.pages) {
        const m = p.measurements.find(m => m.id === id);
        if (m) {
          sourcePageId = p.id;
          mToDelete = m;
          break;
        }
      }
    } else {
      mToDelete = project.pages.find(p => p.id === sourcePageId)?.measurements.find(m => m.id === id);
    }

    if (!sourcePageId || !mToDelete) return;

    pushToHistory({ type: 'delete', measurement: mToDelete });

    const updatedProject = {
      ...project,
      pages: project.pages.map(p => 
        p.id === sourcePageId 
          ? { ...p, measurements: p.measurements.filter(m => m.id !== id) }
          : p
      )
    };
    
    setProject(updatedProject);
    saveProject(updatedProject);
    setPage(updatedProject.pages.find(p => p.id === page.id) || page);

    if (selectedMeasurementId === id) {
      setSelectedMeasurementId(null);
    }

    setShowDeleteConfirm(false);
    setMeasurementToDelete(null);
    
    sendMeasurementUpdate(sourcePageId, 'delete', mToDelete);
  };

  const confirmDeleteTakeoff = async () => {
    if (!project || !takeoffToDelete) return;

    const updatedProject = {
      ...project,
      takeoffs: project.takeoffs.filter(t => t.id !== takeoffToDelete.id),
      pages: project.pages.map(p => ({
        ...p,
        measurements: p.measurements.filter(m => m.takeoffId !== takeoffToDelete.id)
      }))
    };

    await saveProject(updatedProject);
    setProject(updatedProject);
    
    if (page) {
      setPage(updatedProject.pages.find(p => p.id === page.id) || page);
    }

    if (selectedTakeoffId === takeoffToDelete.id) {
      setSelectedTakeoffId(null);
    }

    setTakeoffToDelete(null);
  };

  const handleEditTakeoff = (takeoff: MeasurementTakeoff) => {
    const rawTakeoff = project?.takeoffs.find(t => t.id === takeoff.id) || takeoff;
    setEditingTakeoff(rawTakeoff);
    setEditTakeoffName(rawTakeoff.name);
    setEditTakeoffColor(rawTakeoff.color);
    setEditTakeoffUnit(rawTakeoff.unit || '');
    setEditTakeoffCostPerUnit(rawTakeoff.costPerUnit?.toString() || '');
    setIsEditTakeoffAdvanced(rawTakeoff.isAdvancedCost || false);
    setEditTakeoffCustomCosts(rawTakeoff.customCosts?.map(c => ({
      ...c,
      cost: c.cost?.toString() || '0',
      yield: c.yield?.toString() || '0',
      costPerUnit: c.costPerUnit?.toString() || '0',
      amount: c.amount?.toString() || '0',
      perUnits: c.perUnits?.toString() || '0',
    })) || []);
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
              costPerUnit: !isEditTakeoffAdvanced && editTakeoffCostPerUnit !== '' ? (evaluateMathExpression(editTakeoffCostPerUnit) ?? 0) : undefined,
              isAdvancedCost: isEditTakeoffAdvanced,
              customCosts: isEditTakeoffAdvanced ? editTakeoffCustomCosts.map(c => ({
                ...c,
                cost: evaluateMathExpression(c.cost?.toString() || '') ?? 0,
                yield: evaluateMathExpression(c.yield?.toString() || '') ?? 0,
                costPerUnit: evaluateMathExpression(c.costPerUnit?.toString() || '') ?? 0,
                amount: evaluateMathExpression(c.amount?.toString() || '') ?? 0,
                perUnits: evaluateMathExpression(c.perUnits?.toString() || '') ?? 0,
              })) : undefined,
            } 
          : g
      ),
      pages: project.pages.map(p => ({
        ...p,
        measurements: p.measurements.map(m => 
          m.takeoffId === editingTakeoff.id 
            ? { ...m, color: editTakeoffColor }
            : m
        )
      }))
    };

    await saveProject(updatedProject);
    setProject(updatedProject);
    
    // Update local page state
    if (page) {
      setPage(updatedProject.pages.find(p => p.id === page.id) || page);
    }

    // Update selected color if editing the active takeoff
    if (selectedTakeoffId === editingTakeoff.id) {
      setSelectedColor(editTakeoffColor);
    }

    setEditingTakeoff(null);
  };

  if (isLoading || !project || !page || !imageUrl) {
    return (
      <div className="flex h-screen w-full bg-slate-50 items-center justify-center">
        <div className="w-8 h-8 border-4 border-accent-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // Calculate takeoff totals
  const takeoffTotals = project.takeoffs.map(takeoff => {
    let totalRealValue = 0;
    let measurementsCount = 0;

    const pagesToProcess = showCurrentPageOnly ? pageVersions : project.pages;

    pagesToProcess.forEach(p => {
      const takeoffMeasurements = p.measurements.filter(m => m.takeoffId === takeoff.id);
      measurementsCount += takeoffMeasurements.length;
      
      takeoffMeasurements.forEach(m => {
        // Determine which scale to use
        let currentScale = p.scaleConfig;
        if (p.isMultiRegion && m.regionId) {
          const region = p.scaleRegions?.find(r => r.id === m.regionId);
          if (region?.scaleConfig) {
            currentScale = region.scaleConfig;
          }
        }

        const allMPts = [
          expandArcPoints(m.points, m.arcMidIndices),
          ...(m.segments ?? []).map(s => expandArcPoints(s.points, s.arcMidIndices)),
        ];
        let pixelValue = 0;
        if (takeoff.type === 'length' && m.type === 'length') {
          pixelValue = allMPts.reduce((sum, pts) => sum + calculatePolylineLength(pts), 0);
        } else if (takeoff.type === 'area' && m.type === 'area') {
          pixelValue = allMPts.reduce((sum, pts) => sum + calculatePolygonArea(pts), 0);
        } else if (takeoff.type === 'area' && m.type === 'length') {
          pixelValue = allMPts.reduce((sum, pts) =>
            sum + calculateSurfaceAreaPx(pts, m.heights || [], m.isTwoSided || false, currentScale), 0);
        } else if (takeoff.type === 'count' && m.type === 'count') {
          pixelValue = 1;
        }

        if (pixelValue > 0) {
          const realValue = calculateRealValue(pixelValue, takeoff.type as 'length' | 'area' | 'count', currentScale);
          // Convert to the current page's unit so we have a consistent base unit for formatRealValue
          const targetUnit = page.scaleConfig?.unit || 'ft';
          const sourceUnit = currentScale?.unit || 'ft';

          if (takeoff.type === 'count') {
            totalRealValue += realValue;
          } else {
            totalRealValue += convertUnit(realValue, sourceUnit, targetUnit, takeoff.type as 'length' | 'area' | 'count');
          }
        }
      });
    });
    
    return {
      ...takeoff,
      totalRealValue,
      measurementsCount
    };
  });

  const activeTakeoff = project.takeoffs.find(t => t.id === selectedTakeoffId);
  const selectedMeasurement = selectedMeasurementId
    ? project.pages.flatMap(p => p.measurements).find(m => m.id === selectedMeasurementId) || null
    : null;
  // Lock the drawing tool to the selected measurement's type so subsequent
  // segments cannot mix lines and areas inside one measurement.
  const lockedMeasurementType: 'length' | 'area' | null =
    selectedMeasurement && (selectedMeasurement.type === 'length' || selectedMeasurement.type === 'area')
      ? selectedMeasurement.type
      : null;

  return (
    <div className="flex h-screen w-full bg-slate-50 dark:bg-slate-900 overflow-hidden font-sans relative">
      {/* Left Sidebar Wrapper */}
      {isLeftSidebarOpen && (
        <div 
          className="fixed inset-0 bg-slate-900/20 backdrop-blur-[1px] z-40 md:hidden"
          onClick={() => setIsLeftSidebarOpen(false)}
        />
      )}
      <div className={`fixed inset-0 z-50 md:relative md:inset-auto md:z-20 flex h-full transition-all duration-300 ${isLeftSidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}>
        <div className={`bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 flex flex-col shadow-2xl md:shadow-none transition-all duration-300 overflow-hidden ${isLeftSidebarOpen ? 'w-full md:w-80' : 'w-0'}`}>
          <div className="w-full md:w-80 flex flex-col h-full overflow-y-auto overflow-x-hidden">
            <div className="p-4 border-b border-slate-200 dark:border-slate-700 shrink-0">
              <div className="flex items-center justify-between mb-4">
                <Link to={`/project/${project.id}`} className="inline-flex items-center gap-2 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 transition-colors font-medium text-sm">
                  <ArrowLeft size={16} />
                  <span className="md:inline">Back to Project</span>
                </Link>
                
                <div className="flex items-center gap-2">
                  <button 
                    onClick={() => setIsLeftSidebarOpen(false)}
                    className="md:hidden p-2 text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg"
                  >
                    <ChevronLeft size={20} />
                  </button>
                  <div className="flex items-center bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-sm overflow-hidden">
                <Link
                  to={prevPageId ? `/project/${project.id}/page/${prevPageId}` : '#'}
                  state={{ pageIds }}
                  className={`p-1.5 flex items-center justify-center transition-colors ${prevPageId ? 'text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 hover:text-slate-900 dark:hover:text-white' : 'text-slate-300 dark:text-slate-600 cursor-not-allowed'}`}
                  title="Previous Page"
                  onClick={(e) => !prevPageId && e.preventDefault()}
                >
                  <ChevronLeft size={16} />
                </Link>
                <div className="w-px h-4 bg-slate-200 dark:bg-slate-700" />
                <Link
                  to={nextPageId ? `/project/${project.id}/page/${nextPageId}` : '#'}
                  state={{ pageIds }}
                  className={`p-1.5 flex items-center justify-center transition-colors ${nextPageId ? 'text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 hover:text-slate-900 dark:hover:text-white' : 'text-slate-300 dark:text-slate-600 cursor-not-allowed'}`}
                  title="Next Page"
                  onClick={(e) => !nextPageId && e.preventDefault()}
                >
                  <ChevronRight size={16} />
                </Link>
              </div>
              <div className="relative">
                <button
                  onClick={() => setShowPageJump(prev => !prev)}
                  className="bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-2 py-1 shadow-sm flex items-center text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                  title="Jump to page"
                >
                  {currentPageIndex + 1} / {pageIds.length}
                </button>
                {showPageJump && (
                  <div className="absolute top-full left-0 mt-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg z-50 min-w-[160px] max-h-64 overflow-y-auto">
                    {pageIds.map((pid, idx) => {
                      const pg = project.pages.find(p => p.id === pid);
                      return (
                        <Link
                          key={pid}
                          to={`/project/${project.id}/page/${pid}`}
                          state={{ pageIds }}
                          onClick={() => setShowPageJump(false)}
                          className={`flex items-center gap-2 px-3 py-2 text-xs hover:bg-accent-50 dark:hover:bg-accent-900/20 transition-colors ${pid === pageId ? 'bg-accent-50 dark:bg-accent-900/20 text-accent-700 dark:text-accent-400 font-semibold' : 'text-slate-700 dark:text-slate-300'}`}
                        >
                          <span className="text-slate-400 dark:text-slate-500 w-5 shrink-0">{idx + 1}.</span>
                          <span className="truncate">{pg?.name || `Page ${idx + 1}`}</span>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
          <h1 className="text-xl font-semibold text-slate-800 dark:text-white flex items-center gap-2 line-clamp-1">
            {page.name}
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 line-clamp-1">{project.name}</p>
        </div>

        <div className="p-4 border-b border-slate-200 dark:border-slate-700">
          <h2 className="text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-3">Tools</h2>
          <div className="flex items-center gap-2 mb-4">
            <ToolButton
              active={currentTool === 'pan'}
              onClick={() => setCurrentTool('pan')}
              icon={<Hand size={18} />}
              label="Pan"
            />
            <ToolButton
              active={currentTool === 'scale'}
              onClick={() => setCurrentTool('scale')}
              icon={<Settings size={18} />}
              label="Set Scale"
            />
            <ToolButton
              active={currentTool === 'length'}
              onClick={() => setCurrentTool('length')}
              icon={<Ruler size={18} />}
              label="Length"
              disabled={!page.scaleConfig || activeTakeoff?.type === 'count' || lockedMeasurementType === 'area'}
              onDisabledClick={() => {
                if (!page.scaleConfig) setToolDisabledMessage("Please set the scale first to enable measurement tools.");
                else if (activeTakeoff?.type === 'count') setToolDisabledMessage("Length tools are disabled for count takeoffs.");
                else if (lockedMeasurementType === 'area') setToolDisabledMessage("This measurement is an area — deselect it to start a line.");
              }}
            />
            <ToolButton
              active={currentTool === 'area'}
              onClick={() => setCurrentTool('area')}
              icon={<Square size={18} />}
              label="Area"
              disabled={!page.scaleConfig || activeTakeoff?.type === 'length' || activeTakeoff?.type === 'count' || lockedMeasurementType === 'length'}
              onDisabledClick={() => {
                if (!page.scaleConfig) setToolDisabledMessage("Please set the scale first to enable measurement tools.");
                else if (activeTakeoff?.type === 'length') setToolDisabledMessage("Area tools are disabled for linear takeoffs.");
                else if (activeTakeoff?.type === 'count') setToolDisabledMessage("Area tools are disabled for count takeoffs.");
                else if (lockedMeasurementType === 'length') setToolDisabledMessage("This measurement is a line — deselect it to start an area.");
              }}
            />
            <ToolButton
              active={currentTool === 'count'}
              onClick={() => setCurrentTool('count')}
              icon={<Hash size={18} />}
              label="Count"
              disabled={!page.scaleConfig || activeTakeoff?.type === 'length' || activeTakeoff?.type === 'area' || lockedMeasurementType !== null}
              onDisabledClick={() => {
                if (!page.scaleConfig) setToolDisabledMessage("Please set the scale first to enable measurement tools.");
                else if (activeTakeoff?.type === 'length') setToolDisabledMessage("Count tools are disabled for linear takeoffs.");
                else if (activeTakeoff?.type === 'area') setToolDisabledMessage("Count tools are disabled for area takeoffs.");
                else if (lockedMeasurementType !== null) setToolDisabledMessage("Deselect the current measurement to use the count tool.");
              }}
            />
            <div className="h-8 w-px bg-slate-200 dark:bg-slate-700 mx-1" />
            <button
              onClick={() => projectId && openNotes(projectId)}
              className="flex items-center justify-center p-2 md:p-2.5 rounded-lg border transition-all active:scale-95 bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 hover:border-slate-300"
              title="Project Notes"
            >
              <StickyNote size={18} />
            </button>
            <div className="h-8 w-px bg-slate-200 dark:bg-slate-700 mx-1" />
            <ToolButton
              active={currentTool === 'region'}
              onClick={() => setCurrentTool('region')}
              icon={<Layers size={18} />}
              label="Region"
              disabled={!page.isMultiRegion}
              onDisabledClick={() => setToolDisabledMessage("Enable 'Multi-Region Scaling' to use this tool.")}
            />
            <div className="h-8 w-px bg-slate-200 dark:bg-slate-700 mx-1" />
            <button
              onClick={handleUndo}
              disabled={history.length === 0}
              className={`p-2 rounded-lg transition-colors ${
                history.length === 0
                  ? 'text-slate-300 dark:text-slate-600 cursor-not-allowed'
                  : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 hover:text-accent-600'
              }`}
              title="Undo (Ctrl+Z)"
            >
              <Undo size={18} />
            </button>
            <button
              onClick={handleRedo}
              disabled={redoStack.length === 0}
              className={`p-2 rounded-lg transition-colors ${
                redoStack.length === 0
                  ? 'text-slate-300 cursor-not-allowed'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-accent-600'
              }`}
              title="Redo (Ctrl+Shift+Z)"
            >
              <Redo size={18} />
            </button>
            <button
              onClick={() => setShowShortcutsHelp(true)}
              className="p-2 rounded-lg transition-colors text-slate-400 hover:bg-slate-100 hover:text-accent-600"
              title="Keyboard Shortcuts (?)"
            >
              <HelpCircle size={18} />
            </button>
          </div>

          <div className="mt-4 pt-4 border-t border-slate-100 space-y-4">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-slate-700">Multi-Region Scaling</label>
              <input 
                type="checkbox"
                checked={page.isMultiRegion || false}
                onChange={async (e) => {
                  const updatedProject = {
                    ...project,
                    pages: project.pages.map(p => 
                      p.id === page.id ? { ...p, isMultiRegion: e.target.checked } : p
                    )
                  };
                  await saveProject(updatedProject);
                  setProject(updatedProject);
                  setPage(updatedProject.pages.find(p => p.id === page.id) || page);
                }}
                className="rounded border-slate-300 text-accent-600 focus:ring-accent-500"
              />
            </div>

            {/* Legend */}
            {(() => {
              const effectiveLegendOn = page.showLegend ?? (project?.legendOnAllPages ?? false);
              const legendFontSize = page.legendFontSize || 24;
              const legendWidth = page.legendWidth || 500;

              const setLegendPosition = (pos: { x: number; y: number }) =>
                savePageUpdates({ legendPosition: pos });

              const applyLegendToAllPages = async () => {
                if (!project) return;
                const updatedProject = {
                  ...project,
                  pages: project.pages.map(p => ({
                    ...p,
                    showLegend: true,
                    showLegendTotals: page.showLegendTotals !== false,
                    legendFontSize: legendFontSize,
                    legendWidth: legendWidth,
                  })),
                };
                setProject(updatedProject);
                await saveProject(updatedProject);
              };

              const toggleProjectDefault = async (on: boolean) => {
                if (!project) return;
                const updatedProject = { ...project, legendOnAllPages: on };
                setProject(updatedProject);
                await saveProject(updatedProject);
              };

              return (
                <>
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-slate-700">Show Legend</label>
                    <input
                      type="checkbox"
                      checked={effectiveLegendOn}
                      onChange={(e) => savePageUpdates({ showLegend: e.target.checked })}
                      className="rounded border-slate-300 text-accent-600 focus:ring-accent-500"
                    />
                  </div>

                  {effectiveLegendOn && (
                    <div className="pl-3 border-l-2 border-slate-200 space-y-3">
                      <div className="flex items-center justify-between">
                        <label className="text-xs font-medium text-slate-600">Show Totals</label>
                        <input
                          type="checkbox"
                          checked={page.showLegendTotals !== false}
                          onChange={(e) => savePageUpdates({ showLegendTotals: e.target.checked })}
                          className="rounded border-slate-300 text-accent-600 focus:ring-accent-500"
                        />
                      </div>

                      <div className="flex flex-col gap-1.5">
                        <label className="text-xs font-medium text-slate-600">Text Size</label>
                        <div className="flex items-center gap-2">
                          <input
                            type="range"
                            min="8"
                            max="72"
                            step="1"
                            value={legendFontSize}
                            onChange={(e) => savePageUpdates({ legendFontSize: parseInt(e.target.value) })}
                            className="flex-1 h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                          />
                          <span className="text-[10px] font-bold text-slate-500 w-6">{legendFontSize}</span>
                        </div>
                      </div>

                      {/* Position presets */}
                      <div>
                        <label className="text-xs font-medium text-slate-600 block mb-1.5">Snap to corner</label>
                        <div className="grid grid-cols-2 gap-1">
                          {[
                            { label: 'Top-left',     x: 20, y: 20 },
                            { label: 'Top-right',    x: (page.imageWidth  - legendWidth - 20), y: 20 },
                            { label: 'Bottom-left',  x: 20,                                    y: Math.max(20, page.imageHeight - 600) },
                            { label: 'Bottom-right', x: (page.imageWidth  - legendWidth - 20), y: Math.max(20, page.imageHeight - 600) },
                          ].map(({ label, x, y }) => (
                            <button
                              key={label}
                              onClick={() => setLegendPosition({ x, y })}
                              title={label}
                              className="text-[10px] text-slate-600 bg-slate-100 hover:bg-slate-200 rounded px-1.5 py-1 transition-colors text-left"
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                        <p className="text-[10px] text-slate-400 mt-1">Switch to Pan tool to drag or scroll-resize</p>
                      </div>

                      {/* Apply to all pages */}
                      {project && project.pages.length > 1 && (
                        <button
                          onClick={applyLegendToAllPages}
                          className="w-full text-xs text-accent-600 border border-accent-300 hover:bg-accent-50 rounded-lg px-2 py-1.5 transition-colors font-medium"
                        >
                          Apply legend settings to all pages
                        </button>
                      )}
                    </div>
                  )}

                  {/* Project-level default */}
                  <div className="flex items-center justify-between pt-1">
                    <label className="text-xs font-medium text-slate-600 leading-tight">
                      Enable on all pages<br />
                      <span className="text-[10px] font-normal text-slate-400">by default</span>
                    </label>
                    <input
                      type="checkbox"
                      checked={project?.legendOnAllPages ?? false}
                      onChange={(e) => toggleProjectDefault(e.target.checked)}
                      className="rounded border-slate-300 text-accent-600 focus:ring-accent-500"
                    />
                  </div>
                </>
              );
            })()}

            {!page.isMultiRegion && (
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">Page Scale</label>
                <select
                  value={page.scaleConfig?.label || (page.scaleConfig ? 'custom' : '')}
                  onChange={handleStandardScaleChange}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500 bg-white"
                >
                  <option value="" disabled>Select a scale...</option>
                  <option value="custom">Custom (Calibrated)</option>
                  <optgroup label="Architectural">
                    {STANDARD_SCALES.slice(0, 11).map(s => (
                      <option key={s.label} value={s.label}>{s.label}</option>
                    ))}
                  </optgroup>
                  <optgroup label="Engineering">
                    {STANDARD_SCALES.slice(11).map(s => (
                      <option key={s.label} value={s.label}>{s.label}</option>
                    ))}
                  </optgroup>
                </select>
              </div>
            )}
          </div>

          {page.isMultiRegion && page.scaleRegions && page.scaleRegions.length > 0 && (
            <div className="mt-4 pt-4 border-t border-slate-100">
              <label className="block text-xs font-medium text-slate-700 mb-2 uppercase tracking-wider">Regions</label>
              <div className="space-y-2">
                {page.scaleRegions.map(region => (
                  <div 
                    key={region.id} 
                    className={`border rounded-lg p-2 transition-colors cursor-pointer ${selectedRegionId === region.id ? 'bg-accent-50 border-accent-300' : 'bg-slate-50 border-slate-200 hover:bg-slate-100'}`}
                    onClick={() => setSelectedRegionId(region.id === selectedRegionId ? null : region.id)}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <input 
                        type="text"
                        value={region.name}
                        onClick={(e) => e.stopPropagation()}
                        onChange={async (e) => {
                          const updatedProject = {
                            ...project,
                            pages: project.pages.map(p => 
                              p.id === page.id 
                                ? { 
                                    ...p, 
                                    scaleRegions: p.scaleRegions?.map(r => 
                                      r.id === region.id ? { ...r, name: e.target.value } : r
                                    ) 
                                  } 
                                : p
                            )
                          };
                          await saveProject(updatedProject);
                          setProject(updatedProject);
                          setPage(updatedProject.pages.find(p => p.id === page.id) || page);
                        }}
                        className="text-xs font-semibold bg-transparent border-none p-0 focus:ring-0 w-24"
                      />
                      <button 
                        onClick={async (e) => {
                          e.stopPropagation();
                          const updatedProject = {
                            ...project,
                            pages: project.pages.map(p => 
                              p.id === page.id 
                                ? { 
                                    ...p, 
                                    scaleRegions: p.scaleRegions?.filter(r => r.id !== region.id),
                                    measurements: p.measurements.map(m => m.regionId === region.id ? { ...m, regionId: undefined } : m)
                                  } 
                                : p
                            )
                          };
                          await saveProject(updatedProject);
                          setProject(updatedProject);
                          setPage(updatedProject.pages.find(p => p.id === page.id) || page);
                          if (selectedRegionId === region.id) setSelectedRegionId(null);
                        }}
                        className="text-slate-400 hover:text-red-500"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                    
                    <div className="space-y-2">
                      <select
                        value={region.scaleConfig?.label || (region.scaleConfig ? 'custom' : '')}
                        onClick={(e) => e.stopPropagation()}
                        onChange={async (e) => {
                          const val = e.target.value;
                          let newScaleConfig: ScaleConfig | null = null;
                          
                          if (val === 'custom') {
                            setCalibratingRegionId(region.id);
                            setCurrentTool('scale');
                            return;
                          } else {
                            const standard = STANDARD_SCALES.find(s => s.label === val);
                            if (standard) {
                              newScaleConfig = { ...standard };
                            }
                          }

                          const updatedProject = {
                            ...project,
                            pages: project.pages.map(p => 
                              p.id === page.id 
                                ? { 
                                    ...p, 
                                    scaleRegions: p.scaleRegions?.map(r => 
                                      r.id === region.id ? { ...r, scaleConfig: newScaleConfig || r.scaleConfig } : r
                                    ) 
                                  } 
                                : p
                            )
                          };
                          await saveProject(updatedProject);
                          setProject(updatedProject);
                          setPage(updatedProject.pages.find(p => p.id === page.id) || page);
                        }}
                        className="w-full border border-slate-300 rounded px-2 py-1 text-[10px] focus:outline-none focus:ring-1 focus:ring-accent-500 bg-white"
                      >
                        <option value="" disabled>Select a scale...</option>
                        <option value="custom">Custom (Calibrated)</option>
                        <optgroup label="Architectural">
                          {STANDARD_SCALES.slice(0, 11).map(s => (
                            <option key={s.label} value={s.label}>{s.label}</option>
                          ))}
                        </optgroup>
                        <optgroup label="Engineering">
                          {STANDARD_SCALES.slice(11).map(s => (
                            <option key={s.label} value={s.label}>{s.label}</option>
                          ))}
                        </optgroup>
                      </select>

                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-slate-500 italic">
                          {region.scaleConfig && region.scaleConfig.label === 'custom' ? 'Calibrated' : ''}
                        </span>
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedRegionId(region.id);
                            setCalibratingRegionId(region.id);
                            setCurrentTool('scale');
                          }}
                          className="text-[10px] text-accent-600 font-medium hover:underline"
                        >
                          {region.scaleConfig ? 'Recalibrate' : 'Set Scale'}
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!selectedTakeoffId && page.scaleConfig && (
            <div className="mt-4 pt-4 border-t border-slate-100">
              <label className="block text-xs font-medium text-slate-700 mb-1.5">Highlight Color</label>
              <input
                type="color"
                value={selectedColor}
                onChange={(e) => setSelectedColor(e.target.value)}
                className="h-8 w-full rounded cursor-pointer border border-slate-300 p-0.5"
              />
            </div>
          )}

          {globalUsers.length > 1 && (
            <div className="mt-4 pt-4 border-t border-slate-100">
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Collaboration</h3>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Cursor Color</label>
                  <input
                    type="color"
                    value={globalUsers.find(u => u.id === socket?.id)?.color || '#000000'}
                    onChange={(e) => {
                      const currentUser = globalUsers.find(u => u.id === socket?.id);
                      if (currentUser) {
                        updateUser(currentUser.name, e.target.value);
                        localStorage.setItem('userColor', e.target.value);
                      }
                    }}
                    className="h-8 w-full rounded cursor-pointer border border-slate-300 p-0.5"
                  />
                </div>
                <div className="pt-2">
                  <p className="text-xs text-slate-500 mb-2">Other Users:</p>
                  <div className="space-y-2">
                    {withDisplayNames(globalUsers.filter(u => u.id !== socket?.id)).map(user => (
                      <div key={user.id} className="flex items-center justify-between gap-2 text-sm">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: user.color }}></div>
                          <div className="min-w-0 cursor-pointer hover:text-accent-600 transition-colors" onClick={() => navigate(user.pageId)}>
                            <p className="text-slate-700 truncate font-medium" title={user.displayName}>{user.displayName}</p>
                            {user.pageId !== location.pathname && (
                              <p className="text-[10px] text-slate-400 truncate">
                                {user.pageName || 'Unknown'}
                              </p>
                            )}
                          </div>
                        </div>
                        <label className="flex items-center gap-1 cursor-pointer group">
                          <input 
                            type="checkbox"
                            checked={followedUserId === user.id}
                            onChange={(e) => setFollowedUserId(e.target.checked ? user.id : null)}
                            className="w-3.5 h-3.5 rounded border-slate-300 text-accent-600 focus:ring-accent-500"
                          />
                          <span className="text-[10px] font-medium text-slate-400 group-hover:text-accent-600 transition-colors">Follow</span>
                        </label>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      <button
        onClick={() => setIsLeftSidebarOpen(!isLeftSidebarOpen)}
        className={`absolute right-0 translate-x-full top-1/2 -translate-y-1/2 z-30 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 border-l-0 rounded-r-md p-1 shadow-sm hover:bg-slate-50 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-400 ${isLeftSidebarOpen ? 'hidden md:block' : 'block'}`}
      >
        {isLeftSidebarOpen ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
      </button>
    </div>
  </div>

  {/* Main Canvas Area */}
      <div className="flex-1 relative bg-slate-200 min-w-0 min-h-0 flex flex-col">
        {/* Mobile Header (only visible when sidebars are closed) */}
        <div className={`md:hidden fixed top-0 left-0 right-0 h-14 bg-white/90 backdrop-blur-md border-b border-slate-200 z-40 flex items-center px-4 justify-between transition-all duration-300 ${(!isLeftSidebarOpen && !isRightSidebarOpen) ? 'translate-y-0 opacity-100' : '-translate-y-full opacity-0'}`}>
          <div className="flex items-center gap-3">
            <button 
              onClick={() => setIsLeftSidebarOpen(true)}
              className="p-2 text-slate-600 hover:bg-slate-100 rounded-lg active:scale-95 transition-transform"
            >
              <Settings size={22} />
            </button>
            <div className="flex flex-col min-w-0">
              <span className="text-sm font-bold text-slate-900 truncate">{page.name}</span>
              <span className="text-[10px] text-slate-500 truncate">{project.name}</span>
            </div>
          </div>
          <button 
            onClick={() => setIsRightSidebarOpen(true)}
            className="p-2 text-slate-600 hover:bg-slate-100 rounded-lg relative active:scale-95 transition-transform"
          >
            <Layers size={22} />
            {page.measurements.length > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 bg-accent-600 text-white text-[10px] font-bold flex items-center justify-center rounded-full border-2 border-white shadow-sm">
                {page.measurements.length}
              </span>
            )}
          </button>
        </div>

        <div className="flex-1 relative min-h-0">
          {/* Floating Controls */}
          <div className={`absolute top-[58px] md:top-4 left-4 right-4 z-30 pointer-events-none flex items-center justify-between transition-opacity ${isLeftSidebarOpen || isRightSidebarOpen ? 'opacity-0 md:opacity-100' : 'opacity-100'}`}>
            <div className="hidden md:flex pointer-events-auto items-center gap-2">
              {!isLeftSidebarOpen && (
                <>
                  <Link 
                    to={`/project/${project.id}${searchTerm ? `?search=${encodeURIComponent(searchTerm)}` : ''}`} 
                    className="inline-flex items-center gap-2 bg-white/90 backdrop-blur border border-slate-200 rounded-lg px-3 py-2 text-slate-600 hover:text-slate-900 shadow-sm transition-all font-medium text-sm"
                  >
                    <ArrowLeft size={16} />
                    Back to Project
                  </Link>
                  
                  <div className="flex items-center bg-white/90 backdrop-blur border border-slate-200 rounded-lg shadow-sm overflow-hidden">
                    <Link
                      to={prevPageId ? `/project/${project.id}/page/${prevPageId}${searchTerm ? `?search=${encodeURIComponent(searchTerm)}` : ''}` : '#'}
                      state={{ pageIds }}
                      className={`p-2 flex items-center justify-center transition-colors ${prevPageId ? 'text-slate-600 hover:bg-slate-100 hover:text-slate-900' : 'text-slate-300 cursor-not-allowed'}`}
                      title="Previous Page"
                      onClick={(e) => !prevPageId && e.preventDefault()}
                    >
                      <ChevronLeft size={18} />
                    </Link>
                    <div className="w-px h-5 bg-slate-200" />
                    <Link
                      to={nextPageId ? `/project/${project.id}/page/${nextPageId}${searchTerm ? `?search=${encodeURIComponent(searchTerm)}` : ''}` : '#'}
                      state={{ pageIds }}
                      className={`p-2 flex items-center justify-center transition-colors ${nextPageId ? 'text-slate-600 hover:bg-slate-100 hover:text-slate-900' : 'text-slate-300 cursor-not-allowed'}`}
                      title="Next Page"
                      onClick={(e) => !nextPageId && e.preventDefault()}
                    >
                      <ChevronRight size={18} />
                    </Link>
                  </div>
                </>
              )}
            </div>
            
            <div className={`pointer-events-auto flex items-center gap-1 md:gap-2 bg-white/90 backdrop-blur border border-slate-200 rounded-xl p-1 md:p-1.5 shadow-lg mx-auto md:ml-auto md:mr-0 max-w-[95vw] overflow-x-auto no-scrollbar ${isLeftSidebarOpen || isRightSidebarOpen ? 'hidden md:flex' : 'flex'}`}>
              <ToolButton
                active={currentTool === 'pan'}
                onClick={() => setCurrentTool('pan')}
                icon={<Hand size={20} />}
                label="Pan"
              />
              <ToolButton
                active={currentTool === 'scale'}
                onClick={() => setCurrentTool('scale')}
                icon={<Settings size={20} />}
                label="Set Scale"
              />
              <div className="h-6 w-px bg-slate-200 mx-0.5 md:mx-1 flex-shrink-0" />
              <ToolButton
                active={currentTool === 'length'}
                onClick={() => setCurrentTool('length')}
                icon={<Ruler size={20} />}
                label="Length"
                disabled={!page.scaleConfig || activeTakeoff?.type === 'count' || lockedMeasurementType === 'area'}
                onDisabledClick={() => {
                  if (!page.scaleConfig) setToolDisabledMessage("Please set the scale first to enable measurement tools.");
                  else if (activeTakeoff?.type === 'count') setToolDisabledMessage("Length tools are disabled for count takeoffs.");
                  else if (lockedMeasurementType === 'area') setToolDisabledMessage("This measurement is an area — deselect it to start a line.");
                }}
              />
              <ToolButton
                active={currentTool === 'area'}
                onClick={() => setCurrentTool('area')}
                icon={<Square size={20} />}
                label="Area"
                disabled={!page.scaleConfig || activeTakeoff?.type === 'length' || activeTakeoff?.type === 'count' || lockedMeasurementType === 'length'}
                onDisabledClick={() => {
                  if (!page.scaleConfig) setToolDisabledMessage("Please set the scale first to enable measurement tools.");
                  else if (activeTakeoff?.type === 'length') setToolDisabledMessage("Area tools are disabled for linear takeoffs.");
                  else if (activeTakeoff?.type === 'count') setToolDisabledMessage("Area tools are disabled for count takeoffs.");
                  else if (lockedMeasurementType === 'length') setToolDisabledMessage("This measurement is a line — deselect it to start an area.");
                }}
              />
              <ToolButton
                active={currentTool === 'count'}
                onClick={() => setCurrentTool('count')}
                icon={<Hash size={20} />}
                label="Count"
                disabled={!page.scaleConfig || activeTakeoff?.type === 'length' || activeTakeoff?.type === 'area' || lockedMeasurementType !== null}
                onDisabledClick={() => {
                  if (!page.scaleConfig) setToolDisabledMessage("Please set the scale first to enable measurement tools.");
                  else if (activeTakeoff?.type === 'length') setToolDisabledMessage("Count tools are disabled for linear takeoffs.");
                  else if (activeTakeoff?.type === 'area') setToolDisabledMessage("Count tools are disabled for area takeoffs.");
                  else if (lockedMeasurementType !== null) setToolDisabledMessage("Deselect the current measurement to use the count tool.");
                }}
              />
              <div className="h-6 w-px bg-slate-200 mx-0.5 md:mx-1 flex-shrink-0" />
              <ToolButton
                active={currentTool === 'region'}
                onClick={() => setCurrentTool('region')}
                icon={<Layers size={20} />}
                label="Region"
                disabled={!page.isMultiRegion}
                onDisabledClick={() => setToolDisabledMessage("Enable 'Multi-Region Scaling' to use this tool.")}
              />
              <div className="h-6 w-px bg-slate-200 mx-0.5 md:mx-1 flex-shrink-0" />
              <button
                onClick={handleUndo}
                disabled={history.length === 0}
                className={`p-2 rounded-lg transition-colors flex-shrink-0 active:scale-95 ${
                  history.length === 0
                    ? 'text-slate-300 cursor-not-allowed'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-accent-600 active:bg-slate-200'
                }`}
                title="Undo (Ctrl+Z)"
              >
                <Undo size={20} />
              </button>
              <button
                onClick={handleRedo}
                disabled={redoStack.length === 0}
                className={`p-2 rounded-lg transition-colors flex-shrink-0 active:scale-95 ${
                  redoStack.length === 0
                    ? 'text-slate-300 cursor-not-allowed'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-accent-600 active:bg-slate-200'
                }`}
                title="Redo (Ctrl+Shift+Z)"
              >
                <Redo size={20} />
              </button>
              <button
                onClick={() => setShowShortcutsHelp(true)}
                className="p-2 rounded-lg transition-colors flex-shrink-0 active:scale-95 text-slate-400 hover:bg-slate-100 hover:text-accent-600"
                title="Keyboard Shortcuts (?)"
              >
                <HelpCircle size={20} />
              </button>
              <div className="h-6 w-px bg-slate-200 mx-0.5 md:mx-1 flex-shrink-0" />
              <button
                onClick={() => { setIsMultiSelectMode(m => !m); if (isMultiSelectMode) setMultiSelectedIds(new Set()); }}
                className={`p-2 rounded-lg transition-colors flex-shrink-0 active:scale-95 ${isMultiSelectMode ? 'bg-amber-500 text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-amber-600'}`}
                title="Multi-select (Ctrl+click on desktop)"
              >
                <BoxSelect size={20} />
              </button>
            </div>
          </div>

          <PdfCanvas
            key={page.id}
            imageUrl={imageUrl}
            imageWidth={page.imageWidth}
            imageHeight={page.imageHeight}
            currentTool={currentTool}
            searchTerm={searchTerm}
            scaleConfig={page.scaleConfig}
            measurements={page.measurements}
            pageMeasurements={page.measurements}
            takeoffs={project.takeoffs}
            onAddMeasurement={addMeasurement}
            onUpdateMeasurement={updateMeasurement}
            onDeleteMeasurement={deleteMeasurement}
            onSetScale={handleSetScale}
            selectedMeasurementId={selectedMeasurementId}
            onSelectMeasurement={setSelectedMeasurementId}
            resumeMeasurement={resumeMeasurement}
            onMeasurementResumed={() => setResumeMeasurement(null)}
            onCancel={() => {
              setSelectedMeasurementId(null);
              setCurrentTool('pan');
              setCalibratingRegionId(null);
            }}
            isMultiRegion={page.isMultiRegion}
            scaleRegions={page.scaleRegions}
            selectedRegionId={selectedRegionId}
            onSelectRegion={setSelectedRegionId}
            calibratingRegionId={calibratingRegionId}
            showLegend={page.showLegend ?? (project?.legendOnAllPages ?? false)}
            showLegendTotals={page.showLegendTotals}
            legendPosition={page.legendPosition}
            legendScale={page.legendScale}
            legendScaleX={page.legendScaleX}
            legendScaleY={page.legendScaleY}
            legendFontSize={page.legendFontSize}
            legendWidth={page.legendWidth}
            onUpdateLegend={async (updates) => {
              const pageUpdates: Partial<ProjectPage> = {};
              if (updates.position) pageUpdates.legendPosition = updates.position;
              if (updates.scale !== undefined) pageUpdates.legendScale = updates.scale;
              if (updates.scaleX !== undefined) pageUpdates.legendScaleX = updates.scaleX;
              if (updates.scaleY !== undefined) pageUpdates.legendScaleY = updates.scaleY;
              if (updates.fontSize !== undefined) pageUpdates.legendFontSize = updates.fontSize;
              if (updates.width !== undefined) pageUpdates.legendWidth = updates.width;
              savePageUpdates(pageUpdates);
            }}
            onAddRegion={async (region) => {
              const updatedProject = {
                ...project,
                pages: project.pages.map(p => 
                  p.id === page.id 
                    ? { ...p, scaleRegions: [...(p.scaleRegions || []), region] } 
                    : p
                )
              };
              await saveProject(updatedProject);
              setProject(updatedProject);
              setPage(updatedProject.pages.find(p => p.id === page.id) || page);
              setCurrentTool('pan');
            }}
            onUpdateRegion={async (id, regionUpdate) => {
              const updatedProject = {
                ...project,
                pages: project.pages.map(p => 
                  p.id === page.id 
                    ? { 
                        ...p, 
                        scaleRegions: p.scaleRegions?.map(r => r.id === id ? { ...r, ...regionUpdate } : r) 
                      } 
                    : p
                )
              };
              await saveProject(updatedProject);
              setProject(updatedProject);
              setPage(updatedProject.pages.find(p => p.id === page.id) || page);
            }}
            onDeleteRegion={async (id) => {
              const updatedProject = {
                ...project,
                pages: project.pages.map(p => 
                  p.id === page.id 
                    ? { 
                        ...p, 
                        scaleRegions: p.scaleRegions?.filter(r => r.id !== id),
                        measurements: p.measurements.map(m => m.regionId === id ? { ...m, regionId: undefined } : m)
                      } 
                    : p
                )
              };
              await saveProject(updatedProject);
              setProject(updatedProject);
              setPage(updatedProject.pages.find(p => p.id === page.id) || page);
            }}
            remoteUsers={users}
            onCursorMove={sendCursor}
            currentUserId={socket?.id}
            onUndo={handleUndo}
            onRedo={handleRedo}
            onCopy={selectedMeasurementId ? handleCopy : undefined}
            onPaste={handlePaste}
            hasCopied={!!localStorage.getItem('copiedMeasurement')}
            multiSelectedIds={multiSelectedIds}
            onMultiSelectToggle={handleMultiSelectToggle}
            onClearMultiSelect={() => setMultiSelectedIds(new Set())}
            isMultiSelectMode={isMultiSelectMode}
          />

          {/* Tool Instructions Overlay */}
          {currentTool !== 'pan' && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-slate-800/80 backdrop-blur text-white px-4 py-2 rounded-full text-xs md:text-sm shadow-lg pointer-events-none z-10 text-center max-w-[90vw]">
              {currentTool === 'scale' && (calibratingRegionId ? `Calibrating scale for ${page.scaleRegions?.find(r => r.id === calibratingRegionId)?.name}` : "Click two points to define a known distance")}
              {currentTool === 'length' && "Click points to draw a line. Double-click or press Enter to finish."}
              {currentTool === 'area' && "Click points to draw a polygon. Double-click or press Enter to finish."}
              {currentTool === 'region' && "Click points to define a scale region. Double-click or press Enter to finish."}
            </div>
          )}
        </div>
      </div>

      {/* Right Sidebar Wrapper */}
      {isRightSidebarOpen && (
        <div 
          className="fixed inset-0 bg-slate-900/20 backdrop-blur-[1px] z-40 md:hidden"
          onClick={() => setIsRightSidebarOpen(false)}
        />
      )}
      <div className={`fixed inset-0 z-50 md:relative md:inset-auto md:z-20 flex h-full transition-all duration-300 ${isRightSidebarOpen ? 'translate-x-0' : 'translate-x-full md:translate-x-0'}`}>
        <button
          onClick={() => setIsRightSidebarOpen(!isRightSidebarOpen)}
          className={`absolute left-0 -translate-x-full top-1/2 -translate-y-1/2 z-30 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 border-r-0 rounded-l-md p-1 shadow-sm hover:bg-slate-50 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-400 ${isRightSidebarOpen ? 'hidden md:block' : 'block'}`}
        >
          {isRightSidebarOpen ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>
        <div className={`bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 flex flex-col h-full shadow-2xl md:shadow-none transition-all duration-300 overflow-hidden ${isRightSidebarOpen ? 'w-full md:w-96' : 'w-0'}`}>
          <div className="w-full md:w-96 flex flex-col flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-4 pb-20">
            <div className="flex items-center justify-between mb-3 flex-shrink-0">
              <div className="flex items-center gap-2">
                <button 
                  onClick={() => setIsRightSidebarOpen(false)}
                  className="md:hidden p-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg"
                >
                  <ChevronRight size={20} />
                </button>
                <h2 className="text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider">Takeoffs & Measurements</h2>
              </div>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400 cursor-pointer">
                  <input 
                    type="checkbox" 
                    checked={showCurrentPageOnly}
                    onChange={(e) => setShowCurrentPageOnly(e.target.checked)}
                    className="rounded border-slate-300 dark:border-slate-600 text-accent-600 focus:ring-accent-500"
                  />
                  <span className="hidden sm:inline">Current page only</span>
                  <span className="sm:hidden">Page only</span>
                </label>
                {page.scaleConfig && (
                  <button
                    onClick={() => setShowTakeoffModal(true)}
                    className="text-xs flex items-center gap-1 text-accent-600 dark:text-accent-400 hover:text-accent-700 font-medium bg-accent-50 dark:bg-accent-900/30 hover:bg-accent-100 dark:hover:bg-accent-900/50 px-2 py-1 rounded transition-colors"
                  >
                    <Plus size={12} />
                    New
                  </button>
                )}
              </div>
            </div>

            {/* Measurement filter */}
            <div className="mb-3 flex-shrink-0 relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              <input
                type="text"
                value={measurementFilter}
                onChange={(e) => setMeasurementFilter(e.target.value)}
                placeholder="Filter takeoffs & measurements..."
                className="w-full text-xs border border-slate-200 dark:border-slate-700 rounded-lg pl-8 pr-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-slate-50 dark:bg-slate-800 dark:text-white dark:placeholder-slate-500"
              />
            </div>

            {!page.scaleConfig && (
              <div className="mb-4 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/30 rounded-lg text-sm text-amber-700 dark:text-amber-400">
                Please set the scale on the left sidebar.
              </div>
            )}

            {/* Multi-select merge banner */}
            {multiSelectedIds.size > 0 && (
              <div className="mb-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/30 rounded-xl p-3 flex-shrink-0">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                      {multiSelectedIds.size} selected
                    </p>
                    <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
                      {(() => {
                        const types = [...multiSelectedIds].map(id => page.measurements.find(m => m.id === id)?.type).filter(Boolean);
                        const allSame = types.every(t => t === types[0]);
                        if (!allSame) return 'Mixed types — cannot merge';
                        return selectedMeasurementId ? 'Will merge into selected measurement' : 'Will create a new measurement';
                      })()}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      onClick={() => { setMultiSelectedIds(new Set()); setIsMultiSelectMode(false); }}
                      className="text-xs text-amber-600 dark:text-amber-400 hover:text-amber-800 dark:hover:text-amber-200 px-2 py-1 rounded"
                    >
                      Clear
                    </button>
                    {multiSelectedIds.size >= 2 && (
                      <button
                        onClick={handleMergeSelected}
                        className="text-sm font-semibold bg-amber-500 hover:bg-amber-600 text-white px-3 py-1.5 rounded-lg flex items-center gap-1.5 active:scale-95 transition-all"
                      >
                        <GitMerge size={14} />
                        Merge
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Takeoff Totals */}
            {(() => {
              const filteredTakeoffs = takeoffTotals.filter(takeoff => {
                if (!measurementFilter) return true;
                const fl = measurementFilter.toLowerCase();
                if (takeoff.name.toLowerCase().includes(fl)) return true;
                return (showCurrentPageOnly ? pageVersions : project.pages).some(p =>
                  p.measurements.some(m => m.takeoffId === takeoff.id && m.name.toLowerCase().includes(fl))
                );
              });

              const packageOrder: string[] = [];
              const packageMap: Record<string, typeof filteredTakeoffs> = {};
              const ungrouped: typeof filteredTakeoffs = [];
              for (const t of filteredTakeoffs) {
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

              const renderTakeoffCard = (takeoff: typeof filteredTakeoffs[0]) => {
              const isActive = selectedTakeoffId === takeoff.id;
              const isExpanded = expandedTakeoffs[takeoff.id] !== false; // Default to expanded

              return (
                <div
                  key={takeoff.id}
                  className={`mb-4 bg-white dark:bg-slate-800 border rounded-xl overflow-hidden shadow-sm transition-colors flex-shrink-0 border-l-4 ${isActive ? 'border-accent-500 ring-1 ring-accent-500' : 'border-slate-200 dark:border-slate-700'}`}
                  style={{ borderLeftColor: takeoff.color }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.currentTarget.classList.add('ring-2', 'ring-accent-400', 'ring-inset');
                  }}
                  onDragLeave={(e) => {
                    e.currentTarget.classList.remove('ring-2', 'ring-accent-400', 'ring-inset');
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.currentTarget.classList.remove('ring-2', 'ring-accent-400', 'ring-inset');
                    const measurementId = e.dataTransfer.getData('text/plain');
                    const measurement = (showCurrentPageOnly ? aggregatedMeasurements : project.pages.flatMap(p => p.measurements)).find(m => m.id === measurementId);
                    
                    if (measurement) {
                      if (takeoff.type === 'count' && measurement.type !== 'count') {
                        toast('Cannot drop non-count measurements into a count takeoff.', { type: 'warning' });
                        return;
                      }
                      if (takeoff.type !== 'count' && measurement.type === 'count') {
                        toast('Cannot drop count measurements into a non-count takeoff.', { type: 'warning' });
                        return;
                      }
                      if (takeoff.type === 'length' && measurement.type === 'area') {
                        toast('Cannot drop area measurements into a linear takeoff.', { type: 'warning' });
                        return;
                      }
                      
                      updateMeasurement(measurementId, { takeoffId: takeoff.id, color: takeoff.color });
                    }
                  }}
                >
                  <div 
                    className={`px-3 py-2 border-b flex justify-between items-center group/header cursor-pointer transition-colors ${isActive ? 'bg-accent-50 dark:bg-accent-900/20 border-accent-100 dark:border-accent-800/30' : 'bg-slate-50 dark:bg-slate-800/50 border-slate-100 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700/50'}`}
                    onClick={() => {
                      if (isActive) {
                        setSelectedTakeoffId(null);
                      } else {
                        setSelectedTakeoffId(takeoff.id);
                        setSelectedColor(takeoff.color);
                        if (takeoff.type === 'length') setCurrentTool('length');
                        else if (takeoff.type === 'area') setCurrentTool('area');
                        else if (takeoff.type === 'count') setCurrentTool('count');
                      }
                    }}
                  >
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedTakeoffs(prev => ({ ...prev, [takeoff.id]: !isExpanded }));
                        }}
                        className="text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 p-2 rounded transition-colors active:scale-95 shrink-0"
                      >
                        {isExpanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                      </button>
                      <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: takeoff.color }} />
                      <span className={`text-sm font-semibold break-words whitespace-normal flex-1 min-w-0 ${isActive ? 'text-accent-800 dark:text-accent-300' : 'text-slate-800 dark:text-slate-200'}`}>{takeoff.name}</span>
                      <div className="flex items-center gap-0.5 shrink-0">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setTakeoffToDelete(takeoff);
                          }}
                          className="text-slate-400 hover:text-red-500 p-2 rounded-md hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors md:opacity-0 md:group-hover/header:opacity-100 active:scale-95"
                          title="Delete Takeoff"
                        >
                          <Trash2 size={16} />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleEditTakeoff(takeoff);
                          }}
                          className="text-slate-400 hover:text-accent-500 p-2 rounded-md hover:bg-accent-50 dark:hover:bg-accent-900/30 transition-colors md:opacity-0 md:group-hover/header:opacity-100 active:scale-95"
                          title="Edit Takeoff"
                        >
                          <Edit2 size={16} />
                        </button>
                      </div>
                    </div>
                    <div className="flex flex-col items-end shrink-0 ml-2">
                      <span className={`text-xs font-bold px-2 py-1 rounded-lg border transition-all ${isActive ? 'bg-accent-600 text-white border-accent-700 shadow-sm' : 'bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-600'}`}>
                        {formatRealValue(takeoff.totalRealValue, takeoff.type as 'length' | 'area' | 'count', page.scaleConfig?.unit || 'ft', takeoff, false)}
                      </span>
                      {(takeoff.costPerUnit || takeoff.isAdvancedCost) && (
                        <div className="flex flex-col items-end mt-1">
                          {formatRealValue(takeoff.totalRealValue, takeoff.type as 'length' | 'area' | 'count', page.scaleConfig?.unit || 'ft', takeoff)
                            .split('\n')
                            .slice(1)
                            .map((line, i) => (
                              <span key={i} className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-tight text-right">
                                {line}
                              </span>
                            ))
                          }
                        </div>
                      )}
                    </div>
                  </div>
                  {isExpanded && takeoff.type !== 'count' && (
                    <div className="divide-y divide-slate-50 dark:divide-slate-800 min-h-[10px]">
                      <button
                        onClick={() => openNewMeasurementModal(takeoff.id)}
                        className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-accent-600 dark:text-accent-400 hover:bg-accent-50 dark:hover:bg-accent-900/20 border-b border-dashed border-slate-200 dark:border-slate-700 transition-colors"
                      >
                        <Plus size={14} />
                        New Measurement
                      </button>
                      {(showCurrentPageOnly ? pageVersions : project.pages).flatMap(p =>
                        p.measurements
                          .filter(m => m.takeoffId === takeoff.id && (!measurementFilter || m.name.toLowerCase().includes(measurementFilter.toLowerCase())))
                          .map(m => (
                            <MeasurementItem
                              key={m.id}
                              measurement={m}
                              scaleConfig={p.scaleConfig}
                              takeoffType={takeoff.type}
                              onDelete={() => deleteMeasurement(m.id, p.id)}
                              selected={selectedMeasurementId === m.id}
                              onSelect={() => setSelectedMeasurementId(m.id)}
                              onRename={(newName) => updateMeasurement(m.id, { name: newName }, p.id)}
                              onEditHeights={() => setHeightsModalMeasurementId(m.id)}
                              takeoff={takeoff}
                              pageName={showCurrentPageOnly ? undefined : p.name}
                              pageId={p.id}
                              projectId={project.id}
                              planSetName={m.planSetId ? project.planSets?.find(ps => ps.id === m.planSetId)?.name : undefined}
                              pageIds={project.pages.filter(pg => pg.measurements.some(m => m.takeoffId === takeoff.id)).map(pg => pg.id)}
                            />
                          ))
                      )}
                    </div>
                  )}
                  {isExpanded && takeoff.type === 'count' && (
                    <div className="divide-y divide-slate-50 dark:divide-slate-800 min-h-[10px]">
                      {(showCurrentPageOnly ? pageVersions : project.pages).map(p => {
                        const count = p.measurements.filter(m => m.takeoffId === takeoff.id).length;
                        if (count === 0) return null;
                        return (
                          <div key={p.id} className="p-3 flex items-center justify-between hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors">
                            <Link 
                              to={`/project/${project.id}/page/${p.id}`}
                              state={{ pageIds: project.pages.filter(pg => pg.measurements.some(m => m.takeoffId === takeoff.id)).map(pg => pg.id) }}
                              className="text-sm font-medium text-accent-600 dark:text-accent-400 hover:text-accent-800 dark:hover:text-accent-300 hover:underline truncate"
                            >
                              {p.name}
                            </Link>
                            <span className="text-sm font-semibold text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 px-2 py-0.5 rounded-full">
                              {count}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
              };

              return (
                <>
                  {packageOrder.map(pkg => (
                    <React.Fragment key={`pkg-${pkg}`}>
                      <div className="px-2 pt-3 pb-1">
                        <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">{pkg}</span>
                      </div>
                      {packageMap[pkg].map(renderTakeoffCard)}
                    </React.Fragment>
                  ))}
                  {ungrouped.map(renderTakeoffCard)}
                </>
              );
            })()}

            {/* Ungrouped Measurements */}
            {(showCurrentPageOnly ? aggregatedMeasurements : project.pages.flatMap(p => p.measurements))
              .filter(m => !m.takeoffId && (!measurementFilter || m.name.toLowerCase().includes(measurementFilter.toLowerCase()))).length > 0 && (
              <div 
                className={`mb-4 bg-white dark:bg-slate-800 border rounded-xl overflow-hidden shadow-sm transition-colors flex-shrink-0 ${!selectedTakeoffId ? 'border-accent-500 ring-1 ring-accent-500' : 'border-slate-200 dark:border-slate-700'}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.currentTarget.classList.add('ring-2', 'ring-accent-400', 'ring-inset');
                }}
                onDragLeave={(e) => {
                  e.currentTarget.classList.remove('ring-2', 'ring-accent-400', 'ring-inset');
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.currentTarget.classList.remove('ring-2', 'ring-accent-400', 'ring-inset');
                  const measurementId = e.dataTransfer.getData('text/plain');
                  if (measurementId) {
                    updateMeasurement(measurementId, { takeoffId: undefined });
                  }
                }}
              >
                <div 
                  className={`px-3 py-2 border-b cursor-pointer transition-colors ${!selectedTakeoffId ? 'bg-accent-50 dark:bg-accent-900/20 border-accent-100 dark:border-accent-800/30' : 'bg-slate-50 dark:bg-slate-800/50 border-slate-100 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700/50'}`}
                  onClick={() => setSelectedTakeoffId(null)}
                >
                  <span className={`text-sm font-semibold ${!selectedTakeoffId ? 'text-accent-800 dark:text-accent-300' : 'text-slate-800 dark:text-slate-200'}`}>Ungrouped</span>
                </div>
                <div className="divide-y divide-slate-50 dark:divide-slate-800 min-h-[10px]">
                  {(showCurrentPageOnly ? pageVersions : project.pages).flatMap(p =>
                    p.measurements
                      .filter(m => !m.takeoffId)
                      .map(m => (
                        <MeasurementItem 
                          key={m.id} 
                          measurement={m} 
                          scaleConfig={p.scaleConfig} 
                          takeoffType={undefined}
                          onDelete={() => deleteMeasurement(m.id, p.id)}
                          selected={selectedMeasurementId === m.id}
                          onSelect={() => setSelectedMeasurementId(m.id)}
                          onRename={(newName) => updateMeasurement(m.id, { name: newName }, p.id)}
                          onEditHeights={() => setHeightsModalMeasurementId(m.id)}
                          pageName={showCurrentPageOnly ? undefined : p.name}
                          pageId={p.id}
                          projectId={project.id}
                          planSetName={m.planSetId ? project.planSets?.find(ps => ps.id === m.planSetId)?.name : undefined}
                          pageIds={project.pages.filter(pg => pg.measurements.some(m => !m.takeoffId)).map(pg => pg.id)}
                        />
                      ))
                  )}
                </div>
              </div>
            )}

            {(showCurrentPageOnly ? aggregatedMeasurements : project.pages.flatMap(p => p.measurements)).length === 0 && (
              <p className="text-sm text-slate-500 italic text-center py-4">No measurements yet.</p>
            )}
          </div>
        </div>
      </div>

      {/* Scale Modal */}
      {showScaleModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-slate-900 rounded-xl shadow-xl w-full max-w-sm overflow-hidden">
            <div className="p-4 border-b border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
              <h3 className="font-semibold text-slate-800 dark:text-slate-200">Set Scale</h3>
            </div>
            <div className="p-6">
              <p className="text-sm text-slate-600 dark:text-slate-400 mb-4">
                Enter the real-world distance for the line you just drew.
                {(scaleUnit === 'ft' || scaleUnit === 'in') && (
                  <span className="block mt-1 text-xs text-slate-500">
                    You can use fractions and feet/inches (e.g., 3' 4 1/2", 3.5, 4 1/2")
                  </span>
                )}
              </p>
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="block text-xs font-medium text-slate-500 mb-1">Distance</label>
                  <input
                    type="text"
                    value={scaleInput}
                    onChange={(e) => setScaleInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') confirmScale();
                    }}
                    className="w-full border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent-500 dark:bg-slate-800 dark:text-white"
                    autoFocus
                  />
                </div>
                <div className="w-24">
                  <label className="block text-xs font-medium text-slate-500 mb-1">Unit</label>
                  <select
                    value={scaleUnit}
                    onChange={(e) => setScaleUnit(e.target.value)}
                    className="w-full border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-white dark:bg-slate-800 dark:text-white"
                  >
                    <option value="ft">ft</option>
                    <option value="in">in</option>
                    <option value="m">m</option>
                    <option value="cm">cm</option>
                    <option value="mm">mm</option>
                  </select>
                </div>
              </div>
            </div>
            <div className="p-4 border-t border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 flex justify-end gap-2">
              <button
                onClick={() => setShowScaleModal(false)}
                className="px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 active:scale-95 rounded-lg transition-all"
              >
                Cancel
              </button>
              <button
                onClick={confirmScale}
                className="px-4 py-2 text-sm font-medium text-white bg-accent-600 hover:bg-accent-700 active:scale-95 rounded-lg transition-all"
              >
                Set Scale
              </button>
            </div>
          </div>
        </div>
      )}

      {/* New Measurement Modal */}
      {newMeasurementModal && (() => {
        const targetTakeoff = project.takeoffs.find(t => t.id === newMeasurementModal.takeoffId);
        const allowAreaType = targetTakeoff?.type === 'area';
        return (
          <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-[60] p-4">
            <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-xl w-full max-w-sm overflow-hidden">
              <div className="p-6 border-b border-slate-100 dark:border-slate-700">
                <h3 className="text-lg font-semibold text-slate-900 dark:text-white">New Measurement</h3>
                {targetTakeoff && (
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    Adding to <span className="font-medium" style={{ color: targetTakeoff.color }}>{targetTakeoff.name}</span>
                  </p>
                )}
              </div>
              <div className="p-6 space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">Name</label>
                  <input
                    type="text"
                    value={newMeasurementName}
                    onChange={(e) => setNewMeasurementName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') confirmNewMeasurement();
                    }}
                    placeholder="e.g. North Wall"
                    className="w-full border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent-500 dark:bg-slate-800 dark:text-white"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">Type</label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setNewMeasurementType('length')}
                      className={`flex items-center justify-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium transition-all ${newMeasurementType === 'length' ? 'border-accent-500 bg-accent-50 dark:bg-accent-900/30 text-accent-700 dark:text-accent-300' : 'border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'}`}
                    >
                      <Ruler size={14} /> Line
                    </button>
                    <button
                      type="button"
                      disabled={!allowAreaType}
                      onClick={() => allowAreaType && setNewMeasurementType('area')}
                      className={`flex items-center justify-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium transition-all ${newMeasurementType === 'area' ? 'border-accent-500 bg-accent-50 dark:bg-accent-900/30 text-accent-700 dark:text-accent-300' : 'border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'} ${!allowAreaType ? 'opacity-40 cursor-not-allowed' : ''}`}
                    >
                      <Square size={14} /> Area
                    </button>
                  </div>
                  {!allowAreaType && (
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1.5">
                      Linear takeoffs only support line measurements.
                    </p>
                  )}
                </div>
              </div>
              <div className="p-4 border-t border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 flex justify-end gap-2">
                <button
                  onClick={() => setNewMeasurementModal(null)}
                  className="px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 active:scale-95 rounded-lg transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmNewMeasurement}
                  className="px-4 py-2 text-sm font-medium text-white bg-accent-600 hover:bg-accent-700 active:scale-95 rounded-lg transition-all"
                >
                  Create
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-[60] p-4">
          <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-xl w-full max-w-sm overflow-hidden">
            <div className="p-6 border-b border-slate-100 dark:border-slate-700">
              <h3 className="text-lg font-semibold text-slate-900 dark:text-white">Delete Measurement</h3>
            </div>
            <div className="p-6">
              <p className="text-slate-600 dark:text-slate-400">
                Are you sure you want to delete this measurement? This action cannot be undone.
              </p>
            </div>
            <div className="p-6 border-t border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 flex justify-end gap-3">
              <button
                onClick={() => { setShowDeleteConfirm(false); setMeasurementToDelete(null); }}
                className="px-5 py-2.5 text-sm font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 active:scale-95 rounded-xl transition-all"
              >
                Cancel
              </button>
              <button
                onClick={confirmDeleteMeasurement}
                className="px-5 py-2.5 text-sm font-medium text-white bg-red-600 hover:bg-red-700 active:scale-95 rounded-xl transition-all shadow-sm"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Takeoff Modal */}
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
          setSelectedTakeoffId(newTakeoff.id);
          setSelectedColor(newTakeoff.color);
          setCurrentTool(newTakeoff.type);
          setShowTakeoffModal(false);
        }}
      />

      {/* Delete Takeoff Confirmation Modal */}
      {takeoffToDelete && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-xl w-full max-w-sm overflow-hidden">
            <div className="p-6 border-b border-slate-100 dark:border-slate-700">
              <h3 className="text-lg font-semibold text-slate-900 dark:text-white">Delete Takeoff</h3>
            </div>
            <div className="p-6">
              <p className="text-sm text-slate-600 dark:text-slate-400">
                Are you sure you want to delete the takeoff "{takeoffToDelete.name}"? This will also delete all measurements associated with it across all pages. This action cannot be undone.
              </p>
            </div>
            <div className="p-6 border-t border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 flex justify-end gap-3">
              <button
                onClick={() => setTakeoffToDelete(null)}
                className="px-5 py-2.5 text-sm font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-xl transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDeleteTakeoff}
                className="px-5 py-2.5 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-xl transition-colors shadow-sm"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Takeoff Modal */}
      {editingTakeoff && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
            <div className="p-6 border-b border-slate-100 dark:border-slate-700">
              <h3 className="text-lg font-semibold text-slate-900 dark:text-white">Edit Measurement Takeoff</h3>
            </div>
            <div className="p-6 space-y-4 max-h-[60vh] overflow-y-auto">
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Takeoff Name</label>
                <input
                  type="text"
                  value={editTakeoffName}
                  onChange={(e) => setEditTakeoffName(e.target.value)}
                  className="w-full border border-slate-300 dark:border-slate-600 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent-500 dark:bg-slate-800 dark:text-white"
                  placeholder="e.g. Hardwood Flooring"
                  autoFocus
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Measurement Type</label>
                  <input
                    type="text"
                    value={editingTakeoff.type}
                    disabled
                    className="w-full border border-slate-200 dark:border-slate-600 rounded-xl px-4 py-2.5 bg-slate-50 dark:bg-slate-800/50 text-slate-500 capitalize"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Color</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={editTakeoffColor}
                      onChange={(e) => setEditTakeoffColor(e.target.value)}
                      className="h-11 w-full rounded-lg cursor-pointer border border-slate-300 dark:border-slate-600 p-1"
                    />
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Unit</label>
                  <select
                    value={editTakeoffUnit}
                    onChange={(e) => setEditTakeoffUnit(e.target.value)}
                    className="w-full border border-slate-300 dark:border-slate-600 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-white dark:bg-slate-800 dark:text-white"
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
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Cost Per Unit ($)</label>
                  <input
                    type="text"
                    disabled={isEditTakeoffAdvanced}
                    value={isEditTakeoffAdvanced ? '' : editTakeoffCostPerUnit}
                    onChange={(e) => setEditTakeoffCostPerUnit(e.target.value)}
                    onBlur={() => {
                      if (editTakeoffCostPerUnit.startsWith('=')) {
                        const result = evaluateMathExpression(editTakeoffCostPerUnit);
                        if (result !== null) setEditTakeoffCostPerUnit(result.toString());
                      }
                    }}
                    className="w-full border border-slate-300 dark:border-slate-600 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent-500 dark:bg-slate-800 dark:text-white disabled:bg-slate-50 dark:disabled:bg-slate-800/50 disabled:text-slate-400"
                    placeholder={isEditTakeoffAdvanced ? "Disabled in Advanced" : "0.00 or =95*40%"}
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 py-2">
                <input
                  type="checkbox"
                  id="isEditTakeoffAdvanced"
                  checked={isEditTakeoffAdvanced}
                  onChange={(e) => setIsEditTakeoffAdvanced(e.target.checked)}
                  className="w-4 h-4 text-accent-600 rounded border-slate-300 dark:border-slate-600 focus:ring-accent-500"
                />
                <label htmlFor="isEditTakeoffAdvanced" className="text-sm font-medium text-slate-700 dark:text-slate-300 cursor-pointer">
                  Advanced Costing (Custom Items)
                </label>
              </div>

              {isEditTakeoffAdvanced && (
                <div className="mt-4 pt-4 border-t border-slate-100 dark:border-slate-700">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Advanced Costing</h4>
                    <button
                      onClick={() => setEditTakeoffCustomCosts([...editTakeoffCustomCosts, { id: uuidv4(), name: '', type: 'unit', costPerUnit: '0' }])}
                      className="text-[10px] flex items-center gap-1 text-accent-600 hover:text-accent-700 font-bold uppercase tracking-tight"
                    >
                      <Plus size={12} />
                      Add Cost Item
                    </button>
                  </div>
                  <div className="space-y-3">
                    {editTakeoffCustomCosts.map((cost, idx) => (
                      <CustomCostRow
                        key={cost.id}
                        item={cost}
                        index={idx}
                        unitLabel={UNIT_LABELS[editTakeoffUnit as keyof typeof UNIT_LABELS] || editTakeoffUnit || 'unit'}
                        onChange={(index, updated) => {
                          const newCosts = [...editTakeoffCustomCosts];
                          newCosts[index] = updated;
                          setEditTakeoffCustomCosts(newCosts);
                        }}
                        onRemove={(index) => {
                          setEditTakeoffCustomCosts(editTakeoffCustomCosts.filter((_, i) => i !== index));
                        }}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="p-6 border-t border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 flex justify-end gap-3">
              <button
                onClick={() => setEditingTakeoff(null)}
                className="px-5 py-2.5 text-sm font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 active:scale-95 rounded-xl transition-all"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveEditTakeoff}
                disabled={!editTakeoffName}
                className="px-5 py-2.5 text-sm font-medium text-white bg-accent-600 hover:bg-accent-700 disabled:opacity-50 disabled:cursor-not-allowed active:scale-95 rounded-xl transition-all shadow-sm"
              >
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Heights Modal */}
      {heightsModalMeasurementId && (
        <HeightsModal
          measurement={(showCurrentPageOnly ? aggregatedMeasurements : project.pages.flatMap(p => p.measurements)).find(m => m.id === heightsModalMeasurementId)!}
          scaleConfig={page.scaleConfig}
          onClose={() => setHeightsModalMeasurementId(null)}
          onSave={(heights, isTwoSided) => {
            updateMeasurement(heightsModalMeasurementId, { heights, isTwoSided });
            setHeightsModalMeasurementId(null);
          }}
        />
      )}
      {/* Keyboard Shortcuts Help Modal */}
      {showShortcutsHelp && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[70] p-4" onClick={() => setShowShortcutsHelp(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="p-6 border-b border-slate-100 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-accent-100 flex items-center justify-center text-accent-600">
                  <HelpCircle size={20} />
                </div>
                <h3 className="text-lg font-semibold text-slate-900">Keyboard Shortcuts</h3>
              </div>
              <button onClick={() => setShowShortcutsHelp(false)} className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div className="overflow-y-auto max-h-[60vh]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-100">
                    <th className="px-6 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Key</th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {[
                    ['?', 'Show this help'],
                    ['Escape', 'Cancel / close modal / deselect'],
                    ['Ctrl+Z', 'Undo'],
                    ['Ctrl+Shift+Z / Ctrl+Y', 'Redo'],
                    ['Delete / Backspace', 'Delete selected measurement'],
                    ['P', 'Resume/extend selected measurement'],
                    ['Ctrl+C', 'Copy measurement'],
                    ['Ctrl+V', 'Paste measurement'],
                    ['← / →', 'Previous / next page'],
                    ['Enter', 'Finish current measurement'],
                    ['A (while drawing)', 'Toggle arc mode'],
                  ].map(([key, action]) => (
                    <tr key={key} className="hover:bg-slate-50 transition-colors">
                      <td className="px-6 py-3 font-mono text-xs text-accent-700 bg-accent-50/50 whitespace-nowrap">{key}</td>
                      <td className="px-6 py-3 text-slate-700">{action}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="p-4 border-t border-slate-100 bg-slate-50 text-center">
              <p className="text-xs text-slate-400">Press <span className="font-mono">Escape</span> or click outside to close</p>
            </div>
          </div>
        </div>
      )}
      {/* Tool Disabled Message Modal */}
      {toolDisabledMessage && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-[60]">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm overflow-hidden">
            <div className="p-6 border-b border-slate-100 flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center text-amber-600">
                <Settings size={20} />
              </div>
              <h3 className="text-lg font-semibold text-slate-900">Tool Restricted</h3>
            </div>
            <div className="p-6">
              <p className="text-sm text-slate-600">
                {toolDisabledMessage}
              </p>
            </div>
            <div className="p-6 border-t border-slate-100 bg-slate-50 flex justify-end">
              <button
                onClick={() => setToolDisabledMessage(null)}
                className="px-5 py-2.5 text-sm font-medium text-white bg-accent-600 hover:bg-accent-700 rounded-xl transition-colors shadow-sm"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

interface CollabUser { id: string; name: string; pageId: string; pageName: string; cursor: { x: number; y: number } | null; color: string; }

function withDisplayNames(users: CollabUser[]): (CollabUser & { displayName: string })[] {
  const counts: Record<string, number> = {};
  users.forEach(u => { counts[u.name] = (counts[u.name] || 0) + 1; });
  const indexes: Record<string, number> = {};
  return users.map(u => {
    if (counts[u.name] <= 1) return { ...u, displayName: u.name };
    indexes[u.name] = (indexes[u.name] || 0) + 1;
    return { ...u, displayName: `${u.name} (${indexes[u.name]})` };
  });
}

export const CanvasView: React.FC = () => {
  const { pageId } = useParams<{ pageId: string }>();
  const [userName, setUserName] = useState('');
  const [userColor, setUserColor] = useState('');

  useEffect(() => {
    const storedName = localStorage.getItem('userName');
    if (storedName) {
      setUserName(storedName);
    } else {
      const newName = `User${Math.floor(Math.random() * 1000)}`;
      localStorage.setItem('userName', newName);
      setUserName(newName);
    }

    const storedColor = localStorage.getItem('userColor');
    if (storedColor) {
      setUserColor(storedColor);
    }
  }, []);

  if (!userName) return null;

  return (
    <CanvasViewInner />
  );
};

function ToolButton({ 
  active, 
  onClick, 
  icon, 
  label, 
  disabled = false,
  onDisabledClick,
  className = ""
}: { 
  active: boolean; 
  onClick: () => void; 
  icon: React.ReactNode; 
  label: string;
  disabled?: boolean;
  onDisabledClick?: () => void;
  className?: string;
}) {
  return (
    <button
      onClick={disabled ? onDisabledClick : onClick}
      title={label}
      className={`
        flex items-center justify-center p-2 md:p-2.5 rounded-lg border transition-all active:scale-95
        ${disabled ? 'opacity-50 bg-slate-50 border-slate-200 text-slate-400' : 
          active 
            ? 'bg-accent-50 border-accent-200 text-accent-700 shadow-sm' 
            : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50 hover:border-slate-300'}
        ${className}
      `}
    >
      {icon}
    </button>
  );
}

function MeasurementItem({ 
  measurement, 
  scaleConfig, 
  takeoffType,
  takeoff,
  onDelete,
  selected,
  onSelect,
  onRename,
  onEditHeights,
  pageName,
  pageId,
  projectId,
  planSetName,
  pageIds
}: { 
  measurement: Measurement;
  scaleConfig: ScaleConfig | null;
  takeoffType?: string;
  takeoff?: MeasurementTakeoff;
  onDelete: () => void;
  selected: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  onEditHeights?: () => void;
  pageName?: string;
  pageId?: string;
  projectId?: string;
  planSetName?: string;
  pageIds?: string[];
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(measurement.name);
  const rowRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (selected && rowRef.current) {
      rowRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selected]);

  const handleSaveName = () => {
    if (editName.trim()) {
      onRename(editName.trim());
    } else {
      setEditName(measurement.name);
    }
    setIsEditing(false);
  };

  return (
    <div
      ref={rowRef}
      className={`p-3 relative group flex flex-col gap-2 transition-colors cursor-grab active:cursor-grabbing border-l-4 ${selected ? 'bg-accent-100 dark:bg-accent-900/40 border-accent-500 ring-2 ring-accent-400 ring-inset shadow-sm' : 'hover:bg-slate-50 dark:hover:bg-slate-700/50 border-transparent'}`}
      onClick={onSelect}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', measurement.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
    >
      {selected && (
        <span className="absolute top-1.5 right-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-amber-400 text-amber-950 text-[9px] font-bold uppercase tracking-wider shadow-sm">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-700 animate-pulse" />
          Active
        </span>
      )}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {!measurement.takeoffId && (
            <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: measurement.color }} />
          )}
          <div className="flex flex-col flex-1 min-w-0">
            {isEditing ? (
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={handleSaveName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveName();
                  if (e.key === 'Escape') {
                    setEditName(measurement.name);
                    setIsEditing(false);
                  }
                }}
                className="text-sm border border-accent-300 rounded px-1 py-0.5 w-full focus:outline-none focus:ring-1 focus:ring-accent-500"
                autoFocus
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span
                className="text-sm text-slate-700 dark:text-slate-300 break-words whitespace-normal hover:text-accent-600 dark:hover:text-accent-400"
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setIsEditing(true);
                }}
                title="Double-click to rename"
              >
                {measurement.name}
              </span>
            )}
            {pageName && pageId && projectId && (
              <Link
                to={`/project/${projectId}/page/${pageId}`}
                state={{ pageIds }}
                className="text-[10px] text-accent-500 hover:text-accent-700 hover:underline font-medium uppercase tracking-wide truncate"
                onClick={(e) => e.stopPropagation()}
              >
                Page: {pageName}
              </Link>
            )}
            {pageName && (!pageId || !projectId) && (
              <span className="text-[10px] text-slate-400 font-medium uppercase tracking-wide truncate">
                Page: {pageName}
              </span>
            )}
            {planSetName && (
              <span className="text-[10px] text-purple-500 font-medium uppercase tracking-wide truncate">
                Set: {planSetName}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0 ml-2">
          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100 whitespace-pre-line text-right">
            {measurement.type === 'count'
              ? formatMeasurement(1, 'count', scaleConfig, takeoff)
              : (() => {
                  const allPts = [
                    expandArcPoints(measurement.points, measurement.arcMidIndices),
                    ...(measurement.segments ?? []).map(s => expandArcPoints(s.points, s.arcMidIndices)),
                  ];
                  return measurement.type === 'length'
                    ? (takeoffType === 'area'
                        ? formatMeasurement(
                            allPts.reduce((sum, pts) => sum + calculateSurfaceAreaPx(pts, measurement.heights || [], measurement.isTwoSided || false, scaleConfig), 0),
                            'area', scaleConfig, takeoff)
                        : formatMeasurement(
                            allPts.reduce((sum, pts) => sum + calculatePolylineLength(pts), 0),
                            'length', scaleConfig, takeoff))
                    : formatMeasurement(
                        allPts.reduce((sum, pts) => sum + calculatePolygonArea(pts), 0),
                        'area', scaleConfig, takeoff);
                })()
            }
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setIsEditing(true);
              }}
              className="md:hidden p-2 text-slate-400 hover:text-accent-500 active:scale-95 transition-all"
              title="Rename Measurement"
            >
              <Edit2 size={18} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="p-2 text-slate-400 hover:text-red-500 md:opacity-0 md:group-hover:opacity-100 active:scale-95 transition-all"
              title="Delete Measurement"
            >
              <Trash2 size={18} />
            </button>
          </div>
        </div>
      </div>
      
      {selected && !isEditing && (
        <div className="flex items-center gap-2 mt-1" onClick={(e) => e.stopPropagation()}>
          <span className="text-xs text-slate-500 italic">Drag to move to another takeoff</span>
          <div className="ml-auto flex items-center gap-3">
            {takeoffType === 'area' && measurement.type === 'length' && (
              <button
                onClick={(e) => { e.stopPropagation(); onEditHeights?.(); }}
                className="text-xs text-accent-600 hover:text-accent-800 flex items-center gap-1"
              >
                <Edit2 size={10} /> Edit Heights
              </button>
            )}
            <button
              onClick={() => setIsEditing(true)}
              className="text-xs text-accent-600 hover:text-accent-800 flex items-center gap-1"
            >
              <Edit2 size={10} /> Rename
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function HeightsModal({ 
  measurement, 
  scaleConfig,
  onClose, 
  onSave 
}: { 
  measurement: Measurement;
  scaleConfig: ScaleConfig | null;
  onClose: () => void;
  onSave: (heights: number[], isTwoSided: boolean) => void;
}) {
  const hasExistingPerPoint = measurement.heights && measurement.heights.length > 1 &&
    measurement.heights.some((h, i) => i > 0 && h !== measurement.heights![0]);
  const [perPoint, setPerPoint] = useState(hasExistingPerPoint || false);
  const [globalHeight, setGlobalHeight] = useState<string>(
    measurement.heights ? (measurement.heights[0]?.toString() || '') : ''
  );
  const [heights, setHeights] = useState<string[]>(
    measurement.heights?.map(h => h.toString()) || Array(measurement.points.length).fill('')
  );
  const [isTwoSided, setIsTwoSided] = useState(measurement.isTwoSided || false);

  const handleSave = () => {
    const numHeights = perPoint
      ? heights.map(h => parseFloat(h) || 0)
      : Array(measurement.points.length).fill(parseFloat(globalHeight) || 0);
    onSave(numHeights, isTwoSided);
  };

  const handleTogglePerPoint = (enabled: boolean) => {
    setPerPoint(enabled);
    if (enabled) {
      const val = globalHeight;
      setHeights(Array(measurement.points.length).fill(val));
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
        <div className="p-6 border-b border-slate-100">
          <h3 className="text-lg font-semibold text-slate-900">Wall Heights</h3>
          <p className="text-sm text-slate-500 mt-1">Enter the height to calculate surface area.</p>
        </div>
        <div className="p-6 space-y-4 max-h-[60vh] overflow-y-auto">
          {!perPoint && (
            <div className="flex items-center gap-4">
              <label className="text-sm font-medium text-slate-700 w-20">Height</label>
              <div className="flex-1 relative">
                <input
                  type="number"
                  value={globalHeight}
                  onChange={e => setGlobalHeight(e.target.value)}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 pr-8 focus:outline-none focus:ring-2 focus:ring-accent-500"
                  placeholder="Height"
                  autoFocus
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400">
                  {scaleConfig?.unit || 'px'}
                </span>
              </div>
            </div>
          )}
          {perPoint && measurement.points.map((_p, i) => (
            <div key={i} className="flex items-center gap-4">
              <label className="text-sm font-medium text-slate-700 w-20">Point {i + 1}</label>
              <div className="flex-1 relative">
                <input
                  type="number"
                  value={heights[i]}
                  onChange={e => {
                    const newHeights = [...heights];
                    newHeights[i] = e.target.value;
                    setHeights(newHeights);
                  }}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 pr-8 focus:outline-none focus:ring-2 focus:ring-accent-500"
                  placeholder="Height"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400">
                  {scaleConfig?.unit || 'px'}
                </span>
              </div>
            </div>
          ))}
          <div className="pt-3 space-y-3 border-t border-slate-100">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={perPoint}
                onChange={e => handleTogglePerPoint(e.target.checked)}
                className="w-4 h-4 text-accent-600 rounded border-slate-300 focus:ring-accent-500"
              />
              <span className="text-sm font-medium text-slate-700">Different height at each point</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={isTwoSided}
                onChange={e => setIsTwoSided(e.target.checked)}
                className="w-4 h-4 text-accent-600 rounded border-slate-300 dark:border-slate-600 focus:ring-accent-500"
              />
              <span className="text-sm font-medium text-slate-700">Two-sided wall (doubles the area)</span>
            </label>
          </div>
        </div>
        <div className="p-6 border-t border-slate-100 bg-slate-50 flex justify-end gap-3">
          <button onClick={onClose} className="px-5 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-200 rounded-xl transition-colors">Cancel</button>
          <button onClick={handleSave} className="px-5 py-2.5 text-sm font-medium text-white bg-accent-600 hover:bg-accent-700 rounded-xl transition-colors shadow-sm">Save Heights</button>
        </div>
      </div>
    </div>
  );
}
