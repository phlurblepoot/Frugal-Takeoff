// src/pages/project/billing/PaymentsSection.tsx
import React, { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import {
  Payment, InvoiceListItem, AiaPayApp,
  getProjectPayments, getInvoices, getPayApps, recordPayment, deletePayment,
} from '../../../utils/store';
import { formatMoney } from '../../../utils/money';
import { useToast } from '../../../components/Toast';
import { useConfirm } from '../../../components/ConfirmDialog';
import {
  Button, Card, CardBody, CardHeader, EmptyState, Field, Input, Select, Skeleton,
  Table, TBody, TD, TH, THead, TR,
} from '../../../components/ui';

export const PaymentsSection: React.FC<{ projectId: string; onChange?: () => void }> = ({ projectId, onChange }) => {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [payments, setPayments] = useState<Payment[] | null>(null);
  const [invoices, setInvoices] = useState<InvoiceListItem[]>([]);
  const [payApps, setPayApps] = useState<AiaPayApp[]>([]);
  const [target, setTarget] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  const [method, setMethod] = useState('check');
  const [note, setNote] = useState('');

  const reload = () => {
    if (!projectId) return;
    getProjectPayments(projectId).then(setPayments).catch(() => setPayments([]));
    getInvoices(projectId).then(setInvoices).catch(() => setInvoices([]));
    getPayApps(projectId).then(setPayApps).catch(() => setPayApps([]));
  };
  useEffect(reload, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const amountNum = parseFloat(amount);
  const canRecord = !!target && Number.isFinite(amountNum) && amountNum > 0;

  const record = async () => {
    if (!canRecord) return;
    const sep = target.indexOf(':');
    const targetType = target.slice(0, sep) as 'invoice' | 'payapp';
    const targetId = target.slice(sep + 1);
    try {
      await recordPayment(projectId, targetType, targetId, {
        amount: amountNum,
        date: date ? new Date(date).getTime() : undefined,
        method,
        note: note || undefined,
      });
      toast('Payment recorded', { type: 'success' });
      setTarget(''); setAmount(''); setDate(''); setMethod('check'); setNote('');
      reload();
      onChange?.();
    } catch { toast('Failed to record payment', { type: 'error' }); }
  };

  const remove = async (id: string) => {
    if (!(await confirm({ title: 'Delete payment?', message: 'This permanently removes the payment.', tone: 'danger', confirmLabel: 'Delete' }))) return;
    try {
      await deletePayment(id);
      reload();
      onChange?.();
    } catch { toast('Delete failed', { type: 'error' }); }
  };

  const total = (payments ?? []).reduce((a, p) => a + Math.round(p.amount * 100), 0);

  return (
    <Card className="mb-5">
      <CardHeader title="Payments" />
      <CardBody>
        <div className="mb-4 flex flex-wrap items-end gap-2">
          <Field label="Applied to" htmlFor="pay-target">
            <Select id="pay-target" value={target} onChange={e => setTarget(e.target.value)} className="w-56">
              <option value="">Select target…</option>
              {invoices.length > 0 && (
                <optgroup label="Invoices">
                  {invoices.map(inv => (
                    <option key={inv.id} value={`invoice:${inv.id}`}>Invoice {inv.number || inv.id}</option>
                  ))}
                </optgroup>
              )}
              {payApps.length > 0 && (
                <optgroup label="Pay applications">
                  {payApps.map(pa => (
                    <option key={pa.id} value={`payapp:${pa.id}`}>Application #{pa.number}</option>
                  ))}
                </optgroup>
              )}
            </Select>
          </Field>
          <Field label="Amount" htmlFor="pay-amt"><Input id="pay-amt" type="number" value={amount} onChange={e => setAmount(e.target.value)} className="w-28" placeholder="0.00" /></Field>
          <Field label="Date" htmlFor="pay-date"><Input id="pay-date" type="date" value={date} onChange={e => setDate(e.target.value)} className="w-40" /></Field>
          <Field label="Method" htmlFor="pay-method">
            <Select id="pay-method" value={method} onChange={e => setMethod(e.target.value)}>
              <option value="check">Check</option><option value="card">Card</option><option value="cash">Cash</option><option value="ach">ACH</option><option value="other">Other</option>
            </Select>
          </Field>
          <Field label="Note" htmlFor="pay-note"><Input id="pay-note" value={note} onChange={e => setNote(e.target.value)} className="w-48" placeholder="Optional" /></Field>
          <Button onClick={record} disabled={!canRecord}>Record</Button>
        </div>

        {payments === null ? (
          <Skeleton className="h-9" />
        ) : payments.length === 0 ? (
          <EmptyState title="No payments yet" description="Record a payment against an invoice or pay application." />
        ) : (
          <Table>
            <THead><TR><TH>Date</TH><TH>Applied to</TH><TH>Method</TH><TH>Amount</TH><TH></TH></TR></THead>
            <TBody>
              {payments.map(p => (
                <TR key={p.id}>
                  <TD className="text-ink-soft">{p.date ? new Date(p.date).toLocaleDateString() : '—'}</TD>
                  <TD className="font-medium text-ink">{p.targetLabel || `${p.targetType} ${p.targetId}`}</TD>
                  <TD className="text-ink-soft">{p.method || '—'}</TD>
                  <TD className="text-ink-soft">{formatMoney(Math.round(p.amount * 100))}</TD>
                  <TD><button onClick={() => remove(p.id)} title="Delete" className="rounded-md p-1.5 text-ink-faint hover:bg-hover hover:text-red-600"><Trash2 size={14} /></button></TD>
                </TR>
              ))}
              <TR>
                <TD className="font-semibold text-ink" colSpan={3}>Total</TD>
                <TD className="font-semibold text-ink">{formatMoney(total)}</TD>
                <TD></TD>
              </TR>
            </TBody>
          </Table>
        )}
      </CardBody>
    </Card>
  );
};
