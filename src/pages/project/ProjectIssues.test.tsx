// src/pages/project/ProjectIssues.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor as rtlWaitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import React from 'react';

const { fakeSocket, getIssues } = vi.hoisted(() => {
  const handlers: Record<string, ((...a: any[]) => void)[]> = {};
  const fakeSocket = {
    handlers,
    on: vi.fn((e: string, cb: any) => { (handlers[e] ??= []).push(cb); return fakeSocket; }),
    off: vi.fn((e: string, cb: any) => { handlers[e] = (handlers[e] ?? []).filter(h => h !== cb); return fakeSocket; }),
    emit: vi.fn(),
    fire: (e: string, ...a: any[]) => (handlers[e] ?? []).forEach(cb => cb(...a)),
  };
  return { fakeSocket, getIssues: vi.fn() };
});
vi.mock('../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: fakeSocket, sessions: [], mySessionId: 'sock-1' }),
}));
vi.mock('../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<object>()), getIssues,
}));
vi.mock('./ProjectLayout', () => ({
  useProjectOutlet: () => ({ summary: { name: 'P1', contractor: '' } }),
}));

import { ProjectIssues } from './ProjectIssues';

function mount() {
  return render(
    <MemoryRouter initialEntries={['/project/p1/issues']}>
      <Routes><Route path="/project/:projectId/issues" element={<ProjectIssues />} /></Routes>
    </MemoryRouter>
  );
}

describe('ProjectIssues live refresh', () => {
  beforeEach(() => {
    getIssues.mockReset();
    for (const k of Object.keys(fakeSocket.handlers)) delete fakeSocket.handlers[k];
  });

  it('refetches when a foreign issue event for this project arrives', async () => {
    getIssues.mockResolvedValueOnce([]);
    getIssues.mockResolvedValueOnce([{ id: 'i1', number: 1, title: 'new crack', status: 'open', photoCount: 0 }]);
    mount();
    await rtlWaitFor(() => expect(getIssues).toHaveBeenCalledTimes(1));
    act(() => {
      fakeSocket.fire('entity-changed', { type: 'issue', id: 'i1', projectId: 'p1', action: 'created', bySessionId: 'other-tab' });
    });
    await rtlWaitFor(() => expect(getIssues).toHaveBeenCalledTimes(2), { timeout: 2000 });
    await rtlWaitFor(() => expect(screen.getByText('new crack')).toBeInTheDocument());
  });

  it('ignores issue events for other projects', async () => {
    getIssues.mockResolvedValue([]);
    mount();
    await rtlWaitFor(() => expect(getIssues).toHaveBeenCalledTimes(1));
    act(() => {
      fakeSocket.fire('entity-changed', { type: 'issue', id: 'iX', projectId: 'OTHER', action: 'created', bySessionId: 'other-tab' });
    });
    await new Promise(r => setTimeout(r, 500));
    expect(getIssues).toHaveBeenCalledTimes(1);
  });
});
