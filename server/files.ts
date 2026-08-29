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
  customerId: string | null;
  // Owning entity: invoice|payapp|change-order|issue|punch|rfi|task|proposal|
  // printout|plan-set + its id. Null on loose uploads and legacy rows.
  sourceType: string | null;
  sourceId: string | null;
  archived: number; // 0 | 1 — soft hide on the Documents page
}

// Canonical document kinds (spec 2026-08-17 §Data model). System kinds are
// written by the program; users can never re-type a file into or out of one.
export const SYSTEM_KINDS = [
  'plan-source', 'plan', 'proposal', 'proposal-photo', 'proposal-signed', 'printout',
  'takeoff-print', 'takeoff-export',
  'invoice', 'change-order', 'change-order-photo', 'issue-report',
  'issue-photo', 'punch-report', 'punch-photo', 'rfi', 'rfi-photo',
  'rfi-response', 'task-photo', 'payapp-export', 'email-attachment',
  'settings-asset', 'daily-report', 'daily-report-photo',
] as const;

// Kinds an entity legitimately holds MANY of: one issue has a dozen photos,
// all sharing the same (sourceType, sourceId, kind) triple. They are excluded
// from upsert-by-source — otherwise the second photo would silently overwrite
// the first as a "new version" of it (spec 2026-08-17, second amendment).
// `plan-source` belongs here for the same reason and with sharper teeth: a
// plan set is routinely built from several uploaded PDFs, and versioning one
// onto another would keep the live id — so the pages split out of the FIRST
// pdf would start rendering the second.
export const MULTI_INSTANCE_KINDS = [
  'issue-photo', 'punch-photo', 'task-photo', 'change-order-photo',
  'rfi-photo', 'proposal-photo', 'plan-source', 'daily-report-photo',
] as const;

// Kinds a person can pick in the upload popup — the only ones a file may be
// re-typed to, and the only ones that are ever really deletable.
export const DIRECT_UPLOAD_KINDS = ['document', 'spreadsheet', 'photo', 'other', 'company-document'] as const;

// Admin-defined types are stored as `custom:<id>` and behave like uploads.
export function isDirectUploadKind(kind: string): boolean {
  return (DIRECT_UPLOAD_KINDS as readonly string[]).includes(kind) || kind.startsWith('custom:');
}

export interface PutOpts {
  projectId?: string;
  kind?: string;
  name?: string;
  customerId?: string;
  // The entity this file belongs to. With a kind, the pair identifies ONE
  // stable document — see the upsert-by-source note on `store` below.
  sourceType?: string;
  sourceId?: string;
  // Only meaningful on an upsert-by-source hit (see `store`). 'version'
  // (default) archives the prior bytes as history, same as always.
  // 'overwrite' replaces the live bytes in place — no archived row, id and
  // versionNumber unchanged — for callers that intentionally don't want the
  // regenerate to grow the version history (spec 2026-08-29 document actions).
  mode?: 'version' | 'overwrite';
}

