// src/pages/documents/DocumentsTable.tsx
// Table (+ mobile card list) for the global Documents page. Version-history
// expandable row and open-on-click logic are extracted from the retired
// src/pages/project/ProjectDocuments.tsx (spec §Client). Row selection +
// per-row archive/delete/change-type affordances are Task 5 — the actual
// mutations (patchFile/deleteFile calls) live in DocumentsPage, this only
// decides what to show via selectionPolicy and confirms before delete.
import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import {
  Archive, ArchiveRestore, File, FileText, History, Image as ImageIcon, Sheet, Tag, Trash2,
} from 'lucide-react';
import { DocumentRow, ProjectFile, fetchFileBlob, formatBytes, listFileVersions } from '../../utils/store';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';
import { Skeleton, StatusPill, Table, TBody, TD, TH, THead, TR } from '../../components/ui';
import { DIRECT_UPLOAD_KINDS, CustomDocType, isDirectUploadKind, kindLabel, kindTone } from './docTypes';
import { selectionPolicy } from './documentsPolicy';
import { openTargetFor } from './openTarget';

export const downloadBlob = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const iconBtnCls = 'flex min-h-9 min-w-9 items-center justify-center rounded-md p-1.5 text-ink-faint transition-colors hover:bg-hover hover:text-ink md:min-h-0 md:min-w-0';

const MimeIcon: React.FC<{ mime: string }> = ({ mime }) => {
  const { type } = openTargetFor({ id: '', mime });
  const props = { size: 15, className: 'shrink-0 text-ink-faint' };
  if (type === 'pdf') return <FileText {...props} />;
  if (type === 'sheet') return <Sheet {...props} />;
  if (type === 'image') return <ImageIcon {...props} />;
  return <File {...props} />;
};

const VersionHistory: React.FC<{ fileName: string | null; versions: ProjectFile[] | null }> = ({
  fileName, versions,
}) => {
  const { toast } = useToast();
  if (versions === null) return <Skeleton className="h-6 w-48" />;
  if (versions.length <= 1) return <span className="text-xs text-ink-faint">No earlier versions.</span>;
  return (
    <ul className="space-y-1">
      {versions.slice(1).map(v => (
        <li key={v.id} className="flex items-center gap-3 text-xs text-ink-soft">
          <span>v{v.versionNumber}</span>
          <span>{new Date(v.createdAt).toLocaleString()}</span>
          <button
            onClick={async () => {
              try { downloadBlob(await fetchFileBlob(v.id), `${fileName ?? v.id} (v${v.versionNumber})`); }
              catch { toast('Download failed', { type: 'error' }); }
            }}
            className="text-accent-600 hover:underline dark:text-accent-400"
          >
            download
          </button>
        </li>
      ))}
    </ul>
  );
};

