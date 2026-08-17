// src/pages/documents/DocumentsPage.tsx
// Global Documents page (spec docs/superpowers/specs/2026-08-17-unified-documents-design.md
// §Client). URL params `?projectIds=&customerIds=&kinds=&q=&archived=` (comma
// lists) drive every filter so the page is deep-linkable both ways: this page
// writes them on every filter change, and any other page (e.g. the retired
// per-project Documents nav entry) can land here pre-filtered by composing
// the same query string — see ProjectDocumentsRedirect below.
import React, { useEffect, useMemo, useState } from 'react';
import { Navigate, useParams, useSearchParams } from 'react-router-dom';
import { FolderOpen, Upload } from 'lucide-react';
import { DocumentRow, getCustomers, getDocuments, getProjectsSummary, getSettings } from '../../utils/store';
import { useToast } from '../../components/Toast';
import { Button, EmptyState, Skeleton } from '../../components/ui';
import { DocumentsFilterBar } from './DocumentsFilterBar';
import { DocumentsTable } from './DocumentsTable';
import { MultiSelectOption } from './MultiSelectDropdown';
import { CustomDocType, KIND_OPTIONS } from './docTypes';

const PAGE_SIZE = 100;

const csvParam = (sp: URLSearchParams, key: string): string[] => {
  const v = sp.get(key);
  return v ? v.split(',').map(s => s.trim()).filter(Boolean) : [];
};

type FilterPatch = Partial<{
  projectIds: string[];
  customerIds: string[];
  kinds: string[];
  q: string;
  archived: boolean;
}>;

export const DocumentsPage: React.FC = () => {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const projectIds = useMemo(() => csvParam(searchParams, 'projectIds'), [searchParams]);
  const customerIds = useMemo(() => csvParam(searchParams, 'customerIds'), [searchParams]);
  const kinds = useMemo(() => csvParam(searchParams, 'kinds'), [searchParams]);
  const q = searchParams.get('q') ?? '';
  const archived = searchParams.get('archived') === '1';

  const setFilter = (patch: FilterPatch) => {
    setSearchParams(prev => {
      const p = new URLSearchParams(prev);
      if ('projectIds' in patch) { patch.projectIds!.length ? p.set('projectIds', patch.projectIds!.join(',')) : p.delete('projectIds'); }
      if ('customerIds' in patch) { patch.customerIds!.length ? p.set('customerIds', patch.customerIds!.join(',')) : p.delete('customerIds'); }
      if ('kinds' in patch) { patch.kinds!.length ? p.set('kinds', patch.kinds!.join(',')) : p.delete('kinds'); }
      if ('q' in patch) { patch.q ? p.set('q', patch.q) : p.delete('q'); }
      if ('archived' in patch) { patch.archived ? p.set('archived', '1') : p.delete('archived'); }
      return p;
    }, { replace: true });
  };

  const [rows, setRows] = useState<DocumentRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const [projectOptions, setProjectOptions] = useState<MultiSelectOption[]>([]);
  const [customerOptions, setCustomerOptions] = useState<MultiSelectOption[]>([]);
  const [customTypes, setCustomTypes] = useState<CustomDocType[]>([]);

  // Filter option sources — loaded once. Every project/customer is offered
  // (not just those with a visible document) so a filter chosen ahead of
  // uploading still makes sense.
  useEffect(() => {
    getProjectsSummary()
      .then(ps => setProjectOptions([...ps].sort((a, b) => a.name.localeCompare(b.name)).map(p => ({ id: p.id, label: p.name }))))
      .catch(() => setProjectOptions([]));
    getCustomers()
      .then(cs => setCustomerOptions([...cs].sort((a, b) => a.name.localeCompare(b.name)).map(c => ({ id: c.id, label: c.name }))))
      .catch(() => setCustomerOptions([]));
    getSettings()
      .then(s => {
        try {
          const parsed = s.documentTypes ? JSON.parse(s.documentTypes) : [];
          setCustomTypes(Array.isArray(parsed) ? parsed : []);
        } catch { setCustomTypes([]); }
      })
      .catch(() => setCustomTypes([]));
  }, []);

  const kindOptions = useMemo<MultiSelectOption[]>(() => [
    ...KIND_OPTIONS,
    ...customTypes.map(t => ({ id: `custom:${t.id}`, label: t.label })),
  ], [customTypes]);

  // A single string key so the fetch effect only re-runs when the filters
  // actually change (arrays/objects would otherwise be new references on
  // every render).
  const filterKey = `${projectIds.join(',')}|${customerIds.join(',')}|${kinds.join(',')}|${q}|${archived}`;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getDocuments({ projectIds, customerIds, kinds, q: q || undefined, archived, limit: PAGE_SIZE, offset: 0 })
      .then(res => { if (!cancelled) { setRows(res.rows); setTotal(res.total); } })
      .catch(() => {
        if (!cancelled) {
          setRows([]);
          setTotal(0);
          toast('Failed to load documents', { type: 'error' });
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const res = await getDocuments({
        projectIds, customerIds, kinds, q: q || undefined, archived,
        limit: PAGE_SIZE, offset: rows.length,
      });
      setRows(prev => [...prev, ...res.rows]);
      setTotal(res.total);
    } catch {
      toast('Failed to load more documents', { type: 'error' });
    } finally {
      setLoadingMore(false);
    }
  };

  const filtering = projectIds.length > 0 || customerIds.length > 0 || kinds.length > 0 || q.trim() !== '' || archived;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <FolderOpen size={22} className="text-accent-600 dark:text-accent-400" />
          <h1 className="text-xl font-bold text-ink">Documents</h1>
        </div>
        {/* Upload (batch + labeling popup) lands in the next task; the slot
            stays visible so the page reads complete in the meantime. */}
        <Button data-testid="documents-upload" disabled title="Upload — coming in a future update">
          <Upload size={15} />Upload
        </Button>
      </div>

      <DocumentsFilterBar
        q={q}
        onQChange={v => setFilter({ q: v })}
        projectOptions={projectOptions}
        projectIds={projectIds}
        onProjectIdsChange={ids => setFilter({ projectIds: ids })}
        customerOptions={customerOptions}
        customerIds={customerIds}
        onCustomerIdsChange={ids => setFilter({ customerIds: ids })}
        kindOptions={kindOptions}
        kinds={kinds}
        onKindsChange={ids => setFilter({ kinds: ids })}
        archived={archived}
        onArchivedChange={v => setFilter({ archived: v })}
      />

      {loading ? (
        <div className="space-y-2">{[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-10" />)}</div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<FolderOpen size={22} />}
          title={filtering ? 'No matching documents' : 'No documents yet'}
          description={filtering
            ? 'Try widening your filters.'
            : 'Uploads, proposals, printouts, and generated PDFs will show up here as they land.'}
        />
      ) : (
        <>
          <DocumentsTable rows={rows} customTypes={customTypes} />
          <div className="mt-3 flex items-center justify-between gap-3 text-xs text-ink-faint">
            <span>Filtered: {rows.length} of {total}</span>
            {rows.length < total && (
              <Button variant="secondary" size="sm" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
};

// Route-level redirect: the per-project Documents nav entry keeps working,
// landing on the global page pre-filtered to that project (spec §Decisions).
export const ProjectDocumentsRedirect: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>();
  return <Navigate to={`/documents?projectIds=${encodeURIComponent(projectId ?? '')}`} replace />;
};
