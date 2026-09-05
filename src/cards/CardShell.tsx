// src/cards/CardShell.tsx — the standard card chrome: glass, soft-zoom,
// header, and the loading/empty plumbing every card shares.
import React from 'react';
import { useSoftZoom } from '../hooks/useSoftZoom';
import { Skeleton } from '../components/ui';
import type { EmptyKind } from './types';

// Interim empty-state body: title only, in the EmptyState icon-circle style
// but without an illustration graphic — Task 12's EmptyArt wires real art per
// EmptyKind. Kept private; CardShell owns rendering it.
const CardEmpty: React.FC<{ title?: string; illustration?: EmptyKind }> = ({ title }) => (
  <div className="flex h-full flex-col items-center justify-center px-4 py-6 text-center">
    <div className="mb-3 size-10 rounded-full bg-sunken" aria-hidden="true" />
    {title && <p className="text-sm font-medium text-ink-faint">{title}</p>}
  </div>
);

export const CardShell: React.FC<{
  title: string;
  icon?: React.ReactNode;
  actions?: React.ReactNode;      // e.g. "View all" link
  loading?: boolean;              // -> body replaced by 2 Skeleton rows
  empty?: boolean;                // -> body replaced by <CardEmpty>
  emptyTitle?: string;
  emptyIllustration?: EmptyKind;  // Task 12 wires real art; until then icon circle
  flush?: boolean;                // p-0 body for row lists
  children: React.ReactNode;
}> = ({ title, icon, actions, loading, empty, emptyTitle, emptyIllustration, flush, children }) => {
  const softZoomRef = useSoftZoom<HTMLElement>();

  return (
    <section
      ref={softZoomRef}
      className="soft-zoom glass-panel rounded-xl border border-edge overflow-hidden flex flex-col"
    >
      <div className="flex items-center justify-between gap-2 px-4 py-2.5">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          {icon}
          <span>{title}</span>
        </div>
        {actions}
      </div>
      <div className={`flex-1 ${flush ? '' : 'px-4 py-3'}`}>
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        ) : empty ? (
          <CardEmpty title={emptyTitle} illustration={emptyIllustration} />
        ) : (
          children
        )}
      </div>
    </section>
  );
};
