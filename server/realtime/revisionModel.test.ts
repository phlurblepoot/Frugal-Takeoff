import { describe, it, expect, beforeEach } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from '../db';
import { runMigrations } from '../migrations';
import { migrations } from '../migrationList';
import { createProject } from '../projectStore';
import { effectiveSheetIdFromRow, isPageSuperseded, type PageRow } from './revisionModel';

const tmpDir = () => fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-revmodel-'));

let db: Database.Database;
let dir: string;

beforeEach(() => {
  dir = tmpDir();
  db = openDb(':memory:');
  runMigrations(db, dir, migrations);
});

// Seeds one project with two plan sets (s1 older, s2 newer) and pages
// covering: a shared-sheetId revision pair, a unique page, and a pair that
// only shares a normalized pageNumber (no sheetId — the legacy fallback).
const seed = () => {
  createProject(db, {
    id: 'pr1', name: 'P', createdAt: 1,
    planSets: [
      { id: 's1', name: 'Set 1', createdAt: 1 },
      { id: 's2', name: 'Set 2', createdAt: 2 },
    ],
    takeoffs: [],
    pages: [
      // sheetId-grouped revisions of one sheet
      { id: 'a1', pageNumber: 'A-101', planSetId: 's1', sheetId: 'SH-A', measurements: [] },
      { id: 'a2', pageNumber: 'A-101', planSetId: 's2', sheetId: 'SH-A', measurements: [] },
      // unique page — its own single-revision sheet
      { id: 'c1', pageNumber: 'C-300', planSetId: 's1', sheetId: 'SH-C', measurements: [] },
      // no sheetId — grouped by normalized pageNumber only
      { id: 'b1', pageNumber: 'B-200', planSetId: 's1', measurements: [] },
      { id: 'b2', pageNumber: 'b-200 ', planSetId: 's2', measurements: [] },
    ],
  });
};

describe('isPageSuperseded', () => {
  beforeEach(seed);

  it('case 1: page in the older plan set with a shared sheetId is superseded', () => {
    expect(isPageSuperseded(db, 'pr1', 'a1')).toBe(true);
  });

  it('case 2: page in the newest plan set with a shared sheetId is current (not superseded)', () => {
    expect(isPageSuperseded(db, 'pr1', 'a2')).toBe(false);
  });

  it('case 3: a unique page (no other revision) is not superseded', () => {
    expect(isPageSuperseded(db, 'pr1', 'c1')).toBe(false);
  });

  it('case 4: fallback grouping via normalized pageNumber (no sheetId) — older true, newer false', () => {
    expect(isPageSuperseded(db, 'pr1', 'b1')).toBe(true);
    expect(isPageSuperseded(db, 'pr1', 'b2')).toBe(false);
  });

  it('case 5: an unknown pageId is treated as not-superseded', () => {
    expect(isPageSuperseded(db, 'pr1', 'does-not-exist')).toBe(false);
  });
});

describe('effectiveSheetIdFromRow', () => {
  it('case 6: attrs.sheetId beats pageNumber beats id', () => {
    const withSheetId: PageRow = { id: 'x', planSetId: null, pageNumber: 'A-101', attrs: JSON.stringify({ sheetId: 'S' }) };
    expect(effectiveSheetIdFromRow(withSheetId)).toBe('S');

    const withPageNumberOnly: PageRow = { id: 'x', planSetId: null, pageNumber: 'A-101', attrs: null };
    expect(effectiveSheetIdFromRow(withPageNumberOnly)).toBe('pn:a-101');

    const withNeither: PageRow = { id: 'x', planSetId: null, pageNumber: '', attrs: null };
    expect(effectiveSheetIdFromRow(withNeither)).toBe('id:x');
  });
});
