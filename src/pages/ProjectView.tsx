import React, { useEffect, useState, useRef, useMemo } from 'react';
import { useParams, Link, useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { ArrowLeft, FileImage, Settings, Plus, Trash2, ChevronDown, ChevronRight, Edit2, Check, X, Loader2, Upload, Search, Printer, Download, Eye, FileText, Hash, ZoomIn, ZoomOut, Maximize, FileSpreadsheet, Calendar, Building2, MapPin, Clock } from 'lucide-react';
import { Project, MeasurementTakeoff, ProjectPage, Printout, TakeoffTemplate, CustomCost, ProjectNote } from '../types';
import { getProject, saveProject, getImage, getImageUrl, saveImage, saveFile, getFile, deleteFile, getTemplates, getActivePages, getProjectNotes, saveProjectNotes } from '../utils/store';
import { calculatePolylineLength, calculatePolygonArea, calculateRealValue, formatRealValue, calculateSurfaceAreaPx, formatMeasurement, convertUnit, UNIT_LABELS, calculateTakeoffTotalCost, evaluateMathExpression, calculateTakeoffCostDetails } from '../utils/math';
import { loadPdfPagesGenerator } from '../utils/pdf';
import { v4 as uuidv4 } from 'uuid';
import { jsPDF } from 'jspdf';
import * as XLSX from 'xlsx';
import { createWorker } from 'tesseract.js';
import { AddressAutocomplete } from '../components/AddressAutocomplete';
import { StickyNote } from 'lucide-react';
import { useNotes } from '../context/NotesContext';

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
          className="text-xs border border-slate-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-slate-50"
        >
          <option value="flat">Flat Cost</option>
          <option value="yield">Cost by Yield</option>
          <option value="unit">Cost per {unitLabel}</option>
          <option value="amount_per_units">Amount per {unitLabel}s</option>
        </select>
        <input
          type="text"
          value={item.name}
          onChange={(e) => onChange(index, { ...item, name: e.target.value })}
          placeholder="Line Name"
          className="flex-1 text-xs border border-slate-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={() => onRemove(index)}
          className="p-1.5 text-slate-400 hover:text-red-500 transition-colors"
        >
          <Trash2 size={14} />
        </button>
      </div>
      
      <div className="flex gap-2 items-center pl-2 border-l-2 border-blue-100">
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
                className="w-24 text-xs border border-slate-300 rounded-lg pl-5 pr-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
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
                className="w-20 text-xs border border-slate-300 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
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
                className="w-20 text-xs border border-slate-300 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
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
                  className="w-24 text-xs border border-slate-300 rounded-lg pl-5 pr-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
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
                className="w-24 text-xs border border-slate-300 rounded-lg pl-5 pr-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
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
                  className="w-20 text-xs border border-slate-300 rounded-lg pl-5 pr-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
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
                className="w-16 text-xs border border-slate-300 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <span className="text-[10px] text-slate-500">{unitLabel}s</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-slate-400 uppercase">Unit:</span>
              <input
                type="text"
                value={item.unit || ''}
                onChange={(e) => onChange(index, { ...item, unit: e.target.value })}
                placeholder="e.g. bags"
                className="w-20 text-xs border border-slate-300 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export const ProjectView: React.FC = () => {
  const { openNotes } = useNotes();
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [project, setProject] = useState<Project | null>(null);
  const [takeoffToDelete, setTakeoffToDelete] = useState<string | null>(null);
  const [printoutToDelete, setPrintoutToDelete] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showDeletePrintoutConfirm, setShowDeletePrintoutConfirm] = useState(false);
  const [showDeleteAllConfirm, setShowDeleteAllConfirm] = useState(false);
  const [activeTab, setActiveTab] = useState<'pages' | 'takeoffs' | 'printouts' | 'notes'>('pages');
  const [isLoading, setIsLoading] = useState(true);
  const [projectNote, setProjectNote] = useState<ProjectNote | null>(null);
  const [showTakeoffModal, setShowTakeoffModal] = useState(false);
  const [newTakeoffName, setNewTakeoffName] = useState('');
  const [newTakeoffColor, setNewTakeoffColor] = useState('#3b82f6');
  const [newTakeoffType, setNewTakeoffType] = useState<'length' | 'area' | 'count'>('length');
  const [newTakeoffUnit, setNewTakeoffUnit] = useState('');
  const [newTakeoffCostPerUnit, setNewTakeoffCostPerUnit] = useState<number | ''>('');
  const [isNewTakeoffAdvanced, setIsNewTakeoffAdvanced] = useState(false);
  const [newTakeoffCustomCosts, setNewTakeoffCustomCosts] = useState<any[]>([]);
  const [templates, setTemplates] = useState<TakeoffTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');

  const [selectedTakeoffIds, setSelectedTakeoffIds] = useState<Set<string>>(new Set());
  const [isPrinting, setIsPrinting] = useState(false);
  const [isExportingExcel, setIsExportingExcel] = useState(false);

  const [editingTakeoff, setEditingTakeoff] = useState<MeasurementTakeoff | null>(null);
  const [editTakeoffName, setEditTakeoffName] = useState('');
  const [editTakeoffColor, setEditTakeoffColor] = useState('');
  const [editTakeoffUnit, setEditTakeoffUnit] = useState('');
  const [editTakeoffCostPerUnit, setEditTakeoffCostPerUnit] = useState<number | ''>('');
  const [isEditTakeoffAdvanced, setIsEditTakeoffAdvanced] = useState(false);
  const [editTakeoffCustomCosts, setEditTakeoffCustomCosts] = useState<any[]>([]);

  const [expandedTakeoffs, setExpandedTakeoffs] = useState<Record<string, boolean>>({});
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
  const [previewPageId, setPreviewPageId] = useState<string | null>(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractionRect, setExtractionRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [extractionType, setExtractionType] = useState<'pageNumber' | 'description' | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionStart, setSelectionStart] = useState<{ x: number; y: number } | null>(null);
  const [interactionMode, setInteractionMode] = useState<'draw' | 'move' | 'resize-nw' | 'resize-ne' | 'resize-sw' | 'resize-se' | null>(null);
  const [initialRect, setInitialRect] = useState<{ x: number, y: number, width: number, height: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [newPlanSetName, setNewPlanSetName] = useState('');
  const [newPlanSetDate, setNewPlanSetDate] = useState(new Date().toISOString().split('T')[0]);
  const [newPlanSetFiles, setNewPlanSetFiles] = useState<File[]>([]);
  const [useExistingPlanSet, setUseExistingPlanSet] = useState(false);
  const [targetPlanSetId, setTargetPlanSetId] = useState('');
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
  const [isEditingProjectName, setIsEditingProjectName] = useState(false);
  const [editProjectName, setEditProjectName] = useState('');
  const [isEditingDueDate, setIsEditingDueDate] = useState(false);
  const [editDueDate, setEditDueDate] = useState('');
  const [isEditingAddress, setIsEditingAddress] = useState(false);
  const [editAddress, setEditAddress] = useState('');
  const [isEditingContractor, setIsEditingContractor] = useState(false);
  const [editContractor, setEditContractor] = useState('');
  const [isOptimizingThumbnails, setIsOptimizingThumbnails] = useState(false);
  const [optimizeProgress, setOptimizeProgress] = useState({ current: 0, total: 0 });
  const [activePages, setActivePages] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageContainerRef = useRef<HTMLDivElement>(null);

  const removeNewPlanSetFile = (indexToRemove: number) => {
    setNewPlanSetFiles(newPlanSetFiles.filter((_, index) => index !== indexToRemove));
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

  const loadTemplates = async () => {
    const data = await getTemplates();
    setTemplates(data);
  };

  const loadProject = async (id: string) => {
    setIsLoading(true);
    const data = await getProject(id);
    if (!data) {
      navigate('/');
      return;
    }
    setProject(data);
    
    if (data.planSets && data.planSets.length > 0) {
      setSelectedPlanSetId('');
    }
    
    setIsLoading(false);
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
      customCosts: isNewTakeoffAdvanced ? newTakeoffCustomCosts.map(c => ({
        ...c,
        cost: evaluateMathExpression(c.cost?.toString() || '') ?? 0,
        yield: evaluateMathExpression(c.yield?.toString() || '') ?? 0,
        costPerUnit: evaluateMathExpression(c.costPerUnit?.toString() || '') ?? 0,
        amount: evaluateMathExpression(c.amount?.toString() || '') ?? 0,
        perUnits: evaluateMathExpression(c.perUnits?.toString() || '') ?? 0,
      })) : undefined,
    };

    const updatedProject = {
      ...project,
      takeoffs: [...project.takeoffs, newTakeoff],
    };

    await saveProject(updatedProject);
    setProject(updatedProject);
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

  const handleStartRenamePage = (e: React.MouseEvent, page: ProjectPage) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (activePages.includes(page.id)) {
      alert("This page is currently being viewed by another user and cannot be renamed.");
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
      
      let startingPageNum = updatedProject.pages.length + 1;

      for (let i = 0; i < newPlanSetFiles.length; i++) {
        const file = newPlanSetFiles[i];
        setAddProgress(prev => ({ ...prev, currentFile: i + 1, totalFiles: newPlanSetFiles.length }));
        
        const generator = loadPdfPagesGenerator(file, (status, current, total) => {
          setAddProgress(prev => ({ ...prev, status, current, total }));
        });

        for await (const pageData of generator) {
          setAddProgress(prev => ({ ...prev, status: 'uploading', current: pageData.pageNum, total: prev.total }));
          const imageId = uuidv4();
          const thumbnailId = uuidv4();
          await saveImage(imageId, pageData.dataUrl);
          await saveImage(thumbnailId, pageData.thumbnailDataUrl);
          thumbnails[imageId] = pageData.thumbnailDataUrl;
          
          const newPage = {
            id: uuidv4(),
            name: pageData.suggestedName || `Page ${startingPageNum}`,
            pageNumber: '',
            description: pageData.suggestedName || `Page ${startingPageNum}`,
            imageId,
            thumbnailId,
            imageWidth: pageData.width,
            imageHeight: pageData.height,
            extractedText: pageData.extractedText,
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
            extractedText: newPage.extractedText,
            measurements: [],
            scaleConfig: null,
            planSetId,
          };
          
          updatedProject = {
            ...updatedProject,
            pages: [...updatedProject.pages, newProjectPage]
          };
          
          if (startingPageNum % 5 === 0) {
            await saveProject(updatedProject);
            setProject(updatedProject);
          }
          
          startingPageNum++;
        }
        // Save any remaining pages
        await saveProject(updatedProject);
        setProject(updatedProject);
      }

      setPendingPages(extractedPages);
      setPendingThumbnails(thumbnails);
      setAddPagesStep('name_pages');
    } catch (error) {
      console.error('Error processing PDFs:', error);
      alert('Failed to process PDF. Please try another file.');
    } finally {
      setIsAddingPages(false);
      setAddProgress({ status: '', current: 0, total: 0, currentFile: 0, totalFiles: 0 });
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

    try {
      // Find all pages that have measurements belonging to the selected takeoffs
      const pagesToPrint = project.pages.filter(page => 
        page.measurements.some(m => selectedTakeoffIds.has(m.takeoffId || ''))
      );

      if (pagesToPrint.length === 0) {
        alert('No pages found with the selected takeoffs.');
        setIsPrinting(false);
        return;
      }

      const pdf = new jsPDF({
        orientation: 'landscape',
        unit: 'px',
        format: [pagesToPrint[0].imageWidth, pagesToPrint[0].imageHeight]
      });

      for (let i = 0; i < pagesToPrint.length; i++) {
        const page = pagesToPrint[i];

        const canvas = document.createElement('canvas');
        canvas.width = page.imageWidth;
        canvas.height = page.imageHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) continue;

        // Draw background image
        const img = new Image();
        img.src = getImageUrl(page.imageId);
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
        });
        ctx.drawImage(img, 0, 0);

        // Draw measurements
        page.measurements.forEach(m => {
          if (!selectedTakeoffIds.has(m.takeoffId || '')) return;
          
          const takeoff = project.takeoffs.find(t => t.id === m.takeoffId);
          const color = takeoff?.color || m.color || '#3b82f6';
          
          ctx.strokeStyle = color;
          ctx.fillStyle = `${color}40`;
          ctx.lineWidth = m.type === 'length' ? 8 : 3;
          
          if (m.type === 'count') {
            const p = m.points[0];
            ctx.beginPath();
            ctx.arc(p.x, p.y, 12, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            
            // Draw a small + in the middle
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(p.x - 6, p.y);
            ctx.lineTo(p.x + 6, p.y);
            ctx.moveTo(p.x, p.y - 6);
            ctx.lineTo(p.x, p.y + 6);
            ctx.stroke();
          } else {
            ctx.beginPath();
            ctx.moveTo(m.points[0].x, m.points[0].y);
            for (let j = 1; j < m.points.length; j++) {
              ctx.lineTo(m.points[j].x, m.points[j].y);
            }
            if (m.type === 'area') {
              ctx.closePath();
              ctx.fill();
            }
            ctx.stroke();

            // Draw labels
            let centerX = 0, centerY = 0;
            if (m.type === 'length') {
              const midIdx = Math.floor((m.points.length - 1) / 2);
              centerX = (m.points[midIdx].x + m.points[midIdx + 1].x) / 2;
              centerY = (m.points[midIdx].y + m.points[midIdx + 1].y) / 2;
            } else {
              m.points.forEach(p => { centerX += p.x; centerY += p.y; });
              centerX /= m.points.length;
              centerY /= m.points.length;
            }

            let text = '';
            const isSurfaceArea = takeoff?.type === 'area' && m.type === 'length';
            if (isSurfaceArea) {
              const pxArea = calculateSurfaceAreaPx(m.points, m.heights || [], m.isTwoSided || false, page.scaleConfig);
              text = formatMeasurement(pxArea, 'area', page.scaleConfig, takeoff);
            } else if (m.type === 'length') {
              const pxLen = calculatePolylineLength(m.points);
              text = formatMeasurement(pxLen, 'length', page.scaleConfig, takeoff);
            } else {
              const pxArea = calculatePolygonArea(m.points);
              text = formatMeasurement(pxArea, 'area', page.scaleConfig, takeoff);
            }

            if (text) {
              ctx.font = '14px sans-serif';
              const textWidth = ctx.measureText(text).width;
              ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
              ctx.fillRect(centerX - textWidth / 2 - 4, centerY - 18, textWidth + 8, 24);
              ctx.fillStyle = '#000';
              ctx.textAlign = 'center';
              ctx.fillText(text, centerX, centerY);
            }
          }
        });

        // Draw Legend
        if (page.showLegend && project.takeoffs.length > 0) {
          const legendItems: { color: string; name: string; total: string }[] = [];

          project.takeoffs.forEach(takeoff => {
            let totalRealValue = 0;
            let hasMeasurements = false;

            page.measurements.filter(m => m.takeoffId === takeoff.id).forEach(m => {
              if (!selectedTakeoffIds.has(m.takeoffId || '')) return;
              hasMeasurements = true;
              let currentScale = page.scaleConfig;
              if (page.isMultiRegion && m.regionId) {
                const region = page.scaleRegions?.find(r => r.id === m.regionId);
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
                const targetUnit = takeoff.unit || page.scaleConfig?.unit || 'ft';
                const sourceUnit = currentScale?.unit || 'ft';
                
                if (takeoff.type === 'count') {
                  totalRealValue += realValue;
                } else {
                  const cleanTargetUnit = targetUnit.replace('sq ', '');
                  totalRealValue += convertUnit(realValue, sourceUnit, cleanTargetUnit, takeoff.type as 'length' | 'area' | 'count');
                }
              }
            });

            if (hasMeasurements) {
              const targetUnit = takeoff.unit || page.scaleConfig?.unit || 'ft';
              const unitLabel = ` ${UNIT_LABELS[takeoff.type as keyof typeof UNIT_LABELS]?.[targetUnit] || targetUnit}`;
              const formattedTotal = takeoff.type === 'count' 
                ? Math.round(totalRealValue).toString() 
                : totalRealValue.toFixed(2);
              
              legendItems.push({
                color: takeoff.color,
                name: takeoff.name,
                total: page.showLegendTotals !== false ? `${formattedTotal}${unitLabel}` : ''
              });
            }
          });

          if (legendItems.length > 0) {
            const fontSize = page.legendFontSize || 14;
            const padding = fontSize * 0.8;
            const itemHeight = fontSize * 1.6;
            const colorBoxSize = fontSize;
            const textOffsetX = colorBoxSize + 10;
            const width = page.legendWidth || 350;
            const height = padding * 2 + legendItems.length * itemHeight + fontSize * 2;
            
            const pos = page.legendPosition || { x: 20, y: 20 };

            ctx.save();
            ctx.translate(pos.x, pos.y);

            // Background
            ctx.fillStyle = 'white';
            ctx.shadowColor = 'rgba(0,0,0,0.1)';
            ctx.shadowBlur = 10;
            ctx.shadowOffsetY = 4;
            ctx.beginPath();
            ctx.roundRect(0, 0, width, height, 6);
            ctx.fill();
            ctx.strokeStyle = '#e2e8f0';
            ctx.lineWidth = 1;
            ctx.stroke();

            // Reset shadow for text
            ctx.shadowColor = 'transparent';

            // Title
            ctx.fillStyle = '#334155';
            ctx.font = `bold ${fontSize + 2}px sans-serif`;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText('Legend', padding, padding);

            // Items
            legendItems.forEach((item, index) => {
              const y = padding + fontSize * 2 + index * itemHeight;
              
              // Color box
              ctx.fillStyle = item.color;
              ctx.beginPath();
              ctx.roundRect(padding, y + 2, colorBoxSize, colorBoxSize, 3);
              ctx.fill();

              // Name
              ctx.fillStyle = '#475569';
              ctx.font = `${fontSize}px sans-serif`;
              ctx.textAlign = 'left';
              ctx.textBaseline = 'top';
              // Simple truncation for name
              let nameText = item.name;
              const maxNameWidth = width - padding * 2 - textOffsetX - (page.showLegendTotals !== false ? fontSize * 10 : 0);
              if (ctx.measureText(nameText).width > maxNameWidth) {
                while (nameText.length > 0 && ctx.measureText(nameText + '...').width > maxNameWidth) {
                  nameText = nameText.slice(0, -1);
                }
                nameText += '...';
              }
              ctx.fillText(nameText, padding + textOffsetX, y + 2);

              // Total
              if (page.showLegendTotals !== false) {
                ctx.fillStyle = '#0f172a';
                ctx.font = `bold ${fontSize}px sans-serif`;
                ctx.textAlign = 'right';
                ctx.fillText(item.total, width - padding, y + 2);
              }
            });

            ctx.restore();
          }
        }

        const pageDataUrl = canvas.toDataURL('image/jpeg', 0.8);
        
        if (i > 0) {
          pdf.addPage([page.imageWidth, page.imageHeight], 'landscape');
        }
        
        pdf.setPage(i + 1);
        pdf.addImage(pageDataUrl, 'JPEG', 0, 0, page.imageWidth, page.imageHeight);
      }

      const pdfBlob = pdf.output('blob');
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
        setSelectedTakeoffIds(new Set());
        setActiveTab('printouts');
      };
    } catch (error) {
      console.error('Error generating PDF:', error);
      alert('Failed to generate PDF.');
      setIsPrinting(false);
    }
  };

  const handleExportExcel = async () => {
    if (!project || selectedTakeoffIds.size === 0) return;
    setIsExportingExcel(true);

    try {
      const selectedTakeoffs = getTakeoffTotals().filter(t => selectedTakeoffIds.has(t.id));
      
      const data = selectedTakeoffs.map(t => {
        const totalCost = calculateTakeoffTotalCost(t, t.totalRealValue);

        return {
          'Takeoff Name': t.name,
          'Type': t.type,
          'Total Quantity': t.totalRealValue,
          'Unit': UNIT_LABELS[t.unit || ''] || t.unit || (t.type === 'area' ? 'sq ft' : t.type === 'length' ? 'ft' : 'ea'),
          'Total Cost': totalCost
        };
      });

      const ws = XLSX.utils.json_to_sheet(data);
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
        setActiveTab('printouts');
      };
    } catch (error) {
      console.error('Error generating Excel:', error);
      alert('Failed to generate Excel.');
      setIsExportingExcel(false);
    }
  };

  const handleDeletePrintout = (printoutId: string) => {
    setPrintoutToDelete(printoutId);
    setShowDeletePrintoutConfirm(true);
  };

  const confirmDeletePrintout = async () => {
    if (!project || !printoutToDelete) return;
    
    const printout = project.printouts?.find(p => p.id === printoutToDelete);
    if (!printout) {
      setShowDeletePrintoutConfirm(false);
      setPrintoutToDelete(null);
      return;
    }

    const updatedProject = {
      ...project,
      printouts: project.printouts?.filter(p => p.id !== printoutToDelete) || [],
    };

    await saveProject(updatedProject);
    await deleteFile(printout.fileId);
    setProject(updatedProject);
    setShowDeletePrintoutConfirm(false);
    setPrintoutToDelete(null);
  };

  const handleDownloadPrintout = async (printout: Printout) => {
    const dataUrl = await getFile(printout.fileId);
    if (!dataUrl) return;

    const link = document.createElement('a');
    link.href = dataUrl;
    const isExcel = printout.type === 'excel' || dataUrl.startsWith('data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const extension = isExcel ? '.xlsx' : '.pdf';
    link.download = printout.name.endsWith(extension) ? printout.name : `${printout.name}${extension}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleViewPrintout = async (printout: Printout) => {
    const dataUrl = await getFile(printout.fileId);
    if (!dataUrl) return;

    if (printout.type === 'excel' || dataUrl.startsWith('data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')) {
      // For Excel files, trigger download since browsers can't preview them in iframe easily
      const link = document.createElement('a');
      link.href = dataUrl;
      link.download = printout.name.endsWith('.xlsx') ? printout.name : `${printout.name}.xlsx`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } else {
      const win = window.open();
      if (win) {
        win.document.write(`<iframe src="${dataUrl}" frameborder="0" style="border:0; top:0px; left:0px; bottom:0px; right:0px; width:100%; height:100%;" allowfullscreen></iframe>`);
      }
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
      
      if (!isNamingExistingPages) {
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
    } catch (error) {
      console.error('Error adding pages:', error);
      alert('Failed to add pages.');
    } finally {
      setIsAddingPages(false);
    }
  };

  const updatePendingPageField = (id: string, field: string, value: string) => {
    setPendingPages(prev => prev.map(p => {
      if (p.id === id) {
        const updated = { ...p, [field]: value };
        // Auto-update name based on number and description
        if (field === 'pageNumber' || field === 'description') {
          const num = field === 'pageNumber' ? value : (p.pageNumber || '');
          const desc = field === 'description' ? value : (p.description || '');
          updated.name = num && desc ? `${num} - ${desc}` : (num || desc || p.name);
        }
        return updated;
      }
      return p;
    }));
  };

  const handleExtractText = async (applyToAll: boolean) => {
    if (!previewPageId || !extractionRect || !extractionType) return;
    
    const page = pendingPages.find(p => p.id === previewPageId);
    if (!page) return;

    setIsExtracting(true);
    try {
      const worker = await createWorker('eng');
      
      const extractFromPage = async (targetPage: any) => {
        const imageUrl = getImageUrl(targetPage.imageId);
        if (!imageUrl) return null;

        // Crop image to selection area for better OCR
        const img = new Image();
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
          img.src = imageUrl;
        });

        const canvas = document.createElement('canvas');
        const scaleX = img.width / 100;
        const scaleY = img.height / 100;
        
        canvas.width = extractionRect.width * scaleX;
        canvas.height = extractionRect.height * scaleY;
        
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        
        ctx.drawImage(
          img,
          extractionRect.x * scaleX,
          extractionRect.y * scaleY,
          extractionRect.width * scaleX,
          extractionRect.height * scaleY,
          0, 0, canvas.width, canvas.height
        );

        const croppedDataUrl = canvas.toDataURL('image/png');
        const { data: { text } } = await worker.recognize(croppedDataUrl);
        
        return text?.trim() || '';
      };

      if (applyToAll) {
        // Extract for all pages
        const updatedPages = [...pendingPages];
        for (let i = 0; i < updatedPages.length; i++) {
          const text = await extractFromPage(updatedPages[i]);
          if (text !== null) {
            updatedPages[i] = { 
              ...updatedPages[i], 
              [extractionType]: text,
              name: extractionType === 'pageNumber' 
                ? (text && updatedPages[i].description ? `${text} - ${updatedPages[i].description}` : (text || updatedPages[i].description || updatedPages[i].name))
                : (updatedPages[i].pageNumber && text ? `${updatedPages[i].pageNumber} - ${text}` : (updatedPages[i].pageNumber || text || updatedPages[i].name))
            };
          }
        }
        setPendingPages(updatedPages);
      } else {
        // Extract for current page only
        const text = await extractFromPage(page);
        if (text !== null) {
          updatePendingPageField(previewPageId, extractionType, text);
        }
      }
      
      await worker.terminate();
      setExtractionRect(null);
      setExtractionType(null);
    } catch (error) {
      console.error('Extraction error:', error);
      alert('Failed to extract text. Please try again.');
    } finally {
      setIsExtracting(false);
    }
  };

  // Calculate totals for takeoffs across all pages
  const getTakeoffTotals = () => {
    if (!project) return [];

    const pagesToCalculate = project.pages;

    return project.takeoffs.map(takeoff => {
      let totalRealValue = 0;
      let displayUnit = takeoff.unit || '';
      
      const pageBreakdown: { pageId: string; pageName: string; realValue: number; unit: string }[] = [];

      pagesToCalculate.forEach(page => {
        const takeoffMeasurements = page.measurements.filter(m => m.takeoffId === takeoff.id);
        
        if (takeoffMeasurements.length > 0) {
          let pageRealValue = 0;
          let pageUnit = '';

          takeoffMeasurements.forEach(m => {
            // Determine which scale to use
            let currentScale = page.scaleConfig;
            if (page.isMultiRegion && m.regionId) {
              const region = page.scaleRegions?.find(r => r.id === m.regionId);
              if (region?.scaleConfig) {
                currentScale = region.scaleConfig;
              }
            }

            if (takeoff.type === 'count') {
              pageRealValue += 1;
              pageUnit = 'each';
            } else if (currentScale) {
              let pixelValue = 0;
              if (takeoff.type === 'length' && m.type === 'length') {
                pixelValue = calculatePolylineLength(m.points);
              } else if (takeoff.type === 'area' && m.type === 'area') {
                pixelValue = calculatePolygonArea(m.points);
              } else if (takeoff.type === 'area' && m.type === 'length') {
                pixelValue = calculateSurfaceAreaPx(m.points, m.heights || [], m.isTwoSided || false, currentScale);
              }

              if (pixelValue > 0) {
                const realVal = calculateRealValue(pixelValue, takeoff.type as 'length' | 'area' | 'count', currentScale);
                
                // Convert to a consistent unit
                // If takeoff has a specific unit, use that. Otherwise use page scale unit.
                const targetUnit = takeoff.unit || page.scaleConfig?.unit || currentScale.unit;
                const convertedVal = convertUnit(realVal, currentScale.unit, targetUnit.replace('sq ', ''), takeoff.type as 'length' | 'area' | 'count');
                
                pageRealValue += convertedVal;
                pageUnit = targetUnit.startsWith('sq ') ? targetUnit : (takeoff.type === 'area' && !targetUnit.startsWith('sq ') ? `sq ${targetUnit}` : targetUnit);
              }
            }
          });

          if (pageRealValue > 0) {
            totalRealValue += pageRealValue;
            if (!displayUnit) displayUnit = pageUnit;
            
            pageBreakdown.push({
              pageId: page.id,
              pageName: page.name,
              realValue: pageRealValue,
              unit: pageUnit
            });
          }
        }
      });

      return {
        ...takeoff,
        totalRealValue,
        unit: takeoff.unit || displayUnit, // Keep the original unit if it was set, otherwise use the detected one
        pageBreakdown
      };
    });
  };

  const handleToggleStatus = async (field: 'submitted' | 'responded' | 'accepted') => {
    if (!project) return;
    
    const updatedProject = {
      ...project,
      [field]: !project[field]
    };
    
    await saveProject(updatedProject);
    setProject(updatedProject);
  };

  const handleSaveDueDate = async () => {
    if (!project) return;
    const updatedProject = {
      ...project,
      bidDueDate: editDueDate ? new Date(editDueDate).getTime() : undefined
    };
    await saveProject(updatedProject);
    setProject(updatedProject);
    setIsEditingDueDate(false);
  };

  const handleSaveAddress = async () => {
    if (!project) return;
    const updatedProject = {
      ...project,
      address: editAddress || undefined
    };
    await saveProject(updatedProject);
    setProject(updatedProject);
    setIsEditingAddress(false);
  };

  const handleSaveContractor = async () => {
    if (!project) return;
    const updatedProject = {
      ...project,
      contractor: editContractor || undefined
    };
    await saveProject(updatedProject);
    setProject(updatedProject);
    setIsEditingContractor(false);
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

  const filteredPages = useMemo(() => {
    if (!project) return [];

    let allowedPlanSets = project.planSets || [];
    
    if (selectedPlanSetId) {
      const selectedPlanSet = allowedPlanSets.find(ps => ps.id === selectedPlanSetId);
      if (selectedPlanSet) {
        allowedPlanSets = allowedPlanSets.filter(ps => {
          if (!ps.date || !selectedPlanSet.date) return ps.createdAt <= selectedPlanSet.createdAt;
          if (ps.date === selectedPlanSet.date) return ps.createdAt <= selectedPlanSet.createdAt;
          return ps.date < selectedPlanSet.date;
        });
      }
    }

    const allowedPlanSetIds = new Set(allowedPlanSets.map(ps => ps.id));
    
    const candidatePages = project.pages.filter(page => 
      !page.planSetId || allowedPlanSetIds.has(page.planSetId)
    );

    const latestPagesMap = new Map<string, typeof project.pages[0]>();

    candidatePages.forEach(page => {
      const key = page.pageNumber ? page.pageNumber.trim().toLowerCase() : page.id;
      const existingPage = latestPagesMap.get(key);

      if (!existingPage) {
        latestPagesMap.set(key, page);
      } else {
        const existingPlanSet = allowedPlanSets.find(ps => ps.id === existingPage.planSetId);
        const currentPlanSet = allowedPlanSets.find(ps => ps.id === page.planSetId);

        if (existingPlanSet && currentPlanSet) {
          const isNewer = currentPlanSet.date && existingPlanSet.date 
            ? (currentPlanSet.date > existingPlanSet.date || (currentPlanSet.date === existingPlanSet.date && currentPlanSet.createdAt > existingPlanSet.createdAt))
            : currentPlanSet.createdAt > existingPlanSet.createdAt;

          if (isNewer) {
            latestPagesMap.set(key, page);
          }
        } else if (!existingPlanSet && currentPlanSet) {
          latestPagesMap.set(key, page);
        }
      }
    });

    const searchLower = searchTerm.toLowerCase();
    return Array.from(latestPagesMap.values()).filter(page => {
      const matchesSearch = page.name.toLowerCase().includes(searchLower) || 
                            (page.pageNumber && page.pageNumber.toLowerCase().includes(searchLower)) ||
                            (page.description && page.description.toLowerCase().includes(searchLower)) ||
                            (page.extractedText && page.extractedText.toLowerCase().includes(searchLower));
      return matchesSearch;
    }).sort((a, b) => {
      const nameA = a.pageNumber || a.name || '';
      const nameB = b.pageNumber || b.name || '';
      return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' });
    });
  }, [project, selectedPlanSetId, searchTerm]);

  const handleSaveProjectName = async () => {
    if (!project || !editProjectName.trim()) return;
    
    try {
      const updatedProject = { ...project, name: editProjectName.trim() };
      await saveProject(updatedProject);
      setProject(updatedProject);
      setIsEditingProjectName(false);
    } catch (error) {
      console.error('Failed to update project name:', error);
      alert('Failed to update project name. Please try again.');
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex justify-center items-center">
        <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!project) return null;

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-8 font-sans">
      <div className="max-w-5xl mx-auto">
        <Link to="/" className="inline-flex items-center gap-2 text-slate-500 hover:text-slate-800 mb-4 md:mb-6 transition-colors font-medium text-sm md:text-base">
          <ArrowLeft size={18} />
          Back to Projects
        </Link>
        
        <div className="flex flex-col md:flex-row justify-between items-start md:items-end mb-6 md:mb-8 gap-4 md:gap-6">
          <div className="w-full">
            {isEditingProjectName ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={editProjectName}
                  onChange={(e) => setEditProjectName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveProjectName();
                    if (e.key === 'Escape') setIsEditingProjectName(false);
                  }}
                  className="text-xl md:text-3xl font-bold text-slate-900 border-b-2 border-blue-500 focus:outline-none bg-transparent px-1 min-w-[300px]"
                  autoFocus
                />
                <button
                  onClick={handleSaveProjectName}
                  className="p-1.5 text-green-600 hover:bg-green-50 rounded-lg transition-colors"
                >
                  <Check size={20} />
                </button>
                <button
                  onClick={() => setIsEditingProjectName(false)}
                  className="p-1.5 text-slate-400 hover:bg-slate-100 rounded-lg transition-colors"
                >
                  <X size={20} />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-3 group">
                <h1 className="text-xl md:text-3xl font-bold text-slate-900 break-words leading-tight">{project.name}</h1>
                <button
                  onClick={() => {
                    setEditProjectName(project.name);
                    setIsEditingProjectName(true);
                  }}
                  className="p-1.5 text-slate-400 hover:text-blue-600 opacity-0 group-hover:opacity-100 transition-all rounded-lg hover:bg-blue-50"
                  title="Edit project name"
                >
                  <Edit2 size={18} />
                </button>
              </div>
            )}
            
            <div className="flex flex-wrap gap-2 mt-3 md:mt-4">
              <button
                onClick={() => handleToggleStatus('submitted')}
                className={`px-2.5 py-1 rounded-full text-[10px] md:text-xs font-bold uppercase tracking-wider transition-all border ${
                  project.submitted 
                    ? 'bg-blue-600 text-white border-blue-600 shadow-sm' 
                    : 'bg-white text-slate-400 border-slate-200 hover:border-blue-300 hover:text-blue-500'
                }`}
              >
                Submitted
              </button>
              <button
                onClick={() => handleToggleStatus('responded')}
                className={`px-2.5 py-1 rounded-full text-[10px] md:text-xs font-bold uppercase tracking-wider transition-all border ${
                  project.responded 
                    ? 'bg-amber-500 text-white border-amber-500 shadow-sm' 
                    : 'bg-white text-slate-400 border-slate-200 hover:border-amber-300 hover:text-amber-500'
                }`}
              >
                Responded
              </button>
              <button
                onClick={() => handleToggleStatus('accepted')}
                className={`px-2.5 py-1 rounded-full text-[10px] md:text-xs font-bold uppercase tracking-wider transition-all border ${
                  project.accepted 
                    ? 'bg-emerald-500 text-white border-emerald-500 shadow-sm' 
                    : 'bg-white text-slate-400 border-slate-200 hover:border-emerald-300 hover:text-emerald-500'
                }`}
              >
                Accepted
              </button>
              <button
                onClick={() => projectId && openNotes(projectId)}
                className="px-3 py-1 rounded-full text-[10px] md:text-xs font-bold uppercase tracking-wider transition-all border bg-white text-blue-600 border-blue-200 hover:border-blue-400 hover:bg-blue-50 flex items-center gap-1.5 shadow-sm"
              >
                <StickyNote size={14} />
                Notes Board
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:flex lg:flex-wrap lg:items-center gap-3 md:gap-4 mt-4 text-xs md:text-sm text-slate-500">
              <div className="flex items-center gap-2 bg-white/50 p-2 rounded-lg lg:bg-transparent lg:p-0">
                <Calendar size={14} className="text-slate-400 flex-shrink-0" />
                <span className="truncate">Created {new Date(project.createdAt).toLocaleDateString()}</span>
              </div>
              
              <div className="flex items-center gap-2 bg-white/50 p-2 rounded-lg lg:bg-transparent lg:p-0">
                <Building2 size={14} className="text-slate-400 flex-shrink-0" />
                {isEditingContractor ? (
                  <div className="flex items-center gap-1 flex-1">
                    <input
                      type="text"
                      value={editContractor}
                      onChange={(e) => setEditContractor(e.target.value)}
                      placeholder="Contractor"
                      className="w-full border border-slate-300 rounded px-1.5 py-0.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <button onClick={handleSaveContractor} className="text-green-600 hover:bg-green-50 p-1 rounded">
                      <Check size={14} />
                    </button>
                    <button onClick={() => setIsEditingContractor(false)} className="text-slate-400 hover:bg-slate-100 p-1 rounded">
                      <X size={14} />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 group flex-1 min-w-0">
                    <span className="truncate">{project.contractor || 'No contractor'}</span>
                    <button 
                      onClick={() => {
                        setEditContractor(project.contractor || '');
                        setIsEditingContractor(true);
                      }}
                      className="text-slate-400 hover:text-blue-500 transition-opacity p-1"
                    >
                      <Edit2 size={12} />
                    </button>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2 bg-white/50 p-2 rounded-lg lg:bg-transparent lg:p-0">
                <MapPin size={14} className="text-slate-400 flex-shrink-0" />
                {isEditingAddress ? (
                  <div className="flex items-center gap-1 flex-1">
                    <AddressAutocomplete
                      value={editAddress}
                      onChange={setEditAddress}
                      placeholder="Address"
                    />
                    <button onClick={handleSaveAddress} className="text-green-600 hover:bg-green-50 p-1 rounded">
                      <Check size={14} />
                    </button>
                    <button onClick={() => setIsEditingAddress(false)} className="text-slate-400 hover:bg-slate-100 p-1 rounded">
                      <X size={14} />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 group flex-1 min-w-0">
                    {project.address ? (
                      <a 
                        href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(project.address)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:text-blue-600 hover:underline transition-colors truncate"
                      >
                        {project.address}
                      </a>
                    ) : (
                      <span className="truncate">No address</span>
                    )}
                    <button 
                      onClick={() => {
                        setEditAddress(project.address || '');
                        setIsEditingAddress(true);
                      }}
                      className="text-slate-400 hover:text-blue-500 transition-opacity p-1"
                    >
                      <Edit2 size={12} />
                    </button>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2 bg-white/50 p-2 rounded-lg lg:bg-transparent lg:p-0">
                <Clock size={14} className="text-slate-400 flex-shrink-0" />
                {isEditingDueDate ? (
                  <div className="flex items-center gap-1 flex-1">
                    <input
                      type="date"
                      value={editDueDate}
                      onChange={(e) => setEditDueDate(e.target.value)}
                      className="w-full border border-slate-300 rounded px-1.5 py-0.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <button onClick={handleSaveDueDate} className="text-green-600 hover:bg-green-50 p-1 rounded">
                      <Check size={14} />
                    </button>
                    <button onClick={() => setIsEditingDueDate(false)} className="text-slate-400 hover:bg-slate-100 p-1 rounded">
                      <X size={14} />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 group flex-1 min-w-0">
                    <span className={`${getDueDateColor()} truncate`}>
                      Due: {project.bidDueDate ? new Date(project.bidDueDate).toLocaleDateString() : 'Not set'}
                    </span>
                    <button 
                      onClick={() => {
                        setEditDueDate(project.bidDueDate ? new Date(project.bidDueDate).toISOString().split('T')[0] : '');
                        setIsEditingDueDate(true);
                      }}
                      className="text-slate-400 hover:text-blue-600 transition-opacity p-1"
                    >
                      <Edit2 size={12} />
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
          {project.planSets && project.planSets.length > 0 && (
            <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-lg px-3 py-2 shadow-sm w-full md:w-auto mt-2 md:mt-0">
              <span className="text-xs md:text-sm text-slate-500 font-medium whitespace-nowrap">Plan Set:</span>
              <select
                value={selectedPlanSetId}
                onChange={(e) => setSelectedPlanSetId(e.target.value)}
                className="bg-transparent text-xs md:text-sm font-medium text-slate-700 outline-none w-full"
              >
                <option value="">All Plan Sets</option>
                {project.planSets.map(ps => (
                  <option key={ps.id} value={ps.id}>
                    {ps.name} {ps.date ? `(${ps.date})` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-200 mb-6 overflow-x-auto no-scrollbar -mx-4 px-4 md:mx-0 md:px-0">
          <button
            onClick={() => setActiveTab('pages')}
            className={`px-4 md:px-6 py-3 text-sm font-medium transition-colors relative whitespace-nowrap ${
              activeTab === 'pages' ? 'text-blue-600' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            Pages
            {activeTab === 'pages' && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600" />
            )}
          </button>
          <button
            onClick={() => setActiveTab('takeoffs')}
            className={`px-4 md:px-6 py-3 text-sm font-medium transition-colors relative whitespace-nowrap ${
              activeTab === 'takeoffs' ? 'text-blue-600' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            Takeoffs
            {activeTab === 'takeoffs' && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600" />
            )}
          </button>
          <button
            onClick={() => setActiveTab('printouts')}
            className={`px-4 md:px-6 py-3 text-sm font-medium transition-colors relative whitespace-nowrap ${
              activeTab === 'printouts' ? 'text-blue-600' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            Printouts
            {activeTab === 'printouts' && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-600" />
            )}
          </button>
        </div>

        {activeTab === 'pages' ? (
          <div className="space-y-6">
            <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4">
              <div className="relative flex-1 w-full max-w-md">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                <input
                  type="text"
                  placeholder="Search pages and text..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full pl-10 pr-4 py-2.5 bg-white border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-sm"
                />
              </div>
              <div className="flex flex-wrap gap-2 w-full lg:w-auto">
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
                  className="flex-1 lg:flex-none px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors flex items-center justify-center gap-2 shadow-sm"
                >
                  <Plus size={16} />
                  Add Pages
                </button>
              </div>
            </div>

            {filteredPages.length === 0 ? (
              <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center">
                <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mx-auto mb-4 text-slate-400">
                  <FileImage size={32} />
                </div>
                <h3 className="text-lg font-semibold text-slate-900 mb-1">No pages found</h3>
                <p className="text-slate-500 text-sm max-w-xs mx-auto">
                  {searchTerm ? `No pages match your search "${searchTerm}"` : 'This plan set has no pages yet. Add some to get started.'}
                </p>
                {!searchTerm && (
                  <button
                    onClick={() => setShowAddPagesModal(true)}
                    className="mt-6 px-4 py-2 text-blue-600 font-medium hover:bg-blue-50 rounded-lg transition-colors"
                  >
                    Add your first page
                  </button>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                {filteredPages.map((page) => (
                  <Link
                    key={page.id}
                    to={`/project/${project.id}/page/${page.id}${searchTerm ? `?search=${encodeURIComponent(searchTerm)}` : ''}`}
                    state={{ pageIds: filteredPages.map(p => p.id) }}
                    className="bg-white rounded-xl border border-slate-200 overflow-hidden hover:shadow-md transition-all hover:border-blue-300 flex flex-col group"
                  >
                    <div className="h-40 bg-slate-100 relative overflow-hidden border-b border-slate-200">
                      <img 
                        src={getImageUrl(page.thumbnailId || page.imageId)} 
                        alt={page.name} 
                        className="w-full h-full object-cover object-top opacity-90 group-hover:opacity-100 transition-opacity"
                        referrerPolicy="no-referrer"
                      />
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
                                className="w-full border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
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
                                className="w-full border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
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
                            <h3 className="font-semibold text-slate-900 group-hover:text-blue-600 transition-colors line-clamp-1">{page.name}</h3>
                            <button 
                              onClick={(e) => handleStartRenamePage(e, page)}
                              className="text-slate-400 hover:text-blue-600 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-blue-50"
                            >
                              <Edit2 size={14} />
                            </button>
                          </div>
                        )}
                        <p className="text-sm text-slate-500">
                          {page.measurements.length} highlights
                        </p>
                        {searchTerm && page.extractedText && page.extractedText.toLowerCase().includes(searchTerm.toLowerCase()) && !page.name.toLowerCase().includes(searchTerm.toLowerCase()) && (
                          <div className="mt-2 text-xs text-slate-500 bg-slate-50 p-2 rounded border border-slate-100 line-clamp-2 italic">
                            ...{page.extractedText.substring(Math.max(0, page.extractedText.toLowerCase().indexOf(searchTerm.toLowerCase()) - 30), page.extractedText.toLowerCase().indexOf(searchTerm.toLowerCase()) + searchTerm.length + 30)}...
                          </div>
                        )}
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        ) : activeTab === 'takeoffs' ? (
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
            <div className="p-4 md:p-6 border-b border-slate-100 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-slate-50/50">
              <h2 className="text-xl font-bold text-slate-800">Takeoffs Inventory</h2>
              <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
                {selectedTakeoffIds.size > 0 && (
                  <div className="flex items-center gap-2 w-full sm:w-auto">
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
                      className="flex-1 sm:flex-none px-3 py-2 bg-blue-600 text-white rounded-lg text-xs font-medium hover:bg-blue-700 transition-colors flex items-center justify-center gap-2 shadow-sm disabled:opacity-50"
                    >
                      {isExportingExcel ? <Loader2 size={14} className="animate-spin" /> : <FileSpreadsheet size={14} />}
                      Excel ({selectedTakeoffIds.size})
                    </button>
                  </div>
                )}
                <div className="flex items-center gap-2 w-full sm:w-auto">
                  {project.takeoffs.length > 0 && (
                    <button
                      onClick={() => setShowDeleteAllConfirm(true)}
                      className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                      title="Delete All Takeoffs"
                    >
                      <Trash2 size={20} />
                    </button>
                  )}
                  <button
                    onClick={() => setShowTakeoffModal(true)}
                    className="flex-1 sm:flex-none px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors flex items-center justify-center gap-2 shadow-sm"
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
                  <tr className="bg-slate-50 text-left text-[10px] font-bold text-slate-500 uppercase tracking-widest border-b border-slate-200">
                    <th className="px-6 py-4 w-10">
                      <input 
                        type="checkbox" 
                        className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
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
                <tbody className="divide-y divide-slate-100">
                  {getTakeoffTotals().map(takeoff => {
                    const totalCost = calculateTakeoffTotalCost(takeoff, takeoff.totalRealValue);
                    const costDetails = calculateTakeoffCostDetails(takeoff, takeoff.totalRealValue);

                    return (
                      <React.Fragment key={takeoff.id}>
                        <tr className="hover:bg-slate-50/80 transition-colors group">
                          <td className="px-6 py-4">
                            <input 
                              type="checkbox" 
                              className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
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
                              <span className="font-semibold text-slate-900">{takeoff.name}</span>
                            </div>
                          </td>
                          <td className="px-6 py-4 text-sm text-slate-500 capitalize font-medium">
                            {takeoff.type}
                          </td>
                          <td className="px-6 py-4 text-right font-bold text-slate-900">
                            {takeoff.totalRealValue > 0 ? formatRealValue(takeoff.totalRealValue, takeoff.type as 'length' | 'area' | 'count', takeoff.unit?.replace('sq ', '') || 'ft', takeoff, false) : '-'}
                          </td>
                          <td className="px-6 py-4 text-right text-sm text-slate-600 font-medium">
                            {takeoff.isAdvancedCost ? (
                              <div className="flex flex-col items-end">
                                <span className="text-blue-600 font-bold">${(totalCost / (takeoff.totalRealValue || 1)).toFixed(2)}</span>
                                <span className="text-[10px] text-slate-400 uppercase">Avg / Unit</span>
                              </div>
                            ) : (
                              takeoff.costPerUnit ? `$${takeoff.costPerUnit.toFixed(2)}` : '-'
                            )}
                          </td>
                          <td className="px-6 py-4 text-right font-bold text-blue-600">
                            <div className="flex flex-col items-end">
                              <span>{totalCost > 0 ? `$${totalCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '-'}</span>
                              {takeoff.isAdvancedCost && costDetails.map((d, i) => (
                                d.quantity !== undefined && d.quantity > 0 && (
                                  <span key={i} className="text-[10px] text-slate-500 font-normal">
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
                                className="text-slate-400 hover:text-blue-600 p-2 rounded-lg hover:bg-blue-50 transition-colors"
                                title="Edit Takeoff"
                              >
                                <Edit2 size={16} />
                              </button>
                              <button 
                                onClick={() => handleDeleteTakeoff(takeoff.id)} 
                                className="text-slate-400 hover:text-red-600 p-2 rounded-lg hover:bg-red-50 transition-colors"
                                title="Delete Takeoff"
                              >
                                <Trash2 size={16} />
                              </button>
                            </div>
                          </td>
                        </tr>
                        {expandedTakeoffs[takeoff.id] && (
                          <tr>
                            <td colSpan={11} className="px-0 py-0 bg-slate-50/30">
                              <div className="border-l-4 border-blue-500/20 ml-6 my-2 divide-y divide-slate-100">
                                {takeoff.pageBreakdown.map(pb => (
                                  <div key={pb.pageId} className="py-3 pl-8 pr-12 flex justify-between items-center hover:bg-white transition-colors">
                                    <Link 
                                      to={`/project/${project.id}/page/${pb.pageId}${searchTerm ? `?search=${encodeURIComponent(searchTerm)}` : ''}`} 
                                      state={{ pageIds: takeoff.pageBreakdown.map(p => p.pageId) }}
                                      className="text-sm text-blue-600 hover:text-blue-800 font-semibold flex items-center gap-2"
                                    >
                                      <FileImage size={14} className="text-slate-400" />
                                      {pb.pageName}
                                    </Link>
                                    <span className="text-sm font-bold text-slate-700">
                                      {formatRealValue(pb.realValue, takeoff.type as 'length' | 'area' | 'count', pb.unit?.replace('sq ', '') || 'ft', takeoff, false)}
                                    </span>
                                  </div>
                                ))}
                                {takeoff.pageBreakdown.length === 0 && (
                                  <div className="py-4 pl-8 text-sm text-slate-400 italic">No measurements found for this takeoff.</div>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile Takeoff Cards */}
            <div className="md:hidden divide-y divide-slate-100">
              {getTakeoffTotals().map(takeoff => {
                const totalCostPerUnit = takeoff.isAdvancedCost && takeoff.customCosts 
                  ? takeoff.customCosts.reduce((sum, item) => sum + item.costPerUnit, 0)
                  : (takeoff.costPerUnit || 0);
                const totalCost = takeoff.totalRealValue * totalCostPerUnit;

                return (
                  <div key={takeoff.id} className="p-4 bg-white">
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <input 
                          type="checkbox" 
                          className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                          checked={selectedTakeoffIds.has(takeoff.id)}
                          onChange={() => toggleTakeoffSelection(takeoff.id)}
                        />
                        <div className="w-3 h-3 rounded-full shadow-sm shrink-0" style={{ backgroundColor: takeoff.color }} />
                        <span className="font-bold text-slate-900">{takeoff.name}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <button 
                          onClick={() => handleEditTakeoff(takeoff)} 
                          className="p-1.5 text-slate-400 hover:text-blue-600"
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
                      <div className="text-slate-500">Type</div>
                      <div className="text-slate-900 font-medium capitalize text-right">{takeoff.type}</div>
                      
                      <div className="text-slate-500">Quantity</div>
                      <div className="text-slate-900 font-bold text-right">
                        {takeoff.totalRealValue > 0 ? formatRealValue(takeoff.totalRealValue, takeoff.type as 'length' | 'area' | 'count', takeoff.unit?.replace('sq ', '') || 'ft', takeoff, false) : '-'}
                      </div>
                      
                      <div className="text-slate-500">Total Cost</div>
                      <div className="text-blue-600 font-bold text-right">
                        {totalCost > 0 ? `$${totalCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '-'}
                      </div>
                    </div>

                    <button 
                      onClick={() => toggleTakeoffExpanded(takeoff.id)}
                      className="w-full py-2 bg-slate-50 rounded-lg text-xs font-semibold text-slate-600 flex items-center justify-center gap-2"
                    >
                      {expandedTakeoffs[takeoff.id] ? 'Hide' : 'Show'} Page Breakdown
                      <div className={`transition-transform duration-200 ${expandedTakeoffs[takeoff.id] ? 'rotate-90' : ''}`}>
                        <ChevronRight size={14} />
                      </div>
                    </button>

                    {expandedTakeoffs[takeoff.id] && (
                      <div className="mt-3 space-y-2 pt-3 border-t border-slate-100">
                        {takeoff.pageBreakdown.map(pb => (
                          <div key={pb.pageId} className="flex justify-between items-center text-xs">
                            <Link 
                              to={`/project/${project.id}/page/${pb.pageId}${searchTerm ? `?search=${encodeURIComponent(searchTerm)}` : ''}`} 
                              className="text-blue-600 font-medium"
                            >
                              {pb.pageName}
                            </Link>
                            <span className="font-bold text-slate-700">
                              {formatRealValue(pb.realValue, takeoff.type as 'length' | 'area' | 'count', pb.unit?.replace('sq ', '') || 'ft', takeoff, false)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {project.takeoffs.length === 0 && (
              <div className="px-6 py-12 text-center text-slate-500">
                No takeoffs created yet. <button onClick={() => setShowTakeoffModal(true)} className="text-blue-600 font-bold hover:underline">Create one</button> to start estimating.
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-6">
            <div className="flex justify-between items-center">
              <h2 className="text-xl font-bold text-slate-800">Generated Printouts</h2>
              <p className="text-sm text-slate-500">
                {project.printouts?.length || 0} files saved
              </p>
            </div>

            {(!project.printouts || project.printouts.length === 0) ? (
              <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center">
                <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mx-auto mb-4 text-slate-400">
                  <Printer size={32} />
                </div>
                <h3 className="text-lg font-semibold text-slate-900 mb-1">No printouts yet</h3>
                <p className="text-slate-500 text-sm max-w-xs mx-auto">
                  Select takeoffs from the Takeoffs tab and click "Print PDF" or "Export Excel" to generate a report.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {[...(project.printouts || [])].sort((a, b) => b.createdAt - a.createdAt).map((printout) => (
                  <div key={printout.id} className="bg-white rounded-xl border border-slate-200 overflow-hidden hover:shadow-md transition-all group">
                    <div className="p-6">
                      <div className="flex items-start justify-between mb-4">
                        <div className={`w-12 h-12 ${printout.type === 'excel' ? 'bg-emerald-50 text-emerald-600' : 'bg-blue-50 text-blue-600'} rounded-xl flex items-center justify-center`}>
                          {printout.type === 'excel' ? <FileSpreadsheet size={24} /> : <FileText size={24} />}
                        </div>
                        <div className="flex items-center gap-1">
                          <button 
                            onClick={() => handleViewPrintout(printout)}
                            className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                            title={printout.type === 'excel' ? "Download Excel" : "View PDF"}
                          >
                            {printout.type === 'excel' ? <Download size={18} /> : <Eye size={18} />}
                          </button>
                          <button 
                            onClick={() => handleDownloadPrintout(printout)}
                            className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                            title={printout.type === 'excel' ? "Download Excel" : "Download PDF"}
                          >
                            <Download size={18} />
                          </button>
                          <button 
                            onClick={() => handleDeletePrintout(printout.id)}
                            className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                            title="Delete Printout"
                          >
                            <Trash2 size={18} />
                          </button>
                        </div>
                      </div>
                      <h3 className="font-semibold text-slate-900 mb-1 line-clamp-1">{printout.name}</h3>
                      <p className="text-xs text-slate-500">
                        Generated on {new Date(printout.createdAt).toLocaleString()}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
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

      {showDeletePrintoutConfirm && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-[60]">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
            <div className="p-6 border-b border-slate-100">
              <h3 className="text-lg font-semibold text-slate-900">Delete Printout</h3>
            </div>
            <div className="p-6">
              <p className="text-slate-600">
                Are you sure you want to delete this printout? This action cannot be undone.
              </p>
            </div>
            <div className="p-6 border-t border-slate-100 bg-slate-50 flex justify-end gap-3">
              <button
                onClick={() => { setShowDeletePrintoutConfirm(false); setPrintoutToDelete(null); }}
                className="px-5 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-200 rounded-xl transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDeletePrintout}
                className="px-5 py-2.5 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-xl transition-colors shadow-sm"
              >
                Delete Printout
              </button>
            </div>
          </div>
        </div>
      )}

      {showTakeoffModal && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
            <div className="p-6 border-b border-slate-100">
              <h3 className="text-lg font-semibold text-slate-900">Create Measurement Takeoff</h3>
            </div>
            <div className="p-6 space-y-4">
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
                      onClick={() => setNewTakeoffCustomCosts([...newTakeoffCustomCosts, { id: uuidv4(), name: '', type: 'unit', costPerUnit: 0 }])}
                      className="text-blue-600 hover:text-blue-700 p-1 rounded-full hover:bg-blue-50 transition-colors"
                      title="Add Cost Item"
                    >
                      <Plus size={16} />
                    </button>
                  </div>
                  
                  {newTakeoffCustomCosts.length === 0 ? (
                    <p className="text-xs text-slate-400 italic text-center py-2">No custom items added. Click + to add.</p>
                  ) : (
                    <div className="space-y-3">
                      {newTakeoffCustomCosts.map((item, index) => (
                        <CustomCostRow
                          key={item.id}
                          item={item}
                          index={index}
                          unitLabel={UNIT_LABELS[newTakeoffUnit] || newTakeoffUnit || (newTakeoffType === 'area' ? 'sq ft' : newTakeoffType === 'length' ? 'ft' : 'ea')}
                          onChange={(idx, updated) => {
                            const newCosts = [...newTakeoffCustomCosts];
                            newCosts[idx] = updated;
                            setNewTakeoffCustomCosts(newCosts);
                          }}
                          onRemove={(idx) => {
                            setNewTakeoffCustomCosts(newTakeoffCustomCosts.filter((_, i) => i !== idx));
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
                onClick={() => setShowTakeoffModal(false)}
                className="px-5 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-200 rounded-xl transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateTakeoff}
                disabled={!newTakeoffName}
                className="px-5 py-2.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl transition-colors shadow-sm"
              >
                Create Takeoff
              </button>
            </div>
          </div>
        </div>
      )}

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
                      onClick={() => setEditTakeoffCustomCosts([...editTakeoffCustomCosts, { id: uuidv4(), name: '', type: 'unit', costPerUnit: 0 }])}
                      className="text-blue-600 hover:text-blue-700 p-1 rounded-full hover:bg-blue-50 transition-colors"
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
                className="px-5 py-2.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl transition-colors shadow-sm"
              >
                Save Changes
              </button>
            </div>
          </div>
        </div>
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
                      className={`px-4 py-1.5 text-xs font-semibold rounded-md transition-all ${!useExistingPlanSet ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
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
                      className={`px-4 py-1.5 text-xs font-semibold rounded-md transition-all ${useExistingPlanSet ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
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
                        className="w-full border border-slate-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
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
                          className="w-full border border-slate-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
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
                          className="w-full border border-slate-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
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
                        newPlanSetFiles.length > 0 ? 'border-blue-300 bg-blue-50' : 'border-slate-300 hover:border-blue-400 bg-slate-50 hover:bg-slate-100 cursor-pointer'
                      }`}
                      onClick={() => !isAddingPages && newPlanSetFiles.length === 0 && fileInputRef.current?.click()}
                    >
                      {newPlanSetFiles.length > 0 ? (
                        <div className="flex flex-col items-center w-full">
                          <div className="w-full space-y-2 mb-3">
                            {newPlanSetFiles.map((file, index) => (
                              <div key={`${file.name}-${index}`} className="flex items-center justify-between bg-white p-2 rounded-lg border border-blue-200 shadow-sm">
                                <div className="flex items-center gap-2 overflow-hidden">
                                  <FileImage size={16} className="text-blue-500 shrink-0" />
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
                              className="mt-1 text-sm text-blue-600 hover:text-blue-700 font-medium flex items-center gap-1"
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
                    className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl transition-colors shadow-sm"
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
              <div className="flex flex-col overflow-hidden">
                <div className="p-6 overflow-y-auto">
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                    {pendingPages.map((page, index) => (
                      <div key={page.id} className="bg-white rounded-2xl border-2 border-slate-100 overflow-hidden flex flex-col shadow-sm hover:shadow-md transition-all duration-300">
                        {/* Thumbnail Section */}
                        <div 
                          className="h-48 bg-slate-100 relative flex-shrink-0 border-b border-slate-100 cursor-pointer overflow-hidden group"
                          onClick={() => setPreviewPageId(page.id)}
                        >
                          {pendingThumbnails[page.imageId] ? (
                            <img 
                              src={pendingThumbnails[page.imageId]} 
                              alt={`Page ${index + 1}`}
                              className="w-full h-full object-contain transition-transform duration-500 group-hover:scale-110"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-slate-400">
                              <Loader2 size={32} className="animate-spin" />
                            </div>
                          )}
                          
                          {/* Hover Overlay */}
                          <div className="absolute inset-0 bg-blue-600/0 group-hover:bg-blue-600/40 transition-all duration-300 flex flex-col items-center justify-center gap-3">
                            <div className="w-12 h-12 rounded-full bg-white/20 backdrop-blur-md flex items-center justify-center text-white opacity-0 group-hover:opacity-100 scale-50 group-hover:scale-100 transition-all duration-300">
                              <Eye size={24} />
                            </div>
                            <span className="text-white text-[10px] font-black uppercase tracking-[0.2em] opacity-0 group-hover:opacity-100 transition-all duration-300 translate-y-2 group-hover:translate-y-0">
                              Click to Preview
                            </span>
                          </div>

                          {/* Page Badge */}
                          <div className="absolute top-3 left-3 bg-white/90 backdrop-blur-md text-blue-600 text-[10px] font-black px-2.5 py-1.5 rounded-lg shadow-sm border border-blue-100">
                            PAGE {index + 1}
                          </div>
                        </div>

                        {/* Input Section */}
                        <div className="p-5 space-y-5">
                          <div className="space-y-2">
                            <div className="flex items-center justify-between px-1">
                              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Page Number</label>
                              {page.pageNumber && <Check size={12} className="text-green-500" />}
                            </div>
                            <div className="relative">
                              <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                                <Hash size={14} />
                              </div>
                              <input
                                type="text"
                                value={page.pageNumber || ''}
                                onChange={(e) => updatePendingPageField(page.id, 'pageNumber', e.target.value)}
                                className="w-full pl-10 pr-4 py-3 rounded-xl border-2 border-slate-100 bg-slate-50 focus:bg-white focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all text-sm font-bold text-slate-800 placeholder:text-slate-300 placeholder:font-normal"
                                placeholder="e.g. A-101"
                              />
                            </div>
                          </div>

                          <div className="space-y-2">
                            <div className="flex items-center justify-between px-1">
                              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Description</label>
                              {page.description && <Check size={12} className="text-green-500" />}
                            </div>
                            <div className="relative">
                              <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                                <FileText size={14} />
                              </div>
                              <input
                                type="text"
                                value={page.description || ''}
                                onChange={(e) => updatePendingPageField(page.id, 'description', e.target.value)}
                                className="w-full pl-10 pr-4 py-3 rounded-xl border-2 border-slate-100 bg-slate-50 focus:bg-white focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all text-sm font-bold text-slate-800 placeholder:text-slate-300 placeholder:font-normal"
                                placeholder="e.g. Floor Plan"
                              />
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="p-6 border-t border-slate-100 bg-slate-50 flex justify-between items-center">
                  {isNamingExistingPages ? (
                    <button
                      type="button"
                      onClick={() => {
                        setShowAddPagesModal(false);
                        setIsNamingExistingPages(false);
                        setPendingPages([]);
                        setPendingThumbnails({});
                      }}
                      disabled={isAddingPages}
                      className="inline-flex items-center gap-2 text-slate-500 hover:text-slate-800 transition-colors font-medium"
                    >
                      <X size={16} />
                      Cancel
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setAddPagesStep('details')}
                      disabled={isAddingPages}
                      className="inline-flex items-center gap-2 text-slate-500 hover:text-slate-800 transition-colors font-medium"
                    >
                      <ArrowLeft size={16} />
                      Back
                    </button>
                  )}
                  <button
                    onClick={handleConfirmAddPages}
                    disabled={isAddingPages}
                    className="flex items-center gap-2 px-6 py-2.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl transition-colors shadow-sm"
                  >
                    {isAddingPages ? (
                      <><Loader2 size={16} className="animate-spin" /> Saving...</>
                    ) : (
                      <><Check size={16} /> {isNamingExistingPages ? 'Save Changes' : 'Add Pages'}</>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {previewPageId && (
        <div className="fixed inset-0 bg-slate-900/90 backdrop-blur-md flex items-center justify-center z-[70] p-4 sm:p-8">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl h-full flex flex-col overflow-hidden">
            <div className="p-4 border-b border-slate-100 flex justify-between items-center bg-slate-50">
              <div className="flex items-center gap-4">
                <button 
                  onClick={() => setPreviewPageId(null)}
                  className="p-2 hover:bg-slate-200 rounded-full transition-colors"
                >
                  <ArrowLeft size={20} />
                </button>
                <h3 className="font-bold text-slate-900">Page Preview & Extraction</h3>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex items-center bg-white border border-slate-200 rounded-lg p-1 mr-2">
                  <button 
                    onClick={() => setZoom(prev => Math.max(1, prev - 0.5))}
                    className="p-1.5 hover:bg-slate-100 rounded text-slate-600 transition-colors"
                    title="Zoom Out"
                  >
                    <ZoomOut size={16} />
                  </button>
                  <span className="text-xs font-bold text-slate-500 w-12 text-center">{Math.round(zoom * 100)}%</span>
                  <button 
                    onClick={() => setZoom(prev => Math.min(5, prev + 0.5))}
                    className="p-1.5 hover:bg-slate-100 rounded text-slate-600 transition-colors"
                    title="Zoom In"
                  >
                    <ZoomIn size={16} />
                  </button>
                  <button 
                    onClick={() => { setZoom(1); setPanOffset({ x: 0, y: 0 }); }}
                    className="p-1.5 hover:bg-slate-100 rounded text-slate-600 transition-colors ml-1 border-l border-slate-100"
                    title="Reset Zoom"
                  >
                    <Maximize size={16} />
                  </button>
                </div>

                <button
                  onClick={() => setExtractionType('pageNumber')}
                  className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${extractionType === 'pageNumber' ? 'bg-blue-600 text-white shadow-md' : 'bg-white text-slate-600 border border-slate-200 hover:border-blue-300'}`}
                >
                  Extract Number
                </button>
                <button
                  onClick={() => setExtractionType('description')}
                  className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${extractionType === 'description' ? 'bg-blue-600 text-white shadow-md' : 'bg-white text-slate-600 border border-slate-200 hover:border-blue-300'}`}
                >
                  Extract Description
                </button>
                <div className="w-px h-6 bg-slate-200 mx-2" />
                <button 
                  onClick={() => setPreviewPageId(null)}
                  className="p-2 text-slate-400 hover:text-slate-600 transition-colors"
                >
                  <X size={24} />
                </button>
              </div>
            </div>
            
            <div 
              className={`flex-grow overflow-hidden relative bg-slate-800 flex items-center justify-center ${isPanning ? 'cursor-grabbing' : zoom > 1 ? 'cursor-grab' : 'cursor-crosshair'}`}
              onWheel={(e) => {
                if (e.ctrlKey || e.metaKey) {
                  e.preventDefault();
                  const zoomDirection = e.deltaY > 0 ? -1 : 1;
                  const zoomFactor = 1.1;
                  const newZoom = Math.min(5, Math.max(1, zoomDirection > 0 ? zoom * zoomFactor : zoom / zoomFactor));
                  
                  if (newZoom !== zoom) {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const centerX = rect.left + rect.width / 2;
                    const centerY = rect.top + rect.height / 2;
                    
                    const mouseX = e.clientX - centerX;
                    const mouseY = e.clientY - centerY;
                    
                    const scaleRatio = newZoom / zoom;
                    
                    setPanOffset({
                      x: mouseX - (mouseX - panOffset.x) * scaleRatio,
                      y: mouseY - (mouseY - panOffset.y) * scaleRatio
                    });
                    
                    setZoom(newZoom);
                  }
                }
              }}
              onMouseMove={(e) => {
                if (isPanning) {
                  setPanOffset({
                    x: e.clientX - panStart.x,
                    y: e.clientY - panStart.y
                  });
                  return;
                }
                
                const rect = imageContainerRef.current?.getBoundingClientRect();
                if (!rect) return;

                if (interactionMode === 'move' && initialRect && selectionStart) {
                  const dx = ((e.clientX - selectionStart.x) / rect.width) * 100;
                  const dy = ((e.clientY - selectionStart.y) / rect.height) * 100;
                  setExtractionRect({
                    ...initialRect,
                    x: Math.max(0, Math.min(100 - initialRect.width, initialRect.x + dx)),
                    y: Math.max(0, Math.min(100 - initialRect.height, initialRect.y + dy))
                  });
                  return;
                }
                
                if (interactionMode && interactionMode.startsWith('resize-') && initialRect && selectionStart) {
                  const dx = ((e.clientX - selectionStart.x) / rect.width) * 100;
                  const dy = ((e.clientY - selectionStart.y) / rect.height) * 100;
                  
                  let newX = initialRect.x;
                  let newY = initialRect.y;
                  let newW = initialRect.width;
                  let newH = initialRect.height;
                  
                  if (interactionMode.includes('w')) {
                    newX = Math.min(initialRect.x + initialRect.width - 1, Math.max(0, initialRect.x + dx));
                    newW = initialRect.x + initialRect.width - newX;
                  }
                  if (interactionMode.includes('e')) {
                    newW = Math.max(1, Math.min(100 - initialRect.x, initialRect.width + dx));
                  }
                  if (interactionMode.includes('n')) {
                    newY = Math.min(initialRect.y + initialRect.height - 1, Math.max(0, initialRect.y + dy));
                    newH = initialRect.y + initialRect.height - newY;
                  }
                  if (interactionMode.includes('s')) {
                    newH = Math.max(1, Math.min(100 - initialRect.y, initialRect.height + dy));
                  }
                  
                  setExtractionRect({ x: newX, y: newY, width: newW, height: newH });
                  return;
                }

                if (isSelecting && selectionStart && interactionMode === 'draw') {
                  const clientX = Math.max(rect.left, Math.min(rect.right, e.clientX));
                  const clientY = Math.max(rect.top, Math.min(rect.bottom, e.clientY));
                  
                  const x = ((clientX - rect.left) / rect.width) * 100;
                  const y = ((clientY - rect.top) / rect.height) * 100;
                  
                  setExtractionRect({
                    x: Math.min(x, selectionStart.x),
                    y: Math.min(y, selectionStart.y),
                    width: Math.abs(x - selectionStart.x),
                    height: Math.abs(y - selectionStart.y)
                  });
                }
              }}
              onMouseUp={() => {
                setIsSelecting(false);
                setIsPanning(false);
                setInteractionMode(null);
              }}
              onMouseLeave={() => {
                setIsSelecting(false);
                setIsPanning(false);
                setInteractionMode(null);
              }}
            >
              <div 
                ref={imageContainerRef}
                className="relative transition-transform duration-200 ease-out"
                style={{ 
                  transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoom})`,
                  transformOrigin: 'center center'
                }}
                onMouseDown={(e) => {
                  if (zoom > 1 && !extractionType) {
                    setIsPanning(true);
                    setPanStart({ x: e.clientX - panOffset.x, y: e.clientY - panOffset.y });
                    return;
                  }
                  if (!extractionType) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const x = ((e.clientX - rect.left) / rect.width) * 100;
                  const y = ((e.clientY - rect.top) / rect.height) * 100;
                  setIsSelecting(true);
                  setInteractionMode('draw');
                  setSelectionStart({ x, y });
                  setExtractionRect({ x, y, width: 0, height: 0 });
                }}
              >
                <img 
                  src={getImageUrl(pendingPages.find(p => p.id === previewPageId)?.imageId || '')} 
                  alt="Preview"
                  className="max-w-full max-h-[80vh] object-contain select-none shadow-2xl"
                  draggable={false}
                />
                {extractionRect && (
                  <div 
                    className="absolute border-2 border-blue-500 bg-blue-500/20 cursor-move pointer-events-auto"
                    style={{
                      left: `${extractionRect.x}%`,
                      top: `${extractionRect.y}%`,
                      width: `${extractionRect.width}%`,
                      height: `${extractionRect.height}%`
                    }}
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      setInteractionMode('move');
                      setSelectionStart({ x: e.clientX, y: e.clientY });
                      setInitialRect({ ...extractionRect });
                    }}
                  >
                    <div className="absolute top-0 left-0 w-4 h-4 bg-white border border-blue-500 cursor-nwse-resize" style={{ transform: `translate(-50%, -50%) scale(${1/zoom})` }} onMouseDown={(e) => { e.stopPropagation(); setInteractionMode('resize-nw'); setSelectionStart({ x: e.clientX, y: e.clientY }); setInitialRect({ ...extractionRect }); }} />
                    <div className="absolute top-0 right-0 w-4 h-4 bg-white border border-blue-500 cursor-nesw-resize" style={{ transform: `translate(50%, -50%) scale(${1/zoom})` }} onMouseDown={(e) => { e.stopPropagation(); setInteractionMode('resize-ne'); setSelectionStart({ x: e.clientX, y: e.clientY }); setInitialRect({ ...extractionRect }); }} />
                    <div className="absolute bottom-0 left-0 w-4 h-4 bg-white border border-blue-500 cursor-nesw-resize" style={{ transform: `translate(-50%, 50%) scale(${1/zoom})` }} onMouseDown={(e) => { e.stopPropagation(); setInteractionMode('resize-sw'); setSelectionStart({ x: e.clientX, y: e.clientY }); setInitialRect({ ...extractionRect }); }} />
                    <div className="absolute bottom-0 right-0 w-4 h-4 bg-white border border-blue-500 cursor-nwse-resize" style={{ transform: `translate(50%, 50%) scale(${1/zoom})` }} onMouseDown={(e) => { e.stopPropagation(); setInteractionMode('resize-se'); setSelectionStart({ x: e.clientX, y: e.clientY }); setInitialRect({ ...extractionRect }); }} />
                  </div>
                )}
                {!extractionType && zoom === 1 && (
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="bg-black/60 text-white px-6 py-3 rounded-xl backdrop-blur-md text-sm font-medium">
                      Select "Extract Number" or "Extract Description" then highlight an area
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="p-6 border-t border-slate-100 bg-slate-50 flex justify-between items-center">
              <div className="flex items-center gap-2 text-sm text-slate-600">
                {extractionRect ? (
                  <>
                    <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                    Area selected. Ready to extract {extractionType === 'pageNumber' ? 'page number' : 'description'}.
                  </>
                ) : (
                  <>
                    <div className="w-2 h-2 rounded-full bg-slate-300" />
                    Select an area to extract text.
                  </>
                )}
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setExtractionRect(null)}
                  disabled={!extractionRect}
                  className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-200 rounded-lg transition-colors disabled:opacity-50 disabled:hover:bg-transparent"
                >
                  Clear Selection
                </button>
                <button
                  onClick={() => handleExtractText(false)}
                  disabled={isExtracting || !extractionRect}
                  className="px-6 py-2 bg-slate-800 text-white rounded-lg text-sm font-bold hover:bg-slate-900 transition-all flex items-center gap-2 disabled:opacity-50"
                >
                  {isExtracting ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
                  Extract Current
                </button>
                <button
                  onClick={() => handleExtractText(true)}
                  disabled={isExtracting || !extractionRect}
                  className="px-6 py-2 bg-blue-600 text-white rounded-lg text-sm font-bold hover:bg-blue-700 transition-all flex items-center gap-2 shadow-lg shadow-blue-200 disabled:opacity-50"
                >
                  {isExtracting ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
                  Extract All Pages
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
