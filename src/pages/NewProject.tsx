import React, { useState, useRef, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Upload, ArrowLeft, FileText, Loader2, Trash2, Plus, Check, Eye, Hash, Search, ZoomIn, ZoomOut, Maximize, X } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { Project, ProjectPage } from '../types';
import { createProject, saveImage, getImage } from '../utils/store';
import { loadPdfAllPagesAsImages } from '../utils/pdf';
import { createWorker } from 'tesseract.js';

interface PendingPage {
  id: string;
  name: string;
  pageNumber?: string;
  description?: string;
  imageId: string;
  imageWidth: number;
  imageHeight: number;
  extractedText?: string;
}

export const NewProject: React.FC = () => {
  const navigate = useNavigate();
  const [step, setStep] = useState<'details' | 'name_pages'>('details');
  const [name, setName] = useState('');
  const [contractor, setContractor] = useState('');
  const [bidDueDate, setBidDueDate] = useState('');
  const [planSetName, setPlanSetName] = useState('Initial Set');
  const [planSetDate, setPlanSetDate] = useState(new Date().toISOString().split('T')[0]);
  const [files, setFiles] = useState<File[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState({ status: '', current: 0, total: 0, currentFile: 0, totalFiles: 0 });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageContainerRef = useRef<HTMLDivElement>(null);
  
  const [pendingPages, setPendingPages] = useState<PendingPage[]>([]);
  const [pageThumbnails, setPageThumbnails] = useState<Record<string, string>>({});
  const [previewPageId, setPreviewPageId] = useState<string | null>(null);
  const [extractionType, setExtractionType] = useState<'pageNumber' | 'description' | null>(null);
  const [extractionRect, setExtractionRect] = useState<{ x: number, y: number, width: number, height: number } | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionStart, setSelectionStart] = useState<{ x: number, y: number } | null>(null);
  const [interactionMode, setInteractionMode] = useState<'draw' | 'move' | 'resize-nw' | 'resize-ne' | 'resize-sw' | 'resize-se' | null>(null);
  const [initialRect, setInitialRect] = useState<{ x: number, y: number, width: number, height: number } | null>(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(e.target.files || []);
    if (selectedFiles.length > 0) {
      setFiles(prev => [...prev, ...selectedFiles]);
      if (!name) {
        setName(selectedFiles[0].name.replace('.pdf', ''));
      }
    }
  };

  const removeFile = (indexToRemove: number) => {
    setFiles(files.filter((_, index) => index !== indexToRemove));
  };

  const handleProcessFiles = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || files.length === 0) return;

    setIsProcessing(true);
    try {
      const extractedPages: PendingPage[] = [];
      const thumbnails: Record<string, string> = {};
      
      let globalPageNum = 1;

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setProgress(prev => ({ ...prev, currentFile: i + 1, totalFiles: files.length }));
        
        const pagesData = await loadPdfAllPagesAsImages(file, (status, current, total) => {
          setProgress(prev => ({ ...prev, status, current, total }));
        });

        for (let j = 0; j < pagesData.length; j++) {
          setProgress(prev => ({ ...prev, status: 'Uploading images to server', current: j + 1, total: pagesData.length }));
          const pageData = pagesData[j];
          const imageId = uuidv4();
          await saveImage(imageId, pageData.dataUrl);
          thumbnails[imageId] = pageData.dataUrl;
          
          extractedPages.push({
            id: uuidv4(),
            name: pageData.suggestedName || `Page ${globalPageNum}`,
            pageNumber: '',
            description: pageData.suggestedName || '',
            imageId,
            imageWidth: pageData.width,
            imageHeight: pageData.height,
            extractedText: pageData.extractedText,
          });
          globalPageNum++;
        }
      }

      setPendingPages(extractedPages);
      setPageThumbnails(thumbnails);
      setStep('name_pages');
    } catch (error) {
      console.error('Error processing PDFs:', error);
      alert('Failed to process PDF. Please try another file.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCreateProject = async () => {
    setIsProcessing(true);
    try {
      const projectId = uuidv4();
      const planSetId = uuidv4();
      
      const pages: ProjectPage[] = pendingPages.map(p => ({
        id: p.id,
        name: p.name,
        pageNumber: p.pageNumber,
        description: p.description,
        imageId: p.imageId,
        imageWidth: p.imageWidth,
        imageHeight: p.imageHeight,
        extractedText: p.extractedText,
        measurements: [],
        scaleConfig: null,
        planSetId,
      }));

      let parsedBidDueDate = null;
      if (bidDueDate) {
        const [year, month, day] = bidDueDate.split('-').map(Number);
        parsedBidDueDate = new Date(year, month - 1, day).getTime();
      }

      const project: Project = {
        id: projectId,
        name,
        createdAt: Date.now(),
        contractor: contractor || undefined,
        bidDueDate: parsedBidDueDate,
        planSets: [
          {
            id: planSetId,
            name: planSetName || 'Initial Set',
            date: planSetDate,
            createdAt: Date.now(),
          }
        ],
        pages,
        takeoffs: [],
      };

      await createProject(project);
      navigate(`/project/${projectId}`);
    } catch (error) {
      console.error('Error creating project:', error);
      alert('Failed to create project.');
    } finally {
      setIsProcessing(false);
    }
  };

  const updatePendingPageField = (id: string, field: string, value: string) => {
    setPendingPages(prev => prev.map(p => {
      if (p.id === id) {
        const updated = { ...p, [field]: value };
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
    
    setIsExtracting(true);
    try {
      if (applyToAll) {
        const updatedPages = [...pendingPages];
        const worker = await createWorker('eng');
        
        for (let i = 0; i < updatedPages.length; i++) {
          const p = updatedPages[i];

          const img = new Image();
          img.src = `/api/images/${p.imageId}/raw`;
          await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
          });

          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          if (!ctx) continue;

          const x = (extractionRect.x / 100) * img.width;
          const y = (extractionRect.y / 100) * img.height;
          const w = (extractionRect.width / 100) * img.width;
          const h = (extractionRect.height / 100) * img.height;

          canvas.width = w;
          canvas.height = h;
          ctx.drawImage(img, x, y, w, h, 0, 0, w, h);

          const { data: { text } } = await worker.recognize(canvas.toDataURL());
          const cleanedText = text.trim().replace(/\n/g, ' ');
          
          updatedPages[i] = { ...p, [extractionType]: cleanedText };
          const num = extractionType === 'pageNumber' ? cleanedText : (p.pageNumber || '');
          const desc = extractionType === 'description' ? cleanedText : (p.description || '');
          updatedPages[i].name = num && desc ? `${num} - ${desc}` : (num || desc || p.name);
        }
        
        setPendingPages(updatedPages);
        await worker.terminate();
      } else {
        const worker = await createWorker('eng');
        const page = pendingPages.find(p => p.id === previewPageId);
        if (!page) return;

        const img = new Image();
        img.src = `/api/images/${page.imageId}/raw`;
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
        });

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const x = (extractionRect.x / 100) * img.width;
        const y = (extractionRect.y / 100) * img.height;
        const w = (extractionRect.width / 100) * img.width;
        const h = (extractionRect.height / 100) * img.height;

        canvas.width = w;
        canvas.height = h;
        ctx.drawImage(img, x, y, w, h, 0, 0, w, h);

        const { data: { text } } = await worker.recognize(canvas.toDataURL());
        const cleanedText = text.trim().replace(/\n/g, ' ');
        
        await worker.terminate();
        updatePendingPageField(previewPageId, extractionType, cleanedText);
      }

      setExtractionRect(null);
    } catch (error) {
      console.error('OCR Error:', error);
    } finally {
      setIsExtracting(false);
    }
  };

  if (step === 'name_pages') {
    return (
      <div className="min-h-screen bg-slate-50 p-8 font-sans">
        <div className="max-w-4xl mx-auto">
          <button 
            onClick={() => setStep('details')}
            className="inline-flex items-center gap-2 text-slate-500 hover:text-slate-800 mb-6 transition-colors font-medium"
          >
            <ArrowLeft size={18} />
            Back to Details
          </button>
          
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="p-8 border-b border-slate-100 flex justify-between items-center">
              <div>
                <h1 className="text-2xl font-bold text-slate-900">Name Pages</h1>
                <p className="text-slate-500 mt-1">Review and rename the imported pages before creating the project.</p>
              </div>
              <button
                onClick={handleCreateProject}
                disabled={isProcessing}
                className="flex items-center gap-2 px-6 py-3 rounded-xl font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
              >
                {isProcessing ? (
                  <><Loader2 size={18} className="animate-spin" /> Saving...</>
                ) : (
                  <><Check size={18} /> Create Project</>
                )}
              </button>
            </div>

            <div className="p-8">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                {pendingPages.map((page, index) => (
                  <div key={page.id} className="bg-white rounded-2xl border-2 border-slate-100 overflow-hidden flex flex-col shadow-sm hover:shadow-md transition-all duration-300">
                    {/* Thumbnail Section */}
                    <div 
                      className="h-48 bg-slate-100 relative flex-shrink-0 border-b border-slate-100 cursor-pointer overflow-hidden group"
                      onClick={() => setPreviewPageId(page.id)}
                    >
                      {pageThumbnails[page.imageId] ? (
                        <img 
                          src={pageThumbnails[page.imageId]} 
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
          </div>
        </div>

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
                    src={pageThumbnails[pendingPages.find(p => p.id === previewPageId)?.imageId || '']} 
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
                      Area selected. Ready to extract text.
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
  }

  return (
    <div className="min-h-screen bg-slate-50 p-8 font-sans">
      <div className="max-w-2xl mx-auto">
        <Link to="/" className="inline-flex items-center gap-2 text-slate-500 hover:text-slate-800 mb-6 transition-colors font-medium">
          <ArrowLeft size={18} />
          Back to Projects
        </Link>
        
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="p-8 border-b border-slate-100">
            <h1 className="text-2xl font-bold text-slate-900">New Project</h1>
            <p className="text-slate-500 mt-1">Upload a blueprint PDF to get started</p>
          </div>

          <form onSubmit={handleProcessFiles} className="p-8">
            <div className="space-y-6">
              <div>
                <label htmlFor="name" className="block text-sm font-medium text-slate-700 mb-2">
                  Project Name
                </label>
                <input
                  type="text"
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-4 py-3 rounded-xl border border-slate-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                  placeholder="e.g. Main Floor Plan"
                  required
                  disabled={isProcessing}
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label htmlFor="contractor" className="block text-sm font-medium text-slate-700 mb-2">
                    Contractor (Optional)
                  </label>
                  <input
                    type="text"
                    id="contractor"
                    value={contractor}
                    onChange={(e) => setContractor(e.target.value)}
                    className="w-full px-4 py-3 rounded-xl border border-slate-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                    placeholder="e.g. ABC Construction"
                    disabled={isProcessing}
                  />
                </div>

                <div>
                  <label htmlFor="bidDueDate" className="block text-sm font-medium text-slate-700 mb-2">
                    Bid Due Date (Optional)
                  </label>
                  <input
                    type="date"
                    id="bidDueDate"
                    value={bidDueDate}
                    onChange={(e) => setBidDueDate(e.target.value)}
                    className="w-full px-4 py-3 rounded-xl border border-slate-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                    disabled={isProcessing}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label htmlFor="planSetName" className="block text-sm font-medium text-slate-700 mb-2">
                    Plan Set Name
                  </label>
                  <input
                    type="text"
                    id="planSetName"
                    value={planSetName}
                    onChange={(e) => setPlanSetName(e.target.value)}
                    className="w-full px-4 py-3 rounded-xl border border-slate-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                    placeholder="e.g. Initial Set"
                    required
                    disabled={isProcessing}
                  />
                </div>

                <div>
                  <label htmlFor="planSetDate" className="block text-sm font-medium text-slate-700 mb-2">
                    Plan Set Date
                  </label>
                  <input
                    type="date"
                    id="planSetDate"
                    value={planSetDate}
                    onChange={(e) => setPlanSetDate(e.target.value)}
                    className="w-full px-4 py-3 rounded-xl border border-slate-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                    required
                    disabled={isProcessing}
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Blueprint PDFs
                </label>
                <div 
                  className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors ${
                    files.length > 0 ? 'border-blue-300 bg-blue-50' : 'border-slate-300 hover:border-blue-400 bg-slate-50 hover:bg-slate-100 cursor-pointer'
                  }`}
                  onClick={() => !isProcessing && files.length === 0 && fileInputRef.current?.click()}
                >
                  {files.length > 0 ? (
                    <div className="flex flex-col items-center w-full">
                      <div className="w-full max-w-md space-y-3 mb-4">
                        {files.map((file, index) => (
                          <div key={`${file.name}-${index}`} className="flex items-center justify-between bg-white p-3 rounded-lg border border-blue-200 shadow-sm">
                            <div className="flex items-center gap-3 overflow-hidden">
                              <FileText size={20} className="text-blue-500 shrink-0" />
                              <div className="text-left overflow-hidden">
                                <p className="text-sm font-medium text-slate-900 truncate" title={file.name}>{file.name}</p>
                                <p className="text-xs text-slate-500">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                              </div>
                            </div>
                            {!isProcessing && (
                              <button 
                                type="button" 
                                onClick={(e) => { e.stopPropagation(); removeFile(index); }}
                                className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-md transition-colors shrink-0"
                                title="Remove file"
                              >
                                <Trash2 size={16} />
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                      {!isProcessing && (
                        <button 
                          type="button" 
                          onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                          className="mt-2 text-sm text-blue-600 hover:text-blue-700 font-medium flex items-center gap-1"
                        >
                          <Plus size={16} /> Add more PDFs
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="flex flex-col items-center">
                      <Upload size={48} className="text-slate-400 mb-3" />
                      <p className="text-sm font-medium text-slate-900">Click to upload PDFs</p>
                      <p className="text-xs text-slate-500 mt-1">or drag and drop</p>
                    </div>
                  )}
                </div>
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  accept="application/pdf"
                  className="hidden"
                  multiple
                  required={files.length === 0}
                  disabled={isProcessing}
                />
              </div>
            </div>

            <div className="mt-8 pt-6 border-t border-slate-100 flex justify-end gap-3">
              <Link
                to="/"
                className="px-6 py-3 rounded-xl font-medium text-slate-600 hover:bg-slate-100 transition-colors"
              >
                Cancel
              </Link>
              <button
                type="submit"
                disabled={!name || files.length === 0 || isProcessing}
                className="flex items-center gap-2 px-6 py-3 rounded-xl font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
              >
                {isProcessing ? (
                  <>
                    <Loader2 size={18} className="animate-spin" />
                    {progress.status ? `${progress.status} ` : 'Processing '}
                    {progress.totalFiles > 1 ? `File ${progress.currentFile}/${progress.totalFiles} ` : ''}
                    {progress.total > 0 ? `(${progress.current}/${progress.total})` : '...'}
                  </>
                ) : (
                  'Next Step'
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};
