import crypto from 'crypto';
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
  {
    version: 9,
    name: 'issues',
    up({ db }) {
      // Issue reports (spec §2 new facets, §3.2): numbered deficiency/observation
      // records with photos and an open→sent→resolved lifecycle. Field-created by
      // any user (not admin-gated). number is a per-project sequence (MAX+1).
      // Photos are existing files rows linked via issue_photos.
      db.exec(`
        CREATE TABLE issues (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL,
          number INTEGER NOT NULL,
          title TEXT,
          description TEXT,
          status TEXT NOT NULL DEFAULT 'open',
          version INTEGER NOT NULL DEFAULT 1,
          sentAt INTEGER,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_issues_projectId ON issues (projectId);

        CREATE TABLE issue_photos (
          id TEXT PRIMARY KEY,
          issueId TEXT NOT NULL,
          fileId TEXT NOT NULL,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_issue_photos_issueId ON issue_photos (issueId);
      `);
    },
  },
  {
    version: 10,
    name: 'punch',
    up({ db }) {
      // Punch & Checklists (spec §4.2): project-scoped, area-grouped punch items
      // with per-area progress and before/during/after photos. Field-created by any
      // user (not admin-gated, like issues). No numbering, no email — printable only.
      // Photos are existing files rows linked via punch_photos with a stage.
      db.exec(`
        CREATE TABLE punch_items (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL,
          area TEXT NOT NULL DEFAULT '',
          description TEXT NOT NULL DEFAULT '',
          done INTEGER NOT NULL DEFAULT 0,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          version INTEGER NOT NULL DEFAULT 1,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_punch_items_projectId ON punch_items (projectId);

        CREATE TABLE punch_photos (
          id TEXT PRIMARY KEY,
          punchItemId TEXT NOT NULL,
          fileId TEXT NOT NULL,
          stage TEXT NOT NULL DEFAULT 'before',
          sortOrder INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_punch_photos_itemId ON punch_photos (punchItemId);
      `);
    },
  },
  {
    version: 11,
    name: 'tasks',
    up({ db }) {
      // Collaborative Task List (Phase 4c-2): company-level, category-grouped tasks
      // assignable to any user, with todo|in_progress|done status, due dates, staged
      // photos (before|in_progress|after), and notes. Field-created by any user
      // (not admin-gated). Mirrors punch but with assignee + dueDate + status.
      db.exec(`
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          category TEXT NOT NULL DEFAULT '',
          title TEXT NOT NULL DEFAULT '',
          notes TEXT NOT NULL DEFAULT '',
          assigneeUserId TEXT,
          status TEXT NOT NULL DEFAULT 'todo',
          dueDate TEXT,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          version INTEGER NOT NULL DEFAULT 1,
          createdAt INTEGER NOT NULL,
          createdBy TEXT
        );
        CREATE INDEX idx_tasks_assignee ON tasks (assigneeUserId);
        CREATE INDEX idx_tasks_status ON tasks (status);

        CREATE TABLE task_photos (
          id TEXT PRIMARY KEY,
          taskId TEXT NOT NULL,
          fileId TEXT NOT NULL,
          stage TEXT NOT NULL DEFAULT 'before',
          sortOrder INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_task_photos_taskId ON task_photos (taskId);
      `);

      // Non-destructive import of legacy standalone checklists. Each legacy item
      // becomes a task (category = checklist name). The legacy `checklists` table
      // is intentionally KEPT as a backup. One bad blob must not fail boot — the
      // framework wraps up() in a transaction, but every inner error is caught
      // before it can propagate, so the outer transaction is never aborted.
      let rows: { data: string }[] = [];
      try {
        rows = db.prepare('SELECT data FROM checklists ORDER BY createdAt ASC').all() as { data: string }[];
      } catch { rows = []; } // table may not exist on a brand-new db

      const insTask = db.prepare(`INSERT INTO tasks
        (id, category, title, notes, assigneeUserId, status, dueDate, sortOrder, version, createdAt, createdBy)
        VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, 1, ?, NULL)`);
      const insPhoto = db.prepare(`INSERT INTO task_photos
        (id, taskId, fileId, stage, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?, ?)`);

      let sort = 0;
      for (const r of rows) {
        let cl: any;
        try { cl = JSON.parse(r.data); } catch { continue; } // skip malformed blob
        if (!cl || !Array.isArray(cl.items)) continue;
        const category = typeof cl.name === 'string' ? cl.name : '';
        for (const it of cl.items) {
          if (!it || typeof it !== 'object') continue;
          const taskId = typeof it.id === 'string' && it.id ? it.id : crypto.randomUUID();
          const title = typeof it.description === 'string' ? it.description : '';
          const notes = typeof it.comments === 'string' ? it.comments : '';
          const status = it.done === true ? 'done' : 'todo';
          const createdAt = Number.isFinite(it.createdAt) ? it.createdAt : Date.now();
          try {
            insTask.run(taskId, category, title, notes, status, sort++, createdAt);
          } catch { continue; } // duplicate id etc. — skip, don't abort
          let pSort = 0;
          const stages: [string, any][] = [
            ['before', it.beforePhotoIds],
            ['in_progress', it.inProgressPhotoIds],
            ['after', it.afterPhotoIds],
          ];
          for (const [stage, ids] of stages) {
            if (!Array.isArray(ids)) continue;
            for (const fileId of ids) {
              if (typeof fileId !== 'string' || !fileId) continue;
              try { insPhoto.run(crypto.randomUUID(), taskId, fileId, stage, pSort++, createdAt); } catch { /* skip */ }
            }
          }
        }
      }
    },
  },
  {
    version: 12,
    name: 'aia-billing',
    up({ db }) {
      // AIA progress billing (G702/G703): per-project Schedule of Values, a monthly
      // sequence of pay applications, and per-line progress. Money in INTEGER CENTS.
      // Additive — no data transform. (Phase 7, building on spec §3.2's anticipated
      // schedule_of_values / pay_applications.)
      db.exec(`
        CREATE TABLE aia_sov_lines (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL,
          itemNo TEXT,
          description TEXT NOT NULL DEFAULT '',
          scheduledValueCents INTEGER NOT NULL DEFAULT 0,
          retainagePercent REAL,
          isChangeOrder INTEGER NOT NULL DEFAULT 0,
          changeOrderId TEXT,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          version INTEGER NOT NULL DEFAULT 1,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_aia_sov_projectId ON aia_sov_lines (projectId);

        CREATE TABLE aia_pay_apps (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL,
          number INTEGER NOT NULL,
          periodTo TEXT,
          applicationDate TEXT,
          retainagePercent REAL NOT NULL DEFAULT 10,
          storedRetainagePercent REAL NOT NULL DEFAULT 10,
          status TEXT NOT NULL DEFAULT 'draft',
          version INTEGER NOT NULL DEFAULT 1,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_aia_pay_apps_projectId ON aia_pay_apps (projectId);

        CREATE TABLE aia_pay_app_lines (
          id TEXT PRIMARY KEY,
          payAppId TEXT NOT NULL,
          sovLineId TEXT NOT NULL,
          percentComplete REAL NOT NULL DEFAULT 0,
          storedMaterialsCents INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_aia_pay_app_lines_payAppId ON aia_pay_app_lines (payAppId);
      `);
    },
  },
  {
    version: 13,
    name: 'payments-polymorphic',
    up({ db }) {
      // A payment now targets an invoice OR an AIA pay application (Phase 7b).
      // SQLite cannot drop the NOT NULL invoiceId in place, so the table is
      // rebuilt: every existing row is copied and backfilled to an 'invoice'
      // target (non-destructive). Money stays REAL dollars (billingStore
      // computes integer cents). Runs inside the framework transaction.
      const exists = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='payments'`
      ).get();
      if (!exists) return;
      db.exec(`
        CREATE TABLE payments_new (
          id TEXT PRIMARY KEY,
          targetType TEXT NOT NULL,
          targetId TEXT NOT NULL,
          date INTEGER,
          amount REAL NOT NULL DEFAULT 0,
          method TEXT,
          note TEXT,
          createdAt INTEGER NOT NULL
        );
        INSERT INTO payments_new (id, targetType, targetId, date, amount, method, note, createdAt)
          SELECT id, 'invoice', invoiceId, date, amount, method, note, createdAt FROM payments;
        DROP TABLE payments;
        ALTER TABLE payments_new RENAME TO payments;
        CREATE INDEX idx_payments_target ON payments (targetType, targetId);
      `);
    },
  },
  {
    version: 14,
    name: 'change-order-line-items-photos',
    up({ db }) {
      // Change Orders gain invoice-like capability (Phase 9): line items, photos,
      // a version column (optimistic concurrency), and new fields (lumpSumAmount,
      // scheduleImpactDays, date). PURELY ADDITIVE — new columns get defaults and
      // two new tables are created; NO data rewrite. Existing change_orders rows
      // keep their `amount` (the canonical rolled-up total read by billingSummary
      // and aiaStore.syncChangeOrders), which now equals (Σ line cents + lump-sum
      // cents)/100, written server-side on save. Legacy status='pending' rows stay
      // valid (reads tolerate them; only new transitions use the new status set).
      db.exec(`
        ALTER TABLE change_orders ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE change_orders ADD COLUMN lumpSumAmount REAL NOT NULL DEFAULT 0;
        ALTER TABLE change_orders ADD COLUMN scheduleImpactDays INTEGER;
        ALTER TABLE change_orders ADD COLUMN date INTEGER;

        CREATE TABLE change_order_lines (
          id TEXT PRIMARY KEY,
          changeOrderId TEXT NOT NULL,
          description TEXT,
          qty REAL NOT NULL DEFAULT 1,
          unitPrice REAL NOT NULL DEFAULT 0,
          sortOrder INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_change_order_lines_changeOrderId ON change_order_lines (changeOrderId);

        CREATE TABLE change_order_photos (
          id TEXT PRIMARY KEY,
          changeOrderId TEXT NOT NULL,
          fileId TEXT NOT NULL,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_change_order_photos_changeOrderId ON change_order_photos (changeOrderId);
      `);
    },
  },
  {
    version: 15,
    name: 'plan-set-sheet-identity',
    up({ db }) {
      // Plan-set rework (spec docs/superpowers/specs/2026-06-28-plan-set-rework-design.md).
      //
      // ⚠️ DATA-TRANSFORMING + SUPERVISED. Per the migration protocol, this is
      // flagged to run on real data only under supervision. It is NON-DESTRUCTIVE:
      // no measurement row is ever deleted. The framework backs up the DB before
      // applying and VACUUMs after; the whole up() runs inside one transaction.
      //
      // Establishes the new "logical sheet" model, per project:
      //   (a) SUFFIX within-set duplicate page numbers ("A-101" -> "A-101 (2)")
      //       so each page in a set has a distinct number (mirrors the client-side
      //       suffixPageNumber in src/utils/sheetNaming.ts — kept behavior-identical).
      //   (b) ASSIGN a durable sheetId (uuid) to every page: pages sharing a
      //       normalized (trim+lowercase) page number across the whole project are
      //       revisions of one sheet and share one sheetId. Blank-numbered pages
      //       each become their own single-revision sheet. sheetId lands in the
      //       page row's attrs JSON (round-trips via decompose/loadProject).
      //   (c) CURRENT = LIVING: order each sheet's revisions oldest->newest by
      //       plan-set sortOrder (pages with no plan set sort last). The newest is
      //       the current/living revision. If the current page has ZERO measurement
      //       rows but an older revision has some, COPY the most-recent non-empty
      //       revision's measurements onto the current page (fresh uuids; source
      //       rows are RETAINED as frozen history — never deleted).

      const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

      // Next free "Base (n)" given a set of already-taken normalized numbers.
      // Identical behavior to src/utils/sheetNaming.ts suffixPageNumber.
      const suffixPageNumber = (base: string, takenNormalized: Set<string>): string => {
        let n = 2;
        while (takenNormalized.has(norm(`${base} (${n})`))) n++;
        return `${base} (${n})`;
      };

      // Plan-set order index per project (lower = older). plan_sets.sortOrder is
      // the persisted oldest->newest order written by decomposeProject.
      const planSetRows = db
        .prepare('SELECT id, projectId, sortOrder FROM plan_sets')
        .all() as { id: string; projectId: string; sortOrder: number }[];
      const setOrderById = new Map<string, number>();
      for (const ps of planSetRows) setOrderById.set(ps.id, ps.sortOrder);

      const updatePageNumber = db.prepare('UPDATE pages SET pageNumber = ? WHERE id = ?');
      const updatePageAttrs = db.prepare('UPDATE pages SET attrs = ? WHERE id = ?');
      const insMeas = db.prepare(`
        INSERT INTO measurements (id, pageId, projectId, takeoffId, type, name, color, points, sortOrder, attrs)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const projectIds = (
        db.prepare('SELECT id FROM projects').all() as { id: string }[]
      ).map(r => r.id);

      for (const projectId of projectIds) {
        const pages = db
          .prepare('SELECT id, planSetId, pageNumber, sortOrder, attrs FROM pages WHERE projectId = ? ORDER BY sortOrder')
          .all(projectId) as {
            id: string;
            planSetId: string | null;
            pageNumber: string | null;
            sortOrder: number;
            attrs: string | null;
          }[];
        if (pages.length === 0) continue;

        // Working page numbers (mutated by the suffix pass below).
        const pageNumberById = new Map<string, string | null>();
        for (const p of pages) pageNumberById.set(p.id, p.pageNumber);

        // ---- (a) Suffix within-set duplicate page numbers --------------------
        // Per plan set (null planSet grouped together), the first occurrence of a
        // non-blank number keeps it; later occurrences get the next free suffix.
        const takenBySet = new Map<string, Set<string>>(); // setKey -> normalized numbers taken
        const seenBySet = new Map<string, Set<string>>();   // setKey -> normalized numbers already seen once
        for (const p of pages) {
          const num = pageNumberById.get(p.id);
          const normNum = norm(num);
          if (!normNum) continue; // blank exempt
          const setKey = p.planSetId ?? '';
          let taken = takenBySet.get(setKey);
          if (!taken) { taken = new Set(); takenBySet.set(setKey, taken); }
          let seen = seenBySet.get(setKey);
          if (!seen) { seen = new Set(); seenBySet.set(setKey, seen); }

          if (!seen.has(normNum)) {
            // first time this number appears in the set — keep it
            seen.add(normNum);
            taken.add(normNum);
          } else {
            // duplicate — suffix off the original (pre-normalized) base text
            const base = (num ?? '').trim();
            const suffixed = suffixPageNumber(base, taken);
            taken.add(norm(suffixed));
            pageNumberById.set(p.id, suffixed);
            updatePageNumber.run(suffixed, p.id);
          }
        }

        // ---- (b) Assign sheetId by normalized page number (project-wide) ------
        // Pages sharing a normalized number are revisions of one sheet. Blank
        // numbers never group (each blank page is its own sheet).
        const sheetIdByNormNumber = new Map<string, string>();
        const sheetIdByPageId = new Map<string, string>();
        for (const p of pages) {
          const normNum = norm(pageNumberById.get(p.id));
          let sheetId: string;
          if (!normNum) {
            sheetId = crypto.randomUUID(); // blank -> own sheet
          } else {
            sheetId = sheetIdByNormNumber.get(normNum) ?? crypto.randomUUID();
            sheetIdByNormNumber.set(normNum, sheetId);
          }
          sheetIdByPageId.set(p.id, sheetId);

          // Persist sheetId into the page's attrs JSON.
          let attrs: any = {};
          if (p.attrs) { try { attrs = JSON.parse(p.attrs); } catch { attrs = {}; } }
          if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) attrs = {};
          attrs.sheetId = sheetId;
          updatePageAttrs.run(JSON.stringify(attrs), p.id);
        }

        // ---- (c) current = newest revision = living set ----------------------
        // Group pages by sheetId, order oldest->newest by plan-set order (pages
        // with no plan set, or a set not in the order map, sort LAST/standalone).
        const SET_LAST = Number.MAX_SAFE_INTEGER;
        const setOrderForPage = (planSetId: string | null): number =>
          planSetId ? (setOrderById.get(planSetId) ?? SET_LAST) : SET_LAST;
        const pageById = new Map(pages.map(p => [p.id, p]));

        const sheetGroups = new Map<string, string[]>(); // sheetId -> pageIds
        for (const p of pages) {
          const sid = sheetIdByPageId.get(p.id)!;
          const g = sheetGroups.get(sid) ?? [];
          g.push(p.id);
          sheetGroups.set(sid, g);
        }

        for (const pageIds of sheetGroups.values()) {
          if (pageIds.length <= 1) continue; // single revision — nothing to carry
          // oldest -> newest; stable on original sortOrder for ties.
          const ordered = [...pageIds].sort((a, b) => {
            const pa = pageById.get(a)!, pb = pageById.get(b)!;
            const oa = setOrderForPage(pa.planSetId), ob = setOrderForPage(pb.planSetId);
            if (oa !== ob) return oa - ob;
            return pa.sortOrder - pb.sortOrder;
          });
          const currentPageId = ordered[ordered.length - 1];

          const measCount = (pageId: string): number =>
            (db.prepare('SELECT COUNT(*) AS c FROM measurements WHERE pageId = ?').get(pageId) as { c: number }).c;

          // Current already living? leave it.
          if (measCount(currentPageId) > 0) continue;

          // Find the most-recent OLDER revision that has measurements.
          let sourcePageId: string | null = null;
          for (let i = ordered.length - 2; i >= 0; i--) {
            if (measCount(ordered[i]) > 0) { sourcePageId = ordered[i]; break; }
          }
          if (!sourcePageId) continue; // nothing to copy forward

          // Copy source measurements onto the current page with fresh uuids.
          // Source rows are RETAINED (frozen history) — never deleted.
          const srcRows = db
            .prepare('SELECT takeoffId, type, name, color, points, sortOrder, attrs FROM measurements WHERE pageId = ? ORDER BY sortOrder')
            .all(sourcePageId) as {
              takeoffId: string | null; type: string; name: string | null; color: string | null;
              points: string; sortOrder: number; attrs: string | null;
            }[];
          for (const m of srcRows) {
            insMeas.run(
              crypto.randomUUID(), currentPageId, projectId,
              m.takeoffId, m.type, m.name, m.color, m.points, m.sortOrder, m.attrs
            );
          }
        }
      }
    },
  },
  {
    version: 16,
    name: 'customers-from-contractor',
    // SUPERVISED, data-transforming, NON-DESTRUCTIVE. Creates the customers table
    // + projects.customerId, then makes one Customer per distinct (trimmed,
    // lower-cased) contractor string and links its projects. Projects with a
    // blank/null contractor go to a single well-known "Unassigned" customer so
    // they remain reachable. `contractor` is left untouched.
    up({ db }) {
      const cols = (db.prepare(`PRAGMA table_info(projects)`).all() as any[]).map(c => c.name);
      if (!cols.includes('customerId')) db.exec(`ALTER TABLE projects ADD COLUMN customerId TEXT;`);
      db.exec(`
        CREATE TABLE IF NOT EXISTS customers (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT, address TEXT,
          contactName TEXT, notes TEXT, generalEmail TEXT, accountingEmail TEXT,
          estimatingEmail TEXT, pmEmail TEXT, createdAt INTEGER, updatedAt INTEGER, attrs TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_projects_customerId ON projects (customerId);
      `);
      const now = Date.now();
      db.prepare(`INSERT OR IGNORE INTO customers (id,name,createdAt,updatedAt) VALUES (?,?,?,?)`)
        .run('customer-unassigned', 'Unassigned', now, now);

      // Only touch not-yet-linked projects so a re-run is a no-op (idempotent).
      const rows = db.prepare(`SELECT id, contractor FROM projects WHERE customerId IS NULL OR customerId = ''`).all() as any[];
      const byNorm = new Map<string, string>();
      let seq = 0;
      const link = db.prepare(`UPDATE projects SET customerId = ? WHERE id = ?`);
      for (const r of rows) {
        const raw = (r.contractor ?? '').trim();
        if (!raw) { link.run('customer-unassigned', r.id); continue; }
        const norm = raw.toLowerCase();
        let cid = byNorm.get(norm);
        if (!cid) {
          cid = `customer-mig-${now}-${seq++}`;
          db.prepare(`INSERT INTO customers (id,name,createdAt,updatedAt) VALUES (?,?,?,?)`).run(cid, raw, now, now);
          byNorm.set(norm, cid);
        }
        link.run(cid, r.id);
      }
    },
  },
  {
    version: 17,
    name: 'customer-emails-json',
    // ADDITIVE, NON-DESTRUCTIVE, IDEMPOTENT. Upgrades customer role emails from
    // 4 flat string columns (generalEmail etc.) to a single JSON column `emails`
    // whose shape is CustomerRoleEmails (each role holds {to?, cc?, bcc?}).
    // The old columns are left untouched so rollback is safe.
    up({ db }) {
      // Add the column idempotently.
      const cols = (db.prepare(`PRAGMA table_info(customers)`).all() as any[]).map((c: any) => c.name);
      if (!cols.includes('emails')) {
        db.exec(`ALTER TABLE customers ADD COLUMN emails TEXT;`);
      }

      // Backfill: only touch rows where emails is still NULL (re-run safe).
      const rows = db.prepare(
        `SELECT id, generalEmail, accountingEmail, estimatingEmail, pmEmail
         FROM customers WHERE emails IS NULL`
      ).all() as { id: string; generalEmail: string | null; accountingEmail: string | null; estimatingEmail: string | null; pmEmail: string | null }[];

      const upd = db.prepare(`UPDATE customers SET emails = ? WHERE id = ?`);
      for (const r of rows) {
        const obj: Record<string, { to: string }> = {};
        if (r.generalEmail) obj.general = { to: r.generalEmail };
        if (r.accountingEmail) obj.accounting = { to: r.accountingEmail };
        if (r.estimatingEmail) obj.estimating = { to: r.estimatingEmail };
        if (r.pmEmail) obj.pm = { to: r.pmEmail };
        // Only write non-empty objects; rows with all-null columns stay NULL.
        if (Object.keys(obj).length > 0) {
          upd.run(JSON.stringify(obj), r.id);
        }
      }
    },
  },
  {
    version: 18,
    name: 'task-relations',
    // ADDITIVE. A task may relate to a project and/or customer as its SUBJECT
    // (not its doer). Setting a project derives+locks its customer; that
    // invariant is enforced in taskStore, not here. Existing tasks stay NULL.
    up({ db }) {
      db.exec(`
        ALTER TABLE tasks ADD COLUMN projectId TEXT;
        ALTER TABLE tasks ADD COLUMN customerId TEXT;
        CREATE INDEX idx_tasks_projectId ON tasks (projectId);
        CREATE INDEX idx_tasks_customerId ON tasks (customerId);
      `);
    },
  },
  {
    version: 19,
    name: 'rfis',
    // ADDITIVE. RFIs — numbered Requests For Information, like issues but with
    // header fields (spec/drawing ref, attention), a response-needed-by date,
    // and a tracked response (uploaded PDF and/or text). Photos mirror
    // issue_photos. No FKs (project convention); cascades are manual.
    up({ db }) {
      db.exec(`
        CREATE TABLE rfis (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL,
          number INTEGER NOT NULL,
          title TEXT,
          question TEXT,
          specRef TEXT,
          drawingRef TEXT,
          attention TEXT,
          responseNeededBy TEXT,
          responseText TEXT,
          responseFileId TEXT,
          status TEXT NOT NULL DEFAULT 'open',
          version INTEGER NOT NULL DEFAULT 1,
          sentAt INTEGER,
          answeredAt INTEGER,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_rfis_projectId ON rfis (projectId);
        CREATE TABLE rfi_photos (
          id TEXT PRIMARY KEY,
          rfiId TEXT NOT NULL,
          fileId TEXT NOT NULL,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX idx_rfi_photos_rfiId ON rfi_photos (rfiId);
      `);
    },
  },
  {
    version: 20,
    name: 'rfi-counter',
    // ADDITIVE. RFI numbers are referenced in external correspondence, so an
    // issued number must never be reused after a delete. Numbering moves from
    // MAX(number)+1 to a per-project high-water counter, backfilled to each
    // project's current max.
    up({ db }) {
      db.exec('ALTER TABLE projects ADD COLUMN rfiCounter INTEGER NOT NULL DEFAULT 0;');
      db.exec(`UPDATE projects SET rfiCounter = COALESCE(
        (SELECT MAX(number) FROM rfis WHERE rfis.projectId = projects.id), 0)`);
    },
  },
  {
    version: 21,
    name: 'two-stage-lifecycle',
    // Collapses the 8 legacy stages to bidding|in_progress. complete/lost
    // auto-archive (lost also gets meta.lostBid for the Archive view's badge).
    // Only projects.status + meta.archived/meta.lostBid change — idempotent.
    up({ db }) {
      const rows = db.prepare('SELECT id, status, meta FROM projects').all() as any[];
      const upd = db.prepare('UPDATE projects SET status = ?, meta = ? WHERE id = ?');
      for (const r of rows) {
        const old = r.status ?? 'estimating';
        const meta = r.meta ? JSON.parse(r.meta) : {};
        let status: string;
        if (old === 'bidding' || old === 'in_progress') status = old; // re-run safe
        else if (['estimating', 'proposal_sent'].includes(old)) status = 'bidding';
        else if (['awarded', 'punch_list'].includes(old)) status = 'in_progress';
        else if (old === 'complete') { status = 'in_progress'; meta.archived = true; }
        else if (old === 'archived') { status = 'in_progress'; meta.archived = true; }
        else if (old === 'lost') { status = 'bidding'; meta.archived = true; meta.lostBid = true; }
        else status = 'bidding';
        upd.run(status, JSON.stringify(meta), r.id);
      }
    },
  },
];