// A put either created/overwrote the requested id, or landed as a new version
// of the document that already stood for this source (in which case `id` is
// that document's id, not the one the caller asked for).
export type PutResult = FileMeta & { versioned: boolean };

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
    .prepare(`SELECT projectId, kind, name, parentFileId, versionNumber, createdAt,
                     customerId, sourceType, sourceId, archived FROM files WHERE id = ?`)
    .get(id) as
    | {
        projectId: string | null;
        kind: string;
        name: string | null;
        parentFileId: string | null;
        versionNumber: number;
        createdAt: number;
        customerId: string | null;
        sourceType: string | null;
        sourceId: string | null;
        archived: number;
      }
    | undefined;
  db.prepare(`
    INSERT OR REPLACE INTO files (id, projectId, name, mime, size, sha256, kind, parentFileId, versionNumber, legacyFormat, createdAt, customerId, sourceType, sourceId, archived)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    existing?.createdAt ?? Date.now(),
    opts.customerId ?? existing?.customerId ?? null,
    opts.sourceType ?? existing?.sourceType ?? null,
    opts.sourceId ?? existing?.sourceId ?? null,
    existing?.archived ?? 0
  );
}

// The live document standing for (sourceType, sourceId, kind), if any. Only
// live rows qualify: version history hangs off a parentFileId and must never
// be picked up as an upsert target. Multi-instance kinds never match — an
// entity's second photo is another photo, not a new version of the first.
function findLiveBySource(db: Database.Database, opts: PutOpts): string | null {
  if (!opts.sourceType || !opts.sourceId || !opts.kind) return null;
  if ((MULTI_INSTANCE_KINDS as readonly string[]).includes(opts.kind)) return null;
  const row = db.prepare(`
    SELECT id FROM files
    WHERE parentFileId IS NULL AND sourceType = ? AND sourceId = ? AND kind = ?
    ORDER BY createdAt ASC, id ASC LIMIT 1
  `).get(opts.sourceType, opts.sourceId, opts.kind) as { id: string } | undefined;
  return row?.id ?? null;
}

// Older migration paths (e.g. images-to-disk, which runs before migration 7
// creates `drafts`) can reach the store/version path pre-drafts-table.
function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

// Overwrite mode (spec 2026-08-29 document actions): replaces the live row's
// bytes in place with no archived history row and no versionNumber bump —
// for regenerate flows that intentionally don't want every re-run to grow the
// version list (e.g. a draft the user is still iterating on before it's
// final). Contrast with saveNewVersion, which always archives.
export function overwriteLive(db: Database.Database, dataDir: string, id: string, buf: Buffer, mime: string): void {
  const { size, sha256 } = writeFileContent(dataDir, id, buf); // atomic rename over the same path
  db.prepare('UPDATE files SET mime = ?, size = ?, sha256 = ?, legacyFormat = NULL, createdAt = ?, archived = 0 WHERE id = ?')
    .run(mime, size, sha256, Date.now(), id);
}

// Upsert-by-source (spec 2026-08-17 §Data model): a generate/download flow
// uploads with the owning entity's source metadata every time, minting a fresh
// id client-side. When that source already has a live document of the same
// kind, the bytes become a new VERSION of it rather than a second row — so
// regenerating an invoice never clutters the Documents page. Without a full
// sourceType+sourceId+kind triple this is an ordinary create/overwrite.
function store(
  db: Database.Database,
  dataDir: string,
  id: string,
  buf: Buffer,
  mime: string,
  legacyFormat: string | null,
  opts: PutOpts
): PutResult {
  const existingId = findLiveBySource(db, opts);
  if (existingId) {
    if (opts.mode === 'overwrite') {
      overwriteLive(db, dataDir, existingId, buf, mime);
    } else {
      saveNewVersion(db, dataDir, existingId, buf, mime);
    }
    // saveNewVersion re-enters putBuffer with no opts, which stamps the
    // dataURL format and keeps the old labels. Replay the caller's actual
    // format (so getDataUrlString still round-trips) and take whichever
    // descriptive fields this regenerate carried — kind and source are equal
    // by construction, so nothing about the document's identity moves.
    // Regenerating a document is also an act of using it: un-archive.
    const sets = ['legacyFormat = ?', 'archived = 0'];
    const vals: unknown[] = [legacyFormat];
    if (opts.name) { sets.push('name = ?'); vals.push(opts.name); }
    if (opts.projectId) { sets.push('projectId = ?'); vals.push(opts.projectId); }
    if (opts.customerId) { sets.push('customerId = ?'); vals.push(opts.customerId); }
    db.prepare(`UPDATE files SET ${sets.join(', ')} WHERE id = ?`).run(...vals, existingId);
    // A regenerate — versioned or overwritten in place — invalidates any
    // in-progress editor draft for the old bytes; keeping it around would let
    // a stale PDF-editor draft silently resurrect content the regenerate just
    // replaced. drafts (migration 7) postdates files, so older migration
    // paths that call putBuffer before it exists (e.g. images-to-disk) must
    // not explode on this.
    if (tableExists(db, 'drafts')) {
      db.prepare('DELETE FROM drafts WHERE fileId = ?').run(existingId);
    }
    return { ...getMeta(db, existingId)!, versioned: true };
  }
  const { size, sha256 } = writeFileContent(dataDir, id, buf);
  upsertRow(db, id, mime, size, sha256, legacyFormat, opts);
  return { ...getMeta(db, id)!, versioned: false };
}

// Stores a legacy dataURL string (the only format the old /api/images wrote).
// Non-dataURL strings are treated as bare base64 — getDataUrlString restores
// the original string shape either way.
export function putDataUrl(db: Database.Database, dataDir: string, id: string, data: string, opts: PutOpts = {}): PutResult {
  const { mime, legacyFormat, buf } = parseDataUrl(data);
  return store(db, dataDir, id, buf, mime, legacyFormat, opts);
}

export function putBuffer(db: Database.Database, dataDir: string, id: string, buf: Buffer, mime: string, opts: PutOpts = {}): PutResult {
  // Raw uploads were converted to dataURLs by the old code, so reads expect
  // a dataURL back — mark accordingly.
  return store(db, dataDir, id, buf, mime || 'application/octet-stream', 'dataurl', opts);
}

// Archive/re-type a document. Deliberately policy-free — which kinds may be
// re-typed and who may archive is enforced at the route. Version rows are left
// alone: they are only ever reached through their live row.
export function setFileFlags(
  db: Database.Database,
  id: string,
  flags: { archived?: boolean; kind?: string }
): FileMeta | null {
  if (!getMeta(db, id)) return null;
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (flags.archived !== undefined) { sets.push('archived = ?'); vals.push(flags.archived ? 1 : 0); }
  if (flags.kind !== undefined) { sets.push('kind = ?'); vals.push(flags.kind); }
  if (sets.length) db.prepare(`UPDATE files SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  return getMeta(db, id);
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
  if (!oldContent) {
    console.warn(`[files] versioning ${id} with no on-disk content — version history will have a gap`);
  } else {
    // archived bytes to disk before the tx (idempotent; leak-only on rollback)
    const { size, sha256 } = writeFileContent(dataDir, archivedVersionId, oldContent);
    const versionNumber = live.versionNumber + 1;
    const tx = db.transaction(() => {
      // The archived row deliberately carries no source metadata: the source
      // points at the LIVE document, and leaving these NULL keeps history out
      // of every source-keyed lookup (upsert-by-source, /api/documents).
      db.prepare(`INSERT INTO files (id, projectId, name, mime, size, sha256, kind, parentFileId, versionNumber, legacyFormat, createdAt)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        archivedVersionId, live.projectId, live.name, live.mime, size, sha256, live.kind, id, live.versionNumber, live.legacyFormat, Date.now()
      );
      putBuffer(db, dataDir, id, buf, mime); // disk write is non-tx but idempotent; row upsert is in-tx
      // putBuffer -> upsertRow carries the OLD createdAt forward (it only
      // defaults createdAt for brand-new rows), so a versioned save must
      // refresh it explicitly — otherwise the live row's createdAt would
      // never move past its original creation time, breaking anything that
      // reads createdAt as "when was this document last produced".
      db.prepare('UPDATE files SET versionNumber = ?, createdAt = ? WHERE id = ?').run(versionNumber, Date.now(), id);
    });
    tx();
    return { archivedVersionId, versionNumber };
  }
  // no old content: just overwrite + bump (still atomic for the two DB writes)
  const versionNumber = live.versionNumber + 1;
  const tx = db.transaction(() => {
    putBuffer(db, dataDir, id, buf, mime);
    db.prepare('UPDATE files SET versionNumber = ?, createdAt = ? WHERE id = ?').run(versionNumber, Date.now(), id);
  });
  tx();
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
