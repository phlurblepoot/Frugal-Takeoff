// src/components/documents/DocumentActionsBar.tsx
// The one document strip every editor mounts (invoice, change order, issue,
// punch, proposal, daily report, RFI, AIA pay app) so Generate / Open /
// Download / Send all converge on ONE living document per record instead of
// each screen inventing its own "download a fresh PDF" button (spec
// docs/superpowers/specs/2026-08-29-document-actions-rollout).
//
// The invariants worth knowing before changing anything here:
//  - Generating from a dirty editor would produce a document that disagrees
//    with the record, so we save first and abort if that save fails.
//  - A record that already has a document never gets silently replaced — the
//    version/overwrite dialog is the only way past it.
//  - Send reuses the stored file only when it is genuinely current AND the
//    header email wasn't overridden in the composer; anything else rebuilds,
//    so the recipient always gets bytes that match the record.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, ExternalLink, FileText, Mail } from 'lucide-react';
import {
  CustomDocType, DocumentRow, GeneratedDoc, fetchFileBlob, getDocumentTypes, getFileMeta,
  persistGeneratedDocument,
} from '../../utils/store';
import { useGeneratedDocument } from '../../hooks/useGeneratedDocument';
import { downloadBlob } from '../../utils/download';
import { DocumentViewerModal } from '../../pages/documents/DocumentViewerModal';
import { openTargetFor } from '../../pages/documents/openTarget';
import { EmailComposer, EmailComposerProps } from '../EmailComposer';
import { useToast } from '../Toast';
import { Button } from '../ui';
import { DocFormat, DocumentStatusChip, FORMAT_WORD } from './DocumentStatusChip';
import { DocumentGenerationCancelled } from './errors';
import { VersionOrOverwriteDialog } from './VersionOrOverwriteDialog';

export type { DocFormat };

type SendMessage = {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  attachmentFileIds: string[];
};

export interface DocumentActionsBarProps {
  /** sourceId may be absent while the record is still unsaved — the bar then
   *  shows Generate/Send as blocked ('Save first') instead of guessing an id. */
  source: { sourceType: string; sourceId?: string };
  /** Document kind for persistGeneratedDocument (invoice, issue-report, …). */
  kind: string;
  format: DocFormat;
  projectId: string;
  /** Display + stored name, e.g. `Invoice-12.pdf`. */
  fileName: string;
  build: (opts: { headerEmail?: string }) => Promise<Blob>;
  dirty: boolean;
  /** Commit the editor before generating; resolve false if the save failed. */
  save: () => Promise<boolean>;
  /** When the underlying record last changed — drives the up-to-date chip. */
  updatedAt: number | null | undefined;
  readOnly?: boolean;
  onGenerated?: (fileId: string) => void | Promise<void>;
  send?: {
    /** Non-empty disables Send and explains why (wins over the dirty hint). */
    blockedReason?: string;
    composer: Omit<EmailComposerProps, 'open' | 'onClose' | 'onSend' | 'projectId' | 'primaryAttachmentName'>;
    sendFn: (fileId: string, m: SendMessage) => Promise<void>;
  };
  size?: 'sm';
  testIdPrefix?: string;
}

type PendingChoice = {
  fileName: string;
  versionNumber: number;
  resolve: (mode: 'version' | 'overwrite' | null) => void;
};

