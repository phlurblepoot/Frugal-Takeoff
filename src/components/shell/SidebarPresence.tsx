// src/components/shell/SidebarPresence.tsx
// Unified presence (rehaul spec §4): the one home for "who's online".
// Replaces the floating UserPresenceOverlay bubble and the canvas
// tool-pane Collaboration block. Popover is portaled to <body> because
// the sidebar clips (overflow-hidden).
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { useCollaboration } from '../../context/CollaborationContext';
import { groupSessionsByUser, describeLocation } from '../../utils/presence';
import { getProjectsSummary } from '../../utils/store';
import { useLiveQuery } from '../../hooks/useLiveQuery';

export const SidebarPresence: React.FC<{ expanded: boolean }> = ({ expanded }) => {
  const { sessions, mySessionId, followedSessionId, setFollowedSessionId, updateUser } = useCollaboration();
  const [open, setOpen] = useState(false);
  const [projectNames, setProjectNames] = useState<Record<string, string>>({});
  const [color, setColor] = useState(() => localStorage.getItem('userColor') || '#6366f1');

  const loadNames = () => {
    getProjectsSummary()
      .then(list => setProjectNames(Object.fromEntries(list.map((p: { id: string; name: string }) => [p.id, p.name]))))
      .catch(() => {});
  };
  useLiveQuery(loadNames, { types: ['project'] });

  // Close on route-level clicks elsewhere (cheap: close on Escape + backdrop).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // groupSessionsByUser omits the caller's own current-tab session entirely
  // (it only surfaces a self group — sessions sharing my userId minus my own
  // literal session — when a *second* tab of mine is open) — the sidebar
  // needs a permanent self row (for the cursor-color picker) and an
  // inclusive "N online" count, so we splice that current-tab session back
  // in, MERGED with any other same-account sessions groupSessionsByUser
  // already found, rather than discarding them.
  const mySession = sessions.find(s => s.sessionId === mySessionId) ?? null;
  const allGroups = groupSessionsByUser(sessions, mySessionId);
  const selfGroup = allGroups.find(g => g.isMe);
  const otherGroups = allGroups.filter(g => !g.isMe);
  const groups = mySession
    ? [{
        userId: mySession.userId, name: mySession.name, color: mySession.color, isMe: true,
        sessions: [mySession, ...(selfGroup?.sessions ?? [])],
      }, ...otherGroups]
    : otherGroups;
  const count = groups.length;
  const user = JSON.parse(localStorage.getItem('user') || '{}');

  const pickColor = (hex: string) => {
    setColor(hex);
    localStorage.setItem('userColor', hex);
    updateUser(user.username || 'User', hex);
  };

  return (
    <>
      <button
        data-testid="sidebar-presence"
        onClick={() => setOpen(o => !o)}
        title={!expanded ? `${count} online` : undefined}
        className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-ink-soft hover:bg-hover hover:text-ink transition-colors"
      >
        <span className="flex shrink-0 -space-x-2">
          {groups.slice(0, 3).map(g => (
            <span
              key={g.userId}
              className="flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-bold text-white ring-2 ring-surface"
              style={{ backgroundColor: g.sessions[0]?.color || '#6366f1' }}
            >
              {(g.name || '?').charAt(0).toUpperCase()}
            </span>
          ))}
        </span>
        {expanded && <span className="flex-1 truncate text-left">{count} online</span>}
        {expanded && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.9)]" />}
      </button>

      {createPortal(
        <AnimatePresence>
          {open && (
            <>
              <div className="fixed inset-0 z-[80]" onClick={() => setOpen(false)} />
              <motion.div
                data-testid="presence-popover"
                initial={{ opacity: 0, y: 8, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.97 }}
                transition={{ duration: 0.15 }}
                className={`fixed bottom-24 z-[81] w-72 rounded-2xl border border-edge glass-panel shadow-xl overflow-hidden ${expanded ? 'left-2' : 'left-16'}`}
              >
                <p className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Online now — {count}
                </p>
                <div className="max-h-72 overflow-y-auto pb-2">
                  {groups.map(g => (
                    <div key={g.userId} className="px-4 py-2 flex items-start gap-2.5">
                      <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: g.sessions[0]?.color }} />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-ink truncate">{g.isMe ? `${g.name} (you)` : g.name}</p>
                        {g.sessions.map(s => (
                          <p key={s.sessionId} className="text-[11px] text-ink-faint truncate">
                            {describeLocation(s.location, projectNames)} · {s.device}
                          </p>
                        ))}
                        {g.isMe && (
                          <label className="mt-1 flex items-center gap-2 text-[11px] text-ink-soft">
                            Cursor color
                            <input
                              type="color"
                              value={color}
                              onChange={e => pickColor(e.target.value)}
                              className="h-5 w-8 cursor-pointer rounded border border-edge bg-transparent"
                            />
                          </label>
                        )}
                      </div>
                      {!g.isMe && g.sessions.length === 1 && (
                        <label className="flex items-center gap-1 text-[11px] text-ink-soft shrink-0">
                          <input
                            type="checkbox"
                            aria-label={`Follow ${g.name}`}
                            className="accent-accent-600"
                            checked={followedSessionId === g.sessions[0].sessionId}
                            onChange={e => setFollowedSessionId(e.target.checked ? g.sessions[0].sessionId : null)}
                          />
                          Follow
                        </label>
                      )}
                    </div>
                  ))}
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  );
};
