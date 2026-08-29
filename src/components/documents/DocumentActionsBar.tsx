// src/components/documents/DocumentActionsBar.tsx
// The one document strip every editor mounts (invoice, change order, issue,
// punch, proposal, daily report, RFI, AIA pay app) so Generate / Open /
// Download / Send all converge on ONE living document per record instead of
// each screen inventing its own "download a fresh PDF" button (spec
// docs/superpowers/specs/2026-08-29-document-actions-rollout).
//
// The invariants worth knowing before changing anything here:
//  - Generating from a dirty editor would produce a document that disagrees
//    with the record, so Generate AND Send both save first and abort if that
//    save fails (spec §2, "Dirty rule").
//  - A record that already has a document never gets silently replaced — the
//    version/overwrite dialog is the only way past it.
//  - Send reuses the stored file only when it is genuinely current, no save was
//    needed on the way in, AND the header email wasn't overridden in the
//    composer; anything else rebuilds, so the recipient always gets bytes that
//    match the record.
//  - A record with no change clock (staleness="unknown") never claims to be
//    current, so Send always rebuilds rather than mailing a stale file.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Download, ExternalLink, FileText, Mail } from 'lucide-react';
import { GeneratedDoc, fetchFileBlob, persistGeneratedDocument } from '../../utils/store';
import { useGeneratedDocument } from '../../hooks/useGeneratedDocument';
import { downloadBlob } from '../../utils/download';
import { EmailComposer, EmailComposerProps } from '../EmailComposer';
import { useToast } from '../Toast';
import { Button } from '../ui';
import { DocFormat, DocumentStatusChip, FORMAT_WORD } from './DocumentStatusChip';
import { DocumentGenerationCancelled } from './errors';
import { VersionOrOverwriteDialog } from './VersionOrOverwriteDialog';
import { useDocumentViewer } from './useDocumentViewer';

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
   *  shows Generate/Send as blocked ('Save first') instead of guessing an id.
   *  A dirty (but saved) record does NOT block: both actions save first. */
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
  /** Set to 'unknown' when the record has no updatedAt to compare against (the
   *  project-level punch report is assembled from rows that carry only
   *  createdAt). The chip then makes no freshness claim and Send always
   *  regenerates — a missing clock must not read as "nothing has changed". */
  staleness?: 'unknown';
  readOnly?: boolean;
  onGenerated?: (fileId: string) => void | Promise<void>;
  send?: {
    /** Non-empty disables Send and explains why. */
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
  staleness, readOnly = false, onGenerated, send, size, testIdPrefix = 'doc',
}) => {
  const { toast } = useToast();
  // Same peek-then-decide viewer the list rows open; it owns the modal, the
  // custom-type labels and the open-in-editor routing.
  const viewer = useDocumentViewer();
  const { file, upToDate, refresh } = useGeneratedDocument({
    sourceType: source.sourceType, sourceId: source.sourceId, kind, updatedAt,
    enabled: !!source.sourceId,
  });

  // Nothing to attach a document to yet.
  const unsaved = !source.sourceId;

  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingChoice | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);

  // The awaited version/overwrite choice, mirrored in a ref so unmounting can
  // settle it — a dangling promise would strand the generate/send flow that is
  // waiting on it (and, for send, EmailComposer's `sending` state with it).
  const pendingRef = useRef<PendingChoice | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const p = pendingRef.current;
      pendingRef.current = null;
      p?.resolve(null);
    };
  }, []);
  const set = useCallback(<T,>(fn: (v: T) => void, v: T) => { if (mountedRef.current) fn(v); }, []);

  const word = FORMAT_WORD[format];
  const btnSize = size === 'sm' ? 'sm' : 'md';
  const p = testIdPrefix;

  // A dialog rendered by state, awaited like a confirm(): the async flows read
  // top-to-bottom instead of splintering into callbacks per branch.
  const askMode = (existing: GeneratedDoc) =>
    new Promise<'version' | 'overwrite' | null>(resolve => {
      // Unmounted before we could ask: treat it as a cancel rather than
      // waiting on a dialog that will never render.
      if (!mountedRef.current) { resolve(null); return; }
      const next = { fileName: existing.name ?? fileName, versionNumber: existing.versionNumber, resolve };
      pendingRef.current = next;
      setPending(next);
    });
  const settle = (mode: 'version' | 'overwrite' | null) => {
    pendingRef.current = null;
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
    // The bytes are stored by this point. If the editor's own bookkeeping
    // (proposal fileId, a parent refresh) then fails, saying "failed to
    // generate" would be a lie that sends the user off regenerating a document
    // that already exists — report the linking failure for what it is.
    if (onGenerated) {
      try {
        await onGenerated(fileId);
      } catch {
        toast(`${word} generated, but linking it to the record failed`, { type: 'warning' });
      }
    }
    await refresh();
    return fileId;
  };

  // Generate and Send share one rule: a dirty editor is committed before any
  // bytes are built, and a failed save stops the flow (spec §2).
  const saveFirst = async (): Promise<boolean> => {
    if (!dirty) return true;
    set(setBusy, 'Saving…');
    try {
      return await save();
    } catch {
      return false;
    } finally {
      set(setBusy, null);
    }
  };

  const handleGenerate = async () => {
    // Guarded by the disabled button too; belt and braces, since persisting
    // against a missing sourceId would orphan the document.
    if (busy || unsaved) return;
    if (!(await saveFirst())) {
      toast('Save failed — nothing generated', { type: 'error' });
      return;
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

  const handleOpen = () => {
    if (!file) return;
    viewer.open(file, kind, projectId);
  };

  const handleSend = async (m: SendMessage & { headerEmail?: string }) => {
    if (!send) return;
    // Read BEFORE the save: `upToDate` below is this render's value, captured
    // when the composer's onSend fired. saveFirst() moves the record past the
    // stored file, but the closure still holds the pre-save "current" — trusting
    // it would email the pre-edit PDF. A save having been needed at all is
    // enough to know the stored copy is behind.
    const wasDirty = dirty;
    // Emailing from a dirty editor would attach bytes that disagree with the
    // record, so Send commits first exactly like Generate. A failed save throws
    // the same sentinel a cancelled dialog does, so EmailComposer keeps the
    // typed message on screen instead of reporting a send failure.
    if (!(await saveFirst())) {
      toast('Save failed — nothing sent', { type: 'error' });
      throw new DocumentGenerationCancelled();
    }
    // Picking a different "document shows email" in the composer changes the
    // document itself, so a stored copy can't be reused even if it's current.
    const headerOverride =
      m.headerEmail && m.headerEmail !== send.composer.defaultHeaderEmail ? m.headerEmail : undefined;

    const reusable = !!file && upToDate && !wasDirty && staleness !== 'unknown' && !headerOverride;

    let fileId: string;
    if (reusable && file) {
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

  // Dirty is no longer a blocker — Send saves first. Only a caller-supplied
  // reason or a record with no id (nothing to attach a document to) stops it.
  const sendBlocked = send
    ? (send.blockedReason ?? (unsaved ? 'Save first' : undefined))
    : undefined;
  const generateBlocked = unsaved ? 'Save first' : undefined;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2" data-testid={`${p}-actions`}>
        <span data-testid={`${p}-status`}>
          <DocumentStatusChip file={file} upToDate={upToDate} format={format} size={size} staleness={staleness} />
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
            onClick={handleOpen}
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

      {viewer.modal}
    </>
  );
};
