import { describe, it, expect, beforeEach } from 'vitest';
import fsSync from 'fs'; import os from 'os'; import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import {
  getDailyReport, listDailyReports, createDailyReport, saveDailyReport, deleteDailyReport,
  addPhoto, removePhoto, ValidationError, ConflictError, NotFoundError, DateTakenError,
} from './dailyReportStore';

let db: Database.Database;
beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db, fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-daily-')), migrations);
  db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p1', 'Proj', 1);
  db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p2', 'Proj2', 1);
});

describe('createDailyReport', () => {
  it('creates with prefills and returns the id', () => {
    const r = createDailyReport(db, 'p1', { reportDate: '2026-08-26', jobName: 'Job', contractorName: 'GC' }, 'nathan');
    const row = getDailyReport(db, r.id);
    expect(row.reportDate).toBe('2026-08-26');
    expect(row.jobName).toBe('Job');
    expect(row.version).toBe(1);
    expect(row.createdBy).toBe('nathan');
    expect(row.photos).toEqual([]);
    expect(row.manCounts).toEqual([]);
    expect(row.weatherHourly).toEqual([]);
  });
  it('rejects a missing or malformed reportDate', () => {
    expect(() => createDailyReport(db, 'p1', {})).toThrow(ValidationError);
    expect(() => createDailyReport(db, 'p1', { reportDate: '8/26/2026' })).toThrow(ValidationError);
  });
  it('throws DateTakenError carrying the existing id on a duplicate date', () => {
    const r = createDailyReport(db, 'p1', { reportDate: '2026-08-26' });
    try {
      createDailyReport(db, 'p1', { reportDate: '2026-08-26' });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(DateTakenError);
      expect((e as DateTakenError).existingId).toBe(r.id);
    }
    // same date, other project: fine
    createDailyReport(db, 'p2', { reportDate: '2026-08-26' });
  });
  it('throws NotFoundError for a missing project', () => {
    expect(() => createDailyReport(db, 'nope', { reportDate: '2026-08-26' })).toThrow(NotFoundError);
  });
});

describe('saveDailyReport', () => {
  it('saves all fields, round-trips JSON columns, bumps version', () => {
    const { id } = createDailyReport(db, 'p1', { reportDate: '2026-08-26' });
    const out = saveDailyReport(db, id, {
      version: 1, jobName: 'J', contractorName: 'C', weatherSummary: 'Sunny', temperature: '70–80°F',
      weatherHourly: [{ hour: '6 AM', tempF: 71, condition: 'Clear' }],
      manCounts: [{ type: 'Plasterer', count: 4 }, { type: 'Supervisor', count: 1 }],
      fieldNotes: 'notes', issues: 'none',
    });
    expect(out.version).toBe(2);
    const row = getDailyReport(db, id);
    expect(row.manCounts).toEqual([{ type: 'Plasterer', count: 4 }, { type: 'Supervisor', count: 1 }]);
    expect(row.weatherHourly[0].condition).toBe('Clear');
  });
  it('requires an integer version and throws ConflictError on mismatch', () => {
    const { id } = createDailyReport(db, 'p1', { reportDate: '2026-08-26' });
    expect(() => saveDailyReport(db, id, { fieldNotes: 'x' })).toThrow(ValidationError);
    expect(() => saveDailyReport(db, id, { version: 99, fieldNotes: 'x' })).toThrow(ConflictError);
  });
  it('moves the report to a free date, and throws DateTakenError moving onto a taken one', () => {
    const a = createDailyReport(db, 'p1', { reportDate: '2026-08-25' });
    createDailyReport(db, 'p1', { reportDate: '2026-08-26' });
    saveDailyReport(db, a.id, { version: 1, reportDate: '2026-08-27' });
    expect(getDailyReport(db, a.id).reportDate).toBe('2026-08-27');
    expect(() => saveDailyReport(db, a.id, { version: 2, reportDate: '2026-08-26' })).toThrow(DateTakenError);
  });
  it('throws NotFoundError for a missing id', () => {
    expect(() => saveDailyReport(db, 'nope', { version: 1 })).toThrow(NotFoundError);
  });
});

describe('listDailyReports', () => {
  it('lists newest date first with photoCount and parsed manCounts', () => {
    const a = createDailyReport(db, 'p1', { reportDate: '2026-08-24' });
    const b = createDailyReport(db, 'p1', { reportDate: '2026-08-26' });
    saveDailyReport(db, a.id, { version: 1, manCounts: [{ type: 'Plasterer', count: 3 }] });
    addPhoto(db, a.id, 'f1'); addPhoto(db, a.id, 'f2');
    const list = listDailyReports(db, 'p1');
    expect(list.map((r: any) => r.reportDate)).toEqual(['2026-08-26', '2026-08-24']);
    expect(list[1].photoCount).toBe(2);
    expect(list[1].manCounts).toEqual([{ type: 'Plasterer', count: 3 }]);
    expect(list[0].photoCount).toBe(0);
    expect(listDailyReports(db, 'p2')).toEqual([]);
  });
});

describe('photos', () => {
  it('adds idempotently with increasing sortOrder, removes, never bumps version', () => {
    const { id } = createDailyReport(db, 'p1', { reportDate: '2026-08-26' });
    addPhoto(db, id, 'f1'); addPhoto(db, id, 'f1'); addPhoto(db, id, 'f2');
    let row = getDailyReport(db, id);
    expect(row.photos.map((p: any) => p.fileId)).toEqual(['f1', 'f2']);
    expect(row.photos[1].sortOrder).toBeGreaterThan(row.photos[0].sortOrder);
    expect(row.version).toBe(1);
    removePhoto(db, id, 'f1');
    row = getDailyReport(db, id);
    expect(row.photos.map((p: any) => p.fileId)).toEqual(['f2']);
    expect(row.version).toBe(1);
  });
});

describe('deleteDailyReport', () => {
  it('deletes the row and its photo joins, and frees the date', () => {
    const { id } = createDailyReport(db, 'p1', { reportDate: '2026-08-26' });
    addPhoto(db, id, 'f1');
    deleteDailyReport(db, id);
    expect(getDailyReport(db, id)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) c FROM daily_report_photos WHERE dailyReportId = ?').get(id)).toEqual({ c: 0 });
    createDailyReport(db, 'p1', { reportDate: '2026-08-26' }); // date reusable
  });
  it('throws NotFoundError for a missing id', () => {
    expect(() => deleteDailyReport(db, 'nope')).toThrow(NotFoundError);
  });
});
