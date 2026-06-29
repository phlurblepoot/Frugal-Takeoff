// src/pages/project/ProjectPagesTab.tsx
//
// Pages tab content extracted verbatim from ProjectView (Phase 5g Task 1).
// Behavior-preserving controlled component: ALL state, setters, handlers,
// effects, and refs live in ProjectView and are passed in as props. Only the
// JSX moved here. The search/sort/view toolbar, empty state, list + grid views,
// inline rename editor, favorites, multi-select, revision badges, and the
// right-click context menu are unchanged (same classes/testids/handlers).
import React from 'react';
import { Link } from 'react-router-dom';
import {
  Search, X, LayoutGrid, List, Link as LinkIcon, Settings, Loader2, Edit2,
  Plus, FileImage, Check, Star, Eye, History, Copy, Trash2,
} from 'lucide-react';
import { Project, ProjectPage } from '../../types';
import { getImageUrl } from '../../utils/store';
import { effectiveSheetId } from '../../utils/planSets';
import { RevisionModel } from '../../utils/planSets';

type PagesSortMode = 'pageNumber' | 'description' | 'highlightsDesc';
type PagesViewMode = 'grid' | 'list';

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

interface ProjectPagesTabProps {
  // state / computed
  project: Project;
  filteredPages: ProjectPage[];
  visiblePages: ProjectPage[];
  searchTerm: string;
  pagesViewMode: PagesViewMode;
  pagesSortMode: PagesSortMode;
  pageContextMenu: { pageId: string; x: number; y: number } | null;
  favoritePageIds: Set<string>;
  selectedPageIds: Set<string>;
  editingPageId: string | null;
  editingPageNumber: string;
  editingPageDescription: string;
  revisionModel: RevisionModel;
  isOptimizingThumbnails: boolean;
  optimizeProgress: { current: number; total: number };
  // setters
  setSearchTerm: (term: string) => void;
  setPagesSortMode: (mode: PagesSortMode) => void;
  setPagesViewMode: (mode: PagesViewMode) => void;
  setSelectedPageIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setPageContextMenu: React.Dispatch<React.SetStateAction<{ pageId: string; x: number; y: number } | null>>;
  setEditingPageNumber: (value: string) => void;
  setEditingPageDescription: (value: string) => void;
  setShowAddPagesModal: (open: boolean) => void;
  setShowRevisionsForPageId: (pageId: string | null) => void;
  // handlers
  toggleFavorite: (pageId: string) => void;
  handleStartRenamePage: (e: React.MouseEvent, page: ProjectPage) => void;
  handleSaveRenamePage: (e: React.MouseEvent, pageId: string) => void | Promise<void>;
  handleCancelRenamePage: (e: React.MouseEvent) => void;
  handleSharePage: (page: { imageId: string; name?: string; description?: string }) => void | Promise<void>;
  handleDeletePage: (page: { id: string; name?: string; pageNumber?: string }) => void | Promise<void>;
  handleShareSelectedPages: () => void | Promise<void>;
  handleOptimizeThumbnails: () => void | Promise<void>;
  handleOpenNamePages: () => void;
  // utilities
  navigate: (to: string) => void;
  toast: (message: string, options?: { type?: 'info' | 'success' | 'warning' | 'error' }) => void;
  // refs
  pageSearchInputRef: React.RefObject<HTMLInputElement>;
}

export function ProjectPagesTab({
  project,
  filteredPages,
  visiblePages,
  searchTerm,
  pagesViewMode,
  pagesSortMode,
  pageContextMenu,
  favoritePageIds,
  selectedPageIds,
  editingPageId,
  editingPageNumber,
  editingPageDescription,
  revisionModel,
  isOptimizingThumbnails,
  optimizeProgress,
  setSearchTerm,
  setPagesSortMode,
  setPagesViewMode,
  setSelectedPageIds,
  setPageContextMenu,
  setEditingPageNumber,
  setEditingPageDescription,
  setShowAddPagesModal,
  setShowRevisionsForPageId,
  toggleFavorite,
  handleStartRenamePage,
  handleSaveRenamePage,
  handleCancelRenamePage,
  handleSharePage,
  handleDeletePage,
  handleShareSelectedPages,
  handleOptimizeThumbnails,
  handleOpenNamePages,
  navigate,
  toast,
  pageSearchInputRef,
}: ProjectPagesTabProps) {
  return (
          <div className="space-y-6">
            <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4">
              <div className="flex-1 w-full max-w-md flex flex-col gap-1">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                  <input
                    data-testid="page-search"
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
                    data-testid="view-grid"
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
                    data-testid="view-list"
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
                  data-testid="btn-add-pages"
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
              <div data-testid="pages-list" className="flex flex-col gap-2">
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
                      data-testid="page-row"
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
                              : 'bg-white/80 border-slate-300 opacity-100 can-hover:opacity-0 can-hover:group-hover:opacity-100 focus-visible:opacity-100'
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
                              data-testid="page-rename-input"
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
                                    : 'opacity-100 can-hover:opacity-0 can-hover:group-hover:opacity-100 focus-visible:opacity-100 hover:bg-amber-50 dark:hover:bg-amber-900/20'
                                }`}
                              >
                                <Star
                                  size={14}
                                  className={isFavorite ? 'text-amber-500 fill-amber-400' : 'text-slate-400 hover:text-amber-500'}
                                />
                              </button>
                              <button
                                onClick={(e) => { e.preventDefault(); handleSharePage(page); }}
                                className="text-slate-400 hover:text-accent-600 p-1 rounded hover:bg-accent-50 opacity-100 can-hover:opacity-0 can-hover:group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                                title="Copy share link"
                              >
                                <LinkIcon size={14} />
                              </button>
                              <button
                                onClick={(e) => handleStartRenamePage(e, page)}
                                className="text-slate-400 hover:text-accent-600 p-1 rounded hover:bg-accent-50 opacity-100 can-hover:opacity-0 can-hover:group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
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
              <div data-testid="pages-list" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                {filteredPages.map((page) => {
                  const isPageSelected = selectedPageIds.has(page.id);
                  const isFavorite = favoritePageIds.has(page.id);
                  return (
                  <Link
                    key={page.id}
                    data-testid="page-row"
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
                            : 'bg-white/80 border-slate-300 opacity-100 can-hover:opacity-0 can-hover:group-hover:opacity-100 focus-visible:opacity-100'
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
                            : 'bg-white/80 opacity-100 can-hover:bg-white/0 can-hover:opacity-0 can-hover:group-hover:opacity-100 can-hover:group-hover:bg-white/80 focus-visible:opacity-100'
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
                                data-testid="page-rename-input"
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
                            <div className="flex items-center gap-0.5 opacity-100 can-hover:opacity-0 can-hover:group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
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
                    const key = effectiveSheetId(ctxPage);
                    const revs = revisionModel.revisionsBySheet.get(key) || [];
                    if (revs.length < 2) return null;
                    return (
                      <>
                        <div className="my-1 border-t border-slate-100 dark:border-slate-700" />
                        <button
                          onClick={() => { setPageContextMenu(null); setShowRevisionsForPageId(ctxPage.id); }}
                          className="w-full text-left px-3 py-1.5 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2"
                        >
                          <History size={14} /> Revision history
                        </button>
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
  );
}
