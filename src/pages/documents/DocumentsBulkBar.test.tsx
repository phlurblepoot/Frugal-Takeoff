// src/pages/documents/DocumentsBulkBar.test.tsx
// The bulk bar is presentation over documentsPolicy; this pins the "Change
// type" control: its count reflects only the re-typeable subset of the
// selection, it's disabled when that subset is empty, and the handler is
// handed ONLY the re-typeable rows (a system-kind row is never sent — the
// server would 409 it).
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DocumentsBulkBar } from './DocumentsBulkBar';
import type { DocumentRow } from '../../utils/store';

const row = (over: Partial<DocumentRow>): DocumentRow => ({
  id: 'r1', name: 'file.pdf', mime: 'application/pdf', size: 100, kind: 'document',
  createdAt: 1, versionNumber: 1, archived: false,
  projectId: null, projectName: null, customerId: null, customerName: null, source: null,
  ...over,
});

const docA = row({ id: 'a', name: 'a.pdf', kind: 'document' });
const docB = row({ id: 'b', name: 'b.jpg', kind: 'photo' });
const invoice = row({ id: 'inv', name: 'inv.pdf', kind: 'invoice', source: { type: 'invoice', id: 'i1', label: 'Invoice #1', href: null } });

const renderBar = (selected: DocumentRow[], customTypes: { id: string; label: string }[] = []) => {
  const props = {
    selected,
    customTypes,
    archivedView: false,
    onClear: vi.fn(),
    onDownload: vi.fn(async () => {}),
    onArchive: vi.fn(async () => {}),
    onDelete: vi.fn(async () => {}),
    onChangeKind: vi.fn(async () => {}),
  };
  render(<DocumentsBulkBar {...props} />);
  return props;
};

describe('DocumentsBulkBar change type', () => {
  it('shows "Change type (2 of 3)" and hands the handler only the re-typeable rows', async () => {
    const { onChangeKind } = renderBar([docA, docB, invoice]);
    const btn = screen.getByRole('button', { name: 'Change type (2 of 3)' });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Spreadsheet' }));
    expect(onChangeKind).toHaveBeenCalledTimes(1);
    expect(onChangeKind).toHaveBeenCalledWith([docA, docB], 'spreadsheet');
  });

  it('lists the direct-upload kinds plus custom types as options', () => {
    renderBar([docA], [{ id: 'warranty', label: 'Warranty' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Change type (1 of 1)' }));
    for (const label of ['Document', 'Spreadsheet', 'Photo', 'Other', 'Company Document', 'Warranty']) {
      expect(screen.getByRole('menuitem', { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole('menuitem', { name: 'Invoice' })).toBeNull();
  });

  it('is disabled when nothing selected is re-typeable', () => {
    const { onChangeKind } = renderBar([invoice]);
    const btn = screen.getByRole('button', { name: 'Change type (0 of 1)' });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(screen.queryByRole('menuitem', { name: 'Document' })).toBeNull();
    expect(onChangeKind).not.toHaveBeenCalled();
  });
});
