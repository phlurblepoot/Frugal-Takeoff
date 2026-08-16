// src/pages/customers/CustomerOverviewTab.tsx
// Overview tab: four stat tiles + a "Needs attention" feed. Money figures and
// money-bearing attention items are gated server-side (server/customerStore.ts
// customerOverview) — `overview.billing` and any dollar amounts are entirely
// absent from the payload for non-admins, so this component never needs its
// own role check for those fields.
import React from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, Calendar, CheckSquare, DollarSign, ListChecks,
} from 'lucide-react';
import { CustomerAttentionItem, CustomerOverview } from '../../utils/store';
import { formatMoney } from '../../utils/money';
import { Card, CardBody, CardHeader, EmptyState } from '../../components/ui';

const fmtDate = (v: number | string | null | undefined): string | null => {
  if (v == null) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toLocaleDateString();
};

const StatTile: React.FC<{ label: string; value: React.ReactNode; sub?: React.ReactNode }> = ({ label, value, sub }) => (
  <div>
    <div className="text-ink-faint">{label}</div>
    <div className="text-lg font-bold text-ink">{value}</div>
    {sub && <div className="text-xs text-red-600 dark:text-red-400">{sub}</div>}
  </div>
);

// Resolves each attention type to its link target, per the reorg spec: a task
// row scopes the global Tasks page to this customer (no per-task deep link
// exists there); a bid row goes to the project's overview; an outstanding
// invoice/pay-app row goes straight to that project's Billing tab.
const attentionHref = (item: CustomerAttentionItem, customerId: string): string => {
  switch (item.type) {
    case 'overdue_task': return `/tasks?customerId=${customerId}`;
    case 'bid_due': return `/project/${item.projectId}`;
    case 'outstanding_invoice': return `/project/${item.projectId}/billing`;
  }
};

const AttentionRow: React.FC<{ item: CustomerAttentionItem; customerId: string }> = ({ item, customerId }) => {
  // Overdue tasks are always overdue by construction (the server only emits
  // them past their due date); bids carry an explicit flag; outstanding
  // balances are a standing concern rather than a date-driven overdue state.
  const isOverdue = item.type === 'overdue_task' || (item.type === 'bid_due' && !!item.overdue);
  const Icon = item.type === 'overdue_task' ? CheckSquare : item.type === 'bid_due' ? Calendar : DollarSign;
  const iconTone = isOverdue ? 'text-red-600 dark:text-red-400' : item.type === 'outstanding_invoice' ? 'text-amber-600 dark:text-amber-400' : 'text-ink-faint';
  const dateLabel = fmtDate(item.date);

  return (
    <li>
      <Link
        to={attentionHref(item, customerId)}
        data-testid="customer-attention-row"
        className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-hover"
      >
        <Icon size={14} className={`shrink-0 ${iconTone}`} />
        <span className="min-w-0 flex-1 truncate text-sm text-ink" title={item.label}>{item.label}</span>
        {item.type === 'outstanding_invoice' && (
          <span className="shrink-0 text-sm font-semibold text-ink">{formatMoney(item.balanceCents)}</span>
        )}
        {dateLabel && (
          <span className={`shrink-0 text-xs font-medium ${isOverdue ? 'text-red-600 dark:text-red-400' : 'text-ink-soft'}`}>
            {dateLabel}{isOverdue ? ' · overdue' : ''}
          </span>
        )}
      </Link>
    </li>
  );
};

export const CustomerOverviewTab: React.FC<{ overview: CustomerOverview }> = ({ overview }) => {
  const { customer, projects, attention, taskCounts, billing } = overview;

  const biddingCount = projects.filter(p => !p.archived && p.status === 'bidding').length;
  const inProgressCount = projects.filter(p => !p.archived && p.status === 'in_progress').length;

  return (
    <div className="space-y-5">
      <Card>
        <CardBody>
          <div className={`grid grid-cols-2 gap-4 text-sm ${billing ? 'sm:grid-cols-4' : 'sm:grid-cols-3'}`}>
            <StatTile label="Bidding" value={biddingCount} />
            <StatTile label="In progress" value={inProgressCount} />
            {billing && <StatTile label="Outstanding" value={formatMoney(billing.outstandingCents)} />}
            <StatTile
              label="Open tasks"
              value={taskCounts.open}
              sub={taskCounts.overdue > 0 ? `${taskCounts.overdue} overdue` : undefined}
            />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Needs attention" actions={<AlertTriangle size={15} className="text-ink-faint" />} />
        <CardBody className="p-0">
          {attention.length === 0 ? (
            <EmptyState icon={<ListChecks size={20} />} title="Nothing needs attention"
              description="Overdue tasks, upcoming bid deadlines, and outstanding balances show up here." />
          ) : (
            <ul className="divide-y divide-edge">
              {attention.map((item, i) => (
                <AttentionRow key={`${item.type}-${i}`} item={item} customerId={customer.id} />
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
};
