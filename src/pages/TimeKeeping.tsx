import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Clock, LogIn, LogOut, PenLine, Trash2 } from 'lucide-react';

interface TimeEntry {
  id: string;
  userId: string;
  projectId: string | null;
  clockIn: number;
  clockOut: number | null;
  description: string;
  createdAt: number;
}

const formatDuration = (ms: number) => {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m`;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
};

const formatTime = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const formatDateLabel = (ts: number) => {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
};

export const TimeKeeping: React.FC = () => {
  const token = localStorage.getItem('token');
  const loggedInUser = (() => {
    try { const s = localStorage.getItem('user'); return s ? JSON.parse(s) : null; } catch { return null; }
  })();

  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [activeEntry, setActiveEntry] = useState<TimeEntry | null>(null);
  const [duration, setDuration] = useState(0);
  const [showManualForm, setShowManualForm] = useState(false);
  const [manualDate, setManualDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [manualStart, setManualStart] = useState('09:00');
  const [manualEnd, setManualEnd] = useState('17:00');
  const [manualDesc, setManualDesc] = useState('');
  const [clockOutDesc, setClockOutDesc] = useState('');
  const [showClockOutDesc, setShowClockOutDesc] = useState(false);
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

  useEffect(() => { fetchEntries(); }, [fetchEntries]);

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

  const grouped = (() => {
    const groups: { label: string; entries: TimeEntry[] }[] = [];
    const seen: Record<string, number> = {};
    for (const e of entries) {
      const label = formatDateLabel(e.clockIn);
      if (seen[label] === undefined) { seen[label] = groups.length; groups.push({ label, entries: [] }); }
      groups[seen[label]].entries.push(e);
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

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900">
      <div className="max-w-2xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <Clock size={24} className="text-accent-600 dark:text-accent-400" />
            Time Tracking
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Logged in as <span className="font-medium text-slate-700 dark:text-slate-300">{loggedInUser.username}</span>
          </p>
        </div>

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

        {/* Entry list */}
        <div className="flex flex-col gap-6">
          {grouped.length === 0 ? (
            <p className="text-center text-slate-500 dark:text-slate-400 italic py-8">No time entries yet.</p>
          ) : (
            grouped.map(group => (
              <div key={group.label}>
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
                        <div className="flex items-center gap-3">
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
                      <button
                        onClick={() => handleDelete(entry.id)}
                        className="ml-3 opacity-0 group-hover:opacity-100 p-1.5 text-slate-400 hover:text-red-500 transition-all rounded-lg"
                      >
                        <Trash2 size={14} />
                      </button>
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
