// src/pages/project/ProjectBilling.tsx
import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { DollarSign, ShieldAlert } from 'lucide-react';
import {
  BillingSummary, AiaSettings,
  getBillingSummary, getAiaSettings,
} from '../../utils/store';
import { formatMoney } from '../../utils/money';
import {
  Card, CardBody, CardHeader, EmptyState, Skeleton,
} from '../../components/ui';
import { AiaSettingsForm } from './billing/AiaSettingsForm';
import { AiaScheduleOfValues } from './billing/AiaScheduleOfValues';
import { ChangeOrdersSection } from './billing/ChangeOrdersSection';
import { AiaPayApplications } from './billing/AiaPayApplications';
import { PaymentsSection } from './billing/PaymentsSection';
import { InvoicesSection } from './billing/InvoicesSection';

export { lineCents, draftTotalCents } from './billing/InvoiceEditor';

const isAdmin = () => (JSON.parse(localStorage.getItem('user') || '{}').role) === 'admin';

export const ProjectBilling: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [aiaSettings, setAiaSettings] = useState<AiaSettings | null>(null);

  const admin = isAdmin();

  const reloadSummary = () => {
    if (!projectId || !admin) return;
    getBillingSummary(projectId).then(setSummary).catch(() => setSummary(null));
  };
  const load = () => {
    if (!projectId || !admin) return;
    reloadSummary();
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
      {projectId && <InvoicesSection projectId={projectId} onChange={reloadSummary} />}

      {/* Payments */}
      {projectId && <PaymentsSection projectId={projectId} onChange={reloadSummary} />}
    </div>
  );
};
