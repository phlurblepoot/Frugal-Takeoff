// server/rfiStore.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import {
  RFI_STATUSES, getRfi, listRfis, createRfi, saveRfi, setRfiStatus,
  deleteRfi, addPhoto, removePhoto, markRfiSent, setRfiResponse,
  ValidationError, ConflictError, NotFoundError,
} from './rfiStore';

let db: Database.Database;

beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db, fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-rfi-')), migrations);
  db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p1', 'Proj', 1);
  db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p2', 'Proj2', 1);
});

describe('rfiStore', () => {
  it('numbers RFIs sequentially per project', () => {
    const a = createRfi(db, 'p1', { title: 'A' });
    const b = createRfi(db, 'p1', { title: 'B' });
    const c = createRfi(db, 'p2', { title: 'C' }); // separate project sequence
    expect(a.number).toBe(1);
    expect(b.number).toBe(2);
    expect(c.number).toBe(1);
  });

  it('never reuses a deleted RFI number', () => {
    createRfi(db, 'p1', { title: 'a' });                      // RFI-001
    const b = createRfi(db, 'p1', { title: 'b' });            // RFI-002
    deleteRfi(db, b.id);
    expect(createRfi(db, 'p1', { title: 'c' }).number).toBe(3); // not 2
  });

  it('continues numbering after all RFIs are deleted', () => {
    const a = createRfi(db, 'p1', { title: 'a' });
    const b = createRfi(db, 'p1', { title: 'b' });
    deleteRfi(db, a.id);
    deleteRfi(db, b.id);
    expect(createRfi(db, 'p1', { title: 'c' }).number).toBe(3); // not 1
  });

  it('recovers when the counter is behind existing rows (max guard)', () => {
    createRfi(db, 'p1', { title: 'a' });                       // counter → 1
    db.prepare('UPDATE projects SET rfiCounter = 0 WHERE id = ?').run('p1');
    expect(createRfi(db, 'p1', { title: 'b' }).number).toBe(2); // MAX guard wins
  });

  it('requires a title on create', () => {
    expect(() => createRfi(db, 'p1', {})).toThrow(ValidationError);
  });

  it('rejects create for unknown project', () => {
    expect(() => createRfi(db, 'nope', { title: 'x' })).toThrow(NotFoundError);
  });

  it('stores header fields on create and save', () => {
    const { id } = createRfi(db, 'p1', {
      title: 'A',
      question: 'Q1',
      specRef: 'Spec 1',
      drawingRef: 'A-101',
      attention: 'Jane',
      responseNeededBy: '2026-08-01',
    });
    const rfi = getRfi(db, id)!;
    expect(rfi.title).toBe('A');
    expect(rfi.question).toBe('Q1');
    expect(rfi.specRef).toBe('Spec 1');
    expect(rfi.drawingRef).toBe('A-101');
    expect(rfi.attention).toBe('Jane');
    expect(rfi.responseNeededBy).toBe('2026-08-01');
    expect(rfi.status).toBe('open');
    expect(rfi.version).toBe(1);

    const r = saveRfi(db, id, {
      version: 1,
      title: 'A2',
      question: 'Q2',
      specRef: 'Spec 2',
      drawingRef: 'A-102',
      attention: 'John',
      responseNeededBy: '2026-08-15',
    });
    expect(r.version).toBe(2);

    const reloaded = getRfi(db, id)!;
    expect(reloaded.title).toBe('A2');
    expect(reloaded.question).toBe('Q2');
    expect(reloaded.specRef).toBe('Spec 2');
    expect(reloaded.drawingRef).toBe('A-102');
    expect(reloaded.attention).toBe('John');
    expect(reloaded.responseNeededBy).toBe('2026-08-15');
    expect(reloaded.version).toBe(2);
  });

  it('save is version-checked', () => {
    const { id } = createRfi(db, 'p1', { title: 'A' });
    const rfi = getRfi(db, id)!;
    expect(() => saveRfi(db, id, { ...rfi, title: 'A2', version: 99 })).toThrow(ConflictError);
    expect(() => saveRfi(db, id, { title: 'A2' } as any)).toThrow(ValidationError);
    expect(() => saveRfi(db, 'nope', { title: 'X', version: 1 })).toThrow(NotFoundError);
  });

  it('validates status', () => {
    const { id } = createRfi(db, 'p1', { title: 'A' });
    expect(() => setRfiStatus(db, id, 'bogus')).toThrow(ValidationError);
    for (const status of RFI_STATUSES) {
      setRfiStatus(db, id, status);
      expect(getRfi(db, id)!.status).toBe(status);
    }
  });

  it('lists newest-first with photoCount', () => {
    const a = createRfi(db, 'p1', { title: 'A' });
    createRfi(db, 'p1', { title: 'B' });
    addPhoto(db, a.id, 'f1');
    addPhoto(db, a.id, 'f2');
    const list = listRfis(db, 'p1');
    expect(list.map(r => r.title)).toEqual(['B', 'A']);
    expect(list.find(r => r.id === a.id)!.photoCount).toBe(2);
    expect(list.find(r => r.title === 'B')!.photoCount).toBe(0);
  });

  it('delete cascades photo links', () => {
    const { id } = createRfi(db, 'p1', { title: 'A' });
    addPhoto(db, id, 'f1');
    deleteRfi(db, id);
    expect(getRfi(db, id)).toBeNull();
    expect((db.prepare('SELECT COUNT(*) c FROM rfi_photos').get() as any).c).toBe(0);
  });

  it('addPhoto is idempotent and validates', () => {
    const { id } = createRfi(db, 'p1', { title: 'A' });
    addPhoto(db, id, 'f1');
    addPhoto(db, id, 'f1'); // duplicate ignored
    expect(getRfi(db, id)!.photos).toHaveLength(1);
    expect(() => addPhoto(db, 'nope', 'f1')).toThrow(NotFoundError);
    expect(() => addPhoto(db, id, '')).toThrow(ValidationError);
  });

  it('removePhoto removes a photo link', () => {
    const { id } = createRfi(db, 'p1', { title: 'A' });
    addPhoto(db, id, 'f1');
    addPhoto(db, id, 'f2');
    removePhoto(db, id, 'f1');
    expect(getRfi(db, id)!.photos.map((p: any) => p.fileId)).toEqual(['f2']);
  });

  it('markRfiSent sets status sent + sentAt', () => {
    const { id } = createRfi(db, 'p1', { title: 'A' });
    markRfiSent(db, id);
    const rfi = getRfi(db, id)!;
    expect(rfi.status).toBe('sent');
    expect(typeof rfi.sentAt).toBe('number');
  });

  it('markRfiSent does not demote an answered RFI, but refreshes sentAt', () => {
    const { id } = createRfi(db, 'p1', { title: 'A' });
    setRfiResponse(db, id, { text: 'Answer' });
    const before = getRfi(db, id)!;
    expect(before.status).toBe('answered');
    const beforeVersion = before.version;
    markRfiSent(db, id);
    const rfi = getRfi(db, id)!;
    expect(rfi.status).toBe('answered');
    expect(typeof rfi.sentAt).toBe('number');
    expect(rfi.version).toBe(beforeVersion + 1);
  });

  it('markRfiSent does not demote a closed RFI, but refreshes sentAt', () => {
    const { id } = createRfi(db, 'p1', { title: 'A' });
    setRfiStatus(db, id, 'closed');
    const beforeVersion = getRfi(db, id)!.version;
    markRfiSent(db, id);
    const rfi = getRfi(db, id)!;
    expect(rfi.status).toBe('closed');
    expect(typeof rfi.sentAt).toBe('number');
    expect(rfi.version).toBe(beforeVersion + 1);
  });

  it('saveRfi and setRfiResponse bump updatedAt', async () => {
    const { id } = createRfi(db, 'p1', { title: 'A' });
    const before = (getRfi(db, id) as any).updatedAt;
    expect(typeof before).toBe('number');
    await new Promise(r => setTimeout(r, 2));
    saveRfi(db, id, { title: 'A2', version: 1 });
    const afterSave = (getRfi(db, id) as any).updatedAt;
    expect(afterSave).toBeGreaterThan(before);
    await new Promise(r => setTimeout(r, 2));
    setRfiResponse(db, id, { text: 'Answer' });
    expect((getRfi(db, id) as any).updatedAt).toBeGreaterThan(afterSave);
  });

  describe('setRfiResponse', () => {
    it('requires fileId or text', () => {
      const { id } = createRfi(db, 'p1', { title: 'A' });
      expect(() => setRfiResponse(db, id, {})).toThrow(ValidationError);
    });

    it('file response → answered + answeredAt + responseFileId', () => {
      const { id } = createRfi(db, 'p1', { title: 'A' });
      const r = setRfiResponse(db, id, { fileId: 'f1' });
      expect(r.status).toBe('answered');
      const rfi = getRfi(db, id)!;
      expect(rfi.status).toBe('answered');
      expect(typeof rfi.answeredAt).toBe('number');
      expect(rfi.responseFileId).toBe('f1');
    });

    it('text response → answered + responseText', () => {
      const { id } = createRfi(db, 'p1', { title: 'A' });
      const r = setRfiResponse(db, id, { text: 'The answer is X' });
      expect(r.status).toBe('answered');
      const rfi = getRfi(db, id)!;
      expect(rfi.status).toBe('answered');
      expect(rfi.responseText).toBe('The answer is X');
    });

    it('both can be set across calls without clobbering the other', () => {
      const { id } = createRfi(db, 'p1', { title: 'A' });
      setRfiResponse(db, id, { fileId: 'f1' });
      setRfiResponse(db, id, { text: 'Answer text' });
      const rfi = getRfi(db, id)!;
      expect(rfi.responseFileId).toBe('f1');
      expect(rfi.responseText).toBe('Answer text');
    });

    it('does not demote a closed RFI', () => {
      const { id } = createRfi(db, 'p1', { title: 'A' });
      setRfiStatus(db, id, 'closed');
      const r = setRfiResponse(db, id, { text: 'Late answer' });
      expect(r.status).toBe('closed');
      const rfi = getRfi(db, id)!;
      expect(rfi.status).toBe('closed');
      expect(rfi.responseText).toBe('Late answer');
    });

    it('unknown rfi → NotFoundError', () => {
      expect(() => setRfiResponse(db, 'nope', { text: 'x' })).toThrow(NotFoundError);
    });
  });
});
