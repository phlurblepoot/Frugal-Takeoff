/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from '../db'; import { runMigrations } from '../migrations'; import { migrations } from '../migrationList';
import { createProject } from '../projectStore';
import { saveCustomer } from '../customerStore';
import { createRfi } from '../rfiStore';
import { resolveChain, createLink, listLinksForItem, listLinksForThread, deleteLink } from './links';

let db: Database.Database; let projectId: string; let customerId: string; let rfiId: string;
beforeEach(() => {
  db = openDb(':memory:'); runMigrations(db, fs.mkdtempSync(path.join(os.tmpdir(), 'ft-ln-')), migrations);
  customerId = 'c1'; saveCustomer(db, { id: 'c1', name: 'TEG' } as any);   // saveCustomer(db, c: Customer) — server/customerStore.ts:55; fill required fields if it throws
  projectId = 'p1'; createProject(db, { id: projectId, name: 'Dania', createdAt: 1, customerId, pages: [], takeoffs: [] } as any);
  rfiId = createRfi(db, projectId, { title: 'Ceilings' }).id;
});
describe('links', () => {
  it('resolves rfi → project → customer', () => {
    expect(resolveChain(db, 'rfi', rfiId)).toEqual({ projectId, customerId });
    expect(resolveChain(db, 'project', projectId)).toEqual({ projectId, customerId });
    expect(resolveChain(db, 'customer', customerId)).toEqual({ projectId: null, customerId });
    expect(resolveChain(db, 'rfi', 'missing')).toEqual({ projectId: null, customerId: null });
    // an itemType with no table mapping must not interpolate `undefined` into the SQL
    expect(resolveChain(db, 'nope' as any, 'x')).toEqual({ projectId: null, customerId: null });
  });
  it('createLink is idempotent and denormalizes the chain', () => {
    const a = createLink(db, { threadKey: 'k', itemType: 'rfi', itemId: rfiId, linkedByUserId: 'u1', subjectSnapshot: 'RFI-001' });
    const b = createLink(db, { threadKey: 'k', itemType: 'rfi', itemId: rfiId, linkedByUserId: 'u2' });
    expect(b.id).toBe(a.id); expect(a.projectId).toBe(projectId); expect(a.customerId).toBe(customerId);
    expect(listLinksForItem(db, 'rfi', rfiId).length).toBe(1);
    expect(listLinksForThread(db, 'k').map(l => l.itemType)).toEqual(['rfi']);
    deleteLink(db, a.id); expect(listLinksForThread(db, 'k')).toEqual([]);
  });
});
