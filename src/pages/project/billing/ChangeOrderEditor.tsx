// src/pages/project/billing/ChangeOrderEditor.tsx
import React, { useEffect, useState, useRef } from 'react';
import { Camera, Plus, Trash2 } from 'lucide-react';
import {
  ChangeOrder, ChangeOrderLine,
  saveChangeOrder, getChangeOrder, setChangeOrderStatus, getSettings, getSmtpSettings, getAlwaysCc, getCustomer, getProject, sendChangeOrder,
  uploadProjectFile, addCOPhoto, removeCOPhoto, getImageUrl, fetchFileBlob,
} from '../../../utils/store';
import { Customer } from '../../../types';
import { resolveRecipient } from '../../../utils/recipients';
import { formatMoney } from '../../../utils/money';
import { useToast } from '../../../components/Toast';
import { Button, Field, Input, Modal, Textarea, Table, TBody, TD, TH, THead, TR } from '../../../components/ui';
import { DocumentActionsBar } from '../../../components/documents/DocumentActionsBar';
import { useCollabEditing } from '../../../hooks/useCollabEditing';
import { EditPresenceBanner } from '../../../components/EditPresenceBanner';
import { ChangeOrderStatusPill } from '../../../components/ui/BillingPills';
import { buildChangeOrderPdf } from './changeOrderPdf';
import { hexToRgb, invertImageDataUrl } from '../../../utils/documentLetterhead';
import { lineCents, draftTotalCents } from './InvoiceEditor';

