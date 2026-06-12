// src/components/ui/StatusPill.tsx
import React from 'react';

export type PillTone =
  | 'slate' | 'blue' | 'violet' | 'green' | 'emerald' | 'amber' | 'orange' | 'red';

// Soft colour-tinted pills (spec §5 rule 1). Full class strings per tone so
// Tailwind's scanner sees every class statically.
const TONES: Record<PillTone, string> = {
  slate:   'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-400/10 dark:text-slate-300 dark:border-slate-400/20',
  blue:    'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-400/10 dark:text-blue-300 dark:border-blue-400/20',
  violet:  'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-400/10 dark:text-violet-300 dark:border-violet-400/20',
  green:   'bg-green-50 text-green-700 border-green-200 dark:bg-green-400/10 dark:text-green-300 dark:border-green-400/20',
  emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-400/10 dark:text-emerald-300 dark:border-emerald-400/20',
  amber:   'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-400/10 dark:text-amber-300 dark:border-amber-400/20',
  orange:  'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-400/10 dark:text-orange-300 dark:border-orange-400/20',
  red:     'bg-red-50 text-red-700 border-red-200 dark:bg-red-400/10 dark:text-red-300 dark:border-red-400/20',
};

export const StatusPill: React.FC<{
  tone?: PillTone;
  className?: string;
  children: React.ReactNode;
}> = ({ tone = 'slate', className = '', children }) => (
  <span
    className={
      'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 ' +
      `text-xs font-medium whitespace-nowrap ${TONES[tone]} ${className}`
    }
  >
    {children}
  </span>
);

// Project lifecycle (spec §2): estimating → proposal_sent → awarded →
// in_progress → punch_list → complete → archived, with lost as an exit.
export const PROJECT_STATUS_META: Record<string, { label: string; tone: PillTone }> = {
  estimating:    { label: 'Estimating',    tone: 'blue' },
  proposal_sent: { label: 'Proposal Sent', tone: 'violet' },
  awarded:       { label: 'Awarded',       tone: 'green' },
  in_progress:   { label: 'In Progress',   tone: 'amber' },
  punch_list:    { label: 'Punch List',    tone: 'orange' },
  complete:      { label: 'Complete',      tone: 'emerald' },
  archived:      { label: 'Archived',      tone: 'slate' },
  lost:          { label: 'Lost',          tone: 'red' },
};

export const ProjectStatusPill: React.FC<{ status?: string | null; className?: string }> = ({
  status,
  className,
}) => {
  const meta = (status && PROJECT_STATUS_META[status]) ||
    { label: status || 'Unknown', tone: 'slate' as PillTone };
  return (
    <StatusPill tone={meta.tone} className={className}>
      {meta.label}
    </StatusPill>
  );
};
