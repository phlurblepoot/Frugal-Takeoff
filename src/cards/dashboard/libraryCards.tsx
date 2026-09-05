// src/cards/dashboard/libraryCards.tsx — the 9 optional Dashboard cards
// (Wave 2 Task 7): dash-project-health, dash-mail-peek, dash-proposals,
// dash-my-hours, dash-payments, dash-aging, dash-quick-actions,
// dash-recent-docs, dash-bid-deadlines. Not part of DEFAULT_LAYOUTS (that's
// Task 6's four core cards) — users add these from the card library.
// Registers itself with the card registry as a side effect on import — see
// src/cards/index.ts's header comment for why that import lives there and
// not in registry.tsx.
import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  HeartPulse, Mail, FileSignature, Clock, Wallet, Hourglass, Zap, FileStack,
  CalendarClock, Plus, ListChecks,
} from 'lucide-react';
import {
  ProjectSummary, OutstandingProposal, TimeEntryLite, DashboardMoney, AttentionItem,
  DocumentRow,
  getProjectsSummary, getOutstandingProposals, getMyTimeEntries, getDashboardMoney,
  getDashboardAttention, getDocuments, clockIn,
} from '../../utils/store';
import { formatMoney } from '../../utils/money';
import { formatCurrency } from '../../pages/project/proposal/proposalGenerator';
import { expiryText } from '../../pages/project/proposal/proposalPresentation';
import { normalizeProjectStatus, ProjectStatusPill, Button } from '../../components/ui';
import { GROUP_DEFS } from '../../pages/ProjectsPage';
import { useMailUnread } from '../../pages/mail/useMailUnread';
import { useToast } from '../../components/Toast';
import { CountUp } from '../../components/motion/CountUp';
import { useLiveQuery } from '../../hooks/useLiveQuery';
import { CardShell } from '../CardShell';
import { registerCards } from '../registry';
import type { CardContext, CardWidth } from '../types';

const DAY = 86_400_000;

// Local, private copies of Dashboard.tsx's timeAgo/startOfWeek/hoursThisWeek —
// importing that module here would import '../cards' (via CardGrid) right
// back, a circular import. Small enough to duplicate rather than restructure
// module boundaries for (same call coreCards.tsx made for timeAgo).
function startOfWeek(now: Date = new Date()): number {
  const d = new Date(now);
  const dow = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
  d.setHours(0, 0, 0, 0);
  return d.getTime() - dow * DAY;
}

function hoursThisWeek(entries: TimeEntryLite[], now: number = Date.now()): number {
  const start = startOfWeek(new Date(now));
  let ms = 0;
  for (const e of entries) {
    if (e.clockIn >= start) ms += (e.clockOut ?? now) - e.clockIn;
  }
  return ms / 3_600_000;
}

// Derived from the pipeline groups so cards can never drift from the Projects
// board on which statuses count as bidding/active. Same derivation coreCards
// uses for BIDDING — importing GROUP_DEFS from ProjectsPage is safe because
// ProjectsPage does not import anything from src/cards.
const BIDDING = GROUP_DEFS.find(g => g.id === 'bidding')!.statuses;
const ACTIVE = GROUP_DEFS.find(g => g.id === 'active')!.statuses;

