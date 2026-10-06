// server/dailyReportStore.ts
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import {
  type PdfAttachmentTable, listPdfAttachments, addPdfAttachment, updatePdfAttachment, removePdfAttachment,
} from './pdfAttachments';
import { DEFAULT_START_TIME, isStartTime } from './weather';

export class ValidationError extends Error {}
export class ConflictError extends Error {}
export class NotFoundError extends Error {}
export class DateTakenError extends Error {
  constructor(public existingId: string) { super('date_taken'); }
}

export interface ManCountLine { type: string; count: number; }
export interface DailyWeatherHour { hour: string; tempF: number | null; condition: string; }
export interface DailyReportInput {
  reportDate?: string; startTime?: string | null; jobName?: string; contractorName?: string;
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

// startTime is 'HH:MM' (24-hour) or null — null on reports made before
// migration 44, and when someone clears it.
function checkStartTime(v: unknown): string | null {
  if (v === null) return null;
  if (!isStartTime(v)) throw new ValidationError('startTime is malformed (HH:MM)');
  return v;
}

// A new report's start time when none is given: the previous report's — the
// latest one dated before it that has a start time; failing that (a day filled
// in before the first report), the latest-dated one that has one; else 6 AM,
// which is the original fixed weather window. Kept to this one function so it
// can narrow to a crew's own reports later.
export function previousStartTime(db: Database.Database, projectId: string, reportDate: string): string {
  const row = db.prepare(`SELECT startTime FROM daily_reports
      WHERE projectId = ? AND startTime IS NOT NULL
      ORDER BY reportDate < ? DESC, reportDate DESC LIMIT 1`).get(projectId, reportDate) as any;
  return row?.startTime ?? DEFAULT_START_TIME;
}

function photoCount(db: Database.Database, dailyReportId: string): number {
  return (db.prepare('SELECT COUNT(*) c FROM daily_report_photos WHERE dailyReportId = ?').get(dailyReportId) as any).c;
}

export function getDailyReport(db: Database.Database, id: string): any | null {
  const row = db.prepare('SELECT * FROM daily_reports WHERE id = ?').get(id) as any;
  if (!row) return null;
  const photos = db.prepare('SELECT id, fileId, sortOrder FROM daily_report_photos WHERE dailyReportId = ? ORDER BY sortOrder')
    .all(id) as any[];
  const attachments = listPdfAttachments(db, DAILY_REPORT_ATTACHMENTS, id);
  return { ...row, weatherHourly: parseArr(row.weatherHourly), manCounts: parseArr(row.manCounts), photos, attachments };
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
  const startTime = input.startTime == null
    ? previousStartTime(db, projectId, input.reportDate)
    : checkStartTime(input.startTime);
  const existing = takenBy(db, projectId, input.reportDate);
  if (existing) throw new DateTakenError(existing);
  const id = uuidv4();
  const now = Date.now();
  db.prepare(`INSERT INTO daily_reports
      (id, projectId, reportDate, startTime, jobName, contractorName, weatherSummary, temperature,
       weatherHourly, manCounts, fieldNotes, issues, createdBy, createdAt, updatedAt, version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
    .run(id, projectId, input.reportDate, startTime, input.jobName ?? '', input.contractorName ?? '',
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
  // undefined keeps the stored start time; null clears it.
  const startTime = input.startTime === undefined ? row.startTime : checkStartTime(input.startTime);
  const newVersion = row.version + 1;
  db.prepare(`UPDATE daily_reports SET
      reportDate = ?, startTime = ?, jobName = ?, contractorName = ?, weatherSummary = ?, temperature = ?,
      weatherHourly = ?, manCounts = ?, fieldNotes = ?, issues = ?, version = ?, updatedAt = ?
      WHERE id = ?`)
    .run(
      input.reportDate ?? row.reportDate,
      startTime,
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
    db.prepare('DELETE FROM daily_report_attachments WHERE dailyReportId = ?').run(id);
    db.prepare('DELETE FROM daily_reports WHERE id = ?').run(id);
  });
  tx();
}

// addPhoto/removePhoto deliberately leave `version` alone (see routes.ts —
// bumping it would poison the client's version-dedupe), but they DO stamp
// `updatedAt` so a photo change still counts as "the record moved on" for
// anything comparing against it (the document-actions freshness chip / the
// send-reuses-current-file check).
export function addPhoto(db: Database.Database, dailyReportId: string, fileId: string): void {
  if (!db.prepare('SELECT id FROM daily_reports WHERE id = ?').get(dailyReportId)) throw new NotFoundError('Daily report not found');
  if (typeof fileId !== 'string' || !fileId) throw new ValidationError('fileId is required');
  const exists = db.prepare('SELECT id FROM daily_report_photos WHERE dailyReportId = ? AND fileId = ?').get(dailyReportId, fileId);
  if (exists) return; // idempotent
  const max = (db.prepare('SELECT COALESCE(MAX(sortOrder), -1) m FROM daily_report_photos WHERE dailyReportId = ?').get(dailyReportId) as any).m;
  db.prepare('INSERT INTO daily_report_photos (id, dailyReportId, fileId, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?)')
    .run(uuidv4(), dailyReportId, fileId, max + 1, Date.now());
  db.prepare('UPDATE daily_reports SET updatedAt = ? WHERE id = ?').run(Date.now(), dailyReportId);
}

export function removePhoto(db: Database.Database, dailyReportId: string, fileId: string): void {
  if (!db.prepare('SELECT id FROM daily_reports WHERE id = ?').get(dailyReportId)) throw new NotFoundError('Daily report not found');
  db.prepare('DELETE FROM daily_report_photos WHERE dailyReportId = ? AND fileId = ?').run(dailyReportId, fileId);
  db.prepare('UPDATE daily_reports SET updatedAt = ? WHERE id = ?').run(Date.now(), dailyReportId);
}

// PDF attachments, appended to the generated daily report after its photos.
// Same freshness rule as the photos above: updatedAt moves — the clock the
// document-actions chip and Send's reuse check compare the stored PDF against
// — and version is left alone.
const DAILY_REPORT_ATTACHMENTS: PdfAttachmentTable = {
  table: 'daily_report_attachments', ownerColumn: 'dailyReportId', ownerTable: 'daily_reports',
  notFoundMessage: 'Daily report not found', noun: 'daily report',
  NotFoundError, ValidationError,
  touch: (db, dailyReportId) => { db.prepare('UPDATE daily_reports SET updatedAt = ? WHERE id = ?').run(Date.now(), dailyReportId); },
};

export function addAttachment(db: Database.Database, dailyReportId: string, fileId: string): void {
  addPdfAttachment(db, DAILY_REPORT_ATTACHMENTS, dailyReportId, fileId);
}

export function updateAttachment(db: Database.Database, dailyReportId: string, fileId: string, patch: { sortOrder: number }): void {
  updatePdfAttachment(db, DAILY_REPORT_ATTACHMENTS, dailyReportId, fileId, patch);
}

export function removeAttachment(db: Database.Database, dailyReportId: string, fileId: string): void {
  removePdfAttachment(db, DAILY_REPORT_ATTACHMENTS, dailyReportId, fileId);
}
