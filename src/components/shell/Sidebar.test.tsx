// src/components/shell/Sidebar.test.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../../context/ThemeContext';
import { NotesProvider } from '../../context/NotesContext';

// useMailUnread ultimately depends on useLiveQuery, which needs a
// CollaborationProvider (socket context) this test harness doesn't set up —
// mock it at the module level, same pattern used across the app's other
// live-query-backed hooks.
const useMailUnread = vi.fn(() => 0);
vi.mock('../../pages/mail/useMailUnread', () => ({
  useMailUnread: () => useMailUnread(),
}));

// SidebarPresence (mounted in the footer) also needs a CollaborationProvider
// — mock it out the same way, since these tests exercise nav, not presence.
vi.mock('../../context/CollaborationContext', async (orig) => ({
  ...(await orig()),
  useCollaboration: () => ({
    sessions: [], mySessionId: null, followedSessionId: null,
    setFollowedSessionId: vi.fn(), updateUser: vi.fn(),
  }),
}));
vi.mock('../../hooks/useLiveQuery', () => ({ useLiveQuery: () => {} }));

const { Sidebar } = await import('./Sidebar');

const renderAt = (path: string) =>
  render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[path]}>
        <NotesProvider>
          <Sidebar state="expanded" onChange={() => {}} />
        </NotesProvider>
      </MemoryRouter>
    </ThemeProvider>
  );

const renderLockedAt = (path: string) =>
  render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[path]}>
        <NotesProvider>
          <Sidebar state="expanded" onChange={() => {}} locked />
        </NotesProvider>
      </MemoryRouter>
    </ThemeProvider>
  );

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('token', 'test-token');
  localStorage.setItem('user', JSON.stringify({ username: 'nathan' }));
  useMailUnread.mockReset();
  useMailUnread.mockReturnValue(0);
});

describe('Sidebar — company mode', () => {
  it('shows workspace and tools nav groups', () => {
    renderAt('/');
    for (const label of ['Dashboard', 'Projects', 'Tasks', 'Documents', 'Mail', 'Time', 'PDF Editor', 'Spreadsheet', 'Settings']) {
      expect(screen.getByRole('button', { name: new RegExp(label) })).toBeInTheDocument();
    }
  });

  it('lists Mail right after Documents', () => {
    renderAt('/');
    const labels = screen.getAllByRole('button')
      .map(btn => btn.textContent?.trim())
      .filter((t): t is string => !!t && ['Dashboard', 'Projects', 'Customers', 'Tasks', 'Documents', 'Mail', 'Time'].some(l => t.startsWith(l)));
    const docIdx = labels.findIndex(t => t.startsWith('Documents'));
    const mailIdx = labels.findIndex(t => t.startsWith('Mail'));
    expect(docIdx).toBeGreaterThanOrEqual(0);
    expect(mailIdx).toBe(docIdx + 1);
  });

  it('shows an unread badge on Mail when useMailUnread reports a count', () => {
    useMailUnread.mockReturnValue(7);
    renderAt('/');
    const mailButton = screen.getByRole('button', { name: /Mail/ });
    expect(mailButton).toHaveTextContent('7');
    expect(screen.getByLabelText('7 unread')).toBeInTheDocument();
  });

  it('hides the badge when there are no unread messages', () => {
    useMailUnread.mockReturnValue(0);
    renderAt('/');
    expect(screen.queryByLabelText(/unread/)).not.toBeInTheDocument();
  });

  it('gives only the active item the glow treatment', () => {
    renderAt('/time');
    expect(screen.getByRole('button', { name: /Time/ }).className).toContain('glow-accent');
    expect(screen.getByRole('button', { name: /Projects/ }).className).not.toContain('glow-accent');
  });

  it('marks Dashboard active on /dashboard', () => {
    renderAt('/dashboard');
    expect(screen.getByRole('button', { name: /Dashboard/ }).className).toContain('glow-accent');
    expect(screen.getByRole('button', { name: /Projects/ }).className).not.toContain('glow-accent');
  });

  it('marks Projects active on /projects', () => {
    renderAt('/projects');
    expect(screen.getByRole('button', { name: /Projects/ }).className).toContain('glow-accent');
    expect(screen.getByRole('button', { name: /Dashboard/ }).className).not.toContain('glow-accent');
  });

  it('offers a theme toggle', () => {
    renderAt('/');
    expect(screen.getByRole('button', { name: /Dark mode|Light mode/ })).toBeInTheDocument();
  });

  it('renders nothing when logged out', () => {
    localStorage.clear();
    const { container } = renderAt('/');
    expect(container.querySelector('button')).toBeNull();
  });

  it('keeps the global workspace nav on project routes', () => {
    renderAt('/project/p1/billing');
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Projects')).toBeInTheDocument();
    // No project-section entries in the sidebar anymore:
    expect(screen.queryByText('Takeoff & Estimate')).toBeNull();
    expect(screen.queryByText('All Projects')).toBeNull();
  });

  it('highlights Projects for project routes', () => {
    renderAt('/project/p1/billing');
    const btn = screen.getByRole('button', { name: 'Projects' });
    expect(btn.className).toContain('glow-accent');
  });

  it('shows the size toggles when not locked', () => {
    renderAt('/dashboard');
    expect(screen.getByTitle('Collapse')).toBeInTheDocument();
    expect(screen.getByTitle('Hide sidebar')).toBeInTheDocument();
  });

  it('hides the size toggles when locked', () => {
    renderLockedAt('/dashboard');
    expect(screen.queryByTitle('Collapse')).toBeNull();
    expect(screen.queryByTitle('Expand navigation')).toBeNull();
    expect(screen.queryByTitle('Hide sidebar')).toBeNull();
  });
});
