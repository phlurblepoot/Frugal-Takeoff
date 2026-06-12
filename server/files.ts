import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { writeFileContent, readFileContent, deleteFileContent } from './fileStore';

// Matches the legacy dataURL format used everywhere in the old images table.
// Keep in sync with the regex previously at server.ts:608. The `s` flag
// deliberately differs from the legacy regex: a newline inside the payload
// would match here. Harmless for real data, all of which is canonical base64.
export const DATA_URL_RE = /^data:([A-Za-z0-9.+\/-]+)(?:;[^;,]+)*;base64,(.+)$/s;

// Parses a legacy stored string. legacyFormat is 'dataurl' when the prefix is
// exactly `data:<mime>;base64,`, 'base64' for bare-base64 strings, or the
// verbatim prefix (e.g. 'data:text/plain;charset=utf-8;base64,') when the
// dataURL carried extra parameters — getDataUrlString replays it byte-identically.
export function parseDataUrl(data: string): { mime: string; legacyFormat: string; buf: Buffer } {
  const m = data.match(DATA_URL_RE);
  if (!m) return { mime: 'application/octet-stream', legacyFormat: 'base64', buf: Buffer.from(data, 'base64') };
  const mime = m[1];
  const prefix = data.slice(0, data.length - m[2].length); // everything before the b64 payload
  const canonical = `data:${mime};base64,`;
  return { mime, legacyFormat: prefix === canonical ? 'dataurl' : prefix, buf: Buffer.from(m[2], 'base64') };
}

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
  legacyFormat: string | null; // 'dataurl' | 'base64' | verbatim non-canonical prefix | null
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
  // INSERT OR REPLACE resets unlisted columns to defaults, so carry over
  // every column we don't intend to change.
  const existing = db
    .prepare('SELECT projectId, kind, name, parentFileId, versionNumber, createdAt FROM files WHERE id = ?')
    .get(id) as
    | {
        projectId: string | null;
        kind: string;
        name: string | null;
        parentFileId: string | null;
        versionNumber: number;
        createdAt: number;
      }
    | undefined;
  db.prepare(`
    INSERT OR REPLACE INTO files (id, projectId, name, mime, size, sha256, kind, parentFileId, versionNumber, legacyFormat, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    opts.projectId ?? existing?.projectId ?? null,
    opts.name ?? existing?.name ?? null,
    mime,
    size,
    sha256,
    opts.kind ?? existing?.kind ?? 'other',
    existing?.parentFileId ?? null,
    existing?.versionNumber ?? 1,
    legacyFormat,
    existing?.createdAt ?? Date.now()
  );
}

// Stores a legacy dataURL string (the only format the old /api/images wrote).
// Non-dataURL strings are treated as bare base64 — getDataUrlString restores
// the original string shape either way.
export function putDataUrl(db: Database.Database, dataDir: string, id: string, data: string, opts: PutOpts = {}): FileMeta {
  const { mime, legacyFormat, buf } = parseDataUrl(data);
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
  if (meta.legacyFormat && meta.legacyFormat !== 'dataurl') return meta.legacyFormat + b64; // verbatim prefix replay
  return `data:${meta.mime};base64,${b64}`;
}

export function removeFile(db: Database.Database, dataDir: string, id: string): void {
  db.prepare('DELETE FROM files WHERE id = ?').run(id);
  deleteFileContent(dataDir, id);
}

// Archive-then-overwrite versioning (spec §3.2). The LIVE content always
// keeps its original id so every reference (printouts, proposals, share
// links) stays valid. Each save first snapshots the current content into a
// new row pointing at the original, then overwrites the live row in place.
// Disk writes are not transactional with the DB; a crash can at worst leave
// an unreferenced archived row — reclaimable via explicit orphan cleanup.
export function saveNewVersion(
  db: Database.Database,
  dataDir: string,
  id: string,
  buf: Buffer,
  mime: string
): { archivedVersionId: string; versionNumber: number } {
  const live = getMeta(db, id);
  if (!live) throw new Error(`Cannot version unknown file ${id}`);

  const archivedVersionId = crypto.randomUUID();
  const oldContent = readFileContent(dataDir, id);
  if (oldContent) {
    const { size, sha256 } = writeFileContent(dataDir, archivedVersionId, oldContent);
    db.prepare(`
      INSERT INTO files (id, projectId, name, mime, size, sha256, kind, parentFileId, versionNumber, legacyFormat, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      archivedVersionId, live.projectId, live.name, live.mime, size, sha256,
      live.kind, id, live.versionNumber, live.legacyFormat, Date.now()
    );
  }

  putBuffer(db, dataDir, id, buf, mime); // labels carry over from the live row
  const versionNumber = live.versionNumber + 1;
  db.prepare('UPDATE files SET versionNumber = ? WHERE id = ?').run(versionNumber, id);
  return { archivedVersionId, versionNumber };
}

// Live row first, then archived history newest-first.
export function listVersions(db: Database.Database, id: string): FileMeta[] {
  const live = getMeta(db, id);
  if (!live) return [];
  const history = db.prepare(
    'SELECT * FROM files WHERE parentFileId = ? ORDER BY versionNumber DESC'
  ).all(id) as FileMeta[];
  return [live, ...history];
}
