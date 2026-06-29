import { it, expect } from 'vitest';
import { computeRevisionModel, effectiveSheetId } from './planSets';
import type { Project, ProjectPage } from '../types';

const page = (o: Partial<ProjectPage>): ProjectPage => ({
  id: 'p', name: '', pageNumber: '', description: '', imageId: '', thumbnailId: '',
  imageWidth: 0, imageHeight: 0, measurements: [], scaleConfig: null, ...o,
} as ProjectPage);

const proj = (pages: ProjectPage[], planSets: any[]): Project => ({
  id: 'pr', name: 'x', createdAt: 0, pages, takeoffs: [], planSets,
} as Project);

const sets = [
  { id: 's1', name: 'Set 1', createdAt: 1 },
  { id: 's2', name: 'Set 2', createdAt: 2 },
];

it('current revision is the newest page sharing a sheetId', () => {
  const a1 = page({ id: 'a1', sheetId: 'A', pageNumber: 'A-101', planSetId: 's1', measurements: [{ id: 'm', type: 'length', points: [], takeoffId: 't' } as any] });
  const a2 = page({ id: 'a2', sheetId: 'A', pageNumber: 'A-101', planSetId: 's2', measurements: [{ id: 'm2', type: 'length', points: [], takeoffId: 't' } as any] });
  const m = computeRevisionModel(proj([a1, a2], sets), '');
  expect([...m.currentPageIds]).toEqual(['a2']);            // newest only
  expect(m.status('a1')).toBe('superseded');
  expect(m.status('a2')).toBe('current');
  expect(m.revisionNumberByPageId.get('a1')).toBe(1);
  expect(m.revisionNumberByPageId.get('a2')).toBe(2);
});

it('as-of an older set shows that revision (read-only history)', () => {
  const a1 = page({ id: 'a1', sheetId: 'A', pageNumber: 'A-101', planSetId: 's1' });
  const a2 = page({ id: 'a2', sheetId: 'A', pageNumber: 'A-101', planSetId: 's2' });
  const m = computeRevisionModel(proj([a1, a2], sets), 's1');  // as of Set 1
  expect([...m.currentPageIds]).toEqual(['a1']);
});

it('falls back to pageNumber when sheetId is missing (legacy)', () => {
  const a1 = page({ id: 'a1', pageNumber: 'A-101', planSetId: 's1' });
  const a2 = page({ id: 'a2', pageNumber: 'A-101', planSetId: 's2' });
  const m = computeRevisionModel(proj([a1, a2], sets), '');
  expect([...m.currentPageIds]).toEqual(['a2']);
});

it('distinct sheetIds with the same pageNumber are separate sheets (not revisions)', () => {
  const a1 = page({ id: 'a1', sheetId: 'A', pageNumber: 'A-101', planSetId: 's1' });
  const b1 = page({ id: 'b1', sheetId: 'B', pageNumber: 'A-101', planSetId: 's1' });
  const m = computeRevisionModel(proj([a1, b1], sets), '');
  expect(new Set(m.currentPageIds)).toEqual(new Set(['a1', 'b1']));
});

it('effectiveSheetId prefers sheetId, then page number, then id', () => {
  expect(effectiveSheetId(page({ id: 'x', sheetId: 'S', pageNumber: 'A-101' }))).toBe('S');
  expect(effectiveSheetId(page({ id: 'x', pageNumber: 'A-101' }))).toBe('pn:a-101');
  expect(effectiveSheetId(page({ id: 'x', pageNumber: '' }))).toBe('id:x');
});
