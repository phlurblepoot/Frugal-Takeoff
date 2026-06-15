// server/taskStore.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import {
  listTasks, getTask, createTask, saveTask,
  setTaskStatus, deleteTask, addTaskPhoto, removeTaskPhoto,
  ValidationError, ConflictError, NotFoundError,
} from './taskStore';

let db: Database.Database;

beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db, fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-task-')), migrations);
  db.prepare("INSERT INTO users (id, username, password, role) VALUES ('u1','alice','x','user'),('u2','bob','x','admin')").run();
});

describe('tasks', () => {
  it('creates and reads a task with assignee + due date', () => {
    const { id } = createTask(db, { category: 'Shop', title: 'Fix door', assigneeUserId: 'u1', dueDate: '2026-07-01' });
    const task = getTask(db, id)!;
    expect(task.title).toBe('Fix door');
    expect(task.category).toBe('Shop');
    expect(task.status).toBe('todo');
    expect(task.assigneeUserId).toBe('u1');
    expect(task.assigneeUsername).toBe('alice');
    expect(task.dueDate).toBe('2026-07-01');
    expect(task.version).toBe(1);
    expect(task.photos).toEqual([]);
  });

  it('rejects empty/whitespace title (ValidationError)', () => {
    expect(() => createTask(db, { title: '' })).toThrow(ValidationError);
    expect(() => createTask(db, { title: '   ' })).toThrow(ValidationError);
    expect(() => createTask(db, {})).toThrow(ValidationError);
  });

  it('rejects unknown assignee (ValidationError)', () => {
    expect(() => createTask(db, { title: 'X', assigneeUserId: 'nope' })).toThrow(ValidationError);
  });

  it('rejects invalid dueDate format (ValidationError); accepts null/empty (stored null)', () => {
    expect(() => createTask(db, { title: 'X', dueDate: '07/01/2026' })).toThrow(ValidationError);
    const a = createTask(db, { title: 'A', dueDate: null });
    expect(getTask(db, a.id)!.dueDate).toBeNull();
    const b = createTask(db, { title: 'B', dueDate: '' });
    expect(getTask(db, b.id)!.dueDate).toBeNull();
  });

  it('lists tasks ordered by category ASC then sortOrder, with assigneeUsername + photoCount', () => {
    createTask(db, { category: 'B', title: 'b1' });
    createTask(db, { category: 'A', title: 'a1', assigneeUserId: 'u2' });
    const list = listTasks(db);
    expect(list.map(t => t.title)).toEqual(['a1', 'b1']);
    expect(list[0].assigneeUsername).toBe('bob');
    expect(list[0].photoCount).toBe(0);
  });

  it('saveTask with correct version bumps version to 2 and updates fields', () => {
    const { id } = createTask(db, { category: 'Shop', title: 'Fix door', assigneeUserId: 'u1', dueDate: '2026-07-01' });
    const task = getTask(db, id)!;
    const r = saveTask(db, id, { ...task, category: 'Yard', title: 'Fix gate', assigneeUserId: 'u2', dueDate: '2026-08-01' });
    expect(r.version).toBe(2);
    const reloaded = getTask(db, id)!;
    expect(reloaded.category).toBe('Yard');
    expect(reloaded.title).toBe('Fix gate');
    expect(reloaded.assigneeUserId).toBe('u2');
    expect(reloaded.assigneeUsername).toBe('bob');
    expect(reloaded.dueDate).toBe('2026-08-01');
  });

  it('saveTask with stale version throws ConflictError', () => {
    const { id } = createTask(db, { title: 'Original' });
    const task = getTask(db, id)!;
    saveTask(db, id, { ...task, title: 'Updated' }); // advances to v2
    expect(() => saveTask(db, id, { ...task, title: 'Stale' })).toThrow(ConflictError); // still at v1
  });

  it('saveTask with unknown id throws NotFoundError', () => {
    expect(() => saveTask(db, 'no-such-id', { title: 'X', version: 1 })).toThrow(NotFoundError);
  });
});

describe('setTaskStatus', () => {
  it('sets status and bumps version', () => {
    const { id } = createTask(db, { title: 'Work item' });
    const result = setTaskStatus(db, id, 'in_progress');
    expect(result).toEqual({ status: 'in_progress' });
    const task = getTask(db, id)!;
    expect(task.status).toBe('in_progress');
    expect(task.version).toBe(2);
  });

  it('throws ValidationError for invalid status', () => {
    const { id } = createTask(db, { title: 'Work item' });
    expect(() => setTaskStatus(db, id, 'nope')).toThrow(ValidationError);
  });

  it('throws NotFoundError for unknown id', () => {
    expect(() => setTaskStatus(db, 'no-such-id', 'in_progress')).toThrow(NotFoundError);
  });
});

describe('addTaskPhoto / removeTaskPhoto', () => {
  it('addTaskPhoto is idempotent (same fileId+stage twice → 1 photo)', () => {
    const { id } = createTask(db, { title: 'Photo task' });
    addTaskPhoto(db, id, 'f1', 'before');
    addTaskPhoto(db, id, 'f1', 'before');
    const task = getTask(db, id)!;
    expect(task.photos.length).toBe(1);
    expect(task.photos[0].stage).toBe('before');
  });

  it('throws ValidationError for invalid stage', () => {
    const { id } = createTask(db, { title: 'Photo task' });
    expect(() => addTaskPhoto(db, id, 'f1', 'sideways')).toThrow(ValidationError);
  });

  it('throws ValidationError for empty fileId', () => {
    const { id } = createTask(db, { title: 'Photo task' });
    expect(() => addTaskPhoto(db, id, '', 'before')).toThrow(ValidationError);
  });

  it('throws NotFoundError for unknown task', () => {
    expect(() => addTaskPhoto(db, 'no-such-id', 'f1', 'before')).toThrow(NotFoundError);
  });

  it('removeTaskPhoto removes the photo', () => {
    const { id } = createTask(db, { title: 'Photo task' });
    addTaskPhoto(db, id, 'f1', 'before');
    removeTaskPhoto(db, id, 'f1');
    const task = getTask(db, id)!;
    expect(task.photos.length).toBe(0);
  });
});

describe('deleteTask', () => {
  it('deletes task and cascades task_photos', () => {
    const { id } = createTask(db, { title: 'To delete' });
    addTaskPhoto(db, id, 'f1', 'before');
    deleteTask(db, id);
    expect(getTask(db, id)).toBeNull();
    const count = (db.prepare('SELECT COUNT(*) c FROM task_photos WHERE taskId = ?').get(id) as any).c;
    expect(count).toBe(0);
  });
});
