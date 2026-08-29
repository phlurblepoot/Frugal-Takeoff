// src/pages/project/rfi/RfiEditor.tsx
import React, { useEffect, useState, useRef } from 'react';
import { Camera, Trash2 } from 'lucide-react';
import { Rfi, saveRfi, getRfi, setRfiStatus, addRfiPhoto, removeRfiPhoto, setRfiResponse, sendRfi, uploadProjectFile, getImageUrl, getSettings, getSmtpSettings, getAlwaysCc, getCustomer, getProject, fetchFileBlob } from '../../../utils/store';
import { Customer } from '../../../types';
import { resolveRecipient } from '../../../utils/recipients';
import { useToast } from '../../../components/Toast';
import { Button, Field, Input, Modal, Textarea } from '../../../components/ui';
import { DocumentActionsBar } from '../../../components/documents/DocumentActionsBar';
import { AddFilesButton } from '../../../components/documents/AddFilesButton';
import { useCollabEditing } from '../../../hooks/useCollabEditing';
import { EditPresenceBanner } from '../../../components/EditPresenceBanner';
import { RfiStatusPill, RFI_STATUS_META } from '../../../components/ui/RfiStatusPill';
import { buildRfiPdf } from './rfiPdf';
import { hexToRgb, invertImageDataUrl } from '../../../utils/documentLetterhead';

