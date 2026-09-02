// src/components/documents/SentThreadChip.test.tsx
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SentThreadChip } from './SentThreadChip';
import type { ThreadLink } from '../../pages/mail/types';

const link = (over: Partial<ThreadLink> = {}): ThreadLink => ({
  id: 'l1', threadKey: 'tk 1', subjectSnapshot: 'Invoice 12 — Dania Beach',
  firstDate: '2026-08-27T12:00:00.000Z', participantsJson: null, itemType: 'invoice', itemId: 'inv-1',
  projectId: 'p1', customerId: null, linkedByUserId: 'u1', createdAt: '2026-08-27T12:00:00.000Z',
  ...over,
});

const mount = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('SentThreadChip', () => {
  it('renders nothing for an item that was never emailed', () => {
    const { container } = mount(<SentThreadChip link={null} myThread={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('links into the mail client when the user owns the thread', () => {
    mount(
      <SentThreadChip
        link={link()}
        myThread={{ accountId: 'a1', threadKey: 'tk 1', subject: 'Invoice 12' }}
      />,
    );
    const chip = screen.getByTestId('sent-thread-chip');
    expect(chip).toHaveTextContent('Open thread');
    // `_` is MailPage's "any folder" segment; the key is URL-encoded because a
    // threadKey is opaque server text, not a path-safe id.
    expect(chip).toHaveAttribute('href', '/mail/a1/_/tk%201');
    expect(chip).toHaveAttribute('title', 'Invoice 12 — Dania Beach');
  });

  it('shows the send date', () => {
    mount(<SentThreadChip link={link()} myThread={{ accountId: 'a1', threadKey: 'tk 1', subject: 's' }} />);
    // Formatted by the mail client's own formatter — the exact string depends
    // on the current year, so assert the shape rather than a fixed value.
    expect(screen.getByTestId('sent-thread-chip').textContent).toMatch(/^Sent · .+ · Open thread$/);
  });

  it('falls back to createdAt when the link carries no first date', () => {
    mount(
      <SentThreadChip
        link={link({ firstDate: null })}
        myThread={{ accountId: 'a1', threadKey: 'tk 1', subject: 's' }}
      />,
    );
    expect(screen.getByTestId('sent-thread-chip').textContent).toMatch(/^Sent · .+ · Open thread$/);
  });

  // "Not one of yours" is only true once the lookup has run; until then the
  // chip states the one fact it has — that this went out.
  it('makes no ownership claim while the lookup is still running', () => {
    mount(<SentThreadChip link={link()} myThread={null} resolving />);
    const chip = screen.getByTestId('sent-thread-chip');
    expect(chip).not.toHaveTextContent('by another user');
    expect(chip.textContent).toMatch(/^Sent · /);
    expect(chip).toHaveAttribute('title', 'Looking for the conversation…');
  });

  // The link row is shared with everyone who can see the item, but the thread
  // itself lives in the sender's mailbox: a deep link would 404 for anyone else.
  it('is muted, and not a link, when another user holds the thread', () => {
    mount(<SentThreadChip link={link()} myThread={null} />);
    const chip = screen.getByTestId('sent-thread-chip');
    expect(chip).toHaveTextContent('by another user');
    expect(chip.tagName).toBe('SPAN');
    expect(chip).not.toHaveAttribute('href');
    expect(chip).toHaveAttribute('title', expect.stringContaining("another user's mailbox"));
  });
});
