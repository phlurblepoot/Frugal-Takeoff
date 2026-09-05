// src/pages/ProjectsPage.tsx
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Plus, Calendar, Building2, MapPin, Archive, ArchiveRestore,
  Trash2, Edit2, Check, X, FileText, Ruler, FolderOpen, Clock,
} from 'lucide-react';
import {
  ProjectSummary, getProjectsSummary, patchProject, deleteProject,
  getRecentProjects, ConflictError,
  getUserPreferences, saveUserPreferences, getCustomers,
} from '../utils/store';
import { useCollaboration } from '../context/CollaborationContext';
import { formatMoney } from '../utils/money';
import { useToast } from '../components/Toast';
import {
  Button, Card, EmptyState, Input, LostBadge, Modal, ProjectStatusPill,
  Select, Skeleton, StatusPill, normalizeProjectStatus,
} from '../components/ui';
import { useLiveQuery } from '../hooks/useLiveQuery';
import { useReveal } from '../hooks/useReveal';

export type TabId = 'bidding' | 'in_progress' | 'archive';

export interface PipelineGroup {
  id: TabId;
  label: string;
  projects: ProjectSummary[];
}

// Semantic phase mapping. The Dashboard derives its "upcoming bids" and "active
// projects" status sets from this so the two views can't drift.
export const GROUP_DEFS: { id: string; label: string; statuses: string[] }[] = [
  { id: 'bidding', label: 'Bidding', statuses: ['bidding'] },
  { id: 'active',  label: 'In progress', statuses: ['in_progress'] },
];

// The board is three tabs: the two live stages plus the archive. Archived is a
// flag rather than a stage, so it decides the tab regardless of status.
export const TABS: { id: TabId; label: string }[] = [
  { id: 'bidding',     label: 'Bidding' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'archive',     label: 'Archive' },
];

const TAB_EMPTY: Record<TabId, { title: string; description: string }> = {
  bidding:     { title: 'No open bids',       description: 'Projects you are bidding show up here until they start.' },
  in_progress: { title: 'Nothing in progress', description: 'Move a project to In Progress once the bid is won.' },
  archive:     { title: 'No archived projects', description: 'Archived and lost projects live here and can be restored anytime.' },
};

// Old bookmarks carry pre-collapse ?stage= values (and the previous board's
// group ids). Land them on the tab their projects actually moved to — migration
// 21 auto-archived everything that was complete or lost.
const LEGACY_STAGE_PARAMS: Record<string, TabId> = {
  estimating: 'bidding', proposal_sent: 'bidding',
  awarded: 'in_progress', punch_list: 'in_progress', active: 'in_progress',
  complete: 'archive', lost: 'archive', archived: 'archive', closed: 'archive',
};

// Unrecognised ?stage= values fall back to Bidding rather than a blank board.
export function resolveTab(param: string | null | undefined): TabId {
  if (!param) return 'bidding';
  if (TABS.some(t => t.id === param)) return param as TabId;
  if (Object.hasOwn(LEGACY_STAGE_PARAMS, param)) return LEGACY_STAGE_PARAMS[param];
  return 'bidding';
}

// Which tab a project belongs to. Unknown statuses fold into Bidding (via
// normalizeProjectStatus) so nothing vanishes from the board.
export function tabForProject(p: ProjectSummary): TabId {
  if (p.archived) return 'archive';
  return normalizeProjectStatus(p.status) === 'in_progress' ? 'in_progress' : 'bidding';
}

export type ProjectSort = 'updated' | 'created' | 'name' | 'bidDue';

// Bidding is deadline-driven; elsewhere recency is the useful order. Used only
// while the user hasn't picked a sort of their own.
export const DEFAULT_SORT_BY_TAB: Record<TabId, ProjectSort> = {
  bidding: 'bidDue', in_progress: 'updated', archive: 'updated',
};

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

// Buckets every summary into exactly one tab. A null `sort` means "use each
// tab's own default"; an explicit user choice applies across all three.
export function groupSummaries(
  summaries: ProjectSummary[],
  sort: ProjectSort | null = null
): PipelineGroup[] {
  return TABS.map(def => ({
    id: def.id,
    label: def.label,
    projects: sortProjects(
      summaries.filter(s => tabForProject(s) === def.id),
      sort ?? DEFAULT_SORT_BY_TAB[def.id]
    ),
  }));
}

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString();

