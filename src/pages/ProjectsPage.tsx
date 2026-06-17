// src/pages/ProjectsPage.tsx
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Plus, Calendar, Building2, MapPin, Archive, ArchiveRestore,
  Trash2, Edit2, Check, X, FileText, Ruler, FolderOpen, Layout as LayoutIcon, Clock,
} from 'lucide-react';
import {
  ProjectSummary, getProjectsSummary, patchProject, deleteProject,
  getActivePages, getRecentProjects, ConflictError,
  getUserPreferences, saveUserPreferences,
} from '../utils/store';
import { TemplatesView } from './TemplatesView';
import { useToast } from '../components/Toast';
import {
  Button, Card, EmptyState, Input, Modal, ProjectStatusPill, Select, Skeleton,
} from '../components/ui';

type Tab = 'projects' | 'templates';

export interface PipelineGroup {
  id: string;
  label: string;
  projects: ProjectSummary[];
}

// Semantic phase mapping (estimating / active / closed). The Dashboard derives
// its "upcoming bids" and "active projects" status sets from this so the two
// views can't drift. NOT used for the board layout — see STAGE_ORDER below.
export const GROUP_DEFS: { id: string; label: string; statuses: string[] }[] = [
  { id: 'estimating', label: 'Estimating', statuses: ['estimating', 'proposal_sent'] },
  { id: 'active', label: 'Active', statuses: ['awarded', 'in_progress', 'punch_list'] },
  { id: 'closed', label: 'Complete & Closed', statuses: ['complete', 'lost'] },
];

// The board groups by individual lifecycle stage — one section per status, in
// workflow order. Unknown statuses fold into Estimating so nothing vanishes.
export const STAGE_ORDER: { id: string; label: string }[] = [
  { id: 'estimating',    label: 'Estimating' },
  { id: 'proposal_sent', label: 'Proposal Sent' },
  { id: 'awarded',       label: 'Awarded' },
  { id: 'in_progress',   label: 'In Progress' },
  { id: 'punch_list',    label: 'Punch List' },
  { id: 'complete',      label: 'Complete' },
  { id: 'lost',          label: 'Lost' },
];
const STAGE_IDS = STAGE_ORDER.map(s => s.id);

export type ProjectSort = 'updated' | 'created' | 'name' | 'bidDue';

export const SORT_OPTIONS: { id: ProjectSort; label: string }[] = [
  { id: 'updated', label: 'Last updated' },
  { id: 'created', label: 'Date added' },
  { id: 'name',    label: 'Name (A–Z)' },
  { id: 'bidDue',  label: 'Bid due date' },
];

// Sorts a copy of the list by the chosen key. Bid-due puts undated projects
// last; the recency keys are newest-first.
export function sortProjects(list: ProjectSummary[], sort: ProjectSort): ProjectSummary[] {
  const arr = [...list];
  switch (sort) {
    case 'name':
      arr.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case 'created':
      arr.sort((a, b) => b.createdAt - a.createdAt);
      break;
    case 'bidDue':
      arr.sort((a, b) => (a.bidDueDate ?? Infinity) - (b.bidDueDate ?? Infinity));
      break;
    case 'updated':
    default:
      arr.sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));
      break;
  }
  return arr;
}

// Buckets non-archived summaries into one group per lifecycle stage, each sorted
// by the chosen key. Unknown statuses land in Estimating.
export function groupSummaries(summaries: ProjectSummary[], sort: ProjectSort = 'updated'): PipelineGroup[] {
  const visible = summaries.filter(s => !s.archived);
  return STAGE_ORDER.map(def => {
    const projects = sortProjects(
      visible.filter(s =>
        s.status === def.id || (def.id === 'estimating' && !STAGE_IDS.includes(s.status))
      ),
      sort
    );
    return { id: def.id, label: def.label, projects };
  });
}

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString();

