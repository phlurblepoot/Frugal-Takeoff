import React, { useEffect, useState, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, FolderOpen, Trash2, Calendar, Building2, Filter, ArrowUpDown, ArrowUp, ArrowDown, Layout, MapPin, Users, LogOut } from 'lucide-react';
import { Project, Bid } from '../types';
import { getAllProjects, deleteProject, getActivePages, getBids, saveBid, deleteBid } from '../utils/store';
import { TemplatesView } from './TemplatesView';
import { UsersView } from './UsersView';
import { v4 as uuidv4 } from 'uuid';

type SortField = 'name' | 'contractor' | 'bidDueDate' | 'createdAt' | 'pages' | 'takeoffs';
type SortDirection = 'asc' | 'desc';
type Tab = 'projects' | 'templates' | 'bids' | 'users';

export const ProjectsList: React.FC = () => {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<Tab>('projects');
  const [projects, setProjects] = useState<Project[]>([]);
  const [bids, setBids] = useState<Bid[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filterContractor, setFilterContractor] = useState<string>('all');
  const [sortField, setSortField] = useState<SortField>('createdAt');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);
  const [deleteConfirmationText, setDeleteConfirmationText] = useState('');
  const [activePages, setActivePages] = useState<string[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);

  // New Bid state
  const [newBid, setNewBid] = useState({ name: '', contractor: '', address: '', decision: 'pending' as const });

  useEffect(() => {
    loadData();
    
    // Check if user is admin
    try {
      const userStr = localStorage.getItem('user');
      if (userStr) {
        const user = JSON.parse(userStr);
        setIsAdmin(user.role === 'admin');
      }
    } catch (e) {
      console.error('Failed to parse user data', e);
    }
    
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

  const handleAddBid = async () => {
    if (!newBid.name) return;
    const bid: Bid = {
      id: uuidv4(),
      ...newBid,
      createdAt: Date.now()
    };
    await saveBid(bid);
    const updatedBids = await getBids();
    setBids(updatedBids);
    setNewBid({ name: '', contractor: '', address: '', decision: 'pending' });
  };

  const handleUpdateBidDecision = async (id: string, decision: 'yes' | 'no' | 'pending') => {
    const bid = bids.find(b => b.id === id);
    if (bid) {
      await saveBid({ ...bid, decision });
      const updatedBids = await getBids();
      setBids(updatedBids);
    }
  };

  const handleDeleteBid = async (id: string) => {
    if (window.confirm('Are you sure you want to delete this bid?')) {
      await deleteBid(id);
      const updatedBids = await getBids();
      setBids(updatedBids);
    }
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
    return sortDirection === 'asc' ? <ArrowUp size={14} className="text-blue-500" /> : <ArrowDown size={14} className="text-blue-500" />;
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

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    navigate('/login');
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-8 font-sans">
      <div className="max-w-6xl mx-auto">
        <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center mb-6 sm:mb-8 gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-slate-900">Takeoff Pro</h1>
            <p className="text-sm sm:text-base text-slate-500 mt-1">Manage your projects and templates</p>
          </div>
          <div className="flex flex-wrap items-center gap-3 w-full lg:w-auto">
            {activeTab === 'projects' && (
              <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
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
                  className="flex-1 sm:flex-none flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 sm:px-5 py-2.5 rounded-lg font-medium transition-colors shadow-sm text-sm sm:text-base"
                >
                  <Plus size={20} />
                  New Project
                </Link>
              </div>
            )}
            <button
              onClick={handleLogout}
              className="flex items-center gap-2 text-slate-500 hover:text-red-600 px-3 py-2 rounded-lg font-medium transition-colors ml-auto lg:ml-0"
              title="Logout"
            >
              <LogOut size={18} />
              <span className="hidden sm:inline">Logout</span>
            </button>
          </div>
        </div>

        <div className="flex items-center gap-1 mb-6 bg-slate-200/50 p-1 rounded-xl w-full sm:w-fit overflow-x-auto no-scrollbar -mx-0 px-1">
          <button
            onClick={() => setActiveTab('projects')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all whitespace-nowrap ${
              activeTab === 'projects' 
                ? 'bg-white text-blue-600 shadow-sm' 
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <FolderOpen size={18} />
            Projects
          </button>
          <button
            onClick={() => setActiveTab('templates')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all whitespace-nowrap ${
              activeTab === 'templates' 
                ? 'bg-white text-blue-600 shadow-sm' 
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Layout size={18} />
            Templates
          </button>
          <button
            onClick={() => setActiveTab('bids')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all whitespace-nowrap ${
              activeTab === 'bids' 
                ? 'bg-white text-blue-600 shadow-sm' 
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Building2 size={18} />
            Bid Pipeline
          </button>
          {isAdmin && (
            <button
              onClick={() => setActiveTab('users')}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all whitespace-nowrap ${
                activeTab === 'users' 
                  ? 'bg-white text-blue-600 shadow-sm' 
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Users size={18} />
              Users
            </button>
          )}
        </div>

        {activeTab === 'projects' ? (
          <>
            {isLoading ? (
              <div className="flex justify-center py-12">
                <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : projects.length === 0 ? (
              <div className="bg-white rounded-xl border border-slate-200 p-12 text-center shadow-sm">
                <FolderOpen size={48} className="mx-auto text-slate-300 mb-4" />
                <h3 className="text-lg font-medium text-slate-900 mb-2">No projects yet</h3>
                <p className="text-slate-500 mb-6">Create your first project to start measuring blueprints.</p>
                <Link
                  to="/new"
                  className="inline-flex items-center gap-2 bg-blue-50 text-blue-700 hover:bg-blue-100 px-4 py-2 rounded-lg font-medium transition-colors"
                >
                  <Plus size={18} />
                  Create Project
                </Link>
              </div>
            ) : (
              <div className="space-y-4">
                {/* Desktop Table View */}
                <div className="hidden md:block bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-200">
                          <th 
                            className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase tracking-wider cursor-pointer group hover:bg-slate-100 transition-colors"
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
                            onClick={() => navigate(`/project/${project.id}`)}
                            className="hover:bg-blue-50/50 transition-colors cursor-pointer group"
                          >
                            <td className="px-6 py-4">
                              <div className="flex flex-col gap-1">
                                <div className="font-medium text-slate-900 group-hover:text-blue-600 transition-colors">
                                  {project.name}
                                </div>
                                <div className="flex flex-wrap gap-1.5 mt-1">
                                  {project.submitted && (
                                    <span className="px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 text-[10px] font-bold uppercase tracking-wider">Submitted</span>
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
                                    className="line-clamp-1 hover:text-blue-600 hover:underline transition-colors"
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
                  {filteredAndSortedProjects.map((project) => (
                    <div 
                      key={project.id}
                      onClick={() => navigate(`/project/${project.id}`)}
                      className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm active:bg-slate-50 transition-colors"
                    >
                      <div className="flex justify-between items-start mb-3">
                        <div className="font-bold text-slate-900 text-lg">{project.name}</div>
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
                          <span className="px-2 py-0.5 rounded bg-blue-100 text-blue-700 text-[10px] font-bold uppercase tracking-wider">Submitted</span>
                        )}
                        {project.responded && (
                          <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-700 text-[10px] font-bold uppercase tracking-wider">Responded</span>
                        )}
                        {project.accepted && (
                          <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 text-[10px] font-bold uppercase tracking-wider">Accepted</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : activeTab === 'bids' ? (
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="p-6 border-b border-slate-200 bg-slate-50">
              <h2 className="text-lg font-bold text-slate-900 mb-4">Add Potential Bid</h2>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Project Name</label>
                  <input
                    type="text"
                    value={newBid.name}
                    onChange={e => setNewBid({ ...newBid, name: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 focus:ring-2 focus:ring-blue-500 outline-none"
                    placeholder="e.g. City Hall Renovation"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Contractor</label>
                  <input
                    type="text"
                    value={newBid.contractor}
                    onChange={e => setNewBid({ ...newBid, contractor: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 focus:ring-2 focus:ring-blue-500 outline-none"
                    placeholder="e.g. ABC Construction"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Address</label>
                  <input
                    type="text"
                    value={newBid.address}
                    onChange={e => setNewBid({ ...newBid, address: e.target.value })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 focus:ring-2 focus:ring-blue-500 outline-none"
                    placeholder="e.g. 123 Main St"
                  />
                </div>
                <button
                  onClick={handleAddBid}
                  disabled={!newBid.name}
                  className="flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium transition-colors disabled:opacity-50 h-[42px]"
                >
                  <Plus size={18} />
                  Add Bid
                </button>
              </div>
            </div>

            {/* Desktop Table View */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Project Name</th>
                    <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Contractor</th>
                    <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Address</th>
                    <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Decision</th>
                    <th className="px-6 py-4 text-xs font-semibold text-slate-500 uppercase tracking-wider text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {bids.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-6 py-8 text-center text-slate-500">
                        No potential bids added yet.
                      </td>
                    </tr>
                  ) : (
                    bids.map((bid) => (
                      <tr key={bid.id} className="hover:bg-slate-50 transition-colors group">
                        <td className="px-6 py-4 font-medium text-slate-900">{bid.name}</td>
                        <td className="px-6 py-4 text-slate-600">{bid.contractor || '-'}</td>
                        <td className="px-6 py-4">
                          {bid.address ? (
                            <div className="flex items-center gap-2 text-sm text-slate-600">
                              <MapPin size={14} className="text-slate-400" />
                              <a 
                                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(bid.address)}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="line-clamp-1 hover:text-blue-600 hover:underline transition-colors"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {bid.address}
                              </a>
                            </div>
                          ) : (
                            <span className="text-sm text-slate-400 italic">-</span>
                          )}
                        </td>
                        <td className="px-6 py-4">
                          <select
                            value={bid.decision}
                            onChange={(e) => handleUpdateBidDecision(bid.id, e.target.value as any)}
                            className={`text-sm font-medium rounded-full px-3 py-1 outline-none border-2 ${
                              bid.decision === 'yes' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
                              bid.decision === 'no' ? 'bg-red-50 text-red-700 border-red-200' :
                              'bg-amber-50 text-amber-700 border-amber-200'
                            }`}
                          >
                            <option value="pending">Pending</option>
                            <option value="yes">Yes</option>
                            <option value="no">No</option>
                          </select>
                        </td>
                        <td className="px-6 py-4 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <button
                              onClick={() => handleConvertBid(bid)}
                              className="text-blue-600 hover:text-blue-700 hover:bg-blue-50 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors opacity-0 group-hover:opacity-100"
                            >
                              Convert to Project
                            </button>
                            <button
                              onClick={() => handleDeleteBid(bid.id)}
                              className="text-slate-400 hover:text-red-500 p-2 rounded-lg hover:bg-red-50 transition-colors opacity-0 group-hover:opacity-100"
                              title="Delete Bid"
                            >
                              <Trash2 size={18} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Mobile Card View for Bids */}
            <div className="md:hidden divide-y divide-slate-100">
              {bids.length === 0 ? (
                <div className="p-8 text-center text-slate-500">
                  No potential bids added yet.
                </div>
              ) : (
                bids.map((bid) => (
                  <div key={bid.id} className="p-4 space-y-3">
                    <div className="flex justify-between items-start">
                      <div className="font-bold text-slate-900">{bid.name}</div>
                      <button
                        onClick={() => handleDeleteBid(bid.id)}
                        className="text-slate-400 hover:text-red-500 p-1"
                      >
                        <Trash2 size={18} />
                      </button>
                    </div>
                    
                    <div className="space-y-2">
                      {bid.contractor && (
                        <div className="flex items-center gap-2 text-sm text-slate-600">
                          <Building2 size={14} className="text-slate-400 shrink-0" />
                          <span>{bid.contractor}</span>
                        </div>
                      )}
                      {bid.address && (
                        <div className="flex items-center gap-2 text-sm text-slate-600">
                          <MapPin size={14} className="text-slate-400 shrink-0" />
                          <span className="line-clamp-1">{bid.address}</span>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center justify-between pt-2">
                      <select
                        value={bid.decision}
                        onChange={(e) => handleUpdateBidDecision(bid.id, e.target.value as any)}
                        className={`text-xs font-bold uppercase tracking-wider rounded-full px-3 py-1 outline-none border-2 ${
                          bid.decision === 'yes' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
                          bid.decision === 'no' ? 'bg-red-50 text-red-700 border-red-200' :
                          'bg-amber-50 text-amber-700 border-amber-200'
                        }`}
                      >
                        <option value="pending">Pending</option>
                        <option value="yes">Yes</option>
                        <option value="no">No</option>
                      </select>
                      
                      <button
                        onClick={() => handleConvertBid(bid)}
                        className="text-blue-600 hover:text-blue-700 text-sm font-bold uppercase tracking-wider"
                      >
                        Convert
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : activeTab === 'users' && isAdmin ? (
          <UsersView />
        ) : (
          <TemplatesView />
        )}
      </div>

      {projectToDelete && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden p-6">
            <h3 className="text-xl font-bold text-slate-900 mb-2">Delete Project</h3>
            <p className="text-slate-600 mb-4">
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
