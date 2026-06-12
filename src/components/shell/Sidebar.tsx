// src/components/shell/Sidebar.tsx
import React from 'react';
import { useLocation, useNavigate, matchPath } from 'react-router-dom';
import {
  Menu, PanelLeftClose, Search, FolderKanban, ClipboardList, Clock,
  FileEdit, Sheet, Settings, LogOut, Sun, Moon,
  ArrowLeft, LayoutGrid, Ruler, Printer, Mail, StickyNote, LayoutDashboard,
} from 'lucide-react';
import { useTheme } from '../../context/ThemeContext';
import { useProjectShell } from '../../context/ProjectShellContext';
import { useNotes } from '../../context/NotesContext';

export type SidebarState = 'expanded' | 'collapsed' | 'hidden';

interface NavEntry {
  id: string;
  label: string;
  Icon: React.FC<{ size?: number; className?: string }>;
  path: string;
  match: (pathname: string) => boolean;
}

const WORKSPACE_NAV: NavEntry[] = [
  { id: 'dashboard', label: 'Dashboard', Icon: LayoutDashboard, path: '/dashboard', match: p => p === '/' || p.startsWith('/dashboard') },
  { id: 'projects', label: 'Projects', Icon: FolderKanban, path: '/projects', match: p => p.startsWith('/projects') || p === '/new' || p.startsWith('/project') },
  { id: 'checklists', label: 'Checklists', Icon: ClipboardList, path: '/checklist', match: p => p.startsWith('/checklist') },
  { id: 'time', label: 'Time', Icon: Clock, path: '/time', match: p => p.startsWith('/time') },
];

const TOOLS_NAV: NavEntry[] = [
  { id: 'pdf-editor', label: 'PDF Editor', Icon: FileEdit, path: '/tools/pdf', match: p => p.startsWith('/tools/pdf') || p.startsWith('/pdf-editor') },
  { id: 'spreadsheet-editor', label: 'Spreadsheet', Icon: Sheet, path: '/tools/sheets', match: p => p.startsWith('/tools/sheets') || p.startsWith('/spreadsheet-editor') },
];

// Project sections, Phase 2 edition: they map onto ProjectView's tabs
// (?tab= — Task 9). Notes is not a tab — it opens the notes overlay.
// Phase 3 replaces these with the full section list and real routes.
const PROJECT_NAV: { id: string; label: string; Icon: NavEntry['Icon']; tab: string | null }[] = [
  { id: 'pages',     label: 'Plans & Pages', Icon: LayoutGrid, tab: null },
  { id: 'takeoffs',  label: 'Takeoffs',      Icon: Ruler,      tab: 'takeoffs' },
  { id: 'printouts', label: 'Printouts',     Icon: Printer,    tab: 'printouts' },
  { id: 'email',     label: 'Proposal',      Icon: Mail,       tab: 'email' },
];

