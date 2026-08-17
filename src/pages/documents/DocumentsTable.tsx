// src/pages/documents/DocumentsTable.tsx
// Table (+ mobile card list) for the global Documents page. Version-history
// expandable row and open-on-click logic are extracted from the retired
// src/pages/project/ProjectDocuments.tsx (spec §Client).
import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { File, FileText, History, Image as ImageIcon, Sheet } from 'lucide-react';
import { DocumentRow, ProjectFile, fetchFileBlob, formatBytes, listFileVersions } from '../../utils/store';
import { useToast } from '../../components/Toast';
import { Skeleton, StatusPill, Table, TBody, TD, TH, THead, TR } from '../../components/ui';
import { CustomDocType, kindLabel, kindTone } from './docTypes';
import { openTargetFor } from './openTarget';

const downloadBlob = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const MimeIcon: React.FC<{ mime: string }> = ({ mime }) => {
  const { type } = openTargetFor({ id: '', mime });
  const props = { size: 15, className: 'shrink-0 text-ink-faint' };
  if (type === 'pdf') return <FileText {...props} />;
  if (type === 'sheet') return <Sheet {...props} />;
  if (type === 'image') return <ImageIcon {...props} />;
  return <File {...props} />;
};

const VersionHistory: React.FC<{ fileId: string; fileName: string | null; versions: ProjectFile[] | null }> = ({
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

export const DocumentsTable: React.FC<{
  rows: DocumentRow[];
  customTypes: CustomDocType[];
}> = ({ rows, customTypes }) => {
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

  return (
    <>
      <div className="hidden md:block">
        <Table>
          <THead>
            <TR>
              <TH />
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
                  {/* Reserved for Task 5's row-select checkbox. */}
                  <TD className="w-8" onClick={e => e.stopPropagation()} />
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
                    <button onClick={() => handleHistory(row)} title="Version history"
                      className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-hover hover:text-ink">
                      <History size={14} />
                    </button>
                  </TD>
                </TR>
                {historyFor === row.id && (
                  <TR>
                    <TD colSpan={7} className="bg-sunken/50">
                      <VersionHistory fileId={row.id} fileName={row.name} versions={versions} />
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
            <button type="button" onClick={() => handleOpen(row)} className="block w-full text-left">
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
            <div className="mt-2 flex items-center gap-1 border-t border-edge pt-2">
              <button onClick={() => handleHistory(row)} title="Version history"
                className="flex min-h-9 min-w-9 items-center justify-center rounded-md p-1.5 text-ink-faint transition-colors hover:bg-hover hover:text-ink">
                <History size={16} />
              </button>
            </div>
            {historyFor === row.id && (
              <div className="mt-2 rounded-lg bg-sunken/50 p-2">
                <VersionHistory fileId={row.id} fileName={row.name} versions={versions} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
};
