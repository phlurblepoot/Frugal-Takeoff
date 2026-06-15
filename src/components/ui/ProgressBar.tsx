// src/components/ui/ProgressBar.tsx
import React from 'react';

export const ProgressBar: React.FC<{ done: number; total: number; className?: string }> = ({
  done,
  total,
  className = '',
}) => {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-sunken">
        <div
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          className="glow-bar h-full rounded-full transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="shrink-0 text-xs tabular-nums text-ink-faint">{done} / {total}</span>
    </div>
  );
};
