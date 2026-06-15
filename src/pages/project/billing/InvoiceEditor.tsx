// src/pages/project/billing/InvoiceEditor.tsx
import React, { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Invoice, InvoiceLine, saveInvoice, getSettings, sendInvoice, uploadProjectFile } from '../../../utils/store';
import { formatMoney } from '../../../utils/money';
import { useToast } from '../../../components/Toast';
import { Button, Field, Input, Modal, Table, TBody, TD, TH, THead, TR } from '../../../components/ui';
import { EmailComposer } from '../../../components/EmailComposer';
import { buildInvoicePdf, resolveAccentRgb } from './invoicePdf';

export const lineCents = (l: { description?: string; qty: number; unitPrice: number }): number =>
  Math.round((Number(l.qty) || 0) * (Number(l.unitPrice) || 0) * 100);
export const draftTotalCents = (lines: { description?: string; qty: number; unitPrice: number }[]): number =>
  lines.reduce((a, l) => a + lineCents(l), 0);

export const InvoiceEditor: React.FC<{
  invoice: Invoice;
  onClose: () => void;
  onSaved: () => void;
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
  const [composing, setComposing] = useState(false);

  const total = draftTotalCents(lines);
  const paid = invoice.paidCents;
  const balance = total - paid;

  const setLine = (i: number, patch: Partial<InvoiceLine>) =>
    setLines(prev => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const addLine = () => setLines(prev => [...prev, { description: '', qty: 1, unitPrice: 0 }]);
  const removeLine = (i: number) => setLines(prev => prev.filter((_, idx) => idx !== i));

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveInvoice(invoice.id, {
        ...invoice,
        number: number || null,
        terms: terms || null,
        date: date ? new Date(date).getTime() : null,
        lines: lines.map(l => ({ description: l.description, qty: Number(l.qty) || 0, unitPrice: Number(l.unitPrice) || 0 })),
      });
      toast('Invoice saved', { type: 'success' });
      onSaved();
    } catch (e) {
      toast(e instanceof Error && e.name === 'ConflictError' ? 'Invoice changed elsewhere — reopen it' : 'Save failed', { type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const buildBytes = async (): Promise<Uint8Array> => {
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
    return buildInvoicePdf({
      invoice,
      projectName,
      contractor,
      address,
      company: {
        name: settings.appName || 'Invoice',
        address: settings.companyAddress,
        phone: settings.companyPhone,
        email: settings.companyEmail,
        logoDataUrl,
      },
      accentRgb: resolveAccentRgb(),
    });
  };

  const handleDownloadPdf = async () => {
    try {
      const bytes = await buildBytes();
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `invoice-${invoice.number ?? invoice.id}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { toast('PDF generation failed', { type: 'error' }); }
  };

  return (
    <Modal open onClose={onClose} title={`Invoice ${invoice.number ?? ''}`} width="lg"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        <Button variant="secondary" onClick={handleDownloadPdf}>Download PDF</Button>
        <Button onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save invoice'}</Button>
      </>}
    >
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

      <div className="mt-4 border-t border-edge pt-3">
        <h4 className="mb-2 text-sm font-semibold text-ink">Send invoice</h4>
        <Button onClick={() => setComposing(true)}>Send invoice</Button>
      </div>

      <p className="mt-4 border-t border-edge pt-3 text-sm text-ink-faint">
        Record payments in the Payments section below.
      </p>

      <EmailComposer
        open={composing}
        onClose={() => setComposing(false)}
        projectId={projectId}
        title="Send invoice"
        primaryAttachmentName={`${invoice.number || 'invoice'}.pdf`}
        defaultSubject={`Invoice ${invoice.number} — ${projectName}`}
        defaultBody={`Hello,\n\nPlease find attached Invoice ${invoice.number} for ${projectName}.\n\nThank you.`}
        onSend={async (m) => {
          const bytes = await buildBytes();
          const file = new File([bytes], `${invoice.number || 'invoice'}.pdf`, { type: 'application/pdf' });
          // The PDF is uploaded as a project document before sending; if the send
          // fails the file remains in Documents (project-attributed), and a retry
          // uploads another — acceptable for v1.
          const fileId = await uploadProjectFile(projectId, file, 'invoice');
          await sendInvoice(invoice.id, { to: m.to, cc: m.cc, bcc: m.bcc, subject: m.subject, body: m.body, fileId, attachmentFileIds: m.attachmentFileIds });
          toast('Invoice sent', { type: 'success' });
          onSaved();
        }}
      />
    </Modal>
  );
};
