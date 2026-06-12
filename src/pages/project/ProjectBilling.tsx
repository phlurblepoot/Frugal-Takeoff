// src/pages/project/ProjectBilling.tsx
import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { DollarSign, FileText, Plus, Trash2, ShieldAlert } from 'lucide-react';
import {
  BillingSummary, ChangeOrder, Invoice, InvoiceListItem,
  getBillingSummary, getInvoices, getInvoice, createInvoice, deleteInvoice, setInvoiceStatus,
  getChangeOrders, createChangeOrder, setChangeOrderStatus, deleteChangeOrder,
} from '../../utils/store';
import { formatMoney } from '../../utils/money';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';
import {
  Button, Card, CardBody, CardHeader, EmptyState, Field, Input, Skeleton,
  Table, TBody, TD, TH, THead, TR,
} from '../../components/ui';
import { InvoiceStatusPill, ChangeOrderStatusPill } from '../../components/ui/BillingPills';
import { InvoiceEditor } from './billing/InvoiceEditor';

export { lineCents, draftTotalCents } from './billing/InvoiceEditor';

const isAdmin = () => (JSON.parse(localStorage.getItem('user') || '{}').role) === 'admin';

export const ProjectBilling: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [invoices, setInvoices] = useState<InvoiceListItem[] | null>(null);
  const [changeOrders, setChangeOrders] = useState<ChangeOrder[] | null>(null);
  const [editing, setEditing] = useState<Invoice | null>(null);
  const [coNumber, setCoNumber] = useState('');
  const [coDesc, setCoDesc] = useState('');
  const [coAmount, setCoAmount] = useState('');

  const admin = isAdmin();

  const load = () => {
    if (!projectId || !admin) return;
    getBillingSummary(projectId).then(setSummary).catch(() => setSummary(null));
    getInvoices(projectId).then(setInvoices).catch(() => setInvoices([]));
    getChangeOrders(projectId).then(setChangeOrders).catch(() => setChangeOrders([]));
  };
  useEffect(load, [projectId, admin]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!admin) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-12 md:px-8">
        <EmptyState icon={<ShieldAlert size={22} />} title="Billing is admin-only"
          description="Ask an administrator for access to invoices and change orders." />
      </div>
    );
  }

  const openInvoice = async (id: string) => {
    try { setEditing(await getInvoice(id)); } catch { toast('Failed to open invoice', { type: 'error' }); }
  };
  const newInvoice = async () => {
    if (!projectId) return;
    try {
      const r = await createInvoice(projectId, { number: '', lines: [] });
      const inv = await getInvoice(r.id);
      setEditing(inv);
      load();
    } catch { toast('Failed to create invoice', { type: 'error' }); }
  };
  const removeInvoice = async (id: string) => {
    if (!(await confirm({ title: 'Delete invoice?', message: 'This permanently removes the invoice and its payments.', tone: 'danger', confirmLabel: 'Delete' }))) return;
    try { await deleteInvoice(id); load(); } catch { toast('Delete failed', { type: 'error' }); }
  };
  const cycleStatus = async (inv: InvoiceListItem) => {
    const next = inv.status === 'draft' ? 'sent' : inv.status === 'sent' ? 'paid' : 'draft';
    try { await setInvoiceStatus(inv.id, next); load(); } catch { toast('Status update failed', { type: 'error' }); }
  };
  const addChangeOrder = async () => {
    if (!projectId) return;
    const amount = parseFloat(coAmount);
    if (!Number.isFinite(amount)) { toast('Enter an amount', { type: 'warning' }); return; }
    try {
      await createChangeOrder(projectId, { number: coNumber || undefined, description: coDesc || undefined, amount });
      setCoNumber(''); setCoDesc(''); setCoAmount(''); load();
    } catch { toast('Failed to add change order', { type: 'error' }); }
  };
  const coStatus = async (id: string, status: string) => {
    try { await setChangeOrderStatus(id, status); load(); } catch { toast('Update failed', { type: 'error' }); }
  };
  const removeCo = async (id: string) => {
    try { await deleteChangeOrder(id); load(); } catch { toast('Delete failed', { type: 'error' }); }
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8">
      <h1 className="mb-4 text-xl font-bold text-ink">Billing</h1>

      {/* Contract rollup */}
      <Card className="mb-5">
        <CardHeader title="Contract" actions={<DollarSign size={15} className="text-ink-faint" />} />
        <CardBody>
          {summary === null ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
              {[
                ['Contract value', summary.contractValueCents],
                ['Invoiced', summary.invoicedCents],
                ['Paid', summary.paidCents],
                ['Outstanding', summary.outstandingCents],
              ].map(([label, cents]) => (
                <div key={label as string}>
                  <div className="text-ink-faint">{label}</div>
                  <div className="text-lg font-bold text-ink">{formatMoney(cents as number)}</div>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Invoices */}
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

      {/* Change orders */}
      <Card>
        <CardHeader title="Change orders" />
        <CardBody>
          <div className="mb-3 flex flex-wrap items-end gap-2">
            <Field label="Number" htmlFor="co-num"><Input id="co-num" value={coNumber} onChange={e => setCoNumber(e.target.value)} className="w-28" /></Field>
            <Field label="Description" htmlFor="co-desc"><Input id="co-desc" value={coDesc} onChange={e => setCoDesc(e.target.value)} className="w-56" /></Field>
            <Field label="Amount" htmlFor="co-amt"><Input id="co-amt" type="number" value={coAmount} onChange={e => setCoAmount(e.target.value)} className="w-28" placeholder="0.00" /></Field>
            <Button variant="secondary" onClick={addChangeOrder}><Plus size={14} />Add</Button>
          </div>
          {changeOrders === null ? (
            <Skeleton className="h-9" />
          ) : changeOrders.length === 0 ? (
            <p className="text-sm text-ink-faint">No change orders. Approved change orders increase the contract value.</p>
          ) : (
            <Table>
              <THead><TR><TH>Number</TH><TH>Description</TH><TH>Amount</TH><TH>Status</TH><TH></TH></TR></THead>
              <TBody>
                {changeOrders.map(co => (
                  <TR key={co.id}>
                    <TD className="font-medium text-ink">{co.number || '—'}</TD>
                    <TD className="text-ink-soft">{co.description || '—'}</TD>
                    <TD className="text-ink-soft">{formatMoney(Math.round(co.amount * 100))}</TD>
                    <TD><ChangeOrderStatusPill status={co.status} /></TD>
                    <TD>
                      <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                        {co.status !== 'approved' && <button onClick={() => coStatus(co.id, 'approved')} className="rounded px-2 py-0.5 text-xs text-green-700 hover:bg-green-50 dark:hover:bg-green-900/20">Approve</button>}
                        {co.status !== 'rejected' && <button onClick={() => coStatus(co.id, 'rejected')} className="rounded px-2 py-0.5 text-xs text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20">Reject</button>}
                        <button onClick={() => removeCo(co.id)} title="Delete" className="rounded p-1 text-ink-faint hover:text-red-600"><Trash2 size={13} /></button>
                      </div>
                    </TD>
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
            load();
          }}
        />
      )}
    </div>
  );
};
