import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from '../db'; import { runMigrations } from '../migrations'; import { migrations } from '../migrationList';
import { createProject } from '../projectStore';
import { createRfi, getRfi } from '../rfiStore';
import { createIssue, getIssue } from '../issueStore';
import { applySendEffects } from './itemSendEffects';

let db: Database.Database;
beforeEach(() => {
  db = openDb(':memory:'); runMigrations(db, fs.mkdtempSync(path.join(os.tmpdir(), 'ft-ise-')), migrations);
  createProject(db, { id: 'p1', name: 'P', createdAt: 1, pages: [], takeoffs: [] } as any);
});
describe('applySendEffects', () => {
  it('marks an open RFI sent and logs activity', () => {
    const { id } = createRfi(db, 'p1', { title: 'x' });
    const r = applySendEffects(db, { itemType: 'rfi', itemId: id, userId: 'u1', role: 'user', to: 'a@b', threadKey: 'k' });
    expect(r.applied).toBe(true); expect(getRfi(db, id).status).toBe('sent');
    expect(r.broadcast).toMatchObject({ type: 'rfi', id, projectId: 'p1' });
    expect((db.prepare(`SELECT type FROM activity WHERE projectId='p1'`).all() as any[]).map(a => a.type)).toContain('rfi_sent');
  });
  it('is idempotent: an answered RFI is left alone (noop) but activity still logs', () => {
    const { id } = createRfi(db, 'p1', { title: 'x', status: 'answered' });
    const r = applySendEffects(db, { itemType: 'rfi', itemId: id, userId: 'u1', role: 'user', to: 'a@b', threadKey: 'k' });
    expect(getRfi(db, id).status).toBe('answered'); expect(r.applied).toBe(true);
  });
  it('skips admin-gated item types for non-admins', () => {
    const r = applySendEffects(db, { itemType: 'invoice', itemId: 'inv-missing', userId: 'u1', role: 'user', to: 'a@b', threadKey: 'k' });
    expect(r).toEqual({ applied: false, skipped: 'role' });
  });
  it('reports missing items', () => {
    expect(applySendEffects(db, { itemType: 'issue', itemId: 'nope', userId: 'u1', role: 'user', to: 'a@b', threadKey: 'k' })).toEqual({ applied: false, skipped: 'missing' });
  });
  it('link-only types are a noop', () => {
    expect(applySendEffects(db, { itemType: 'project', itemId: 'p1', userId: 'u1', role: 'user', to: 'a@b', threadKey: 'k' })).toEqual({ applied: false, skipped: 'noop' });
  });
});
