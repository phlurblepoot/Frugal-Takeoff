import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Menu, Calculator, FileEdit, Sheet, Settings, LogOut, PanelLeftClose } from 'lucide-react';

export type DockState = 'expanded' | 'collapsed' | 'hidden';

interface App {
  id: string;
  label: string;
  Icon: React.FC<{ size?: number; className?: string }>;
  path: string;
  matchRoute: (pathname: string) => boolean;
}

const APPS: App[] = [
  {
    id: 'estimating',
    label: 'Estimating',
    Icon: Calculator,
    path: '/',
    matchRoute: (p) => p === '/' || p === '/new' || p.startsWith('/project'),
  },
  {
    id: 'pdf-editor',
    label: 'PDF Editor',
    Icon: FileEdit,
    path: '/pdf-editor',
    matchRoute: (p) => p.startsWith('/pdf-editor'),
  },
  {
    id: 'spreadsheet-editor',
    label: 'Spreadsheet',
    Icon: Sheet,
    path: '/spreadsheet-editor',
    matchRoute: (p) => p.startsWith('/spreadsheet-editor'),
  },
];

interface SideDockProps {
  state: DockState;
  onChange: (s: DockState) => void;
}

export const SideDock: React.FC<SideDockProps> = ({ state, onChange }) => {
  const location = useLocation();
  const navigate = useNavigate();

  if (location.pathname === '/login' || !localStorage.getItem('token')) {
    return null;
  }

  const user = JSON.parse(localStorage.getItem('user') || '{}');
  const isExpanded = state === 'expanded';

  const handleToggle = () => onChange(state === 'expanded' ? 'collapsed' : 'expanded');
  const handleHide = () => onChange('hidden');
  const handleShow = () => onChange('collapsed');
  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = '/login';
  };

  if (state === 'hidden') {
    return (
      <button
        onClick={handleShow}
        title="Open navigation"
        className="fixed top-4 left-4 z-50 p-2.5 bg-white dark:bg-slate-800 rounded-xl shadow-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-all"
      >
        <Menu size={18} />
      </button>
    );
  }

  return (
    <div
      className={`fixed left-0 top-0 h-full z-40 flex flex-col bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden transition-all duration-200 ${
        isExpanded ? 'w-52' : 'w-16'
      }`}
    >
      {/* Header row */}
      <div className={`flex items-center h-14 px-3 border-b border-slate-200 dark:border-slate-800 shrink-0 ${isExpanded ? 'justify-between' : 'justify-center'}`}>
        <button
          onClick={handleToggle}
          title={isExpanded ? 'Collapse' : 'Expand navigation'}
          className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400 transition-colors"
        >
          <Menu size={18} />
        </button>
        {isExpanded && (
          <button
            onClick={handleHide}
            title="Hide dock"
            className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 dark:text-slate-500 transition-colors"
          >
            <PanelLeftClose size={18} />
          </button>
        )}
      </div>

      {/* App list */}
      <div className="flex-1 py-3 px-2 space-y-1 overflow-y-auto">
        {APPS.map((app) => {
          const isActive = app.matchRoute(location.pathname);
          return (
            <button
              key={app.id}
              onClick={() => navigate(app.path)}
              title={!isExpanded ? app.label : undefined}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                isActive
                  ? 'bg-accent-600 text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              <app.Icon size={20} className="shrink-0" />
              {isExpanded && <span className="truncate">{app.label}</span>}
            </button>
          );
        })}
      </div>

      {/* Bottom: Settings + Logout */}
      <div className="px-2 pb-3 pt-3 border-t border-slate-200 dark:border-slate-800 space-y-1 shrink-0">
        <button
          onClick={() => navigate('/settings')}
          title={!isExpanded ? 'Settings' : undefined}
          className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
            location.pathname === '/settings'
              ? 'bg-accent-600 text-white shadow-sm'
              : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
          }`}
        >
          <Settings size={20} className="shrink-0" />
          {isExpanded && <span className="truncate">Settings</span>}
        </button>

        <button
          onClick={handleLogout}
          title={!isExpanded ? `${user.username || 'User'} — Logout` : undefined}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-600 dark:hover:text-red-400 transition-all"
        >
          <LogOut size={20} className="shrink-0" />
          {isExpanded && (
            <div className="text-left min-w-0">
              <p className="text-sm font-medium truncate">{user.username || 'User'}</p>
              <p className="text-[11px] text-slate-400 dark:text-slate-500">Logout</p>
            </div>
          )}
        </button>
      </div>
    </div>
  );
};
