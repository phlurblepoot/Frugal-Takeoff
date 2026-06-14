// src/pages/project/billing/InvoicesSection.tsx
import React, { useEffect, useState } from 'react';
import { FileText, Plus, Trash2 } from 'lucide-react';
import {
  Invoice, InvoiceListItem,
  getInvoices, getInvoice, createInvoice, deleteInvoice, setInvoiceStatus,
} from '../../../utils/store';
import { formatMoney } from '../../../utils/money';
import { useToast } from '../../../components/Toast';
import { useConfirm } from '../../../components/ConfirmDialog';
import {
  Button, Card, CardBody, CardHeader, EmptyState, Skeleton,
  Table, TBody, TD, TH, THead, TR,
} from '../../../components/ui';
import { InvoiceStatusPill } from '../../../components/ui/BillingPills';
import { InvoiceEditor } from './InvoiceEditor';
import { useProjectOutlet } from '../ProjectLayout';

export const InvoicesSection: React.FC<{ projectId: string; onChange?: () => void }> = ({ projectId, onChange }) => {
  const { toast } = useToast();
  const confirm = useConfirm();
  const { summary: projectSummary } = useProjectOutlet();
  const [invoices, setInvoices] = useState<InvoiceListItem[] | null>(null);
  const [editing, setEditing] = useState<Invoice | null>(null);

  const reload = () => {
    if (!projectId) return;
    getInvoices(projectId).then(setInvoices).catch(() => setInvoices([]));
  };
  useEffect(reload, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const openInvoice = async (id: string) => {
    try { setEditing(await getInvoice(id)); } catch { toast('Failed to open invoice', { type: 'error' }); }
  };
  const newInvoice = async () => {
    if (!projectId) return;
    try {
      const r = await createInvoice(projectId, { number: '', lines: [] });
      const inv = await getInvoice(r.id);
      setEditing(inv);
      reload();
      onChange?.();
    } catch { toast('Failed to create invoice', { type: 'error' }); }
  };
  const removeInvoice = async (id: string) => {
    if (!(await confirm({ title: 'Delete invoice?', message: 'This permanently removes the invoice and its payments.', tone: 'danger', confirmLabel: 'Delete' }))) return;
    try { await deleteInvoice(id); reload(); onChange?.(); } catch { toast('Delete failed', { type: 'error' }); }
  };
  const cycleStatus = async (inv: InvoiceListItem) => {
    const next = inv.status === 'draft' ? 'sent' : inv.status === 'sent' ? 'paid' : 'draft';
    try { await setInvoiceStatus(inv.id, next); reload(); onChange?.(); } catch { toast('Status update failed', { type: 'error' }); }
  };

  return (
    <>
      <Card className="mb-5">
        <CardHeader title="Invoices" actions={<Button size="sm" onClick={newInvoice}><Plus size={14} />New invoice</Button>} />
        <CardBody className="p-0">
          {invoices === null ? (
            <div className="space-y-2 p-4">{[0, 1].map(i => <Skeleton key={i} className="h-9" />)}</div>
          ) : invoices.length === 0 ? (
            <EmptyState icon={<FileText size={20} />} title="No invoices yet" description="Create an invoice to bill against this project." />
          ) : (
            <Table>
              <THead><TR><TH>Number</TH><TH>Status</TH><TH>Total</TH><TH>Balance</TH><TH></TH></TR></THead>
              <TBody>
                {invoices.map(inv => (
                  <TR key={inv.id} interactive onClick={() => openInvoice(inv.id)}>
                    <TD className="font-medium text-ink">{inv.number || '(untitled)'}</TD>
                    <TD title="Click to advance status" onClick={e => { e.stopPropagation(); cycleStatus(inv); }}><InvoiceStatusPill status={inv.status} /></TD>
                    <TD className="text-ink-soft">{formatMoney(inv.totalCents)}</TD>
                    <TD className="text-ink-soft">{formatMoney(inv.balanceCents)}</TD>
                    <TD onClick={e => e.stopPropagation()}><button onClick={() => removeInvoice(inv.id)} title="Delete" className="rounded-md p-1.5 text-ink-faint hover:bg-hover hover:text-red-600"><Trash2 size={14} /></button></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>

      {editing && (
        <InvoiceEditor
          key={`${editing.id}:${editing.version}`}
          invoice={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            // reload the open invoice (payments/lines) and the lists
            try { setEditing(await getInvoice(editing.id)); } catch { setEditing(null); }
            reload();
            onChange?.();
          }}
          projectName={projectSummary?.name ?? ''}
          contractor={projectSummary?.contractor}
          address={projectSummary?.address}
          projectId={projectId ?? ''}
        />
      )}
    </>
  );
};
