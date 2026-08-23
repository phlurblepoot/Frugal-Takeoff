// src/pages/tasks/TaskEditor.test.tsx
//
// Representative coverage for Task 8's edit-awareness wiring (fake-socket +
// mocked-context pattern from useCollabEditing.test.tsx / ProjectIssues.test.tsx).
// IssueEditor/RfiEditor/PunchItemEditor get the same three touches but aren't
// re-tested here — the hook itself is unit-tested in useCollabEditing.test.tsx.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import React from 'react';
import { TaskEditor } from './TaskEditor';
import { ToastProvider } from '../../components/Toast';
import type { Task } from '../../utils/store';

const { fakeSocket } = vi.hoisted(() => {
  const handlers: Record<string, ((...a: any[]) => void)[]> = {};
  const fakeSocket = {
    handlers,
    on: vi.fn((e: string, cb: any) => { (handlers[e] ??= []).push(cb); return fakeSocket; }),
    off: vi.fn((e: string, cb: any) => { handlers[e] = (handlers[e] ?? []).filter(h => h !== cb); return fakeSocket; }),
    emit: vi.fn(),
    fire: (e: string, ...a: any[]) => (handlers[e] ?? []).forEach(cb => cb(...a)),
  };
  return { fakeSocket };
});

vi.mock('../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: fakeSocket, sessions: [], mySessionId: 'me' }),
}));

const saveTask = vi.hoisted(() => vi.fn());
vi.mock('../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  saveTask,
}));

const task: Task = {
  id: 't1', category: '', title: 'Original title', notes: '',
  assigneeUserId: null, assigneeUsername: null, status: 'todo', dueDate: null,
  sortOrder: 0, projectId: null, customerId: null, projectName: null, customerName: null,
  version: 1, createdAt: 0, createdBy: null, photos: [],
};

const changeEvt = (over: Record<string, unknown> = {}) => ({
  type: 'task', id: 't1', action: 'updated', version: 7, bySessionId: 'other-tab', ...over,
});

function renderEditor(onSaved: () => void = vi.fn()) {
  return render(
    <ToastProvider>
      <TaskEditor task={task} users={[]} projects={[]} customers={[]} onClose={vi.fn()} onSaved={onSaved} />
    </ToastProvider>
  );
}

describe('TaskEditor collab awareness', () => {
  beforeEach(() => {
    saveTask.mockReset().mockResolvedValue({ version: 8 });
    fakeSocket.emit.mockClear();
    for (const k of Object.keys(fakeSocket.handlers)) delete fakeSocket.handlers[k];
  });

  it('declares set-editing for this task on mount', () => {
    renderEditor();
    expect(fakeSocket.emit).toHaveBeenCalledWith('set-editing', { type: 'task', id: 't1' });
  });

  it('pristine: a foreign entity-changed event for this task calls onSaved (no banner)', () => {
    const onSaved = vi.fn();
    renderEditor(onSaved);
    act(() => { fakeSocket.fire('entity-changed', changeEvt()); });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/saved changes while you were editing/)).toBeNull();
  });

  it('dirty: a foreign entity-changed event shows the banner instead of reloading', () => {
    const onSaved = vi.fn();
    renderEditor(onSaved);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Changed title' } });
    act(() => { fakeSocket.fire('entity-changed', changeEvt()); });
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByText(/saved changes while you were editing/)).toBeInTheDocument();
  });

  it('Keep mine then Save sends the event version, not the stale prop version', async () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Changed title' } });
    act(() => { fakeSocket.fire('entity-changed', changeEvt()); });
    fireEvent.click(screen.getByText('Keep mine'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveTask).toHaveBeenCalledTimes(1));
    expect(saveTask.mock.calls[0][1].version).toBe(7);
  });
});