const ProjectRow: React.FC<{
  p: ProjectSummary;
  tab: TabId;
  customerName?: string;
  onOpen: () => void;
  onRename: (name: string) => void;
  onArchiveToggle: () => void;
  onDelete: () => void;
}> = ({ p, tab, customerName, onOpen, onRename, onArchiveToggle, onDelete }) => {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.name);
  // A bid deadline only matters while the bid is still open.
  const showBidDue = tab === 'bidding' && p.bidDueDate !== null;
  const overdue = showBidDue && p.bidDueDate! < Date.now();
  // Outstanding balance is admin-gated server-side: absent, not zero, for
  // everyone else. A settled project shows nothing rather than "$0.00".
  const outstanding = tab === 'in_progress' ? p.outstandingCents : undefined;

  const commitRename = () => {
    setEditing(false);
    const trimmed = name.trim();
    if (trimmed && trimmed !== p.name) onRename(trimmed);
    else setName(p.name);
  };

  return (
    <div
      data-testid="project-row"
      data-project-id={p.id}
      onClick={() => !editing && onOpen()}
      className="flex cursor-pointer items-center gap-3 border-b border-edge px-3 py-3 transition-colors last:border-b-0 hover:bg-hover"
    >
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
            <Input
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') { setEditing(false); setName(p.name); }
              }}
              autoFocus
              className="h-8 max-w-sm py-1 text-sm"
            />
            <Button variant="ghost" size="sm" onClick={commitRename} aria-label="Save name"><Check size={14} /></Button>
            <Button variant="ghost" size="sm" onClick={() => { setEditing(false); setName(p.name); }} aria-label="Cancel rename"><X size={14} /></Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-ink" title={p.name}>{p.name}</h3>
            {/* On the archive tab the row's own stage is no longer implied by
                the tab, so spell it out alongside the lost-bid marker. */}
            {tab === 'archive' && p.lostBid && <LostBadge className="shrink-0" />}
            {tab === 'archive' && !p.lostBid && <ProjectStatusPill status={p.status} className="shrink-0" />}
          </div>
        )}

        <div className="mt-0.5 flex items-center gap-x-3 text-xs text-ink-soft">
          {(customerName || p.contractor) && (
            <span className="flex min-w-0 items-center gap-1">
              <Building2 size={12} className="shrink-0 text-ink-faint" />
              <span className="truncate">{customerName || p.contractor}</span>
            </span>
          )}
          {p.address && (
            <span className="hidden min-w-0 items-center gap-1 sm:flex">
              <MapPin size={12} className="shrink-0 text-ink-faint" />
              <span className="truncate">{p.address}</span>
            </span>
          )}
          <span className="hidden shrink-0 items-center gap-1 text-ink-faint sm:flex">
            <Clock size={12} />Updated {fmtDate(p.updatedAt ?? p.createdAt)}
          </span>
        </div>
      </div>

      {/* Whatever the current tab is actually about. */}
      {showBidDue && (
        <StatusPill tone={overdue ? 'red' : 'slate'} className="shrink-0">
          <Calendar size={11} />Due {fmtDate(p.bidDueDate!)}
        </StatusPill>
      )}
      {outstanding !== undefined && outstanding > 0 && (
        <span className="shrink-0 text-sm font-semibold text-ink" title="Outstanding balance">
          {formatMoney(outstanding)}
        </span>
      )}

      <div className="hidden shrink-0 items-center gap-3 text-xs text-ink-faint md:flex">
        <span className="flex items-center gap-1"><FileText size={12} />{p.pageCount}</span>
        <span className="flex items-center gap-1"><Ruler size={12} />{p.takeoffCount}</span>
      </div>

      <div className="flex shrink-0 items-center gap-0.5" onClick={e => e.stopPropagation()}>
        <button onClick={() => setEditing(true)} title="Rename" className="flex min-h-10 min-w-10 items-center justify-center rounded-md p-1.5 text-ink-faint transition-colors hover:bg-hover hover:text-ink active:bg-hover md:min-h-0 md:min-w-0"><Edit2 size={13} /></button>
        <button onClick={onArchiveToggle} title={p.archived ? 'Restore' : 'Archive'} className="flex min-h-10 min-w-10 items-center justify-center rounded-md p-1.5 text-ink-faint transition-colors hover:bg-hover hover:text-ink active:bg-hover md:min-h-0 md:min-w-0">
          {p.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
        </button>
        <button onClick={onDelete} title="Delete" className="flex min-h-10 min-w-10 items-center justify-center rounded-md p-1.5 text-ink-faint transition-colors hover:bg-red-50 hover:text-red-600 active:bg-red-100 dark:hover:bg-red-900/20 dark:hover:text-red-400 dark:active:bg-red-900/30 md:min-h-0 md:min-w-0"><Trash2 size={13} /></button>
      </div>
    </div>
  );
};

