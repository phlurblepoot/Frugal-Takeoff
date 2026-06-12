// src/components/ui/BillingPills.tsx
import React from 'react';
import { StatusPill, PillTone } from './StatusPill';

export const INVOICE_STATUS_META: Record<string, { label: string; tone: PillTone }> = {
  draft: { label: 'Draft', tone: 'slate' },
  sent:  { label: 'Sent',  tone: 'blue' },
  paid:  { label: 'Paid',  tone: 'emerald' },
};

export const CO_STATUS_META: Record<string, { label: string; tone: PillTone }> = {
  pending:  { label: 'Pending',  tone: 'amber' },
  approved: { label: 'Approved', tone: 'green' },
  rejected: { label: 'Rejected', tone: 'red' },
};

const pillFrom = (
  meta: Record<string, { label: string; tone: PillTone }>,
  status?: string | null,
  className?: string
) => {
  const entry = status != null && Object.hasOwn(meta, status) ? meta[status] : null;
  const m = entry ?? { label: status || 'Unknown', tone: 'slate' as PillTone };
  return <StatusPill tone={m.tone} className={className}>{m.label}</StatusPill>;
};

export const InvoiceStatusPill: React.FC<{ status?: string | null; className?: string }> = ({ status, className }) =>
  pillFrom(INVOICE_STATUS_META, status, className);

export const ChangeOrderStatusPill: React.FC<{ status?: string | null; className?: string }> = ({ status, className }) =>
  pillFrom(CO_STATUS_META, status, className);
