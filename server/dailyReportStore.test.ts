import { describe, it, expect, beforeEach } from 'vitest';
import fsSync from 'fs'; import os from 'os'; import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import { putBuffer } from './files';
import {
  getDailyReport, listDailyReports, createDailyReport, saveDailyReport, deleteDailyReport, previousStartTime,
  addPhoto, removePhoto, addAttachment, updateAttachment, removeAttachment,
  ValidationError, ConflictError, NotFoundError, DateTakenError,
} from './dailyReportStore';

let db: Database.Database;
let dir: string;
beforeEach(() => {
  db = openDb(':memory:');
  dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-daily-'));
  runMigrations(db, dir, migrations);
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
    expect(row.attachments).toEqual([]);
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

// Start time (spec docs/superpowers/specs/2026-10-06-daily-report-start-time-design.md):
// 'HH:MM' or null; a new report without one copies the previous report's.
describe('startTime', () => {
  // A report made before migration 44, which keeps NULL.
  const legacy = (projectId: string, reportDate: string) => {
    const { id } = createDailyReport(db, projectId, { reportDate });
    db.prepare('UPDATE daily_reports SET startTime = NULL WHERE id = ?').run(id);
    return id;
  };

  it('round-trips through create, get, list and save; an omitted startTime keeps it, null clears it', () => {
    const { id } = createDailyReport(db, 'p1', { reportDate: '2026-08-26', startTime: '07:30' });
    expect(getDailyReport(db, id).startTime).toBe('07:30');
    expect(listDailyReports(db, 'p1')[0].startTime).toBe('07:30');

    saveDailyReport(db, id, { version: 1, startTime: '05:45' });
    expect(getDailyReport(db, id).startTime).toBe('05:45');
    saveDailyReport(db, id, { version: 2, fieldNotes: 'x' });
    expect(getDailyReport(db, id).startTime).toBe('05:45');
    saveDailyReport(db, id, { version: 3, startTime: null });
    expect(getDailyReport(db, id).startTime).toBeNull();
  });

  it('rejects anything but HH:MM from 00:00 to 23:59, on create and on save', () => {
    const { id } = createDailyReport(db, 'p1', { reportDate: '2026-08-26' });
    for (const bad of ['7:00', '24:00', '12:60', '07:00:00', 'noon', '', 700]) {
      expect(() => createDailyReport(db, 'p1', { reportDate: '2026-08-27', startTime: bad as any }), String(bad)).toThrow(ValidationError);
      expect(() => saveDailyReport(db, id, { version: 1, startTime: bad as any }), String(bad)).toThrow(ValidationError);
    }
    expect(getDailyReport(db, id).version).toBe(1); // nothing was written
    expect(listDailyReports(db, 'p1')).toHaveLength(1);
    createDailyReport(db, 'p1', { reportDate: '2026-08-27', startTime: '23:59' });
    createDailyReport(db, 'p1', { reportDate: '2026-08-28', startTime: '00:00' });
  });

  it('defaults to 6 AM with no earlier report, or only ones without a start time', () => {
    const first = createDailyReport(db, 'p1', { reportDate: '2026-08-26' });
    expect(getDailyReport(db, first.id).startTime).toBe('06:00');
    legacy('p2', '2026-08-20');
    const afterLegacy = createDailyReport(db, 'p2', { reportDate: '2026-08-21' });
    expect(getDailyReport(db, afterLegacy.id).startTime).toBe('06:00');
  });

  it('copies the latest earlier report\'s start time, skipping ones without one', () => {
    createDailyReport(db, 'p1', { reportDate: '2026-08-20', startTime: '05:00' });
    createDailyReport(db, 'p1', { reportDate: '2026-08-22', startTime: '07:00' });
    legacy('p1', '2026-08-23');
    createDailyReport(db, 'p1', { reportDate: '2026-08-25', startTime: '08:00' }); // later: not "previous"
    createDailyReport(db, 'p2', { reportDate: '2026-08-23', startTime: '09:00' }); // other project
    const { id } = createDailyReport(db, 'p1', { reportDate: '2026-08-24' });
    expect(getDailyReport(db, id).startTime).toBe('07:00');
    // An explicit start time wins over the copy.
    const own = createDailyReport(db, 'p1', { reportDate: '2026-08-21', startTime: '06:30' });
    expect(getDailyReport(db, own.id).startTime).toBe('06:30');
  });

  it('a day filled in before the first report copies the latest-dated report that has one', () => {
    createDailyReport(db, 'p1', { reportDate: '2026-08-20', startTime: '07:00' });
    createDailyReport(db, 'p1', { reportDate: '2026-08-25', startTime: '08:00' });
    legacy('p1', '2026-08-27');
    expect(previousStartTime(db, 'p1', '2026-08-01')).toBe('08:00');
    expect(previousStartTime(db, 'p1', '2026-08-22')).toBe('07:00');
    expect(previousStartTime(db, 'p2', '2026-08-22')).toBe('06:00');
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
  it('removePhoto throws NotFoundError for a missing report id', () => {
    expect(() => removePhoto(db, 'nope', 'f1')).toThrow(NotFoundError);
  });
  it('addPhoto and removePhoto stamp updatedAt (without touching version)', () => {
    const { id } = createDailyReport(db, 'p1', { reportDate: '2026-08-26' });
    // Force a stale updatedAt so the bump is unambiguous even on a fast clock.
    const stale = getDailyReport(db, id).updatedAt - 1000;
    db.prepare('UPDATE daily_reports SET updatedAt = ? WHERE id = ?').run(stale, id);

    addPhoto(db, id, 'f1');
    let row = getDailyReport(db, id);
    expect(row.updatedAt).toBeGreaterThan(stale);
    expect(row.version).toBe(1);

    db.prepare('UPDATE daily_reports SET updatedAt = ? WHERE id = ?').run(stale, id);
    removePhoto(db, id, 'f1');
    row = getDailyReport(db, id);
    expect(row.updatedAt).toBeGreaterThan(stale);
    expect(row.version).toBe(1);
  });
});

// PDF attachments: same contract as the invoice's; like this report's photos
// they stamp updatedAt — the clock the generated-PDF chip compares against —
// so the stored PDF reads out of date, and leave version alone.
describe('attachments', () => {
  const pdfFile = (id: string) => putBuffer(db, dir, id, Buffer.from('%PDF'), 'application/pdf', { projectId: 'p1', kind: 'document', name: `${id}.pdf` });
  const stale = (id: string) => db.prepare('UPDATE daily_reports SET updatedAt = 1 WHERE id = ?').run(id);

  it('only an existing PDF can be attached, to an existing report', () => {
    const { id } = createDailyReport(db, 'p1', { reportDate: '2026-08-26' });
    putBuffer(db, dir, 'img', Buffer.from('x'), 'image/jpeg', { projectId: 'p1', kind: 'daily-report-photo', name: 'img.jpg' });
    expect(() => addAttachment(db, id, 'img')).toThrow(ValidationError);
    expect(() => addAttachment(db, id, 'missing')).toThrow(NotFoundError);
    expect(() => addAttachment(db, id, '')).toThrow(ValidationError);
    pdfFile('a1');
    expect(() => addAttachment(db, 'nope', 'a1')).toThrow(NotFoundError);
  });

  it('adds idempotently in order, reorders, removes — stamping updatedAt but never version', () => {
    const { id } = createDailyReport(db, 'p1', { reportDate: '2026-08-26' });
    pdfFile('a1'); pdfFile('a2');
    stale(id);
    addAttachment(db, id, 'a1');
    addAttachment(db, id, 'a1'); // idempotent
    addAttachment(db, id, 'a2');
    let row = getDailyReport(db, id);
    expect(row.attachments).toEqual([
      expect.objectContaining({ fileId: 'a1', sortOrder: 0, name: 'a1.pdf', mime: 'application/pdf' }),
      expect.objectContaining({ fileId: 'a2', sortOrder: 1, name: 'a2.pdf', mime: 'application/pdf' }),
    ]);
    expect(row.updatedAt).toBeGreaterThan(1);
    expect(row.version).toBe(1);

    stale(id);
    updateAttachment(db, id, 'a1', { sortOrder: 5 });
    row = getDailyReport(db, id);
    expect(row.attachments.map((a: any) => a.fileId)).toEqual(['a2', 'a1']);
    expect(row.updatedAt).toBeGreaterThan(1);
    expect(row.version).toBe(1);
    expect(() => updateAttachment(db, id, 'nope', { sortOrder: 0 })).toThrow(NotFoundError);

    stale(id);
    removeAttachment(db, id, 'a1');
    row = getDailyReport(db, id);
    expect(row.attachments.map((a: any) => a.fileId)).toEqual(['a2']);
    expect(row.updatedAt).toBeGreaterThan(1);
    expect(row.version).toBe(1);
  });
});

describe('deleteDailyReport', () => {
  it('deletes the row and its photo and attachment joins, and frees the date', () => {
    const { id } = createDailyReport(db, 'p1', { reportDate: '2026-08-26' });
    addPhoto(db, id, 'f1');
    putBuffer(db, dir, 'a1', Buffer.from('%PDF'), 'application/pdf', { projectId: 'p1', kind: 'document', name: 'a1.pdf' });
    addAttachment(db, id, 'a1');
    deleteDailyReport(db, id);
    expect(getDailyReport(db, id)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) c FROM daily_report_photos WHERE dailyReportId = ?').get(id)).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM daily_report_attachments WHERE dailyReportId = ?').get(id)).toEqual({ c: 0 });
    createDailyReport(db, 'p1', { reportDate: '2026-08-26' }); // date reusable
  });
  it('throws NotFoundError for a missing id', () => {
    expect(() => deleteDailyReport(db, 'nope')).toThrow(NotFoundError);
  });
});
