// src/pages/project/ProjectBilling.tsx
import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { DollarSign, FileText, Plus, Trash2, ShieldAlert } from 'lucide-react';
import {
  BillingSummary, Invoice, InvoiceListItem, AiaSettings,
  getBillingSummary, getInvoices, getInvoice, createInvoice, deleteInvoice, setInvoiceStatus,
  getAiaSettings,
} from '../../utils/store';
import { formatMoney } from '../../utils/money';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';
import {
  Button, Card, CardBody, CardHeader, EmptyState, Skeleton,
  Table, TBody, TD, TH, THead, TR,
} from '../../components/ui';
import { InvoiceStatusPill } from '../../components/ui/BillingPills';
import { InvoiceEditor } from './billing/InvoiceEditor';
import { AiaSettingsForm } from './billing/AiaSettingsForm';
import { AiaScheduleOfValues } from './billing/AiaScheduleOfValues';
import { ChangeOrdersSection } from './billing/ChangeOrdersSection';
import { AiaPayApplications } from './billing/AiaPayApplications';
import { PaymentsSection } from './billing/PaymentsSection';
import { useProjectOutlet } from './ProjectLayout';

export { lineCents, draftTotalCents } from './billing/InvoiceEditor';

const isAdmin = () => (JSON.parse(localStorage.getItem('user') || '{}').role) === 'admin';

export const ProjectBilling: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const { toast } = useToast();
  const confirm = useConfirm();
  const { summary: projectSummary } = useProjectOutlet();
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [invoices, setInvoices] = useState<InvoiceListItem[] | null>(null);
  const [editing, setEditing] = useState<Invoice | null>(null);
  const [aiaSettings, setAiaSettings] = useState<AiaSettings | null>(null);

  const admin = isAdmin();

  const reloadSummary = () => {
    if (!projectId || !admin) return;
    getBillingSummary(projectId).then(setSummary).catch(() => setSummary(null));
  };
  const load = () => {
    if (!projectId || !admin) return;
    reloadSummary();
    getInvoices(projectId).then(setInvoices).catch(() => setInvoices([]));
    getAiaSettings(projectId).then(setAiaSettings).catch(() => setAiaSettings({}));
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

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-ink">Billing</h1>
      </div>

      {/* Summary */}
      <Card className="mb-5">
        <CardHeader title="Summary" actions={<DollarSign size={15} className="text-ink-faint" />} />
        <CardBody>
          {summary === null ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3 lg:grid-cols-5">
              {[
                ['Contract total', summary.contractTotalCents],
                ['Invoiced', summary.invoiceTotalCents],
                ['Paid (contract)', summary.paid.payAppsCents],
                ['Paid (invoices)', summary.paid.invoicesCents],
                ['Invoice outstanding', summary.invoiceOutstandingCents],
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

      {/* AIA G702/G703 */}
      {aiaSettings && (
        <AiaSettingsForm projectId={projectId ?? ''} settings={aiaSettings} onSaved={setAiaSettings} />
      )}
      {projectId && <AiaScheduleOfValues projectId={projectId} />}
      {projectId && <ChangeOrdersSection projectId={projectId} onChange={() => { load(); reloadSummary(); }} />}
      {projectId && <AiaPayApplications projectId={projectId} />}

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

      {/* Payments */}
      {projectId && <PaymentsSection projectId={projectId} onChange={reloadSummary} />}

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
          projectName={projectSummary?.name ?? ''}
          contractor={projectSummary?.contractor}
          address={projectSummary?.address}
          projectId={projectId ?? ''}
        />
      )}
    </div>
  );
};
