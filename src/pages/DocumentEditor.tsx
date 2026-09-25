// src/pages/DocumentEditor.tsx — /tools/edit: the ONLYOFFICE document editor
// (replaces the old /tools/pdf and /tools/sheets editors; ONLYOFFICE Phase 1,
// docs/superpowers/specs/2026-09-25-onlyoffice-checklist.md).
//
// With ?fileId= it asks the server for a signed editor config, loads
// ONLYOFFICE's api.js from its public address and mounts the editor. The
// server decides everything that matters (edit or view, who the user is,
// where saves go); this page only hosts the iframe and handles the ways
// opening can fail. Without a fileId it is the landing page: recent files,
// open from Documents, or upload a file from the computer into a project.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Download, FileEdit, Upload, X } from 'lucide-react';
import { Button, Card, CardBody, CardHeader, EmptyState } from '../components/ui';
import { AddFilesButton } from '../components/documents/AddFilesButton';
import { useToast } from '../components/Toast';
import { useTheme } from '../context/ThemeContext';
import {
  EditorOpenError, fetchFileBlob, forgetRecentDocument, getFileMeta, getRecentDocuments, openInEditor,
  recordRecentDocument, type RecentDocument,
} from '../utils/store';
import { downloadBlob } from '../utils/download';
import { loadDocsApi } from '../utils/onlyofficeApi';
import { officeFormatByExt } from '../utils/officeFormats';
import { MimeIcon } from './documents/MimeIcon';
import { OpenFromComputerModal } from './documentEditor/OpenFromComputerModal';

const editorUrl = (fileId: string) => `/tools/edit?fileId=${encodeURIComponent(fileId)}`;
const isAdmin = () => {
  try { return JSON.parse(localStorage.getItem('user') || '{}').role === 'admin'; } catch { return false; }
};
// The mobile top bar sits above every page on phones (AppShell); the editor
// fills whatever is left.
const FULL_HEIGHT = 'h-[calc(100dvh-3.5rem-env(safe-area-inset-top))] md:h-dvh';

export const DocumentEditor: React.FC = () => {
  const [params] = useSearchParams();
  const fileId = params.get('fileId');
  // Keyed: switching files tears the old editor down and builds a new one.
  return fileId ? <EditorView key={fileId} fileId={fileId} /> : <EditorLanding />;
};

// ── The editor ───────────────────────────────────────────────────────────────

type ViewState =
  | { phase: 'loading' }
  | { phase: 'ready' }
  | { phase: 'error'; message: string; code?: string; status?: number };

let placeholderSeq = 0;

const EditorView: React.FC<{ fileId: string }> = ({ fileId }) => {
  const navigate = useNavigate();
  const { mode: themeMode } = useTheme();
  const hostRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<ViewState>({ phase: 'loading' });

  // Read once at open: ONLYOFFICE takes its theme when it starts, and
  // rebuilding the editor on a theme toggle would interrupt the person typing.
  const themeAtOpen = useRef(themeMode);
  const close = useCallback(() => {
    if (window.history.length > 1) navigate(-1);
    else navigate('/documents');
  }, [navigate]);
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    let cancelled = false;
    let editor: { destroyEditor?: () => void } | null = null;
    const host = hostRef.current;

    (async () => {
      try {
        const phone = window.matchMedia('(max-width: 767px)').matches;
        const opening = await openInEditor(fileId, {
          device: phone ? 'phone' : 'desktop',
          theme: themeAtOpen.current === 'dark' ? 'dark' : 'light',
        });
        if (cancelled) return;
        try {
          await loadDocsApi(opening.publicUrl);
        } catch (e) {
          throw new EditorOpenError(
            `Couldn't load the editor from ${opening.publicUrl} (${e instanceof Error ? e.message : 'unknown error'}).`,
            0, 'script',
          );
        }
        if (cancelled || !host || !window.DocsAPI) return;
        // ONLYOFFICE swaps its placeholder for an iframe, so the placeholder is
        // a plain DOM node React never renders or reconciles.
        const placeholder = document.createElement('div');
        placeholder.id = `oo-editor-${++placeholderSeq}`;
        host.appendChild(placeholder);
        editor = new window.DocsAPI.DocEditor(placeholder.id, {
          ...opening.config,
          events: {
            // The editor's own Close button (customization.close).
            onRequestClose: () => closeRef.current(),
          },
        }) as { destroyEditor?: () => void };
        recordRecentDocument({
          id: opening.file.id,
          name: opening.file.name || 'Document',
          mime: officeFormatByExt(opening.file.ext)?.mime ?? '',
        });
        setState({ phase: 'ready' });
      } catch (e) {
        if (cancelled) return;
        if (e instanceof EditorOpenError) {
          if (e.status === 404) forgetRecentDocument(fileId);
          setState({ phase: 'error', message: e.message, code: e.code, status: e.status });
        } else {
          setState({ phase: 'error', message: e instanceof Error ? e.message : "Couldn't open the file" });
        }
      }
    })();

    return () => {
      cancelled = true;
      try { editor?.destroyEditor?.(); } catch { /* already gone */ }
      if (host) host.replaceChildren();
    };
  }, [fileId]);

  return (
    <div className={`relative ${FULL_HEIGHT} bg-sunken`} data-testid="document-editor">
      <div ref={hostRef} className="absolute inset-0" data-testid="document-editor-host" />
      {state.phase === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-ink-soft" data-testid="document-editor-loading">
          Opening the editor…
        </div>
      )}
      {state.phase === 'error' && <OpenError fileId={fileId} state={state} onBack={close} />}
    </div>
  );
};

