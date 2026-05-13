import React, { useState, useRef, useEffect } from 'react';
import { useNavigate, Link, useLocation } from 'react-router-dom';
import { Upload, ArrowLeft, FileText, Loader2, Trash2, Plus, Check, Eye, Hash, Search, ZoomIn, ZoomOut, Maximize, X } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { Project, ProjectPage } from '../types';
import { createProject, saveProject, getProject, saveImage, getImage, getImageUrl, deleteBid, getAllProjects, getBids } from '../utils/store';
import { loadPdfPagesGenerator, detectPageInfo, buildOcrCrop, ocrParamsFor, cleanSheetNumber, cleanDescriptionText } from '../utils/pdf';
import { createWorker } from 'tesseract.js';
import { AddressAutocomplete } from '../components/AddressAutocomplete';

interface PendingPage {
  id: string;
  name: string;
  pageNumber?: string;
  description?: string;
  imageId: string;
  thumbnailId: string;
  imageWidth: number;
  imageHeight: number;
  extractedText?: string;
}

export const NewProject: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [step, setStep] = useState<'details' | 'name_pages'>('details');
  const [name, setName] = useState(location.state?.initialName || '');
  const [contractor, setContractor] = useState(location.state?.initialContractor || '');
  const [address, setAddress] = useState(location.state?.initialAddress || '');
  const [bidDueDate, setBidDueDate] = useState('');
  const [planSetName, setPlanSetName] = useState('Initial Set');
  const [planSetDate, setPlanSetDate] = useState(new Date().toISOString().split('T')[0]);
  const [files, setFiles] = useState<File[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState({ status: '', current: 0, total: 0, currentFile: 0, totalFiles: 0 });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageContainerRef = useRef<HTMLDivElement>(null);
  
  const [projectId, setProjectId] = useState<string | null>(null);
  const [planSetId, setPlanSetId] = useState<string | null>(null);
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
  const [allContractors, setAllContractors] = useState<string[]>([]);
  const [filteredContractors, setFilteredContractors] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const suggestionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fetchContractors = async () => {
      try {
        const [projects, bids] = await Promise.all([getAllProjects(), getBids()]);
        const contractors = new Set<string>();
        projects.forEach(p => {
          if (p.contractor) contractors.add(p.contractor);
        });
        bids.forEach(b => {
          if (b.contractor) contractors.add(b.contractor);
        });
        setAllContractors(Array.from(contractors).sort());
      } catch (error) {
        console.error('Failed to fetch contractors:', error);
      }
    };
    fetchContractors();
  }, []);

  useEffect(() => {
    const trimmedContractor = String(contractor || '').trim();
    if (trimmedContractor) {
      const filtered = allContractors.filter(c => 
        c.toLowerCase().includes(trimmedContractor.toLowerCase()) && 
        c.toLowerCase() !== trimmedContractor.toLowerCase()
      );
      setFilteredContractors(filtered);
    } else {
      setFilteredContractors([]);
    }
  }, [contractor, allContractors]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (suggestionRef.current && !suggestionRef.current.contains(event.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(e.target.files || []);
    if (selectedFiles.length > 0) {
      setFiles(prev => [...prev, ...selectedFiles]);
      if (!name) {
        setName(selectedFiles[0].name.replace('.pdf', ''));
      }
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (isProcessing) return;
    const dropped = Array.from(e.dataTransfer.files).filter(f => f.type === 'application/pdf');
    if (dropped.length > 0) {
      setFiles(prev => [...prev, ...dropped]);
      if (!name) {
        setName(dropped[0].name.replace('.pdf', ''));
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
      const newProjectId = uuidv4();
      const newPlanSetId = uuidv4();
      setProjectId(newProjectId);
      setPlanSetId(newPlanSetId);

      let parsedBidDueDate = null;
      if (bidDueDate) {
        const [year, month, day] = bidDueDate.split('-').map(Number);
        parsedBidDueDate = new Date(year, month - 1, day).getTime();
      }

      const project: Project = {
        id: newProjectId,
        name,
        createdAt: Date.now(),
        contractor: contractor || undefined,
        address: address || undefined,
        bidDueDate: parsedBidDueDate,
        planSets: [
          {
            id: newPlanSetId,
            name: planSetName || 'Initial Set',
            date: planSetDate,
            createdAt: Date.now(),
          }
        ],
        pages: [],
        takeoffs: [],
      };

      await createProject(project);

      const extractedPages: PendingPage[] = [];
      const thumbnails: Record<string, string> = {};
      const failures: Array<{ fileName: string; pageNum: number | null; reason: string }> = [];
      let totalExpected = 0;
      let totalProcessed = 0;
      let globalPageNum = 1;

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setProgress(prev => ({ ...prev, currentFile: i + 1, totalFiles: files.length }));

        let fileExpected = 0;
        let fileYielded = 0;

        try {
          const generator = loadPdfPagesGenerator(file, (status, current, total) => {
            if (total > 0) fileExpected = total;
            setProgress(prev => ({ ...prev, status, current, total }));
          });

          for await (const pageData of generator) {
            fileYielded++;

            if (pageData.error) {
              failures.push({ fileName: file.name, pageNum: pageData.pageNum, reason: pageData.error });
              continue;
            }

            setProgress(prev => ({ ...prev, status: 'uploading', current: pageData.pageNum, total: prev.total }));

            try {
              const imageId = uuidv4();
              const thumbnailId = uuidv4();
              await saveImage(imageId, pageData.dataUrl);
              await saveImage(thumbnailId, pageData.thumbnailDataUrl);
              thumbnails[imageId] = pageData.thumbnailDataUrl;

              const detected = detectPageInfo(pageData.suggestedName, file.name, pageData.extractedText);
              const newPage: PendingPage = {
                id: uuidv4(),
                name: detected.pageNumber && detected.description
                  ? `${detected.pageNumber} - ${detected.description}`
                  : detected.pageNumber || detected.description || pageData.suggestedName || `Page ${globalPageNum}`,
                pageNumber: detected.pageNumber,
                description: detected.description,
                imageId,
                thumbnailId,
                imageWidth: pageData.width,
                imageHeight: pageData.height,
                extractedText: pageData.extractedText,
              };

              extractedPages.push(newPage);

              project.pages.push({
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
                planSetId: newPlanSetId,
              });

              totalProcessed++;

              if (globalPageNum % 5 === 0) {
                try { await saveProject(project); } catch (saveErr) {
                  console.warn('Periodic saveProject failed', saveErr);
                }
              }

              globalPageNum++;
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

        // Account for pages the generator never reached (e.g. iteration aborted mid-file).
        if (fileExpected > fileYielded) {
          for (let p = fileYielded + 1; p <= fileExpected; p++) {
            failures.push({
              fileName: file.name,
              pageNum: p,
              reason: 'Page was never reached during processing',
            });
          }
        }

        try { await saveProject(project); } catch (saveErr) {
          console.warn('End-of-file saveProject failed', saveErr);
        }
      }

      // Final verification — surface any losses to the user so silent skips can't happen.
      if (failures.length > 0 || totalProcessed !== totalExpected) {
        const byFile = new Map<string, typeof failures>();
        failures.forEach(f => {
          const arr = byFile.get(f.fileName) ?? [];
          arr.push(f);
          byFile.set(f.fileName, arr);
        });
        const lines: string[] = [];
        byFile.forEach((arr, name) => {
          const fileLevel = arr.find(a => a.pageNum == null);
          const pageNums = arr.filter(a => a.pageNum != null).map(a => a.pageNum).join(', ');
          if (fileLevel) lines.push(`• ${name}: ${fileLevel.reason}`);
          if (pageNums) lines.push(`• ${name}: failed pages ${pageNums}`);
        });
        alert(
          `${totalProcessed} of ${totalExpected} page${totalExpected === 1 ? '' : 's'} were imported successfully.\n\n` +
          `Some pages could not be processed:\n${lines.join('\n')}\n\n` +
          `You can continue with the pages that imported, then re-upload the file to retry the rest.`
        );
      }

      if (totalProcessed === 0) {
        // Nothing to name — stay on the upload step.
        setIsProcessing(false);
        return;
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

  const handleSaveChanges = async () => {
    if (!projectId || !planSetId) return;
    
    setIsProcessing(true);
    try {
      const project = await getProject(projectId);
      if (!project) throw new Error('Project not found');

      const updatedPages: ProjectPage[] = pendingPages.map(p => ({
        id: p.id,
        name: p.pageNumber && p.description ? `${p.pageNumber} - ${p.description}` : (p.pageNumber || p.description || p.name),
        pageNumber: p.pageNumber,
        description: p.description,
        imageId: p.imageId,
        thumbnailId: p.thumbnailId,
        imageWidth: p.imageWidth,
        imageHeight: p.imageHeight,
        extractedText: p.extractedText,
        measurements: project.pages.find(pp => pp.id === p.id)?.measurements || [],
        scaleConfig: project.pages.find(pp => pp.id === p.id)?.scaleConfig || null,
        planSetId,
      }));

      project.pages = updatedPages;

      // If converted from a bid, move the email thread onto the project so the
      // pipeline entry can be deleted while keeping the conversation history.
      const state = location.state as {
        fromBidId?: string;
        fromBidEmail?: import('../types').BidEmail;
        fromBidEmails?: import('../types').BidEmail[];
        fromBidProposalFileId?: string;
        fromBidProposalSentAt?: number;
      } | null;
      if (state?.fromBidEmail) project.email = state.fromBidEmail;
      if (state?.fromBidEmails) project.emails = state.fromBidEmails;
      if (state?.fromBidProposalFileId) project.proposalFileId = state.fromBidProposalFileId;
      if (state?.fromBidProposalSentAt) project.proposalSentAt = state.fromBidProposalSentAt;

      await saveProject(project);

      if (state?.fromBidId) {
        await deleteBid(state.fromBidId);
      }

      navigate(`/project/${projectId}`);
    } catch (error) {
      console.error('Error saving project:', error);
      alert('Failed to save project.');
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

    const mode = extractionType;
    const region = { ...extractionRect };
    const cleanValue = (t: string) => (mode === 'pageNumber' ? cleanSheetNumber(t) : cleanDescriptionText(t));

    setIsExtracting(true);
    let worker: Awaited<ReturnType<typeof createWorker>> | null = null;
    try {
      worker = await createWorker('eng');
      await worker.setParameters(ocrParamsFor(mode));

      const recognizePage = async (p: PendingPage): Promise<string> => {
        const cropDataUrl = await buildOcrCrop(getImageUrl(p.imageId), region);
        const { data: { text } } = await worker!.recognize(cropDataUrl);
        return cleanValue(text || '');
      };

      if (applyToAll) {
        const updatedPages = [...pendingPages];
        for (let i = 0; i < updatedPages.length; i++) {
          const p = updatedPages[i];
          const value = await recognizePage(p);
          const num = mode === 'pageNumber' ? value : (p.pageNumber || '');
          const desc = mode === 'description' ? value : (p.description || '');
          updatedPages[i] = {
            ...p,
            [mode]: value,
            name: num && desc ? `${num} - ${desc}` : (num || desc || p.name),
          };
        }
        setPendingPages(updatedPages);
      } else {
        const page = pendingPages.find(p => p.id === previewPageId);
        if (page) {
          const value = await recognizePage(page);
          updatePendingPageField(previewPageId, mode, value);
        }
      }

      setExtractionRect(null);
    } catch (error) {
      console.error('OCR Error:', error);
      alert('Failed to extract text. Please try again.');
    } finally {
      if (worker) await worker.terminate();
      setIsExtracting(false);
    }
  };

  if (step === 'name_pages') {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-900 p-4 sm:p-8 font-sans">
        <div className="max-w-4xl mx-auto">
          <button
            onClick={() => setStep('details')}
            className="inline-flex items-center gap-2 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-300 mb-6 transition-colors font-medium"
          >
            <ArrowLeft size={18} />
            Back to Details
          </button>
          
          <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden">
            <div className="p-4 sm:p-8 border-b border-slate-100 dark:border-slate-700 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
              <div>
                <h1 className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white">Name Pages</h1>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Review and rename the imported pages before creating the project.</p>
              </div>
              <button
                onClick={handleSaveChanges}
                disabled={isProcessing}
                className="w-full sm:w-auto flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-medium text-white bg-accent-600 hover:bg-accent-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
              >
                {isProcessing ? (
                  <><Loader2 size={18} className="animate-spin" /> Saving...</>
                ) : (
                  <><Check size={18} /> Finish</>
                )}
              </button>
            </div>

            <div className="p-4 sm:p-8">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
                {pendingPages.map((page, index) => (
                  <div key={page.id} className="bg-white dark:bg-slate-800 rounded-2xl border-2 border-slate-100 dark:border-slate-700 overflow-hidden flex flex-col shadow-sm hover:shadow-md transition-all duration-300">
                    {/* Thumbnail Section */}
                    <div 
                      className="h-48 bg-slate-100 dark:bg-slate-700 relative flex-shrink-0 border-b border-slate-100 dark:border-slate-700 cursor-pointer overflow-hidden group"
                      onClick={() => setPreviewPageId(page.id)}
                    >
                      {pageThumbnails[page.imageId] ? (
                        <img 
                          src={pageThumbnails[page.imageId]} 
                          alt={`Page ${index + 1}`}
                          className="w-full h-full object-contain transition-transform duration-500 group-hover:scale-110"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-slate-400 dark:text-slate-500">
                          <Loader2 size={32} className="animate-spin" />
                        </div>
                      )}
                      
                      {/* Hover Overlay */}
                      <div className="absolute inset-0 bg-accent-600/0 group-hover:bg-accent-600/40 transition-all duration-300 flex flex-col items-center justify-center gap-3">
                        <div className="w-12 h-12 rounded-full bg-white/20 backdrop-blur-md flex items-center justify-center text-white opacity-0 group-hover:opacity-100 scale-50 group-hover:scale-100 transition-all duration-300">
                          <Eye size={24} />
                        </div>
                        <span className="text-white text-[10px] font-black uppercase tracking-[0.2em] opacity-0 group-hover:opacity-100 transition-all duration-300 translate-y-2 group-hover:translate-y-0">
                          Click to Preview
                        </span>
                      </div>

                      {/* Page Badge */}
                      <div className="absolute top-3 left-3 bg-white/90 backdrop-blur-md text-accent-600 text-[10px] font-black px-2.5 py-1.5 rounded-lg shadow-sm border border-accent-100">
                        PAGE {index + 1}
                      </div>
                    </div>

                    {/* Input Section */}
                    <div className="p-5 space-y-5">
                      <div className="space-y-2">
                        <div className="flex items-center justify-between px-1">
                          <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Page Number</label>
                          {page.pageNumber && <Check size={12} className="text-green-500" />}
                        </div>
                        <div className="relative">
                          <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400 dark:text-slate-500">
                            <Hash size={14} />
                          </div>
                          <input
                            type="text"
                            value={page.pageNumber || ''}
                            onChange={(e) => updatePendingPageField(page.id, 'pageNumber', e.target.value)}
                            className="w-full pl-10 pr-4 py-3 rounded-xl border-2 border-slate-100 bg-slate-50 focus:bg-white focus:border-accent-500 focus:ring-4 focus:ring-accent-500/10 outline-none transition-all text-sm font-bold text-slate-800 placeholder:text-slate-300 placeholder:font-normal dark:bg-slate-800/50 dark:border-slate-600 dark:text-white dark:placeholder-slate-500 dark:focus:bg-slate-800"
                            placeholder="e.g. A-101"
                          />
                        </div>
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center justify-between px-1">
                          <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest">Description</label>
                          {page.description && <Check size={12} className="text-green-500" />}
                        </div>
                        <div className="relative">
                          <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400 dark:text-slate-500">
                            <FileText size={14} />
                          </div>
                          <input
                            type="text"
                            value={page.description || ''}
                            onChange={(e) => updatePendingPageField(page.id, 'description', e.target.value)}
                            className="w-full pl-10 pr-4 py-3 rounded-xl border-2 border-slate-100 bg-slate-50 focus:bg-white focus:border-accent-500 focus:ring-4 focus:ring-accent-500/10 outline-none transition-all text-sm font-bold text-slate-800 placeholder:text-slate-300 placeholder:font-normal dark:bg-slate-800/50 dark:border-slate-600 dark:text-white dark:placeholder-slate-500 dark:focus:bg-slate-800"
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
          <div className="fixed inset-0 bg-slate-900/90 backdrop-blur-md flex items-center justify-center z-[70] p-0 sm:p-8">
            <div className="bg-white dark:bg-slate-800 rounded-none sm:rounded-2xl shadow-2xl w-full max-w-5xl h-full flex flex-col overflow-hidden">
              <div className="p-3 sm:p-4 border-b border-slate-100 dark:border-slate-700 flex flex-col sm:flex-row justify-between items-start sm:items-center bg-slate-50 dark:bg-slate-900 gap-3">
                <div className="flex items-center gap-3 w-full sm:w-auto">
                  <button
                    onClick={() => setPreviewPageId(null)}
                    className="p-2 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-full transition-colors text-slate-700 dark:text-slate-300"
                  >
                    <ArrowLeft size={20} />
                  </button>
                  <h3 className="font-bold text-slate-900 dark:text-white text-sm sm:text-base truncate">Page Preview & Extraction</h3>
                </div>
                <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
                  <div className="flex items-center bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-lg p-1">
                    <button
                      onClick={() => setZoom(prev => Math.max(1, prev - 0.5))}
                      className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-700 rounded text-slate-600 dark:text-slate-400 transition-colors"
                      title="Zoom Out"
                    >
                      <ZoomOut size={16} />
                    </button>
                    <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 w-10 text-center">{Math.round(zoom * 100)}%</span>
                    <button
                      onClick={() => setZoom(prev => Math.min(5, prev + 0.5))}
                      className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-700 rounded text-slate-600 dark:text-slate-400 transition-colors"
                      title="Zoom In"
                    >
                      <ZoomIn size={16} />
                    </button>
                  </div>

                  <div className="flex items-center gap-1 flex-1 sm:flex-none">
                    <button
                      onClick={() => setExtractionType('pageNumber')}
                      className={`flex-1 sm:flex-none px-3 py-1.5 rounded-lg text-[10px] sm:text-xs font-bold transition-all ${extractionType === 'pageNumber' ? 'bg-accent-600 text-white shadow-md' : 'bg-white dark:bg-slate-700 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-600 hover:border-accent-300'}`}
                    >
                      Number
                    </button>
                    <button
                      onClick={() => setExtractionType('description')}
                      className={`flex-1 sm:flex-none px-3 py-1.5 rounded-lg text-[10px] sm:text-xs font-bold transition-all ${extractionType === 'description' ? 'bg-accent-600 text-white shadow-md' : 'bg-white dark:bg-slate-700 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-600 hover:border-accent-300'}`}
                    >
                      Desc
                    </button>
                  </div>
                  
                  <button 
                    onClick={() => setPreviewPageId(null)}
                    className="hidden sm:block p-2 text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
                  >
                    <X size={24} />
                  </button>
                </div>
              </div>
              
              <div
                className={`flex-grow overflow-hidden relative bg-slate-800 flex items-center justify-center ${isPanning ? 'cursor-grabbing' : extractionType ? 'cursor-crosshair' : zoom > 1 ? 'cursor-grab' : 'cursor-default'}`}
                onWheel={(e) => {
                  e.preventDefault();
                  const zoomDirection = e.deltaY > 0 ? -1 : 1;
                  const zoomFactor = 1.15;
                  const newZoom = Math.min(5, Math.max(1, zoomDirection > 0 ? zoom * zoomFactor : zoom / zoomFactor));
                  if (newZoom === zoom) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const mouseX = e.clientX - (rect.left + rect.width / 2);
                  const mouseY = e.clientY - (rect.top + rect.height / 2);
                  const scaleRatio = newZoom / zoom;
                  const nextOffset = newZoom === 1
                    ? { x: 0, y: 0 }
                    : { x: mouseX - (mouseX - panOffset.x) * scaleRatio, y: mouseY - (mouseY - panOffset.y) * scaleRatio };
                  setPanOffset(nextOffset);
                  setZoom(newZoom);
                }}
                onMouseDown={(e) => {
                  // Middle mouse button pans, regardless of zoom level or extraction mode.
                  if (e.button === 1) {
                    e.preventDefault();
                    setIsPanning(true);
                    setPanStart({ x: e.clientX - panOffset.x, y: e.clientY - panOffset.y });
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
                    // The opposite corner stays anchored; only the dragged edges move.
                    const anchorX = interactionMode.includes('w') ? initialRect.x + initialRect.width : initialRect.x;
                    const anchorY = interactionMode.includes('n') ? initialRect.y + initialRect.height : initialRect.y;
                    const cursorX = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
                    const cursorY = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));

                    let { x: newX, y: newY, width: newW, height: newH } = initialRect;
                    if (interactionMode.includes('w') || interactionMode.includes('e')) {
                      newX = Math.min(cursorX, anchorX);
                      newW = Math.max(0.5, Math.abs(cursorX - anchorX));
                    }
                    if (interactionMode.includes('n') || interactionMode.includes('s')) {
                      newY = Math.min(cursorY, anchorY);
                      newH = Math.max(0.5, Math.abs(cursorY - anchorY));
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
                    if (e.button !== 0) return;
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
                      className="absolute border-accent-500 bg-accent-500/10 cursor-move pointer-events-auto"
                      style={{
                        left: `${extractionRect.x}%`,
                        top: `${extractionRect.y}%`,
                        width: `${extractionRect.width}%`,
                        height: `${extractionRect.height}%`,
                        borderStyle: 'solid',
                        borderWidth: `${1 / zoom}px`,
                      }}
                      onMouseDown={(e) => {
                        if (e.button !== 0) return;
                        e.stopPropagation();
                        setInteractionMode('move');
                        setSelectionStart({ x: e.clientX, y: e.clientY });
                        setInitialRect({ ...extractionRect });
                      }}
                    >
                      {([
                        { mode: 'resize-nw', pos: 'top-0 left-0', tx: '-50%', ty: '-50%', cursor: 'nwse-resize' },
                        { mode: 'resize-ne', pos: 'top-0 right-0', tx: '50%', ty: '-50%', cursor: 'nesw-resize' },
                        { mode: 'resize-sw', pos: 'bottom-0 left-0', tx: '-50%', ty: '50%', cursor: 'nesw-resize' },
                        { mode: 'resize-se', pos: 'bottom-0 right-0', tx: '50%', ty: '50%', cursor: 'nwse-resize' },
                      ] as const).map(h => (
                        <div
                          key={h.mode}
                          className={`absolute ${h.pos} flex items-center justify-center`}
                          style={{ width: 22, height: 22, transform: `translate(${h.tx}, ${h.ty}) scale(${1 / zoom})`, cursor: h.cursor }}
                          onMouseDown={(e) => {
                            if (e.button !== 0) return;
                            e.preventDefault();
                            e.stopPropagation();
                            setInteractionMode(h.mode);
                            setSelectionStart({ x: e.clientX, y: e.clientY });
                            setInitialRect({ ...extractionRect });
                          }}
                        >
                          <div className="w-2.5 h-2.5 rounded-[2px] bg-white border border-accent-600 shadow" />
                        </div>
                      ))}
                    </div>
                  )}
                  {!extractionType && zoom === 1 && (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                      <div className="bg-black/60 text-white px-6 py-3 rounded-xl backdrop-blur-md text-sm font-medium text-center">
                        Pick "Number" or "Desc", then drag a box around the text.<br />
                        <span className="text-white/70 text-xs">Scroll to zoom · middle-mouse drag to pan</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="p-4 sm:p-6 border-t border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 flex flex-col sm:flex-row justify-between items-center gap-4">
                <div className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400 w-full sm:w-auto">
                  {extractionRect ? (
                    <>
                      <div className="w-2 h-2 rounded-full bg-accent-500 animate-pulse" />
                      Area selected. Ready to extract.
                    </>
                  ) : (
                    <>
                      <div className="w-2 h-2 rounded-full bg-slate-300" />
                      Select an area to extract text.
                    </>
                  )}
                </div>
                <div className="flex flex-wrap items-center justify-center gap-2 w-full sm:w-auto">
                  <button
                    onClick={() => setExtractionRect(null)}
                    disabled={!extractionRect}
                    className="flex-1 sm:flex-none px-4 py-2 text-xs font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors disabled:opacity-50 disabled:hover:bg-transparent"
                  >
                    Clear
                  </button>
                  <button
                    onClick={() => handleExtractText(false)}
                    disabled={isExtracting || !extractionRect}
                    className="flex-1 sm:flex-none px-4 py-2 bg-slate-800 text-white rounded-lg text-xs font-bold hover:bg-slate-900 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    {isExtracting ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
                    Extract
                  </button>
                  <button
                    onClick={() => handleExtractText(true)}
                    disabled={isExtracting || !extractionRect}
                    className="flex-1 sm:flex-none px-4 py-2 bg-accent-600 text-white rounded-lg text-xs font-bold hover:bg-accent-700 transition-all flex items-center justify-center gap-2 shadow-lg shadow-accent-200 disabled:opacity-50"
                  >
                    {isExtracting ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                    All Pages
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
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 p-4 sm:p-8 font-sans">
      <div className="max-w-2xl mx-auto">
        <Link to="/" className="inline-flex items-center gap-2 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-300 mb-6 transition-colors font-medium">
          <ArrowLeft size={18} />
          Back to Projects
        </Link>
        
        <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden">
          <div className="p-6 sm:p-8 border-b border-slate-100 dark:border-slate-700">
            <h1 className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white">New Project</h1>
            <p className="text-sm sm:text-base text-slate-500 dark:text-slate-400 mt-1">Upload a blueprint PDF to get started</p>
          </div>

          <form onSubmit={handleProcessFiles} className="p-6 sm:p-8">
            <div className="space-y-6">
              <div>
                <label htmlFor="name" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                  Project Name
                </label>
                <input
                  type="text"
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-4 py-3 rounded-xl border border-slate-300 focus:ring-2 focus:ring-accent-500 focus:border-accent-500 outline-none transition-all dark:bg-slate-800/50 dark:border-slate-600 dark:text-white dark:placeholder-slate-500"
                  placeholder="e.g. Main Floor Plan"
                  required
                  disabled={isProcessing}
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="relative">
                  <label htmlFor="contractor" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                    Contractor (Optional)
                  </label>
                  <input
                    type="text"
                    id="contractor"
                    value={contractor}
                    onChange={(e) => {
                      setContractor(e.target.value);
                      setShowSuggestions(true);
                    }}
                    onFocus={() => setShowSuggestions(true)}
                    className="w-full px-4 py-3 rounded-xl border border-slate-300 focus:ring-2 focus:ring-accent-500 focus:border-accent-500 outline-none transition-all dark:bg-slate-800/50 dark:border-slate-600 dark:text-white dark:placeholder-slate-500"
                    placeholder="e.g. ABC Construction"
                    disabled={isProcessing}
                    autoComplete="off"
                  />
                  {showSuggestions && filteredContractors.length > 0 && (
                    <div
                      ref={suggestionRef}
                      className="absolute z-10 w-full mt-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-lg max-h-60 overflow-auto"
                    >
                      {filteredContractors.map((c, index) => (
                        <button
                          key={index}
                          type="button"
                          className="w-full text-left px-4 py-2 hover:bg-slate-50 dark:hover:bg-slate-700 text-slate-900 dark:text-slate-100 transition-colors first:rounded-t-xl last:rounded-b-xl"
                          onClick={() => {
                            setContractor(c);
                            setShowSuggestions(false);
                          }}
                        >
                          {c}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  <label htmlFor="address" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                    Address (Optional)
                  </label>
                  <AddressAutocomplete
                    value={address}
                    onChange={setAddress}
                    placeholder="e.g. 123 Main St, City, State"
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
                    className="w-full px-4 py-3 rounded-xl border border-slate-300 focus:ring-2 focus:ring-accent-500 focus:border-accent-500 outline-none transition-all"
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
                    className="w-full px-4 py-3 rounded-xl border border-slate-300 focus:ring-2 focus:ring-accent-500 focus:border-accent-500 outline-none transition-all"
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
                    className="w-full px-4 py-3 rounded-xl border border-slate-300 focus:ring-2 focus:ring-accent-500 focus:border-accent-500 outline-none transition-all"
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
                    files.length > 0 ? 'border-accent-300 bg-accent-50' : 'border-slate-300 hover:border-accent-400 bg-slate-50 hover:bg-slate-100 cursor-pointer'
                  }`}
                  onClick={() => !isProcessing && files.length === 0 && fileInputRef.current?.click()}
                  onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
                  onDragEnter={e => { e.preventDefault(); e.stopPropagation(); }}
                  onDrop={handleDrop}
                >
                  {files.length > 0 ? (
                    <div className="flex flex-col items-center w-full">
                      <div className="w-full max-w-md space-y-3 mb-4">
                        {files.map((file, index) => (
                          <div key={`${file.name}-${index}`} className="flex items-center justify-between bg-white p-3 rounded-lg border border-accent-200 shadow-sm">
                            <div className="flex items-center gap-3 overflow-hidden">
                              <FileText size={20} className="text-accent-500 shrink-0" />
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
                          className="mt-2 text-sm text-accent-600 hover:text-accent-700 font-medium flex items-center gap-1"
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
                className="flex items-center gap-2 px-6 py-3 rounded-xl font-medium text-white bg-accent-600 hover:bg-accent-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
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
