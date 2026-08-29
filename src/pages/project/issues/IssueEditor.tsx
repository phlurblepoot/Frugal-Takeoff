// src/pages/project/issues/IssueEditor.tsx
import React, { useEffect, useState, useRef } from 'react';
import { Camera, Trash2 } from 'lucide-react';
import { Issue, saveIssue, getIssue, setIssueStatus, addIssuePhoto, removeIssuePhoto, uploadProjectFile, getImageUrl, getSettings, getSmtpSettings, getAlwaysCc, getCustomer, getProject, fetchFileBlob, sendIssue } from '../../../utils/store';
import { Customer } from '../../../types';
import { resolveRecipient } from '../../../utils/recipients';
import { useToast } from '../../../components/Toast';
import { Button, Field, Input, Modal, Textarea } from '../../../components/ui';
import { DocumentActionsBar } from '../../../components/documents/DocumentActionsBar';
import { useCollabEditing } from '../../../hooks/useCollabEditing';
import { EditPresenceBanner } from '../../../components/EditPresenceBanner';
import { IssueStatusPill, ISSUE_STATUS_META } from '../../../components/ui/IssueStatusPill';
import { buildIssuePdf } from './issuePdf';
import { hexToRgb, invertImageDataUrl } from '../../../utils/documentLetterhead';

export const IssueEditor: React.FC<{
  issue: Issue;
  projectId: string;
  projectName: string;
  contractor?: string | null;
  onClose: () => void;
  /** keepMounted: refresh the record without re-keying this editor — the
   *  document bar's save-then-generate flow dies if the modal remounts
   *  underneath it. */
  onSaved: (opts?: { keepMounted?: boolean }) => void;
}> = ({ issue, projectId, projectName, contractor, onClose, onSaved }) => {
  const { toast } = useToast();
  const [title, setTitle] = useState(issue.title ?? '');
  const [description, setDescription] = useState(issue.description ?? '');
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const dirty = title.trim() !== (issue.title ?? '') || description !== (issue.description ?? '');
  const padded = String(issue.number).padStart(3, '0');
  // One name for the stored document and the email attachment — they upsert
  // onto the same document row, so a differing name would flip the stored name
  // depending on which ran last.
  const pdfFileName = `ISS-${padded}.pdf`;

  const collab = useCollabEditing({
    type: 'issue',
    id: issue.id,
    isDirty: () => dirty,
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
        const resolved = resolveRecipient('issue', project?.contactEmails, customer?.emails);
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
    setUploading(true);
    let ok = 0;
    for (const f of Array.from(list)) {
      try {
        const { fileId } = await uploadProjectFile(projectId, f, 'issue-photo', { sourceType: 'issue', sourceId: issue.id });
        await addIssuePhoto(issue.id, fileId);
        ok++;
      } catch { /* keep going */ }
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = '';
    if (ok < list.length) toast(`Uploaded ${ok} of ${list.length} photos`, { type: ok ? 'warning' : 'error' });
    onSaved(); // reload the issue → photos appear
  };

  const dropPhoto = async (fileId: string) => {
    try { await removeIssuePhoto(issue.id, fileId); onSaved(); } catch { toast('Failed to remove photo', { type: 'error' }); }
  };

  // Built from the SAVED issue, never the typed-in draft: the bar commits
  // first, so re-reading the record here is what keeps a generated report and
  // the issue it claims to represent from drifting apart (photos included — an
  // upload that landed after this editor mounted is on the saved record, not
  // on the prop). A failed re-read throws on purpose — the bar then reports
  // the failure and keeps the existing document, rather than quietly storing
  // pre-save bytes and marking them current.
  const buildIssueBytes = async (headerEmail?: string): Promise<Uint8Array> => {
    const saved = await getIssue(issue.id);
    if (!saved) throw new Error('Issue not found');
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
    return buildIssuePdf({
      issue: saved,
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
      await saveIssue(issue.id, {
        ...issue,
        ...(collab.keepMineVersion !== null ? { version: collab.keepMineVersion } : {}),
        title: title.trim(), description: description || null,
      });
      toast('Issue saved', { type: 'success' });
      // A "Keep mine" save adopted a foreign version number; only a remount
      // clears it, otherwise the next save would post a stale version.
      onSaved({ keepMounted: opts?.keepMounted === true && collab.keepMineVersion === null });
    } catch (e) {
      toast(e instanceof Error && e.name === 'ConflictError' ? 'Issue changed elsewhere — reopen it' : 'Save failed', { type: 'error' });
      throw e;
    } finally { setSaving(false); }
  };

  // The bar saves before it generates, so `false` here means "don't build".
  const saveForDocument = async (): Promise<boolean> => {
    try { await handleSave({ keepMounted: true }); return true; } catch { return false; }
  };

  const cycleStatus = async () => {
    if (dirty) {
      toast('Save your changes before changing status', { type: 'warning' });
      return;
    }
    const next = issue.status === 'open' ? 'sent' : issue.status === 'sent' ? 'resolved' : 'open';
    try { await setIssueStatus(issue.id, next); onSaved(); } catch { toast('Status update failed', { type: 'error' }); }
  };

  return (
    <Modal open onClose={onClose} title={`ISS-${padded}`} width="lg"
      footer={<>
        <div className="mr-auto">
          <DocumentActionsBar
            source={{ sourceType: 'issue', sourceId: issue.id }}
            kind="issue-report"
            format="pdf"
            projectId={projectId}
            fileName={pdfFileName}
            build={async ({ headerEmail }) => new Blob([await buildIssueBytes(headerEmail)], { type: 'application/pdf' })}
            dirty={dirty}
            save={saveForDocument}
            updatedAt={issue.updatedAt}
            size="sm"
            send={{
              composer: {
                title: 'Send issue report',
                defaultTo: emailDefaults.defaultTo || undefined,
                defaultCc: emailDefaults.defaultCc || undefined,
                defaultBcc: emailDefaults.defaultBcc || undefined,
                defaultSubject: `Issue Report ISS-${padded} — ${projectName}`,
                defaultBody: `Hello,\n\nPlease find attached Issue Report ISS-${padded}${issue.title ? ' — ' + issue.title : ''} for ${projectName}.\n\nThank you.`,
                headerEmailOptions: emailDefaults.headerEmailOptions.length ? emailDefaults.headerEmailOptions : undefined,
                defaultHeaderEmail: emailDefaults.companyEmail || undefined,
              },
              sendFn: async (fileId, m) => {
                await sendIssue(issue.id, {
                  to: m.to, cc: m.cc, bcc: m.bcc, subject: m.subject, body: m.body,
                  fileId, attachmentFileIds: m.attachmentFileIds,
                });
                // The send stamps the issue 'sent' server-side.
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
        <button onClick={cycleStatus} title="Click to advance status"><IssueStatusPill status={issue.status} /></button>
        <span className="text-xs text-ink-faint">{Object.values(ISSUE_STATUS_META).map(m => m.label).join(' → ')}</span>
      </div>
      <Field label="Title" htmlFor="iss-title"><Input id="iss-title" value={title} onChange={e => setTitle(e.target.value)} /></Field>
      <div className="mt-3">
        <Field label="Description" htmlFor="iss-desc"><Textarea id="iss-desc" value={description} onChange={e => setDescription(e.target.value)} rows={4} /></Field>
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
        {issue.photos.length === 0 ? (
          <p className="text-xs text-ink-faint">No photos. Add before/during/after shots from the field.</p>
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {issue.photos.map(p => (
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
    </Modal>
  );
};