// Popover trigger for the "Change type" row menu (direct uploads only) — same
// outside-click idiom as MultiSelectDropdown.tsx, single-select instead of
// checkbox-list.
const ChangeTypeMenu: React.FC<{
  row: DocumentRow;
  customTypes: CustomDocType[];
  onChange: (kind: string) => void;
}> = ({ row, customTypes, onChange }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const options = [
    ...DIRECT_UPLOAD_KINDS.map(k => ({ id: k, label: kindLabel(k) })),
    ...customTypes.map(t => ({ id: `custom:${t.id}`, label: t.label })),
  ];

  return (
    <div ref={ref} className="relative">
      <button
        data-testid="doc-change-type"
        title="Change type"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-label={`Change type for ${row.name ?? row.id}`}
        className={iconBtnCls}
      >
        <Tag size={14} />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 max-h-64 w-44 overflow-y-auto rounded-lg border border-edge bg-raised py-1 shadow-lg">
          {options.map(o => (
            <button
              key={o.id}
              onClick={() => { setOpen(false); if (o.id !== row.kind) onChange(o.id); }}
              className={`block w-full truncate px-3 py-1.5 text-left text-sm hover:bg-hover ${
                o.id === row.kind ? 'font-semibold text-accent-600 dark:text-accent-400' : 'text-ink'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// Archive/restore, delete, and change-type icons for one row — shared by both
// the desktop table cell and the mobile card's action row.
const RowActions: React.FC<{
  row: DocumentRow;
  customTypes: CustomDocType[];
  onArchiveRows: (rows: DocumentRow[], archived: boolean) => Promise<void>;
  onDeleteRows: (rows: DocumentRow[]) => Promise<void>;
  onChangeKind: (row: DocumentRow, kind: string) => Promise<void>;
  onHistory: () => void;
}> = ({ row, customTypes, onArchiveRows, onDeleteRows, onChangeKind, onHistory }) => {
  const confirm = useConfirm();
  const { archivable, deletable } = selectionPolicy([row]);
  const archivableRow = archivable.length > 0;
  const deletableRow = deletable.length > 0;
  const directUpload = isDirectUploadKind(row.kind);

  const handleDelete = async () => {
    const ok = await confirm({
      title: 'Delete document',
      message: `Delete "${row.name ?? row.id}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    onDeleteRows([row]);
  };

  return (
    <div className="flex items-center justify-end gap-0.5">
      {archivableRow && (
        row.archived ? (
          <button title="Restore" aria-label="Restore" onClick={() => onArchiveRows([row], false)} className={iconBtnCls}>
            <ArchiveRestore size={14} />
          </button>
        ) : (
          <button
            title={row.source ? 'Managed by its source — archive here' : 'Archive'}
            aria-label="Archive"
            onClick={() => onArchiveRows([row], true)}
            className={iconBtnCls}
          >
            <Archive size={14} />
          </button>
        )
      )}
      {deletableRow && (
        <button title="Delete" aria-label="Delete" onClick={handleDelete} className={iconBtnCls}>
          <Trash2 size={14} />
        </button>
      )}
      {directUpload && (
        <ChangeTypeMenu row={row} customTypes={customTypes} onChange={kind => onChangeKind(row, kind)} />
      )}
      <button title="Version history" aria-label="Version history" onClick={onHistory} className={iconBtnCls}>
        <History size={14} />
      </button>
    </div>
  );
};

export const DocumentsTable: React.FC<{
  rows: DocumentRow[];
  customTypes: CustomDocType[];
  selected: Set<string>;
  onToggleRow: (id: string) => void;
  onToggleAll: () => void;
  onArchiveRows: (rows: DocumentRow[], archived: boolean) => Promise<void>;
  onDeleteRows: (rows: DocumentRow[]) => Promise<void>;
  onChangeKind: (row: DocumentRow, kind: string) => Promise<void>;
}> = ({ rows, customTypes, selected, onToggleRow, onToggleAll, onArchiveRows, onDeleteRows, onChangeKind }) => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [versions, setVersions] = useState<ProjectFile[] | null>(null);

  const handleOpen = async (row: DocumentRow) => {
    const target = openTargetFor(row);
    if (target.type === 'pdf' || target.type === 'sheet') navigate(target.url!);
    else if (target.type === 'image') window.open(target.url!, '_blank');
    else {
      try { downloadBlob(await fetchFileBlob(row.id), row.name ?? row.id); }
      catch { toast('Download failed', { type: 'error' }); }
    }
  };

  const handleHistory = async (row: DocumentRow) => {
    if (historyFor === row.id) { setHistoryFor(null); setVersions(null); return; }
    setHistoryFor(row.id);
    setVersions(null);
    try { setVersions(await listFileVersions(row.id)); }
    catch { setVersions([]); }
  };

  const SourceCell: React.FC<{ row: DocumentRow }> = ({ row }) => {
    if (!row.source) return <span className="text-ink-faint">—</span>;
    if (row.source.href) {
      return (
        <Link
          to={row.source.href}
          onClick={e => e.stopPropagation()}
          className="text-accent-600 hover:underline dark:text-accent-400"
        >
          {row.source.label}
        </Link>
      );
    }
    return <span>{row.source.label}</span>;
  };

  const allSelected = rows.length > 0 && rows.every(r => selected.has(r.id));

  return (
    <>
      <div className="hidden md:block">
        <Table>
          <THead>
            <TR>
              <TH className="w-8">
                <input
                  type="checkbox"
                  className="size-4 rounded border-edge-strong accent-accent-600"
                  checked={allSelected}
                  onChange={onToggleAll}
                  aria-label="Select all documents"
                />
              </TH>
              <TH>Name</TH>
              <TH>Type</TH>
              <TH>Project</TH>
              <TH>Source</TH>
              <TH>Date</TH>
              <TH className="text-right">Actions</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map(row => (
              <React.Fragment key={row.id}>
                <TR data-testid="documents-row" interactive onClick={() => handleOpen(row)}>
                  <TD className="w-8" onClick={e => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      data-testid="doc-row-select"
                      className="size-4 rounded border-edge-strong accent-accent-600"
                      checked={selected.has(row.id)}
                      onChange={() => onToggleRow(row.id)}
                      aria-label={`Select ${row.name ?? row.id}`}
                    />
                  </TD>
                  <TD className="font-medium text-ink">
                    <div className="flex items-center gap-2">
                      <MimeIcon mime={row.mime} />
                      <span className="truncate">{row.name ?? row.id}</span>
                    </div>
                    <div className="ml-[23px] text-xs font-normal text-ink-faint">
                      {formatBytes(row.size)}{row.versionNumber > 1 ? ` · v${row.versionNumber}` : ''}
                    </div>
                  </TD>
                  <TD><StatusPill tone={kindTone(row.kind)}>{kindLabel(row.kind, customTypes)}</StatusPill></TD>
                  <TD className="text-ink-soft">{row.projectName ?? '—'}</TD>
                  <TD><SourceCell row={row} /></TD>
                  <TD className="text-ink-soft">{new Date(row.createdAt).toLocaleDateString()}</TD>
                  <TD className="text-right" onClick={e => e.stopPropagation()}>
                    <RowActions
                      row={row}
                      customTypes={customTypes}
                      onArchiveRows={onArchiveRows}
                      onDeleteRows={onDeleteRows}
                      onChangeKind={onChangeKind}
                      onHistory={() => handleHistory(row)}
                    />
                  </TD>
                </TR>
                {historyFor === row.id && (
                  <TR>
                    <TD colSpan={7} className="bg-sunken/50">
                      <VersionHistory fileName={row.name} versions={versions} />
                    </TD>
                  </TR>
                )}
              </React.Fragment>
            ))}
          </TBody>
        </Table>
      </div>

      {/* Mobile document cards — same data + handlers as the table. */}
      <ul className="space-y-3 md:hidden">
        {rows.map(row => (
          <li key={row.id} data-testid="documents-row" className="rounded-xl border border-edge bg-raised p-3">
            <div className="flex items-start gap-2">
              <input
                type="checkbox"
                data-testid="doc-row-select"
                className="mt-0.5 size-4 shrink-0 rounded border-edge-strong accent-accent-600"
                checked={selected.has(row.id)}
                onChange={() => onToggleRow(row.id)}
                aria-label={`Select ${row.name ?? row.id}`}
              />
              <button type="button" onClick={() => handleOpen(row)} className="block min-w-0 flex-1 text-left">
                <div className="flex items-start justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2 font-medium text-ink">
                    <MimeIcon mime={row.mime} />
                    <span className="truncate break-words">{row.name ?? row.id}</span>
                  </span>
                  <StatusPill tone={kindTone(row.kind)}>{kindLabel(row.kind, customTypes)}</StatusPill>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-soft">
                  <span>{formatBytes(row.size)}</span>
                  {row.versionNumber > 1 && <span>v{row.versionNumber}</span>}
                  <span>{new Date(row.createdAt).toLocaleDateString()}</span>
                  {row.projectName && <span>{row.projectName}</span>}
                </div>
                {row.source && (
                  <div className="mt-1 text-xs" onClick={e => e.stopPropagation()}>
                    <SourceCell row={row} />
                  </div>
                )}
              </button>
            </div>
            <div className="mt-2 flex items-center justify-end border-t border-edge pt-2">
              <RowActions
                row={row}
                customTypes={customTypes}
                onArchiveRows={onArchiveRows}
                onDeleteRows={onDeleteRows}
                onChangeKind={onChangeKind}
                onHistory={() => handleHistory(row)}
              />
            </div>
            {historyFor === row.id && (
              <div className="mt-2 rounded-lg bg-sunken/50 p-2">
                <VersionHistory fileName={row.name} versions={versions} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
};
