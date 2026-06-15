// src/pages/ProjectsPage.test.tsx
import { describe, it, expect } from 'vitest';
import { groupSummaries, sortProjects } from './ProjectsPage';
import type { ProjectSummary } from '../utils/store';

const mk = (over: Partial<ProjectSummary>): ProjectSummary => ({
  id: 'x', name: 'P', status: 'estimating', contractor: null, address: null,
  bidDueDate: null, version: 1, createdAt: 1, updatedAt: null, archived: false,
  pageCount: 0, takeoffCount: 0, pageIds: [], openIssueCount: 0, punchDone: 0, punchTotal: 0, contractValueCents: 0, invoiceCount: 0, ...over,
});

describe('groupSummaries', () => {
  it('gives every lifecycle stage its own group, in workflow order', () => {
    const groups = groupSummaries([
      mk({ id: 'a', status: 'estimating' }),
      mk({ id: 'b', status: 'proposal_sent' }),
      mk({ id: 'c', status: 'awarded' }),
      mk({ id: 'd', status: 'in_progress' }),
      mk({ id: 'e', status: 'punch_list' }),
      mk({ id: 'f', status: 'complete' }),
      mk({ id: 'g', status: 'lost' }),
    ]);
    expect(groups.map(g => g.id)).toEqual([
      'estimating', 'proposal_sent', 'awarded', 'in_progress', 'punch_list', 'complete', 'lost',
    ]);
    // estimating and proposal_sent are now separate groups.
    expect(groups[0].projects.map(p => p.id)).toEqual(['a']);
    expect(groups[1].projects.map(p => p.id)).toEqual(['b']);
    expect(groups[2].projects.map(p => p.id)).toEqual(['c']);
    expect(groups[6].projects.map(p => p.id)).toEqual(['g']);
  });

  it('drops archived projects and folds unknown statuses into Estimating', () => {
    const groups = groupSummaries([
      mk({ id: 'a', status: 'awarded', archived: true }),
      mk({ id: 'b', status: 'something_weird' }),
    ]);
    expect(groups.find(g => g.id === 'awarded')!.projects).toHaveLength(0);
    expect(groups[0].id).toBe('estimating');
    expect(groups[0].projects.map(p => p.id)).toEqual(['b']);
  });

  it('applies the chosen sort within each group (default: last updated)', () => {
    const groups = groupSummaries([
      mk({ id: 'old', status: 'awarded', updatedAt: 10 }),
      mk({ id: 'new', status: 'awarded', updatedAt: 20 }),
    ]);
    expect(groups.find(g => g.id === 'awarded')!.projects.map(p => p.id)).toEqual(['new', 'old']);
  });
});

describe('sortProjects', () => {
  it('sorts by name, date added, last updated, and bid due (undated last)', () => {
    const list = [
      mk({ id: 'b', name: 'Beta', createdAt: 100, updatedAt: 5, bidDueDate: 200 }),
      mk({ id: 'a', name: 'Alpha', createdAt: 300, updatedAt: 50, bidDueDate: null }),
      mk({ id: 'c', name: 'Gamma', createdAt: 200, updatedAt: 30, bidDueDate: 100 }),
    ];
    expect(sortProjects(list, 'name').map(p => p.id)).toEqual(['a', 'b', 'c']);
    expect(sortProjects(list, 'created').map(p => p.id)).toEqual(['a', 'c', 'b']);
    expect(sortProjects(list, 'updated').map(p => p.id)).toEqual(['a', 'c', 'b']);
    expect(sortProjects(list, 'bidDue').map(p => p.id)).toEqual(['c', 'b', 'a']);
  });
});
