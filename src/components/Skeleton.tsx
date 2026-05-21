import React from 'react';

// Base shimmer block. Compose these to mirror the real content's layout so
// there's no jump when data arrives.
export const Skeleton: React.FC<{ className?: string }> = ({ className = '' }) => (
  <div className={`animate-pulse rounded bg-slate-200 dark:bg-slate-700 ${className}`} />
);

// Skeleton for the desktop projects table (7 columns).
export const ProjectTableSkeleton: React.FC<{ rows?: number }> = ({ rows = 6 }) => (
  <div className="hidden md:block bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
    <div className="px-6 py-4 bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700">
      <Skeleton className="h-4 w-32" />
    </div>
    <div className="divide-y divide-slate-100 dark:divide-slate-700/60">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="px-6 py-4 flex items-center gap-6">
          <Skeleton className="h-4 flex-[2]" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-10" />
          <Skeleton className="h-7 w-7 rounded-lg" />
        </div>
      ))}
    </div>
  </div>
);

// Skeleton for the mobile project cards.
export const ProjectCardsSkeleton: React.FC<{ count?: number }> = ({ count = 4 }) => (
  <div className="md:hidden space-y-4">
    {Array.from({ length: count }).map((_, i) => (
      <div key={i} className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-4 shadow-sm space-y-3">
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <div className="flex gap-3 pt-1">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-24" />
        </div>
      </div>
    ))}
  </div>
);
