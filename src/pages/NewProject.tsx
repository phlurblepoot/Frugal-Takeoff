import React, { useState, useRef, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Upload, ArrowLeft, FileText, Loader2, Trash2, Plus, Check } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { Project, ProjectPage } from '../types';
import { saveProject, saveImage, getImage } from '../utils/store';
import { loadPdfAllPagesAsImages } from '../utils/pdf';

interface PendingPage {
  id: string;
  name: string;
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
  const [progress, setProgress] = useState({ current: 0, total: 0, currentFile: 0, totalFiles: 0 });
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [pendingPages, setPendingPages] = useState<PendingPage[]>([]);
  const [pageThumbnails, setPageThumbnails] = useState<Record<string, string>>({});

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
        
        const pagesData = await loadPdfAllPagesAsImages(file, (current, total) => {
          setProgress(prev => ({ ...prev, current, total }));
        });

        for (const pageData of pagesData) {
          const imageId = uuidv4();
          await saveImage(imageId, pageData.dataUrl);
          thumbnails[imageId] = pageData.dataUrl;
          
          extractedPages.push({
            id: uuidv4(),
            name: pageData.suggestedName || `Page ${globalPageNum}`,
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

      await saveProject(project);
      navigate(`/project/${projectId}`);
    } catch (error) {
      console.error('Error creating project:', error);
      alert('Failed to create project.');
    } finally {
      setIsProcessing(false);
    }
  };

  const updatePendingPageName = (id: string, newName: string) => {
    setPendingPages(prev => prev.map(p => p.id === id ? { ...p, name: newName } : p));
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
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6">
                {pendingPages.map((page, index) => (
                  <div key={page.id} className="bg-slate-50 rounded-xl border border-slate-200 overflow-hidden flex flex-col">
                    <div className="h-48 bg-slate-200 relative flex-shrink-0 border-b border-slate-200">
                      {pageThumbnails[page.imageId] ? (
                        <img 
                          src={pageThumbnails[page.imageId]} 
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
          </div>
        </div>
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
                    Processing {progress.totalFiles > 1 ? `File ${progress.currentFile}/${progress.totalFiles} ` : ''}
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
