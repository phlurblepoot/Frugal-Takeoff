// server/issueStore.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import {
  listIssues, getIssue, createIssue, saveIssue, setIssueStatus, deleteIssue,
  ValidationError, ConflictError, NotFoundError,
} from './issueStore';

let db: Database.Database;

beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db, fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-iss-')), migrations);
  db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p1', 'Proj', 1);
  db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p2', 'Proj2', 1);
});

describe('issues', () => {
  it('numbers issues sequentially per project starting at 1', () => {
    const a = createIssue(db, 'p1', { title: 'A' });
    const b = createIssue(db, 'p1', { title: 'B' });
    const c = createIssue(db, 'p2', { title: 'C' }); // separate project sequence
    expect(a.number).toBe(1);
    expect(b.number).toBe(2);
    expect(c.number).toBe(1);
    expect(getIssue(db, a.id)!.status).toBe('open');
    expect(getIssue(db, a.id)!.version).toBe(1);
  });

  it('saveIssue is version-checked and updates the body', () => {
    const { id } = createIssue(db, 'p1', { title: 'A', description: 'first' });
    const iss = getIssue(db, id)!;
    const r = saveIssue(db, id, { ...iss, title: 'A2', description: 'second' });
    expect(r.version).toBe(2);
    const reloaded = getIssue(db, id)!;
    expect(reloaded.title).toBe('A2');
    expect(reloaded.description).toBe('second');
    expect(() => saveIssue(db, id, { ...iss })).toThrow(ConflictError); // stale
  });

  it('setIssueStatus validates and updates', () => {
    const { id } = createIssue(db, 'p1', { title: 'A' });
    setIssueStatus(db, id, 'resolved');
    expect(getIssue(db, id)!.status).toBe('resolved');
    expect(() => setIssueStatus(db, id, 'galactic')).toThrow(ValidationError);
  });

  it('validates create + unknown project + unknown issue', () => {
    expect(() => createIssue(db, 'nope', { title: 'X' })).toThrow(NotFoundError);
    expect(() => createIssue(db, 'p1', { title: '' })).toThrow(ValidationError);
    expect(() => saveIssue(db, 'nope', { version: 1, title: 'X' } as any)).toThrow(NotFoundError);
  });

  it('listIssues returns newest-first with photoCount', () => {
    createIssue(db, 'p1', { title: 'A' });
    createIssue(db, 'p1', { title: 'B' });
    const list = listIssues(db, 'p1');
    expect(list.map(i => i.title)).toEqual(['B', 'A']);
    expect(list[0].photoCount).toBe(0);
  });

  it('deleteIssue removes the issue and its photo links', () => {
    const { id } = createIssue(db, 'p1', { title: 'A' });
    db.prepare('INSERT INTO issue_photos (id, issueId, fileId, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?)').run('ph', id, 'f1', 0, 1);
    deleteIssue(db, id);
    expect(getIssue(db, id)).toBeNull();
    expect((db.prepare('SELECT COUNT(*) c FROM issue_photos').get() as any).c).toBe(0);
  });
});
