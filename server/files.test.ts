import { describe, it, expect, beforeEach } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import { putDataUrl, putBuffer, getMeta, getDataUrlString, removeFile, saveNewVersion, listVersions } from './files';
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

  it('round-trips dataURLs with extra parameters byte-identically', () => {
    const url = 'data:text/plain;charset=utf-8;base64,' + Buffer.from('hello').toString('base64');
    putDataUrl(db, dir, 'txt1', url);
    expect(getDataUrlString(db, dir, 'txt1')).toBe(url);
    expect(getMeta(db, 'txt1')!.mime).toBe('text/plain');
  });

  it('preserves parentFileId/versionNumber/createdAt across overwrite', () => {
    putBuffer(db, dir, 'img1', Buffer.from('a'), 'image/png');
    db.prepare('UPDATE files SET parentFileId = ?, versionNumber = ?, createdAt = ? WHERE id = ?')
      .run('parent1', 3, 12345, 'img1');
    putBuffer(db, dir, 'img1', Buffer.from('b'), 'image/png');
    const meta = getMeta(db, 'img1')!;
    expect(meta.parentFileId).toBe('parent1');
    expect(meta.versionNumber).toBe(3);
    expect(meta.createdAt).toBe(12345);
  });
});

describe('file versioning', () => {
  it('archives old content to a version row and overwrites in place', () => {
    putBuffer(db, dir, 'f1', Buffer.from('v1-bytes'), 'application/pdf', { projectId: 'p1', kind: 'printout', name: 'Bid.pdf' });
    const r1 = saveNewVersion(db, dir, 'f1', Buffer.from('v2-bytes'), 'application/pdf');
    expect(r1.versionNumber).toBe(2);

    // live row: same id, new content, bumped version, labels intact
    const live = getMeta(db, 'f1')!;
    expect(live.versionNumber).toBe(2);
    expect(live.projectId).toBe('p1');
    expect(live.name).toBe('Bid.pdf');
    expect(readFileContent(dir, 'f1')!.toString()).toBe('v2-bytes');

    // archived row: old content, parent points at the original
    const archived = getMeta(db, r1.archivedVersionId)!;
    expect(archived.parentFileId).toBe('f1');
    expect(archived.versionNumber).toBe(1);
    expect(readFileContent(dir, r1.archivedVersionId)!.toString()).toBe('v1-bytes');
  });

  it('listVersions returns live row first then history newest-first', () => {
    putBuffer(db, dir, 'f1', Buffer.from('v1'), 'application/pdf');
    saveNewVersion(db, dir, 'f1', Buffer.from('v2'), 'application/pdf');
    saveNewVersion(db, dir, 'f1', Buffer.from('v3'), 'application/pdf');
    const versions = listVersions(db, 'f1');
    expect(versions[0].id).toBe('f1');
    expect(versions[0].versionNumber).toBe(3);
    expect(versions.slice(1).map(v => v.versionNumber)).toEqual([2, 1]);
  });

  it('throws for unknown files', () => {
    expect(() => saveNewVersion(db, dir, 'nope', Buffer.from('x'), 'text/plain')).toThrow();
  });

  it('keeps versionNumbers unique across live and history after several saves', () => {
    putBuffer(db, dir, 'f1', Buffer.from('v1'), 'application/pdf');
    saveNewVersion(db, dir, 'f1', Buffer.from('v2'), 'application/pdf');
    saveNewVersion(db, dir, 'f1', Buffer.from('v3'), 'application/pdf');
    const nums = listVersions(db, 'f1').map(v => v.versionNumber).sort((a, b) => a - b);
    expect(nums).toEqual([1, 2, 3]);
    expect(new Set(nums).size).toBe(nums.length);
  });
});