// ── dash-project-health ──────────────────────────────────────────────────
const ProjectHealthCard: React.FC<{ width: CardWidth; ctx: CardContext }> = ({ width, ctx }) => {
  const [summaries, setSummaries] = useState<ProjectSummary[] | null>(null);

  const load = () => { getProjectsSummary().then(setSummaries).catch(() => setSummaries([])); };
  useLiveQuery(load, { types: ['project', 'issue', 'punch', 'invoice', 'payment', 'aiaPayApp', 'changeOrder'] });

  const loading = summaries === null;
  const active = (summaries ?? [])
    .filter(s => !s.archived && ACTIVE.includes(normalizeProjectStatus(s.status)))
    .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))
    .slice(0, width === 3 ? 8 : 5);

  return (
    <CardShell
      title="Project health"
      icon={<HeartPulse size={13} />}
      loading={loading}
      empty={!loading && active.length === 0}
      emptyTitle="No active projects."
      flush
    >
      <ul className="divide-y divide-edge">
        {active.map(p => {
          const openItems = p.openIssueCount + (p.punchTotal - p.punchDone);
          const showBilled = ctx.isAdmin && p.outstandingCents !== undefined && p.contractValueCents !== undefined && p.contractValueCents > 0;
          const billedPct = showBilled ? Math.round((p.outstandingCents! / p.contractValueCents!) * 100) : null;
          return (
            <li key={p.id}>
              <Link to={`/project/${p.id}`} className="flex items-center justify-between gap-3 px-4 py-2 transition-colors hover:bg-hover">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{p.name}</span>
                  <span className="flex items-center gap-2">
                    <ProjectStatusPill status={p.status} />
                    {billedPct !== null && <span className="text-xs text-ink-faint">{billedPct}% billed</span>}
                  </span>
                </span>
                {openItems > 0 && (
                  <span className="shrink-0 rounded-full bg-sunken px-1.5 py-0.5 text-[11px] font-semibold text-ink-soft">
                    {openItems} open
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </CardShell>
  );
};

// ── dash-mail-peek ────────────────────────────────────────────────────────
const MailPeekCard: React.FC<{ width: CardWidth; ctx: CardContext }> = () => {
  const unread = useMailUnread();

  return (
    <CardShell title="Mail" icon={<Mail size={13} />}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <CountUp value={unread} className="text-2xl font-bold text-ink" />
          <span className="text-sm text-ink-soft">unread</span>
        </div>
        <Link to="/mail" className="shrink-0 text-xs font-medium text-accent-600 hover:underline">Open Mail</Link>
      </div>
    </CardShell>
  );
};

// ── dash-proposals ────────────────────────────────────────────────────────
const ProposalsCard: React.FC<{ width: CardWidth; ctx: CardContext }> = ({ width }) => {
  const [proposals, setProposals] = useState<OutstandingProposal[] | null>(null);

  const load = () => { getOutstandingProposals().then(setProposals).catch(() => setProposals([])); };
  useLiveQuery(load, { types: ['proposal', 'project'] });

  const loading = proposals === null;
  const visible = (proposals ?? []).slice(0, width === 1 ? 4 : 6);

  return (
    <CardShell
      title="Outstanding proposals"
      icon={<FileSignature size={13} />}
      actions={<Link to="/documents?kinds=proposal" className="text-xs font-medium text-accent-600 hover:underline">View all</Link>}
      loading={loading}
      empty={!loading && visible.length === 0}
      emptyTitle="No proposals awaiting a response."
      flush
    >
      <ul className="divide-y divide-edge">
        {visible.map(p => {
          const expiry = expiryText(p);
          const expired = expiry?.startsWith('expired') ?? false;
          return (
            <li key={p.id}>
              <Link to={`/project/${p.projectId}/proposal/${p.id}`} className="flex items-center justify-between gap-3 px-4 py-2 transition-colors hover:bg-hover">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-ink">
                    {p.projectName ?? '—'} · #{p.number}{p.title ? ` — ${p.title}` : ''}
                  </span>
                  {expiry && (
                    <span className={`block truncate text-xs ${expired ? 'text-red-600 dark:text-red-400' : 'text-ink-faint'}`}>
                      {expiry}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-xs font-medium text-ink-soft">{formatCurrency(p.totalCents / 100)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </CardShell>
  );
};

// ── dash-my-hours ─────────────────────────────────────────────────────────
const MyHoursCard: React.FC<{ width: CardWidth; ctx: CardContext }> = () => {
  const [hours, setHours] = useState<number | null>(null);

  const load = () => { getMyTimeEntries().then(e => setHours(hoursThisWeek(e))).catch(() => setHours(0)); };
  useLiveQuery(load, { types: ['timeEntry'] });

  const loading = hours === null;

  return (
    <CardShell
      title="My hours this week"
      icon={<Clock size={13} />}
      actions={<Link to="/time" className="text-xs font-medium text-accent-600 hover:underline">Time tracking</Link>}
      loading={loading}
    >
      {!loading && (
        <div className="flex items-baseline gap-2">
          <CountUp value={hours!} format={v => v.toFixed(1)} className="text-2xl font-bold text-ink" />
          <span className="text-sm text-ink-soft">hours since Monday</span>
        </div>
      )}
    </CardShell>
  );
};

// ── dash-payments ─────────────────────────────────────────────────────────
const PaymentsCard: React.FC<{ width: CardWidth; ctx: CardContext }> = ({ width }) => {
  const [payments, setPayments] = useState<DashboardMoney['recentPayments'] | null>(null);

  const load = () => { getDashboardMoney().then(d => setPayments(d.recentPayments)).catch(() => setPayments([])); };
  useLiveQuery(load, { types: ['payment', 'invoice', 'aiaPayApp'] });

  const loading = payments === null;
  const visible = (payments ?? []).slice(0, width === 1 ? 4 : 6);

  return (
    <CardShell
      title="Recent payments"
      icon={<Wallet size={13} />}
      loading={loading}
      empty={!loading && visible.length === 0}
      emptyTitle="No recent payments."
      flush
    >
      <ul className="divide-y divide-edge">
        {visible.map(p => (
          <li key={p.id}>
            <Link to={`/project/${p.projectId}/billing`} className="flex items-center justify-between gap-3 px-4 py-2 transition-colors hover:bg-hover">
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-ink">{p.projectName}</span>
                <span className="block truncate text-xs text-ink-faint">
                  {new Date(p.date).toLocaleDateString()}{p.method ? ` · ${p.method}` : ''}
                </span>
              </span>
              <span className="shrink-0 text-xs font-medium text-ink-soft">{formatMoney(p.amount)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </CardShell>
  );
};

// ── dash-aging ────────────────────────────────────────────────────────────
interface AgingBuckets { d0_30: number; d31_60: number; d61: number }

function agingBuckets(items: AttentionItem[], now: number = Date.now()): AgingBuckets {
  const buckets: AgingBuckets = { d0_30: 0, d31_60: 0, d61: 0 };
  for (const item of items) {
    if (item.type !== 'aging_receivable') continue;
    const age = Math.floor((now - item.date) / DAY);
    const amount = item.balanceCents ?? 0;
    if (age <= 30) buckets.d0_30 += amount;
    else if (age <= 60) buckets.d31_60 += amount;
    else buckets.d61 += amount;
  }
  return buckets;
}

const AgingCard: React.FC<{ width: CardWidth; ctx: CardContext }> = () => {
  const [items, setItems] = useState<AttentionItem[] | null>(null);

  const load = () => { getDashboardAttention().then(setItems).catch(() => setItems([])); };
  useLiveQuery(load, { types: ['invoice', 'payment', 'aiaPayApp', 'project'] });

  const loading = items === null;
  const receivables = (items ?? []).filter(i => i.type === 'aging_receivable');
  const buckets = agingBuckets(receivables);

  const TILES: { key: keyof AgingBuckets; label: string; tone: string }[] = [
    { key: 'd0_30', label: '0–30 days', tone: 'bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-400/10 dark:border-emerald-400/20 dark:text-emerald-300' },
    { key: 'd31_60', label: '31–60 days', tone: 'bg-amber-50 border-amber-200 text-amber-700 dark:bg-amber-400/10 dark:border-amber-400/20 dark:text-amber-300' },
    { key: 'd61', label: '61+ days', tone: 'bg-red-50 border-red-200 text-red-700 dark:bg-red-400/10 dark:border-red-400/20 dark:text-red-300' },
  ];

  return (
    <CardShell
      title="Aging receivables"
      icon={<Hourglass size={13} />}
      loading={loading}
      empty={!loading && receivables.length === 0}
      emptyTitle="Nothing aging."
    >
      <div className="grid grid-cols-3 gap-2">
        {TILES.map(t => (
          <div key={t.key} data-testid={`aging-bucket-${t.key}`} className={`rounded-lg border p-2.5 ${t.tone}`}>
            <p className="text-[11px] font-medium">{t.label}</p>
            <p className="text-sm font-bold text-ink">{formatMoney(buckets[t.key])}</p>
          </div>
        ))}
      </div>
    </CardShell>
  );
};

// ── dash-quick-actions ────────────────────────────────────────────────────
const QuickActionsCard: React.FC<{ width: CardWidth; ctx: CardContext }> = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [clockingIn, setClockingIn] = useState(false);

  const handleClockIn = async () => {
    setClockingIn(true);
    try {
      await clockIn();
      toast('Clocked in.', { type: 'success' });
    } catch {
      toast('Could not clock in.', { type: 'error' });
    } finally {
      setClockingIn(false);
    }
  };

  return (
    <CardShell title="Quick actions" icon={<Zap size={13} />}>
      <div className="flex flex-col gap-2">
        <Button variant="secondary" size="sm" className="justify-start" onClick={() => navigate('/new')}>
          <Plus size={14} />New Project
        </Button>
        <Button variant="secondary" size="sm" className="justify-start" onClick={() => navigate('/tasks?new=1')}>
          <ListChecks size={14} />New Task
        </Button>
        <Button variant="secondary" size="sm" className="justify-start" onClick={handleClockIn} disabled={clockingIn}>
          <Clock size={14} />Clock in
        </Button>
      </div>
    </CardShell>
  );
};

// ── dash-recent-docs ──────────────────────────────────────────────────────
const RecentDocsCard: React.FC<{ width: CardWidth; ctx: CardContext }> = ({ width }) => {
  const [docs, setDocs] = useState<DocumentRow[] | null>(null);

  const load = () => { getDocuments({ limit: 6 }).then(r => setDocs(r.rows)).catch(() => setDocs([])); };
  useLiveQuery(load, { types: ['file'] });

  const loading = docs === null;
  const visible = (docs ?? []).slice(0, width === 1 ? 4 : 6);

  return (
    <CardShell
      title="Recent documents"
      icon={<FileStack size={13} />}
      actions={<Link to="/documents" className="text-xs font-medium text-accent-600 hover:underline">View all</Link>}
      loading={loading}
      empty={!loading && visible.length === 0}
      emptyTitle="No documents yet."
      flush
    >
      <ul className="divide-y divide-edge">
        {visible.map(d => {
          const context = d.projectName ?? d.customerName;
          return (
            <li key={d.id}>
              <Link to="/documents" className="flex items-center justify-between gap-3 px-4 py-2 transition-colors hover:bg-hover">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{d.name ?? '(untitled)'}</span>
                  <span className="block truncate text-xs text-ink-faint">{context ?? d.kind}</span>
                </span>
                <span className="shrink-0 text-xs text-ink-faint">{new Date(d.createdAt).toLocaleDateString()}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </CardShell>
  );
};

// ── dash-bid-deadlines ────────────────────────────────────────────────────
const BidDeadlinesCard: React.FC<{ width: CardWidth; ctx: CardContext }> = () => {
  const [summaries, setSummaries] = useState<ProjectSummary[] | null>(null);

  const load = () => { getProjectsSummary().then(setSummaries).catch(() => setSummaries([])); };
  useLiveQuery(load, { types: ['project'] });

  const loading = summaries === null;
  const upcoming = (summaries ?? [])
    .filter(s => !s.archived && BIDDING.includes(normalizeProjectStatus(s.status)) && s.bidDueDate !== null)
    .sort((a, b) => a.bidDueDate! - b.bidDueDate!)
    .slice(0, 5);

  return (
    <CardShell
      title="Upcoming bid deadlines"
      icon={<CalendarClock size={13} />}
      loading={loading}
      empty={!loading && upcoming.length === 0}
      emptyTitle="No upcoming deadlines."
      flush
    >
      <ul className="divide-y divide-edge">
        {upcoming.map(p => {
          const overdue = p.bidDueDate! < Date.now();
          return (
            <li key={p.id}>
              <Link to={`/project/${p.id}`} className="flex items-center justify-between gap-3 px-4 py-2 transition-colors hover:bg-hover">
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
    </CardShell>
  );
};

registerCards([
  {
    id: 'dash-project-health', title: 'Project health', icon: HeartPulse, page: 'dashboard',
    widths: [2, 3], defaultWidth: 2, Component: ProjectHealthCard,
  },
  {
    id: 'dash-mail-peek', title: 'Mail', icon: Mail, page: 'dashboard',
    widths: [1, 2], defaultWidth: 1, Component: MailPeekCard,
  },
  {
    id: 'dash-proposals', title: 'Outstanding proposals', icon: FileSignature, page: 'dashboard',
    widths: [1, 2], defaultWidth: 1, adminOnly: true, Component: ProposalsCard,
  },
  {
    id: 'dash-my-hours', title: 'My hours this week', icon: Clock, page: 'dashboard',
    widths: [1], defaultWidth: 1, Component: MyHoursCard,
  },
  {
    id: 'dash-payments', title: 'Recent payments', icon: Wallet, page: 'dashboard',
    widths: [1, 2], defaultWidth: 1, adminOnly: true, Component: PaymentsCard,
  },
  {
    id: 'dash-aging', title: 'Aging receivables', icon: Hourglass, page: 'dashboard',
    widths: [1, 2], defaultWidth: 1, adminOnly: true, Component: AgingCard,
  },
  {
    id: 'dash-quick-actions', title: 'Quick actions', icon: Zap, page: 'dashboard',
    widths: [1], defaultWidth: 1, Component: QuickActionsCard,
  },
  {
    id: 'dash-recent-docs', title: 'Recent documents', icon: FileStack, page: 'dashboard',
    widths: [1, 2], defaultWidth: 1, Component: RecentDocsCard,
  },
  {
    id: 'dash-bid-deadlines', title: 'Upcoming bid deadlines', icon: CalendarClock, page: 'dashboard',
    widths: [1, 2], defaultWidth: 1, Component: BidDeadlinesCard,
  },
]);
