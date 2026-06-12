// src/pages/Dashboard.tsx
import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Activity as ActivityIcon, Calendar, Clock, FolderKanban, Plus } from 'lucide-react';
import {
  ProjectSummary, ActivityItem, TimeEntryLite,
  getProjectsSummary, getActivity, getMyTimeEntries,
} from '../utils/store';
import {
  Button, Card, CardBody, CardHeader, EmptyState, ProjectStatusPill, Skeleton,
} from '../components/ui';

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
    if (e.clockIn >= start) ms += (e.clockOut ?? now) - e.clockIn;
  }
  return ms / 3_600_000;
};

const ESTIMATING = ['estimating', 'proposal_sent'];
const ACTIVE = ['awarded', 'in_progress', 'punch_list'];

export const Dashboard: React.FC = () => {
  const navigate = useNavigate();
  const [summaries, setSummaries] = useState<ProjectSummary[] | null>(null);
  const [activity, setActivity] = useState<ActivityItem[] | null>(null);
  const [hours, setHours] = useState<number | null>(null);
  const user = JSON.parse(localStorage.getItem('user') || '{}');

  useEffect(() => {
    getProjectsSummary().then(setSummaries).catch(() => setSummaries([]));
    getActivity(10).then(setActivity).catch(() => setActivity([]));
    getMyTimeEntries().then(e => setHours(hoursThisWeek(e))).catch(() => setHours(0));
  }, []);

  const visible = (summaries ?? []).filter(s => !s.archived);
  const upcoming = visible
    .filter(s => ESTIMATING.includes(s.status) && s.bidDueDate !== null)
    .sort((a, b) => (a.bidDueDate! - b.bidDueDate!))
    .slice(0, 5);
  const activeProjects = visible
    .filter(s => ACTIVE.includes(s.status))
    .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))
    .slice(0, 5);

  const loading = summaries === null;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-8">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink">Dashboard</h1>
          <p className="text-sm text-ink-faint">Welcome back{user.username ? `, ${user.username}` : ''}.</p>
        </div>
        <Button onClick={() => navigate('/new')}><Plus size={16} />New Project</Button>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Upcoming bid deadlines */}
        <Card>
          <CardHeader title="Upcoming bid deadlines" actions={<Calendar size={15} className="text-ink-faint" />} />
          <CardBody className="p-0">
            {loading ? (
              <div className="space-y-2 p-4">{[0, 1, 2].map(i => <Skeleton key={i} className="h-9" />)}</div>
            ) : upcoming.length === 0 ? (
              <EmptyState title="No upcoming deadlines" description="Estimating projects with bid due dates show up here." />
            ) : (
              <ul className="divide-y divide-edge">
                {upcoming.map(p => {
                  const overdue = p.bidDueDate! < Date.now();
                  return (
                    <li key={p.id}>
                      <Link to={`/project/${p.id}`} className="flex items-center justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-hover">
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-ink">{p.name}</span>
                          {p.contractor && <span className="block truncate text-xs text-ink-faint">{p.contractor}</span>}
                        </span>
                        <span className={`shrink-0 text-xs font-medium ${overdue ? 'text-red-600 dark:text-red-400' : 'text-ink-soft'}`}>
                          {new Date(p.bidDueDate!).toLocaleDateString()}{overdue ? ' · overdue' : ''}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardBody>
        </Card>

        {/* Active projects */}
        <Card>
          <CardHeader
            title="Active projects"
            actions={<Link to="/projects" className="text-xs font-medium text-accent-600 hover:underline">View all</Link>}
          />
          <CardBody className="p-0">
            {loading ? (
              <div className="space-y-2 p-4">{[0, 1, 2].map(i => <Skeleton key={i} className="h-9" />)}</div>
            ) : activeProjects.length === 0 ? (
              <EmptyState icon={<FolderKanban size={20} />} title="Nothing in progress" description="Projects move here once they're awarded." />
            ) : (
              <ul className="divide-y divide-edge">
                {activeProjects.map(p => (
                  <li key={p.id}>
                    <Link to={`/project/${p.id}`} className="flex items-center justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-hover">
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-ink">{p.name}</span>
                        {p.contractor && <span className="block truncate text-xs text-ink-faint">{p.contractor}</span>}
                      </span>
                      <ProjectStatusPill status={p.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        {/* Recent activity */}
        <Card>
          <CardHeader title="Recent activity" actions={<ActivityIcon size={15} className="text-ink-faint" />} />
          <CardBody className="p-0">
            {activity === null ? (
              <div className="space-y-2 p-4">{[0, 1, 2].map(i => <Skeleton key={i} className="h-8" />)}</div>
            ) : activity.length === 0 ? (
              <EmptyState title="No activity yet" description="Project events show up here as your team works." />
            ) : (
              <ul className="divide-y divide-edge">
                {activity.map(a => (
                  <li key={a.id} className="px-4 py-2.5">
                    <p className="text-sm text-ink">{a.message}</p>
                    <p className="text-xs text-ink-faint">
                      {a.username ? `${a.username} · ` : ''}{timeAgo(a.createdAt)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        {/* My hours this week */}
        <Card>
          <CardHeader
            title="My hours this week"
            actions={<Link to="/time" className="text-xs font-medium text-accent-600 hover:underline">Time tracking</Link>}
          />
          <CardBody>
            {hours === null ? (
              <Skeleton className="h-12 w-28" />
            ) : (
              <div className="flex items-baseline gap-2">
                <Clock size={20} className="self-center text-ink-faint" />
                <span className="text-3xl font-bold text-ink">{hours.toFixed(1)}</span>
                <span className="text-sm text-ink-soft">hours since Monday</span>
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
};
