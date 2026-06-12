// src/pages/ProjectsPage.test.tsx
import { describe, it, expect } from 'vitest';
import { groupSummaries } from './ProjectsPage';
import type { ProjectSummary } from '../utils/store';

const mk = (over: Partial<ProjectSummary>): ProjectSummary => ({
  id: 'x', name: 'P', status: 'estimating', contractor: null, address: null,
  bidDueDate: null, version: 1, createdAt: 1, updatedAt: null, archived: false,
  pageCount: 0, takeoffCount: 0, pageIds: [], contractValueCents: 0, invoiceCount: 0, ...over,
});

describe('groupSummaries', () => {
  it('buckets statuses into the three pipeline groups', () => {
    const groups = groupSummaries([
      mk({ id: 'a', status: 'estimating' }),
      mk({ id: 'b', status: 'proposal_sent' }),
      mk({ id: 'c', status: 'awarded' }),
      mk({ id: 'd', status: 'in_progress' }),
      mk({ id: 'e', status: 'punch_list' }),
      mk({ id: 'f', status: 'complete' }),
      mk({ id: 'g', status: 'lost' }),
    ]);
    expect(groups.map(g => g.id)).toEqual(['estimating', 'active', 'closed']);
    expect(groups[0].projects.map(p => p.id).sort()).toEqual(['a', 'b']);
    expect(groups[1].projects.map(p => p.id).sort()).toEqual(['c', 'd', 'e']);
    expect(groups[2].projects.map(p => p.id).sort()).toEqual(['f', 'g']);
  });

  it('drops archived projects and folds unknown statuses into Estimating', () => {
    const groups = groupSummaries([
      mk({ id: 'a', status: 'awarded', archived: true }),
      mk({ id: 'b', status: 'something_weird' }),
    ]);
    expect(groups[1].projects).toHaveLength(0);
    expect(groups[0].projects.map(p => p.id)).toEqual(['b']);
  });

  it('sorts Estimating by due date (undated last) and Active by recency', () => {
    const groups = groupSummaries([
      mk({ id: 'late', status: 'estimating', bidDueDate: 200 }),
      mk({ id: 'none', status: 'estimating', bidDueDate: null }),
      mk({ id: 'soon', status: 'estimating', bidDueDate: 100 }),
      mk({ id: 'old', status: 'awarded', updatedAt: 10 }),
      mk({ id: 'new', status: 'awarded', updatedAt: 20 }),
    ]);
    expect(groups[0].projects.map(p => p.id)).toEqual(['soon', 'late', 'none']);
    expect(groups[1].projects.map(p => p.id)).toEqual(['new', 'old']);
  });
});
