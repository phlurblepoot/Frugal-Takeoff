// src/pages/project/billing/InvoiceEditor.tsx
import React, { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Invoice, InvoiceLine, saveInvoice, getInvoice, getSettings, getMailAccounts, pickSendableAccount, mailSendBlockedReason, getAlwaysCc, getCustomer, getProject, sendInvoice } from '../../../utils/store';
import { Customer } from '../../../types';
import { resolveRecipient } from '../../../utils/recipients';
import { formatMoney } from '../../../utils/money';
import { useToast } from '../../../components/Toast';
import { Button, Field, Input, Modal, Table, TBody, TD, TH, THead, TR } from '../../../components/ui';
import { DocumentActionsBar } from '../../../components/documents/DocumentActionsBar';
import { useCollabEditing } from '../../../hooks/useCollabEditing';
import { EditPresenceBanner } from '../../../components/EditPresenceBanner';
import { buildInvoicePdf } from './invoicePdf';
import { hexToRgb, invertImageDataUrl } from '../../../utils/documentLetterhead';

export const lineCents = (l: { description?: string; qty: number; unitPrice: number }): number =>
  Math.round((Number(l.qty) || 0) * (Number(l.unitPrice) || 0) * 100);
export const draftTotalCents = (lines: { description?: string; qty: number; unitPrice: number }[]): number =>
  lines.reduce((a, l) => a + lineCents(l), 0);

// Dirty-check key for invoice/change-order line items. Content only: the
// server re-INSERTs the rows on every save (billingStore's writeLines /
// writeChangeOrderLines), so a saved record comes back with brand-new line
// ids — comparing whole objects would leave the editor permanently "dirty"
// and the document bar permanently blocked on "Save first".
export const lineContentKey = (
  lines: { description?: string; qty: number | string; unitPrice: number | string }[],
): string =>
  JSON.stringify(lines.map(l => ({
    description: l.description ?? '',
    qty: Number(l.qty) || 0,
    unitPrice: Number(l.unitPrice) || 0,
  })));

