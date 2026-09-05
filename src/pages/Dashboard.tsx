// src/pages/Dashboard.tsx
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { Button } from '../components/ui';
import { CardGrid } from '../cards';
import type { TimeEntryLite } from '../utils/store';

const DAY = 86_400_000;

export const timeAgo = (ms: number): string => {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / DAY)}d ago`;
};

// Monday 00:00 local time of the week containing `now`.
export const startOfWeek = (now: Date = new Date()): number => {
  const d = new Date(now);
  const dow = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
  d.setHours(0, 0, 0, 0);
  return d.getTime() - dow * DAY;
};

export const hoursThisWeek = (entries: TimeEntryLite[], now: number = Date.now()): number => {
  const start = startOfWeek(new Date(now));
  let ms = 0;
  for (const e of entries) {
    // An entry is charged to the week it STARTED in (a Sun→Mon overnight
    // shift counts toward last week) — intended for contractor billing.
    if (e.clockIn >= start) ms += (e.clockOut ?? now) - e.clockIn;
  }
  return ms / 3_600_000;
};

export const Dashboard: React.FC = () => {
  const navigate = useNavigate();
  const isAdmin = (JSON.parse(localStorage.getItem('user') || '{}').role) === 'admin';
  const user = JSON.parse(localStorage.getItem('user') || '{}');

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-8">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink">Dashboard</h1>
          <p className="text-sm text-ink-faint">Welcome back{user.username ? `, ${user.username}` : ''}.</p>
        </div>
        <Button onClick={() => navigate('/new')}><Plus size={16} />New Project</Button>
      </div>

      <CardGrid page="dashboard" ctx={{ isAdmin }} />
    </div>
  );
};
