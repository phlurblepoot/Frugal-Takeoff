// src/pages/project/ProjectOverview.tsx
import React, { useEffect, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import {
  Activity as ActivityIcon, AlertCircle, Building2, Calendar, ClipboardCheck, Clock, DollarSign, FileText,
  FolderOpen, MapPin, Ruler, Upload,
} from 'lucide-react';
import { useProjectOutlet } from './ProjectLayout';
import {
  ActivityItem, TimeEntryLite, getActivity, getMyTimeEntries, clockIn,
} from '../../utils/store';
import { ProjectStageControl } from '../../components/ProjectStageControl';
import { useToast } from '../../components/Toast';
import {
  Button, Card, CardBody, CardHeader, EmptyState, Skeleton,
} from '../../components/ui';
import { timeAgo, hoursThisWeek } from '../Dashboard';
import { formatMoney } from '../../utils/money';

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString();

export const ProjectOverview: React.FC = () => {
  const [searchParams] = useSearchParams();
  const { summary, refreshSummary } = useProjectOutlet();
  const { toast } = useToast();
  const isAdmin = (JSON.parse(localStorage.getItem('user') || '{}').role) === 'admin';
  const [activity, setActivity] = useState<ActivityItem[] | null>(null);
  const [entries, setEntries] = useState<TimeEntryLite[] | null>(null);

  const projectId = summary?.id;
  useEffect(() => {
    if (!projectId) return;
    getActivity(8, projectId).then(setActivity).catch(() => setActivity([]));
    getMyTimeEntries(projectId).then(setEntries).catch(() => setEntries([]));
  }, [projectId]);

  // Pre-3b bookmarks looked like /project/:id?tab=takeoffs — forward them.
  const legacyTab = searchParams.get('tab');
  if (legacyTab) return <Navigate to={`takeoff?tab=${encodeURIComponent(legacyTab)}`} replace />;

  const totalHours = entries
    ? entries.reduce((ms, e) => ms + ((e.clockOut ?? Date.now()) - e.clockIn), 0) / 3_600_000
    : null;
  const weekHours = entries ? hoursThisWeek(entries) : null;

  const handleClockIn = async () => {
    if (!projectId) return;
    try {
      await clockIn(projectId);
      toast('Clocked in to this project', { type: 'success' });
      getMyTimeEntries(projectId).then(setEntries).catch(() => {});
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Clock-in failed', { type: 'error' });
    }
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8">
      {/* Header: name + stage */}
      <div className="mb-5">
        {summary ? (
          <>
            <h1 className="text-xl font-bold text-ink">{summary.name}</h1>
            <div className="mt-2">
              <ProjectStageControl
                projectId={summary.id}
                version={summary.version}
                status={summary.status}
                onChanged={() => refreshSummary()}
              />
            </div>
          </>
        ) : (
          <Skeleton className="h-7 w-64" />
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Details */}
        <Card>
          <CardHeader title="Details" />
          <CardBody>
            {!summary ? (
              <div className="space-y-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-5" />)}</div>
            ) : (
              <dl className="space-y-2 text-sm">
                {summary.contractor && (
                  <div className="flex items-center gap-2 text-ink"><Building2 size={14} className="text-ink-faint" />{summary.contractor}</div>
                )}
                {summary.address && (
                  <div className="flex items-center gap-2 text-ink"><MapPin size={14} className="text-ink-faint" />{summary.address}</div>
                )}
                {summary.bidDueDate !== null && (
                  <div className="flex items-center gap-2 text-ink">
                    <Calendar size={14} className="text-ink-faint" />
                    Bid due {fmtDate(summary.bidDueDate)}
                  </div>
                )}
                <div className="flex items-center gap-4 pt-1 text-ink-soft">
                  <span className="flex items-center gap-1.5"><FileText size={14} className="text-ink-faint" />{summary.pageCount} pages</span>
                  <span className="flex items-center gap-1.5"><Ruler size={14} className="text-ink-faint" />{summary.takeoffCount} takeoffs</span>
                  <span className="flex items-center gap-1.5"><AlertCircle size={14} className="text-ink-faint" />{summary.openIssueCount} open issue{summary.openIssueCount === 1 ? '' : 's'}</span>
                  <span className="flex items-center gap-1.5"><ClipboardCheck size={14} className="text-ink-faint" />{summary.punchDone}/{summary.punchTotal} punch</span>
                </div>
                {isAdmin && (summary.contractValueCents ?? 0) > 0 && (
                  <div className="flex items-center gap-2 pt-1 text-ink">
                    <DollarSign size={14} className="text-ink-faint" />
                    Contract value: <span className="font-semibold">{formatMoney(summary.contractValueCents)}</span>
                  </div>
                )}
              </dl>
            )}
          </CardBody>
        </Card>

        {/* Next actions (spec §4.2: stage-aware home with next actions) */}
        <Card>
          <CardHeader title="Actions" />
          <CardBody className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={handleClockIn}>
              <Clock size={15} />Clock in to this project
            </Button>
            <Link to="takeoff"><Button variant="secondary"><Ruler size={15} />Open takeoff</Button></Link>
            <Link to="documents"><Button variant="secondary"><FolderOpen size={15} />Documents</Button></Link>
            <Link to="documents"><Button variant="secondary"><Upload size={15} />Upload a file</Button></Link>
          </CardBody>
        </Card>

        {/* Project activity */}
        <Card>
          <CardHeader title="Activity" actions={<ActivityIcon size={15} className="text-ink-faint" />} />
          <CardBody className="p-0">
            {activity === null ? (
              <div className="space-y-2 p-4">{[0, 1, 2].map(i => <Skeleton key={i} className="h-8" />)}</div>
            ) : activity.length === 0 ? (
              <EmptyState title="No activity yet" description="Events on this project show up here." />
            ) : (
              <ul className="divide-y divide-edge">
                {activity.map(a => (
                  <li key={a.id} className="px-4 py-2.5">
                    <p className="text-sm text-ink">{a.message}</p>
                    <p className="text-xs text-ink-faint">{a.username ? `${a.username} · ` : ''}{timeAgo(a.createdAt)}</p>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        {/* My hours on this project */}
        <Card>
          <CardHeader
            title="My hours on this project"
            actions={<Link to="time" className="text-xs font-medium text-accent-600 hover:underline">Project time</Link>}
          />
          <CardBody>
            {totalHours === null ? (
              <Skeleton className="h-12 w-28" />
            ) : (
              <div className="flex items-baseline gap-2">
                <Clock size={20} className="self-center text-ink-faint" />
                <span className="text-3xl font-bold text-ink">{totalHours.toFixed(1)}</span>
                <span className="text-sm text-ink-soft">hours total · {weekHours!.toFixed(1)} this week</span>
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
};
