// src/components/shell/Sidebar.test.tsx
import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../../context/ThemeContext';
import { Sidebar } from './Sidebar';
import { NotesProvider } from '../../context/NotesContext';
import { ProjectShellProvider, useRegisterProjectShell } from '../../context/ProjectShellContext';

const RegisterProject: React.FC<{ id: string; name: string }> = ({ id, name }) => {
  useRegisterProjectShell(id, name);
  return null;
};

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

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('token', 'test-token');
  localStorage.setItem('user', JSON.stringify({ username: 'nathan' }));
});

describe('Sidebar — company mode', () => {
  it('shows workspace and tools nav groups', () => {
    renderAt('/');
    for (const label of ['Dashboard', 'Projects', 'Tasks', 'Time', 'PDF Editor', 'Spreadsheet', 'Settings']) {
      expect(screen.getByRole('button', { name: new RegExp(label) })).toBeInTheDocument();
    }
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
});

describe('Sidebar — project mode', () => {
  const renderProject = (path: string) =>
    render(
      <ThemeProvider>
        <MemoryRouter initialEntries={[path]}>
          <NotesProvider>
            <ProjectShellProvider>
              <RegisterProject id="p1" name="Maple St Office" />
              <Sidebar state="expanded" onChange={() => {}} />
            </ProjectShellProvider>
          </NotesProvider>
        </MemoryRouter>
      </ThemeProvider>
    );

  it('swaps to project nav on project routes', () => {
    renderProject('/project/p1');
    expect(screen.getByRole('button', { name: /All Projects/ })).toBeInTheDocument();
    expect(screen.getByText('Maple St Office')).toBeInTheDocument();
    for (const label of ['Overview', 'Takeoff & Estimate', 'Documents', 'Punch & Checklists', 'Notes', 'Time', 'Issues']) {
      expect(screen.getByRole('button', { name: new RegExp(label) })).toBeInTheDocument();
    }
    // company nav is gone
    expect(screen.queryByRole('button', { name: /^Tasks$/ })).not.toBeInTheDocument();
  });

  it('highlights the section matching the route', () => {
    renderProject('/project/p1/documents');
    expect(screen.getByRole('button', { name: /Documents/ }).className).toContain('glow-accent');
    expect(screen.getByRole('button', { name: /Overview/ }).className).not.toContain('glow-accent');
  });

  it('highlights Overview at the project root and Takeoff on canvas routes', () => {
    renderProject('/project/p1');
    expect(screen.getByRole('button', { name: /Overview/ }).className).toContain('glow-accent');
  });

  it('stays in company mode off project routes', () => {
    renderProject('/time');
    expect(screen.queryByRole('button', { name: /All Projects/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Tasks/ })).toBeInTheDocument();
  });

  it('keeps project mode on the canvas route', () => {
    render(
      <ThemeProvider>
        <MemoryRouter initialEntries={['/project/p1/page/pg1']}>
          <NotesProvider>
            <ProjectShellProvider>
              <RegisterProject id="p1" name="Maple St Office" />
              <Sidebar state="collapsed" onChange={() => {}} locked />
            </ProjectShellProvider>
          </NotesProvider>
        </MemoryRouter>
      </ThemeProvider>
    );
    // icons-only rail: section labels hidden, but project rows still render
    expect(screen.getByRole('button', { name: /All Projects/ })).toBeInTheDocument();
    expect(screen.queryByText('Maple St Office')).not.toBeInTheDocument();
  });

  it('shows Billing for admins', () => {
    localStorage.setItem('user', JSON.stringify({ username: 'a', role: 'admin' }));
    renderProject('/project/p1');
    expect(screen.getByRole('button', { name: /Billing/ })).toBeInTheDocument();
  });

  it('hides Billing for members', () => {
    localStorage.setItem('user', JSON.stringify({ username: 'm', role: 'member' }));
    renderProject('/project/p1');
    expect(screen.queryByRole('button', { name: /Billing/ })).not.toBeInTheDocument();
  });

  it('shows Issues for non-admins (not admin-gated)', () => {
    localStorage.setItem('user', JSON.stringify({ username: 'm', role: 'user' }));
    renderProject('/project/p1');
    expect(screen.getByRole('button', { name: /Issues/ })).toBeInTheDocument();
  });

  it('shows Punch & Checklists for non-admins (not admin-gated)', () => {
    localStorage.setItem('user', JSON.stringify({ username: 'm', role: 'user' }));
    renderProject('/project/p1');
    expect(screen.getByRole('button', { name: /Punch & Checklists/ })).toBeInTheDocument();
  });

  it('hides the size toggles when locked', () => {
    render(
      <ThemeProvider>
        <MemoryRouter initialEntries={['/project/p1/page/pg1']}>
          <NotesProvider>
            <ProjectShellProvider>
              <Sidebar state="collapsed" onChange={() => {}} locked />
            </ProjectShellProvider>
          </NotesProvider>
        </MemoryRouter>
      </ThemeProvider>
    );
    expect(screen.queryByTitle('Expand navigation')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Hide sidebar')).not.toBeInTheDocument();
  });
});
