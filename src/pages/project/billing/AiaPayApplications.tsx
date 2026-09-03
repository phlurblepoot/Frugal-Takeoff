// src/pages/project/billing/AiaPayApplications.tsx
import React, { useState } from 'react';
import { Eye, Plus, Trash2 } from 'lucide-react';
import { AiaPayAppListItem, getPayApps, createPayApp, deletePayApp } from '../../../utils/store';
import { formatMoney } from '../../../utils/money';
import { useToast } from '../../../components/Toast';
import { useConfirm } from '../../../components/ConfirmDialog';
import {
  Button, Card, CardBody, CardHeader, EmptyState, Field, Input, Modal, StatusPill, Skeleton,
  Table, TBody, TD, TH, THead, TR,
} from '../../../components/ui';
import type { PillTone } from '../../../components/ui';
import { AiaPayAppEditor } from './AiaPayAppEditor';
import { useLiveQuery } from '../../../hooks/useLiveQuery';
import { EditingChip } from '../../../components/EditingChip';
import { useGeneratedDocuments } from '../../../hooks/useGeneratedDocument';
import { useReplyFlags } from '../../../hooks/useReplyFlags';
import { DocumentStatusChip } from '../../../components/documents/DocumentStatusChip';
import { ReplyFlagChip } from '../../../components/documents/ReplyFlagChip';
import { useDocumentViewer } from '../../../components/documents/useDocumentViewer';

const STATUS_META: Record<string, { label: string; tone: PillTone }> = {
  draft:     { label: 'Draft',     tone: 'slate' },
  finalized: { label: 'Finalized', tone: 'emerald' },
};

const today = () => new Date().toISOString().slice(0, 10);

export const AiaPayApplications: React.FC<{ projectId: string }> = ({ projectId }) => {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [apps, setApps] = useState<AiaPayAppListItem[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  // New-application form modal.
  const [creating, setCreating] = useState(false);
  const [nPeriodTo, setNPeriodTo] = useState('');
  const [nAppDate, setNAppDate] = useState(today());
  const [busy, setBusy] = useState(false);

  const reload = () => {
    getPayApps(projectId).then(setApps).catch(() => setApps([]));
  };
  useLiveQuery(reload, { types: ['aiaPayApp', 'payment'], projectId });

  // One batched by-source lookup for the whole list: each row shows whether its
  // G702/G703 workbook exists and still matches the application.
  const rows = apps ?? [];
  const docs = useGeneratedDocuments({
    sourceType: 'payapp',
    kind: 'payapp-export',
    sourceIds: rows.map(a => a.id),
    updatedAtById: Object.fromEntries(rows.map(a => [a.id, a.updatedAt])),
  });
  const replyFlags = useReplyFlags('payApp', rows.map(a => a.id));
  const viewer = useDocumentViewer();

  const startCreate = () => {
    setNPeriodTo('');
    setNAppDate(today());
    setCreating(true);
  };

  const submitCreate = async () => {
    setBusy(true);
    try {
      const { id } = await createPayApp(projectId, {
        periodTo: nPeriodTo || undefined,
        applicationDate: nAppDate || undefined,
      });
      setCreating(false);
      reload();
      setOpenId(id); // open the editor for the new app
    } catch {
      toast('Failed to create pay application', { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const removeApp = async (app: AiaPayAppListItem) => {
    const ok = await confirm({
      title: 'Delete pay application?',
      message: `This permanently removes application #${app.number}.`,
      tone: 'danger', confirmLabel: 'Delete',
    });
    if (!ok) return;
    try { await deletePayApp(app.id); reload(); }
    catch { toast('Delete failed', { type: 'error' }); }
  };

  const fmtDate = (d: string | null) => (d ? new Date(d).toLocaleDateString() : '—');

  return (
    <Card className="mb-5">
      <CardHeader title="Applications for payment"
        actions={<Button size="sm" variant="secondary" onClick={startCreate}><Plus size={14} />New application</Button>} />
      <CardBody className="p-0">
        {apps === null ? (
          <div className="space-y-2 p-4">{[0, 1, 2].map(i => <Skeleton key={i} className="h-9" />)}</div>
        ) : apps.length === 0 ? (
          <EmptyState title="No applications for payment yet"
            description="Create an application to bill against the schedule of values (G702/G703)." />
        ) : (
          <Table>
            <THead><TR><TH>App #</TH><TH>Period to</TH><TH>Application date</TH><TH>Status</TH><TH className="text-right">Amount</TH><TH className="text-right">Balance</TH><TH></TH></TR></THead>
            <TBody>
              {apps.map(app => {
                const meta = STATUS_META[app.status] ?? { label: app.status, tone: 'slate' as PillTone };
                return (
                  <TR key={app.id} interactive onClick={() => setOpenId(app.id)}>
                    <TD className="font-medium text-ink"><span className="inline-flex items-center gap-1.5">#{app.number}<EditingChip type="aiaPayApp" id={app.id} />{replyFlags.has(app.id) && <ReplyFlagChip data-testid={`payapp-reply-flag-${app.id}`} />}</span></TD>
                    <TD className="text-ink-soft">{fmtDate(app.periodTo)}</TD>
                    <TD className="text-ink-soft">{fmtDate(app.applicationDate)}</TD>
                    <TD><StatusPill tone={meta.tone}>{meta.label}</StatusPill></TD>
                    <TD className="text-right tabular-nums text-ink-soft">{formatMoney(app.totalCents)}</TD>
                    <TD className="text-right tabular-nums text-ink-soft">{app.balanceCents == null ? '—' : formatMoney(app.balanceCents)}</TD>
                    <TD onClick={e => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1">
                        {docs.byId[app.id]?.file && (
                          <>
                            <DocumentStatusChip file={docs.byId[app.id].file} upToDate={docs.byId[app.id].upToDate} format="xlsx" size="sm" />
                            <button
                              onClick={() => viewer.open(docs.byId[app.id].file!, 'payapp-export', projectId)}
                              title="Open Excel" aria-label="Open Excel"
                              className="rounded-md p-1 text-ink-faint hover:bg-hover hover:text-ink"
                            >
                              <Eye size={14} />
                            </button>
                          </>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => setOpenId(app.id)}>Open</Button>
                        <button onClick={() => removeApp(app)} title="Delete" className="rounded-md p-1 text-ink-faint hover:bg-hover hover:text-red-600"><Trash2 size={14} /></button>
                      </div>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </CardBody>

      {/* New application form */}
      <Modal open={creating} onClose={() => setCreating(false)} title="New application for payment" width="sm"
        footer={<>
          <Button variant="secondary" onClick={() => setCreating(false)}>Cancel</Button>
          <Button onClick={submitCreate} disabled={busy}>{busy ? 'Creating…' : 'Create'}</Button>
        </>}>
        <div className="space-y-3">
          <Field label="Period to" htmlFor="new-pa-period"><Input id="new-pa-period" type="date" value={nPeriodTo} onChange={e => setNPeriodTo(e.target.value)} /></Field>
          <Field label="Application date" htmlFor="new-pa-date"><Input id="new-pa-date" type="date" value={nAppDate} onChange={e => setNAppDate(e.target.value)} /></Field>
        </div>
      </Modal>

      {openId && (
        <AiaPayAppEditor
          payAppId={openId}
          onClose={() => setOpenId(null)}
          onSaved={reload}
        />
      )}

      {viewer.modal}
    </Card>
  );
};
