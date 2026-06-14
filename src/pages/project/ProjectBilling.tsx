// src/pages/project/ProjectBilling.tsx
import React, { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
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

const BILLING_TABS = [
  { value: 'sov', label: 'Schedule of Values' },
  { value: 'change-orders', label: 'Change Orders' },
  { value: 'pay-apps', label: 'Pay Applications' },
  { value: 'invoices', label: 'Invoices' },
  { value: 'payments', label: 'Payments' },
  { value: 'settings', label: 'Settings' },
] as const;

type BillingTab = (typeof BILLING_TABS)[number]['value'];
const BILLING_TAB_VALUES = BILLING_TABS.map(t => t.value) as readonly string[];

export const ProjectBilling: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [aiaSettings, setAiaSettings] = useState<AiaSettings | null>(null);

  const admin = isAdmin();

  const tabParam = searchParams.get('tab');
  const activeTab: BillingTab = BILLING_TAB_VALUES.includes(tabParam ?? '')
    ? (tabParam as BillingTab)
    : 'sov';
  const setActiveTab = (tab: BillingTab) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('tab', tab);
      return next;
    }, { replace: true });
  };

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

  // Refresh the always-visible summary totals whenever the active tab changes,
  // so edits made in any tab (e.g. SOV / change orders affecting the contract
  // total) are reflected without a manual reload.
  useEffect(reloadSummary, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

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

      {/* Tabs */}
      <div className="flex border-b border-slate-200 dark:border-slate-700 mb-6 overflow-x-auto no-scrollbar -mx-4 px-4 md:mx-0 md:px-0">
        {BILLING_TABS.map(tab => (
          <button
            key={tab.value}
            onClick={() => setActiveTab(tab.value)}
            className={`px-4 md:px-6 py-3 text-sm font-medium transition-colors relative whitespace-nowrap ${
              activeTab === tab.value ? 'text-accent-600' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
            }`}
          >
            {tab.label}
            {activeTab === tab.value && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent-600" />
            )}
          </button>
        ))}
      </div>

      {/* Active section */}
      {projectId && activeTab === 'sov' && <AiaScheduleOfValues projectId={projectId} />}
      {projectId && activeTab === 'change-orders' && (
        <ChangeOrdersSection projectId={projectId} onChange={reloadSummary} />
      )}
      {projectId && activeTab === 'pay-apps' && <AiaPayApplications projectId={projectId} />}
      {projectId && activeTab === 'invoices' && (
        <InvoicesSection projectId={projectId} onChange={reloadSummary} />
      )}
      {projectId && activeTab === 'payments' && (
        <PaymentsSection projectId={projectId} onChange={reloadSummary} />
      )}
      {activeTab === 'settings' && (
        <AiaSettingsForm projectId={projectId ?? ''} settings={aiaSettings ?? {}} onSaved={setAiaSettings} defaultOpen />
      )}
    </div>
  );
};
