import fsSync from 'fs';
import path from 'path';
import type { Migration } from './migrations';
import { parseDataUrl } from './files';
import { writeFileContent } from './fileStore';
import { decomposeProject } from './projectStore';

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'base-schema',
    up({ db }) {
      // Mirrors the legacy initDb() bootstrap so fresh installs and old
      // databases converge on the same starting point. IF NOT EXISTS makes
      // this a no-op for existing installs.
      db.exec(`
        CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT, createdAt INTEGER);
        CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, data TEXT);
        CREATE TABLE IF NOT EXISTS templates (id TEXT PRIMARY KEY, data TEXT);
        CREATE TABLE IF NOT EXISTS bids (id TEXT PRIMARY KEY, data TEXT, createdAt INTEGER);
        CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE, password TEXT, role TEXT);
        CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, projectId TEXT, data TEXT, createdAt INTEGER, updatedAt INTEGER);
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS user_preferences (userId TEXT NOT NULL, key TEXT NOT NULL, value TEXT, UNIQUE(userId, key));
        CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, type TEXT NOT NULL, resourceId TEXT NOT NULL, name TEXT, createdAt INTEGER);
        CREATE TABLE IF NOT EXISTS checklists (id TEXT PRIMARY KEY, data TEXT, createdAt INTEGER);
        CREATE TABLE IF NOT EXISTS email_accounts (id TEXT PRIMARY KEY, data TEXT NOT NULL, createdAt INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS time_entries (
          id TEXT PRIMARY KEY, userId TEXT NOT NULL, projectId TEXT,
          clockIn INTEGER NOT NULL, clockOut INTEGER, description TEXT, createdAt INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_time_entries_userId ON time_entries (userId);
        CREATE INDEX IF NOT EXISTS idx_notes_projectId ON notes (projectId);
        CREATE INDEX IF NOT EXISTS idx_projects_createdAt ON projects (createdAt);
        CREATE INDEX IF NOT EXISTS idx_bids_createdAt ON bids (createdAt);
      `);
    },
  },
  {
    version: 2,
    name: 'legacy-dir-import',
    up({ db, dataDir }) {
      // Absorbs the old migrateOldData() (server.ts:217-272): pre-SQLite
      // installs kept JSON files in data/projects + data/images. Runs once;
      // renames the dirs after import so they are never re-read.
      const PROJECTS_DIR = path.join(dataDir, 'projects');
      const IMAGES_DIR = path.join(dataDir, 'images');
      const TEMPLATES_FILE = path.join(dataDir, 'templates.json');
      try {
        if (fsSync.existsSync(PROJECTS_DIR)) {
          const insert = db.prepare('INSERT OR IGNORE INTO projects (id, data, createdAt) VALUES (?, ?, ?)');
          for (const f of fsSync.readdirSync(PROJECTS_DIR)) {
            if (!f.endsWith('.json')) continue;
            const data = fsSync.readFileSync(path.join(PROJECTS_DIR, f), 'utf-8');
            const p = JSON.parse(data);
            insert.run(p.id, data, p.createdAt || Date.now());
          }
          fsSync.renameSync(PROJECTS_DIR, path.join(dataDir, 'projects_migrated'));
        }
      } catch (e) {
        console.error('[migrations] legacy project import failed (continuing):', e);
      }
      try {
        if (fsSync.existsSync(IMAGES_DIR)) {
          const insert = db.prepare('INSERT OR IGNORE INTO images (id, data) VALUES (?, ?)');
          for (const f of fsSync.readdirSync(IMAGES_DIR)) {
            if (!f.endsWith('.txt')) continue;
            insert.run(f.replace('.txt', ''), fsSync.readFileSync(path.join(IMAGES_DIR, f), 'utf-8'));
          }
          fsSync.renameSync(IMAGES_DIR, path.join(dataDir, 'images_migrated'));
        }
      } catch (e) {
        console.error('[migrations] legacy image import failed (continuing):', e);
      }
      try {
        if (fsSync.existsSync(TEMPLATES_FILE)) {
          const insert = db.prepare('INSERT OR IGNORE INTO templates (id, data) VALUES (?, ?)');
          for (const t of JSON.parse(fsSync.readFileSync(TEMPLATES_FILE, 'utf-8'))) {
            insert.run(t.id, JSON.stringify(t));
          }
          fsSync.renameSync(TEMPLATES_FILE, path.join(dataDir, 'templates_migrated.json'));
        }
      } catch (e) {
        console.error('[migrations] legacy template import failed (continuing):', e);
      }
    },
  },
  {
    version: 3,
    name: 'core-tables',
    up({ db }) {
      db.exec(`
        ALTER TABLE projects ADD COLUMN name TEXT;
        ALTER TABLE projects ADD COLUMN status TEXT NOT NULL DEFAULT 'estimating';
        ALTER TABLE projects ADD COLUMN contractor TEXT;
        ALTER TABLE projects ADD COLUMN address TEXT;
        ALTER TABLE projects ADD COLUMN bidDueDate INTEGER;
        ALTER TABLE projects ADD COLUMN contractValue REAL;
        ALTER TABLE projects ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE projects ADD COLUMN updatedAt INTEGER;
        ALTER TABLE projects ADD COLUMN meta TEXT;

        CREATE TABLE files (
          id TEXT PRIMARY KEY,
          projectId TEXT,
          name TEXT,
          mime TEXT NOT NULL DEFAULT 'application/octet-stream',
          size INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'other',
          parentFileId TEXT,
          versionNumber INTEGER NOT NULL DEFAULT 1,
          legacyFormat TEXT,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_files_projectId ON files (projectId);

        CREATE TABLE plan_sets (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL,
          name TEXT,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          attrs TEXT
        );
        CREATE INDEX idx_plan_sets_projectId ON plan_sets (projectId);

        CREATE TABLE pages (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL,
          planSetId TEXT,
          name TEXT,
          pageNumber TEXT,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          imageId TEXT,
          thumbnailId TEXT,
          sourcePdfFileId TEXT,
          sourcePdfPageNum INTEGER,
          attrs TEXT
        );
        CREATE INDEX idx_pages_projectId ON pages (projectId);

        CREATE TABLE takeoffs (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL,
          name TEXT,
          type TEXT,
          color TEXT,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          attrs TEXT
        );
        CREATE INDEX idx_takeoffs_projectId ON takeoffs (projectId);

        CREATE TABLE measurements (
          id TEXT PRIMARY KEY,
          pageId TEXT NOT NULL,
          projectId TEXT NOT NULL,
          takeoffId TEXT,
          type TEXT NOT NULL,
          name TEXT,
          color TEXT,
          points TEXT NOT NULL,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          attrs TEXT
        );
        CREATE INDEX idx_measurements_pageId ON measurements (pageId);
        CREATE INDEX idx_measurements_projectId ON measurements (projectId);

        CREATE TABLE activity (
          id TEXT PRIMARY KEY,
          projectId TEXT,
          userId TEXT,
          type TEXT NOT NULL,
          message TEXT,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_activity_projectId ON activity (projectId);
      `);
    },
  },
  {
    version: 4,
    name: 'images-to-disk',
    up({ db, dataDir }) {
      // Walks every legacy base64 blob out of the images table onto disk.
      // Disk writes are idempotent (same id → same path, atomic overwrite),
      // so a crash mid-migration is safe: the DB transaction rolls back and
      // the next boot redoes the walk.
      //
      // Stream rows with iterate() so multi-GB images tables never sit in the
      // JS heap: each blob is written to disk and dropped before the next row
      // is fetched. better-sqlite3 forbids running INSERTs while a cursor is
      // open on the same connection ("connection is busy" error), so only the
      // tiny metadata tuples are collected during the walk and inserted after
      // the cursor closes.
      const insert = db.prepare(`
        INSERT OR REPLACE INTO files (id, projectId, name, mime, size, sha256, kind, legacyFormat, createdAt)
        VALUES (?, NULL, NULL, ?, ?, ?, 'other', ?, ?)
      `);
      const now = Date.now();
      const metas: { id: string; mime: string; size: number; sha256: string; legacyFormat: string }[] = [];
      for (const row of db.prepare('SELECT id, data FROM images').iterate() as Iterable<{ id: string; data: string | null }>) {
        if (!row.data) continue;
        const { mime, legacyFormat, buf } = parseDataUrl(row.data);
        const { size, sha256 } = writeFileContent(dataDir, row.id, buf);
        metas.push({ id: row.id, mime, size, sha256, legacyFormat });
      }
      for (const m of metas) {
        insert.run(m.id, m.mime, m.size, m.sha256, m.legacyFormat, now);
      }
      db.exec('DROP TABLE images');
      console.log(`[migrations] moved ${metas.length} blobs from images table to disk`);
    },
  },
  {
    version: 5,
    name: 'normalize-projects',
    up({ db }) {
      const labelFile = db.prepare('UPDATE files SET projectId = ?, kind = ?, name = COALESCE(?, name) WHERE id = ?');
      const label = (projectId: string, kind: string, name: string | null, fileId: any) => {
        if (typeof fileId === 'string' && fileId) labelFile.run(projectId, kind, name, fileId);
      };
      const rows = db.prepare('SELECT id, data FROM projects').all() as { id: string; data: string | null }[];
      for (const row of rows) {
        if (!row.data) continue;
        let p: any;
        try { p = JSON.parse(row.data); } catch {
          console.warn(`[migrations] skipping unparseable project ${row.id} (data preserved)`);
          continue;
        }
        if (!p || typeof p !== 'object' || Array.isArray(p)) {
          console.warn(`[migrations] skipping non-object project ${row.id} (data preserved)`);
          continue;
        }
        p.id = row.id; // trust the row key over the blob
        decomposeProject(db, p, 1);

        // Label this project's files so Documents/storage views can attribute them.
        for (const pg of p.pages ?? []) {
          label(row.id, 'plan', pg.name ?? null, pg.imageId);
          label(row.id, 'plan', pg.name ?? null, pg.thumbnailId);
          label(row.id, 'plan', pg.name ?? null, pg.sourcePdfFileId);
        }
        for (const po of p.printouts ?? []) label(row.id, 'printout', po.name ?? null, po.fileId);
        label(row.id, 'proposal', 'Proposal', p.proposalFileId);
        const emails = [...(p.email ? [p.email] : []), ...(p.emails ?? [])];
        for (const e of emails) for (const aid of e?.attachmentIds ?? []) label(row.id, 'document', null, aid);
      }
      console.log(`[migrations] normalized ${rows.length} projects`);
    },
  },
  {
    version: 6,
    name: 'remove-bid-inbox',
    up({ db }) {
      // Bid inbox + IMAP receiving are removed in Phase 3 (spec §2). The
      // migration framework backs up the DB file before applying, so existing
      // bid data survives in backups/. Bid email attachments stay in files/
      // and become reclaimable via the explicit orphan-cleanup admin tool.
      db.exec('DROP TABLE IF EXISTS bids; DROP TABLE IF EXISTS email_accounts;');
    },
  },
  {
    version: 7,
    name: 'drafts',
    up({ db }) {
      // Server-side editor drafts (spec §6): crash/refresh-safe working state
      // for the PDF/spreadsheet editors, keyed per user per file. data is the
      // editor-specific JSON (annotations / FortuneSheet workbook) — the base
      // file content is re-fetched by fileId, never duplicated here.
      db.exec(`
        CREATE TABLE drafts (
          userId TEXT NOT NULL,
          fileId TEXT NOT NULL,
          kind TEXT NOT NULL,
          data TEXT NOT NULL,
          updatedAt INTEGER NOT NULL,
          PRIMARY KEY (userId, fileId)
        );
      `);
    },
  },
  {
    version: 8,
    name: 'billing',
    up({ db }) {
      // Billing v1 (spec §2, §3.2). Money stored as REAL dollars; all totals
      // are computed in integer cents in billingStore to avoid float drift.
      // Line-item identity is preserved (no totals-only invoices) so a future
      // AIA schedule-of-values can reference these rows (spec §3.2).
      db.exec(`
        CREATE TABLE invoices (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL,
          number TEXT,
          date INTEGER,
          status TEXT NOT NULL DEFAULT 'draft',
          terms TEXT,
          version INTEGER NOT NULL DEFAULT 1,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_invoices_projectId ON invoices (projectId);

        CREATE TABLE invoice_lines (
          id TEXT PRIMARY KEY,
          invoiceId TEXT NOT NULL,
          description TEXT,
          qty REAL NOT NULL DEFAULT 1,
          unitPrice REAL NOT NULL DEFAULT 0,
          sortOrder INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_invoice_lines_invoiceId ON invoice_lines (invoiceId);

        CREATE TABLE payments (
          id TEXT PRIMARY KEY,
          invoiceId TEXT NOT NULL,
          date INTEGER,
          amount REAL NOT NULL DEFAULT 0,
          method TEXT,
          note TEXT,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_payments_invoiceId ON payments (invoiceId);

        CREATE TABLE change_orders (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL,
          number TEXT,
          description TEXT,
          amount REAL NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'pending',
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_change_orders_projectId ON change_orders (projectId);
      `);
    },
  },
];
