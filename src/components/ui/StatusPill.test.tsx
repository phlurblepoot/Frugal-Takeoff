// src/components/ui/StatusPill.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  StatusPill, ProjectStatusPill, LostBadge, PROJECT_STATUS_META, normalizeProjectStatus,
} from './StatusPill';

describe('StatusPill', () => {
  it('renders children with the requested tone', () => {
    render(<StatusPill tone="emerald">Done</StatusPill>);
    const pill = screen.getByText('Done');
    expect(pill.className).toContain('emerald');
  });

  it('defaults to the slate tone', () => {
    render(<StatusPill>Meh</StatusPill>);
    expect(screen.getByText('Meh').className).toContain('slate');
  });
});

describe('normalizeProjectStatus', () => {
  it('passes the live statuses through untouched', () => {
    for (const s of ['bidding', 'in_progress', 'archived']) {
      expect(PROJECT_STATUS_META[s], `missing status ${s}`).toBeDefined();
      expect(normalizeProjectStatus(s)).toBe(s);
    }
  });

  it('collapses legacy status ids the way migration 21 did', () => {
    expect(normalizeProjectStatus('estimating')).toBe('bidding');
    expect(normalizeProjectStatus('proposal_sent')).toBe('bidding');
    expect(normalizeProjectStatus('lost')).toBe('bidding');
    expect(normalizeProjectStatus('awarded')).toBe('in_progress');
    expect(normalizeProjectStatus('punch_list')).toBe('in_progress');
    expect(normalizeProjectStatus('complete')).toBe('in_progress');
  });

  it('folds unknown and prototype keys into bidding', () => {
    expect(normalizeProjectStatus('something_else')).toBe('bidding');
    expect(normalizeProjectStatus('constructor')).toBe('bidding');
  });
});

describe('ProjectStatusPill', () => {
  it('renders the human label for a live status', () => {
    render(<ProjectStatusPill status="in_progress" />);
    expect(screen.getByText('In Progress')).toBeInTheDocument();
  });

  it('renders a legacy status under its collapsed label', () => {
    render(<ProjectStatusPill status="proposal_sent" />);
    expect(screen.getByText('Bidding')).toBeInTheDocument();
  });

  it('shows Unknown rather than guessing when the status is missing', () => {
    render(<ProjectStatusPill status={null} />);
    expect(screen.getByText('Unknown').className).toContain('slate');
  });
});

describe('LostBadge', () => {
  it('renders a red Lost marker', () => {
    render(<LostBadge />);
    expect(screen.getByText('Lost').className).toContain('red');
  });
});
