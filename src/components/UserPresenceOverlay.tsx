import React, { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Users, X, ExternalLink } from 'lucide-react';
import { useCollaboration } from '../context/CollaborationContext';
import { motion, AnimatePresence } from 'motion/react';

export const UserPresenceOverlay: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const { globalUsers, socket, followedUserId, setFollowedUserId } = useCollaboration();
  const location = useLocation();
  const navigate = useNavigate();

  // Don't show on canvas page (it has its own list in sidebar)
  if (location.pathname.includes('/page/')) return null;

  const otherUsers = globalUsers.filter(u => u.id !== socket?.id);

  return (
    <div className="fixed bottom-6 right-6 z-50">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-12 h-12 bg-white dark:bg-slate-800 rounded-full shadow-lg border border-slate-200 dark:border-slate-700 flex items-center justify-center text-slate-600 dark:text-slate-400 hover:text-blue-600 dark:hover:text-accent-400 hover:border-blue-200 dark:hover:border-accent-600 transition-all active:scale-95 relative"
      >
        <Users size={24} />
        {otherUsers.length > 0 && (
          <span className="absolute -top-1 -right-1 w-5 h-5 bg-blue-600 text-white text-[10px] font-bold flex items-center justify-center rounded-full border-2 border-white dark:border-slate-800">
            {otherUsers.length}
          </span>
        )}
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 10 }}
            className="absolute bottom-16 right-0 w-72 bg-white dark:bg-slate-800 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 overflow-hidden"
          >
            <div className="p-4 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between bg-slate-50/50 dark:bg-slate-900/50">
              <h3 className="font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                <Users size={18} className="text-blue-600 dark:text-accent-400" />
                Active Users
              </h3>
              <button onClick={() => setIsOpen(false)} className="text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300">
                <X size={18} />
              </button>
            </div>

            <div className="max-h-96 overflow-y-auto p-2">
              {otherUsers.length === 0 ? (
                <div className="p-8 text-center">
                  <p className="text-sm text-slate-500 dark:text-slate-400 italic">No other users online</p>
                </div>
              ) : (
                <div className="space-y-1">
                  {otherUsers.map(user => (
                    <div
                      key={user.id}
                      className="group flex items-center justify-between p-2 rounded-xl hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
                    >
                      <div
                        className="flex items-center gap-3 min-w-0 cursor-pointer flex-1"
                        onClick={() => {
                          navigate(user.pageId);
                          setIsOpen(false);
                        }}
                      >
                        <div className="relative">
                          <div
                            className="w-8 h-8 rounded-full flex items-center justify-center text-white font-bold text-xs"
                            style={{ backgroundColor: user.color }}
                          >
                            {user.name.charAt(0).toUpperCase()}
                          </div>
                          <div className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 bg-green-500 border-2 border-white dark:border-slate-800 rounded-full"></div>
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-slate-900 dark:text-white truncate">{user.name}</p>
                          <p className="text-[10px] text-slate-500 dark:text-slate-400 truncate flex items-center gap-1">
                            <ExternalLink size={10} />
                            {user.pageName || (user.pageId === '/' ? 'Home' : user.pageId.split('/').pop())}
                          </p>
                        </div>
                      </div>

                      <label className="flex items-center gap-1.5 cursor-pointer p-1.5 rounded-lg hover:bg-white dark:hover:bg-slate-600 border border-transparent hover:border-slate-200 dark:hover:border-slate-600 transition-all">
                        <input
                          type="checkbox"
                          checked={followedUserId === user.id}
                          onChange={(e) => setFollowedUserId(e.target.checked ? user.id : null)}
                          className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                        />
                        <span className={`text-[10px] font-bold uppercase tracking-wider ${followedUserId === user.id ? 'text-blue-600 dark:text-accent-400' : 'text-slate-400 dark:text-slate-500'}`}>
                          {followedUserId === user.id ? 'Following' : 'Follow'}
                        </span>
                      </label>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="p-3 bg-slate-50 dark:bg-slate-900 border-t border-slate-100 dark:border-slate-700 text-[10px] text-slate-400 dark:text-slate-500 text-center">
              Click a user to jump to their page
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
