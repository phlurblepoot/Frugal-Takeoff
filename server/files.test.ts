import { describe, it, expect, beforeEach } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import { putDataUrl, putBuffer, getMeta, getDataUrlString, removeFile } from './files';
import { readFileContent } from './fileStore';

let db: Database.Database;
let dir: string;

beforeEach(() => {
  dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-files-'));
  db = openDb(':memory:');
  runMigrations(db, dir, migrations.filter(m => m.version <= 3));
});

const PNG_DATAURL = 'data:image/png;base64,' + Buffer.from('fakepng').toString('base64');

describe('files layer', () => {
  it('putDataUrl stores content on disk and metadata in db', () => {
    putDataUrl(db, dir, 'img1', PNG_DATAURL);
    const meta = getMeta(db, 'img1')!;
    expect(meta.mime).toBe('image/png');
    expect(meta.size).toBe(7);
    expect(meta.kind).toBe('other');
    expect(readFileContent(dir, 'img1')!.toString()).toBe('fakepng');
  });

  it('getDataUrlString round-trips byte-identically', () => {
    putDataUrl(db, dir, 'img1', PNG_DATAURL);
    expect(getDataUrlString(db, dir, 'img1')).toBe(PNG_DATAURL);
  });

  it('putBuffer reproduces the dataURL the old raw-upload path built', () => {
    putBuffer(db, dir, 'pdf1', Buffer.from('fakepdf'), 'application/pdf');
    // legacy POST /api/files/:id built: data:<mime>;base64,<b64> (server.ts:653)
    expect(getDataUrlString(db, dir, 'pdf1'))
      .toBe('data:application/pdf;base64,' + Buffer.from('fakepdf').toString('base64'));
  });

  it('overwriting an id replaces content and mime', () => {
    putDataUrl(db, dir, 'img1', PNG_DATAURL);
    putBuffer(db, dir, 'img1', Buffer.from('newcontent'), 'image/jpeg');
    expect(getMeta(db, 'img1')!.mime).toBe('image/jpeg');
    expect(readFileContent(dir, 'img1')!.toString()).toBe('newcontent');
  });

  it('preserves projectId/kind/name labels across overwrite', () => {
    putBuffer(db, dir, 'img1', Buffer.from('a'), 'image/png', { projectId: 'p1', kind: 'plan', name: 'Sheet A1' });
    putBuffer(db, dir, 'img1', Buffer.from('b'), 'image/png');
    const meta = getMeta(db, 'img1')!;
    expect(meta.projectId).toBe('p1');
    expect(meta.kind).toBe('plan');
    expect(meta.name).toBe('Sheet A1');
  });

  it('removeFile deletes row and disk content', () => {
    putDataUrl(db, dir, 'img1', PNG_DATAURL);
    removeFile(db, dir, 'img1');
    expect(getMeta(db, 'img1')).toBeNull();
    expect(readFileContent(dir, 'img1')).toBeNull();
  });

  it('returns null for unknown ids', () => {
    expect(getMeta(db, 'nope')).toBeNull();
    expect(getDataUrlString(db, dir, 'nope')).toBeNull();
  });
});
