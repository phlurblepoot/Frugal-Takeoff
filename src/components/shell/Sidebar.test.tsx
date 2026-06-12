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
    for (const label of ['Projects', 'Checklists', 'Time', 'PDF Editor', 'Spreadsheet', 'Settings']) {
      expect(screen.getByRole('button', { name: new RegExp(label) })).toBeInTheDocument();
    }
  });

  it('gives only the active item the glow treatment', () => {
    renderAt('/time');
    expect(screen.getByRole('button', { name: /Time/ }).className).toContain('glow-accent');
    expect(screen.getByRole('button', { name: /Projects/ }).className).not.toContain('glow-accent');
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
    for (const label of ['Plans & Pages', 'Takeoffs', 'Printouts', 'Proposal', 'Notes']) {
      expect(screen.getByRole('button', { name: new RegExp(label) })).toBeInTheDocument();
    }
    // company nav is gone
    expect(screen.queryByRole('button', { name: /Checklists/ })).not.toBeInTheDocument();
  });

  it('highlights the section matching ?tab=', () => {
    renderProject('/project/p1?tab=takeoffs');
    expect(screen.getByRole('button', { name: /Takeoffs/ }).className).toContain('glow-accent');
    expect(screen.getByRole('button', { name: /Plans & Pages/ }).className).not.toContain('glow-accent');
  });

  it('stays in company mode off project routes', () => {
    renderProject('/time');
    expect(screen.queryByRole('button', { name: /All Projects/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Checklists/ })).toBeInTheDocument();
  });
});
