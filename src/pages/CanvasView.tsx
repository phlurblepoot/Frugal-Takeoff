import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, Link, useLocation } from 'react-router-dom';
import { Hand, Ruler, Square, Settings, Trash2, Download, ArrowLeft, Layers, Plus, Edit2, Hash, Undo, ChevronLeft, ChevronRight, ChevronDown, Menu } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { PdfCanvas } from '../components/PdfCanvas';
import { Measurement, ScaleConfig, Tool, Project, ProjectPage, MeasurementTakeoff, TakeoffTemplate } from '../types';
import { calculatePolylineLength, calculatePolygonArea, formatMeasurement, calculateRealValue, parseFeetAndInches, calculateSurfaceAreaPx, formatRealValue, convertUnit } from '../utils/math';
import { getProject, saveProject, getImage, getImageUrl, getTemplates } from '../utils/store';
import { CollaborationProvider, useCollaboration } from '../context/CollaborationContext';

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

const CanvasViewInner: React.FC = () => {
  const { projectId, pageId } = useParams<{ projectId: string; pageId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  
  const { socket, users, sendCursor, sendMeasurementUpdate, sendProjectUpdate, onMeasurementSync, onProjectSync, updateUser } = useCollaboration();

  const [project, setProject] = useState<Project | null>(null);
  const [page, setPage] = useState<ProjectPage | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const pageIds = (location.state?.pageIds as string[]) || project?.pages.map(p => p.id) || [];
  const currentPageIndex = pageIds.findIndex(id => id === pageId);
  const prevPageId = currentPageIndex > 0 ? pageIds[currentPageIndex - 1] : null;
  const nextPageId = currentPageIndex !== -1 && currentPageIndex < pageIds.length - 1 ? pageIds[currentPageIndex + 1] : null;
  
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
  const [newTakeoffName, setNewTakeoffName] = useState('');
  const [newTakeoffColor, setNewTakeoffColor] = useState('#3b82f6');
  const [newTakeoffType, setNewTakeoffType] = useState<'length' | 'area' | 'count'>('length');
  const [newTakeoffUnit, setNewTakeoffUnit] = useState('');
  const [newTakeoffCostPerUnit, setNewTakeoffCostPerUnit] = useState<number | ''>('');
  const [isNewTakeoffAdvanced, setIsNewTakeoffAdvanced] = useState(false);
  const [newTakeoffCustomCosts, setNewTakeoffCustomCosts] = useState<{ id: string; name: string; costPerUnit: number }[]>([]);
  const [templates, setTemplates] = useState<TakeoffTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');

  const [editingTakeoff, setEditingTakeoff] = useState<MeasurementTakeoff | null>(null);
  const [takeoffToDelete, setTakeoffToDelete] = useState<MeasurementTakeoff | null>(null);
  const [editTakeoffName, setEditTakeoffName] = useState('');
  const [editTakeoffColor, setEditTakeoffColor] = useState('');
  const [editTakeoffUnit, setEditTakeoffUnit] = useState('');
  const [editTakeoffCostPerUnit, setEditTakeoffCostPerUnit] = useState<number | ''>('');
  const [isEditTakeoffAdvanced, setIsEditTakeoffAdvanced] = useState(false);
  const [editTakeoffCustomCosts, setEditTakeoffCustomCosts] = useState<{ id: string; name: string; costPerUnit: number }[]>([]);

  const [showCurrentPageOnly, setShowCurrentPageOnly] = useState(false);
  const [history, setHistory] = useState<{ type: 'add' | 'delete'; measurement: Measurement }[]>([]);

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

  const pushToHistory = (action: { type: 'add' | 'delete'; measurement: Measurement }) => {
    setHistory(prev => [...prev, action].slice(-50));
  };

  const handleUndo = () => {
    if (history.length === 0 || !page) return;

    const lastAction = history[history.length - 1];
    setHistory(prev => prev.slice(0, -1));

    if (lastAction.type === 'add') {
      // Undo add -> remove it
      savePageUpdates({
        measurements: page.measurements.filter(m => m.id !== lastAction.measurement.id)
      });
      if (selectedMeasurementId === lastAction.measurement.id) {
        setSelectedMeasurementId(null);
      }
    } else if (lastAction.type === 'delete') {
      // Undo delete -> add it back
      savePageUpdates({
        measurements: [...page.measurements, lastAction.measurement]
      });
    }
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

      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedMeasurementId) {
        deleteMeasurement(selectedMeasurementId);
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        handleUndo();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedMeasurementId, page, history]);

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
      alert('Please enter a valid distance.');
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

  const [aggregatedMeasurements, setAggregatedMeasurements] = useState<Measurement[]>([]);

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

  const handleCreateTakeoff = async () => {
    if (!project || !newTakeoffName) return;

    const newTakeoff: MeasurementTakeoff = {
      id: uuidv4(),
      name: newTakeoffName,
      color: newTakeoffColor,
      type: newTakeoffType,
      unit: newTakeoffUnit || undefined,
      costPerUnit: !isNewTakeoffAdvanced && newTakeoffCostPerUnit !== '' ? Number(newTakeoffCostPerUnit) : undefined,
      isAdvancedCost: isNewTakeoffAdvanced,
      customCosts: isNewTakeoffAdvanced ? newTakeoffCustomCosts : undefined,
    };

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
    setNewTakeoffName('');
    setNewTakeoffUnit('');
    setNewTakeoffCostPerUnit('');
    setIsNewTakeoffAdvanced(false);
    setNewTakeoffCustomCosts([]);
    setSelectedTemplateId('');
  };

  const handleTemplateChange = (templateId: string) => {
    setSelectedTemplateId(templateId);
    const template = templates.find(t => t.id === templateId);
    if (template) {
      setNewTakeoffName(template.name);
      if (template.type !== 'scale') {
        setNewTakeoffType(template.type);
      }
      setNewTakeoffColor(template.color);
      setNewTakeoffUnit(template.unit || '');
      setNewTakeoffCostPerUnit(template.costPerUnit ?? '');
      setIsNewTakeoffAdvanced(template.isAdvancedCost || false);
      setNewTakeoffCustomCosts(template.customCosts || []);
    }
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
    setEditTakeoffCostPerUnit(rawTakeoff.costPerUnit ?? '');
    setIsEditTakeoffAdvanced(rawTakeoff.isAdvancedCost || false);
    setEditTakeoffCustomCosts(rawTakeoff.customCosts || []);
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
              customCosts: isEditTakeoffAdvanced ? editTakeoffCustomCosts : undefined,
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
        <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
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

        let pixelValue = 0;
        if (takeoff.type === 'length' && m.type === 'length') {
          pixelValue = calculatePolylineLength(m.points);
        } else if (takeoff.type === 'area' && m.type === 'area') {
          pixelValue = calculatePolygonArea(m.points);
        } else if (takeoff.type === 'area' && m.type === 'length') {
          pixelValue = calculateSurfaceAreaPx(m.points, m.heights || [], m.isTwoSided || false, currentScale);
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

  return (
    <div className="flex h-screen w-full bg-slate-50 overflow-hidden font-sans relative">
      {/* Left Sidebar Wrapper */}
      {isLeftSidebarOpen && (
        <div 
          className="fixed inset-0 bg-slate-900/20 backdrop-blur-[1px] z-40 md:hidden"
          onClick={() => setIsLeftSidebarOpen(false)}
        />
      )}
      <div className={`fixed inset-0 z-50 md:relative md:inset-auto md:z-20 flex h-full transition-all duration-300 ${isLeftSidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}>
        <div className={`bg-white border-r border-slate-200 flex flex-col shadow-2xl md:shadow-none transition-all duration-300 overflow-hidden ${isLeftSidebarOpen ? 'w-full md:w-80' : 'w-0'}`}>
          <div className="w-full md:w-80 flex flex-col h-full overflow-y-auto overflow-x-hidden">
            <div className="p-4 border-b border-slate-200 shrink-0">
              <div className="flex items-center justify-between mb-4">
                <Link to={`/project/${project.id}`} className="inline-flex items-center gap-2 text-slate-500 hover:text-slate-800 transition-colors font-medium text-sm">
                  <ArrowLeft size={16} />
                  <span className="md:inline">Back to Project</span>
                </Link>
                
                <div className="flex items-center gap-2">
                  <button 
                    onClick={() => setIsLeftSidebarOpen(false)}
                    className="md:hidden p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg"
                  >
                    <ChevronLeft size={20} />
                  </button>
                  <div className="flex items-center bg-slate-50 border border-slate-200 rounded-lg shadow-sm overflow-hidden">
                <Link
                  to={prevPageId ? `/project/${project.id}/page/${prevPageId}` : '#'}
                  state={{ pageIds }}
                  className={`p-1.5 flex items-center justify-center transition-colors ${prevPageId ? 'text-slate-600 hover:bg-slate-200 hover:text-slate-900' : 'text-slate-300 cursor-not-allowed'}`}
                  title="Previous Page"
                  onClick={(e) => !prevPageId && e.preventDefault()}
                >
                  <ChevronLeft size={16} />
                </Link>
                <div className="w-px h-4 bg-slate-200" />
                <Link
                  to={nextPageId ? `/project/${project.id}/page/${nextPageId}` : '#'}
                  state={{ pageIds }}
                  className={`p-1.5 flex items-center justify-center transition-colors ${nextPageId ? 'text-slate-600 hover:bg-slate-200 hover:text-slate-900' : 'text-slate-300 cursor-not-allowed'}`}
                  title="Next Page"
                  onClick={(e) => !nextPageId && e.preventDefault()}
                >
                  <ChevronRight size={16} />
                </Link>
              </div>
              <div className="bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 shadow-sm flex items-center text-xs font-medium text-slate-600">
                <span>{currentPageIndex + 1} / {pageIds.length}</span>
              </div>
            </div>
          </div>
          <h1 className="text-xl font-semibold text-slate-800 flex items-center gap-2 line-clamp-1">
            {page.name}
          </h1>
          <p className="text-xs text-slate-500 mt-1 line-clamp-1">{project.name}</p>
        </div>

        <div className="p-4 border-b border-slate-200">
          <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Tools</h2>
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
              disabled={!page.scaleConfig || activeTakeoff?.type === 'count'}
              onDisabledClick={() => {
                if (!page.scaleConfig) setToolDisabledMessage("Please set the scale first to enable measurement tools.");
                else if (activeTakeoff?.type === 'count') setToolDisabledMessage("Length tools are disabled for count takeoffs.");
              }}
            />
            <ToolButton
              active={currentTool === 'area'}
              onClick={() => setCurrentTool('area')}
              icon={<Square size={18} />}
              label="Area"
              disabled={!page.scaleConfig || activeTakeoff?.type === 'length' || activeTakeoff?.type === 'count'}
              onDisabledClick={() => {
                if (!page.scaleConfig) setToolDisabledMessage("Please set the scale first to enable measurement tools.");
                else if (activeTakeoff?.type === 'length') setToolDisabledMessage("Area tools are disabled for linear takeoffs.");
                else if (activeTakeoff?.type === 'count') setToolDisabledMessage("Area tools are disabled for count takeoffs.");
              }}
            />
            <ToolButton
              active={currentTool === 'count'}
              onClick={() => setCurrentTool('count')}
              icon={<Hash size={18} />}
              label="Count"
              disabled={!page.scaleConfig || activeTakeoff?.type === 'length' || activeTakeoff?.type === 'area'}
              onDisabledClick={() => {
                if (!page.scaleConfig) setToolDisabledMessage("Please set the scale first to enable measurement tools.");
                else if (activeTakeoff?.type === 'length') setToolDisabledMessage("Count tools are disabled for linear takeoffs.");
                else if (activeTakeoff?.type === 'area') setToolDisabledMessage("Count tools are disabled for area takeoffs.");
              }}
            />
            <div className="h-8 w-px bg-slate-200 mx-1" />
            <ToolButton
              active={currentTool === 'region'}
              onClick={() => setCurrentTool('region')}
              icon={<Layers size={18} />}
              label="Region"
              disabled={!page.isMultiRegion}
              onDisabledClick={() => setToolDisabledMessage("Enable 'Multi-Region Scaling' to use this tool.")}
            />
            <div className="h-8 w-px bg-slate-200 mx-1" />
            <button
              onClick={handleUndo}
              disabled={history.length === 0}
              className={`p-2 rounded-lg transition-colors ${
                history.length === 0 
                  ? 'text-slate-300 cursor-not-allowed' 
                  : 'text-slate-600 hover:bg-slate-100 hover:text-blue-600'
              }`}
              title="Undo (Ctrl+Z)"
            >
              <Undo size={18} />
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
                className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
            </div>

            {!page.isMultiRegion && (
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">Page Scale</label>
                <select
                  value={page.scaleConfig?.label || (page.scaleConfig ? 'custom' : '')}
                  onChange={handleStandardScaleChange}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
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
                    className={`border rounded-lg p-2 transition-colors cursor-pointer ${selectedRegionId === region.id ? 'bg-blue-50 border-blue-300' : 'bg-slate-50 border-slate-200 hover:bg-slate-100'}`}
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
                        className="w-full border border-slate-300 rounded px-2 py-1 text-[10px] focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white"
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
                          className="text-[10px] text-blue-600 font-medium hover:underline"
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

          {users.length > 1 && (
            <div className="mt-4 pt-4 border-t border-slate-100">
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Collaboration</h3>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Your Name</label>
                  <input
                    type="text"
                    value={users.find(u => u.id === socket?.id)?.name || ''}
                    onChange={(e) => {
                      const currentUser = users.find(u => u.id === socket?.id);
                      if (currentUser) {
                        updateUser(e.target.value, currentUser.color);
                        localStorage.setItem('userName', e.target.value);
                      }
                    }}
                    className="w-full text-sm border border-slate-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Cursor Color</label>
                  <input
                    type="color"
                    value={users.find(u => u.id === socket?.id)?.color || '#000000'}
                    onChange={(e) => {
                      const currentUser = users.find(u => u.id === socket?.id);
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
                  <div className="space-y-1">
                    {users.filter(u => u.id !== socket?.id).map(user => (
                      <div key={user.id} className="flex items-center gap-2 text-sm">
                        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: user.color }}></div>
                        <span className="text-slate-700 truncate">{user.name}</span>
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
        className={`absolute right-0 translate-x-full top-1/2 -translate-y-1/2 z-30 bg-white border border-slate-200 border-l-0 rounded-r-md p-1 shadow-sm hover:bg-slate-50 text-slate-500 ${isLeftSidebarOpen ? 'hidden md:block' : 'block'}`}
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
            {aggregatedMeasurements.length > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 bg-blue-600 text-white text-[10px] font-bold flex items-center justify-center rounded-full border-2 border-white shadow-sm">
                {aggregatedMeasurements.length}
              </span>
            )}
          </button>
        </div>

        <div className="flex-1 relative min-h-0">
          {/* Floating Controls */}
          <div className={`absolute top-4 left-4 right-4 z-30 pointer-events-none flex items-center justify-between transition-opacity ${isLeftSidebarOpen || isRightSidebarOpen ? 'opacity-0 md:opacity-100' : 'opacity-100'}`}>
            <div className="hidden md:flex pointer-events-auto items-center gap-2">
              {!isLeftSidebarOpen && (
                <>
                  <Link 
                    to={`/project/${project.id}`} 
                    className="inline-flex items-center gap-2 bg-white/90 backdrop-blur border border-slate-200 rounded-lg px-3 py-2 text-slate-600 hover:text-slate-900 shadow-sm transition-all font-medium text-sm"
                  >
                    <ArrowLeft size={16} />
                    Back to Project
                  </Link>
                  
                  <div className="flex items-center bg-white/90 backdrop-blur border border-slate-200 rounded-lg shadow-sm overflow-hidden">
                    <Link
                      to={prevPageId ? `/project/${project.id}/page/${prevPageId}` : '#'}
                      state={{ pageIds }}
                      className={`p-2 flex items-center justify-center transition-colors ${prevPageId ? 'text-slate-600 hover:bg-slate-100 hover:text-slate-900' : 'text-slate-300 cursor-not-allowed'}`}
                      title="Previous Page"
                      onClick={(e) => !prevPageId && e.preventDefault()}
                    >
                      <ChevronLeft size={18} />
                    </Link>
                    <div className="w-px h-5 bg-slate-200" />
                    <Link
                      to={nextPageId ? `/project/${project.id}/page/${nextPageId}` : '#'}
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
                disabled={!page.scaleConfig || activeTakeoff?.type === 'count'}
                onDisabledClick={() => {
                  if (!page.scaleConfig) setToolDisabledMessage("Please set the scale first to enable measurement tools.");
                  else if (activeTakeoff?.type === 'count') setToolDisabledMessage("Length tools are disabled for count takeoffs.");
                }}
              />
              <ToolButton
                active={currentTool === 'area'}
                onClick={() => setCurrentTool('area')}
                icon={<Square size={20} />}
                label="Area"
                disabled={!page.scaleConfig || activeTakeoff?.type === 'length' || activeTakeoff?.type === 'count'}
                onDisabledClick={() => {
                  if (!page.scaleConfig) setToolDisabledMessage("Please set the scale first to enable measurement tools.");
                  else if (activeTakeoff?.type === 'length') setToolDisabledMessage("Area tools are disabled for linear takeoffs.");
                  else if (activeTakeoff?.type === 'count') setToolDisabledMessage("Area tools are disabled for count takeoffs.");
                }}
              />
              <ToolButton
                active={currentTool === 'count'}
                onClick={() => setCurrentTool('count')}
                icon={<Hash size={20} />}
                label="Count"
                disabled={!page.scaleConfig || activeTakeoff?.type === 'length' || activeTakeoff?.type === 'area'}
                onDisabledClick={() => {
                  if (!page.scaleConfig) setToolDisabledMessage("Please set the scale first to enable measurement tools.");
                  else if (activeTakeoff?.type === 'length') setToolDisabledMessage("Count tools are disabled for linear takeoffs.");
                  else if (activeTakeoff?.type === 'area') setToolDisabledMessage("Count tools are disabled for area takeoffs.");
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
                    : 'text-slate-600 hover:bg-slate-100 hover:text-blue-600 active:bg-slate-200'
                }`}
                title="Undo (Ctrl+Z)"
              >
                <Undo size={20} />
              </button>
            </div>
          </div>

          <PdfCanvas
            key={page.id}
            imageUrl={imageUrl}
            imageWidth={page.imageWidth}
            imageHeight={page.imageHeight}
            currentTool={currentTool}
            scaleConfig={page.scaleConfig}
            measurements={aggregatedMeasurements}
            takeoffs={project.takeoffs}
            onAddMeasurement={addMeasurement}
            onUpdateMeasurement={updateMeasurement}
            onDeleteMeasurement={deleteMeasurement}
            onSetScale={handleSetScale}
            selectedMeasurementId={selectedMeasurementId}
            onSelectMeasurement={setSelectedMeasurementId}
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
          className={`absolute left-0 -translate-x-full top-1/2 -translate-y-1/2 z-30 bg-white border border-slate-200 border-r-0 rounded-l-md p-1 shadow-sm hover:bg-slate-50 text-slate-500 ${isRightSidebarOpen ? 'hidden md:block' : 'block'}`}
        >
          {isRightSidebarOpen ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>
        <div className={`bg-white border-l border-slate-200 flex flex-col shadow-2xl md:shadow-none transition-all duration-300 overflow-hidden ${isRightSidebarOpen ? 'w-full md:w-96' : 'w-0'}`}>
          <div className="w-full md:w-96 flex flex-col h-full overflow-y-auto overflow-x-hidden p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <button 
                  onClick={() => setIsRightSidebarOpen(false)}
                  className="md:hidden p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg"
                >
                  <ChevronRight size={20} />
                </button>
                <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Takeoffs & Measurements</h2>
              </div>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
                  <input 
                    type="checkbox" 
                    checked={showCurrentPageOnly}
                    onChange={(e) => setShowCurrentPageOnly(e.target.checked)}
                    className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="hidden sm:inline">Current page only</span>
                  <span className="sm:hidden">Page only</span>
                </label>
                {page.scaleConfig && (
                  <button
                    onClick={() => setShowTakeoffModal(true)}
                    className="text-xs flex items-center gap-1 text-blue-600 hover:text-blue-700 font-medium bg-blue-50 hover:bg-blue-100 px-2 py-1 rounded transition-colors"
                  >
                    <Plus size={12} />
                    New
                  </button>
                )}
              </div>
            </div>

            {!page.scaleConfig && (
              <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700">
                Please set the scale on the left sidebar.
              </div>
            )}
            
            {/* Takeoff Totals */}
            {takeoffTotals.map(takeoff => {
              const isActive = selectedTakeoffId === takeoff.id;
              const isExpanded = expandedTakeoffs[takeoff.id] !== false; // Default to expanded
              
              return (
                <div 
                  key={takeoff.id} 
                  className={`mb-4 bg-white border rounded-xl overflow-hidden shadow-sm transition-colors ${isActive ? 'border-blue-500 ring-1 ring-blue-500' : 'border-slate-200'}`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.currentTarget.classList.add('ring-2', 'ring-blue-400', 'ring-inset');
                  }}
                  onDragLeave={(e) => {
                    e.currentTarget.classList.remove('ring-2', 'ring-blue-400', 'ring-inset');
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.currentTarget.classList.remove('ring-2', 'ring-blue-400', 'ring-inset');
                    const measurementId = e.dataTransfer.getData('text/plain');
                    const measurement = (showCurrentPageOnly ? aggregatedMeasurements : project.pages.flatMap(p => p.measurements)).find(m => m.id === measurementId);
                    
                    if (measurement) {
                      if (takeoff.type === 'count' && measurement.type !== 'count') {
                        alert('Cannot drop non-count measurements into a count takeoff.');
                        return;
                      }
                      if (takeoff.type !== 'count' && measurement.type === 'count') {
                        alert('Cannot drop count measurements into a non-count takeoff.');
                        return;
                      }
                      if (takeoff.type === 'length' && measurement.type === 'area') {
                        alert('Cannot drop area measurements into a linear takeoff.');
                        return;
                      }
                      
                      updateMeasurement(measurementId, { takeoffId: takeoff.id, color: takeoff.color });
                    }
                  }}
                >
                  <div 
                    className={`px-3 py-2 border-b flex justify-between items-center group/header cursor-pointer transition-colors ${isActive ? 'bg-blue-50 border-blue-100' : 'bg-slate-50 border-slate-100 hover:bg-slate-100'}`}
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
                    <div className="flex items-center gap-2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedTakeoffs(prev => ({ ...prev, [takeoff.id]: !isExpanded }));
                        }}
                        className="text-slate-400 hover:text-slate-600 p-2 rounded transition-colors active:scale-95"
                      >
                        {isExpanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                      </button>
                      <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: takeoff.color }} />
                      <span className={`text-sm font-semibold truncate max-w-[120px] md:max-w-none ${isActive ? 'text-blue-800' : 'text-slate-800'}`}>{takeoff.name}</span>
                      <div className="flex items-center gap-0.5">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setTakeoffToDelete(takeoff);
                          }}
                          className="text-slate-400 hover:text-red-500 p-2 rounded-md hover:bg-red-50 transition-colors md:opacity-0 md:group-hover/header:opacity-100 active:scale-95"
                          title="Delete Takeoff"
                        >
                          <Trash2 size={16} />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleEditTakeoff(takeoff);
                          }}
                          className="text-slate-400 hover:text-blue-500 p-2 rounded-md hover:bg-blue-50 transition-colors md:opacity-0 md:group-hover/header:opacity-100 active:scale-95"
                          title="Edit Takeoff"
                        >
                          <Edit2 size={16} />
                        </button>
                      </div>
                    </div>
                    <div className="flex flex-col items-end shrink-0 ml-2">
                      <span className={`text-xs font-bold px-2 py-1 rounded-lg border transition-all ${isActive ? 'bg-blue-600 text-white border-blue-700 shadow-sm' : 'bg-slate-100 text-slate-700 border-slate-200'}`}>
                        {formatRealValue(takeoff.totalRealValue, takeoff.type as 'length' | 'area' | 'count', page.scaleConfig?.unit || 'ft', takeoff, false)}
                      </span>
                      {takeoff.costPerUnit && (
                        <span className="text-[10px] font-bold text-emerald-600 mt-1 uppercase tracking-tight">
                          {formatRealValue(takeoff.totalRealValue, takeoff.type as 'length' | 'area' | 'count', page.scaleConfig?.unit || 'ft', takeoff).split('\n')[1]}
                        </span>
                      )}
                    </div>
                  </div>
                  {isExpanded && takeoff.type !== 'count' && (
                    <div className="divide-y divide-slate-50 min-h-[10px]">
                      {(showCurrentPageOnly ? pageVersions : project.pages).flatMap(p => 
                        p.measurements
                          .filter(m => m.takeoffId === takeoff.id)
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
                    <div className="divide-y divide-slate-50 min-h-[10px]">
                      {(showCurrentPageOnly ? pageVersions : project.pages).map(p => {
                        const count = p.measurements.filter(m => m.takeoffId === takeoff.id).length;
                        if (count === 0) return null;
                        return (
                          <div key={p.id} className="p-3 flex items-center justify-between hover:bg-slate-50 transition-colors">
                            <Link 
                              to={`/project/${project.id}/page/${p.id}`}
                              state={{ pageIds: project.pages.filter(pg => pg.measurements.some(m => m.takeoffId === takeoff.id)).map(pg => pg.id) }}
                              className="text-sm font-medium text-blue-600 hover:text-blue-800 hover:underline truncate"
                            >
                              {p.name}
                            </Link>
                            <span className="text-sm font-semibold text-slate-700 bg-slate-100 px-2 py-0.5 rounded-full">
                              {count}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Ungrouped Measurements */}
            {(showCurrentPageOnly ? aggregatedMeasurements : project.pages.flatMap(p => p.measurements)).filter(m => !m.takeoffId).length > 0 && (
              <div 
                className={`mb-4 bg-white border rounded-xl overflow-hidden shadow-sm transition-colors ${!selectedTakeoffId ? 'border-blue-500 ring-1 ring-blue-500' : 'border-slate-200'}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.currentTarget.classList.add('ring-2', 'ring-blue-400', 'ring-inset');
                }}
                onDragLeave={(e) => {
                  e.currentTarget.classList.remove('ring-2', 'ring-blue-400', 'ring-inset');
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.currentTarget.classList.remove('ring-2', 'ring-blue-400', 'ring-inset');
                  const measurementId = e.dataTransfer.getData('text/plain');
                  if (measurementId) {
                    updateMeasurement(measurementId, { takeoffId: undefined });
                  }
                }}
              >
                <div 
                  className={`px-3 py-2 border-b cursor-pointer transition-colors ${!selectedTakeoffId ? 'bg-blue-50 border-blue-100' : 'bg-slate-50 border-slate-100 hover:bg-slate-100'}`}
                  onClick={() => setSelectedTakeoffId(null)}
                >
                  <span className={`text-sm font-semibold ${!selectedTakeoffId ? 'text-blue-800' : 'text-slate-800'}`}>Ungrouped</span>
                </div>
                <div className="divide-y divide-slate-50 min-h-[10px]">
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
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm overflow-hidden">
            <div className="p-4 border-b border-slate-100 bg-slate-50">
              <h3 className="font-semibold text-slate-800">Set Scale</h3>
            </div>
            <div className="p-6">
              <p className="text-sm text-slate-600 mb-4">
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
                    className="w-full border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    autoFocus
                  />
                </div>
                <div className="w-24">
                  <label className="block text-xs font-medium text-slate-500 mb-1">Unit</label>
                  <select
                    value={scaleUnit}
                    onChange={(e) => setScaleUnit(e.target.value)}
                    className="w-full border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
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
            <div className="p-4 border-t border-slate-100 bg-slate-50 flex justify-end gap-2">
              <button
                onClick={() => setShowScaleModal(false)}
                className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-200 active:scale-95 rounded-lg transition-all"
              >
                Cancel
              </button>
              <button
                onClick={confirmScale}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 active:scale-95 rounded-lg transition-all"
              >
                Set Scale
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-[60] p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm overflow-hidden">
            <div className="p-6 border-b border-slate-100">
              <h3 className="text-lg font-semibold text-slate-900">Delete Measurement</h3>
            </div>
            <div className="p-6">
              <p className="text-slate-600">
                Are you sure you want to delete this measurement? This action cannot be undone.
              </p>
            </div>
            <div className="p-6 border-t border-slate-100 bg-slate-50 flex justify-end gap-3">
              <button
                onClick={() => { setShowDeleteConfirm(false); setMeasurementToDelete(null); }}
                className="px-5 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-200 active:scale-95 rounded-xl transition-all"
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
      {showTakeoffModal && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
            <div className="p-6 border-b border-slate-100">
              <h3 className="text-lg font-semibold text-slate-900">Create Measurement Takeoff</h3>
            </div>
            <div className="p-6 space-y-4 max-h-[60vh] overflow-y-auto">
              {templates.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Use Template (Optional)</label>
                  <select
                    value={selectedTemplateId}
                    onChange={(e) => handleTemplateChange(e.target.value)}
                    className="w-full border border-slate-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                  >
                    <option value="">Select a template...</option>
                    {templates.map(t => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Takeoff Name</label>
                <input
                  type="text"
                  value={newTakeoffName}
                  onChange={(e) => setNewTakeoffName(e.target.value)}
                  className="w-full border border-slate-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="e.g. Hardwood Flooring"
                  autoFocus
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Measurement Type</label>
                  <select
                    value={newTakeoffType}
                    onChange={(e) => {
                      setNewTakeoffType(e.target.value as 'length' | 'area' | 'count');
                      setNewTakeoffUnit('');
                    }}
                    className="w-full border border-slate-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                  >
                    <option value="length">Length</option>
                    <option value="area">Area</option>
                    <option value="count">Count</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Color</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={newTakeoffColor}
                      onChange={(e) => setNewTakeoffColor(e.target.value)}
                      className="h-11 w-full rounded-lg cursor-pointer border border-slate-300 p-1"
                    />
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Unit</label>
                  <select
                    value={newTakeoffUnit}
                    onChange={(e) => setNewTakeoffUnit(e.target.value)}
                    className="w-full border border-slate-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                  >
                    <option value="">Default (Scale Unit)</option>
                    {newTakeoffType === 'length' && (
                      <>
                        <option value="in">Inches (in)</option>
                        <option value="ft">Feet (ft)</option>
                        <option value="yd">Yards (yd)</option>
                        <option value="cm">Centimeters (cm)</option>
                        <option value="m">Meters (m)</option>
                      </>
                    )}
                    {newTakeoffType === 'area' && (
                      <>
                        <option value="sqin">Square Inches (sq in)</option>
                        <option value="sqft">Square Feet (sq ft)</option>
                        <option value="sqyd">Square Yards (sq yd)</option>
                        <option value="sqcm">Square Centimeters (sq cm)</option>
                        <option value="sqm">Square Meters (sq m)</option>
                      </>
                    )}
                    {newTakeoffType === 'count' && (
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
                    disabled={isNewTakeoffAdvanced}
                    value={isNewTakeoffAdvanced ? '' : newTakeoffCostPerUnit}
                    onChange={(e) => setNewTakeoffCostPerUnit(e.target.value === '' ? '' : Number(e.target.value))}
                    className="w-full border border-slate-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-50 disabled:text-slate-400"
                    placeholder={isNewTakeoffAdvanced ? "Disabled in Advanced" : "0.00"}
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 py-2">
                <input
                  type="checkbox"
                  id="isNewTakeoffAdvanced"
                  checked={isNewTakeoffAdvanced}
                  onChange={(e) => setIsNewTakeoffAdvanced(e.target.checked)}
                  className="w-4 h-4 text-blue-600 rounded border-slate-300 focus:ring-blue-500"
                />
                <label htmlFor="isNewTakeoffAdvanced" className="text-sm font-medium text-slate-700 cursor-pointer">
                  Advanced Costing (Custom Items)
                </label>
              </div>

              {isNewTakeoffAdvanced && (
                <div className="space-y-3 p-4 bg-slate-50 rounded-xl border border-slate-200">
                  <div className="flex justify-between items-center mb-2">
                    <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider">Custom Cost Items</h4>
                    <button
                      onClick={() => setNewTakeoffCustomCosts([...newTakeoffCustomCosts, { id: uuidv4(), name: '', costPerUnit: 0 }])}
                      className="text-blue-600 hover:text-blue-700 p-1 rounded-full hover:bg-blue-50 transition-colors"
                      title="Add Cost Item"
                    >
                      <Plus size={16} />
                    </button>
                  </div>
                  
                  {newTakeoffCustomCosts.length === 0 ? (
                    <p className="text-xs text-slate-400 italic text-center py-2">No custom items added. Click + to add.</p>
                  ) : (
                    <div className="space-y-2">
                      {newTakeoffCustomCosts.map((item, index) => (
                        <div key={item.id} className="flex gap-2 items-start">
                          <div className="flex-1">
                            <input
                              type="text"
                              value={item.name}
                              onChange={(e) => {
                                const newCosts = [...newTakeoffCustomCosts];
                                newCosts[index].name = e.target.value;
                                setNewTakeoffCustomCosts(newCosts);
                              }}
                              placeholder="Item Name"
                              className="w-full text-xs border border-slate-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                          </div>
                          <div className="w-24">
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={item.costPerUnit}
                              onChange={(e) => {
                                const newCosts = [...newTakeoffCustomCosts];
                                newCosts[index].costPerUnit = Number(e.target.value);
                                setNewTakeoffCustomCosts(newCosts);
                              }}
                              placeholder="Cost"
                              className="w-full text-xs border border-slate-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                          </div>
                          <button
                            onClick={() => setNewTakeoffCustomCosts(newTakeoffCustomCosts.filter((_, i) => i !== index))}
                            className="p-1.5 text-slate-400 hover:text-red-500 transition-colors"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="p-6 border-t border-slate-100 bg-slate-50 flex justify-end gap-3">
              <button
                onClick={() => setShowTakeoffModal(false)}
                className="px-5 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-200 active:scale-95 rounded-xl transition-all"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateTakeoff}
                disabled={!newTakeoffName}
                className="px-5 py-2.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed active:scale-95 rounded-xl transition-all shadow-sm"
              >
                Create Takeoff
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Takeoff Confirmation Modal */}
      {takeoffToDelete && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm overflow-hidden">
            <div className="p-6 border-b border-slate-100">
              <h3 className="text-lg font-semibold text-slate-900">Delete Takeoff</h3>
            </div>
            <div className="p-6">
              <p className="text-sm text-slate-600">
                Are you sure you want to delete the takeoff "{takeoffToDelete.name}"? This will also delete all measurements associated with it across all pages. This action cannot be undone.
              </p>
            </div>
            <div className="p-6 border-t border-slate-100 bg-slate-50 flex justify-end gap-3">
              <button
                onClick={() => setTakeoffToDelete(null)}
                className="px-5 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-200 rounded-xl transition-colors"
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
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
            <div className="p-6 border-b border-slate-100">
              <h3 className="text-lg font-semibold text-slate-900">Edit Measurement Takeoff</h3>
            </div>
            <div className="p-6 space-y-4 max-h-[60vh] overflow-y-auto">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Takeoff Name</label>
                <input
                  type="text"
                  value={editTakeoffName}
                  onChange={(e) => setEditTakeoffName(e.target.value)}
                  className="w-full border border-slate-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="e.g. Hardwood Flooring"
                  autoFocus
                />
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
                    className="w-full border border-slate-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
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
                    className="w-full border border-slate-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-50 disabled:text-slate-400"
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
                  className="w-4 h-4 text-blue-600 rounded border-slate-300 focus:ring-blue-500"
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
                      onClick={() => setEditTakeoffCustomCosts([...editTakeoffCustomCosts, { id: uuidv4(), name: '', costPerUnit: 0 }])}
                      className="text-blue-600 hover:text-blue-700 p-1 rounded-full hover:bg-blue-50 transition-colors"
                      title="Add Cost Item"
                    >
                      <Plus size={16} />
                    </button>
                  </div>
                  
                  {editTakeoffCustomCosts.length === 0 ? (
                    <p className="text-xs text-slate-400 italic text-center py-2">No custom items added. Click + to add.</p>
                  ) : (
                    <div className="space-y-2">
                      {editTakeoffCustomCosts.map((item, index) => (
                        <div key={item.id} className="flex gap-2 items-start">
                          <div className="flex-1">
                            <input
                              type="text"
                              value={item.name}
                              onChange={(e) => {
                                const newCosts = [...editTakeoffCustomCosts];
                                newCosts[index].name = e.target.value;
                                setEditTakeoffCustomCosts(newCosts);
                              }}
                              placeholder="Item Name"
                              className="w-full text-xs border border-slate-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                          </div>
                          <div className="w-24">
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={item.costPerUnit}
                              onChange={(e) => {
                                const newCosts = [...editTakeoffCustomCosts];
                                newCosts[index].costPerUnit = Number(e.target.value);
                                setEditTakeoffCustomCosts(newCosts);
                              }}
                              placeholder="Cost"
                              className="w-full text-xs border border-slate-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                          </div>
                          <button
                            onClick={() => setEditTakeoffCustomCosts(editTakeoffCustomCosts.filter((_, i) => i !== index))}
                            className="p-1.5 text-slate-400 hover:text-red-500 transition-colors"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="p-6 border-t border-slate-100 bg-slate-50 flex justify-end gap-3">
              <button
                onClick={() => setEditingTakeoff(null)}
                className="px-5 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-200 active:scale-95 rounded-xl transition-all"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveEditTakeoff}
                disabled={!editTakeoffName}
                className="px-5 py-2.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed active:scale-95 rounded-xl transition-all shadow-sm"
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
                className="px-5 py-2.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-xl transition-colors shadow-sm"
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
    <CollaborationProvider pageId={pageId} userName={userName} userColor={userColor}>
      <CanvasViewInner />
    </CollaborationProvider>
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
            ? 'bg-blue-50 border-blue-200 text-blue-700 shadow-sm' 
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
      className={`p-3 relative group flex flex-col gap-2 transition-colors cursor-grab active:cursor-grabbing border-l-4 ${selected ? 'bg-blue-50 border-blue-500' : 'hover:bg-slate-50 border-transparent'}`}
      onClick={onSelect}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', measurement.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
    >
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
                className="text-sm border border-blue-300 rounded px-1 py-0.5 w-full focus:outline-none focus:ring-1 focus:ring-blue-500"
                autoFocus
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span 
                className="text-sm text-slate-700 truncate hover:text-blue-600"
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
                className="text-[10px] text-blue-500 hover:text-blue-700 hover:underline font-medium uppercase tracking-wide truncate"
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
          <span className="text-sm font-semibold text-slate-900 whitespace-pre-line text-right">
            {measurement.type === 'count'
              ? formatMeasurement(1, 'count', scaleConfig, takeoff)
              : measurement.type === 'length' 
                ? (takeoffType === 'area' 
                    ? formatMeasurement(calculateSurfaceAreaPx(measurement.points, measurement.heights || [], measurement.isTwoSided || false, scaleConfig), 'area', scaleConfig, takeoff)
                    : formatMeasurement(calculatePolylineLength(measurement.points), 'length', scaleConfig, takeoff))
                : formatMeasurement(calculatePolygonArea(measurement.points), 'area', scaleConfig, takeoff)
            }
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setIsEditing(true);
              }}
              className="md:hidden p-2 text-slate-400 hover:text-blue-500 active:scale-95 transition-all"
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
                className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1"
              >
                <Edit2 size={10} /> Edit Heights
              </button>
            )}
            <button
              onClick={() => setIsEditing(true)}
              className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1"
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
  const [heights, setHeights] = useState<string[]>(
    measurement.heights?.map(h => h.toString()) || Array(measurement.points.length).fill('')
  );
  const [isTwoSided, setIsTwoSided] = useState(measurement.isTwoSided || false);

  const handleSave = () => {
    const numHeights = heights.map(h => parseFloat(h) || 0);
    onSave(numHeights, isTwoSided);
  };

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
        <div className="p-6 border-b border-slate-100">
          <h3 className="text-lg font-semibold text-slate-900">Wall Heights</h3>
          <p className="text-sm text-slate-500 mt-1">Enter the height at each point to calculate surface area.</p>
        </div>
        <div className="p-6 space-y-4 max-h-[60vh] overflow-y-auto">
          {measurement.points.map((p, i) => (
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
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 pr-8 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Height"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400">
                  {scaleConfig?.unit || 'px'}
                </span>
              </div>
            </div>
          ))}
          <div className="pt-4 border-t border-slate-100">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={isTwoSided}
                onChange={e => setIsTwoSided(e.target.checked)}
                className="w-4 h-4 text-blue-600 rounded border-slate-300 focus:ring-blue-500"
              />
              <span className="text-sm font-medium text-slate-700">Two-sided wall (doubles the area)</span>
            </label>
          </div>
        </div>
        <div className="p-6 border-t border-slate-100 bg-slate-50 flex justify-end gap-3">
          <button onClick={onClose} className="px-5 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-200 rounded-xl transition-colors">Cancel</button>
          <button onClick={handleSave} className="px-5 py-2.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-xl transition-colors shadow-sm">Save Heights</button>
        </div>
      </div>
    </div>
  );
}