// Reveals a row-group Card on scroll (Wave 3 Task 11). A plain component
// instance (not a hook call inline in renderRows) so each mount — including
// a fresh one when the active-tab section remounts via its `key` — gets its
// own IntersectionObserver lifecycle. Card is a plain FC (no ref
// forwarding), so the ref lives on a thin wrapper div instead.
const RevealCard: React.FC<React.PropsWithChildren<{ className?: string }>> = ({ children, className }) => {
  const ref = useReveal<HTMLDivElement>();
  return (
    <div ref={ref}>
      <Card className={className}>{children}</Card>
    </div>
  );
};

export const ProjectsPage: React.FC = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { sessions, mySessionId } = useCollaboration();
  const [searchParams, setSearchParams] = useSearchParams();
  const setStage = (id: TabId) => {
    const next = new URLSearchParams(searchParams);
    next.set('stage', id);
    setSearchParams(next, { replace: true });
  };

  const [summaries, setSummaries] = useState<ProjectSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [customerFilter, setCustomerFilter] = useState('all');
  const [customerMap, setCustomerMap] = useState<Map<string, string>>(new Map());
  // null = no explicit choice, so each tab uses its own default order.
  const [sort, setSort] = useState<ProjectSort | null>(() => {
    const saved = localStorage.getItem('projectsSort');
    return SORT_OPTIONS.some(o => o.id === saved) ? (saved as ProjectSort) : null;
  });
  const changeSort = (s: ProjectSort | 'auto') => {
    setSort(s === 'auto' ? null : s);
    localStorage.setItem('projectsSort', s);
    // Cross-device: persist to the account, fire-and-forget.
    saveUserPreferences({ projectsSort: s }).catch(() => {});
  };
  const [deleteTarget, setDeleteTarget] = useState<ProjectSummary | null>(null);
  const [deleteText, setDeleteText] = useState('');

  const load = async () => {
    try {
      const [sums, custs] = await Promise.all([
        getProjectsSummary(),
        getCustomers().catch(() => [] as { id: string; name: string }[]),
      ]);
      setSummaries(sums);
      setCustomerMap(new Map(custs.map((c: { id: string; name: string }): [string, string] => [c.id, c.name])));
    } catch {
      toast('Failed to load projects', { type: 'error' });
    } finally {
      setIsLoading(false);
    }
  };
  useLiveQuery(load, { types: ['project', 'customer', 'invoice', 'aiaPayApp', 'payment'] });

  // Server is the source of truth for the sort preference (cross-device); the
  // localStorage init above is just the instant default. Ignore missing/invalid.
  useEffect(() => {
    getUserPreferences().then(prefs => {
      const saved = prefs['projectsSort'];
      if (saved === 'auto') setSort(null);
      else if (saved && SORT_OPTIONS.some(o => o.id === saved)) setSort(saved as ProjectSort);
    }).catch(() => { /* offline / not present — keep localStorage default */ });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Customers that have at least one project in the loaded summaries (for filter dropdown).
  const filterableCustomers = useMemo(() => {
    const seen = new Set(summaries.map(s => s.customerId).filter(Boolean) as string[]);
    return Array.from(seen)
      .map(id => ({ id, name: customerMap.get(id) ?? id }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [summaries, customerMap]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return summaries.filter(s => {
      if (customerFilter !== 'all' && s.customerId !== customerFilter) return false;
      if (!q) return true;
      const customerName = s.customerId ? (customerMap.get(s.customerId) ?? s.contractor ?? '') : (s.contractor ?? '');
      return [s.name, customerName, s.address].some(v => v && v.toLowerCase().includes(q));
    });
  }, [summaries, search, customerFilter, customerMap]);

  const groups = useMemo(() => groupSummaries(filtered, sort), [filtered, sort]);

  // Recently opened (from localStorage, newest first). Resolved against the
  // loaded summaries so deleted/archived projects drop out; shown only on the
  // unfiltered live tabs as a quick-access row.
  const recents = useMemo(() => {
    const byId = new Map(summaries.map(s => [s.id, s] as const));
    return getRecentProjects()
      .map(r => byId.get(r.id))
      .filter((s): s is ProjectSummary => !!s && !s.archived)
      .slice(0, 6);
  }, [summaries]);

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

  const handleDeleteClick = (p: ProjectSummary) => {
    const hasViewer = sessions.some(s => s.sessionId !== mySessionId && s.location?.projectId === p.id);
    if (hasViewer) {
      toast('Someone is currently working in this project — it cannot be deleted right now.', { type: 'warning' });
      return;
    }
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

  // `tab` fixes which signal each row shows; the Recently-opened row spans
  // tabs, so its rows are typed by the project itself.
  const renderRows = (projects: ProjectSummary[], tab?: TabId) => (
    <RevealCard className="overflow-hidden">
      {projects.map(p => (
        <ProjectRow
          key={p.id}
          p={p}
          tab={tab ?? tabForProject(p)}
          customerName={p.customerId ? customerMap.get(p.customerId) : undefined}
          onOpen={() => navigate(`/project/${p.id}`)}
          onRename={name => applyPatch(p, { name })}
          // Restoring undoes the lost-bid marker too, so a project that comes
          // back and is later archived for another reason isn't still "Lost".
          onArchiveToggle={() => applyPatch(p, p.archived ? { archived: false, lostBid: false } : { archived: true })}
          onDelete={() => handleDeleteClick(p)}
        />
      ))}
    </RevealCard>
  );

  // The active tab lives in the URL (?stage=), so a deep link survives a
  // reload. Unlike the old board it never moves on its own — an empty tab
  // stays selected and says so.
  const activeTab = resolveTab(searchParams.get('stage'));
  const activeGroup = groups.find(g => g.id === activeTab)!;
  const filtering = search.trim() !== '' || customerFilter !== 'all';
  const showRecents = activeTab !== 'archive' && !filtering && recents.length > 0;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-ink">Projects</h1>
        <Button onClick={() => navigate('/new')}><Plus size={16} />New Project</Button>
      </div>

      {/* Controls */}
          <div className="mb-5 flex flex-wrap items-center gap-2">
            <Input
              placeholder="Search projects…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="h-9 max-w-xs"
            />
            <Select value={customerFilter} onChange={e => setCustomerFilter(e.target.value)} className="h-9 w-auto">
              <option value="all">All customers</option>
              {filterableCustomers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
            <Select
              value={sort ?? 'auto'}
              onChange={e => changeSort(e.target.value as ProjectSort | 'auto')}
              className="h-9 w-auto"
              aria-label="Sort projects"
            >
              <option value="auto">Sort: Best for tab</option>
              {SORT_OPTIONS.map(o => <option key={o.id} value={o.id}>Sort: {o.label}</option>)}
            </Select>
          </div>

          {isLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-8 w-64" />
              <Skeleton className="h-64 rounded-xl" />
            </div>
          ) : summaries.length === 0 ? (
            <EmptyState
              icon={<FolderOpen size={22} />}
              title="No projects yet"
              description="Create your first project to start bidding."
              action={<Button onClick={() => navigate('/new')}><Plus size={16} />New Project</Button>}
            />
          ) : (
            <div className="space-y-5">
              {showRecents && (
                <section>
                  <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                    <Clock size={12} />Recently opened
                  </h2>
                  {renderRows(recents)}
                </section>
              )}

              {/* Lifecycle tabs — the two live stages plus the archive */}
              <div className="-mx-4 flex items-center gap-1 overflow-x-auto border-b border-edge px-4 no-scrollbar md:mx-0 md:px-0">
                {groups.map(g => (
                  <button
                    key={g.id}
                    data-testid={`stage-tab-${g.id}`}
                    onClick={() => setStage(g.id)}
                    className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                      activeTab === g.id ? 'border-accent-500 text-ink' : 'border-transparent text-ink-soft hover:text-ink'
                    }`}
                  >
                    {g.label}
                    {/* The archive is a bucket, not a workload — a count there
                        would only ever grow, so it isn't worth the ink. */}
                    {g.id !== 'archive' && (
                      <span className="rounded-full bg-sunken px-1.5 py-0.5 text-[11px] font-semibold text-ink-faint">{g.projects.length}</span>
                    )}
                  </button>
                ))}
              </div>

              {activeGroup.projects.length === 0 ? (
                <EmptyState
                  icon={activeTab === 'archive' ? <Archive size={22} /> : <FolderOpen size={22} />}
                  title={filtering ? 'No matching projects' : TAB_EMPTY[activeTab].title}
                  description={filtering ? 'Try a different search or customer filter.' : TAB_EMPTY[activeTab].description}
                />
              ) : (
                <div key={activeTab} className="anim-tab-in">
                  {renderRows(activeGroup.projects, activeTab)}
                </div>
              )}
            </div>
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
