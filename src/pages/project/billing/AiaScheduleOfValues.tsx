// src/pages/project/billing/AiaScheduleOfValues.tsx
import React, { useEffect, useState } from 'react';
import { Plus, Trash2, Check, X, Pencil } from 'lucide-react';
import {
  AiaSovLine, getSov, createSovLine, saveSovLine, deleteSovLine,
  seedSov, syncChangeOrders, getProject, computeSovSeedFromEstimate,
} from '../../../utils/store';
import { formatMoney, dollarsToCents, centsToDollars } from '../../../utils/money';
import { useToast } from '../../../components/Toast';
import { useConfirm } from '../../../components/ConfirmDialog';
import {
  Button, Card, CardBody, CardHeader, EmptyState, Field, Input, Skeleton,
  Table, TBody, TD, TH, THead, TR,
} from '../../../components/ui';

const isCo = (l: AiaSovLine) => !!l.isChangeOrder;

export const AiaScheduleOfValues: React.FC<{ projectId: string }> = ({ projectId }) => {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [lines, setLines] = useState<AiaSovLine[] | null>(null);
  const [busy, setBusy] = useState(false);

  // inline edit state
  const [editId, setEditId] = useState<string | null>(null);
  const [eItemNo, setEItemNo] = useState('');
  const [eDesc, setEDesc] = useState('');
  const [eValue, setEValue] = useState('');
  const [eRetainage, setERetainage] = useState('');

  // add form
  const [nItemNo, setNItemNo] = useState('');
  const [nDesc, setNDesc] = useState('');
  const [nValue, setNValue] = useState('');
  const [nRetainage, setNRetainage] = useState('');

  const reload = () => {
    getSov(projectId).then(setLines).catch(() => setLines([]));
  };
  useEffect(reload, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const seedFromEstimate = async () => {
    if (!projectId) return;
    setBusy(true);
    try {
      const project = await getProject(projectId);
      if (!project) { toast('Project not found', { type: 'error' }); return; }
      const seed = computeSovSeedFromEstimate(project);
      if (seed.length === 0) { toast('No estimate totals to seed from', { type: 'warning' }); return; }
      const hasOriginal = (lines ?? []).some(l => !isCo(l));
      if (hasOriginal) {
        const ok = await confirm({
          title: 'Replace schedule of values?',
          message: 'Replace the existing schedule of values from the estimate? Change-order lines are preserved.',
          confirmLabel: 'Replace',
        });
        if (!ok) return;
      }
      const { count } = await seedSov(projectId, seed);
      reload();
      toast(`Seeded ${count} line${count === 1 ? '' : 's'} from estimate`, { type: 'success' });
    } catch {
      toast('Failed to seed from estimate', { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const syncCos = async () => {
    if (!projectId) return;
    setBusy(true);
    try {
      const { added } = await syncChangeOrders(projectId);
      reload();
      toast(added > 0 ? `Added ${added} change-order line${added === 1 ? '' : 's'}` : 'No new change orders to sync', { type: 'success' });
    } catch {
      toast('Failed to sync change orders', { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (l: AiaSovLine) => {
    setEditId(l.id);
    setEItemNo(l.itemNo ?? '');
    setEDesc(l.description);
    setEValue(String(centsToDollars(l.scheduledValueCents)));
    setERetainage(l.retainagePercent != null ? String(l.retainagePercent) : '');
  };
  const cancelEdit = () => setEditId(null);

  const saveEdit = async (l: AiaSovLine) => {
    if (!eDesc.trim()) { toast('Description is required', { type: 'warning' }); return; }
    const retNum = eRetainage.trim() === '' ? null : parseFloat(eRetainage);
    try {
      await saveSovLine(l.id, {
        ...l,
        itemNo: eItemNo.trim() || null,
        description: eDesc.trim(),
        scheduledValueCents: dollarsToCents(eValue),
        retainagePercent: retNum != null && Number.isFinite(retNum) ? retNum : null,
      });
      setEditId(null);
      reload();
      toast('Line saved', { type: 'success' });
    } catch (e) {
      toast(e instanceof Error && e.name === 'ConflictError'
        ? 'Line changed elsewhere — reload'
        : 'Save failed', { type: 'error' });
    }
  };

  const removeLine = async (l: AiaSovLine) => {
    const ok = await confirm({
      title: 'Delete line?',
      message: 'This permanently removes the schedule-of-values line.',
      tone: 'danger', confirmLabel: 'Delete',
    });
    if (!ok) return;
    try { await deleteSovLine(l.id); reload(); }
    catch { toast('Delete failed', { type: 'error' }); }
  };

  const addLine = async () => {
    if (!projectId) return;
    if (!nDesc.trim()) { toast('Enter a description', { type: 'warning' }); return; }
    const retNum = nRetainage.trim() === '' ? null : parseFloat(nRetainage);
    try {
      await createSovLine(projectId, {
        itemNo: nItemNo.trim() || null,
        description: nDesc.trim(),
        scheduledValueCents: dollarsToCents(nValue),
        retainagePercent: retNum != null && Number.isFinite(retNum) ? retNum : null,
      });
      setNItemNo(''); setNDesc(''); setNValue(''); setNRetainage('');
      reload();
    } catch { toast('Failed to add line', { type: 'error' }); }
  };

  const totalCents = (lines ?? []).reduce((a, l) => a + l.scheduledValueCents, 0);
  const originalCents = (lines ?? []).filter(l => !isCo(l)).reduce((a, l) => a + l.scheduledValueCents, 0);
  const coCents = (lines ?? []).filter(isCo).reduce((a, l) => a + l.scheduledValueCents, 0);

  return (
    <Card className="mb-5">
      <CardHeader title="Schedule of values"
        actions={
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={seedFromEstimate} disabled={busy}>Seed from estimate</Button>
            <Button size="sm" variant="secondary" onClick={syncCos} disabled={busy}>Sync approved change orders</Button>
          </div>
        } />
      <CardBody className="p-0">
        {lines === null ? (
          <div className="space-y-2 p-4">{[0, 1, 2].map(i => <Skeleton key={i} className="h-9" />)}</div>
        ) : lines.length === 0 ? (
          <EmptyState title="No schedule of values yet"
            description="Seed from the estimate or add lines manually to build the G703." />
        ) : (
          <Table>
            <THead><TR><TH>Item no.</TH><TH>Description</TH><TH>Scheduled value</TH><TH>Retainage %</TH><TH></TH></TR></THead>
            <TBody>
              {lines.map(l => editId === l.id ? (
                <TR key={l.id}>
                  <TD className="w-24"><Input value={eItemNo} onChange={e => setEItemNo(e.target.value)} /></TD>
                  <TD><Input value={eDesc} onChange={e => setEDesc(e.target.value)} /></TD>
                  <TD className="w-32"><Input type="number" value={eValue} onChange={e => setEValue(e.target.value)} placeholder="0.00" /></TD>
                  <TD className="w-24"><Input type="number" value={eRetainage} onChange={e => setERetainage(e.target.value)} placeholder="default" /></TD>
                  <TD>
                    <div className="flex items-center gap-1">
                      <button onClick={() => saveEdit(l)} title="Save" className="rounded-md p-1 text-green-600 hover:bg-hover"><Check size={15} /></button>
                      <button onClick={cancelEdit} title="Cancel" className="rounded-md p-1 text-ink-faint hover:bg-hover"><X size={15} /></button>
                    </div>
                  </TD>
                </TR>
              ) : (
                <TR key={l.id}>
                  <TD className="text-ink-soft">{l.itemNo || '—'}</TD>
                  <TD className="font-medium text-ink">
                    {l.description}
                    {isCo(l) && <span className="ml-2 rounded bg-hover px-1.5 py-0.5 text-xs font-normal text-ink-faint">CO</span>}
                  </TD>
                  <TD className="text-ink-soft">{formatMoney(l.scheduledValueCents)}</TD>
                  <TD className="text-ink-soft">{l.retainagePercent != null ? `${l.retainagePercent}%` : '—'}</TD>
                  <TD>
                    <div className="flex items-center gap-1">
                      <button onClick={() => startEdit(l)} title="Edit" className="rounded-md p-1 text-ink-faint hover:bg-hover hover:text-ink"><Pencil size={14} /></button>
                      <button onClick={() => removeLine(l)} title="Delete" className="rounded-md p-1 text-ink-faint hover:bg-hover hover:text-red-600"><Trash2 size={14} /></button>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}

        {/* Add line */}
        <div className="flex flex-wrap items-end gap-2 border-t border-edge p-4">
          <Field label="Item no." htmlFor="sov-item"><Input id="sov-item" value={nItemNo} onChange={e => setNItemNo(e.target.value)} className="w-24" /></Field>
          <Field label="Description" htmlFor="sov-desc"><Input id="sov-desc" value={nDesc} onChange={e => setNDesc(e.target.value)} className="w-56" /></Field>
          <Field label="Scheduled value" htmlFor="sov-value"><Input id="sov-value" type="number" value={nValue} onChange={e => setNValue(e.target.value)} className="w-32" placeholder="0.00" /></Field>
          <Field label="Retainage %" htmlFor="sov-ret"><Input id="sov-ret" type="number" value={nRetainage} onChange={e => setNRetainage(e.target.value)} className="w-28" placeholder="default" /></Field>
          <Button variant="secondary" onClick={addLine}><Plus size={14} />Add line</Button>
        </div>

        {/* Totals */}
        {lines && lines.length > 0 && (
          <div className="flex flex-wrap justify-end gap-6 border-t border-edge p-4 text-sm">
            <div className="text-ink-soft">Original <span className="ml-2 font-semibold text-ink">{formatMoney(originalCents)}</span></div>
            <div className="text-ink-soft">Change orders <span className="ml-2 font-semibold text-ink">{formatMoney(coCents)}</span></div>
            <div className="text-ink-soft">Total scheduled value <span className="ml-2 font-semibold text-ink">{formatMoney(totalCents)}</span></div>
          </div>
        )}

        {/* <AiaPayApplications projectId={projectId}/> added in Task 7 */}
      </CardBody>
    </Card>
  );
};
