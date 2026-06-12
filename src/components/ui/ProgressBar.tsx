// src/components/ui/ProgressBar.tsx
import React from 'react';

// One of the three allowed glow surfaces (spec §5 rule 2).
export const ProgressBar: React.FC<{ value: number; className?: string }> = ({
  value,
  className = '',
}) => {
  const clamped = Math.max(0, Math.min(100, Number.isNaN(value) ? 0 : value));
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={`h-2 w-full overflow-hidden rounded-full bg-sunken ${className}`}
    >
      <div
        className="glow-bar h-full rounded-full transition-[width] duration-300"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
};
