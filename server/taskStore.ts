// server/taskStore.ts
import type Database from 'better-sqlite3';
import crypto from 'crypto';

export class ValidationError extends Error {}
export class ConflictError extends Error {}
export class NotFoundError extends Error {}

export const TASK_STATUSES = ['todo', 'in_progress', 'done'] as const;
export const TASK_PHOTO_STAGES = ['before', 'in_progress', 'after'] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function photoCount(db: Database.Database, taskId: string): number {
  return (db.prepare('SELECT COUNT(*) c FROM task_photos WHERE taskId = ?').get(taskId) as any).c;
}

function validateAssignee(db: Database.Database, assigneeUserId: unknown): string | null {
  if (assigneeUserId === undefined || assigneeUserId === null || assigneeUserId === '') return null;
  if (typeof assigneeUserId !== 'string') throw new ValidationError('Invalid assignee');
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(assigneeUserId)) throw new ValidationError('Assignee is not a known user');
  return assigneeUserId;
}

function validateDue(dueDate: unknown): string | null {
  if (dueDate === undefined || dueDate === null || dueDate === '') return null;
  if (typeof dueDate !== 'string' || !DATE_RE.test(dueDate)) throw new ValidationError('Due date must be YYYY-MM-DD');
  return dueDate;
}

interface TaskInput {
  category?: string; title?: string; notes?: string;
  assigneeUserId?: string | null; dueDate?: string | null;
}

export function getTask(db: Database.Database, id: string): any | null {
  const row = db.prepare(`
    SELECT t.*, u.username AS assigneeUsername
    FROM tasks t LEFT JOIN users u ON u.id = t.assigneeUserId
    WHERE t.id = ?`).get(id) as any;
  if (!row) return null;
  const photos = db.prepare('SELECT id, fileId, stage, sortOrder FROM task_photos WHERE taskId = ? ORDER BY stage, sortOrder, createdAt').all(id);
  return { ...row, photos };
}

export function listTasks(db: Database.Database): any[] {
  const rows = db.prepare(`
    SELECT t.*, u.username AS assigneeUsername
    FROM tasks t LEFT JOIN users u ON u.id = t.assigneeUserId
    ORDER BY t.category ASC, t.sortOrder ASC, t.createdAt ASC, t.rowid ASC`).all() as any[];
  return rows.map(r => ({ ...r, photoCount: photoCount(db, r.id) }));
}

export function createTask(db: Database.Database, input: TaskInput & { createdBy?: string | null }): { id: string } {
  if (typeof input.title !== 'string' || !input.title.trim()) throw new ValidationError('Task title is required');
  const assignee = validateAssignee(db, input.assigneeUserId);
  const due = validateDue(input.dueDate);
  const id = crypto.randomUUID();
  const tx = db.transaction(() => {
    const max = (db.prepare('SELECT COALESCE(MAX(sortOrder), -1) m FROM tasks').get() as any).m;
    db.prepare(`INSERT INTO tasks (id, category, title, notes, assigneeUserId, status, dueDate, sortOrder, version, createdAt, createdBy)
      VALUES (?, ?, ?, ?, ?, 'todo', ?, ?, 1, ?, ?)`)
      .run(id, (input.category ?? '').trim(), input.title!.trim(), (input.notes ?? '').trim(), assignee, due, max + 1, Date.now(), input.createdBy ?? null);
  });
  tx();
  return { id };
}

export function saveTask(db: Database.Database, id: string, input: TaskInput & { version?: number }): { version: number } {
  if (typeof input.title !== 'string' || !input.title.trim()) throw new ValidationError('Task title is required');
  if (!Number.isInteger(input.version) || (input.version as number) < 1) throw new ValidationError('Missing or invalid version — reload the task');
  const assignee = validateAssignee(db, input.assigneeUserId);
  const due = validateDue(input.dueDate);
  let newVersion = 0;
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT version FROM tasks WHERE id = ?').get(id) as { version: number } | undefined;
    if (!row) throw new NotFoundError('Task not found');
    if (row.version !== input.version) throw new ConflictError(`Task changed since it was loaded (server v${row.version}, payload v${input.version})`);
    newVersion = row.version + 1;
    db.prepare('UPDATE tasks SET category = ?, title = ?, notes = ?, assigneeUserId = ?, dueDate = ?, version = ? WHERE id = ?')
      .run((input.category ?? '').trim(), input.title!.trim(), (input.notes ?? '').trim(), assignee, due, newVersion, id);
  });
  tx();
  return { version: newVersion };
}
