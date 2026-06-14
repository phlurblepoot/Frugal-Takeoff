// src/pages/project/billing/AiaPayAppEditor.tsx
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AiaPayApp, AiaPayAppLine, AiaG703Row, AiaG702,
  getPayApp, savePayAppLines, setPayApp,
} from '../../../utils/store';
import { formatMoney, dollarsToCents, centsToDollars } from '../../../utils/money';
import { useToast } from '../../../components/Toast';
import {
  Button, Field, Input, Modal, Select, StatusPill, Skeleton,
  Table, TBody, TD, TH, THead, TR,
} from '../../../components/ui';
import type { PillTone } from '../../../components/ui';

const STATUS_META: Record<string, { label: string; tone: PillTone }> = {
  draft:     { label: 'Draft',     tone: 'slate' },
  finalized: { label: 'Finalized', tone: 'emerald' },
};

const STATUS_OPTIONS = ['draft', 'finalized'];

// Local editable per-line state, keyed by sovLineId.
interface EditLine { percentComplete: string; storedMaterials: string }

export const AiaPayAppEditor: React.FC<{
  payAppId: string;
  onClose: () => void;
  onSaved: () => void;
}> = ({ payAppId, onClose, onSaved }) => {
  const { toast } = useToast();

  const [data, setData] = useState<{ app: AiaPayApp; lines: AiaPayAppLine[]; g703: AiaG703Row[]; g702: AiaG702 } | null>(null);
  const [saving, setSaving] = useState(false);

  // Editable per-line inputs, seeded once per load (re-seeded on reload).
  const [edits, setEdits] = useState<Record<string, EditLine>>({});

  // Editable app fields.
  const [periodTo, setPeriodTo] = useState('');
  const [applicationDate, setApplicationDate] = useState('');
  const [retainagePercent, setRetainagePercent] = useState('');
  const [storedRetainagePercent, setStoredRetainagePercent] = useState('');
  const [status, setStatus] = useState('draft');

  const seed = useCallback((d: { app: AiaPayApp; lines: AiaPayAppLine[]; g703: AiaG703Row[]; g702: AiaG702 }) => {
    const byLine: Record<string, AiaPayAppLine> = {};
    for (const l of d.lines) byLine[l.sovLineId] = l;
    const next: Record<string, EditLine> = {};
    for (const row of d.g703) {
      const line = byLine[row.sovLineId];
      next[row.sovLineId] = {
        percentComplete: line ? String(line.percentComplete) : String(row.percentComplete ?? 0),
        storedMaterials: line ? String(centsToDollars(line.storedMaterialsCents)) : String(centsToDollars(row.storedCents ?? 0)),
      };
    }
    setEdits(next);
    setPeriodTo(d.app.periodTo ?? '');
    setApplicationDate(d.app.applicationDate ?? '');
    setRetainagePercent(String(d.app.retainagePercent ?? 0));
    setStoredRetainagePercent(String(d.app.storedRetainagePercent ?? 0));
    setStatus(d.app.status ?? 'draft');
  }, []);

  const load = useCallback(() => {
    getPayApp(payAppId).then(d => { setData(d); seed(d); }).catch(() => toast('Failed to load pay application', { type: 'error' }));
  }, [payAppId, seed, toast]);

  useEffect(() => { load(); }, [load]);

  const isFinalized = (data?.app.status ?? status) === 'finalized';

  const setEdit = (sovLineId: string, patch: Partial<EditLine>) =>
    setEdits(prev => ({ ...prev, [sovLineId]: { ...prev[sovLineId], ...patch } }));

  const handleSave = async () => {
    if (!data) return;
    setSaving(true);
    try {
      // Persist app-level field changes first (date/retainage/status).
      const app = data.app;
      const patch: Record<string, unknown> = {};
      const retNum = parseFloat(retainagePercent);
      const storedRetNum = parseFloat(storedRetainagePercent);
      if ((periodTo || null) !== (app.periodTo ?? null)) patch.periodTo = periodTo || null;
      if ((applicationDate || null) !== (app.applicationDate ?? null)) patch.applicationDate = applicationDate || null;
      if (Number.isFinite(retNum) && retNum !== app.retainagePercent) patch.retainagePercent = retNum;
      if (Number.isFinite(storedRetNum) && storedRetNum !== app.storedRetainagePercent) patch.storedRetainagePercent = storedRetNum;
      if (status !== app.status) patch.status = status;
      if (Object.keys(patch).length > 0) {
        await setPayApp(payAppId, patch);
      }

      // Persist line edits (version-checked).
      const lines = data.g703.map(row => {
        const e = edits[row.sovLineId];
        const pct = e ? parseFloat(e.percentComplete) : row.percentComplete;
        return {
          sovLineId: row.sovLineId,
          percentComplete: Number.isFinite(pct) ? pct : 0,
          storedMaterialsCents: e ? dollarsToCents(e.storedMaterials) : row.storedCents,
        };
      });
      await savePayAppLines(payAppId, lines, app.version);

      toast('Pay application saved', { type: 'success' });
      load(); // refetch + re-seed so G702/G703 + version reflect saved state
      onSaved();
    } catch (e) {
      toast(e instanceof Error && e.name === 'ConflictError'
        ? 'Pay application changed elsewhere — reopen it'
        : 'Save failed', { type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const handleFinalize = async () => {
    if (!data) return;
    try {
      await setPayApp(payAppId, { status: 'finalized' });
      toast('Pay application finalized', { type: 'success' });
      load();
      onSaved();
    } catch {
      toast('Failed to finalize', { type: 'error' });
    }
  };

  // Task 8 implements the AIA Excel export.
  const handleExport = () => {
    // TODO(Task 8): exportAiaXlsx
    toast('AIA Excel export coming soon', { type: 'info' });
  };

  // Light client-side preview of Total to Date (G = scheduled*% /100 + stored).
  const previewG = useMemo(() => {
    const map: Record<string, number> = {};
    if (!data) return map;
    for (const row of data.g703) {
      const e = edits[row.sovLineId];
      const pct = e ? parseFloat(e.percentComplete) : row.percentComplete;
      const storedCents = e ? dollarsToCents(e.storedMaterials) : row.storedCents;
      const completed = Math.round(row.scheduledValueCents * (Number.isFinite(pct) ? pct : 0) / 100);
      map[row.sovLineId] = completed + storedCents;
    }
    return map;
  }, [data, edits]);

  const g702 = data?.g702;

  return (
    <Modal
      open
      onClose={onClose}
      title={data ? `Application for payment #${data.app.number}` : 'Application for payment'}
      width="lg"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        <Button variant="secondary" onClick={handleExport}>Export AIA Excel</Button>
        {!isFinalized && (
          <Button variant="secondary" onClick={handleFinalize} disabled={saving}>Finalize</Button>
        )}
        <Button onClick={handleSave} disabled={saving || isFinalized}>{saving ? 'Saving…' : 'Save'}</Button>
      </>}
    >
      {!data ? (
        <div className="space-y-2">{[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-9" />)}</div>
      ) : (
        <div className="space-y-5">
          {/* Application fields */}
          <div className="flex items-center gap-2">
            <StatusPill tone={STATUS_META[status]?.tone ?? 'slate'}>{STATUS_META[status]?.label ?? status}</StatusPill>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Period to" htmlFor="pa-period"><Input id="pa-period" type="date" value={periodTo} onChange={e => setPeriodTo(e.target.value)} disabled={isFinalized} /></Field>
            <Field label="Application date" htmlFor="pa-date"><Input id="pa-date" type="date" value={applicationDate} onChange={e => setApplicationDate(e.target.value)} disabled={isFinalized} /></Field>
            <Field label="Status" htmlFor="pa-status">
              <Select id="pa-status" value={status} onChange={e => setStatus(e.target.value)} disabled={isFinalized}>
                {STATUS_OPTIONS.map(s => <option key={s} value={s}>{STATUS_META[s]?.label ?? s}</option>)}
              </Select>
            </Field>
            <Field label="Retainage % (work)" htmlFor="pa-ret"><Input id="pa-ret" type="number" value={retainagePercent} onChange={e => setRetainagePercent(e.target.value)} disabled={isFinalized} /></Field>
            <Field label="Retainage % (stored)" htmlFor="pa-sret"><Input id="pa-sret" type="number" value={storedRetainagePercent} onChange={e => setStoredRetainagePercent(e.target.value)} disabled={isFinalized} /></Field>
          </div>

          {/* G703 continuation sheet */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <h4 className="text-sm font-semibold text-ink">G703 continuation sheet</h4>
              <span className="text-xs text-ink-faint">Save to recalc D / E / G / retainage</span>
            </div>
            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <TR>
                    <TH>Item</TH><TH>Description</TH>
                    <TH>Scheduled (C)</TH><TH>Previous (D)</TH><TH>This period (E)</TH>
                    <TH>Stored (F)</TH><TH>% (G/C)</TH><TH>Total to date (G)</TH>
                    <TH>Balance</TH><TH>Retainage</TH>
                  </TR>
                </THead>
                <TBody>
                  {data.g703.map(row => {
                    const e = edits[row.sovLineId] ?? { percentComplete: '0', storedMaterials: '0' };
                    return (
                      <TR key={row.sovLineId}>
                        <TD className="text-ink-soft">{row.itemNo || '—'}</TD>
                        <TD className="font-medium text-ink">
                          {row.description}
                          {row.isChangeOrder ? <span className="ml-2 rounded bg-hover px-1.5 py-0.5 text-xs font-normal text-ink-faint">CO</span> : null}
                        </TD>
                        <TD className="text-ink-soft">{formatMoney(row.scheduledValueCents)}</TD>
                        <TD className="text-ink-soft">{formatMoney(row.previousCents)}</TD>
                        <TD className="text-ink-soft">{formatMoney(row.thisPeriodCents)}</TD>
                        <TD className="w-28">
                          <Input
                            type="number"
                            value={e.storedMaterials}
                            onChange={ev => setEdit(row.sovLineId, { storedMaterials: ev.target.value })}
                            disabled={isFinalized}
                            placeholder="0.00"
                          />
                        </TD>
                        <TD className="w-20">
                          <Input
                            type="number"
                            value={e.percentComplete}
                            onChange={ev => setEdit(row.sovLineId, { percentComplete: ev.target.value })}
                            disabled={isFinalized}
                            min={0}
                            max={100}
                          />
                        </TD>
                        <TD className="text-ink-soft">
                          {formatMoney(row.totalToDateCents)}
                          {previewG[row.sovLineId] !== row.totalToDateCents && (
                            <span className="ml-1 text-xs text-ink-faint" title="Unsaved preview">→ {formatMoney(previewG[row.sovLineId])}</span>
                          )}
                        </TD>
                        <TD className="text-ink-soft">{formatMoney(row.balanceToFinishCents)}</TD>
                        <TD className="text-ink-soft">{formatMoney(row.retainageCents)}</TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </div>
          </div>

          {/* G702 summary */}
          {g702 && (
            <div className="rounded-lg border border-edge p-4">
              <h4 className="mb-3 text-sm font-semibold text-ink">G702 application summary</h4>
              <dl className="space-y-1.5 text-sm">
                <Row label="1. Original contract sum" value={g702.L1originalContractCents} />
                <Row label="2. Net change by change orders" value={g702.L2changeOrdersCents} />
                <Row label="3. Contract sum to date" value={g702.L3contractSumToDateCents} bold />
                <Row label="4. Total completed & stored to date" value={g702.L4totalCompletedStoredCents} />
                <Row label="5a. Retainage (completed work)" value={g702.L5aRetainageWorkCents} sub />
                <Row label="5b. Retainage (stored material)" value={g702.L5bRetainageStoredCents} sub />
                <Row label="5. Total retainage" value={g702.L5retainageCents} />
                <Row label="6. Total earned less retainage" value={g702.L6earnedLessRetainageCents} />
                <Row label="7. Less previous certificates for payment" value={g702.L7lessPreviousCents} />
                <div className="my-2 border-t border-edge" />
                <div className="flex items-center justify-between text-base">
                  <dt className="font-semibold text-ink">8. Current payment due</dt>
                  <dd className="font-bold text-ink">{formatMoney(g702.L8currentPaymentDueCents)}</dd>
                </div>
                <div className="my-2 border-t border-edge" />
                <Row label="9. Balance to finish, plus retainage" value={g702.L9balanceToFinishCents} />
              </dl>

              <div className="mt-4 border-t border-edge pt-3">
                <h5 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">Change order summary</h5>
                <dl className="space-y-1.5 text-sm">
                  <Row label="Additions" value={g702.changeOrders.additionsCents} />
                  <Row label="Deductions" value={g702.changeOrders.deductionsCents} />
                  <Row label="Net change by change orders" value={g702.changeOrders.netCents} bold />
                </dl>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
};

const Row: React.FC<{ label: string; value: number; bold?: boolean; sub?: boolean }> = ({ label, value, bold, sub }) => (
  <div className={`flex items-center justify-between ${sub ? 'pl-4' : ''}`}>
    <dt className={bold ? 'font-medium text-ink' : 'text-ink-soft'}>{label}</dt>
    <dd className={bold ? 'font-semibold text-ink' : 'text-ink-soft'}>{formatMoney(value)}</dd>
  </div>
);