const OpenError: React.FC<{
  fileId: string;
  state: Extract<ViewState, { phase: 'error' }>;
  onBack: () => void;
}> = ({ fileId, state, onBack }) => {
  const { toast } = useToast();
  const setupProblem = state.code === 'not-configured' || state.code === 'onlyoffice-unreachable' || state.code === 'script';
  const missing = state.status === 404;

  const download = async () => {
    try {
      const meta = await getFileMeta(fileId);
      downloadBlob(await fetchFileBlob(fileId), meta?.name || 'document');
    } catch {
      toast('Download failed', { type: 'error' });
    }
  };

  return (
    <div className="absolute inset-0 flex items-center justify-center p-4" data-testid="document-editor-error">
      <Card className="w-full max-w-lg">
        <CardBody className="space-y-3">
          <div className="flex items-center gap-2 text-base font-semibold text-ink">
            <AlertTriangle size={18} className="text-amber-500" />
            {missing ? 'File not found' : "Couldn't open this file"}
          </div>
          <p className="text-sm text-ink-soft">{missing ? 'It may have been deleted or moved.' : state.message}</p>
          {setupProblem && (isAdmin()
            ? <p className="text-sm text-ink-soft">Check <Link className="text-accent-600 underline" to="/settings?tab=document-editor">Settings → Document Editor</Link> to see what's wrong.</p>
            : <p className="text-sm text-ink-soft">Ask an admin to check Settings → Document Editor.</p>)}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button variant="secondary" onClick={onBack}><ArrowLeft size={15} /> Back</Button>
            {!missing && state.status !== 403 && (
              <Button variant="secondary" onClick={() => void download()}><Download size={15} /> Download instead</Button>
            )}
          </div>
        </CardBody>
      </Card>
    </div>
  );
};

// ── Landing: no file chosen yet ─────────────────────────────────────────────

const EditorLanding: React.FC = () => {
  const navigate = useNavigate();
  const [recent, setRecent] = useState<RecentDocument[]>(() => getRecentDocuments());
  const [uploadOpen, setUploadOpen] = useState(false);

  const forget = (id: string) => {
    forgetRecentDocument(id);
    setRecent(getRecentDocuments());
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 md:p-8" data-testid="document-editor-landing">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-bold text-ink"><FileEdit size={22} className="text-accent-600" /> Document editor</h1>
        <p className="mt-1 text-sm text-ink-soft">
          Open a PDF, Word, Excel or PowerPoint file. Several people can edit the same file at once, and saves go into the file's version history.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <AddFilesButton
          label="Open from Documents"
          accept="office"
          multi={false}
          variant="primary"
          onPick={rows => { const r = rows[0]; if (r) navigate(editorUrl(r.id)); }}
        />
        <Button variant="secondary" onClick={() => setUploadOpen(true)}><Upload size={15} /> Open from computer</Button>
      </div>
      <Card>
        <CardHeader title="Recently opened" />
        <CardBody className={recent.length ? 'p-0' : undefined}>
          {recent.length === 0 ? (
            <EmptyState title="Nothing opened yet" description="Files you open here are listed for quick access." />
          ) : (
            <ul className="divide-y divide-edge" data-testid="recent-documents">
              {recent.map(r => (
                <li key={r.id} className="flex items-center gap-3 px-5 py-3">
                  <MimeIcon mime={r.mime} />
                  <button className="min-w-0 flex-1 truncate text-left text-sm text-ink hover:text-accent-600" onClick={() => navigate(editorUrl(r.id))}>
                    {r.name}
                  </button>
                  <span className="hidden text-xs text-ink-faint sm:inline">{new Date(r.at).toLocaleDateString()}</span>
                  <button className="rounded p-1 text-ink-faint hover:bg-hover hover:text-ink" title="Remove from this list" aria-label={`Remove ${r.name} from recent`} onClick={() => forget(r.id)}>
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
      <OpenFromComputerModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onUploaded={id => { setUploadOpen(false); navigate(editorUrl(id)); }}
      />
    </div>
  );
};
