// src/components/shell/Sidebar.test.tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../../context/ThemeContext';
import { Sidebar } from './Sidebar';

const renderAt = (path: string) =>
  render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[path]}>
        <Sidebar state="expanded" onChange={() => {}} />
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
