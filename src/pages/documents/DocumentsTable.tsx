// src/pages/documents/DocumentsTable.tsx
// Table (+ mobile card list) for the global Documents page. Version-history
// expandable row and open-on-click logic are extracted from the retired
// src/pages/project/ProjectDocuments.tsx (spec §Client). Per-row
// archive/delete/change-type affordances used to live as always-visible
// buttons in this column; they're now a right-click/long-press context menu
// (RowContextMenu.tsx, spec docs/superpowers/specs/2026-08-17-documents-context-menu-design.md)
// so a single mis-click can't trigger a destructive action. The actual
// mutations (patchFile/deleteFile calls) live in DocumentsPage — this only
// decides what to offer via selectionPolicy (inside RowContextMenu) and
// confirms before delete.
import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import {
  File, FileText, History, Image as ImageIcon, Sheet,
} from 'lucide-react';
import { DocumentRow, ProjectFile, fetchFileBlob, formatBytes, listFileVersions } from '../../utils/store';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';
import { Skeleton, StatusPill, Table, TBody, TD, TH, THead, TR } from '../../components/ui';
import { CustomDocType, kindLabel, kindTone } from './docTypes';
import { openTargetFor } from './openTarget';
import { RowContextMenu, RowContextMenuState } from './RowContextMenu';

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

// Long-press duration (ms) and move tolerance (px) before it's treated as a
// scroll/drag instead — mirrors the timer-ref idiom in PdfCanvas.tsx.
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_TOLERANCE = 10;

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

// Row actions column: the version-history toggle is the only affordance left
// here (spec: "ONLY the version-history toggle remains, rendered ONLY when
// row.versionNumber > 1") — everything else moved into RowContextMenu.
const RowActions: React.FC<{ row: DocumentRow; onHistory: () => void }> = ({ row, onHistory }) => {
  if (row.versionNumber <= 1) return null;
  return (
    <div className="flex items-center justify-end">
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
  const confirm = useConfirm();
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [versions, setVersions] = useState<ProjectFile[] | null>(null);
  const [contextMenu, setContextMenu] = useState<RowContextMenuState | null>(null);

  const handleOpen = async (row: DocumentRow) => {
    const target = openTargetFor(row);
    if (target.type === 'pdf' || target.type === 'sheet') navigate(target.url!);
    else if (target.type === 'image') window.open(target.url!, '_blank');
    else {
      try { downloadBlob(await fetchFileBlob(row.id), row.name ?? row.id); }
      catch { toast('Download failed', { type: 'error' }); }
    }
  };

  const handleDownload = async (row: DocumentRow) => {
    try { downloadBlob(await fetchFileBlob(row.id), row.name ?? row.id); }
    catch { toast('Download failed', { type: 'error' }); }
  };

  const handleDelete = async (row: DocumentRow) => {
    const ok = await confirm({
      title: 'Delete document',
      message: `Delete "${row.name ?? row.id}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    onDeleteRows([row]);
  };

  const handleHistory = async (row: DocumentRow) => {
    if (historyFor === row.id) { setHistoryFor(null); setVersions(null); return; }
    setHistoryFor(row.id);
    setVersions(null);
    try { setVersions(await listFileVersions(row.id)); }
    catch { setVersions([]); }
  };

  // ── Long-press → context menu (touch/mobile cards). A timer armed on
  // touchstart opens the menu at the touch point if the finger hasn't moved
  // or lifted by LONG_PRESS_MS; any move past the tolerance (scroll/drag) or
  // an early lift cancels it. Mirrors PdfCanvas.tsx's longPressTimerRef idiom.
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const cancelLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };
  useEffect(() => () => cancelLongPress(), []);

  const handleTouchStart = (row: DocumentRow) => (e: React.TouchEvent) => {
    if (e.touches.length !== 1) { cancelLongPress(); return; }
    const touch = e.touches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY };
    longPressFiredRef.current = false;
    cancelLongPress();
    longPressTimerRef.current = setTimeout(() => {
      longPressFiredRef.current = true;
      longPressTimerRef.current = null;
      setContextMenu({ x: touch.clientX, y: touch.clientY, row });
    }, LONG_PRESS_MS);
  };
  const handleTouchMove = (e: React.TouchEvent) => {
    const start = touchStartRef.current;
    const touch = e.touches[0];
    if (!start || !touch) return;
    if (
      Math.abs(touch.clientX - start.x) > LONG_PRESS_MOVE_TOLERANCE
      || Math.abs(touch.clientY - start.y) > LONG_PRESS_MOVE_TOLERANCE
    ) cancelLongPress();
  };
  const handleTouchEnd = (e: React.TouchEvent) => {
    cancelLongPress();
    // A long-press already opened the menu — suppress the synthetic click
    // that would otherwise follow and open the file (mirrors PdfCanvas's
    // onTap longPressFiredRef check).
    if (longPressFiredRef.current) {
      e.preventDefault();
      longPressFiredRef.current = false;
    }
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
                <TR
                  data-testid="documents-row"
                  interactive
                  onClick={() => handleOpen(row)}
                  onContextMenu={e => {
                    e.preventDefault();
                    setContextMenu({ x: e.clientX, y: e.clientY, row });
                  }}
                >
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
                    <RowActions row={row} onHistory={() => handleHistory(row)} />
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
          <li
            key={row.id}
            data-testid="documents-row"
            className="rounded-xl border border-edge bg-raised p-3"
            onContextMenu={e => e.preventDefault()}
            onTouchStart={handleTouchStart(row)}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          >
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
            {row.versionNumber > 1 && (
              <div className="mt-2 flex items-center justify-end border-t border-edge pt-2">
                <RowActions row={row} onHistory={() => handleHistory(row)} />
              </div>
            )}
            {historyFor === row.id && (
              <div className="mt-2 rounded-lg bg-sunken/50 p-2">
                <VersionHistory fileName={row.name} versions={versions} />
              </div>
            )}
          </li>
        ))}
      </ul>

      {contextMenu && (
        <RowContextMenu
          state={contextMenu}
          customTypes={customTypes}
          onClose={() => setContextMenu(null)}
          onOpen={handleOpen}
          onDownload={handleDownload}
          onArchive={(row, archived) => onArchiveRows([row], archived)}
          onChangeKind={(row, kind) => onChangeKind(row, kind)}
          onDelete={handleDelete}
        />
      )}
    </>
  );
};
