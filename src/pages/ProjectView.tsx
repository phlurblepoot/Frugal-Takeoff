import React, { useEffect, useState, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, FileImage, Settings, Plus, Trash2, ChevronDown, ChevronRight, Edit2, Check, X, Loader2, Upload, Search, Printer, Download, Eye, FileText } from 'lucide-react';
import { Project, MeasurementTakeoff, ProjectPage, Printout, TakeoffTemplate } from '../types';
import { getProject, saveProject, getImage, saveImage, saveFile, getFile, deleteFile, getTemplates } from '../utils/store';
import { calculatePolylineLength, calculatePolygonArea, calculateRealValue, formatRealValue, calculateSurfaceAreaPx, formatMeasurement, convertUnit } from '../utils/math';
import { loadPdfAllPagesAsImages } from '../utils/pdf';
import { v4 as uuidv4 } from 'uuid';
import { jsPDF } from 'jspdf';

export const ProjectView: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [takeoffToDelete, setTakeoffToDelete] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showDeleteAllConfirm, setShowDeleteAllConfirm] = useState(false);
  const [activeTab, setActiveTab] = useState<'pages' | 'takeoffs' | 'printouts'>('pages');
  const [isLoading, setIsLoading] = useState(true);
  const [showTakeoffModal, setShowTakeoffModal] = useState(false);
  const [newTakeoffName, setNewTakeoffName] = useState('');
  const [newTakeoffColor, setNewTakeoffColor] = useState('#3b82f6');
  const [newTakeoffType, setNewTakeoffType] = useState<'length' | 'area' | 'count'>('length');
  const [newTakeoffUnit, setNewTakeoffUnit] = useState('');
  const [newTakeoffCostPerUnit, setNewTakeoffCostPerUnit] = useState<number | ''>('');
  const [newTakeoffLaborPercent, setNewTakeoffLaborPercent] = useState<number | ''>('');
  const [newTakeoffMaterialsPercent, setNewTakeoffMaterialsPercent] = useState<number | ''>('');
  const [newTakeoffEquipmentPercent, setNewTakeoffEquipmentPercent] = useState<number | ''>('');
  const [newTakeoffProfitPercent, setNewTakeoffProfitPercent] = useState<number | ''>('');
  const [templates, setTemplates] = useState<TakeoffTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');

  const [selectedTakeoffIds, setSelectedTakeoffIds] = useState<Set<string>>(new Set());
  const [isPrinting, setIsPrinting] = useState(false);

  const [editingTakeoff, setEditingTakeoff] = useState<MeasurementTakeoff | null>(null);
  const [editTakeoffName, setEditTakeoffName] = useState('');
  const [editTakeoffColor, setEditTakeoffColor] = useState('');
  const [editTakeoffUnit, setEditTakeoffUnit] = useState('');
  const [editTakeoffCostPerUnit, setEditTakeoffCostPerUnit] = useState<number | ''>('');
  const [editTakeoffLaborPercent, setEditTakeoffLaborPercent] = useState<number | ''>('');
  const [editTakeoffMaterialsPercent, setEditTakeoffMaterialsPercent] = useState<number | ''>('');
  const [editTakeoffEquipmentPercent, setEditTakeoffEquipmentPercent] = useState<number | ''>('');
  const [editTakeoffProfitPercent, setEditTakeoffProfitPercent] = useState<number | ''>('');

  const [pageImages, setPageImages] = useState<Record<string, string>>({});
  const [expandedTakeoffs, setExpandedTakeoffs] = useState<Record<string, boolean>>({});
  const [editingPageId, setEditingPageId] = useState<string | null>(null);
  const [editingPageName, setEditingPageName] = useState('');
  const [isAddingPages, setIsAddingPages] = useState(false);
  const [addProgress, setAddProgress] = useState({ current: 0, total: 0, currentFile: 0, totalFiles: 0 });
  const [selectedPlanSetId, setSelectedPlanSetId] = useState<string>('');
  const [showAddPagesModal, setShowAddPagesModal] = useState(false);
  const [addPagesStep, setAddPagesStep] = useState<'details' | 'name_pages'>('details');
  const [pendingPages, setPendingPages] = useState<any[]>([]);
  const [pendingThumbnails, setPendingThumbnails] = useState<Record<string, string>>({});
  const [newPlanSetName, setNewPlanSetName] = useState('');
  const [newPlanSetDate, setNewPlanSetDate] = useState(new Date().toISOString().split('T')[0]);
  const [newPlanSetFiles, setNewPlanSetFiles] = useState<File[]>([]);
  const [useExistingPlanSet, setUseExistingPlanSet] = useState(false);
  const [targetPlanSetId, setTargetPlanSetId] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [isEditingDueDate, setIsEditingDueDate] = useState(false);
  const [editDueDate, setEditDueDate] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const removeNewPlanSetFile = (indexToRemove: number) => {
    setNewPlanSetFiles(newPlanSetFiles.filter((_, index) => index !== indexToRemove));
  };

  useEffect(() => {
    if (projectId) {
      loadProject(projectId);
    }
    loadTemplates();
  }, [projectId]);

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
      setSelectedPlanSetId(data.planSets[0].id);
    }
    
    // Load images for thumbnails
    const images: Record<string, string> = {};
    for (const page of data.pages) {
      const img = await getImage(page.imageId);
      if (img) {
        images[page.id] = img;
      }
    }
    setPageImages(images);
    
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
      costPerUnit: newTakeoffCostPerUnit !== '' ? Number(newTakeoffCostPerUnit) : undefined,
      laborPercent: newTakeoffLaborPercent !== '' ? Number(newTakeoffLaborPercent) : undefined,
      materialsPercent: newTakeoffMaterialsPercent !== '' ? Number(newTakeoffMaterialsPercent) : undefined,
      equipmentPercent: newTakeoffEquipmentPercent !== '' ? Number(newTakeoffEquipmentPercent) : undefined,
      profitPercent: newTakeoffProfitPercent !== '' ? Number(newTakeoffProfitPercent) : undefined,
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
    setNewTakeoffLaborPercent('');
    setNewTakeoffMaterialsPercent('');
    setNewTakeoffEquipmentPercent('');
    setNewTakeoffProfitPercent('');
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
      setNewTakeoffLaborPercent(template.laborPercent ?? '');
      setNewTakeoffMaterialsPercent(template.materialsPercent ?? '');
      setNewTakeoffEquipmentPercent(template.equipmentPercent ?? '');
      setNewTakeoffProfitPercent(template.profitPercent ?? '');
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
    setEditingTakeoff(takeoff);
    setEditTakeoffName(takeoff.name);
    setEditTakeoffColor(takeoff.color);
    setEditTakeoffUnit(takeoff.unit || '');
    setEditTakeoffCostPerUnit(takeoff.costPerUnit ?? '');
    setEditTakeoffLaborPercent(takeoff.laborPercent ?? '');
    setEditTakeoffMaterialsPercent(takeoff.materialsPercent ?? '');
    setEditTakeoffEquipmentPercent(takeoff.equipmentPercent ?? '');
    setEditTakeoffProfitPercent(takeoff.profitPercent ?? '');
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
              costPerUnit: editTakeoffCostPerUnit !== '' ? Number(editTakeoffCostPerUnit) : undefined,
              laborPercent: editTakeoffLaborPercent !== '' ? Number(editTakeoffLaborPercent) : undefined,
              materialsPercent: editTakeoffMaterialsPercent !== '' ? Number(editTakeoffMaterialsPercent) : undefined,
              equipmentPercent: editTakeoffEquipmentPercent !== '' ? Number(editTakeoffEquipmentPercent) : undefined,
              profitPercent: editTakeoffProfitPercent !== '' ? Number(editTakeoffProfitPercent) : undefined,
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
    setEditingPageId(page.id);
    setEditingPageName(page.name);
  };

  const handleSaveRenamePage = async (e: React.MouseEvent, pageId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (!project || !editingPageName.trim()) return;

    const updatedProject = {
      ...project,
      pages: project.pages.map(p => p.id === pageId ? { ...p, name: editingPageName.trim() } : p)
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
      const extractedPages: any[] = [];
      const thumbnails: Record<string, string> = {};
      
      let startingPageNum = project.pages.length + 1;

      for (let i = 0; i < newPlanSetFiles.length; i++) {
        const file = newPlanSetFiles[i];
        setAddProgress(prev => ({ ...prev, currentFile: i + 1, totalFiles: newPlanSetFiles.length }));
        
        const pagesData = await loadPdfAllPagesAsImages(file, (current, total) => {
          setAddProgress(prev => ({ ...prev, current, total }));
        });

        for (let j = 0; j < pagesData.length; j++) {
          const pageData = pagesData[j];
          const imageId = uuidv4();
          await saveImage(imageId, pageData.dataUrl);
          thumbnails[imageId] = pageData.dataUrl;
          
          extractedPages.push({
            id: uuidv4(),
            name: pageData.suggestedName || `Page ${startingPageNum}`,
            imageId,
            imageWidth: pageData.width,
            imageHeight: pageData.height,
            extractedText: pageData.extractedText,
          });
          startingPageNum++;
        }
      }

      setPendingPages(extractedPages);
      setPendingThumbnails(thumbnails);
      setAddPagesStep('name_pages');
    } catch (error) {
      console.error('Error processing PDFs:', error);
      alert('Failed to process PDF. Please try another file.');
    } finally {
      setIsAddingPages(false);
      setAddProgress({ current: 0, total: 0, currentFile: 0, totalFiles: 0 });
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
        const imageUrl = await getImage(page.imageId);
        if (!imageUrl) continue;

        const canvas = document.createElement('canvas');
        canvas.width = page.imageWidth;
        canvas.height = page.imageHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) continue;

        // Draw background image
        const img = new Image();
        img.src = imageUrl;
        await new Promise((resolve) => { img.onload = resolve; });
        ctx.drawImage(img, 0, 0);

        // Draw measurements
        page.measurements.forEach(m => {
          if (!selectedTakeoffIds.has(m.takeoffId || '')) return;
          
          const takeoff = project.takeoffs.find(t => t.id === m.takeoffId);
          const color = takeoff?.color || m.color || '#3b82f6';
          
          ctx.strokeStyle = color;
          ctx.fillStyle = `${color}40`;
          ctx.lineWidth = 3;
          
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
              text = formatMeasurement(pxArea, 'area', page.scaleConfig);
            } else if (m.type === 'length') {
              const pxLen = calculatePolylineLength(m.points);
              text = formatMeasurement(pxLen, 'length', page.scaleConfig);
            } else {
              const pxArea = calculatePolygonArea(m.points);
              text = formatMeasurement(pxArea, 'area', page.scaleConfig);
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

  const handleDeletePrintout = async (printoutId: string) => {
    if (!project) return;
    
    const printout = project.printouts?.find(p => p.id === printoutId);
    if (!printout) return;

    if (!confirm('Are you sure you want to delete this printout?')) return;

    const updatedProject = {
      ...project,
      printouts: project.printouts?.filter(p => p.id !== printoutId) || [],
    };

    await saveProject(updatedProject);
    await deleteFile(printout.fileId);
    setProject(updatedProject);
  };

  const handleDownloadPrintout = async (printout: Printout) => {
    const dataUrl = await getFile(printout.fileId);
    if (!dataUrl) return;

    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = `${printout.name}.pdf`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleViewPrintout = async (printout: Printout) => {
    const dataUrl = await getFile(printout.fileId);
    if (!dataUrl) return;

    const win = window.open();
    if (win) {
      win.document.write(`<iframe src="${dataUrl}" frameborder="0" style="border:0; top:0px; left:0px; bottom:0px; right:0px; width:100%; height:100%;" allowfullscreen></iframe>`);
    }
  };

  const handleConfirmAddPages = async () => {
    if (!project) return;
    setIsAddingPages(true);
    try {
      const planSetId = useExistingPlanSet ? targetPlanSetId : uuidv4();
      const newPages: ProjectPage[] = pendingPages.map(p => ({
        id: p.id,
        name: p.name,
        imageId: p.imageId,
        imageWidth: p.imageWidth,
        imageHeight: p.imageHeight,
        extractedText: p.extractedText,
        measurements: [],
        scaleConfig: null,
        planSetId,
      }));

      const newImages: Record<string, string> = { ...pageImages };
      for (const p of pendingPages) {
        newImages[p.id] = pendingThumbnails[p.imageId];
      }

      let updatedProject;
      if (useExistingPlanSet) {
        updatedProject = {
          ...project,
          pages: [...project.pages, ...newPages]
        };
      } else {
        const newPlanSet = {
          id: planSetId,
          name: newPlanSetName,
          date: newPlanSetDate,
          createdAt: Date.now(),
        };

        updatedProject = {
          ...project,
          planSets: [...(project.planSets || []), newPlanSet],
          pages: [...project.pages, ...newPages]
        };
      }

      await saveProject(updatedProject);
      setProject(updatedProject);
      setPageImages(newImages);
      setSelectedPlanSetId(planSetId);
      setShowAddPagesModal(false);
      setAddPagesStep('details');
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

  const updatePendingPageName = (id: string, newName: string) => {
    setPendingPages(prev => prev.map(p => p.id === id ? { ...p, name: newName } : p));
  };

  // Calculate totals for takeoffs across all pages
  const getTakeoffTotals = () => {
    if (!project) return [];

    const pagesToCalculate = project.pages;

    return project.takeoffs.map(takeoff => {
      let totalRealValue = 0;
      let unit = '';
      
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
                
                // Convert to a consistent unit for the page if possible
                const targetUnit = page.scaleConfig?.unit || currentScale.unit;
                const convertedVal = convertUnit(realVal, currentScale.unit, targetUnit, takeoff.type as 'length' | 'area' | 'count');
                
                pageRealValue += convertedVal;
                pageUnit = takeoff.type === 'area' ? `sq ${targetUnit}` : targetUnit;
              }
            }
          });

          if (pageRealValue > 0) {
            totalRealValue += pageRealValue;
            if (!unit) unit = pageUnit;
            
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
        unit,
        pageBreakdown
      };
    });
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

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex justify-center items-center">
        <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!project) return null;

  const filteredPages = project.pages.filter(page => {
    const matchesPlanSet = !selectedPlanSetId || page.planSetId === selectedPlanSetId;
    const searchLower = searchTerm.toLowerCase();
    const matchesSearch = page.name.toLowerCase().includes(searchLower) || 
                          (page.extractedText && page.extractedText.toLowerCase().includes(searchLower));
    return matchesPlanSet && matchesSearch;
  });

  return (
    <div className="min-h-screen bg-slate-50 p-8 font-sans">
      <div className="max-w-5xl mx-auto">
        <Link to="/" className="inline-flex items-center gap-2 text-slate-500 hover:text-slate-800 mb-6 transition-colors font-medium">
          <ArrowLeft size={18} />
          Back to Projects
        </Link>
        
        <div className="flex flex-col md:flex-row justify-between items-start md:items-end mb-8 gap-4">
          <div>
            <h1 className="text-3xl font-bold text-slate-900">{project.name}</h1>
            <div className="flex flex-wrap items-center gap-4 mt-2 text-sm text-slate-500">
              <span>Created on {new Date(project.createdAt).toLocaleDateString()}</span>
              {project.contractor && (
                <span className="flex items-center gap-1">
                  <span className="w-1 h-1 rounded-full bg-slate-300"></span>
                  {project.contractor}
                </span>
              )}
              <div className="flex items-center gap-1">
                <span className="w-1 h-1 rounded-full bg-slate-300"></span>
                {isEditingDueDate ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="date"
                      value={editDueDate}
                      onChange={(e) => setEditDueDate(e.target.value)}
                      className="border border-slate-300 rounded px-2 py-0.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <button onClick={handleSaveDueDate} className="text-green-600 hover:bg-green-50 p-1 rounded">
                      <Check size={14} />
                    </button>
                    <button onClick={() => setIsEditingDueDate(false)} className="text-slate-400 hover:bg-slate-100 p-1 rounded">
                      <X size={14} />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 group">
                    <span className={`${project.bidDueDate && project.bidDueDate < Date.now() ? 'text-red-600 font-medium' : ''}`}>
                      Due: {project.bidDueDate ? new Date(project.bidDueDate).toLocaleDateString() : 'Not set'}
                    </span>
                    <button 
                      onClick={() => {
                        setEditDueDate(project.bidDueDate ? new Date(project.bidDueDate).toISOString().split('T')[0] : '');
                        setIsEditingDueDate(true);
                      }}
                      className="text-slate-400 hover:text-blue-600 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-blue-50"
                    >
                      <Edit2 size={14} />
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
          {project.planSets && project.planSets.length > 0 && (
            <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-lg px-3 py-2 shadow-sm">
              <span className="text-sm text-slate-500 font-medium">Plan Set:</span>
              <select
                value={selectedPlanSetId}
                onChange={(e) => setSelectedPlanSetId(e.target.value)}
                className="bg-transparent text-sm font-medium text-slate-700 outline-none"
              >
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
        <div className="flex border-b border-slate-200 mb-6">
          <button
            onClick={() => setActiveTab('pages')}
            className={`px-6 py-3 text-sm font-medium transition-colors relative ${
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
            className={`px-6 py-3 text-sm font-medium transition-colors relative ${
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
            className={`px-6 py-3 text-sm font-medium transition-colors relative ${
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
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
              <div className="relative flex-1 w-full max-w-md">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                <input
                  type="text"
                  placeholder="Search pages..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 bg-white border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-sm"
                />
              </div>
              <button
                onClick={() => setShowAddPagesModal(true)}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors flex items-center gap-2 shadow-sm"
              >
                <Plus size={16} />
                Add Pages
              </button>
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
                    to={`/project/${project.id}/page/${page.id}`}
                    className="bg-white rounded-xl border border-slate-200 overflow-hidden hover:shadow-md transition-all hover:border-blue-300 flex flex-col group"
                  >
                    <div className="h-40 bg-slate-100 relative overflow-hidden border-b border-slate-200">
                      {pageImages[page.id] ? (
                        <img 
                          src={pageImages[page.id]} 
                          alt={page.name} 
                          className="w-full h-full object-cover object-top opacity-90 group-hover:opacity-100 transition-opacity"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-slate-400">
                          <FileImage size={32} />
                        </div>
                      )}
                    </div>
                    <div className="p-4 flex-1 flex flex-col justify-between">
                      <div>
                        {editingPageId === page.id ? (
                          <div className="flex items-center gap-2 mb-2" onClick={e => e.preventDefault()}>
                            <input
                              type="text"
                              value={editingPageName}
                              onChange={(e) => setEditingPageName(e.target.value)}
                              className="flex-1 border border-blue-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                              autoFocus
                              onClick={e => e.stopPropagation()}
                              onKeyDown={e => {
                                if (e.key === 'Enter') handleSaveRenamePage(e as any, page.id);
                                if (e.key === 'Escape') handleCancelRenamePage(e as any);
                              }}
                            />
                            <button onClick={(e) => handleSaveRenamePage(e, page.id)} className="text-green-600 hover:bg-green-50 p-1 rounded">
                              <Check size={16} />
                            </button>
                            <button onClick={handleCancelRenamePage} className="text-slate-400 hover:bg-slate-100 p-1 rounded">
                              <X size={16} />
                            </button>
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
            <div className="p-6 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
              <h2 className="text-xl font-bold text-slate-800">Takeoffs Inventory</h2>
              <div className="flex items-center gap-3">
                {selectedTakeoffIds.size > 0 && (
                  <button
                    onClick={handlePrint}
                    disabled={isPrinting}
                    className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 transition-colors flex items-center gap-2 shadow-sm disabled:opacity-50"
                  >
                    {isPrinting ? <Loader2 size={16} className="animate-spin" /> : <Printer size={16} />}
                    {isPrinting ? 'Generating PDF...' : `Print Selected (${selectedTakeoffIds.size})`}
                  </button>
                )}
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
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors flex items-center gap-2 shadow-sm"
                >
                  <Plus size={16} />
                  New Takeoff
                </button>
              </div>
            </div>
            
            <div className="overflow-x-auto">
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
                    <th className="px-6 py-4 text-right">Labor %</th>
                    <th className="px-6 py-4 text-right">Mat %</th>
                    <th className="px-6 py-4 text-right">Equip %</th>
                    <th className="px-6 py-4 text-right">Profit %</th>
                    <th className="px-6 py-4 text-right">Total Cost</th>
                    <th className="px-6 py-4 w-24"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {getTakeoffTotals().map(takeoff => {
                    const baseCost = takeoff.totalRealValue * (takeoff.costPerUnit || 0);
                    const laborCost = baseCost * ((takeoff.laborPercent || 0) / 100);
                    const materialsCost = baseCost * ((takeoff.materialsPercent || 0) / 100);
                    const equipmentCost = baseCost * ((takeoff.equipmentPercent || 0) / 100);
                    const subtotal = baseCost + laborCost + materialsCost + equipmentCost;
                    const profit = subtotal * ((takeoff.profitPercent || 0) / 100);
                    const totalCost = subtotal + profit;

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
                            {takeoff.totalRealValue > 0 ? formatRealValue(takeoff.totalRealValue, takeoff.type as 'length' | 'area' | 'count', takeoff.unit?.replace('sq ', '') || 'ft') : '-'}
                          </td>
                          <td className="px-6 py-4 text-right text-sm text-slate-600 font-medium">
                            {takeoff.costPerUnit ? `$${takeoff.costPerUnit.toFixed(2)}` : '-'}
                          </td>
                          <td className="px-6 py-4 text-right text-sm text-slate-500">
                            {takeoff.laborPercent ? `${takeoff.laborPercent}%` : '-'}
                          </td>
                          <td className="px-6 py-4 text-right text-sm text-slate-500">
                            {takeoff.materialsPercent ? `${takeoff.materialsPercent}%` : '-'}
                          </td>
                          <td className="px-6 py-4 text-right text-sm text-slate-500">
                            {takeoff.equipmentPercent ? `${takeoff.equipmentPercent}%` : '-'}
                          </td>
                          <td className="px-6 py-4 text-right text-sm text-slate-500">
                            {takeoff.profitPercent ? `${takeoff.profitPercent}%` : '-'}
                          </td>
                          <td className="px-6 py-4 text-right font-bold text-blue-600">
                            {totalCost > 0 ? `$${totalCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '-'}
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
                                    <Link to={`/project/${project.id}/page/${pb.pageId}`} className="text-sm text-blue-600 hover:text-blue-800 font-semibold flex items-center gap-2">
                                      <FileImage size={14} className="text-slate-400" />
                                      {pb.pageName}
                                    </Link>
                                    <span className="text-sm font-bold text-slate-700">
                                      {formatRealValue(pb.realValue, takeoff.type as 'length' | 'area' | 'count', pb.unit?.replace('sq ', '') || 'ft')}
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
                  {project.takeoffs.length === 0 && (
                    <tr>
                      <td colSpan={11} className="px-6 py-12 text-center text-slate-500">
                        No takeoffs created yet. <button onClick={() => setShowTakeoffModal(true)} className="text-blue-600 font-bold hover:underline">Create one</button> to start estimating.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
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
                  Select takeoffs from the Takeoffs tab and click "Print" to generate a PDF report.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {[...(project.printouts || [])].sort((a, b) => b.createdAt - a.createdAt).map((printout) => (
                  <div key={printout.id} className="bg-white rounded-xl border border-slate-200 overflow-hidden hover:shadow-md transition-all group">
                    <div className="p-6">
                      <div className="flex items-start justify-between mb-4">
                        <div className="w-12 h-12 bg-blue-50 rounded-xl flex items-center justify-center text-blue-600">
                          <FileText size={24} />
                        </div>
                        <div className="flex items-center gap-1">
                          <button 
                            onClick={() => handleViewPrintout(printout)}
                            className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                            title="View PDF"
                          >
                            <Eye size={18} />
                          </button>
                          <button 
                            onClick={() => handleDownloadPrintout(printout)}
                            className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                            title="Download PDF"
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
                    value={newTakeoffCostPerUnit}
                    onChange={(e) => setNewTakeoffCostPerUnit(e.target.value === '' ? '' : Number(e.target.value))}
                    className="w-full border border-slate-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="0.00"
                  />
                </div>
              </div>
              <div className="grid grid-cols-4 gap-2">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Labor %</label>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={newTakeoffLaborPercent}
                    onChange={(e) => setNewTakeoffLaborPercent(e.target.value === '' ? '' : Number(e.target.value))}
                    className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="0"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Materials %</label>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={newTakeoffMaterialsPercent}
                    onChange={(e) => setNewTakeoffMaterialsPercent(e.target.value === '' ? '' : Number(e.target.value))}
                    className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="0"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Equip %</label>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={newTakeoffEquipmentPercent}
                    onChange={(e) => setNewTakeoffEquipmentPercent(e.target.value === '' ? '' : Number(e.target.value))}
                    className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="0"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Profit %</label>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={newTakeoffProfitPercent}
                    onChange={(e) => setNewTakeoffProfitPercent(e.target.value === '' ? '' : Number(e.target.value))}
                    className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="0"
                  />
                </div>
              </div>
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
                    value={editTakeoffCostPerUnit}
                    onChange={(e) => setEditTakeoffCostPerUnit(e.target.value === '' ? '' : Number(e.target.value))}
                    className="w-full border border-slate-300 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="0.00"
                  />
                </div>
              </div>
              <div className="grid grid-cols-4 gap-2">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Labor %</label>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={editTakeoffLaborPercent}
                    onChange={(e) => setEditTakeoffLaborPercent(e.target.value === '' ? '' : Number(e.target.value))}
                    className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="0"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Materials %</label>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={editTakeoffMaterialsPercent}
                    onChange={(e) => setEditTakeoffMaterialsPercent(e.target.value === '' ? '' : Number(e.target.value))}
                    className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="0"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Equip %</label>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={editTakeoffEquipmentPercent}
                    onChange={(e) => setEditTakeoffEquipmentPercent(e.target.value === '' ? '' : Number(e.target.value))}
                    className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="0"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Profit %</label>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={editTakeoffProfitPercent}
                    onChange={(e) => setEditTakeoffProfitPercent(e.target.value === '' ? '' : Number(e.target.value))}
                    className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="0"
                  />
                </div>
              </div>
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
                        Adding {addProgress.totalFiles > 1 ? `File ${addProgress.currentFile}/${addProgress.totalFiles} ` : ''}
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
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6">
                    {pendingPages.map((page, index) => (
                      <div key={page.id} className="bg-slate-50 rounded-xl border border-slate-200 overflow-hidden flex flex-col">
                        <div className="h-40 bg-slate-200 relative flex-shrink-0 border-b border-slate-200">
                          {pendingThumbnails[page.imageId] ? (
                            <img 
                              src={pendingThumbnails[page.imageId]} 
                              alt={`Page ${index + 1}`}
                              className="w-full h-full object-contain"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-slate-400">
                              <Loader2 size={24} className="animate-spin" />
                            </div>
                          )}
                          <div className="absolute top-2 left-2 bg-black/60 text-white text-xs font-medium px-2 py-1 rounded-md backdrop-blur-sm">
                            {index + 1}
                          </div>
                        </div>
                        <div className="p-4 flex-grow flex flex-col justify-center">
                          <label className="block text-xs font-medium text-slate-500 mb-1 uppercase tracking-wider">Page Name</label>
                          <input
                            type="text"
                            value={page.name}
                            onChange={(e) => updatePendingPageName(page.id, e.target.value)}
                            className="w-full px-3 py-2 rounded-lg border border-slate-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-sm font-medium"
                            placeholder={`Page ${index + 1}`}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="p-6 border-t border-slate-100 bg-slate-50 flex justify-between items-center">
                  <button
                    type="button"
                    onClick={() => setAddPagesStep('details')}
                    disabled={isAddingPages}
                    className="inline-flex items-center gap-2 text-slate-500 hover:text-slate-800 transition-colors font-medium"
                  >
                    <ArrowLeft size={16} />
                    Back
                  </button>
                  <button
                    onClick={handleConfirmAddPages}
                    disabled={isAddingPages}
                    className="flex items-center gap-2 px-6 py-2.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl transition-colors shadow-sm"
                  >
                    {isAddingPages ? (
                      <><Loader2 size={16} className="animate-spin" /> Saving...</>
                    ) : (
                      <><Check size={16} /> Add Pages</>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
