import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Clock, LogIn, LogOut, PenLine, Trash2, ChevronLeft, ChevronRight, Users, User as UserIcon } from 'lucide-react';

interface TimeEntry {
  id: string;
  userId: string;
  projectId: string | null;
  clockIn: number;
  clockOut: number | null;
  description: string;
  createdAt: number;
  username?: string; // Present on admin /all endpoint responses
}

interface UserData {
  id: string;
  username: string;
  role: string;
}

const formatDuration = (ms: number) => {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m`;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
};

const formatHoursShort = (ms: number) => {
  const h = ms / 3_600_000;
  if (h < 1) {
    const m = Math.round(ms / 60_000);
    return `${m}m`;
  }
  return `${h.toFixed(h < 10 ? 1 : 0)}h`;
};

const formatTime = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

const formatDateLabel = (ts: number) => {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(d, today)) return 'Today';
  if (sameDay(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
};

// Build a 6×7 grid of dates covering the visible month, padded with neighbouring days.
const buildMonthGrid = (year: number, month: number) => {
  const first = new Date(year, month, 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay()); // back up to the Sunday on/before the 1st
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    cells.push(d);
  }
  return cells;
};

interface CalendarProps {
  entries: TimeEntry[];
  selectedDate: Date | null;
  onSelectDate: (d: Date | null) => void;
}

const CalendarHeatmap: React.FC<CalendarProps> = ({ entries, selectedDate, onSelectDate }) => {
  const [cursor, setCursor] = useState(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), 1);
  });

  const totalsByDay = useMemo(() => {
    const map: Record<string, number> = {};
    for (const e of entries) {
      if (!e.clockOut) continue;
      const k = new Date(e.clockIn).toDateString();
      map[k] = (map[k] || 0) + (e.clockOut - e.clockIn);
    }
    return map;
  }, [entries]);

  const maxMs = useMemo(() => Math.max(0, ...Object.values(totalsByDay)), [totalsByDay]);

  const cells = buildMonthGrid(cursor.getFullYear(), cursor.getMonth());
  const today = new Date();

  const intensity = (ms: number) => {
    if (ms <= 0 || maxMs <= 0) return 0;
    return Math.min(1, ms / maxMs);
  };

  const cellBg = (ms: number, isCurrentMonth: boolean) => {
    if (!isCurrentMonth) return 'bg-slate-50/50 dark:bg-slate-800/30';
    const t = intensity(ms);
    if (t === 0) return 'bg-white dark:bg-slate-800';
    // Five intensity buckets using accent palette
    if (t < 0.2) return 'bg-accent-50 dark:bg-accent-900/30';
    if (t < 0.4) return 'bg-accent-100 dark:bg-accent-800/50';
    if (t < 0.6) return 'bg-accent-200 dark:bg-accent-700/60';
    if (t < 0.8) return 'bg-accent-400 dark:bg-accent-600/80';
    return 'bg-accent-500 dark:bg-accent-500';
  };

  return (
    <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <button
          onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
          className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-400 transition-colors"
        >
          <ChevronLeft size={16} />
        </button>
        <h3 className="text-sm font-semibold text-slate-800 dark:text-white">
          {cursor.toLocaleDateString([], { month: 'long', year: 'numeric' })}
        </h3>
        <button
          onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
          className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-400 transition-colors"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1 mb-1">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
          <div key={i} className="text-[10px] font-bold text-slate-400 dark:text-slate-500 text-center uppercase tracking-wider">{d}</div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {cells.map((d, i) => {
          const isCurrentMonth = d.getMonth() === cursor.getMonth();
          const ms = totalsByDay[d.toDateString()] || 0;
          const isToday = sameDay(d, today);
          const isSelected = selectedDate && sameDay(d, selectedDate);
          const intense = isCurrentMonth ? intensity(ms) : 0;
          return (
            <button
              key={i}
              onClick={() => onSelectDate(isSelected ? null : d)}
              title={ms > 0 ? `${d.toLocaleDateString()} — ${formatDuration(ms)}` : d.toLocaleDateString()}
              className={`aspect-square rounded-lg flex flex-col items-center justify-center text-[11px] font-medium transition-all border ${
                cellBg(ms, isCurrentMonth)
              } ${
                isCurrentMonth ? '' : 'opacity-50'
              } ${
                isSelected
                  ? 'border-accent-600 ring-2 ring-accent-500'
                  : isToday
                  ? 'border-accent-400 dark:border-accent-500'
                  : 'border-transparent'
              } hover:border-accent-300 dark:hover:border-accent-700`}
            >
              <span className={`leading-none ${
                intense > 0.5 ? 'text-white' : 'text-slate-700 dark:text-slate-200'
              }`}>{d.getDate()}</span>
              {ms > 0 && (
                <span className={`text-[9px] mt-0.5 leading-none tabular-nums ${
                  intense > 0.5 ? 'text-white/90' : 'text-slate-500 dark:text-slate-400'
                }`}>{formatHoursShort(ms)}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export const TimeKeeping: React.FC = () => {
  const token = localStorage.getItem('token');
  const loggedInUser = (() => {
    try { const s = localStorage.getItem('user'); return s ? JSON.parse(s) : null; } catch { return null; }
  })();
  const isAdmin = loggedInUser?.role === 'admin';

  const [view, setView] = useState<'me' | 'team'>('me');
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [teamEntries, setTeamEntries] = useState<TimeEntry[]>([]);
  const [activeEntry, setActiveEntry] = useState<TimeEntry | null>(null);
  const [duration, setDuration] = useState(0);
  const [showManualForm, setShowManualForm] = useState(false);
  const [manualDate, setManualDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [manualStart, setManualStart] = useState('09:00');
  const [manualEnd, setManualEnd] = useState('17:00');
  const [manualDesc, setManualDesc] = useState('');
  const [clockOutDesc, setClockOutDesc] = useState('');
  const [showClockOutDesc, setShowClockOutDesc] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [users, setUsers] = useState<UserData[]>([]);
  const [selectedTeamUserId, setSelectedTeamUserId] = useState<string>('all');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchEntries = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch('/api/time-entries', { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return;
      const data: TimeEntry[] = await res.json();
      setEntries(data);
      setActiveEntry(data.find(e => e.clockOut === null) ?? null);
    } catch {}
  }, [token]);

  const fetchTeamEntries = useCallback(async () => {
    if (!token || !isAdmin) return;
    try {
      const url = selectedTeamUserId === 'all'
        ? '/api/time-entries/all'
        : `/api/time-entries/all?userId=${encodeURIComponent(selectedTeamUserId)}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return;
      const data: TimeEntry[] = await res.json();
      setTeamEntries(data);
    } catch {}
  }, [token, isAdmin, selectedTeamUserId]);

  const fetchUsers = useCallback(async () => {
    if (!token || !isAdmin) return;
    try {
      const res = await fetch('/api/users', { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return;
      const data: UserData[] = await res.json();
      setUsers(data);
    } catch {}
  }, [token, isAdmin]);

  useEffect(() => { fetchEntries(); }, [fetchEntries]);
  useEffect(() => { if (view === 'team') { fetchUsers(); fetchTeamEntries(); } }, [view, fetchUsers, fetchTeamEntries]);

  useEffect(() => {
    if (activeEntry) {
      const tick = () => setDuration(Date.now() - activeEntry.clockIn);
      tick();
      timerRef.current = setInterval(tick, 1000);
    } else {
      setDuration(0);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [activeEntry]);

  const handleClockIn = async () => {
    if (!token) return;
    try {
      const res = await fetch('/api/time-entries/clock-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      });
      if (!res.ok) return;
      const entry: TimeEntry = await res.json();
      setActiveEntry(entry);
      setEntries(prev => [entry, ...prev]);
    } catch {}
  };

  const handleClockOut = async () => {
    if (!token || !activeEntry) return;
    try {
      const res = await fetch('/api/time-entries/clock-out', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ description: clockOutDesc }),
      });
      if (!res.ok) return;
      const updated: TimeEntry = await res.json();
      setActiveEntry(null);
      setEntries(prev => prev.map(e => e.id === updated.id ? updated : e));
      setClockOutDesc('');
      setShowClockOutDesc(false);
    } catch {}
  };

  const handleManualEntry = async () => {
    if (!token) return;
    const clockIn = new Date(`${manualDate}T${manualStart}`).getTime();
    const clockOut = new Date(`${manualDate}T${manualEnd}`).getTime();
    if (isNaN(clockIn) || isNaN(clockOut) || clockOut <= clockIn) return;
    try {
      const res = await fetch('/api/time-entries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ clockIn, clockOut, description: manualDesc }),
      });
      if (!res.ok) return;
      const entry: TimeEntry = await res.json();
      setEntries(prev => [entry, ...prev].sort((a, b) => b.clockIn - a.clockIn));
      setShowManualForm(false);
      setManualDesc('');
    } catch {}
  };

  const handleDelete = async (id: string) => {
    if (!token) return;
    try {
      await fetch(`/api/time-entries/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      setEntries(prev => prev.filter(e => e.id !== id));
      if (activeEntry?.id === id) setActiveEntry(null);
    } catch {}
  };

  if (!loggedInUser) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-900 flex items-center justify-center">
        <div className="text-center text-slate-500 dark:text-slate-400">
          <Clock size={48} className="mx-auto mb-4 opacity-30" />
          <p className="text-lg font-medium">Please log in to use time tracking.</p>
        </div>
      </div>
    );
  }

  // Source the right entry list for the calendar/list based on view + filter
  const sourceEntries = view === 'team' ? teamEntries : entries;

  // Filter to selected calendar day if any
  const visibleEntries = selectedDate
    ? sourceEntries.filter(e => sameDay(new Date(e.clockIn), selectedDate))
    : sourceEntries;

  // Group entries by day-label for the list
  const grouped = (() => {
    const groups: { label: string; key: string; entries: TimeEntry[] }[] = [];
    const seen: Record<string, number> = {};
    for (const e of visibleEntries) {
      const key = new Date(e.clockIn).toDateString();
      if (seen[key] === undefined) {
        seen[key] = groups.length;
        groups.push({ key, label: formatDateLabel(e.clockIn), entries: [] });
      }
      groups[seen[key]].entries.push(e);
    }
    return groups;
  })();

  const todayMs = entries
    .filter(e => e.clockOut && formatDateLabel(e.clockIn) === 'Today')
    .reduce((s, e) => s + (e.clockOut! - e.clockIn), 0);

  const weekMs = entries
    .filter(e => e.clockOut)
    .filter(e => {
      const d = new Date(e.clockIn);
      const now = new Date();
      const startOfWeek = new Date(now);
      startOfWeek.setDate(now.getDate() - now.getDay());
      startOfWeek.setHours(0, 0, 0, 0);
      return d >= startOfWeek;
    })
    .reduce((s, e) => s + (e.clockOut! - e.clockIn), 0);

  // Per-user totals for the team view summary
  const teamTotals = useMemo(() => {
    if (view !== 'team') return [] as { userId: string; username: string; ms: number; entryCount: number }[];
    const map: Record<string, { username: string; ms: number; count: number }> = {};
    for (const e of teamEntries) {
      if (!e.clockOut) continue;
      const k = e.userId;
      if (!map[k]) map[k] = { username: e.username || 'Unknown', ms: 0, count: 0 };
      map[k].ms += e.clockOut - e.clockIn;
      map[k].count += 1;
    }
    return Object.entries(map)
      .map(([userId, v]) => ({ userId, username: v.username, ms: v.ms, entryCount: v.count }))
      .sort((a, b) => b.ms - a.ms);
  }, [view, teamEntries]);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900">
      <div className="max-w-2xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Clock size={24} className="text-accent-600 dark:text-accent-400" />
            Time Tracking
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Logged in as <span className="font-medium text-slate-700 dark:text-slate-300">{loggedInUser.username}</span>
          </p>
        </div>

        {/* Admin tab toggle */}
        {isAdmin && (
          <div className="flex gap-1 p-1 bg-slate-200/70 dark:bg-slate-800 rounded-xl mb-6 w-fit">
            <button
              onClick={() => { setView('me'); setSelectedDate(null); }}
              className={`flex items-center gap-2 px-4 py-1.5 text-sm font-medium rounded-lg transition-all ${
                view === 'me'
                  ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
            >
              <UserIcon size={14} /> My Time
            </button>
            <button
              onClick={() => { setView('team'); setSelectedDate(null); }}
              className={`flex items-center gap-2 px-4 py-1.5 text-sm font-medium rounded-lg transition-all ${
                view === 'team'
                  ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
            >
              <Users size={14} /> Team Time
            </button>
          </div>
        )}

        {view === 'me' ? (
          <>
            {/* Summary row */}
            <div className="grid grid-cols-2 gap-4 mb-6">
              <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-4">
                <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">Today</p>
                <p className="text-2xl font-bold text-slate-800 dark:text-white tabular-nums">
                  {todayMs > 0 ? formatDuration(todayMs) : '—'}
                </p>
              </div>
              <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-4">
                <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1">This Week</p>
                <p className="text-2xl font-bold text-slate-800 dark:text-white tabular-nums">
                  {weekMs > 0 ? formatDuration(weekMs) : '—'}
                </p>
              </div>
            </div>

            {/* Clock in/out card */}
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 mb-6 shadow-sm">
              {activeEntry ? (
                <div className="flex flex-col items-center gap-4">
                  <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
                    <div className="w-2.5 h-2.5 rounded-full bg-green-500 animate-pulse" />
                    <span className="text-sm font-semibold uppercase tracking-wider">Clocked In</span>
                  </div>
                  <p className="text-5xl font-mono font-bold text-slate-800 dark:text-white tabular-nums">
                    {formatDuration(duration)}
                  </p>
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    Since {formatTime(activeEntry.clockIn)}
                  </p>
                  {showClockOutDesc ? (
                    <div className="w-full flex flex-col gap-2">
                      <input
                        type="text"
                        value={clockOutDesc}
                        onChange={e => setClockOutDesc(e.target.value)}
                        placeholder="What did you work on? (optional)"
                        className="w-full text-sm border border-slate-200 dark:border-slate-600 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-slate-50 dark:bg-slate-700 dark:text-white dark:placeholder-slate-500"
                        onKeyDown={e => e.key === 'Enter' && handleClockOut()}
                        autoFocus
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={handleClockOut}
                          className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-red-500 hover:bg-red-600 text-white text-sm font-semibold rounded-xl transition-colors shadow-sm"
                        >
                          <LogOut size={16} />
                          Clock Out
                        </button>
                        <button
                          onClick={() => setShowClockOutDesc(false)}
                          className="px-4 py-2.5 text-sm text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 rounded-xl transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => setShowClockOutDesc(true)}
                      className="flex items-center gap-2 px-8 py-3 bg-red-500 hover:bg-red-600 text-white text-sm font-semibold rounded-xl transition-colors shadow-sm"
                    >
                      <LogOut size={16} />
                      Clock Out
                    </button>
                  )}
                </div>
              ) : (
                <div className="flex flex-col items-center gap-4">
                  <div className="w-16 h-16 rounded-full bg-slate-100 dark:bg-slate-700 flex items-center justify-center">
                    <Clock size={28} className="text-slate-400 dark:text-slate-500" />
                  </div>
                  <p className="text-slate-500 dark:text-slate-400 text-sm">Not currently clocked in</p>
                  <button
                    onClick={handleClockIn}
                    className="flex items-center gap-2 px-8 py-3 bg-green-500 hover:bg-green-600 text-white text-sm font-semibold rounded-xl transition-colors shadow-sm"
                  >
                    <LogIn size={16} />
                    Clock In
                  </button>
                </div>
              )}
            </div>

            {/* Manual entry */}
            <div className="mb-6">
              <button
                onClick={() => setShowManualForm(v => !v)}
                className="flex items-center gap-2 text-sm text-accent-600 dark:text-accent-400 hover:text-accent-700 font-medium"
              >
                <PenLine size={15} />
                {showManualForm ? 'Cancel manual entry' : 'Add manual entry'}
              </button>

              {showManualForm && (
                <div className="mt-3 bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-4 flex flex-col gap-3 shadow-sm">
                  <div>
                    <label className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5 block">Date</label>
                    <input
                      type="date"
                      value={manualDate}
                      onChange={e => setManualDate(e.target.value)}
                      className="w-full text-sm border border-slate-200 dark:border-slate-600 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-slate-50 dark:bg-slate-700 dark:text-white"
                    />
                  </div>
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <label className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5 block">Start Time</label>
                      <input
                        type="time"
                        value={manualStart}
                        onChange={e => setManualStart(e.target.value)}
                        className="w-full text-sm border border-slate-200 dark:border-slate-600 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-slate-50 dark:bg-slate-700 dark:text-white"
                      />
                    </div>
                    <div className="flex-1">
                      <label className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5 block">End Time</label>
                      <input
                        type="time"
                        value={manualEnd}
                        onChange={e => setManualEnd(e.target.value)}
                        className="w-full text-sm border border-slate-200 dark:border-slate-600 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-slate-50 dark:bg-slate-700 dark:text-white"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5 block">Description (optional)</label>
                    <input
                      type="text"
                      value={manualDesc}
                      onChange={e => setManualDesc(e.target.value)}
                      placeholder="What did you work on?"
                      className="w-full text-sm border border-slate-200 dark:border-slate-600 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-slate-50 dark:bg-slate-700 dark:text-white dark:placeholder-slate-500"
                      onKeyDown={e => e.key === 'Enter' && handleManualEntry()}
                    />
                  </div>
                  <button
                    onClick={handleManualEntry}
                    className="w-full py-2.5 text-sm font-semibold text-white bg-accent-600 hover:bg-accent-700 rounded-xl transition-colors"
                  >
                    Save Entry
                  </button>
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            {/* Team filter row */}
            <div className="flex items-center justify-between gap-3 mb-6">
              <select
                value={selectedTeamUserId}
                onChange={e => { setSelectedTeamUserId(e.target.value); setSelectedDate(null); }}
                className="text-sm border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2 bg-white dark:bg-slate-800 dark:text-white focus:outline-none focus:ring-2 focus:ring-accent-500"
              >
                <option value="all">All users</option>
                {users.map(u => (
                  <option key={u.id} value={u.id}>{u.username}{u.role === 'admin' ? ' (admin)' : ''}</option>
                ))}
              </select>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {teamEntries.length} {teamEntries.length === 1 ? 'entry' : 'entries'}
              </p>
            </div>

            {/* Per-user summary tiles (only when viewing all) */}
            {selectedTeamUserId === 'all' && teamTotals.length > 0 && (
              <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-4 mb-6 shadow-sm">
                <h3 className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-3">Totals by User</h3>
                <div className="flex flex-col divide-y divide-slate-100 dark:divide-slate-700">
                  {teamTotals.map(t => (
                    <div key={t.userId} className="flex items-center justify-between py-2 first:pt-0 last:pb-0">
                      <div className="flex items-center gap-2">
                        <UserIcon size={14} className="text-slate-400 dark:text-slate-500" />
                        <span className="text-sm font-medium text-slate-700 dark:text-slate-300">{t.username}</span>
                        <span className="text-xs text-slate-400 dark:text-slate-500">· {t.entryCount} {t.entryCount === 1 ? 'entry' : 'entries'}</span>
                      </div>
                      <span className="text-sm font-semibold text-slate-800 dark:text-white tabular-nums">{formatDuration(t.ms)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* Calendar */}
        <div className="mb-6">
          <CalendarHeatmap
            entries={sourceEntries}
            selectedDate={selectedDate}
            onSelectDate={setSelectedDate}
          />
          {selectedDate && (
            <div className="mt-2 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
              <span>Showing entries for {selectedDate.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</span>
              <button
                onClick={() => setSelectedDate(null)}
                className="text-accent-600 dark:text-accent-400 font-medium hover:underline"
              >
                Clear filter
              </button>
            </div>
          )}
        </div>

        {/* Entry list */}
        <div className="flex flex-col gap-6">
          {grouped.length === 0 ? (
            <p className="text-center text-slate-500 dark:text-slate-400 italic py-8">
              {view === 'team' ? 'No entries for this filter.' : 'No time entries yet.'}
            </p>
          ) : (
            grouped.map(group => (
              <div key={group.key}>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                    {group.label}
                  </h3>
                  <span className="text-xs text-slate-500 dark:text-slate-400 font-medium tabular-nums">
                    {formatDuration(
                      group.entries
                        .filter(e => e.clockOut)
                        .reduce((s, e) => s + (e.clockOut! - e.clockIn), 0)
                    )}
                  </span>
                </div>
                <div className="flex flex-col gap-2">
                  {group.entries.map(entry => (
                    <div
                      key={entry.id}
                      className="group flex items-center justify-between bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl px-4 py-3 shadow-sm"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-3 flex-wrap">
                          {view === 'team' && entry.username && (
                            <span className="text-xs font-semibold text-accent-700 dark:text-accent-400 bg-accent-50 dark:bg-accent-900/30 px-2 py-0.5 rounded-md">
                              {entry.username}
                            </span>
                          )}
                          <span className="text-sm font-medium text-slate-700 dark:text-slate-300 tabular-nums">
                            {formatTime(entry.clockIn)} – {entry.clockOut ? formatTime(entry.clockOut) : (
                              <span className="text-green-500">running</span>
                            )}
                          </span>
                          {entry.clockOut && (
                            <span className="text-xs text-slate-400 dark:text-slate-500 tabular-nums">
                              {formatDuration(entry.clockOut - entry.clockIn)}
                            </span>
                          )}
                        </div>
                        {entry.description && (
                          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate">{entry.description}</p>
                        )}
                      </div>
                      {view === 'me' && (
                        <button
                          onClick={() => handleDelete(entry.id)}
                          className="ml-3 opacity-0 group-hover:opacity-100 p-1.5 text-slate-400 hover:text-red-500 transition-all rounded-lg"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
