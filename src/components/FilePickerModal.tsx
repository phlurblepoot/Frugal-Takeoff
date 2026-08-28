// src/components/FilePickerModal.tsx — pick files already on the server.
// Reuses the Documents page's filter bar + row presentation
// (spec docs/superpowers/specs/2026-08-28-proposal-rework-design.md §5).
import React, { useEffect, useMemo, useState } from 'react';
import { Customer } from '../types';
import { DocumentRow, ProjectSummary, getCustomers, getDocumentTypes, getDocuments, getProjectsSummary } from '../utils/store';
import { Button, Modal, Skeleton, StatusPill } from './ui';
import { DocumentsFilterBar } from '../pages/documents/DocumentsFilterBar';
import { DocumentHoverPreview } from '../pages/documents/DocumentHoverPreview';
import { MimeIcon } from '../pages/documents/MimeIcon';
import { CustomDocType, KIND_OPTIONS, kindLabel, kindTone } from '../pages/documents/docTypes';
import { MultiSelectOption } from '../pages/documents/MultiSelectDropdown';

const PAGE_SIZE = 100;
const MIMES: Record<NonNullable<FilePickerModalProps['accept']>, string[] | undefined> = { pdf: ['application/pdf'], image: ['image/'], any: undefined };
const fmtSize = (n: number) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

export interface FilePickerModalProps {
  open: boolean;
  onClose: () => void;
  onPick: (rows: DocumentRow[]) => void | Promise<void>;
  accept?: 'pdf' | 'image' | 'any';
  multi?: boolean;
  excludeFileIds?: string[];
  initialProjectIds?: string[];
  title?: string;
}

export const FilePickerModal: React.FC<FilePickerModalProps> = ({
  open, onClose, onPick, accept = 'any', multi = true, excludeFileIds = [], initialProjectIds = [], title = 'Choose files',
}) => {
  const [q, setQ] = useState('');
  const [projectIds, setProjectIds] = useState<string[]>(initialProjectIds);
  const [customerIds, setCustomerIds] = useState<string[]>([]);
  const [kinds, setKinds] = useState<string[]>([]);
  const [archived, setArchived] = useState(false);
  const [rows, setRows] = useState<DocumentRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Map<string, DocumentRow>>(new Map());
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customTypes, setCustomTypes] = useState<CustomDocType[]>([]);
  const [hover, setHover] = useState<{ row: DocumentRow; x: number; y: number } | null>(null);
  const [hoverCapable] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia('(hover: hover)').matches);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelected(new Map());
    setProjectIds(initialProjectIds);
    getProjectsSummary().then(setProjects).catch(() => setProjects([]));
    getCustomers().then(setCustomers).catch(() => setCustomers([]));
    getDocumentTypes().then(setCustomTypes).catch(() => setCustomTypes([]));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const filterKey = `${open}|${q}|${projectIds.join(',')}|${customerIds.join(',')}|${kinds.join(',')}|${archived}|${accept}`;
  const fetchPage = async (offset: number) => {
    setLoading(true);
    try {
      const res = await getDocuments({ q: q || undefined, projectIds, customerIds, kinds, archived, mimes: MIMES[accept], limit: PAGE_SIZE, offset });
      setRows(prev => offset === 0 ? res.rows : [...prev, ...res.rows]);
      setTotal(res.total);
    } catch { if (offset === 0) { setRows([]); setTotal(0); } }
    finally { setLoading(false); }
  };
  useEffect(() => { if (open) fetchPage(0); }, [filterKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const excluded = useMemo(() => new Set(excludeFileIds), [excludeFileIds]);
  const visible = rows.filter(r => !excluded.has(r.id));
  const projectOptions: MultiSelectOption[] = projects.map(p => ({ id: p.id, label: p.name }));
  const customerOptions: MultiSelectOption[] = customers.map(c => ({ id: c.id, label: c.name }));
  const kindOptions: MultiSelectOption[] = [...KIND_OPTIONS, ...customTypes.map(t => ({ id: `custom:${t.id}`, label: t.label }))];

  const toggle = (row: DocumentRow) => setSelected(prev => {
    const next = multi ? new Map(prev) : new Map<string, DocumentRow>();
    if (prev.has(row.id) && multi) next.delete(row.id); else next.set(row.id, row);
    return next;
  });

  const confirm = async () => {
    setPicking(true);
    try { await onPick([...selected.values()]); onClose(); } finally { setPicking(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title={title} width="xl"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={confirm} disabled={selected.size === 0 || picking}>Add {selected.size} file{selected.size === 1 ? '' : 's'}</Button>
      </>}>
      <DocumentsFilterBar
        q={q} onQChange={setQ}
        projectOptions={projectOptions} projectIds={projectIds} onProjectIdsChange={setProjectIds}
        customerOptions={customerOptions} customerIds={customerIds} onCustomerIdsChange={setCustomerIds}
        kindOptions={kindOptions} kinds={kinds} onKindsChange={setKinds}
        archived={archived} onArchivedChange={setArchived}
        isAdmin={false} unassigned={false} onUnassignedChange={() => {}}
      />
      <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-edge">
        {loading && rows.length === 0 ? (
          <div className="space-y-2 p-3">{[0, 1, 2].map(i => <Skeleton key={i} className="h-8" />)}</div>
        ) : visible.length === 0 ? (
          <p className="p-4 text-sm text-ink-faint">No files match.</p>
        ) : (
          <ul className="divide-y divide-edge">
            {visible.map(row => (
              <li key={row.id} className="flex items-center gap-3 px-3 py-2 hover:bg-surface-2"
                  onMouseEnter={hoverCapable ? (e) => setHover({ row, x: e.clientX, y: e.clientY }) : undefined}
                  onMouseLeave={hoverCapable ? () => setHover(null) : undefined}>
                <input type="checkbox" aria-label={row.name ?? row.id} checked={selected.has(row.id)} onChange={() => toggle(row)} className="h-4 w-4 accent-accent-600" />
                <MimeIcon mime={row.mime} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">{row.name ?? row.id}</p>
                  <p className="truncate text-xs text-ink-faint">{row.projectName ?? row.customerName ?? '—'} · {new Date(row.createdAt).toLocaleDateString()} · {fmtSize(row.size)}</p>
                </div>
                <StatusPill tone={kindTone(row.kind)}>{kindLabel(row.kind, customTypes)}</StatusPill>
              </li>
            ))}
          </ul>
        )}
        {rows.length < total && (
          <div className="p-2 text-center"><Button variant="ghost" onClick={() => fetchPage(rows.length)} disabled={loading}>Load more</Button></div>
        )}
      </div>
      {hover && <DocumentHoverPreview row={hover.row} startX={hover.x} startY={hover.y} customTypes={customTypes} onHide={() => setHover(null)} />}
    </Modal>
  );
};
