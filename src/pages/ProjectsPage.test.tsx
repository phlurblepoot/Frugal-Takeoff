// src/pages/ProjectsPage.test.tsx
import { describe, it, expect } from 'vitest';
import { groupSummaries, resolveTab, sortProjects, tabForProject } from './ProjectsPage';
import type { ProjectSummary } from '../utils/store';

const mk = (over: Partial<ProjectSummary>): ProjectSummary => ({
  id: 'x', name: 'P', status: 'bidding', contractor: null, customerId: null, address: null,
  bidDueDate: null, version: 1, createdAt: 1, updatedAt: null, archived: false,
  pageCount: 0, takeoffCount: 0, pageIds: [], openIssueCount: 0, punchDone: 0, punchTotal: 0, contractValueCents: 0, invoiceCount: 0, ...over,
});

describe('tabForProject', () => {
  it('routes the two live stages to their own tabs', () => {
    expect(tabForProject(mk({ status: 'bidding' }))).toBe('bidding');
    expect(tabForProject(mk({ status: 'in_progress' }))).toBe('in_progress');
  });

  it('lets archived win over whatever status the project carries', () => {
    expect(tabForProject(mk({ status: 'in_progress', archived: true }))).toBe('archive');
    expect(tabForProject(mk({ status: 'bidding', archived: true }))).toBe('archive');
  });

  it('collapses legacy statuses and folds unknown ones into bidding', () => {
    expect(tabForProject(mk({ status: 'proposal_sent' }))).toBe('bidding');
    expect(tabForProject(mk({ status: 'awarded' }))).toBe('in_progress');
    expect(tabForProject(mk({ status: 'punch_list' }))).toBe('in_progress');
    expect(tabForProject(mk({ status: 'something_weird' }))).toBe('bidding');
  });
});

describe('resolveTab', () => {
  it('accepts the three tab ids', () => {
    expect(resolveTab('bidding')).toBe('bidding');
    expect(resolveTab('in_progress')).toBe('in_progress');
    expect(resolveTab('archive')).toBe('archive');
  });

  it('lands old bookmarks on the tab their projects moved to', () => {
    expect(resolveTab('estimating')).toBe('bidding');
    expect(resolveTab('proposal_sent')).toBe('bidding');
    expect(resolveTab('awarded')).toBe('in_progress');
    expect(resolveTab('active')).toBe('in_progress');
    // migration 21 auto-archived complete and lost projects.
    expect(resolveTab('complete')).toBe('archive');
    expect(resolveTab('lost')).toBe('archive');
  });

  it('defaults to bidding when the param is missing or nonsense', () => {
    expect(resolveTab(null)).toBe('bidding');
    expect(resolveTab('')).toBe('bidding');
    expect(resolveTab('constructor')).toBe('bidding');
  });
});

describe('groupSummaries', () => {
  it('returns exactly the three tabs, in board order', () => {
    const groups = groupSummaries([]);
    expect(groups.map(g => g.id)).toEqual(['bidding', 'in_progress', 'archive']);
  });

  it('puts every project in exactly one tab', () => {
    const groups = groupSummaries([
      mk({ id: 'a', status: 'bidding' }),
      mk({ id: 'b', status: 'proposal_sent' }),
      mk({ id: 'c', status: 'in_progress' }),
      mk({ id: 'd', status: 'awarded' }),
      mk({ id: 'e', status: 'in_progress', archived: true }),
      mk({ id: 'f', status: 'something_weird' }),
    ], 'name');
    expect(groups[0].projects.map(p => p.id)).toEqual(['a', 'b', 'f']);
    expect(groups[1].projects.map(p => p.id)).toEqual(['c', 'd']);
    expect(groups[2].projects.map(p => p.id)).toEqual(['e']);
  });

  it('defaults bidding to bid-due order and the other tabs to last updated', () => {
    const groups = groupSummaries([
      mk({ id: 'late', status: 'bidding', bidDueDate: 200, updatedAt: 99 }),
      mk({ id: 'soon', status: 'bidding', bidDueDate: 100, updatedAt: 1 }),
      mk({ id: 'stale', status: 'in_progress', updatedAt: 10 }),
      mk({ id: 'fresh', status: 'in_progress', updatedAt: 20 }),
      mk({ id: 'old-arch', status: 'in_progress', archived: true, updatedAt: 10 }),
      mk({ id: 'new-arch', status: 'in_progress', archived: true, updatedAt: 20 }),
    ]);
    expect(groups[0].projects.map(p => p.id)).toEqual(['soon', 'late']);
    expect(groups[1].projects.map(p => p.id)).toEqual(['fresh', 'stale']);
    expect(groups[2].projects.map(p => p.id)).toEqual(['new-arch', 'old-arch']);
  });

  it('lets an explicit sort override every tab default', () => {
    const groups = groupSummaries([
      mk({ id: 'late', status: 'bidding', bidDueDate: 200, updatedAt: 99 }),
      mk({ id: 'soon', status: 'bidding', bidDueDate: 100, updatedAt: 1 }),
    ], 'updated');
    expect(groups[0].projects.map(p => p.id)).toEqual(['late', 'soon']);
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
