import type Database from 'better-sqlite3';
import { writeFileContent, readFileContent, deleteFileContent } from './fileStore';

// Matches the legacy dataURL format used everywhere in the old images table.
// Keep in sync with the regex previously at server.ts:608.
export const DATA_URL_RE = /^data:([A-Za-z0-9.+\/-]+)(?:;[^;,]+)*;base64,(.+)$/s;

export interface FileMeta {
  id: string;
  projectId: string | null;
  name: string | null;
  mime: string;
  size: number;
  sha256: string;
  kind: string;
  parentFileId: string | null;
  versionNumber: number;
  legacyFormat: string | null; // 'dataurl' | 'base64' | null
  createdAt: number;
}

export interface PutOpts {
  projectId?: string;
  kind?: string;
  name?: string;
}

function upsertRow(
  db: Database.Database,
  id: string,
  mime: string,
  size: number,
  sha256: string,
  legacyFormat: string | null,
  opts: PutOpts
): void {
  const existing = db.prepare('SELECT projectId, kind, name FROM files WHERE id = ?').get(id) as
    | { projectId: string | null; kind: string; name: string | null }
    | undefined;
  db.prepare(`
    INSERT OR REPLACE INTO files (id, projectId, name, mime, size, sha256, kind, legacyFormat, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    opts.projectId ?? existing?.projectId ?? null,
    opts.name ?? existing?.name ?? null,
    mime,
    size,
    sha256,
    opts.kind ?? existing?.kind ?? 'other',
    legacyFormat,
    Date.now()
  );
}

// Stores a legacy dataURL string (the only format the old /api/images wrote).
// Non-dataURL strings are treated as bare base64 — getDataUrlString restores
// the original string shape either way.
export function putDataUrl(db: Database.Database, dataDir: string, id: string, data: string, opts: PutOpts = {}): FileMeta {
  const m = data.match(DATA_URL_RE);
  let mime = 'application/octet-stream';
  let legacyFormat = 'base64';
  let buf: Buffer;
  if (m) {
    mime = m[1];
    legacyFormat = 'dataurl';
    buf = Buffer.from(m[2], 'base64');
  } else {
    buf = Buffer.from(data, 'base64');
  }
  const { size, sha256 } = writeFileContent(dataDir, id, buf);
  upsertRow(db, id, mime, size, sha256, legacyFormat, opts);
  return getMeta(db, id)!;
}

export function putBuffer(db: Database.Database, dataDir: string, id: string, buf: Buffer, mime: string, opts: PutOpts = {}): FileMeta {
  const { size, sha256 } = writeFileContent(dataDir, id, buf);
  // Raw uploads were converted to dataURLs by the old code, so reads expect
  // a dataURL back — mark accordingly.
  upsertRow(db, id, mime || 'application/octet-stream', size, sha256, 'dataurl', opts);
  return getMeta(db, id)!;
}

export function getMeta(db: Database.Database, id: string): FileMeta | null {
  const row = db.prepare('SELECT * FROM files WHERE id = ?').get(id) as FileMeta | undefined;
  return row ?? null;
}

// Reconstructs the exact string the legacy images.data column held.
export function getDataUrlString(db: Database.Database, dataDir: string, id: string): string | null {
  const meta = getMeta(db, id);
  if (!meta) return null;
  const buf = readFileContent(dataDir, id);
  if (!buf) return null;
  const b64 = buf.toString('base64');
  if (meta.legacyFormat === 'base64') return b64;
  return `data:${meta.mime};base64,${b64}`;
}

export function removeFile(db: Database.Database, dataDir: string, id: string): void {
  db.prepare('DELETE FROM files WHERE id = ?').run(id);
  deleteFileContent(dataDir, id);
}
