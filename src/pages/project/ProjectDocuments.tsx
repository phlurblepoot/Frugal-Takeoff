// src/pages/project/ProjectDocuments.tsx
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Download, FileText, History, Upload } from 'lucide-react';
import {
  ProjectFile, fetchFileBlob, formatBytes, getProjectFiles, listFileVersions, uploadProjectFile,
} from '../../utils/store';
import { useToast } from '../../components/Toast';
import {
  Button, EmptyState, Skeleton, StatusPill, Table, TBody, TD, TH, THead, TR,
} from '../../components/ui';

const SHEET_MIMES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
];

export const kindFromMime = (mime: string): string => {
  if (mime === 'application/pdf') return 'document';
  if (SHEET_MIMES.includes(mime)) return 'spreadsheet';
  if (mime.startsWith('image/')) return 'photo';
  return 'other';
};

export const openTargetFor = (f: Pick<ProjectFile, 'id' | 'mime'>):
  { type: 'pdf' | 'sheet' | 'image' | 'download'; url: string | null } => {
  if (f.mime === 'application/pdf') return { type: 'pdf', url: `/tools/pdf?fileId=${f.id}` };
  if (SHEET_MIMES.includes(f.mime)) return { type: 'sheet', url: `/tools/sheets?fileId=${f.id}` };
  if (f.mime.startsWith('image/')) return { type: 'image', url: `/api/images/${f.id}/raw` };
  return { type: 'download', url: null };
};

// Display order + labels for the kind filter. 'plan' covers internal canvas
// assets (page rasters/thumbnails/source pdfs) and is excluded from 'all'.
const KIND_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'document', label: 'Documents' },
  { id: 'proposal', label: 'Proposals' },
  { id: 'printout', label: 'Printouts' },
  { id: 'spreadsheet', label: 'Spreadsheets' },
  { id: 'photo', label: 'Photos' },
  { id: 'other', label: 'Other' },
  { id: 'plan', label: 'Plan assets' },
];

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