const ProjectCard: React.FC<{
  p: ProjectSummary;
  onOpen: () => void;
  onRename: (name: string) => void;
  onArchiveToggle: () => void;
  onDelete: () => void;
}> = ({ p, onOpen, onRename, onArchiveToggle, onDelete }) => {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.name);
  // The bid due date only matters while a project is still being estimated.
  const showBidDue = p.status === 'estimating' && !p.archived && p.bidDueDate !== null;
  const overdue = showBidDue && p.bidDueDate! < Date.now();

  const commitRename = () => {
    setEditing(false);
    const trimmed = name.trim();
    if (trimmed && trimmed !== p.name) onRename(trimmed);
    else setName(p.name);
  };

  return (
    <Card
      className="cursor-pointer p-4 transition-colors hover:border-edge-strong"
      onClick={() => !editing && onOpen()}
    >
      <div className="flex items-start justify-between gap-2">
        {editing ? (
          <div className="flex flex-1 items-center gap-1" onClick={e => e.stopPropagation()}>
            <Input
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') { setEditing(false); setName(p.name); }
              }}
              autoFocus
              className="h-8 py-1 text-sm"
            />
            <Button variant="ghost" size="sm" onClick={commitRename} aria-label="Save name"><Check size={14} /></Button>
            <Button variant="ghost" size="sm" onClick={() => { setEditing(false); setName(p.name); }} aria-label="Cancel rename"><X size={14} /></Button>
          </div>
        ) : (
          <h3 className="flex-1 truncate text-sm font-semibold text-ink" title={p.name}>{p.name}</h3>
        )}
        <ProjectStatusPill status={p.archived ? 'archived' : p.status} />
      </div>

      <div className="mt-2 space-y-1 text-xs text-ink-soft">
        {p.contractor && (
          <p className="flex items-center gap-1.5 truncate"><Building2 size={12} className="shrink-0 text-ink-faint" />{p.contractor}</p>
        )}
        {p.address && (
          <p className="flex items-center gap-1.5 truncate"><MapPin size={12} className="shrink-0 text-ink-faint" />{p.address}</p>
        )}
        {showBidDue && (
          <p className={`flex items-center gap-1.5 ${overdue ? 'font-medium text-red-600 dark:text-red-400' : ''}`}>
            <Calendar size={12} className="shrink-0 text-ink-faint" />
            Due {fmtDate(p.bidDueDate!)}{overdue ? ' — overdue' : ''}
          </p>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-edge pt-2">
        <div className="flex items-center gap-3 text-xs text-ink-faint">
          <span className="flex items-center gap-1"><FileText size={12} />{p.pageCount}</span>
          <span className="flex items-center gap-1"><Ruler size={12} />{p.takeoffCount}</span>
        </div>
        <div className="flex items-center gap-0.5" onClick={e => e.stopPropagation()}>
          <button onClick={() => setEditing(true)} title="Rename" className="flex min-h-10 min-w-10 items-center justify-center rounded-md p-1.5 text-ink-faint transition-colors hover:bg-hover hover:text-ink active:bg-hover md:min-h-0 md:min-w-0"><Edit2 size={13} /></button>
          <button onClick={onArchiveToggle} title={p.archived ? 'Restore' : 'Archive'} className="flex min-h-10 min-w-10 items-center justify-center rounded-md p-1.5 text-ink-faint transition-colors hover:bg-hover hover:text-ink active:bg-hover md:min-h-0 md:min-w-0">
            {p.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
          </button>
          <button onClick={onDelete} title="Delete" className="flex min-h-10 min-w-10 items-center justify-center rounded-md p-1.5 text-ink-faint transition-colors hover:bg-red-50 hover:text-red-600 active:bg-red-100 dark:hover:bg-red-900/20 dark:hover:text-red-400 dark:active:bg-red-900/30 md:min-h-0 md:min-w-0"><Trash2 size={13} /></button>
        </div>
      </div>
    </Card>
  );
};

export const ProjectsPage: React.FC = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: Tab = searchParams.get('tab') === 'templates' ? 'templates' : 'projects';
  const setTab = (t: Tab) => {
    const next = new URLSearchParams(searchParams);
    if (t === 'projects') next.delete('tab'); else next.set('tab', t);
    setSearchParams(next, { replace: true });
  };
  const setStage = (id: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('stage', id);
    setSearchParams(next, { replace: true });
  };

  const [summaries, setSummaries] = useState<ProjectSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [view, setView] = useState<'active' | 'archived'>('active');
  const [search, setSearch] = useState('');
  const [contractor, setContractor] = useState('all');
  const [sort, setSort] = useState<ProjectSort>(() => {
    const saved = localStorage.getItem('projectsSort');
    return SORT_OPTIONS.some(o => o.id === saved) ? (saved as ProjectSort) : 'updated';
  });
  const changeSort = (s: ProjectSort) => {
    setSort(s);
    localStorage.setItem('projectsSort', s);
    // Cross-device: persist to the account, fire-and-forget.
    saveUserPreferences({ projectsSort: s }).catch(() => {});
  };
  const [deleteTarget, setDeleteTarget] = useState<ProjectSummary | null>(null);
  const [deleteText, setDeleteText] = useState('');

  const load = async () => {
    try {
      setSummaries(await getProjectsSummary());
    } catch {
      toast('Failed to load projects', { type: 'error' });
    } finally {
      setIsLoading(false);
    }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Server is the source of truth for the sort preference (cross-device); the
  // localStorage init above is just the instant default. Ignore missing/invalid.
  useEffect(() => {
    getUserPreferences().then(prefs => {
      const saved = prefs['projectsSort'];
      if (saved && SORT_OPTIONS.some(o => o.id === saved)) {
        setSort(saved as ProjectSort);
      }
    }).catch(() => { /* offline / not present — keep localStorage default */ });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const contractors = useMemo(
    () => Array.from(new Set(summaries.map(s => s.contractor).filter(Boolean))).sort() as string[],
    [summaries]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return summaries.filter(s => {
      if (contractor !== 'all' && s.contractor !== contractor) return false;
      if (!q) return true;
      return [s.name, s.contractor, s.address].some(v => v && v.toLowerCase().includes(q));
    });
  }, [summaries, search, contractor]);

  const groups = useMemo(() => groupSummaries(filtered, sort), [filtered, sort]);
  const archivedProjects = useMemo(
    () => sortProjects(filtered.filter(s => s.archived), sort),
    [filtered, sort]
  );

  // Recently opened (from localStorage, newest first). Resolved against the
  // loaded summaries so deleted/archived projects drop out; shown only on the
  // unfiltered active board as a quick-access row.
  const recents = useMemo(() => {
    const byId = new Map(summaries.map(s => [s.id, s] as const));
    return getRecentProjects()
      .map(r => byId.get(r.id))
      .filter((s): s is ProjectSummary => !!s && !s.archived)
      .slice(0, 6);
  }, [summaries]);
  const showRecents = view === 'active' && !search.trim() && contractor === 'all' && recents.length > 0;

  // Applies a granular patch and reconciles the local row. A 409 means our
  // summary is stale — refetch rather than reloading the page.
  const applyPatch = async (p: ProjectSummary, patch: Partial<ProjectSummary> & Record<string, unknown>) => {
    try {
      const r = await patchProject(p.id, { version: p.version, ...patch } as any);
      // updatedAt mirrors the server's bump so recency sorting stays correct
      // without a refetch.
      setSummaries(prev => prev.map(s => (s.id === p.id ? { ...s, ...patch, version: r.version, updatedAt: Date.now() } : s)));
    } catch (e) {
      if (e instanceof ConflictError) {
        toast('Project changed elsewhere — refreshing', { type: 'warning' });
        load();
      } else {
        toast('Update failed', { type: 'error' });
      }
    }
  };

  const handleDeleteClick = async (p: ProjectSummary) => {
    try {
      const active = await getActivePages();
      if (p.pageIds.some(id => active.includes(id))) {
        toast('This project has pages currently being viewed by other users and cannot be deleted.', { type: 'warning' });
        return;
      }
    } catch { /* active-pages check is best-effort */ }
    setDeleteText('');
    setDeleteTarget(p);
  };

  const confirmDelete = async () => {
    if (!deleteTarget || deleteText.toLowerCase() !== 'delete') return;
    const removed = deleteTarget;
    setDeleteTarget(null);
    setSummaries(prev => prev.filter(s => s.id !== removed.id)); // optimistic
    try {
      await deleteProject(removed.id);
      toast('Project deleted', { type: 'success' });
    } catch {
      setSummaries(prev => [removed, ...prev]);
      toast('Failed to delete project', { type: 'error' });
    }
  };

  const renderCards = (projects: ProjectSummary[]) => (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {projects.map(p => (
        <ProjectCard
          key={p.id}
          p={p}
          onOpen={() => navigate(`/project/${p.id}`)}
          onRename={name => applyPatch(p, { name })}
          onArchiveToggle={() => applyPatch(p, { archived: !p.archived })}
          onDelete={() => handleDeleteClick(p)}
        />
      ))}
    </div>
  );

  const totalVisible = groups.reduce((n, g) => n + g.projects.length, 0);

  // Stage tabs: one per non-empty stage. The active stage is tracked in the URL
  // (?stage=); fall back to the first non-empty stage when absent or emptied
  // (e.g. by a search), so the board never lands on a blank tab.
  const stageGroups = groups.filter(g => g.projects.length > 0);
  const stageParam = searchParams.get('stage');
  const activeStage = stageGroups.some(g => g.id === stageParam) ? stageParam! : (stageGroups[0]?.id ?? '');
  const activeGroup = stageGroups.find(g => g.id === activeStage);

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-ink">Projects</h1>
        <Button onClick={() => navigate('/new')}><Plus size={16} />New Project</Button>
      </div>

      {/* Tabs: Projects | Templates */}
      <div className="mb-4 flex items-center gap-1 border-b border-edge">
        {(['projects', 'templates'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              tab === t ? 'border-accent-500 text-ink' : 'border-transparent text-ink-soft hover:text-ink'
            }`}
          >
            {t === 'projects' ? <FolderOpen size={15} /> : <LayoutIcon size={15} />}
            {t === 'projects' ? 'Projects' : 'Templates'}
          </button>
        ))}
      </div>

      {tab === 'templates' ? (
        <TemplatesView />
      ) : (
        <>
          {/* Controls */}
          <div className="mb-5 flex flex-wrap items-center gap-2">
            <Input
              placeholder="Search projects…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="h-9 max-w-xs"
            />
            <Select value={contractor} onChange={e => setContractor(e.target.value)} className="h-9 w-auto">
              <option value="all">All contractors</option>
              {contractors.map(c => <option key={c} value={c}>{c}</option>)}
            </Select>
            <Select
              value={sort}
              onChange={e => changeSort(e.target.value as ProjectSort)}
              className="h-9 w-auto"
              aria-label="Sort projects"
            >
              {SORT_OPTIONS.map(o => <option key={o.id} value={o.id}>Sort: {o.label}</option>)}
            </Select>
            <div className="ml-auto flex rounded-lg border border-edge p-0.5">
              {(['active', 'archived'] as const).map(v => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                    view === v ? 'bg-sunken text-ink' : 'text-ink-soft hover:text-ink'
                  }`}
                >
                  {v === 'active' ? 'Active' : 'Archived'}
                </button>
              ))}
            </div>
          </div>

          {isLoading ? (
            <div className="space-y-6">
              <Skeleton className="h-5 w-32" />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-36 rounded-xl" />)}
              </div>
            </div>
          ) : view === 'archived' ? (
            archivedProjects.length === 0 ? (
              <EmptyState icon={<Archive size={22} />} title="No archived projects" description="Archived projects appear here and can be restored anytime." />
            ) : (
              renderCards(archivedProjects)
            )
          ) : totalVisible === 0 ? (
            <EmptyState
              icon={<FolderOpen size={22} />}
              title="No projects yet"
              description="Create your first project to start estimating."
              action={<Button onClick={() => navigate('/new')}><Plus size={16} />New Project</Button>}
            />
          ) : (
            <div className="space-y-5">
              {showRecents && (
                <section>
                  <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                    <Clock size={12} />Recently opened
                  </h2>
                  {renderCards(recents)}
                </section>
              )}

              {/* Stage tabs — one per non-empty lifecycle stage */}
              <div className="-mx-4 flex items-center gap-1 overflow-x-auto border-b border-edge px-4 no-scrollbar md:mx-0 md:px-0">
                {stageGroups.map(g => (
                  <button
                    key={g.id}
                    onClick={() => setStage(g.id)}
                    className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                      activeStage === g.id ? 'border-accent-500 text-ink' : 'border-transparent text-ink-soft hover:text-ink'
                    }`}
                  >
                    {g.label}
                    <span className="rounded-full bg-sunken px-1.5 py-0.5 text-[11px] font-semibold text-ink-faint">{g.projects.length}</span>
                  </button>
                ))}
              </div>

              {activeGroup && renderCards(activeGroup.projects)}
            </div>
          )}
        </>
      )}

      {/* Delete confirmation */}
      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={`Delete "${deleteTarget?.name}"?`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="danger" disabled={deleteText.toLowerCase() !== 'delete'} onClick={confirmDelete}>
              Delete project
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm text-ink-soft">
          This permanently deletes the project, its pages, measurements, and files. Type <strong>delete</strong> to confirm.
        </p>
        <Input value={deleteText} onChange={e => setDeleteText(e.target.value)} placeholder="delete" autoFocus />
      </Modal>
    </div>
  );
};
