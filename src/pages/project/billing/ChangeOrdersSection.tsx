// src/pages/project/billing/ChangeOrdersSection.tsx
import React, { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  ChangeOrder,
  getChangeOrders, createChangeOrder, setChangeOrderStatus, deleteChangeOrder,
} from '../../../utils/store';
import { formatMoney } from '../../../utils/money';
import { useToast } from '../../../components/Toast';
import {
  Button, Card, CardBody, CardHeader, Field, Input, Skeleton,
  Table, TBody, TD, TH, THead, TR,
} from '../../../components/ui';
import { ChangeOrderStatusPill } from '../../../components/ui/BillingPills';

export const ChangeOrdersSection: React.FC<{ projectId: string; onChange?: () => void }> = ({ projectId, onChange }) => {
  const { toast } = useToast();
  const [changeOrders, setChangeOrders] = useState<ChangeOrder[] | null>(null);
  const [coNumber, setCoNumber] = useState('');
  const [coDesc, setCoDesc] = useState('');
  const [coAmount, setCoAmount] = useState('');

  const load = () => {
    if (!projectId) return;
    getChangeOrders(projectId).then(setChangeOrders).catch(() => setChangeOrders([]));
  };
  useEffect(load, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const addChangeOrder = async () => {
    if (!projectId) return;
    const amount = parseFloat(coAmount);
    if (!Number.isFinite(amount)) { toast('Enter an amount', { type: 'warning' }); return; }
    try {
      await createChangeOrder(projectId, { number: coNumber || undefined, description: coDesc || undefined, amount });
      setCoNumber(''); setCoDesc(''); setCoAmount(''); load();
      onChange?.();
    } catch { toast('Failed to add change order', { type: 'error' }); }
  };
  const coStatus = async (id: string, status: string) => {
    try { await setChangeOrderStatus(id, status); load(); onChange?.(); } catch { toast('Update failed', { type: 'error' }); }
  };
  const removeCo = async (id: string) => {
    try { await deleteChangeOrder(id); load(); onChange?.(); } catch { toast('Delete failed', { type: 'error' }); }
  };

  return (
    <Card className="mb-5">
      <CardHeader title="Change Orders" />
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
                      {co.status !== 'approved' && <button onClick={() => coStatus(co.id, 'approved')} className="rounded px-3 py-1.5 min-h-[36px] text-xs text-green-700 hover:bg-green-50 dark:hover:bg-green-900/20">Approve</button>}
                      {co.status !== 'rejected' && <button onClick={() => coStatus(co.id, 'rejected')} className="rounded px-3 py-1.5 min-h-[36px] text-xs text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20">Reject</button>}
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
  );
};