export const RfiEditor: React.FC<{
  rfi: Rfi;
  projectId: string;
  projectName: string;
  contractor?: string | null;
  onClose: () => void;
  /** keepMounted: refresh the record without re-keying this editor — the
   *  document bar's save-then-generate flow dies if the modal remounts
   *  underneath it. */
  onSaved: (opts?: { keepMounted?: boolean }) => void;
}> = ({ rfi, projectId, projectName, contractor, onClose, onSaved }) => {
  const { toast } = useToast();
  const [title, setTitle] = useState(rfi.title ?? '');
  const [question, setQuestion] = useState(rfi.question ?? '');
  const [specRef, setSpecRef] = useState(rfi.specRef ?? '');
  const [drawingRef, setDrawingRef] = useState(rfi.drawingRef ?? '');
  const [attention, setAttention] = useState(rfi.attention ?? '');
  const [responseNeededBy, setResponseNeededBy] = useState(rfi.responseNeededBy ?? '');
  const [responseDraft, setResponseDraft] = useState(rfi.responseText ?? '');
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const padded = String(rfi.number).padStart(3, '0');
  // One name for the stored document and the email attachment — they upsert
  // onto the same document row, so a differing name would flip the stored name
  // depending on which ran last.
  const pdfFileName = `RFI-${padded}.pdf`;

  // A typed-but-unsaved response counts as dirty too, so a remount-triggering
  // action (status change, photo upload, response-file attach) never silently
  // discards it.
  const responseDirty = responseDraft.trim() !== (rfi.responseText ?? '');

  const isDirty = () =>
    title.trim() !== (rfi.title ?? '') ||
    question !== (rfi.question ?? '') ||
    specRef !== (rfi.specRef ?? '') ||
    drawingRef !== (rfi.drawingRef ?? '') ||
    attention !== (rfi.attention ?? '') ||
    (responseNeededBy || '') !== (rfi.responseNeededBy ?? '') ||
    responseDirty;

  const dirty = isDirty();

  const collab = useCollabEditing({
    type: 'rfi',
    id: rfi.id,
    isDirty,
    onFresh: onSaved,
  });

  // Email defaults: resolved recipient, always-CC, header-email options.
  const [emailDefaults, setEmailDefaults] = useState<{
    defaultTo: string;
    defaultCc: string;
    defaultBcc: string;
    companyEmail: string;
    headerEmailOptions: { label: string; value: string }[];
  }>({ defaultTo: '', defaultCc: '', defaultBcc: '', companyEmail: '', headerEmailOptions: [] });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [settings, smtp, alwaysCc, project] = await Promise.all([
          getSettings(),
          getSmtpSettings().catch(() => ({})),
          getAlwaysCc(),
          getProject(projectId).catch(() => null),
        ]);
        if (cancelled) return;
        let customer: Customer | undefined;
        if (project?.customerId) {
          customer = await getCustomer(project.customerId).catch(() => undefined);
        }
        const resolved = resolveRecipient('rfi', project?.contactEmails, customer?.emails);
        const mergeCsv = (...lists: string[]) => Array.from(new Set(lists.flatMap(s => (s || '').split(',').map(x => x.trim()).filter(Boolean)))).join(', ');
        const companyEmail = settings.companyEmail ?? '';
        const fromAddress = (smtp as { fromAddress?: string }).fromAddress ?? '';
        const opts = [
          companyEmail ? { label: 'Company default', value: companyEmail } : null,
          fromAddress && fromAddress !== companyEmail ? { label: 'My email', value: fromAddress } : null,
        ].filter(Boolean) as { label: string; value: string }[];
        if (!cancelled) {
          setEmailDefaults({ defaultTo: resolved.to, defaultCc: mergeCsv(resolved.cc, alwaysCc), defaultBcc: resolved.bcc, companyEmail, headerEmailOptions: opts });
        }
      } catch { /* non-fatal */ }
    })();
    return () => { cancelled = true; };
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePhotos = async (list: FileList | null) => {
    if (!list || !list.length) return;
    if (isDirty()) {
      toast('Save your changes first', { type: 'warning' });
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    setUploading(true);
    let ok = 0;
    for (const f of Array.from(list)) {
      try {
        const { fileId } = await uploadProjectFile(projectId, f, 'rfi-photo', { sourceType: 'rfi', sourceId: rfi.id });
        await addRfiPhoto(rfi.id, fileId);
        ok++;
      } catch { /* keep going */ }
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = '';
    if (ok < list.length) toast(`Uploaded ${ok} of ${list.length} photos`, { type: ok ? 'warning' : 'error' });
    onSaved(); // reload the rfi → photos appear
  };

  const dropPhoto = async (fileId: string) => {
    try { await removeRfiPhoto(rfi.id, fileId); onSaved(); } catch { toast('Failed to remove photo', { type: 'error' }); }
  };

  // The answer can be a document that already lives in the app (the architect
  // emailed a sketch that was filed elsewhere) as much as a fresh upload, so
  // this is the shared picker rather than a bare file input. Attaching bumps
  // the RFI's version, which re-keys this editor — hence the save-first gate.
  const attachResponse = async (fileId: string) => {
    try {
      await setRfiResponse(rfi.id, { fileId });
      toast('Response attached', { type: 'success' });
      onSaved();
    } catch { toast('Failed to attach response', { type: 'error' }); }
  };

  const saveResponseText = async () => {
    try { await setRfiResponse(rfi.id, { text: responseDraft.trim() }); toast('Response saved', { type: 'success' }); onSaved(); }
    catch { toast('Failed to save response', { type: 'error' }); }
  };
  const downloadResponseFile = async () => {
    if (!rfi.responseFileId) return;
    try {
      const blob = await fetchFileBlob(rfi.responseFileId);
      const ext = blob.type === 'application/pdf' ? '.pdf' : blob.type === 'image/jpeg' ? '.jpg' : blob.type === 'image/png' ? '.png' : '';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `RFI-${padded}-response${ext}`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { toast('Failed to download response', { type: 'error' }); }
  };

  // Built from the SAVED RFI, never the typed-in draft: the bar commits first,
  // so re-reading the record here is what keeps a generated PDF and the RFI it
  // claims to represent from drifting apart (photos included). A failed
  // re-read throws on purpose — the bar then reports the failure and keeps the
  // existing document, rather than quietly storing pre-save bytes and marking
  // them current.
  const buildRfiBytes = async (headerEmail?: string): Promise<Uint8Array> => {
    const saved = await getRfi(rfi.id);
    if (!saved) throw new Error('RFI not found');
    const settings = await getSettings();
    let logoDataUrl: string | undefined = settings.logoUrl || undefined;
    if (logoDataUrl && !logoDataUrl.startsWith('data:')) {
      const blob = await (await fetch(logoDataUrl)).blob();
      logoDataUrl = await new Promise<string>(r => { const fr = new FileReader(); fr.onload = () => r(fr.result as string); fr.readAsDataURL(blob); });
    }
    if (logoDataUrl && settings.invertLogoOnDocuments === 'true') {
      logoDataUrl = await invertImageDataUrl(logoDataUrl);
    }
    // fetch each photo as a dataURL (authenticated content endpoint)
    const photoDataUrls: string[] = [];
    for (const p of saved.photos) {
      try {
        const blob = await fetchFileBlob(p.fileId);
        photoDataUrls.push(await new Promise<string>(r => { const fr = new FileReader(); fr.onload = () => r(fr.result as string); fr.readAsDataURL(blob); }));
      } catch { /* skip */ }
    }
    return buildRfiPdf({
      rfi: saved,
      projectName: projectName,
      contractor: contractor,
      photoDataUrls,
      letterhead: {
        brandRgb: hexToRgb(settings.companyBrandColor || '#99CB38'),
        company: {
          name: settings.companyName || settings.appName,
          phone: settings.companyPhone,
          email: settings.companyEmail,
          address: settings.companyAddress,
        },
        logoDataUrl,
      },
      headerEmail: headerEmail || undefined,
    });
  };

  const handleSave = async (opts?: { keepMounted?: boolean }) => {
    // Thrown rather than returned so the document bar's save-first step can
    // tell a refused save from a successful one.
    if (!title.trim()) { toast('A title is required', { type: 'warning' }); throw new Error('A title is required'); }
    setSaving(true);
    try {
      await saveRfi(rfi.id, {
        ...rfi,
        ...(collab.keepMineVersion !== null ? { version: collab.keepMineVersion } : {}),
        title: title.trim(), question: question || null, specRef: specRef || null, drawingRef: drawingRef || null, attention: attention || null, responseNeededBy: responseNeededBy || null,
      });
      // Save also persists a typed-but-unsaved response, so switching status,
      // uploading a photo, etc. right after Save never loses the draft.
      if (responseDirty && responseDraft.trim()) {
        await setRfiResponse(rfi.id, { text: responseDraft.trim() });
      }
      toast('RFI saved', { type: 'success' });
      // A "Keep mine" save adopted a foreign version number; only a remount
      // clears it, otherwise the next save would post a stale version.
      onSaved({ keepMounted: opts?.keepMounted === true && collab.keepMineVersion === null });
    } catch (e) {
      toast(e instanceof Error && e.name === 'ConflictError' ? 'RFI changed elsewhere — reopen it' : 'Save failed', { type: 'error' });
      throw e;
    } finally { setSaving(false); }
  };

  // The bar saves before it generates, so `false` here means "don't build".
  const saveForDocument = async (): Promise<boolean> => {
    try { await handleSave({ keepMounted: true }); return true; } catch { return false; }
  };

  const cycleStatus = async () => {
    if (isDirty()) {
      toast('Save your changes before changing status', { type: 'warning' });
      return;
    }
    const next = rfi.status === 'open' ? 'sent' : rfi.status === 'sent' ? 'answered' : rfi.status === 'answered' ? 'closed' : 'open';
    try { await setRfiStatus(rfi.id, next); onSaved(); } catch { toast('Status update failed', { type: 'error' }); }
  };

  return (
    <Modal open onClose={onClose} title={`RFI-${padded}`} width="lg"
      footer={<>
        <div className="mr-auto">
          <DocumentActionsBar
            source={{ sourceType: 'rfi', sourceId: rfi.id }}
            kind="rfi"
            format="pdf"
            projectId={projectId}
            fileName={pdfFileName}
            build={async ({ headerEmail }) => new Blob([await buildRfiBytes(headerEmail)], { type: 'application/pdf' })}
            dirty={dirty}
            save={saveForDocument}
            updatedAt={rfi.updatedAt}
            size="sm"
            send={{
              composer: {
                title: 'Send RFI',
                defaultTo: emailDefaults.defaultTo || undefined,
                defaultCc: emailDefaults.defaultCc || undefined,
                defaultBcc: emailDefaults.defaultBcc || undefined,
                defaultSubject: `RFI RFI-${padded} — ${projectName}`,
                defaultBody: `Hello,\n\nPlease find attached RFI-${padded}${rfi.title ? ' — ' + rfi.title : ''} for ${projectName}.\n\nPlease respond${rfi.responseNeededBy ? ` by ${rfi.responseNeededBy}` : ' at your earliest convenience'}.\n\nThank you.`,
                headerEmailOptions: emailDefaults.headerEmailOptions.length ? emailDefaults.headerEmailOptions : undefined,
                defaultHeaderEmail: emailDefaults.companyEmail || undefined,
              },
              sendFn: async (fileId, m) => {
                await sendRfi(rfi.id, {
                  to: m.to, cc: m.cc, bcc: m.bcc, subject: m.subject, body: m.body,
                  fileId, attachmentFileIds: m.attachmentFileIds,
                });
                // The send stamps the RFI 'sent' server-side.
                onSaved({ keepMounted: true });
              },
            }}
          />
        </div>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        <Button onClick={() => { void handleSave().catch(() => {}); }} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
      </>}
    >
      <EditPresenceBanner state={collab} />
      <div className="mb-3 flex items-center gap-2">
        <button onClick={cycleStatus} title="Click to advance status"><RfiStatusPill status={rfi.status} /></button>
        <span className="text-xs text-ink-faint">{Object.values(RFI_STATUS_META).map(m => m.label).join(' → ')}</span>
      </div>
      <Field label="Title" htmlFor="rfi-title"><Input id="rfi-title" value={title} onChange={e => setTitle(e.target.value)} /></Field>
      <div className="mt-3">
        <Field label="Question" htmlFor="rfi-question"><Textarea id="rfi-question" value={question} onChange={e => setQuestion(e.target.value)} rows={4} /></Field>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Attention" htmlFor="rfi-att"><Input id="rfi-att" value={attention} onChange={e => setAttention(e.target.value)} placeholder="e.g. GC project manager" /></Field>
        <Field label="Response needed by" htmlFor="rfi-due"><Input id="rfi-due" type="date" value={responseNeededBy} onChange={e => setResponseNeededBy(e.target.value)} /></Field>
        <Field label="Spec reference" htmlFor="rfi-spec"><Input id="rfi-spec" value={specRef} onChange={e => setSpecRef(e.target.value)} placeholder="e.g. 09 24 00" /></Field>
        <Field label="Drawing reference" htmlFor="rfi-dwg"><Input id="rfi-dwg" value={drawingRef} onChange={e => setDrawingRef(e.target.value)} placeholder="e.g. A-501" /></Field>
      </div>
      <div className="mt-4 border-t border-edge pt-3">
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-sm font-semibold text-ink">Photos</h4>
          <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
            <Camera size={14} />{uploading ? 'Uploading…' : 'Add photos'}
          </Button>
          {/* capture="environment" opens the rear camera on mobile (spec §4.3 field use) */}
          <input ref={fileRef} type="file" accept="image/*" capture="environment" multiple className="hidden"
            onChange={e => handlePhotos(e.target.files)} />
        </div>
        {rfi.photos.length === 0 ? (
          <p className="text-xs text-ink-faint">No photos. Add before/during/after shots from the field.</p>
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {rfi.photos.map(p => (
              <div key={p.id} className="group relative">
                <img src={getImageUrl(p.fileId)} alt="" className="h-24 w-full rounded-lg border border-edge object-cover" />
                <button onClick={() => dropPhoto(p.fileId)} title="Remove"
                  className="absolute right-1 top-1 flex min-h-9 min-w-9 items-center justify-center rounded-md bg-black/50 p-1 text-white opacity-100 transition-opacity focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100">
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="mt-4 border-t border-edge pt-3">
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-sm font-semibold text-ink">Response</h4>
          <AddFilesButton
            label="Attach response"
            accept="any"
            multi={false}
            defaultTab="upload"
            size="sm"
            disabled={dirty}
            title={dirty ? 'Save your changes first' : undefined}
            upload={{ kind: 'rfi-response', projectId, sourceType: 'rfi', sourceId: rfi.id }}
            onPick={rows => { if (rows.length) void attachResponse(rows[0].id); }}
          />
        </div>
        {rfi.answeredAt && <p className="mb-2 text-xs text-ink-faint">Answered {new Date(rfi.answeredAt).toLocaleDateString()}</p>}
        {rfi.responseFileId && (
          <p className="mb-2 text-xs">
            <button className="text-accent underline" onClick={downloadResponseFile}>Download response document</button>
          </p>
        )}
        <Field label="Response text (for non-PDF answers)" htmlFor="rfi-resp">
          <Textarea id="rfi-resp" value={responseDraft} onChange={e => setResponseDraft(e.target.value)} rows={3} />
        </Field>
        <div className="mt-2">
          <Button variant="secondary" size="sm" onClick={saveResponseText} disabled={!responseDraft.trim() || responseDraft.trim() === (rfi.responseText ?? '')}>Save response text</Button>
        </div>
      </div>
    </Modal>
  );
};
