// src/pages/customers/CustomerPane.tsx
// Right pane of the customers split view: header (name, contact/phone,
// [+ Project], admin-outstanding slot) + Overview/Projects/Tasks/Billing/
// Settings tabs with ?tab= persistence. Tab-host pattern mirrors
// src/pages/project/ProjectBilling.tsx.
import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Phone, Plus, User } from 'lucide-react';
import { Customer } from '../../types';
import { CustomerOverview, getCustomerOverview } from '../../utils/store';
import { useToast } from '../../components/Toast';
import { Button, Card, CardBody, Skeleton } from '../../components/ui';
import { CustomerProjectsTab } from './CustomerProjectsTab';
import { CustomerSettingsTab } from './CustomerSettingsTab';

const CUSTOMER_TABS = [
  { value: 'overview', label: 'Overview' },
  { value: 'projects', label: 'Projects' },
  { value: 'tasks', label: 'Tasks' },
  { value: 'billing', label: 'Billing' },
  { value: 'settings', label: 'Settings' },
] as const;

type CustomerTab = (typeof CUSTOMER_TABS)[number]['value'];
const CUSTOMER_TAB_VALUES = CUSTOMER_TABS.map(t => t.value) as readonly string[];

// A tab whose content isn't built yet — replaced by Task 5.
const ComingSoonCard: React.FC<{ label: string }> = ({ label }) => (
  <Card>
    <CardBody>
      <p className="text-sm text-ink-faint">{label} — coming in the next task.</p>
    </CardBody>
  </Card>
);

export const CustomerPane: React.FC<{
  customerId: string;
  onBack: () => void;
  onDeleted: () => void;
  onMerged: (targetId: string) => void;
}> = ({ customerId, onBack, onDeleted, onMerged }) => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [overview, setOverview] = useState<CustomerOverview | null>(null);
  const [loading, setLoading] = useState(true);

  const tabParam = searchParams.get('tab');
  const activeTab: CustomerTab = CUSTOMER_TAB_VALUES.includes(tabParam ?? '')
    ? (tabParam as CustomerTab)
    : 'overview';
  const setActiveTab = (tab: CustomerTab) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('tab', tab);
      return next;
    }, { replace: true });
  };

  const load = useCallback(() => {
    setLoading(true);
    getCustomerOverview(customerId)
      .then(setOverview)
      .catch(() => toast('Failed to load customer.', { type: 'error' }))
      .finally(() => setLoading(false));
  }, [customerId, toast]);

  useEffect(() => { load(); }, [load]);

  const handleSaved = (c: Customer) => {
    setOverview(prev => (prev ? { ...prev, customer: c } : prev));
  };

  if (loading || !overview) {
    return (
      <div data-testid="customer-pane" className="flex h-full flex-col p-4 sm:p-6">
        <Skeleton className="mb-4 h-8 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const { customer } = overview;

  return (
    <div data-testid="customer-pane" className="flex h-full flex-col overflow-y-auto">
      {/* Header */}
      <div className="sticky top-0 z-10 border-b border-edge bg-surface px-4 py-4 sm:px-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <button
              onClick={onBack}
              className="flex items-center justify-center rounded-lg p-1.5 text-ink-faint transition-colors hover:bg-hover hover:text-ink md:hidden"
              aria-label="Back to Customers"
            >
              <ArrowLeft size={18} />
            </button>
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold text-ink" title={customer.name}>
                {customer.name}
              </h1>
              {(customer.contactName || customer.phone) && (
                <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 truncate text-sm text-ink-soft">
                  {customer.contactName && (
                    <span className="flex items-center gap-1"><User size={12} className="shrink-0" />{customer.contactName}</span>
                  )}
                  {customer.phone && (
                    <span className="flex items-center gap-1"><Phone size={12} className="shrink-0" />{customer.phone}</span>
                  )}
                </p>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/* Admin outstanding-balance figure lands here in the next task. */}
            <div data-testid="customer-outstanding-slot" />
            <Button size="sm" onClick={() => navigate(`/new?customerId=${customer.id}`)}>
              <Plus size={15} />
              <span>Project</span>
            </Button>
          </div>
        </div>

        {/* Tabs */}
        <div className="-mx-4 mt-4 flex overflow-x-auto border-b border-edge px-4 no-scrollbar sm:-mx-6 sm:px-6">
          {CUSTOMER_TABS.map(tab => (
            <button
              key={tab.value}
              data-testid={`customer-tab-${tab.value}`}
              onClick={() => setActiveTab(tab.value)}
              className={`relative whitespace-nowrap px-4 py-3 text-sm font-medium transition-colors md:px-5 ${
                activeTab === tab.value ? 'text-accent-600' : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-300'
              }`}
            >
              {tab.label}
              {activeTab === tab.value && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent-600" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Active section */}
      <div className="flex-1 px-4 py-6 sm:px-6">
        {activeTab === 'overview' && <ComingSoonCard label="Overview" />}
        {activeTab === 'projects' && <CustomerProjectsTab projects={overview.projects} />}
        {activeTab === 'tasks' && <ComingSoonCard label="Tasks" />}
        {activeTab === 'billing' && <ComingSoonCard label="Billing" />}
        {activeTab === 'settings' && (
          <CustomerSettingsTab
            customerId={customer.id}
            onSaved={handleSaved}
            onDeleted={onDeleted}
            onMerged={onMerged}
          />
        )}
      </div>
    </div>
  );
};
