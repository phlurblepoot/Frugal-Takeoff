// src/pages/project/billing/AiaScheduleOfValues.tsx
import React, { useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { Plus, Trash2, Check, X, Pencil, Upload, HelpCircle, Download } from 'lucide-react';
import {
  AiaSettings, AiaSovLine, getSov, createSovLine, saveSovLine, deleteSovLine,
  seedSov, syncChangeOrders, getProject, computeSovSeedFromEstimate, resolveRetainageMode,
} from '../../../utils/store';
import { formatMoney, dollarsToCents, centsToDollars } from '../../../utils/money';
import { useToast } from '../../../components/Toast';
import { useConfirm } from '../../../components/ConfirmDialog';
import { exportAiaXlsx, sanitizeFilename } from './aiaExcel';
import { resolveAiaExportEnv, buildBlankSovContext } from './aiaExportShared';
import {
  Button, Card, CardBody, CardHeader, EmptyState, Field, Input, Skeleton,
  Table, TBody, TD, TH, THead, TR,
} from '../../../components/ui';
import { useLiveQuery } from '../../../hooks/useLiveQuery';
import { useCollabEditing } from '../../../hooks/useCollabEditing';
import { EditPresenceBanner } from '../../../components/EditPresenceBanner';

const isCo = (l: AiaSovLine) => !!l.isChangeOrder;

export const AiaScheduleOfValues: React.FC<{ projectId: string; aiaSettings?: AiaSettings | null }> = ({ projectId, aiaSettings }) => {
  const { toast } = useToast();
  const confirm = useConfirm();
  const baseRetainagePercent = aiaSettings?.retainagePercent ?? 10;
  const [lines, setLines] = useState<AiaSovLine[] | null>(null);
  // Resolved mode: absent aiaSettings.retainageMode falls back to inferring
  // from the SOV lines themselves, so a legacy per-line project keeps
  // showing its column before anyone visits AIA settings.
  const perLine = resolveRetainageMode(aiaSettings?.retainageMode, lines ?? []) === 'perLine';
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
  useLiveQuery(reload, { types: ['aiaSov', 'changeOrder'], projectId });

  // Page-level presence only — SOV events carry per-line ids, not a single
  // entity id, and Task 6's useLiveQuery above already handles silent live
  // refresh. isDirty always false means remoteChange can never be set, so
  // the banner only ever renders its "others editing" half.
  const collab = useCollabEditing({
    type: 'aiaSov',
    id: projectId,
    isDirty: () => false,
    onFresh: reload,
  });

  // Zero-charge SOV export — the same G702/G703 workbook (or admin template) a
  // pay-app export produces, with all billing at $0. Lets the SOV be presented
  // for approval before any pay application exists.
  const handleDownloadSov = async () => {
    if (!lines || lines.length === 0) return;
    setDownloading(true);
    try {
      const env = await resolveAiaExportEnv(projectId);
      if (env.templateLoadFailed) {
        toast('AIA template failed to load — exporting standard G702/G703 instead', { type: 'error' });
      }
      const blank = buildBlankSovContext(env.sovLines, env.aiaSettings, projectId);
      await exportAiaXlsx({
        projectName: env.project?.name ?? 'Project',
        contractor: env.project?.contractor ?? undefined,
        company: env.company,
        aiaSettings: env.aiaSettings,
        app: blank.app,
        sovLines: env.sovLines,
        g702: blank.g702,
        g703: blank.g703,
      }, env.template, `AIA-${sanitizeFilename(env.project?.name ?? 'Project')}-SOV.xlsx`);
      toast('SOV downloaded', { type: 'success' });
    } catch {
      toast('Failed to export SOV', { type: 'error' });
    } finally {
      setDownloading(false);
    }
  };

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

  const handleUploadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    if (!file || !projectId) { input.value = ''; return; }
    setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      if (!ws) { toast('No sheet found in the file', { type: 'error' }); return; }
      const rows = XLSX.utils.sheet_to_json<any[]>(ws, { header: 1, blankrows: false });
      const newLines: { description: string; scheduledValueCents: number }[] = [];
      for (const row of rows) {
        const description = String(row[0] ?? '').trim();
        const value = Number(String(row[1] ?? '').replace(/[$,\s]/g, ''));
        if (description === '' || !Number.isFinite(value)) continue;
        newLines.push({ description, scheduledValueCents: Math.round(value * 100) });
      }
      if (newLines.length === 0) {
        toast('No valid rows found — column A should be descriptions, column B the values', { type: 'error' });
        return;
      }
      const hasOriginal = (lines ?? []).some(l => !isCo(l));
      if (hasOriginal) {
        const ok = await confirm({
          title: 'Replace schedule of values?',
          message: `Replace the schedule of values with ${newLines.length} line${newLines.length === 1 ? '' : 's'} from the sheet? Change-order lines are kept.`,
          confirmLabel: 'Replace',
        });
        if (!ok) return;
      }
      await seedSov(projectId, newLines);
      reload();
      toast(`Imported ${newLines.length} line${newLines.length === 1 ? '' : 's'}`, { type: 'success' });
    } catch {
      toast('Failed to read sheet', { type: 'error' });
    } finally {
      input.value = '';
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
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" onClick={handleDownloadSov}
              disabled={busy || downloading || !lines || lines.length === 0}>
              <Download size={14} />{downloading ? 'Exporting…' : 'Download SOV'}
            </Button>
            <Button size="sm" variant="secondary" onClick={seedFromEstimate} disabled={busy}>Seed from estimate</Button>
            <Button size="sm" variant="secondary" onClick={syncCos} disabled={busy}>Sync approved change orders</Button>
            <Button size="sm" variant="secondary" onClick={() => fileInputRef.current?.click()} disabled={busy}><Upload size={14} />Upload sheet</Button>
            <Button size="sm" variant="ghost" onClick={() => setShowHelp(v => !v)} aria-expanded={showHelp} aria-label="Schedule of values upload help"><HelpCircle size={16} /></Button>
            <input ref={fileInputRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleUploadFile} />
          </div>
        } />
      {showHelp && (
        <p className="border-b border-edge px-4 py-3 text-sm text-ink-faint">
          Upload an .xlsx where column A is the line description and column B is the scheduled value (in dollars). A header row is fine — it's skipped automatically. This replaces the current schedule of values (change-order lines are kept).
        </p>
      )}
      <CardBody className="p-0">
        {collab.othersEditing.length > 0 && (
          <div className="px-4 pt-4"><EditPresenceBanner state={collab} /></div>
        )}
        {lines === null ? (
          <div className="space-y-2 p-4">{[0, 1, 2].map(i => <Skeleton key={i} className="h-9" />)}</div>
        ) : lines.length === 0 ? (
          <EmptyState title="No schedule of values yet"
            description="Seed from the estimate or add lines manually to build the G703." />
        ) : (
          <Table>
            <THead><TR><TH>Item no.</TH><TH>Description</TH><TH>Scheduled value</TH>{perLine && <TH>Retainage %</TH>}<TH></TH></TR></THead>
            <TBody>
              {lines.map(l => editId === l.id ? (
                <TR key={l.id}>
                  <TD className="w-24"><Input value={eItemNo} onChange={e => setEItemNo(e.target.value)} /></TD>
                  <TD><Input value={eDesc} onChange={e => setEDesc(e.target.value)} /></TD>
                  <TD className="w-32"><Input type="number" value={eValue} onChange={e => setEValue(e.target.value)} placeholder="0.00" /></TD>
                  {perLine && <TD className="w-24"><Input type="number" value={eRetainage} onChange={e => setERetainage(e.target.value)} placeholder={`base ${baseRetainagePercent}%`} /></TD>}
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
                  {perLine && <TD className="text-ink-soft">{l.retainagePercent != null ? `${l.retainagePercent}%` : '—'}</TD>}
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
        {!perLine && lines && lines.length > 0 && (
          <p className="border-t border-edge px-4 py-2 text-xs text-ink-faint">
            Retainage: base rate {baseRetainagePercent}% applies to all lines (change in AIA settings)
          </p>
        )}

        {/* Add line */}
        <div className="flex flex-wrap items-end gap-2 border-t border-edge p-4">
          <div className="w-full sm:w-auto"><Field label="Item no." htmlFor="sov-item"><Input id="sov-item" value={nItemNo} onChange={e => setNItemNo(e.target.value)} className="w-full sm:w-24" /></Field></div>
          <div className="w-full sm:w-auto"><Field label="Description" htmlFor="sov-desc"><Input id="sov-desc" value={nDesc} onChange={e => setNDesc(e.target.value)} className="w-full sm:w-56" /></Field></div>
          <div className="w-full sm:w-auto"><Field label="Scheduled value" htmlFor="sov-value"><Input id="sov-value" type="number" value={nValue} onChange={e => setNValue(e.target.value)} className="w-full sm:w-32" placeholder="0.00" /></Field></div>
          {perLine && <div className="w-full sm:w-auto"><Field label="Retainage %" htmlFor="sov-ret"><Input id="sov-ret" type="number" value={nRetainage} onChange={e => setNRetainage(e.target.value)} className="w-full sm:w-28" placeholder={`base ${baseRetainagePercent}%`} /></Field></div>}
          <Button variant="secondary" onClick={addLine} className="w-full sm:w-auto"><Plus size={14} />Add line</Button>
        </div>

        {/* Totals */}
        {lines && lines.length > 0 && (
          <div className="flex flex-wrap justify-end gap-6 border-t border-edge p-4 text-sm">
            <div className="text-ink-soft">Original <span className="ml-2 font-semibold text-ink">{formatMoney(originalCents)}</span></div>
            <div className="text-ink-soft">Change orders <span className="ml-2 font-semibold text-ink">{formatMoney(coCents)}</span></div>
            <div className="text-ink-soft">Total scheduled value <span className="ml-2 font-semibold text-ink">{formatMoney(totalCents)}</span></div>
          </div>
        )}
      </CardBody>
    </Card>
  );
};
