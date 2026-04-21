import React, { useEffect, useState, useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, FolderOpen, Trash2, Calendar, Building2, Filter, ArrowUpDown, ArrowUp, ArrowDown, Layout, MapPin, Users, Edit2, Check, X, Mail, Upload, Send, ChevronDown, ChevronUp, RefreshCw, FileText, ExternalLink } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Project, Bid, BidStatus } from '../types';
import { getAllProjects, deleteProject, getActivePages, getBids, saveBid, updateBid, deleteBid, saveProject, importEmailAsBid, sendProposal } from '../utils/store';
import { TemplatesView } from './TemplatesView';
import { v4 as uuidv4 } from 'uuid';

type SortField = 'name' | 'contractor' | 'bidDueDate' | 'createdAt' | 'pages' | 'takeoffs';
type SortDirection = 'asc' | 'desc';
type Tab = 'projects' | 'templates' | 'bids' | 'users';

export const ProjectsList: React.FC<{ appName: string; logoUrl: string }> = ({ appName, logoUrl }) => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = (searchParams.get('tab') as Tab) || 'projects';
  const setActiveTab = (tab: Tab) => {
    searchParams.set('tab', tab);
    setSearchParams(searchParams, { replace: true });
  };
  const filterContractor = searchParams.get('contractor') || 'all';
  const setFilterContractor = (contractor: string) => {
    if (contractor === 'all') {
      searchParams.delete('contractor');
    } else {
      searchParams.set('contractor', contractor);
    }
    setSearchParams(searchParams, { replace: true });
  };
  const searchTerm = searchParams.get('search') || '';
  const setSearchTerm = (term: string) => {
    if (term) {
      searchParams.set('search', term);
    } else {
      searchParams.delete('search');
    }
    setSearchParams(searchParams, { replace: true });
  };
  const [projects, setProjects] = useState<Project[]>([]);
  const [bids, setBids] = useState<Bid[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [sortField, setSortField] = useState<SortField>('createdAt');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);
  const [deleteConfirmationText, setDeleteConfirmationText] = useState('');
  const [activePages, setActivePages] = useState<string[]>([]);
  const [isAdmin] = useState(() => {
    try {
      const user = JSON.parse(localStorage.getItem('user') || '{}');
      return user.role === 'admin';
    } catch { return false; }
  });

  // Bid pipeline state
  const [bidFilter, setBidFilter] = useState<'all' | BidStatus>('all');
  const [expandedBidIds, setExpandedBidIds] = useState<Set<string>>(new Set());
  const [showImportModal, setShowImportModal] = useState(false);
  const [importForm, setImportForm] = useState({ from: '', fromName: '', subject: '', body: '' });
  const [importSaving, setImportSaving] = useState(false);
  const [showProposalModal, setShowProposalModal] = useState(false);
  const [proposalBid, setProposalBid] = useState<Bid | null>(null);
  const [proposalFileId, setProposalFileId] = useState('');
  const [proposalMessage, setProposalMessage] = useState('');
  const [proposalSending, setProposalSending] = useState(false);
  const [showAddManual, setShowAddManual] = useState(false);
  const [manualBid, setManualBid] = useState({ name: '', contractor: '', address: '' });

  useEffect(() => {
    loadData();

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
  }, []);

  const loadData = async () => {
    setIsLoading(true);
    const [projectsData, bidsData] = await Promise.all([
      getAllProjects(),
      getBids()
    ]);
    setProjects(projectsData);
    setBids(bidsData);
    setIsLoading(false);
  };

  const handleAddManualBid = async () => {
    if (!manualBid.name) return;
    const bid: Bid = { id: uuidv4(), ...manualBid, decision: 'new', createdAt: Date.now() };
    await saveBid(bid);
    setBids(await getBids());
    setManualBid({ name: '', contractor: '', address: '' });
    setShowAddManual(false);
  };

  const handleImportEmail = async () => {
    if (!importForm.subject && !importForm.body) return;
    setImportSaving(true);
    try {
      await importEmailAsBid(importForm);
      setBids(await getBids());
      setShowImportModal(false);
      setImportForm({ from: '', fromName: '', subject: '', body: '' });
    } catch (e: any) {
      alert('Failed to import: ' + (e.message || 'Unknown error'));
    } finally {
      setImportSaving(false);
    }
  };

  const handleUpdateBidStatus = async (id: string, decision: BidStatus) => {
    const bid = bids.find(b => b.id === id);
    if (bid) {
      const updated = { ...bid, decision };
      await updateBid(updated);
      setBids(prev => prev.map(b => b.id === id ? updated : b));
    }
  };

  const handleDeleteBid = async (id: string) => {
    if (!window.confirm('Delete this bid?')) return;
    await deleteBid(id);
    setBids(prev => prev.filter(b => b.id !== id));
  };

  const handleConvertBid = (bid: Bid) => {
    navigate('/new', {
      state: {
        initialName: bid.name,
        initialContractor: bid.contractor,
        initialAddress: bid.address,
        fromBidId: bid.id
      }
    });
  };

  const handleSendProposal = async () => {
    if (!proposalBid || !proposalFileId) return;
    setProposalSending(true);
    try {
      const updated = await sendProposal(proposalBid.id, proposalFileId, proposalMessage || undefined);
      setBids(prev => prev.map(b => b.id === updated.id ? updated : b));
      setShowProposalModal(false);
      setProposalBid(null);
      setProposalFileId('');
      setProposalMessage('');
    } catch (e: any) {
      alert('Failed to send: ' + (e.message || 'Unknown error'));
    } finally {
      setProposalSending(false);
    }
  };

  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [editingProjectName, setEditingProjectName] = useState('');

  const handleRename = async (project: Project) => {
    try {
      await saveProject({ ...project, name: editingProjectName });
      setProjects(prev => prev.map(p => p.id === project.id ? { ...p, name: editingProjectName } : p));
      setEditingProjectId(null);
    } catch (error) {
      console.error('Failed to rename project:', error);
    }
  };

  const handleDeleteClick = (e: React.MouseEvent, project: Project) => {
    e.preventDefault();
    e.stopPropagation();
    
    const hasActivePages = project.pages.some(page => activePages.includes(page.id));
    if (hasActivePages) {
      alert("This project has pages that are currently being viewed by other users and cannot be deleted.");
      return;
    }
    
    setProjectToDelete(project);
    setDeleteConfirmationText('');
  };

  const confirmDelete = async () => {
    if (projectToDelete && deleteConfirmationText.toLowerCase() === 'delete') {
      await deleteProject(projectToDelete.id);
      setProjectToDelete(null);
      loadData();
    }
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const contractors = useMemo(() => {
    const uniqueContractors = new Set<string>();
    projects.forEach(p => {
      if (p.contractor) uniqueContractors.add(p.contractor);
    });
    return Array.from(uniqueContractors).sort();
  }, [projects]);

  const filteredAndSortedProjects = useMemo(() => {
    let result = [...projects];

    if (filterContractor !== 'all') {
      result = result.filter(p => p.contractor === filterContractor);
    }

    if (searchTerm) {
      const lowerSearchTerm = searchTerm.toLowerCase();
      result = result.filter(p => 
        p.name.toLowerCase().includes(lowerSearchTerm) || 
        (p.contractor && p.contractor.toLowerCase().includes(lowerSearchTerm)) ||
        (p.address && p.address.toLowerCase().includes(lowerSearchTerm))
      );
    }

    result.sort((a, b) => {
      let comparison = 0;
      
      switch (sortField) {
        case 'name':
          comparison = a.name.localeCompare(b.name);
          break;
        case 'contractor':
          comparison = (a.contractor || '').localeCompare(b.contractor || '');
          break;
        case 'bidDueDate':
          if (!a.bidDueDate && !b.bidDueDate) comparison = 0;
          else if (!a.bidDueDate) comparison = 1;
          else if (!b.bidDueDate) comparison = -1;
          else comparison = a.bidDueDate - b.bidDueDate;
          break;
        case 'createdAt':
          comparison = a.createdAt - b.createdAt;
          break;
        case 'pages':
          comparison = a.pages.length - b.pages.length;
          break;
        case 'takeoffs':
          comparison = a.takeoffs.length - b.takeoffs.length;
          break;
      }

      return sortDirection === 'asc' ? comparison : -comparison;
    });

    return result;
  }, [projects, filterContractor, sortField, sortDirection]);

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ArrowUpDown size={14} className="text-slate-300 opacity-0 group-hover:opacity-100 transition-opacity" />;
    return sortDirection === 'asc' ? <ArrowUp size={14} className="text-accent-500" /> : <ArrowDown size={14} className="text-accent-500" />;
  };

  const getDueDateColor = (project: Project) => {
    if (project.submitted || !project.bidDueDate) return 'text-slate-600';
    
    const now = Date.now();
    const diff = project.bidDueDate - now;
    const days = diff / (1000 * 60 * 60 * 24);

    if (days < 0) return 'text-purple-600 font-bold';
    if (days <= 3) return 'text-red-600 font-bold';
    if (days <= 14) return 'text-amber-600 font-bold';
    
    return 'text-slate-600';
  };

  const getDueDateIconColor = (project: Project) => {
    if (project.submitted || !project.bidDueDate) return 'text-slate-400';
    
    const now = Date.now();
    const diff = project.bidDueDate - now;
    const days = diff / (1000 * 60 * 60 * 24);

    if (days < 0) return 'text-purple-400';
    if (days <= 3) return 'text-red-400';
    if (days <= 14) return 'text-amber-400';
    
    return 'text-slate-400';
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 p-4 sm:p-8 font-sans">
      <div className="max-w-6xl mx-auto">
        <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center mb-6 sm:mb-8 gap-4">
          <div className="flex items-center gap-4">
            {logoUrl ? (
              <img src={logoUrl} alt="Logo" className="h-12 w-auto object-contain" />
            ) : (
              <div className="w-12 h-12 bg-accent-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-accent-600/25">
                <FolderOpen size={28} />
              </div>
            )}
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 dark:text-white">{appName}</h1>
              <p className="text-sm sm:text-base text-slate-500 dark:text-slate-400 mt-1">Manage your projects and templates</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3 w-full lg:w-auto">
            {activeTab === 'projects' && (
              <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
                <div className="flex-1 sm:flex-none flex items-center gap-2 bg-white border border-slate-200 rounded-lg px-3 py-2 shadow-sm min-w-[200px]">
                  <input
                    type="text"
                    placeholder="Search projects..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="bg-transparent text-sm font-medium text-slate-700 outline-none w-full"
                  />
                </div>
                {contractors.length > 0 && (
                  <div className="flex-1 sm:flex-none flex items-center gap-2 bg-white border border-slate-200 rounded-lg px-3 py-2 shadow-sm">
                    <Filter size={16} className="text-slate-400" />
                    <select
                      value={filterContractor}
                      onChange={(e) => setFilterContractor(e.target.value)}
                      className="bg-transparent text-sm font-medium text-slate-700 outline-none w-full"
                    >
                      <option value="all">All Contractors</option>
                      {contractors.map(c => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </div>
                )}
                <Link
                  to="/new"
                  className="flex-1 sm:flex-none flex items-center justify-center gap-2 bg-accent-600 hover:bg-accent-700 text-white px-4 sm:px-5 py-2.5 rounded-lg font-medium transition-colors shadow-sm text-sm sm:text-base"
                >
                  <Plus size={20} />
                  New Project
                </Link>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1 mb-6 glass-subtle p-1 rounded-xl w-full sm:w-fit overflow-x-auto no-scrollbar -mx-0 px-1">
          <button
            onClick={() => setActiveTab('projects')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all whitespace-nowrap ${
              activeTab === 'projects'
                ? 'bg-white dark:bg-slate-800 text-accent-600 dark:text-accent-400 shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            <FolderOpen size={18} />
            Projects
          </button>
          <button
            onClick={() => setActiveTab('templates')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all whitespace-nowrap ${
              activeTab === 'templates'
                ? 'bg-white dark:bg-slate-800 text-accent-600 dark:text-accent-400 shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            <Layout size={18} />
            Templates
          </button>
          <button
            onClick={() => setActiveTab('bids')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all whitespace-nowrap ${
              activeTab === 'bids'
                ? 'bg-white dark:bg-slate-800 text-accent-600 dark:text-accent-400 shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            <Building2 size={18} />
            Bid Pipeline
          </button>
        </div>

        <AnimatePresence mode="wait">
        {activeTab === 'projects' ? (
          <motion.div key="projects"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }}
            exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
          >
          <>
            {isLoading ? (
              <div className="flex justify-center py-12">
                <div className="w-8 h-8 border-4 border-accent-600 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : projects.length === 0 ? (
              <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-12 text-center shadow-sm">
                <FolderOpen size={48} className="mx-auto text-slate-300 dark:text-slate-600 mb-4" />
                <h3 className="text-lg font-medium text-slate-900 dark:text-slate-100 mb-2">No projects yet</h3>
                <p className="text-slate-500 dark:text-slate-400 mb-6">Create your first project to start measuring blueprints.</p>
                <Link
                  to="/new"
                  className="inline-flex items-center gap-2 bg-accent-50 text-accent-700 hover:bg-accent-100 dark:bg-accent-900/30 dark:text-accent-300 dark:hover:bg-accent-900/50 px-4 py-2 rounded-lg font-medium transition-colors"
                >
                  <Plus size={18} />
                  Create Project
                </Link>
              </div>
            ) : (
              <div className="space-y-4">
                {/* Desktop Table View */}
                <div className="hidden md:block bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700">
                          <th
                            className="px-6 py-4 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider cursor-pointer group hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                            onClick={() => handleSort('name')}
                          >
                            <div className="flex items-center gap-2">
                              Project Name
                              <SortIcon field="name" />
                            </div>
                          </th>
                          <th 
                            className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase tracking-wider cursor-pointer group hover:bg-slate-100 transition-colors"
                            onClick={() => handleSort('contractor')}
                          >
                            <div className="flex items-center gap-2">
                              Contractor
                              <SortIcon field="contractor" />
                            </div>
                          </th>
                          <th 
                            className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase tracking-wider"
                          >
                            <div className="flex items-center gap-2">
                              Address
                            </div>
                          </th>
                          <th 
                            className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase tracking-wider cursor-pointer group hover:bg-slate-100 transition-colors"
                            onClick={() => handleSort('bidDueDate')}
                          >
                            <div className="flex items-center gap-2">
                              Bid Due Date
                              <SortIcon field="bidDueDate" />
                            </div>
                          </th>
                          <th 
                            className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase tracking-wider cursor-pointer group hover:bg-slate-100 transition-colors"
                            onClick={() => handleSort('createdAt')}
                          >
                            <div className="flex items-center gap-2">
                              Created
                              <SortIcon field="createdAt" />
                            </div>
                          </th>
                          <th 
                            className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase tracking-wider cursor-pointer group hover:bg-slate-100 transition-colors"
                            onClick={() => handleSort('pages')}
                          >
                            <div className="flex items-center gap-2">
                              Pages
                              <SortIcon field="pages" />
                            </div>
                          </th>
                          <th 
                            className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase tracking-wider cursor-pointer group hover:bg-slate-100 transition-colors text-right"
                          >
                            Actions
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {filteredAndSortedProjects.map((project) => (
                          <tr 
                            key={project.id}
                            onClick={() => navigate(`/project/${project.id}${searchTerm ? `?search=${encodeURIComponent(searchTerm)}` : ''}`)}
                            className="hover:bg-accent-50/50 dark:hover:bg-slate-700/50 transition-colors cursor-pointer group"
                          >
                            <td className="px-6 py-4">
                              <div className="flex flex-col gap-1">
                                {editingProjectId === project.id ? (
                                  <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                                    <input
                                      type="text"
                                      value={editingProjectName}
                                      onChange={e => setEditingProjectName(e.target.value)}
                                      onKeyDown={e => {
                                        if (e.key === 'Enter') handleRename(project);
                                        if (e.key === 'Escape') setEditingProjectId(null);
                                      }}
                                      className="px-2 py-1 text-sm border border-accent-500 rounded outline-none w-full"
                                      autoFocus
                                    />
                                    <button 
                                      onClick={() => handleRename(project)}
                                      className="p-1 text-emerald-600 hover:bg-emerald-50 rounded"
                                    >
                                      <Check size={16} />
                                    </button>
                                    <button 
                                      onClick={() => setEditingProjectId(null)}
                                      className="p-1 text-slate-400 hover:bg-slate-50 rounded"
                                    >
                                      <X size={16} />
                                    </button>
                                  </div>
                                ) : (
                                  <div className="flex items-center gap-2 group/name">
                                    <div className="font-medium text-slate-900 dark:text-slate-100 group-hover:text-accent-600 dark:group-hover:text-accent-400 transition-colors">
                                      {project.name}
                                    </div>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setEditingProjectId(project.id);
                                        setEditingProjectName(project.name);
                                      }}
                                      className="p-1 text-slate-400 hover:text-accent-600 opacity-0 group-hover/name:opacity-100 transition-all"
                                    >
                                      <Edit2 size={12} />
                                    </button>
                                  </div>
                                )}
                                <div className="flex flex-wrap gap-1.5 mt-1">
                                  {project.submitted && (
                                    <span className="px-1.5 py-0.5 rounded bg-accent-100 text-accent-700 text-[10px] font-bold uppercase tracking-wider">Submitted</span>
                                  )}
                                  {project.responded && (
                                    <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 text-[10px] font-bold uppercase tracking-wider">Responded</span>
                                  )}
                                  {project.accepted && (
                                    <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 text-[10px] font-bold uppercase tracking-wider">Accepted</span>
                                  )}
                                </div>
                              </div>
                            </td>
                            <td className="px-6 py-4">
                              {project.contractor ? (
                                <div className="flex items-center gap-2 text-sm text-slate-600">
                                  <Building2 size={14} className="text-slate-400" />
                                  <span className="line-clamp-1">{project.contractor}</span>
                                </div>
                              ) : (
                                <span className="text-sm text-slate-400 italic">-</span>
                              )}
                            </td>
                            <td className="px-6 py-4">
                              {project.address ? (
                                <div className="flex items-center gap-2 text-sm text-slate-600">
                                  <MapPin size={14} className="text-slate-400" />
                                  <a 
                                    href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(project.address)}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="line-clamp-1 hover:text-accent-600 hover:underline transition-colors"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    {project.address}
                                  </a>
                                </div>
                              ) : (
                                <span className="text-sm text-slate-400 italic">-</span>
                              )}
                            </td>
                            <td className="px-6 py-4">
                              {project.bidDueDate ? (
                                <div className="flex items-center gap-2 text-sm">
                                  <Calendar size={14} className={getDueDateIconColor(project)} />
                                  <span className={getDueDateColor(project)}>
                                    {new Date(project.bidDueDate).toLocaleDateString()}
                                  </span>
                                </div>
                              ) : (
                                <span className="text-sm text-slate-400 italic">-</span>
                              )}
                            </td>
                            <td className="px-6 py-4">
                              <span className="text-sm text-slate-600">
                                {new Date(project.createdAt).toLocaleDateString()}
                              </span>
                            </td>
                            <td className="px-6 py-4">
                              <span className="inline-flex items-center justify-center px-2.5 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-700">
                                {project.pages.length}
                              </span>
                            </td>
                            <td className="px-6 py-4 text-right">
                              <button
                                onClick={(e) => handleDeleteClick(e, project)}
                                className="text-slate-400 hover:text-red-500 p-2 rounded-lg hover:bg-red-50 transition-colors opacity-0 group-hover:opacity-100"
                                title="Delete Project"
                              >
                                <Trash2 size={18} />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Mobile Card View */}
                <div className="md:hidden space-y-4">
                  {filteredAndSortedProjects.map((project, i) => (
                    <motion.div
                      key={project.id}
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.22, delay: Math.min(i * 0.04, 0.3) }}
                      onClick={() => navigate(`/project/${project.id}${searchTerm ? `?search=${encodeURIComponent(searchTerm)}` : ''}`)}
                      className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-4 shadow-sm active:bg-slate-50 dark:active:bg-slate-700 transition-colors"
                    >
                      <div className="flex justify-between items-start mb-3">
                        <div className="font-bold text-slate-900 dark:text-white text-lg">{project.name}</div>
                        <button
                          onClick={(e) => handleDeleteClick(e, project)}
                          className="text-slate-400 hover:text-red-500 p-1"
                        >
                          <Trash2 size={18} />
                        </button>
                      </div>
                      
                      <div className="space-y-2 mb-4">
                        {project.contractor && (
                          <div className="flex items-center gap-2 text-sm text-slate-600">
                            <Building2 size={14} className="text-slate-400 shrink-0" />
                            <span>{project.contractor}</span>
                          </div>
                        )}
                        {project.address && (
                          <div className="flex items-center gap-2 text-sm text-slate-600">
                            <MapPin size={14} className="text-slate-400 shrink-0" />
                            <span className="line-clamp-1">{project.address}</span>
                          </div>
                        )}
                        <div className="flex items-center justify-between">
                          {project.bidDueDate ? (
                            <div className="flex items-center gap-2 text-sm">
                              <Calendar size={14} className={getDueDateIconColor(project)} />
                              <span className={getDueDateColor(project)}>
                                Due: {new Date(project.bidDueDate).toLocaleDateString()}
                              </span>
                            </div>
                          ) : (
                            <div className="text-sm text-slate-400">No due date</div>
                          )}
                          <div className="text-xs text-slate-500">
                            {project.pages.length} {project.pages.length === 1 ? 'page' : 'pages'}
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-1.5">
                        {project.submitted && (
                          <span className="px-2 py-0.5 rounded bg-accent-100 text-accent-700 text-[10px] font-bold uppercase tracking-wider">Submitted</span>
                        )}
                        {project.responded && (
                          <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-700 text-[10px] font-bold uppercase tracking-wider">Responded</span>
                        )}
                        {project.accepted && (
                          <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 text-[10px] font-bold uppercase tracking-wider">Accepted</span>
                        )}
                      </div>
                    </motion.div>
                  ))}
                </div>
              </div>
            )}
          </>
          </motion.div>
        ) : activeTab === 'bids' ? (
          <motion.div key="bids"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }}
            exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
          >
          {/* Bid Pipeline Header */}
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div className="flex flex-wrap gap-2">
              {(['all', 'new', 'reviewing', 'proposal_sent', 'won', 'lost'] as const).map(f => {
                const count = f === 'all' ? bids.length : bids.filter(b => b.decision === f || (f === 'new' && (b.decision === 'pending')) || (f === 'won' && b.decision === 'yes') || (f === 'lost' && b.decision === 'no')).length;
                const labels: Record<string, string> = { all: 'All', new: 'New', reviewing: 'Reviewing', proposal_sent: 'Sent', won: 'Won', lost: 'Lost' };
                return (
                  <button key={f} onClick={() => setBidFilter(f)}
                    className={`px-3 py-1.5 rounded-full text-sm font-medium transition-all ${bidFilter === f ? 'bg-accent-600 text-white shadow-sm' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:border-accent-300'}`}>
                    {labels[f]} {count > 0 && <span className={`ml-1 text-xs ${bidFilter === f ? 'opacity-75' : 'text-slate-400'}`}>{count}</span>}
                  </button>
                );
              })}
            </div>
            <div className="flex gap-2">
              <button onClick={() => setShowAddManual(p => !p)} className="flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-300 dark:border-slate-600 text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all">
                <Plus size={15} /> Add Manually
              </button>
              <button onClick={() => setShowImportModal(true)} className="flex items-center gap-2 px-4 py-2 rounded-xl bg-accent-600 text-white text-sm font-medium hover:bg-accent-700 transition-all shadow-sm">
                <Mail size={15} /> Import Email
              </button>
            </div>
          </div>

          {/* Manual Add Form */}
          {showAddManual && (
            <div className="mb-4 p-4 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm">
              <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-3 uppercase tracking-wider">Add Bid Manually</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <input className="w-full px-3 py-2.5 rounded-xl border border-slate-300 dark:border-slate-600 dark:bg-slate-800/50 dark:text-white outline-none focus:ring-2 focus:ring-accent-500 text-sm" value={manualBid.name} onChange={e => setManualBid(m => ({ ...m, name: e.target.value }))} placeholder="Project name *" />
                <input className="w-full px-3 py-2.5 rounded-xl border border-slate-300 dark:border-slate-600 dark:bg-slate-800/50 dark:text-white outline-none focus:ring-2 focus:ring-accent-500 text-sm" value={manualBid.contractor} onChange={e => setManualBid(m => ({ ...m, contractor: e.target.value }))} placeholder="Contractor / company" />
                <input className="w-full px-3 py-2.5 rounded-xl border border-slate-300 dark:border-slate-600 dark:bg-slate-800/50 dark:text-white outline-none focus:ring-2 focus:ring-accent-500 text-sm" value={manualBid.address} onChange={e => setManualBid(m => ({ ...m, address: e.target.value }))} placeholder="Address" />
              </div>
              <div className="flex gap-2 mt-3 justify-end">
                <button onClick={() => setShowAddManual(false)} className="px-3 py-2 rounded-xl border border-slate-300 dark:border-slate-600 text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-all">Cancel</button>
                <button onClick={handleAddManualBid} disabled={!manualBid.name} className="px-4 py-2 rounded-xl bg-accent-600 text-white text-sm font-medium hover:bg-accent-700 transition-all disabled:opacity-50">Add Bid</button>
              </div>
            </div>
          )}

          {/* Bid Cards */}
          {(() => {
            const STATUS_LABEL: Record<string, string> = { new: 'New', reviewing: 'Reviewing', proposal_sent: 'Proposal Sent', won: 'Won', lost: 'Lost', pending: 'Pending', yes: 'Won', no: 'Lost' };
            const STATUS_CLS: Record<string, string> = {
              new: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700',
              reviewing: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700',
              proposal_sent: 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-900/30 dark:text-purple-300 dark:border-purple-700',
              won: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-700',
              lost: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-700',
              pending: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700',
              yes: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-700',
              no: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-700',
            };
            const visibleBids = bids.filter(b => {
              if (bidFilter === 'all') return true;
              if (bidFilter === 'won') return b.decision === 'won' || b.decision === 'yes';
              if (bidFilter === 'lost') return b.decision === 'lost' || b.decision === 'no';
              if (bidFilter === 'new') return b.decision === 'new' || b.decision === 'pending';
              return b.decision === bidFilter;
            });
            if (visibleBids.length === 0) return (
              <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm p-12 text-center text-slate-400 dark:text-slate-500">
                {bids.length === 0
                  ? <><Mail size={36} className="mx-auto mb-3 opacity-30" /><p className="font-medium">No bids yet</p><p className="text-sm mt-1">Import an email invitation or add a bid manually.</p></>
                  : <p>No bids in this category.</p>
                }
              </div>
            );
            return (
              <div className="space-y-3">
                {visibleBids.map(bid => {
                  const isExpanded = expandedBidIds.has(bid.id);
                  const linkedProject = bid.projectId ? projects.find(p => p.id === bid.projectId) : null;
                  return (
                    <div key={bid.id} className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
                      {/* Card Header */}
                      <div className="p-4 flex items-start gap-4">
                        <div className={`mt-0.5 p-2 rounded-lg shrink-0 ${bid.email ? 'bg-accent-50 dark:bg-accent-900/30' : 'bg-slate-100 dark:bg-slate-700'}`}>
                          <Mail size={18} className={bid.email ? 'text-accent-600 dark:text-accent-400' : 'text-slate-400'} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div>
                              <p className="font-bold text-slate-900 dark:text-white leading-tight">{bid.email?.subject || bid.name}</p>
                              {bid.email ? (
                                <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
                                  <span className="font-medium text-slate-700 dark:text-slate-300">{bid.email.fromName || bid.email.from}</span>
                                  {bid.email.fromName && <span className="text-slate-400"> &lt;{bid.email.from}&gt;</span>}
                                  <span className="ml-2">{new Date(bid.email.receivedAt).toLocaleDateString()}</span>
                                </p>
                              ) : (
                                <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">{bid.contractor || 'No contractor'}</p>
                              )}
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <select value={bid.decision} onChange={e => handleUpdateBidStatus(bid.id, e.target.value as BidStatus)}
                                className={`text-xs font-semibold rounded-full px-3 py-1 outline-none border cursor-pointer ${STATUS_CLS[bid.decision] || STATUS_CLS.new}`}>
                                <option value="new">New</option>
                                <option value="reviewing">Reviewing</option>
                                <option value="proposal_sent">Proposal Sent</option>
                                <option value="won">Won</option>
                                <option value="lost">Lost</option>
                              </select>
                            </div>
                          </div>
                          {/* Body preview */}
                          {bid.email?.body && (
                            <p className={`text-sm text-slate-500 dark:text-slate-400 mt-2 ${isExpanded ? '' : 'line-clamp-2'} whitespace-pre-wrap`}>
                              {bid.email.body}
                            </p>
                          )}
                          {/* Actions row */}
                          <div className="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-slate-100 dark:border-slate-700">
                            {bid.email?.body && (
                              <button onClick={() => setExpandedBidIds(s => { const n = new Set(s); isExpanded ? n.delete(bid.id) : n.add(bid.id); return n; })}
                                className="flex items-center gap-1 text-xs text-slate-500 hover:text-accent-600 transition-colors">
                                {isExpanded ? <><ChevronUp size={13} /> Show less</> : <><ChevronDown size={13} /> Show full email</>}
                              </button>
                            )}
                            <div className="ml-auto flex items-center gap-2">
                              {bid.proposalSentAt && (
                                <span className="text-xs text-slate-400">Proposal sent {new Date(bid.proposalSentAt).toLocaleDateString()}</span>
                              )}
                              {linkedProject ? (
                                <Link to={`/project/${linkedProject.id}`} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-accent-300 dark:border-accent-700 text-xs font-medium text-accent-600 dark:text-accent-400 hover:bg-accent-50 dark:hover:bg-accent-900/30 transition-all">
                                  <ExternalLink size={13} /> Open Project
                                </Link>
                              ) : (
                                <button onClick={() => handleConvertBid(bid)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-all">
                                  <FolderOpen size={13} /> Create Project
                                </button>
                              )}
                              {bid.email && (
                                <button onClick={() => { setProposalBid(bid); setShowProposalModal(true); }}
                                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent-600 text-white text-xs font-medium hover:bg-accent-700 transition-all">
                                  <Send size={13} /> Send Proposal
                                </button>
                              )}
                              <button onClick={() => handleDeleteBid(bid.id)} className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 transition-all">
                                <Trash2 size={15} />
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
          </motion.div>
        ) : (
          <motion.div key="templates"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }}
            exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
          >
            <TemplatesView />
          </motion.div>
        )}
        </AnimatePresence>
      </div>

      {/* Import Email Modal */}
      {showImportModal && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-xl w-full max-w-xl">
            <div className="p-6 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2"><Mail size={20} className="text-accent-600" /> Import Email</h3>
              <button onClick={() => setShowImportModal(false)} className="p-2 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-all"><X size={18} /></button>
            </div>
            <div className="p-6 space-y-4">
              <p className="text-sm text-slate-500 dark:text-slate-400">Paste the details from the invitation email. The subject line will become the bid name.</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider mb-1.5">From Name</label>
                  <input className="w-full px-3 py-2 rounded-xl border border-slate-300 dark:border-slate-600 dark:bg-slate-800/50 dark:text-white text-sm outline-none focus:ring-2 focus:ring-accent-500" value={importForm.fromName} onChange={e => setImportForm(f => ({ ...f, fromName: e.target.value }))} placeholder="John Smith" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider mb-1.5">From Email</label>
                  <input className="w-full px-3 py-2 rounded-xl border border-slate-300 dark:border-slate-600 dark:bg-slate-800/50 dark:text-white text-sm outline-none focus:ring-2 focus:ring-accent-500" value={importForm.from} onChange={e => setImportForm(f => ({ ...f, from: e.target.value }))} placeholder="john@contractor.com" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider mb-1.5">Subject *</label>
                <input className="w-full px-3 py-2 rounded-xl border border-slate-300 dark:border-slate-600 dark:bg-slate-800/50 dark:text-white text-sm outline-none focus:ring-2 focus:ring-accent-500" value={importForm.subject} onChange={e => setImportForm(f => ({ ...f, subject: e.target.value }))} placeholder="ITB: City Hall Renovation - Due May 15" required />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider mb-1.5">Email Body</label>
                <textarea rows={6} className="w-full px-3 py-2 rounded-xl border border-slate-300 dark:border-slate-600 dark:bg-slate-800/50 dark:text-white text-sm outline-none focus:ring-2 focus:ring-accent-500 resize-none" value={importForm.body} onChange={e => setImportForm(f => ({ ...f, body: e.target.value }))} placeholder="Paste the email body here…" />
              </div>
            </div>
            <div className="p-6 pt-0 flex justify-end gap-3">
              <button onClick={() => setShowImportModal(false)} className="px-4 py-2 rounded-xl border border-slate-300 dark:border-slate-600 text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-all">Cancel</button>
              <button onClick={handleImportEmail} disabled={importSaving || (!importForm.subject && !importForm.body)} className="px-4 py-2 rounded-xl bg-accent-600 text-white text-sm font-medium hover:bg-accent-700 transition-all disabled:opacity-50 flex items-center gap-2">
                {importSaving ? <><RefreshCw size={15} className="animate-spin" /> Importing…</> : <><Upload size={15} /> Import</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Send Proposal Modal */}
      {showProposalModal && proposalBid && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-xl w-full max-w-xl">
            <div className="p-6 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2"><Send size={20} className="text-accent-600" /> Send Proposal</h3>
              <button onClick={() => setShowProposalModal(false)} className="p-2 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-all"><X size={18} /></button>
            </div>
            <div className="p-6 space-y-4">
              <div className="bg-slate-50 dark:bg-slate-900/50 rounded-xl p-3 text-sm">
                <p className="text-slate-500 dark:text-slate-400 text-xs uppercase font-bold tracking-wider mb-1">Replying to</p>
                <p className="font-semibold text-slate-800 dark:text-slate-200">{proposalBid.email?.fromName || proposalBid.email?.from}</p>
                <p className="text-slate-500 dark:text-slate-400 text-xs">{proposalBid.email?.from} · Re: {proposalBid.email?.subject}</p>
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider mb-1.5">Attach Proposal</label>
                <select className="w-full px-3 py-2 rounded-xl border border-slate-300 dark:border-slate-600 dark:bg-slate-800/50 dark:text-white text-sm outline-none focus:ring-2 focus:ring-accent-500"
                  value={proposalFileId} onChange={e => setProposalFileId(e.target.value)}>
                  <option value="">— Select a printout —</option>
                  {projects.flatMap(p => (p.printouts || []).filter(pr => pr.type === 'pdf').map(pr => (
                    <option key={pr.fileId} value={pr.fileId}>{p.name} › {pr.name}</option>
                  )))}
                </select>
                {projects.every(p => !(p.printouts || []).some(pr => pr.type === 'pdf')) && (
                  <p className="mt-1.5 text-xs text-slate-400">No PDF printouts found. Generate one from a project first.</p>
                )}
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider mb-1.5">Message <span className="font-normal text-slate-400 normal-case">(optional)</span></label>
                <textarea rows={4} className="w-full px-3 py-2 rounded-xl border border-slate-300 dark:border-slate-600 dark:bg-slate-800/50 dark:text-white text-sm outline-none focus:ring-2 focus:ring-accent-500 resize-none" value={proposalMessage} onChange={e => setProposalMessage(e.target.value)} placeholder="Please find our proposal attached. Don't hesitate to reach out with any questions." />
              </div>
            </div>
            <div className="p-6 pt-0 flex justify-end gap-3">
              <button onClick={() => setShowProposalModal(false)} className="px-4 py-2 rounded-xl border border-slate-300 dark:border-slate-600 text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-all">Cancel</button>
              <button onClick={handleSendProposal} disabled={proposalSending || !proposalFileId} className="px-4 py-2 rounded-xl bg-accent-600 text-white text-sm font-medium hover:bg-accent-700 transition-all disabled:opacity-50 flex items-center gap-2">
                {proposalSending ? <><RefreshCw size={15} className="animate-spin" /> Sending…</> : <><Send size={15} /> Send</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {projectToDelete && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="glass-card w-full max-w-md overflow-hidden p-6">
            <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2">Delete Project</h3>
            <p className="text-slate-600 dark:text-slate-300 mb-4">
              Are you sure you want to delete <strong>{projectToDelete.name}</strong>? This action cannot be undone.
            </p>
            <div className="mb-6">
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Type <strong>delete</strong> to confirm
              </label>
              <input
                type="text"
                value={deleteConfirmationText}
                onChange={(e) => setDeleteConfirmationText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && deleteConfirmationText.toLowerCase() === 'delete') {
                    confirmDelete();
                  }
                }}
                className="w-full px-4 py-2 rounded-lg border border-slate-300 focus:ring-2 focus:ring-red-500 focus:border-red-500 outline-none transition-all"
                placeholder="delete"
                autoFocus
              />
            </div>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setProjectToDelete(null)}
                className="px-4 py-2 rounded-lg font-medium text-slate-600 hover:bg-slate-100 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                disabled={deleteConfirmationText.toLowerCase() !== 'delete'}
                className="px-4 py-2 rounded-lg font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Confirm Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
