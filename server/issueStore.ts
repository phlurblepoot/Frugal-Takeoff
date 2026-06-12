// server/issueStore.ts
import type Database from 'better-sqlite3';
import crypto from 'crypto';

export class ValidationError extends Error {}
export class ConflictError extends Error {}
export class NotFoundError extends Error {}

export const ISSUE_STATUSES = ['open', 'sent', 'resolved'] as const;

function requireProject(db: Database.Database, projectId: string): void {
  if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) throw new NotFoundError('Project not found');
}

interface IssueInput { title?: string; description?: string; status?: string; }

function photoCount(db: Database.Database, issueId: string): number {
  return (db.prepare('SELECT COUNT(*) c FROM issue_photos WHERE issueId = ?').get(issueId) as any).c;
}

export function getIssue(db: Database.Database, id: string): any | null {
  const row = db.prepare('SELECT * FROM issues WHERE id = ?').get(id) as any;
  if (!row) return null;
  const photos = db.prepare('SELECT id, fileId, sortOrder FROM issue_photos WHERE issueId = ? ORDER BY sortOrder, createdAt').all(id);
  return { ...row, photos };
}

export function listIssues(db: Database.Database, projectId: string): any[] {
  const rows = db.prepare('SELECT * FROM issues WHERE projectId = ? ORDER BY createdAt DESC, rowid DESC').all(projectId) as any[];
  return rows.map(r => ({ ...r, photoCount: photoCount(db, r.id) }));
}

export function createIssue(db: Database.Database, projectId: string, input: IssueInput): { id: string; number: number } {
  requireProject(db, projectId);
  if (typeof input.title !== 'string' || !input.title.trim()) throw new ValidationError('Issue title is required');
  if (input.status !== undefined && !(ISSUE_STATUSES as readonly string[]).includes(input.status)) {
    throw new ValidationError(`Invalid issue status: ${input.status}`);
  }
  const id = crypto.randomUUID();
  let number = 0;
  const tx = db.transaction(() => {
    const max = (db.prepare('SELECT COALESCE(MAX(number), 0) m FROM issues WHERE projectId = ?').get(projectId) as any).m;
    number = max + 1;
    db.prepare('INSERT INTO issues (id, projectId, number, title, description, status, version, sentAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?)')
      .run(id, projectId, number, input.title!.trim(), input.description ?? null, input.status ?? 'open', Date.now());
  });
  tx();
  return { id, number };
}

export function saveIssue(db: Database.Database, id: string, input: IssueInput & { version?: number }): { version: number } {
  if (typeof input.title !== 'string' || !input.title.trim()) throw new ValidationError('Issue title is required');
  if (!Number.isInteger(input.version) || (input.version as number) < 1) throw new ValidationError('Missing or invalid version — reload the issue');
  let newVersion = 0;
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT version FROM issues WHERE id = ?').get(id) as { version: number } | undefined;
    if (!row) throw new NotFoundError('Issue not found');
    if (row.version !== input.version) throw new ConflictError(`Issue changed since it was loaded (server v${row.version}, payload v${input.version})`);
    newVersion = row.version + 1;
    db.prepare('UPDATE issues SET title = ?, description = ?, version = ? WHERE id = ?')
      .run(input.title!.trim(), input.description ?? null, newVersion, id);
  });
  tx();
  return { version: newVersion };
}

export function setIssueStatus(db: Database.Database, id: string, status: string): { status: string } {
  if (!(ISSUE_STATUSES as readonly string[]).includes(status)) throw new ValidationError(`Invalid issue status: ${status}`);
  const row = db.prepare('SELECT id FROM issues WHERE id = ?').get(id);
  if (!row) throw new NotFoundError('Issue not found');
  db.prepare('UPDATE issues SET status = ?, version = version + 1 WHERE id = ?').run(status, id);
  return { status };
}

export function deleteIssue(db: Database.Database, id: string): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM issue_photos WHERE issueId = ?').run(id);
    db.prepare('DELETE FROM issues WHERE id = ?').run(id);
  });
  tx();
}