export const ProjectDocuments: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [files, setFiles] = useState<ProjectFile[] | null>(null);
  const [filter, setFilter] = useState('all');
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [versions, setVersions] = useState<ProjectFile[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = () => {
    if (!projectId) return;
    getProjectFiles(projectId).then(setFiles).catch(() => {
      setFiles([]);
      toast('Failed to load documents', { type: 'error' });
    });
  };
  useEffect(load, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const f of files ?? []) c.set(f.kind, (c.get(f.kind) ?? 0) + 1);
    return c;
  }, [files]);

  const visible = useMemo(() => {
    const all = files ?? [];
    if (filter === 'all') return all.filter(f => f.kind !== 'plan');
    return all.filter(f => f.kind === filter);
  }, [files, filter]);

  const handleUpload = async (list: FileList | null) => {
    if (!list || !projectId) return;
    setUploading(true);
    let succeeded = 0;
    for (const file of Array.from(list)) {
      try {
        await uploadProjectFile(projectId, file, kindFromMime(file.type || 'application/octet-stream'));
        succeeded++;
      } catch { /* keep going */ }
    }
    const failed = list.length - succeeded;
    if (failed === 0) toast(`Uploaded ${list.length} file${list.length > 1 ? 's' : ''}`, { type: 'success' });
    else if (succeeded === 0) toast('Upload failed', { type: 'error' });
    else toast(`Uploaded ${succeeded} of ${list.length} — ${failed} failed`, { type: 'error' });
    setUploading(false);
    if (inputRef.current) inputRef.current.value = '';
    load();
  };

  const handleOpen = async (f: ProjectFile) => {
    const target = openTargetFor(f);
    if (target.type === 'pdf' || target.type === 'sheet') navigate(target.url!);
    else if (target.type === 'image') window.open(target.url!, '_blank');
    else {
      try {
        downloadBlob(await fetchFileBlob(f.id), f.name ?? f.id);
      } catch {
        toast('Download failed', { type: 'error' });
      }
    }
  };

  const handleHistory = async (f: ProjectFile) => {
    if (historyFor === f.id) { setHistoryFor(null); setVersions(null); return; }
    setHistoryFor(f.id);
    setVersions(null);
    try {
      setVersions(await listFileVersions(f.id));
    } catch {
      setVersions([]);
    }
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-ink">Documents</h1>
        <Button onClick={() => inputRef.current?.click()} disabled={uploading}>
          <Upload size={15} />{uploading ? 'Uploading…' : 'Upload'}
        </Button>
        <input ref={inputRef} type="file" multiple className="hidden" onChange={e => handleUpload(e.target.files)} />
      </div>

      {/* Kind filter chips */}
      <div className="mb-4 flex flex-wrap gap-1.5">
        {KIND_FILTERS.map(k => {
          const count = k.id === 'all'
            ? (files ?? []).filter(f => f.kind !== 'plan').length
            : counts.get(k.id) ?? 0;
          if (k.id !== 'all' && count === 0) return null;
          return (
            <button
              key={k.id}
              onClick={() => setFilter(k.id)}
              aria-pressed={filter === k.id}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                filter === k.id
                  ? 'border-accent-500 bg-accent-50 text-accent-700 dark:bg-accent-900/30 dark:text-accent-300'
                  : 'border-edge text-ink-soft hover:bg-hover hover:text-ink'
              }`}
            >
              {k.label} · {count}
            </button>
          );
        })}
      </div>

      {files === null ? (
        <div className="space-y-2">{[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-10" />)}</div>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<FileText size={22} />}
          title="No documents yet"
          description="Upload contracts, photos, or plans — proposals and printouts you generate land here too."
          action={<Button onClick={() => inputRef.current?.click()}><Upload size={15} />Upload</Button>}
        />
      ) : (
        <>
        <div className="hidden md:block">
        <Table>
          <THead>
            <TR><TH>Name</TH><TH>Kind</TH><TH>Size</TH><TH>Version</TH><TH>Added</TH><TH className="text-right">Actions</TH></TR>
          </THead>
          <TBody>
            {visible.map(f => (
              <React.Fragment key={f.id}>
                <TR interactive onClick={() => handleOpen(f)}>
                  <TD className="font-medium text-ink">{f.name ?? f.id}</TD>
                  <TD><StatusPill>{f.kind}</StatusPill></TD>
                  <TD className="text-ink-soft">{formatBytes(f.size)}</TD>
                  <TD className="text-ink-soft">v{f.versionNumber}</TD>
                  <TD className="text-ink-soft">{new Date(f.createdAt).toLocaleDateString()}</TD>
                  <TD className="text-right" onClick={e => e.stopPropagation()}>
                    <button onClick={() => handleHistory(f)} title="Version history"
                      className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-hover hover:text-ink">
                      <History size={14} />
                    </button>
                    <button
                      onClick={async () => {
                        try { downloadBlob(await fetchFileBlob(f.id), f.name ?? f.id); }
                        catch { toast('Download failed', { type: 'error' }); }
                      }}
                      title="Download"
                      className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-hover hover:text-ink"
                    >
                      <Download size={14} />
                    </button>
                  </TD>
                </TR>
                {historyFor === f.id && (
                  <TR>
                    <TD colSpan={6} className="bg-sunken/50">
                      {versions === null ? (
                        <Skeleton className="h-6 w-48" />
                      ) : versions.length <= 1 ? (
                        <span className="text-xs text-ink-faint">No earlier versions.</span>
                      ) : (
                        <ul className="space-y-1">
                          {versions.slice(1).map(v => (
                            <li key={v.id} className="flex items-center gap-3 text-xs text-ink-soft">
                              <span>v{v.versionNumber}</span>
                              <span>{new Date(v.createdAt).toLocaleString()}</span>
                              <button
                                onClick={async () => {
                                  try { downloadBlob(await fetchFileBlob(v.id), `${f.name ?? f.id} (v${v.versionNumber})`); }
                                  catch { toast('Download failed', { type: 'error' }); }
                                }}
                                className="text-accent-600 hover:underline"
                              >
                                download
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </TD>
                  </TR>
                )}
              </React.Fragment>
            ))}
          </TBody>
        </Table>
        </div>

        {/* Mobile document cards — same `visible` data + handlers as the table. */}
        <ul className="space-y-3 md:hidden">
          {visible.map(f => (
            <li key={f.id} className="rounded-xl border border-edge bg-raised p-3">
              <button
                type="button"
                onClick={() => handleOpen(f)}
                className="block w-full text-left"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="font-medium text-ink break-words">{f.name ?? f.id}</span>
                  <StatusPill>{f.kind}</StatusPill>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-soft">
                  <span>{formatBytes(f.size)}</span>
                  <span>v{f.versionNumber}</span>
                  <span>{new Date(f.createdAt).toLocaleDateString()}</span>
                </div>
              </button>
              <div className="mt-2 flex items-center gap-1 border-t border-edge pt-2">
                <button onClick={() => handleHistory(f)} title="Version history"
                  className="flex min-h-9 min-w-9 items-center justify-center rounded-md p-1.5 text-ink-faint transition-colors hover:bg-hover hover:text-ink">
                  <History size={16} />
                </button>
                <button
                  onClick={async () => {
                    try { downloadBlob(await fetchFileBlob(f.id), f.name ?? f.id); }
                    catch { toast('Download failed', { type: 'error' }); }
                  }}
                  title="Download"
                  className="flex min-h-9 min-w-9 items-center justify-center rounded-md p-1.5 text-ink-faint transition-colors hover:bg-hover hover:text-ink"
                >
                  <Download size={16} />
                </button>
              </div>
              {historyFor === f.id && (
                <div className="mt-2 rounded-lg bg-sunken/50 p-2">
                  {versions === null ? (
                    <Skeleton className="h-6 w-48" />
                  ) : versions.length <= 1 ? (
                    <span className="text-xs text-ink-faint">No earlier versions.</span>
                  ) : (
                    <ul className="space-y-1">
                      {versions.slice(1).map(v => (
                        <li key={v.id} className="flex items-center gap-3 text-xs text-ink-soft">
                          <span>v{v.versionNumber}</span>
                          <span>{new Date(v.createdAt).toLocaleString()}</span>
                          <button
                            onClick={async () => {
                              try { downloadBlob(await fetchFileBlob(v.id), `${f.name ?? f.id} (v${v.versionNumber})`); }
                              catch { toast('Download failed', { type: 'error' }); }
                            }}
                            className="text-accent-600 hover:underline"
                          >
                            download
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
        </>
      )}
    </div>
  );
};
