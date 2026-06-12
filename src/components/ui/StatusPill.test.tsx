// src/components/ui/StatusPill.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusPill, ProjectStatusPill, PROJECT_STATUS_META } from './StatusPill';

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

describe('ProjectStatusPill', () => {
  it('maps every lifecycle status from the spec', () => {
    for (const s of ['estimating', 'proposal_sent', 'awarded', 'in_progress',
                     'punch_list', 'complete', 'archived', 'lost']) {
      expect(PROJECT_STATUS_META[s], `missing status ${s}`).toBeDefined();
    }
  });

  it('renders the human label for a known status', () => {
    render(<ProjectStatusPill status="proposal_sent" />);
    expect(screen.getByText('Proposal Sent')).toBeInTheDocument();
  });

  it('falls back to slate + raw text for unknown statuses', () => {
    render(<ProjectStatusPill status="something_else" />);
    expect(screen.getByText('something_else').className).toContain('slate');
  });

  it('treats prototype keys as unknown statuses', () => {
    render(<ProjectStatusPill status="constructor" />);
    expect(screen.getByText('constructor').className).toContain('slate');
  });
});
