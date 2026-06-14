// src/pages/project/billing/AiaPayApplications.tsx
import React, { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { AiaPayApp, getPayApps, createPayApp, deletePayApp } from '../../../utils/store';
import { useToast } from '../../../components/Toast';
import { useConfirm } from '../../../components/ConfirmDialog';
import {
  Button, Card, CardBody, CardHeader, EmptyState, Field, Input, Modal, StatusPill, Skeleton,
  Table, TBody, TD, TH, THead, TR,
} from '../../../components/ui';
import type { PillTone } from '../../../components/ui';
import { AiaPayAppEditor } from './AiaPayAppEditor';

const STATUS_META: Record<string, { label: string; tone: PillTone }> = {
  draft:     { label: 'Draft',     tone: 'slate' },
  finalized: { label: 'Finalized', tone: 'emerald' },
};

const today = () => new Date().toISOString().slice(0, 10);

export const AiaPayApplications: React.FC<{ projectId: string }> = ({ projectId }) => {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [apps, setApps] = useState<AiaPayApp[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  // New-application form modal.
  const [creating, setCreating] = useState(false);
  const [nPeriodTo, setNPeriodTo] = useState('');
  const [nAppDate, setNAppDate] = useState(today());
  const [busy, setBusy] = useState(false);

  const reload = () => {
    getPayApps(projectId).then(setApps).catch(() => setApps([]));
  };
  useEffect(reload, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const removeApp = async (app: AiaPayApp) => {
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
            <THead><TR><TH>App #</TH><TH>Period to</TH><TH>Application date</TH><TH>Status</TH><TH></TH></TR></THead>
            <TBody>
              {apps.map(app => {
                const meta = STATUS_META[app.status] ?? { label: app.status, tone: 'slate' as PillTone };
                return (
                  <TR key={app.id} interactive onClick={() => setOpenId(app.id)}>
                    <TD className="font-medium text-ink">#{app.number}</TD>
                    <TD className="text-ink-soft">{fmtDate(app.periodTo)}</TD>
                    <TD className="text-ink-soft">{fmtDate(app.applicationDate)}</TD>
                    <TD><StatusPill tone={meta.tone}>{meta.label}</StatusPill></TD>
                    <TD onClick={e => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1">
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
    </Card>
  );
};
