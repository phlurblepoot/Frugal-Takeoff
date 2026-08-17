// src/pages/documents/DocumentsBulkBar.tsx
// Dark bulk-action bar shown once at least one row is selected (mockup: N
// selected · Download · Archive/Restore · Delete (N of M) · clear). Purely
// presentational — DocumentsPage owns the actual mutations (patchFile/
// deleteFile calls + refresh); this component only decides what's enabled
// via selectionPolicy and confirms before delete.
import React, { useState } from 'react';
import { Archive, ArchiveRestore, Download, Trash2, X } from 'lucide-react';
import { DocumentRow } from '../../utils/store';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';
import { selectionPolicy } from './documentsPolicy';

type Busy = 'download' | 'archive' | 'delete' | null;

export const DocumentsBulkBar: React.FC<{
  selected: DocumentRow[];
  archivedView: boolean;
  onClear: () => void;
  onDownload: (rows: DocumentRow[]) => Promise<void>;
  onArchive: (rows: DocumentRow[], archived: boolean) => Promise<void>;
  onDelete: (rows: DocumentRow[]) => Promise<void>;
}> = ({ selected, archivedView, onClear, onDownload, onArchive, onDelete }) => {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<Busy>(null);

  if (selected.length === 0) return null;

  const { downloadable, archivable, deletable } = selectionPolicy(selected);

  const handleDownload = async () => {
    setBusy('download');
    try { await onDownload(downloadable); }
    catch { toast('Some downloads failed', { type: 'error' }); }
    finally { setBusy(null); }
  };

  const handleArchive = async () => {
    setBusy('archive');
    try { await onArchive(archivable, !archivedView); }
    catch { toast(archivedView ? 'Failed to restore' : 'Failed to archive', { type: 'error' }); }
    finally { setBusy(null); }
  };

  const handleDelete = async () => {
    const ok = await confirm({
      title: 'Delete documents',
      message: `Delete ${deletable.length} document${deletable.length === 1 ? '' : 's'}? This cannot be undone.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    setBusy('delete');
    try { await onDelete(deletable); }
    catch { toast('Failed to delete', { type: 'error' }); }
    finally { setBusy(null); }
  };

  return (
    <div
      data-testid="documents-bulkbar"
      className="mb-4 flex flex-wrap items-center gap-3 rounded-xl bg-slate-900 px-4 py-2.5 text-sm text-white shadow-lg dark:bg-slate-950"
    >
      <button
        onClick={onClear}
        aria-label="Clear selection"
        className="flex min-h-9 min-w-9 items-center justify-center rounded-lg text-slate-300 transition-colors hover:bg-white/10 hover:text-white"
      >
        <X size={16} />
      </button>
      <span className="font-medium">{selected.length} selected</span>
      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        <button
          onClick={handleDownload}
          disabled={busy !== null || downloadable.length === 0}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-slate-100 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Download size={14} />{busy === 'download' ? 'Downloading…' : 'Download'}
        </button>
        <button
          onClick={handleArchive}
          disabled={busy !== null || archivable.length === 0}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-slate-100 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {archivedView ? <ArchiveRestore size={14} /> : <Archive size={14} />}
          {busy === 'archive' ? (archivedView ? 'Restoring…' : 'Archiving…') : (archivedView ? 'Restore' : 'Archive')}
        </button>
        <button
          onClick={handleDelete}
          disabled={busy !== null || deletable.length === 0}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-red-300 transition-colors hover:bg-red-500/20 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Trash2 size={14} />{busy === 'delete' ? 'Deleting…' : `Delete (${deletable.length} of ${selected.length})`}
        </button>
      </div>
    </div>
  );
};
