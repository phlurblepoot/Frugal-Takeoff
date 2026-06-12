// src/pages/ProjectsPage.tsx
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Plus, Calendar, Building2, MapPin, Archive, ArchiveRestore,
  Trash2, Edit2, Check, X, FileText, Ruler, FolderOpen, Layout as LayoutIcon,
} from 'lucide-react';
import {
  ProjectSummary, getProjectsSummary, patchProject, deleteProject,
  getActivePages, ConflictError,
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

export const GROUP_DEFS: { id: string; label: string; statuses: string[] }[] = [
  { id: 'estimating', label: 'Estimating', statuses: ['estimating', 'proposal_sent'] },
  { id: 'active', label: 'Active', statuses: ['awarded', 'in_progress', 'punch_list'] },
  { id: 'closed', label: 'Complete & Closed', statuses: ['complete', 'lost'] },
];

const KNOWN_STATUSES = GROUP_DEFS.flatMap(g => g.statuses);

// Buckets non-archived summaries into the three pipeline groups (spec §4.1).
// Unknown statuses land in Estimating so nothing ever vanishes from the board.
export function groupSummaries(summaries: ProjectSummary[]): PipelineGroup[] {
  const visible = summaries.filter(s => !s.archived);
  return GROUP_DEFS.map(def => {
    const projects = visible.filter(s =>
      def.statuses.includes(s.status) ||
      (def.id === 'estimating' && !KNOWN_STATUSES.includes(s.status))
    );
    // Estimating: soonest bid due date first, undated last.
    // Other groups: most recently touched first.
    projects.sort((a, b) =>
      def.id === 'estimating'
        ? (a.bidDueDate ?? Infinity) - (b.bidDueDate ?? Infinity)
        : (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt)
    );
    return { id: def.id, label: def.label, projects };
  });
}

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString();

const ProjectCard: React.FC<{
  p: ProjectSummary;
  overdueHighlight: boolean;
  onOpen: () => void;
  onRename: (name: string) => void;
  onArchiveToggle: () => void;
  onDelete: () => void;
}> = ({ p, overdueHighlight, onOpen, onRename, onArchiveToggle, onDelete }) => {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.name);
  const overdue = overdueHighlight && p.bidDueDate !== null && p.bidDueDate < Date.now();

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
        {p.bidDueDate !== null && (
          <p className={`flex items-center gap-1.5 ${overdue ? 'font-medium text-red-600 dark:text-red-400' : ''}`}>
            <Calendar size={12} className="shrink-0 text-ink-faint" />
            Due {fmtDate(p.bidDueDate)}{overdue ? ' — overdue' : ''}
          </p>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-edge pt-2">
        <div className="flex items-center gap-3 text-xs text-ink-faint">
          <span className="flex items-center gap-1"><FileText size={12} />{p.pageCount}</span>
          <span className="flex items-center gap-1"><Ruler size={12} />{p.takeoffCount}</span>
        </div>
        <div className="flex items-center gap-0.5" onClick={e => e.stopPropagation()}>
          <button onClick={() => setEditing(true)} title="Rename" className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-hover hover:text-ink"><Edit2 size={13} /></button>
          <button onClick={onArchiveToggle} title={p.archived ? 'Restore' : 'Archive'} className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-hover hover:text-ink">
            {p.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
          </button>
          <button onClick={onDelete} title="Delete" className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20 dark:hover:text-red-400"><Trash2 size={13} /></button>
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

  const [summaries, setSummaries] = useState<ProjectSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [view, setView] = useState<'active' | 'archived'>('active');
  const [search, setSearch] = useState('');
  const [contractor, setContractor] = useState('all');
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

  const groups = useMemo(() => groupSummaries(filtered), [filtered]);
  const archivedProjects = useMemo(
    () => filtered.filter(s => s.archived).sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt)),
    [filtered]
  );

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

  const renderCards = (projects: ProjectSummary[], overdueHighlight: boolean) => (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {projects.map(p => (
        <ProjectCard
          key={p.id}
          p={p}
          overdueHighlight={overdueHighlight}
          onOpen={() => navigate(`/project/${p.id}`)}
          onRename={name => applyPatch(p, { name })}
          onArchiveToggle={() => applyPatch(p, { archived: !p.archived })}
          onDelete={() => handleDeleteClick(p)}
        />
      ))}
    </div>
  );

  const totalVisible = groups.reduce((n, g) => n + g.projects.length, 0);

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-8">
      <div className="mb-4 flex items-center justify-between gap-3">
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
              renderCards(archivedProjects, false)
            )
          ) : totalVisible === 0 ? (
            <EmptyState
              icon={<FolderOpen size={22} />}
              title="No projects yet"
              description="Create your first project to start estimating."
              action={<Button onClick={() => navigate('/new')}><Plus size={16} />New Project</Button>}
            />
          ) : (
            <div className="space-y-7">
              {groups.filter(g => g.projects.length > 0).map(g => (
                <section key={g.id}>
                  <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                    {g.label} · {g.projects.length}
                  </h2>
                  {renderCards(g.projects, g.id === 'estimating')}
                </section>
              ))}
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
