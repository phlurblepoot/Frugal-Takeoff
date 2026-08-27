// server/dailyReportStore.ts
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

export class ValidationError extends Error {}
export class ConflictError extends Error {}
export class NotFoundError extends Error {}
export class DateTakenError extends Error {
  constructor(public existingId: string) { super('date_taken'); }
}

export interface ManCountLine { type: string; count: number; }
export interface DailyWeatherHour { hour: string; tempF: number | null; condition: string; }
export interface DailyReportInput {
  reportDate?: string; jobName?: string; contractorName?: string;
  weatherSummary?: string; temperature?: string; weatherHourly?: DailyWeatherHour[];
  manCounts?: ManCountLine[]; fieldNotes?: string; issues?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const parseArr = (s: string | null): any[] => { try { const v = JSON.parse(s ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };

function requireProject(db: Database.Database, projectId: string): void {
  if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) throw new NotFoundError('Project not found');
}

// Returns the id of the report already occupying (projectId, reportDate), if
// any, excluding excludeId (used when a save moves a report onto a date it
// already occupies).
function takenBy(db: Database.Database, projectId: string, reportDate: string, excludeId?: string): string | undefined {
  const row = db.prepare('SELECT id FROM daily_reports WHERE projectId = ? AND reportDate = ?').get(projectId, reportDate) as any;
  return row && row.id !== excludeId ? row.id : undefined;
}

function photoCount(db: Database.Database, dailyReportId: string): number {
  return (db.prepare('SELECT COUNT(*) c FROM daily_report_photos WHERE dailyReportId = ?').get(dailyReportId) as any).c;
}

export function getDailyReport(db: Database.Database, id: string): any | null {
  const row = db.prepare('SELECT * FROM daily_reports WHERE id = ?').get(id) as any;
  if (!row) return null;
  const photos = db.prepare('SELECT id, fileId, sortOrder FROM daily_report_photos WHERE dailyReportId = ? ORDER BY sortOrder')
    .all(id) as any[];
  return { ...row, weatherHourly: parseArr(row.weatherHourly), manCounts: parseArr(row.manCounts), photos };
}

export function listDailyReports(db: Database.Database, projectId: string): any[] {
  const rows = db.prepare('SELECT * FROM daily_reports WHERE projectId = ? ORDER BY reportDate DESC').all(projectId) as any[];
  return rows.map(r => {
    const { weatherHourly, fieldNotes, issues, ...summary } = r;
    return { ...summary, manCounts: parseArr(r.manCounts), photoCount: photoCount(db, r.id) };
  });
}

export function createDailyReport(db: Database.Database, projectId: string, input: DailyReportInput, createdBy?: string): { id: string } {
  requireProject(db, projectId);
  if (!input.reportDate || !DATE_RE.test(input.reportDate)) throw new ValidationError('reportDate is required (YYYY-MM-DD)');
  const existing = takenBy(db, projectId, input.reportDate);
  if (existing) throw new DateTakenError(existing);
  const id = uuidv4();
  const now = Date.now();
  db.prepare(`INSERT INTO daily_reports
      (id, projectId, reportDate, jobName, contractorName, weatherSummary, temperature,
       weatherHourly, manCounts, fieldNotes, issues, createdBy, createdAt, updatedAt, version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
    .run(id, projectId, input.reportDate, input.jobName ?? '', input.contractorName ?? '',
         input.weatherSummary ?? '', input.temperature ?? '',
         JSON.stringify(input.weatherHourly ?? []), JSON.stringify(input.manCounts ?? []),
         input.fieldNotes ?? '', input.issues ?? '', createdBy ?? null, now, now);
  return { id };
}

export function saveDailyReport(db: Database.Database, id: string, input: DailyReportInput & { version?: number }): { version: number } {
  const row = db.prepare('SELECT * FROM daily_reports WHERE id = ?').get(id) as any;
  if (!row) throw new NotFoundError('Daily report not found');
  if (!Number.isInteger(input.version)) throw new ValidationError('version required');
  if (row.version !== input.version) throw new ConflictError('daily report was modified');
  if (input.reportDate !== undefined) {
    if (!DATE_RE.test(input.reportDate)) throw new ValidationError('reportDate is malformed (YYYY-MM-DD)');
    const existing = takenBy(db, row.projectId, input.reportDate, id);
    if (existing) throw new DateTakenError(existing);
  }
  const newVersion = row.version + 1;
  db.prepare(`UPDATE daily_reports SET
      reportDate = ?, jobName = ?, contractorName = ?, weatherSummary = ?, temperature = ?,
      weatherHourly = ?, manCounts = ?, fieldNotes = ?, issues = ?, version = ?, updatedAt = ?
      WHERE id = ?`)
    .run(
      input.reportDate ?? row.reportDate,
      input.jobName ?? row.jobName,
      input.contractorName ?? row.contractorName,
      input.weatherSummary ?? row.weatherSummary,
      input.temperature ?? row.temperature,
      JSON.stringify(input.weatherHourly ?? parseArr(row.weatherHourly)),
      JSON.stringify(input.manCounts ?? parseArr(row.manCounts)),
      input.fieldNotes ?? row.fieldNotes,
      input.issues ?? row.issues,
      newVersion,
      Date.now(),
      id,
    );
  return { version: newVersion };
}

export function deleteDailyReport(db: Database.Database, id: string): void {
  const row = db.prepare('SELECT id FROM daily_reports WHERE id = ?').get(id);
  if (!row) throw new NotFoundError('Daily report not found');
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM daily_report_photos WHERE dailyReportId = ?').run(id);
    db.prepare('DELETE FROM daily_reports WHERE id = ?').run(id);
  });
  tx();
}

export function addPhoto(db: Database.Database, dailyReportId: string, fileId: string): void {
  if (!db.prepare('SELECT id FROM daily_reports WHERE id = ?').get(dailyReportId)) throw new NotFoundError('Daily report not found');
  if (typeof fileId !== 'string' || !fileId) throw new ValidationError('fileId is required');
  const exists = db.prepare('SELECT id FROM daily_report_photos WHERE dailyReportId = ? AND fileId = ?').get(dailyReportId, fileId);
  if (exists) return; // idempotent
  const max = (db.prepare('SELECT COALESCE(MAX(sortOrder), -1) m FROM daily_report_photos WHERE dailyReportId = ?').get(dailyReportId) as any).m;
  db.prepare('INSERT INTO daily_report_photos (id, dailyReportId, fileId, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?)')
    .run(uuidv4(), dailyReportId, fileId, max + 1, Date.now());
}

export function removePhoto(db: Database.Database, dailyReportId: string, fileId: string): void {
  db.prepare('DELETE FROM daily_report_photos WHERE dailyReportId = ? AND fileId = ?').run(dailyReportId, fileId);
}
