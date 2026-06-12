// src/components/ProjectStageControl.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProjectStageControl } from './ProjectStageControl';
import { ToastProvider } from './Toast';

const patchProject = vi.hoisted(() => vi.fn());
vi.mock('../utils/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/store')>();
  return { ...actual, patchProject };
});

beforeEach(() => patchProject.mockReset());

const renderControl = (onChanged = vi.fn()) =>
  render(
    <ToastProvider>
      <ProjectStageControl projectId="p1" version={3} status="estimating" onChanged={onChanged} />
    </ToastProvider>
  );

describe('ProjectStageControl', () => {
  it('shows the current stage pill and opens the stage menu', () => {
    renderControl();
    expect(screen.getByText('Estimating')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Change project stage'));
    for (const label of ['Proposal Sent', 'Awarded', 'In Progress', 'Punch List', 'Complete', 'Lost']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: 'Archived' })).not.toBeInTheDocument();
  });

  it('patches the stage and reports the new version', async () => {
    patchProject.mockResolvedValue({ version: 4, status: 'awarded' });
    const onChanged = vi.fn();
    renderControl(onChanged);
    fireEvent.click(screen.getByTitle('Change project stage'));
    fireEvent.click(screen.getByRole('button', { name: 'Awarded' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(4, 'awarded'));
    expect(patchProject).toHaveBeenCalledWith('p1', { version: 3, status: 'awarded' });
  });
});
