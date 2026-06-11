import fsSync from 'fs';
import path from 'path';
import type { Migration } from './migrations';

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
];
