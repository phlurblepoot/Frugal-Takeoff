// src/pages/mail/ThreadReferenceCard.test.tsx
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ThreadLink } from './types';

const h = vi.hoisted(() => ({ getAssignableUsers: vi.fn() }));
vi.mock('../../utils/store', () => ({ getAssignableUsers: h.getAssignableUsers }));

import { ThreadReferenceCard } from './ThreadReferenceCard';

const link = (over: Partial<ThreadLink> = {}): ThreadLink => ({
  id: 'l1', threadKey: 'tk 1', subjectSnapshot: 'Invoice 12 — Dania Beach',
  firstDate: '2026-08-27T12:00:00.000Z', participantsJson: JSON.stringify([{ addr: 'gc@teg.com', name: 'Mike' }]),
  itemType: 'invoice', itemId: 'inv-1', label: 'INV-012',
  projectId: 'p1', customerId: null, linkedByUserId: 'u1', createdAt: '2026-08-27T12:00:00.000Z',
  ...over,
});

beforeEach(() => { h.getAssignableUsers.mockReset(); h.getAssignableUsers.mockResolvedValue([]); });

describe('ThreadReferenceCard', () => {
  it('shows the subject, date, participants, and muted no-copy notice', async () => {
    render(<ThreadReferenceCard links={[link()]} onClose={vi.fn()} />);
    expect(screen.getByText('Invoice 12 — Dania Beach')).toBeInTheDocument();
    expect(screen.getByText('Mike <gc@teg.com>')).toBeInTheDocument();
    expect(screen.getByTestId('thread-reference-no-copy'))
      .toHaveTextContent('No copy of this conversation in your connected mailboxes.');
  });

  it('falls back to "(no subject)" and "(unknown)" participants when the snapshot is empty', () => {
    render(<ThreadReferenceCard links={[link({ subjectSnapshot: null, participantsJson: null })]} onClose={vi.fn()} />);
    expect(screen.getByText('(no subject)')).toBeInTheDocument();
    expect(screen.getByText('(unknown)')).toBeInTheDocument();
  });

  it('lists every linked item with its resolved label and item-type badge', () => {
    render(
      <ThreadReferenceCard
        links={[link(), link({ id: 'l2', itemType: 'project', itemId: 'p1', label: 'Dania Beach', linkedByUserId: 'u2' })]}
        onClose={vi.fn()}
      />,
    );
    const rows = screen.getAllByTestId('thread-reference-link');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Invoice');
    expect(rows[0]).toHaveTextContent('INV-012');
    expect(rows[1]).toHaveTextContent('Project');
    expect(rows[1]).toHaveTextContent('Dania Beach');
  });

  it('resolves "linked by" to a username once the user list loads, falling back to the id until then', async () => {
    h.getAssignableUsers.mockResolvedValue([{ id: 'u1', username: 'nathan', role: 'admin' }]);
    render(<ThreadReferenceCard links={[link()]} onClose={vi.fn()} />);
    // Before the fetch resolves, the raw id is shown rather than nothing.
    expect(screen.getByTestId('thread-reference-link')).toHaveTextContent('u1');
    await waitFor(() => expect(screen.getByTestId('thread-reference-link')).toHaveTextContent('nathan'));
  });

  it('still renders completely when the user list fetch fails', async () => {
    h.getAssignableUsers.mockRejectedValue(new Error('offline'));
    render(<ThreadReferenceCard links={[link()]} onClose={vi.fn()} />);
    expect(screen.getByTestId('thread-reference-link')).toHaveTextContent('u1');
  });

  it('calls onClose from the modal close control', () => {
    const onClose = vi.fn();
    render(<ThreadReferenceCard links={[link()]} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