export const ChangeOrderEditor: React.FC<{
  changeOrder: ChangeOrder;
  onClose: () => void;
  /** keepMounted: refresh the record without re-keying this editor — the
   *  document bar's save-then-generate flow dies if the modal remounts
   *  underneath it. */
  onSaved: (opts?: { keepMounted?: boolean }) => void;
  projectName: string;
  contractor?: string | null;
  address?: string | null;
  projectId: string;
}> = ({ changeOrder, onClose, onSaved, projectName, contractor, address, projectId }) => {
  const { toast } = useToast();
  const co = changeOrder;
  const [number, setNumber] = useState(co.number ?? '');
  const [date, setDate] = useState(co.date ? new Date(co.date).toISOString().slice(0, 10) : '');
  const [title, setTitle] = useState(co.title ?? '');
  const [description, setDescription] = useState(co.description ?? '');
  const [lines, setLines] = useState<ChangeOrderLine[]>(co.lines.length ? co.lines : []);
  const [lumpSumAmount, setLumpSumAmount] = useState(String(co.lumpSumAmount ?? 0));
  const [scheduleImpactDays, setScheduleImpactDays] = useState(
    co.scheduleImpactDays === null || co.scheduleImpactDays === undefined ? '' : String(co.scheduleImpactDays)
  );
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const initialDate = co.date ? new Date(co.date).toISOString().slice(0, 10) : '';
  const initialScheduleImpactDays =
    co.scheduleImpactDays === null || co.scheduleImpactDays === undefined ? '' : String(co.scheduleImpactDays);
  const dirty =
    number !== (co.number ?? '') ||
    date !== initialDate ||
    title !== (co.title ?? '') ||
    description !== (co.description ?? '') ||
    lumpSumAmount !== String(co.lumpSumAmount ?? 0) ||
    scheduleImpactDays !== initialScheduleImpactDays ||
    JSON.stringify(lines) !== JSON.stringify(co.lines.length ? co.lines : []);

  const collab = useCollabEditing({
    type: 'changeOrder',
    id: co.id,
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
        const resolved = resolveRecipient('changeOrder', project?.contactEmails, customer?.emails);
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

  // One name for the stored document and the email attachment — they upsert
  // onto the same row, so a differing name would flip it depending on which
  // ran last. Keyed off the edited number rather than the loaded one because
  // the bar saves before it generates, so the draft number is the one the
  // document will carry. The id fallback keeps unnumbered drafts apart.
  const pdfFileName = `CO-${number || co.id}.pdf`;

  const lumpCents = Math.round((Number(lumpSumAmount) || 0) * 100);
  const total = draftTotalCents(lines) + lumpCents;

  const setLine = (i: number, patch: Partial<ChangeOrderLine>) =>
    setLines(prev => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const addLine = () => setLines(prev => [...prev, { description: '', qty: 1, unitPrice: 0 }]);
  const removeLine = (i: number) => setLines(prev => prev.filter((_, idx) => idx !== i));

  const handleSave = async (opts?: { keepMounted?: boolean }) => {
    setSaving(true);
    try {
      await saveChangeOrder(co.id, {
        ...co,
        ...(collab.keepMineVersion !== null ? { version: collab.keepMineVersion } : {}),
        number: number || null,
        date: date ? new Date(date).getTime() : null,
        title: title || null,
        description: description || null,
        lumpSumAmount: Number(lumpSumAmount) || 0,
        scheduleImpactDays: scheduleImpactDays.trim() === '' ? null : (Number(scheduleImpactDays) || 0),
        lines: lines.map(l => ({ description: l.description, qty: Number(l.qty) || 0, unitPrice: Number(l.unitPrice) || 0 })),
      });
      toast('Change order saved', { type: 'success' });
      // A "Keep mine" save adopted a foreign version number; only a remount
      // clears it, otherwise the next save would post a stale version.
      onSaved({ keepMounted: opts?.keepMounted === true && collab.keepMineVersion === null });
    } catch (e) {
      toast(e instanceof Error && e.name === 'ConflictError' ? 'Change order changed elsewhere — reopen it' : 'Save failed', { type: 'error' });
      throw e;
    } finally {
      setSaving(false);
    }
  };

  // The bar saves before it generates, so `false` here means "don't build".
  const saveForDocument = async (): Promise<boolean> => {
    try { await handleSave({ keepMounted: true }); return true; } catch { return false; }
  };

  const handlePhotos = async (list: FileList | null) => {
    if (!list || !list.length) return;
    setUploading(true);
    let ok = 0;
    for (const f of Array.from(list)) {
      try {
        const { fileId } = await uploadProjectFile(projectId, f, 'change-order-photo', { sourceType: 'change-order', sourceId: co.id });
        await addCOPhoto(co.id, fileId);
        ok++;
      } catch { /* keep going */ }
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = '';
    if (ok < list.length) toast(`Uploaded ${ok} of ${list.length} photos`, { type: ok ? 'warning' : 'error' });
    onSaved(); // reload the CO → photos appear (and version bumps)
  };

  const dropPhoto = async (fileId: string) => {
    try { await removeCOPhoto(co.id, fileId); onSaved(); } catch { toast('Failed to remove photo', { type: 'error' }); }
  };

  // Built from the SAVED change order, never the typed-in draft: the bar
  // commits first, so re-reading the record here is what keeps a generated PDF
  // and the change order it claims to represent from drifting apart.
  const buildBytes = async (headerEmail?: string): Promise<Uint8Array> => {
    const saved = (await getChangeOrder(co.id).catch(() => null)) ?? co;
    const settings = await getSettings();
    let logoDataUrl: string | undefined;
    const logoUrl = settings.logoUrl;
    if (logoUrl) {
      if (logoUrl.startsWith('data:')) {
        logoDataUrl = logoUrl;
      } else {
        try {
          const resp = await fetch(logoUrl);
          const blob = await resp.blob();
          logoDataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
        } catch { /* skip logo on fetch error */ }
      }
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
    return buildChangeOrderPdf({
      changeOrder: saved,
      projectName,
      contractor,
      address,
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
      photoDataUrls,
      headerEmail: headerEmail || undefined,
    });
  };

  const changeStatus = async (status: string) => {
    try { await setChangeOrderStatus(co.id, status); onSaved(); } catch { toast('Status update failed', { type: 'error' }); }
  };

  return (
    <Modal open onClose={onClose} title={`Change Order CO-${co.number ?? ''}`} width="lg"
      footer={<>
        <div className="mr-auto">
          <DocumentActionsBar
            source={{ sourceType: 'change-order', sourceId: co.id }}
            kind="change-order"
            format="pdf"
            projectId={projectId}
            fileName={pdfFileName}
            build={async ({ headerEmail }) => new Blob([await buildBytes(headerEmail)], { type: 'application/pdf' })}
            dirty={dirty}
            save={saveForDocument}
            updatedAt={co.updatedAt}
            size="sm"
            send={{
              composer: {
                title: 'Send change order request',
                defaultTo: emailDefaults.defaultTo || undefined,
                defaultCc: emailDefaults.defaultCc || undefined,
                defaultBcc: emailDefaults.defaultBcc || undefined,
                defaultSubject: `Change Order Request CO-${number} — ${projectName}`,
                defaultBody: `Hello,\n\nPlease find attached Change Order Request CO-${number} for ${projectName}${description ? ', covering: ' + description : ''}.\n\nPlease review and approve at your convenience.\n\nThank you.`,
                headerEmailOptions: emailDefaults.headerEmailOptions.length ? emailDefaults.headerEmailOptions : undefined,
                defaultHeaderEmail: emailDefaults.companyEmail || undefined,
              },
              sendFn: async (fileId, m) => {
                await sendChangeOrder(co.id, {
                  to: m.to, cc: m.cc, bcc: m.bcc, subject: m.subject, body: m.body,
                  fileId, attachmentFileIds: m.attachmentFileIds,
                });
                // The send moves the change order to 'sent' server-side.
                onSaved({ keepMounted: true });
              },
            }}
          />
        </div>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        <Button onClick={() => { void handleSave().catch(() => {}); }} disabled={saving}>{saving ? 'Saving…' : 'Save change order'}</Button>
      </>}
    >
      <EditPresenceBanner state={collab} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ChangeOrderStatusPill status={co.status} />
        {co.status !== 'approved' && <Button variant="ghost" size="sm" onClick={() => changeStatus('approved')}>Approve</Button>}
        {co.status !== 'rejected' && <Button variant="ghost" size="sm" onClick={() => changeStatus('rejected')}>Reject</Button>}
        <span className="text-xs text-ink-faint">Only approved change orders count toward the contract total.</span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Number" htmlFor="co-num"><Input id="co-num" value={number} onChange={e => setNumber(e.target.value)} /></Field>
        <Field label="Date" htmlFor="co-date"><Input id="co-date" type="date" value={date} onChange={e => setDate(e.target.value)} /></Field>
        <Field label="Schedule impact (days)" htmlFor="co-impact"><Input id="co-impact" type="number" value={scheduleImpactDays} onChange={e => setScheduleImpactDays(e.target.value)} placeholder="0" /></Field>
      </div>

      <div className="mt-3">
        <Field label="Title" htmlFor="co-title"><Input id="co-title" value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Kitchen electrical add" /></Field>
      </div>

      <div className="mt-3">
        <Field label="Description" htmlFor="co-desc"><Textarea id="co-desc" value={description} onChange={e => setDescription(e.target.value)} rows={4} placeholder="Describe the scope change…" /></Field>
      </div>

      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-sm font-semibold text-ink">Line items</h4>
          <Button variant="ghost" size="sm" onClick={addLine}><Plus size={14} />Add line</Button>
        </div>
        <Table>
          <THead><TR><TH>Description</TH><TH>Qty</TH><TH>Unit price</TH><TH>Amount</TH><TH></TH></TR></THead>
          <TBody>
            {lines.map((l, i) => (
              <TR key={i}>
                <TD><Input value={l.description} onChange={e => setLine(i, { description: e.target.value })} /></TD>
                <TD className="w-20"><Input type="number" value={String(l.qty)} onChange={e => setLine(i, { qty: parseFloat(e.target.value) || 0 })} /></TD>
                <TD className="w-28"><Input type="number" value={String(l.unitPrice)} onChange={e => setLine(i, { unitPrice: parseFloat(e.target.value) || 0 })} /></TD>
                <TD className="text-ink-soft">{formatMoney(lineCents(l))}</TD>
                <TD><button onClick={() => removeLine(i)} title="Remove" className="rounded-md p-1 text-ink-faint hover:bg-hover hover:text-red-600"><Trash2 size={14} /></button></TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Lump sum" htmlFor="co-lump"><Input id="co-lump" type="number" value={lumpSumAmount} onChange={e => setLumpSumAmount(e.target.value)} placeholder="0.00" /></Field>
      </div>

      <div className="mt-4 flex justify-end gap-6 border-t border-edge pt-3 text-sm">
        <div className="text-right">
          <div className="text-ink-soft">Total <span className="ml-2 font-semibold text-ink">{formatMoney(total)}</span></div>
        </div>
      </div>

      <div className="mt-4 border-t border-edge pt-3">
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-sm font-semibold text-ink">Photos</h4>
          <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
            <Camera size={14} />{uploading ? 'Uploading…' : 'Add photos'}
          </Button>
          {/* capture="environment" opens the rear camera on mobile field use */}
          <input ref={fileRef} type="file" accept="image/*" capture="environment" multiple className="hidden"
            onChange={e => handlePhotos(e.target.files)} />
        </div>
        {co.photos.length === 0 ? (
          <p className="text-xs text-ink-faint">No photos. Attach reference shots for the change order request.</p>
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {co.photos.map(p => (
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