// Row used by every nav item. The active item gets the glow treatment —
// spec §5 rule 2: glow is for primary buttons, active nav, progress bars only.
const NavRow: React.FC<{
  label: string;
  Icon: NavEntry['Icon'];
  active?: boolean;
  expanded: boolean;
  onClick: () => void;
  trailing?: React.ReactNode;
}> = ({ label, Icon, active = false, expanded, onClick, trailing }) => (
  <button
    onClick={onClick}
    title={!expanded ? label : undefined}
    className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
      active ? 'glow-accent text-white' : 'text-ink-soft hover:bg-hover hover:text-ink'
    }`}
  >
    <Icon size={18} className="shrink-0" />
    {expanded && <span className="flex-1 truncate text-left">{label}</span>}
    {expanded && trailing}
  </button>
);

const SectionLabel: React.FC<{ show: boolean; children: React.ReactNode }> = ({ show, children }) =>
  show ? (
    <p className="px-3 pt-4 pb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
      {children}
    </p>
  ) : null;

interface SidebarProps {
  state: SidebarState;
  onChange: (s: SidebarState) => void;
  // True on canvas routes: the rail is forced thin and the size toggles hide.
  locked?: boolean;
}

export const Sidebar: React.FC<SidebarProps> = ({ state, onChange, locked = false }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { mode, toggleMode } = useTheme();
  const { project } = useProjectShell();
  const { openNotes } = useNotes();
  const projectMatch = matchPath({ path: '/project/:projectId', end: false }, location.pathname);
  const projectId = projectMatch?.params.projectId;
  const onProjectRoot = !!matchPath('/project/:projectId', location.pathname);
  const activeTab = new URLSearchParams(location.search).get('tab') ?? 'pages';

  if (location.pathname === '/login' || !localStorage.getItem('token')) return null;

  const user = JSON.parse(localStorage.getItem('user') || '{}');
  const expanded = state === 'expanded';

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = '/login';
  };

  if (state === 'hidden') {
    return (
      <button
        onClick={() => onChange('collapsed')}
        title="Open navigation"
        className="fixed top-4 left-4 z-50 p-2.5 bg-raised rounded-xl shadow-lg border border-edge text-ink-soft hover:bg-hover transition-colors"
      >
        <Menu size={18} />
      </button>
    );
  }

  return (
    <div
      className={`fixed left-0 top-0 h-full z-40 flex flex-col bg-surface border-r border-edge overflow-hidden transition-all duration-200 ${
        expanded ? 'w-52' : 'w-16'
      }`}
    >
      {/* Header */}
      <div className={`flex items-center h-14 px-3 border-b border-edge shrink-0 ${expanded ? 'justify-between' : 'justify-center'}`}>
        {!locked ? (
          <button
            onClick={() => onChange(expanded ? 'collapsed' : 'expanded')}
            title={expanded ? 'Collapse' : 'Expand navigation'}
            className="p-1.5 rounded-lg hover:bg-hover text-ink-soft transition-colors"
          >
            <Menu size={18} />
          </button>
        ) : (
          <div className="p-1.5 text-ink-faint"><Menu size={18} /></div>
        )}
        {expanded && !locked && (
          <button
            onClick={() => onChange('hidden')}
            title="Hide sidebar"
            className="p-1.5 rounded-lg hover:bg-hover text-ink-faint transition-colors"
          >
            <PanelLeftClose size={18} />
          </button>
        )}
      </div>

      {/* Nav */}
      <div className="flex-1 py-2 px-2 overflow-y-auto">
        <NavRow
          label="Search"
          Icon={Search}
          expanded={expanded}
          onClick={() => window.dispatchEvent(new CustomEvent('open-command-palette'))}
          trailing={
            <kbd className="text-[10px] font-mono text-ink-faint border border-edge rounded px-1 py-0.5">⌘K</kbd>
          }
        />
        {projectId ? (
          <>
            <div className="pt-2">
              <NavRow
                label="All Projects"
                Icon={ArrowLeft}
                expanded={expanded}
                onClick={() => navigate('/projects')}
              />
            </div>
            {expanded && (
              <p
                className="px-3 pt-3 pb-1 text-sm font-semibold text-ink truncate"
                title={project && project.id === projectId ? project.name : undefined}
              >
                {project && project.id === projectId ? project.name : 'Project'}
              </p>
            )}
            <div className="space-y-0.5">
              {PROJECT_NAV.map(item => (
                <NavRow
                  key={item.id}
                  label={item.label}
                  Icon={item.Icon}
                  expanded={expanded}
                  active={onProjectRoot && activeTab === (item.tab ?? 'pages')}
                  onClick={() =>
                    navigate(item.tab ? `/project/${projectId}?tab=${item.tab}` : `/project/${projectId}`)
                  }
                />
              ))}
              {/* Notes is an overlay, not a route — no active state. */}
              <NavRow
                label="Notes"
                Icon={StickyNote}
                expanded={expanded}
                onClick={() => openNotes(projectId)}
              />
            </div>
          </>
        ) : (
          <>
            <SectionLabel show={expanded}>Workspace</SectionLabel>
            <div className="space-y-0.5">
              {WORKSPACE_NAV.map(item => (
                <NavRow
                  key={item.id}
                  label={item.label}
                  Icon={item.Icon}
                  expanded={expanded}
                  active={item.match(location.pathname)}
                  onClick={() => navigate(item.path)}
                />
              ))}
            </div>
            <SectionLabel show={expanded}>Tools</SectionLabel>
            <div className="space-y-0.5">
              {TOOLS_NAV.map(item => (
                <NavRow
                  key={item.id}
                  label={item.label}
                  Icon={item.Icon}
                  expanded={expanded}
                  active={item.match(location.pathname)}
                  onClick={() => navigate(item.path)}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {/* Footer */}
      <div className="px-2 pb-3 pt-2 border-t border-edge space-y-0.5 shrink-0">
        <NavRow
          label={mode === 'dark' ? 'Light mode' : 'Dark mode'}
          Icon={mode === 'dark' ? Sun : Moon}
          expanded={expanded}
          onClick={toggleMode}
        />
        <NavRow
          label="Settings"
          Icon={Settings}
          expanded={expanded}
          active={location.pathname === '/settings'}
          onClick={() => navigate('/settings')}
        />
        <button
          onClick={handleLogout}
          title={!expanded ? `${user.username || 'User'} — Logout` : undefined}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium text-ink-soft hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-600 dark:hover:text-red-400 transition-colors"
        >
          <LogOut size={18} className="shrink-0" />
          {expanded && (
            <div className="text-left min-w-0">
              <p className="text-sm font-medium truncate">{user.username || 'User'}</p>
              <p className="text-[11px] text-ink-faint">Logout</p>
            </div>
          )}
        </button>
      </div>
    </div>
  );
};