export const DocumentActionsBar: React.FC<DocumentActionsBarProps> = ({
  source, kind, format, projectId, fileName, build, dirty, save, updatedAt,
  readOnly = false, onGenerated, send, size, testIdPrefix = 'doc',
}) => {
  const { toast } = useToast();
  const navigate = useNavigate();
  const { file, upToDate, refresh } = useGeneratedDocument({
    sourceType: source.sourceType, sourceId: source.sourceId, kind, updatedAt,
    enabled: !!source.sourceId,
  });

  // Nothing to attach a document to yet.
  const unsaved = !source.sourceId;

  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingChoice | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [viewerRow, setViewerRow] = useState<DocumentRow | null>(null);
  const [customTypes, setCustomTypes] = useState<CustomDocType[]>([]);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const set = useCallback(<T,>(fn: (v: T) => void, v: T) => { if (mountedRef.current) fn(v); }, []);

  const word = FORMAT_WORD[format];
  const btnSize = size === 'sm' ? 'sm' : 'md';
  const p = testIdPrefix;

  // A dialog rendered by state, awaited like a confirm(): the async flows read
  // top-to-bottom instead of splintering into callbacks per branch.
  const askMode = (existing: GeneratedDoc) =>
    new Promise<'version' | 'overwrite' | null>(resolve => {
      setPending({ fileName: existing.name ?? fileName, versionNumber: existing.versionNumber, resolve });
    });
  const settle = (mode: 'version' | 'overwrite' | null) => {
    pending?.resolve(mode);
    setPending(null);
  };

  const buildAndPersist = async (
    mode: 'version' | 'overwrite' | undefined,
    headerEmail?: string,
  ): Promise<string> => {
    const blob = await build(headerEmail ? { headerEmail } : {});
    const { fileId } = await persistGeneratedDocument(blob, {
      projectId,
      kind,
      name: fileName,
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      // Only meaningful on an upsert hit — omitted entirely for a first save
      // so the server keeps its own default.
      ...(mode ? { mode } : {}),
    });
    await onGenerated?.(fileId);
    await refresh();
    return fileId;
  };

  const handleGenerate = async () => {
    // Guarded by the disabled button too; belt and braces, since persisting
    // against a missing sourceId would orphan the document.
    if (busy || unsaved) return;
    if (dirty) {
      let saved = false;
      set(setBusy, 'Saving…');
      try {
        saved = await save();
      } catch {
        saved = false;
      } finally {
        set(setBusy, null);
      }
      if (!saved) {
        toast('Save failed — nothing generated', { type: 'error' });
        return;
      }
    }

    let mode: 'version' | 'overwrite' | undefined;
    if (file) {
      const choice = await askMode(file);
      if (!choice) return;
      mode = choice;
    }

    set(setBusy, `Generating ${word}…`);
    try {
      await buildAndPersist(mode);
      toast(`${word} generated`, { type: 'success' });
    } catch {
      toast(`Failed to generate the ${word}`, { type: 'error' });
    } finally {
      set(setBusy, null);
    }
  };

  const handleDownload = async () => {
    if (!file) return;
    set(setBusy, 'Downloading…');
    try {
      downloadBlob(await fetchFileBlob(file.id), file.name ?? fileName);
    } catch {
      toast('Download failed', { type: 'error' });
    } finally {
      set(setBusy, null);
    }
  };

  const handleOpen = async () => {
    if (!file) return;
    set(setBusy, 'Opening…');
    try {
      const [meta, types] = await Promise.all([
        getFileMeta(file.id),
        getDocumentTypes().catch(() => [] as CustomDocType[]),
      ]);
      if (!meta) {
        toast('That document is no longer available', { type: 'error' });
        return;
      }
      set(setCustomTypes, types);
      // The bar knows its own record, so the row it hands the viewer carries
      // the bar's kind/project rather than a second lookup; the viewer only
      // reads these for its detail rows.
      set(setViewerRow, {
        id: meta.id,
        name: meta.name,
        mime: meta.mime,
        size: meta.size,
        kind,
        createdAt: meta.createdAt,
        versionNumber: meta.versionNumber,
        archived: false,
        projectId,
        projectName: null,
        customerId: null,
        customerName: null,
        source: null,
      });
    } catch {
      toast('Could not open that document', { type: 'error' });
    } finally {
      set(setBusy, null);
    }
  };

  const openInEditor = (row: DocumentRow) => {
    const target = openTargetFor(row);
    if (!target.url) { void handleDownload(); return; }
    if (target.type === 'image') { window.open(target.url, '_blank', 'noopener'); return; }
    navigate(target.url);
  };

  const handleSend = async (m: SendMessage & { headerEmail?: string }) => {
    if (!send) return;
    // Picking a different "document shows email" in the composer changes the
    // document itself, so a stored copy can't be reused even if it's current.
    const headerOverride =
      m.headerEmail && m.headerEmail !== send.composer.defaultHeaderEmail ? m.headerEmail : undefined;

    let fileId: string;
    if (file && upToDate && !headerOverride) {
      fileId = file.id;
    } else {
      let mode: 'version' | 'overwrite' | undefined;
      if (file) {
        const choice = await askMode(file);
        // Rethrown, not swallowed: EmailComposer keeps the dialog (and the
        // typed message) open when onSend rejects, and skips its error toast
        // for this sentinel — a cancel isn't a failed send.
        if (!choice) throw new DocumentGenerationCancelled();
        mode = choice;
      }
      set(setBusy, `Generating ${word}…`);
      try {
        fileId = await buildAndPersist(mode, headerOverride);
      } finally {
        set(setBusy, null);
      }
    }

    set(setBusy, 'Sending…');
    try {
      await send.sendFn(fileId, m);
    } finally {
      set(setBusy, null);
    }
    toast('Sent', { type: 'success' });
  };

  const sendBlocked = send
    ? (send.blockedReason ?? (dirty || unsaved ? 'Save first' : undefined))
    : undefined;
  const generateBlocked = unsaved ? 'Save first' : undefined;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2" data-testid={`${p}-actions`}>
        <span data-testid={`${p}-status`}>
          <DocumentStatusChip file={file} upToDate={upToDate} format={format} size={size} />
        </span>

        {!readOnly && (
          <Button
            size={btnSize}
            data-testid={`${p}-generate`}
            disabled={!!busy || !!generateBlocked}
            title={generateBlocked}
            onClick={() => { void handleGenerate(); }}
          >
            <FileText size={15} />{file ? `Regenerate ${word}` : `Generate ${word}`}
          </Button>
        )}

        {file && (
          <Button
            variant="secondary"
            size={btnSize}
            data-testid={`${p}-open`}
            disabled={!!busy}
            onClick={() => { void handleOpen(); }}
          >
            <ExternalLink size={15} />Open
          </Button>
        )}

        {file && (
          <Button
            variant="secondary"
            size={btnSize}
            data-testid={`${p}-download`}
            disabled={!!busy}
            onClick={() => { void handleDownload(); }}
          >
            <Download size={15} />Download
          </Button>
        )}

        {!readOnly && send && (
          <Button
            variant="secondary"
            size={btnSize}
            data-testid={`${p}-send`}
            disabled={!!busy || !!sendBlocked}
            title={sendBlocked}
            onClick={() => setComposerOpen(true)}
          >
            <Mail size={15} />Email
          </Button>
        )}

        {busy && <span className="text-xs text-ink-faint" data-testid={`${p}-busy`}>{busy}</span>}
      </div>

      {pending && (
        <VersionOrOverwriteDialog
          open
          fileName={pending.fileName}
          versionNumber={pending.versionNumber}
          format={format}
          testIdPrefix={p}
          onChoose={settle}
          onCancel={() => settle(null)}
        />
      )}

      {send && (
        <EmailComposer
          {...send.composer}
          open={composerOpen}
          // Both Modals listen for Escape on window, so an Escape aimed at the
          // version dialog would otherwise also close the composer and lose the
          // typed message. While a choice is pending, only the dialog closes.
          onClose={() => { if (!pending) setComposerOpen(false); }}
          projectId={projectId}
          primaryAttachmentName={fileName}
          onSend={handleSend}
        />
      )}

      {viewerRow && (
        <DocumentViewerModal
          row={viewerRow}
          customTypes={customTypes}
          hideArchive
          onClose={() => setViewerRow(null)}
          onOpenInEditor={openInEditor}
          onDownload={() => { void handleDownload(); }}
          // The bar never archives — the Documents page owns that.
          onArchive={async () => {}}
        />
      )}
    </>
  );
};
