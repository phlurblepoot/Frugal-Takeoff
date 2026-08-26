import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronDown, ChevronRight, Monitor, Users } from 'lucide-react';
import { useCollaboration } from '../context/CollaborationContext';
import type { SessionView } from '../context/CollaborationContext';
import { groupSessionsByUser, describeLocation } from '../utils/presence';
import { useLiveQuery } from '../hooks/useLiveQuery';
import { getProjectsSummary } from '../utils/store';

export const UserPresenceOverlay: React.FC = () => {
  const { sessions, mySessionId, followedSessionId, setFollowedSessionId } = useCollaboration();
  const [isOpen, setIsOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [projectNames, setProjectNames] = useState<Record<string, string>>({});
  const openedOnceRef = useRef(false);
  const location = useLocation();
  const navigate = useNavigate();

  const loadNames = async () => {
    if (!openedOnceRef.current) return;
    try {
      const list = await getProjectsSummary();
      setProjectNames(Object.fromEntries(list.map(p => [p.id, p.name])));
    } catch { /* names are cosmetic — degrade to 'A project' */ }
  };
  useLiveQuery(loadNames, { types: ['project'] });
  useEffect(() => {
    if (isOpen && !openedOnceRef.current) { openedOnceRef.current = true; void loadNames(); }
  }, [isOpen]);

  // Don't show on the canvas page (it has its own presence list in the sidebar).
  if (location.pathname.includes('/page/')) return null;

  const groups = groupSessionsByUser(sessions, mySessionId);

  const goTo = (path: string | undefined) => {
    if (!path) return;
    navigate(path);
    setIsOpen(false);
  };

  const toggleExpanded = (userId: string) =>
    setExpanded(prev => ({ ...prev, [userId]: !prev[userId] }));

  const followCheckbox = (session: SessionView) => (
    <label
      className="flex shrink-0 items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-ink-faint"
      onClick={(e) => e.stopPropagation()}
    >
      <input
        type="checkbox"
        checked={followedSessionId === session.sessionId}
        onChange={(e) => setFollowedSessionId(e.target.checked ? session.sessionId : null)}
        className="size-3.5 rounded border-edge-strong accent-accent-600"
      />
      Follow
    </label>
  );

  const sessionLocation = (session: SessionView) => (
    <div className="flex min-w-0 items-center gap-1 text-[10px] text-ink-faint">
      <Monitor size={11} className="shrink-0" />
      <span className="truncate">{session.device}</span>
      <span aria-hidden="true">·</span>
      <span className="truncate">{describeLocation(session.location, projectNames)}</span>
    </div>
  );

  return (
    <div className="fixed bottom-6 right-6 z-50">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="relative flex h-12 w-12 items-center justify-center rounded-full border border-edge bg-raised text-ink-soft shadow-lg transition-all hover:text-accent-600 active:scale-95"
      >
        <Users size={22} />
        {groups.length > 0 && (
          <span className="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full border-2 border-raised bg-accent-600 text-[10px] font-bold text-white">
            {groups.length}
          </span>
        )}
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 10 }}
            className="absolute bottom-16 right-0 w-72 overflow-hidden rounded-2xl border border-edge bg-raised shadow-2xl"
          >
            <div className="border-b border-edge px-4 py-3">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
                <Users size={16} className="text-accent-600" />
                Active Users
              </h3>
            </div>

            <div className="max-h-96 overflow-y-auto p-2">
              {groups.length === 0 ? (
                <p className="p-6 text-center text-sm italic text-ink-faint">No other users online</p>
              ) : (
                <div className="space-y-1">
                  {groups.map(group => {
                    const multi = group.sessions.length > 1;
                    const solo = group.sessions[0];
                    return (
                      <div key={group.userId}>
                        <div
                          className={`flex items-center gap-2 rounded-lg p-2 ${multi ? 'cursor-pointer hover:bg-hover' : 'hover:bg-hover'} ${!multi && solo.location?.path ? 'cursor-pointer' : ''}`}
                          onClick={multi ? () => toggleExpanded(group.userId) : () => goTo(solo.location?.path)}
                        >
                          <div
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
                            style={{ backgroundColor: group.color }}
                          >
                            {group.name.charAt(0).toUpperCase()}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-ink">
                              <span>{group.name}</span>
                              {group.isMe && <span className="ml-1.5 text-xs font-normal text-ink-faint">You</span>}
                            </p>
                            {multi
                              ? <p className="text-[10px] text-ink-faint">{group.sessions.length} sessions</p>
                              : sessionLocation(solo)}
                          </div>
                          {multi ? (
                            <button
                              onClick={(e) => { e.stopPropagation(); toggleExpanded(group.userId); }}
                              className="shrink-0 text-ink-faint hover:text-ink"
                            >
                              {expanded[group.userId] ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                            </button>
                          ) : (
                            !group.isMe && followCheckbox(solo)
                          )}
                        </div>

                        {multi && expanded[group.userId] && (
                          <div className="space-y-1">
                            {group.sessions.map(session => (
                              <div
                                key={session.sessionId}
                                className={`ml-9 flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-hover ${session.location?.path ? 'cursor-pointer' : ''}`}
                                onClick={() => goTo(session.location?.path)}
                              >
                                {sessionLocation(session)}
                                {!group.isMe && followCheckbox(session)}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
