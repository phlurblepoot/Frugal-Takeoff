// src/components/documents/VersionOrOverwriteDialog.test.tsx
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VersionOrOverwriteDialog } from './VersionOrOverwriteDialog';

const setup = (over: Partial<React.ComponentProps<typeof VersionOrOverwriteDialog>> = {}) => {
  const onChoose = vi.fn();
  const onCancel = vi.fn();
  render(
    <VersionOrOverwriteDialog
      open
      fileName="Invoice-12.pdf"
      versionNumber={2}
      onChoose={onChoose}
      onCancel={onCancel}
      {...over}
    />
  );
  return { onChoose, onCancel };
};

describe('VersionOrOverwriteDialog', () => {
  it('explains the existing file and its next version number', () => {
    setup();
    expect(screen.getByText('Replace the existing PDF?')).toBeInTheDocument();
    expect(
      screen.getByText(/Invoice-12\.pdf already exists \(version 2\)\. Save the new PDF as version 3, or overwrite it\?/)
    ).toBeInTheDocument();
  });

  it('reports the chosen mode', () => {
    const { onChoose, onCancel } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Save as new version' }));
    expect(onChoose).toHaveBeenCalledWith('version');
    fireEvent.click(screen.getByRole('button', { name: 'Overwrite' }));
    expect(onChoose).toHaveBeenCalledWith('overwrite');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('cancels', () => {
    const { onChoose, onCancel } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
    expect(onChoose).not.toHaveBeenCalled();
  });

  it('renders nothing when closed', () => {
    setup({ open: false });
    expect(screen.queryByText('Replace the existing PDF?')).toBeNull();
  });
});