export const InvoiceEditor: React.FC<{
  invoice: Invoice;
  onClose: () => void;
  /** keepMounted: refresh the record without re-keying this editor — the
   *  document bar's save-then-generate flow dies if the modal remounts
   *  underneath it. */
  onSaved: (opts?: { keepMounted?: boolean }) => void;
  projectName: string;
  contractor?: string | null;
  address?: string | null;
  projectId: string;
}> = ({ invoice, onClose, onSaved, projectName, contractor, address, projectId }) => {
  const { toast } = useToast();
  const [number, setNumber] = useState(invoice.number ?? '');
  const [terms, setTerms] = useState(invoice.terms ?? '');
  const [date, setDate] = useState(invoice.date ? new Date(invoice.date).toISOString().slice(0, 10) : '');
  const [lines, setLines] = useState<InvoiceLine[]>(invoice.lines.length ? invoice.lines : []);
  const [saving, setSaving] = useState(false);

  const initialDate = invoice.date ? new Date(invoice.date).toISOString().slice(0, 10) : '';
  const dirty =
    number !== (invoice.number ?? '') ||
    terms !== (invoice.terms ?? '') ||
    date !== initialDate ||
    lineContentKey(lines) !== lineContentKey(invoice.lines);

  const collab = useCollabEditing({
    type: 'invoice',
    id: invoice.id,
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
    /** Set once we know the user has no mail account to send from. */
    sendBlockedReason?: string;
  }>({ defaultTo: '', defaultCc: '', defaultBcc: '', companyEmail: '', headerEmailOptions: [] });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [settings, mailAccounts, alwaysCc, project] = await Promise.all([
          getSettings(),
          getMailAccounts().catch(() => []),
          getAlwaysCc(),
          getProject(projectId).catch(() => null),
        ]);
        if (cancelled) return;
        let customer: Customer | undefined;
        if (project?.customerId) {
          customer = await getCustomer(project.customerId).catch(() => undefined);
        }
        const resolved = resolveRecipient('invoice', project?.contactEmails, customer?.emails);
        const mergeCsv = (...lists: string[]) => Array.from(new Set(lists.flatMap(s => (s || '').split(',').map(x => x.trim()).filter(Boolean)))).join(', ');
        const companyEmail = settings.companyEmail ?? '';
        const fromAddress = pickSendableAccount(mailAccounts)?.emailAddress ?? '';
        const opts = [
          companyEmail ? { label: 'Company default', value: companyEmail } : null,
          fromAddress && fromAddress !== companyEmail ? { label: 'My email', value: fromAddress } : null,
        ].filter(Boolean) as { label: string; value: string }[];
        if (!cancelled) {
          setEmailDefaults({ defaultTo: resolved.to, defaultCc: mergeCsv(resolved.cc, alwaysCc), defaultBcc: resolved.bcc, companyEmail, headerEmailOptions: opts, sendBlockedReason: mailSendBlockedReason(mailAccounts) });
        }
      } catch { /* non-fatal */ }
    })();
    return () => { cancelled = true; };
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // One name for the stored document and the email attachment — they upsert
  // onto the same document row, so a differing name would flip the stored name
  // depending on which ran last. Keyed off the edited number rather than the
  // loaded one because the bar saves before it generates, so the draft number
  // is the one the document will carry. The id fallback keeps unnumbered
  // drafts from all landing on the same "invoice.pdf".
  const pdfFileName = `Invoice-${number || invoice.id}.pdf`;

  const total = draftTotalCents(lines);
  const paid = invoice.paidCents;
  const balance = total - paid;

  const setLine = (i: number, patch: Partial<InvoiceLine>) =>
    setLines(prev => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const addLine = () => setLines(prev => [...prev, { description: '', qty: 1, unitPrice: 0 }]);
  const removeLine = (i: number) => setLines(prev => prev.filter((_, idx) => idx !== i));

  const handleSave = async (opts?: { keepMounted?: boolean }) => {
    setSaving(true);
    try {
      await saveInvoice(invoice.id, {
        ...invoice,
        ...(collab.keepMineVersion !== null ? { version: collab.keepMineVersion } : {}),
        number: number || null,
        terms: terms || null,
        date: date ? new Date(date).getTime() : null,
        lines: lines.map(l => ({ description: l.description, qty: Number(l.qty) || 0, unitPrice: Number(l.unitPrice) || 0 })),
      });
      toast('Invoice saved', { type: 'success' });
      // A "Keep mine" save adopted a foreign version number; only a remount
      // clears it, otherwise the next save would post a stale version.
      onSaved({ keepMounted: opts?.keepMounted === true && collab.keepMineVersion === null });
    } catch (e) {
      toast(e instanceof Error && e.name === 'ConflictError' ? 'Invoice changed elsewhere — reopen it' : 'Save failed', { type: 'error' });
      throw e;
    } finally {
      setSaving(false);
    }
  };

  // The bar saves before it generates, so `false` here means "don't build".
  const saveForDocument = async (): Promise<boolean> => {
    try { await handleSave({ keepMounted: true }); return true; } catch { return false; }
  };

  // Built from the SAVED invoice, never the typed-in draft: the bar commits
  // first, so re-reading the record here is what keeps a generated PDF and the
  // invoice it claims to represent from drifting apart. A failed re-read
  // throws on purpose — the bar then reports the failure and keeps the
  // existing document, rather than quietly storing pre-save bytes and marking
  // them current.
  const buildBytes = async (headerEmail?: string): Promise<Uint8Array> => {
    const saved = await getInvoice(invoice.id);
    if (!saved) throw new Error('Invoice not found');
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
    return buildInvoicePdf({
      invoice: saved,
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
      headerEmail: headerEmail || undefined,
    });
  };

  return (
    <Modal open onClose={onClose} title={`Invoice ${invoice.number ?? ''}`} width="lg"
      footer={<>
        <div className="mr-auto">
          <DocumentActionsBar
            source={{ sourceType: 'invoice', sourceId: invoice.id }}
            kind="invoice"
            format="pdf"
            projectId={projectId}
            fileName={pdfFileName}
            build={async ({ headerEmail }) => new Blob([await buildBytes(headerEmail)], { type: 'application/pdf' })}
            dirty={dirty}
            save={saveForDocument}
            updatedAt={invoice.updatedAt}
            size="sm"
            send={{
              blockedReason: emailDefaults.sendBlockedReason,
              composer: {
                title: 'Send invoice',
                defaultTo: emailDefaults.defaultTo || undefined,
                defaultCc: emailDefaults.defaultCc || undefined,
                defaultBcc: emailDefaults.defaultBcc || undefined,
                defaultSubject: `Invoice ${number} — ${projectName}`,
                defaultBody: `Hello,\n\nPlease find attached Invoice ${number} for ${projectName}.\n\nThank you.`,
                headerEmailOptions: emailDefaults.headerEmailOptions.length ? emailDefaults.headerEmailOptions : undefined,
                defaultHeaderEmail: emailDefaults.companyEmail || undefined,
              },
              sendFn: async (fileId, m) => {
                await sendInvoice(invoice.id, {
                  to: m.to, cc: m.cc, bcc: m.bcc, subject: m.subject, body: m.body,
                  fileId, attachmentFileIds: m.attachmentFileIds,
                });
                // The send stamps the invoice 'sent' server-side.
                onSaved({ keepMounted: true });
              },
            }}
          />
        </div>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        <Button onClick={() => { void handleSave().catch(() => {}); }} disabled={saving}>{saving ? 'Saving…' : 'Save invoice'}</Button>
      </>}
    >
      <EditPresenceBanner state={collab} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Number" htmlFor="inv-num"><Input id="inv-num" value={number} onChange={e => setNumber(e.target.value)} /></Field>
        <Field label="Date" htmlFor="inv-date"><Input id="inv-date" type="date" value={date} onChange={e => setDate(e.target.value)} /></Field>
        <Field label="Terms" htmlFor="inv-terms"><Input id="inv-terms" value={terms} onChange={e => setTerms(e.target.value)} placeholder="Net 30" /></Field>
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

      <div className="mt-4 flex justify-end gap-6 border-t border-edge pt-3 text-sm">
        <div className="text-right">
          <div className="text-ink-soft">Total <span className="ml-2 font-semibold text-ink">{formatMoney(total)}</span></div>
          <div className="text-ink-soft">Paid <span className="ml-2 font-semibold text-ink">{formatMoney(paid)}</span></div>
          <div className="text-ink-soft">Balance <span className="ml-2 font-semibold text-ink">{formatMoney(balance)}</span></div>
        </div>
      </div>

      {/* Payments — read-only; recording/deleting happens in the project's
          Billing → Payments tab. */}
      <div className="mt-4 border-t border-edge pt-3">
        <h4 className="mb-2 text-sm font-semibold text-ink">Payments</h4>
        {invoice.payments.length === 0 ? (
          <p className="text-sm text-ink-faint">No payments recorded. Record payments in the Billing → Payments tab.</p>
        ) : (
          <Table>
            <THead><TR><TH>Date</TH><TH>Note</TH><TH className="text-right">Amount</TH></TR></THead>
            <TBody>
              {invoice.payments.map(p => (
                <TR key={p.id}>
                  <TD className="text-ink-soft">{p.date ? new Date(p.date).toLocaleDateString() : '—'}</TD>
                  <TD className="text-ink-faint">{p.note || '—'}</TD>
                  <TD className="text-right tabular-nums text-ink-soft">{formatMoney(Math.round((Number(p.amount) || 0) * 100))}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        <p className="mt-2 text-sm text-ink-soft">
          Paid <span className="font-semibold text-ink">{formatMoney(paid)}</span>
          {' · '}
          Balance <span className="font-semibold text-ink">{formatMoney(balance)}</span>
        </p>
        {invoice.payments.length > 0 && (
          <p className="mt-1 text-xs text-ink-faint">Record payments in the Billing → Payments tab.</p>
        )}
      </div>
    </Modal>
  );
};
