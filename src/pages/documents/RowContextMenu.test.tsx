// src/pages/documents/RowContextMenu.test.tsx
// The per-row menu is pure presentation over documentsPolicy — this covers the
// items whose visibility is kind-dependent (Share link, Delete), which is where
// the takeoff-print rules land.
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RowContextMenu } from './RowContextMenu';
import type { DocumentRow } from '../../utils/store';

const row = (over: Partial<DocumentRow>): DocumentRow => ({
  id: 'r1', name: 'file.pdf', mime: 'application/pdf', size: 100, kind: 'document',
  createdAt: 1, versionNumber: 1, archived: false,
  projectId: null, projectName: null, customerId: null, customerName: null, source: null,
  ...over,
});

const takeoffPrint = row({
  id: 'tp1', kind: 'takeoff-print', name: 'Takeoff Print – Test – 2026-08-28',
  source: { type: 'takeoff-print', id: 'po-1', label: 'Takeoff Print', href: '/project/p1/takeoff' },
});

const renderMenu = (r: DocumentRow, over: Partial<React.ComponentProps<typeof RowContextMenu>> = {}) => {
  const props = {
    state: { x: 10, y: 10, row: r },
    customTypes: [],
    onClose: vi.fn(), onOpen: vi.fn(), onDownload: vi.fn(), onArchive: vi.fn(),
    onChangeKind: vi.fn(), onDelete: vi.fn(), onShare: vi.fn(),
    ...over,
  };
  render(<RowContextMenu {...props} />);
  return props;
};

describe('RowContextMenu', () => {
  it('offers Share link and Delete on a takeoff print', () => {
    const { onShare, onClose } = renderMenu(takeoffPrint);
    fireEvent.click(screen.getByRole('menuitem', { name: /Share link/ }));
    expect(onShare).toHaveBeenCalledWith(takeoffPrint);
    expect(onClose).toHaveBeenCalled();
    expect(screen.getByRole('menuitem', { name: /Delete/ })).toBeInTheDocument();
  });

  it('offers Share link on a takeoff export too', () => {
    renderMenu(row({ kind: 'takeoff-export', source: { type: 'takeoff-print', id: 'po-2', label: 'x', href: null } }));
    expect(screen.getByRole('menuitem', { name: /Share link/ })).toBeInTheDocument();
  });

  it('does not offer Share link on an ordinary upload or an owned generated document', () => {
    renderMenu(row({ kind: 'document' }));
    expect(screen.queryByRole('menuitem', { name: /Share link/ })).toBeNull();
    // Delete is still there — a loose direct upload is deletable.
    expect(screen.getByRole('menuitem', { name: /Delete/ })).toBeInTheDocument();
  });

  it('a proposal document gets neither Share link nor Delete (its proposal owns it)', () => {
    renderMenu(row({ kind: 'proposal', source: { type: 'proposal', id: 'pr1', label: 'Proposal #1', href: null } }));
    expect(screen.queryByRole('menuitem', { name: /Share link/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Delete/ })).toBeNull();
  });
});
