import express from "express";
import { createServer as createViteServer } from "vite";
import { Server } from "socket.io";
import { createServer } from "http";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import dotenv from "dotenv";
import type Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import rateLimit from "express-rate-limit";
import nodemailer from "nodemailer";
import { openDb } from './server/db';
import { runMigrations } from './server/migrations';
import { migrations } from './server/migrationList';
import { registerDataRoutes, registerEmailRoutes } from './server/routes';
import { registerAiRoutes } from './server/aiRoutes';
import { getAiRunner } from './server/ai';

dotenv.config();

const DATA_DIR = process.env.STORAGE_PATH || path.join(process.cwd(), "data");
const DB_FILE = path.join(DATA_DIR, "app.db");

let db: Database.Database;

async function ensureDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

function initDb() {
  try {
    // Check if the path is a directory (common Docker volume mount mistake)
    if (fsSync.existsSync(DB_FILE) && fsSync.statSync(DB_FILE).isDirectory()) {
      console.error(`\n================================================================`);
      console.error(`❌ FATAL ERROR: Database path ${DB_FILE} is a directory!`);
      console.error(`This usually happens if you mapped a Docker volume directly to the database file`);
      console.error(`instead of the directory. Please check your Unraid/Docker volume settings.`);
      console.error(`Make sure you map to '/app/data' and NOT '/app/data/app.db'.`);
      console.error(`================================================================\n`);
      process.exit(1);
    }

    // Ensure the directory exists and is writable
    if (!fsSync.existsSync(DATA_DIR)) {
      fsSync.mkdirSync(DATA_DIR, { recursive: true });
    }
    
    // Test write permissions to the directory
    try {
      const testFile = path.join(DATA_DIR, '.write-test');
      fsSync.writeFileSync(testFile, 'test');
      fsSync.unlinkSync(testFile);
    } catch (err) {
      console.error(`\n================================================================`);
      console.error(`❌ FATAL ERROR: No write permission to ${DATA_DIR}!`);
      console.error(`Please check the permissions of your Unraid appdata folder.`);
      console.error(`Error details: ${err instanceof Error ? err.message : String(err)}`);
      console.error(`================================================================\n`);
      process.exit(1);
    }

    db = openDb(DB_FILE);
    runMigrations(db, DATA_DIR, migrations, { dbFile: DB_FILE, vacuum: true });

    // Initialize default settings
    const settingsCount = db.prepare('SELECT COUNT(*) as count FROM settings').get() as { count: number };
    if (settingsCount.count === 0) {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('appName', 'Takeoff Pro');
    }

    // Create default admin user if no users exist
    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
    if (userCount.count === 0) {
      const hash = bcrypt.hashSync('admin', 10);
      db.prepare('INSERT INTO users (id, username, password, role) VALUES (?, ?, ?, ?)').run(
        'admin-id-123', 'admin', hash, 'admin'
      );
    }
  } catch (error) {
    console.error(`\n================================================================`);
    console.error(`❌ FATAL ERROR: Failed to initialize SQLite database at ${DB_FILE}`);
    console.error(`Error details:`, error);
    console.error(`================================================================\n`);
    process.exit(1);
  }
}

const users: Record<string, { id: string; userId?: string; name: string; pageId: string; pageName: string; cursor: { x: number; y: number } | null; color: string; lastActive?: number }> = {};

async function startServer() {
  await ensureDirs();
  initDb();

  const app = express();
  // Trust the first reverse proxy hop (e.g. Cloudflare) so req.ip reflects the
  // real client IP from X-Forwarded-For. Without this, rate limiting buckets
  // all traffic under the proxy's IP and becomes effectively shared across users.
  app.set('trust proxy', 1);
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
    },
  });

  app.use(express.json({ limit: "50mb" }));

  // JWT secret resolution order:
  //   1. JWT_SECRET environment variable (admin override)
  //   2. Persisted secret in the settings table
  //   3. Generate a fresh 64-byte random secret and persist it
  // This means fresh installs work out of the box — no manual setup required.
  let JWT_SECRET = process.env.JWT_SECRET || '';
  if (!JWT_SECRET) {
    const existing = db.prepare("SELECT value FROM settings WHERE key = 'jwt.secret'").get() as { value: string } | undefined;
    if (existing?.value) {
      JWT_SECRET = existing.value;
    } else {
      JWT_SECRET = crypto.randomBytes(64).toString('hex');
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('jwt.secret', JWT_SECRET);
      console.log('Generated a new JWT signing secret and saved it to the database.');
    }
  }

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Auth Middleware
  const authenticateToken = (req: any, res: any, next: any) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
      if (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
      }
      req.user = user;
      next();
    });
  };

  const requireAdmin = (req: any, res: any, next: any) => {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  };

  registerDataRoutes(app, {
    db,
    dataDir: DATA_DIR,
    dbFile: DB_FILE,
    authenticateToken,
    requireAdmin,
    verifyToken: (token: string) => {
      try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
    },
  });

  // The Playwright e2e harness logs in many times per run (per-worker session +
  // a few explicit logins per spec), which would trip a 10/min cap. Detect the
  // e2e store (set via STORAGE_PATH=.e2e-data in playwright.config.ts) and lift
  // the cap there. Production behavior is unchanged.
  const isE2E = (process.env.STORAGE_PATH ?? '').includes('.e2e-data');
  const loginLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: isE2E ? 100000 : 10,
    message: { error: 'Too many login attempts. Please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  // Auth Routes
  app.post('/api/auth/login', loginLimiter, (req, res) => {
    const { username, password } = req.body;
    try {
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as any;
      if (!user) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const validPassword = bcrypt.compareSync(password, user.password);
      if (!validPassword) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
      res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
    } catch (error) {
      res.status(500).json({ error: 'Login failed' });
    }
  });

  app.get('/api/auth/me', authenticateToken, (req: any, res: any) => {
    res.json({ user: req.user });
  });

  app.post('/api/auth/change-password', authenticateToken, (req: any, res: any) => {
    const { currentPassword, newPassword } = req.body;
    try {
      const user = db.prepare('SELECT id, password FROM users WHERE id = ?').get(req.user.id) as any;
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      const validPassword = bcrypt.compareSync(currentPassword || '', user.password);
      if (!validPassword) {
        return res.status(400).json({ error: 'Current password is incorrect' });
      }
      if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6) {
        return res.status(400).json({ error: 'New password must be at least 6 characters' });
      }
      const hash = bcrypt.hashSync(newPassword, 10);
      db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, req.user.id);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Failed to change password' });
    }
  });

  // User Management Routes
  app.get('/api/users', authenticateToken, requireAdmin, (req, res) => {
    try {
      const users = db.prepare('SELECT id, username, role FROM users').all();
      res.json(users);
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch users' });
    }
  });

  app.post('/api/users', authenticateToken, requireAdmin, (req, res) => {
    const { username, password, role } = req.body;
    if (!username || typeof username !== 'string' || username.trim().length === 0) {
      return res.status(400).json({ error: 'Username is required' });
    }
    if (!password || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    const assignedRole = role || 'user';
    if (!['admin', 'user'].includes(assignedRole)) {
      return res.status(400).json({ error: 'Role must be admin or user' });
    }
    try {
      const hash = bcrypt.hashSync(password, 10);
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO users (id, username, password, role) VALUES (?, ?, ?, ?)').run(
        id, username.trim(), hash, assignedRole
      );
      res.json({ success: true, user: { id, username: username.trim(), role: assignedRole } });
    } catch (error: any) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        res.status(400).json({ error: 'Username already exists' });
      } else {
        res.status(500).json({ error: 'Failed to create user' });
      }
    }
  });

  app.patch('/api/users/:id/role', authenticateToken, requireAdmin, (req: any, res: any) => {
    const { role } = req.body;
    if (!['admin', 'user'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    try {
      const targetUser = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(req.params.id) as any;
      if (!targetUser) {
        return res.status(404).json({ error: 'User not found' });
      }
      // Prevent changing your own role (avoids self-lockout / stale-token confusion)
      if (req.params.id === req.user.id) {
        return res.status(400).json({ error: 'You cannot change your own role' });
      }
      // Prevent demoting the last admin
      if (targetUser.role === 'admin' && role === 'user') {
        const adminCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get() as any;
        if (adminCount.count <= 1) {
          return res.status(400).json({ error: 'Cannot remove the last admin' });
        }
      }
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
      res.json({ id: targetUser.id, username: targetUser.username, role });
    } catch (error) {
      res.status(500).json({ error: 'Failed to update user role' });
    }
  });

  app.delete('/api/users/:id', authenticateToken, requireAdmin, (req, res) => {
    try {
      // Prevent deleting the last admin
      const userToDelete = db.prepare('SELECT role FROM users WHERE id = ?').get(req.params.id) as any;
      if (userToDelete?.role === 'admin') {
        const adminCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get() as any;
        if (adminCount.count <= 1) {
          return res.status(400).json({ error: 'Cannot delete the last admin user' });
        }
      }
      
      db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
      db.prepare('DELETE FROM user_preferences WHERE userId = ?').run(req.params.id);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Failed to delete user' });
    }
  });

  app.get("/api/templates", authenticateToken, (req, res) => {
    try {
      const stmt = db.prepare('SELECT data FROM templates');
      const rows = stmt.all() as { data: string }[];
      const templates = rows.map(row => JSON.parse(row.data));
      res.json(templates);
    } catch (error) {
      res.json([]);
    }
  });

  app.post("/api/templates", authenticateToken, (req, res) => {
    try {
      const t = req.body;
      const stmt = db.prepare('INSERT OR REPLACE INTO templates (id, data) VALUES (?, ?)');
      stmt.run(t.id, JSON.stringify(t));
      res.json({ success: true });
    } catch (error) {
      console.error("Error saving template:", error);
      res.status(500).json({ error: "Failed to save template" });
    }
  });

  app.delete("/api/templates/:id", authenticateToken, (req, res) => {
    try {
      const stmt = db.prepare('DELETE FROM templates WHERE id = ?');
      stmt.run(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting template:", error);
      res.status(500).json({ error: "Failed to delete template" });
    }
  });

  // Notes API
  app.get("/api/projects/:projectId/notes", authenticateToken, (req, res) => {
    try {
      const stmt = db.prepare('SELECT data FROM notes WHERE projectId = ? ORDER BY updatedAt DESC');
      const row = stmt.get(req.params.projectId) as { data: string } | undefined;
      if (!row) {
        return res.json(null);
      }
      res.json(JSON.parse(row.data));
    } catch (error) {
      console.error("Error fetching notes:", error);
      res.status(500).json({ error: "Failed to fetch notes" });
    }
  });

  app.post("/api/projects/:projectId/notes", authenticateToken, (req, res) => {
    try {
      const note = req.body;
      const stmt = db.prepare('INSERT OR REPLACE INTO notes (id, projectId, data, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)');
      stmt.run(note.id, req.params.projectId, JSON.stringify(note), note.createdAt || Date.now(), Date.now());
      res.json({ success: true });
    } catch (error) {
      console.error("Error saving notes:", error);
      res.status(500).json({ error: "Failed to save notes" });
    }
  });

  // Active pages endpoint
  app.get("/api/pages/active", authenticateToken, (req, res) => {
    try {
      const activePageIds = Array.from(new Set(Object.values(users).map(u => u?.pageId).filter(Boolean)));
      console.log(`GET /api/pages/active - current users count: ${Object.keys(users).length}, active page IDs: ${JSON.stringify(activePageIds)}`);
      res.json(activePageIds);
    } catch (error) {
      console.error("Error in /api/pages/active route:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Settings API — public endpoint, excludes any key that could contain secrets
  // (jwt.secret, smtp.*, email.* credentials). Those are fetched via their own
  // authenticated endpoints.
  const SETTINGS_PRIVATE_PREFIXES = ['jwt.', 'smtp.'];
  const isPrivateSettingKey = (key: string) => SETTINGS_PRIVATE_PREFIXES.some(p => key.startsWith(p));
  app.get("/api/settings", (req, res) => {
    try {
      const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string, value: string }[];
      const settings: Record<string, string> = {};
      rows.forEach(row => { if (!isPrivateSettingKey(row.key)) settings[row.key] = row.value; });
      res.json(settings);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch settings" });
    }
  });

  app.post("/api/settings", authenticateToken, requireAdmin, (req, res) => {
    try {
      const settings = req.body;
      const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
      Object.entries(settings).forEach(([key, value]) => {
        stmt.run(key, value as string);
      });
      res.json({ success: true });
    } catch (error) {
      console.error("Error saving settings:", error);
      res.status(500).json({ error: "Failed to save settings" });
    }
  });

  // ── Sharing API ───────────────────────────────────────────────────────────────

  // Public: get share info (does not expose internal resourceId)
  app.get('/api/share/:shareId/info', (req, res) => {
    try {
      const row = db.prepare('SELECT type, name, resourceId FROM shares WHERE id = ?').get(req.params.shareId) as { type: string; name: string; resourceId: string } | undefined;
      if (!row) return res.status(404).json({ error: 'Share not found' });
      if (row.type === 'pages') {
        try {
          const pages = JSON.parse(row.resourceId) as { imageId: string; name: string; pageNumber?: string }[];
          return res.json({ type: row.type, name: row.name, count: pages.length });
        } catch { /* fall through */ }
      }
      res.json({ type: row.type, name: row.name });
    } catch {
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Public: return name/pageNumber metadata for one page in a 'pages' share
  app.get('/api/share/:shareId/page-info/:index', (req, res) => {
    try {
      const share = db.prepare('SELECT type, resourceId FROM shares WHERE id = ?').get(req.params.shareId) as { type: string; resourceId: string } | undefined;
      if (!share || share.type !== 'pages') return res.status(404).json({ error: 'Share not found' });
      const pages = JSON.parse(share.resourceId) as { imageId: string; name: string; pageNumber?: string }[];
      const idx = parseInt(req.params.index, 10);
      if (isNaN(idx) || idx < 0 || idx >= pages.length) return res.status(404).json({ error: 'Page not found' });
      const { name, pageNumber } = pages[idx];
      res.json({ name, pageNumber });
    } catch {
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Authenticated: create a share
  app.post('/api/shares', authenticateToken, (req, res) => {
    try {
      const { type, resourceId, name } = req.body as { type: string; resourceId: string; name: string };
      if (!type || !resourceId) return res.status(400).json({ error: 'Missing fields' });
      // Reuse existing share for same resourceId if it exists
      const existing = db.prepare('SELECT id FROM shares WHERE resourceId = ?').get(resourceId) as { id: string } | undefined;
      if (existing) return res.json({ id: existing.id });
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO shares (id, type, resourceId, name, createdAt) VALUES (?, ?, ?, ?, ?)').run(id, type, resourceId, name || '', Date.now());
      res.json({ id });
    } catch {
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Authenticated: delete a share
  app.delete('/api/shares/:id', authenticateToken, (req, res) => {
    try {
      db.prepare('DELETE FROM shares WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch {
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Checklists API removed — feature moved to /api/tasks (collaborative Tasks page).
  // The `checklists` table is retained as a data backup (see migration 11); do not drop it.

  // User Preferences API (per-user, cross-browser)
  app.get("/api/user-preferences", authenticateToken, (req, res) => {
    try {
      const rows = db.prepare('SELECT key, value FROM user_preferences WHERE userId = ?').all((req as any).user.id) as { key: string; value: string }[];
      const prefs: Record<string, string> = {};
      // Exclude smtp.* keys (per-user SMTP config incl. password) — those are
      // read/written only via the dedicated GET/POST /api/email/smtp routes.
      rows.forEach(row => { if (!row.key.startsWith('smtp.')) prefs[row.key] = row.value; });
      res.json(prefs);
    } catch (error) {
      console.error("Error fetching user preferences:", error);
      res.status(500).json({ error: "Failed to fetch preferences" });
    }
  });

  app.put("/api/user-preferences", authenticateToken, (req, res) => {
    try {
      const prefs = req.body;
      const stmt = db.prepare('INSERT OR REPLACE INTO user_preferences (userId, key, value) VALUES (?, ?, ?)');
      const userId = (req as any).user.id;
      Object.entries(prefs).forEach(([key, value]) => {
        // SMTP credentials are written only via the dedicated POST /api/email/smtp
        // route (per-user, type-coerced). Don't let the generic prefs endpoint be
        // a second write path for them.
        if (key.startsWith('smtp.')) return;
        stmt.run(userId, key, value as string);
      });
      res.json({ success: true });
    } catch (error) {
      console.error("Error saving user preferences:", error);
      res.status(500).json({ error: "Failed to save preferences" });
    }
  });

  // ── Email API ──────────────────────────────────────────────────────────────

  // Helper: read a user's per-user SMTP config (smtp.* keys in user_preferences),
  // stripped of the `smtp.` prefix. SMTP is strictly per-user — no global fallback.
  function getUserSmtp(userId: string): Record<string, string> {
    const rows = db.prepare("SELECT key, value FROM user_preferences WHERE userId = ? AND key LIKE 'smtp.%'").all(userId) as { key: string; value: string }[];
    const cfg: Record<string, string> = {};
    rows.forEach(r => { cfg[r.key.replace('smtp.', '')] = r.value; });
    return cfg;
  }

  // Helper: build SMTP transporter from the given user's config (null when not configured).
  function buildTransporter(userId: string) {
    const cfg = getUserSmtp(userId);
    if (!cfg.host || !cfg.username) return null;
    return nodemailer.createTransport({
      host: cfg.host,
      port: parseInt(cfg.port || '587'),
      secure: cfg.secure === 'true',
      auth: { user: cfg.username, pass: cfg.password },
    });
  }

  // The SMTP-settings routes + the four send routes (proposal/invoice/change-
  // order/issue) and the shared sendProjectEmail helper now live in
  // server/routes.ts so they can be unit-tested with a stubbed transporter.
  // SMTP-absent still no-ops: buildTransporter() returns null → sends throw
  // "SMTP not configured", exactly as before.
  registerEmailRoutes(app, {
    db,
    dataDir: DATA_DIR,
    authenticateToken,
    requireAdmin,
    buildTransporter,
    getUserSmtp,
  });

  registerAiRoutes(app, {
    dataDir: DATA_DIR,
    authenticateToken,
    runner: getAiRunner(),
  });

  // WebSocket Logic

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("join-page", ({ pageId, pageName, name, userId, color }) => {
      // If this socket already had a different page, leave it so we don't
      // accidentally fan out room messages to stale rooms.
      const previous = users[socket.id];
      if (previous && previous.pageId && previous.pageId !== pageId) {
        socket.leave(previous.pageId);
      }
      users[socket.id] = {
        id: socket.id,
        userId: userId || undefined,
        name,
        pageId,
        pageName: pageName || '',
        cursor: null,
        color,
        lastActive: Date.now(),
      };
      socket.join(pageId);

      // Notify others in the room
      const roomUsers = Object.values(users).filter(u => u.pageId === pageId);
      io.to(pageId).emit("room-users", roomUsers);

      // Notify everyone about global users
      io.emit("global-users", Object.values(users));
    });

    socket.on("cursor-move", ({ x, y }) => {
      const user = users[socket.id];
      if (user) {
        user.cursor = { x, y };
        user.lastActive = Date.now();
        socket.to(user.pageId).emit("user-cursor", { id: socket.id, cursor: { x, y } });
      }
    });

    socket.on("measurement-update", ({ pageId, action, measurement }) => {
      socket.to(pageId).emit("measurement-sync", { action, measurement });
    });

    socket.on("update-user", ({ name, color }) => {
      const user = users[socket.id];
      if (user) {
        user.name = name;
        user.color = color;
        const roomUsers = Object.values(users).filter(u => u.pageId === user.pageId);
        io.to(user.pageId).emit("room-users", roomUsers);
        io.emit("global-users", Object.values(users));
      }
    });

    socket.on("disconnect", () => {
      const user = users[socket.id];
      if (user) {
        const pageId = user.pageId;
        delete users[socket.id];
        const roomUsers = Object.values(users).filter(u => u.pageId === pageId);
        io.to(pageId).emit("room-users", roomUsers);
        io.emit("global-users", Object.values(users));
      }
      console.log("User disconnected:", socket.id);
    });
  });

  // Time Entry Routes
  app.get("/api/time-entries", authenticateToken, (req: any, res: any) => {
    try {
      const { projectId } = req.query;
      let rows;
      if (projectId) {
        rows = db.prepare('SELECT * FROM time_entries WHERE userId = ? AND projectId = ? ORDER BY clockIn DESC').all(req.user.id, projectId);
      } else {
        rows = db.prepare('SELECT * FROM time_entries WHERE userId = ? ORDER BY clockIn DESC').all(req.user.id);
      }
      res.json(rows);
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch time entries' });
    }
  });

  // Admin-only: every user's entries, joined with username for display.
  app.get("/api/time-entries/all", authenticateToken, requireAdmin, (req: any, res: any) => {
    try {
      const { userId } = req.query;
      const rows = userId
        ? db.prepare(`
            SELECT te.*, u.username
            FROM time_entries te
            JOIN users u ON te.userId = u.id
            WHERE te.userId = ?
            ORDER BY te.clockIn DESC
          `).all(userId)
        : db.prepare(`
            SELECT te.*, u.username
            FROM time_entries te
            JOIN users u ON te.userId = u.id
            ORDER BY te.clockIn DESC
          `).all();
      res.json(rows);
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch all time entries' });
    }
  });

  app.post("/api/time-entries/clock-in", authenticateToken, (req: any, res: any) => {
    try {
      const { projectId } = req.body;
      const existing = db.prepare('SELECT * FROM time_entries WHERE userId = ? AND clockOut IS NULL').get(req.user.id) as any;
      if (existing) {
        return res.status(400).json({ error: 'Already clocked in', entry: existing });
      }
      const entry = {
        id: uuidv4(),
        userId: req.user.id,
        projectId: projectId || null,
        clockIn: Date.now(),
        clockOut: null,
        description: '',
        createdAt: Date.now(),
      };
      db.prepare('INSERT INTO time_entries (id, userId, projectId, clockIn, clockOut, description, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        entry.id, entry.userId, entry.projectId, entry.clockIn, entry.clockOut, entry.description, entry.createdAt
      );
      res.json(entry);
    } catch (error) {
      res.status(500).json({ error: 'Failed to clock in' });
    }
  });

  app.put("/api/time-entries/clock-out", authenticateToken, (req: any, res: any) => {
    try {
      const { description } = req.body;
      const existing = db.prepare('SELECT * FROM time_entries WHERE userId = ? AND clockOut IS NULL').get(req.user.id) as any;
      if (!existing) {
        return res.status(400).json({ error: 'Not clocked in' });
      }
      const clockOut = Date.now();
      db.prepare('UPDATE time_entries SET clockOut = ?, description = ? WHERE id = ?').run(clockOut, description ?? existing.description, existing.id);
      res.json({ ...existing, clockOut, description: description ?? existing.description });
    } catch (error) {
      res.status(500).json({ error: 'Failed to clock out' });
    }
  });

  app.post("/api/time-entries", authenticateToken, (req: any, res: any) => {
    try {
      const { projectId, clockIn, clockOut, description } = req.body;
      if (!clockIn || !clockOut) {
        return res.status(400).json({ error: 'clockIn and clockOut are required for manual entries' });
      }
      const entry = {
        id: uuidv4(),
        userId: req.user.id,
        projectId: projectId || null,
        clockIn: Number(clockIn),
        clockOut: Number(clockOut),
        description: description || '',
        createdAt: Date.now(),
      };
      db.prepare('INSERT INTO time_entries (id, userId, projectId, clockIn, clockOut, description, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        entry.id, entry.userId, entry.projectId, entry.clockIn, entry.clockOut, entry.description, entry.createdAt
      );
      res.json(entry);
    } catch (error) {
      res.status(500).json({ error: 'Failed to create time entry' });
    }
  });

  app.put("/api/time-entries/:id", authenticateToken, (req: any, res: any) => {
    try {
      const existing = db.prepare('SELECT * FROM time_entries WHERE id = ? AND userId = ?').get(req.params.id, req.user.id) as any;
      if (!existing) {
        return res.status(404).json({ error: 'Entry not found' });
      }
      const { clockIn, clockOut, description } = req.body;
      db.prepare('UPDATE time_entries SET clockIn = ?, clockOut = ?, description = ? WHERE id = ?').run(
        clockIn ?? existing.clockIn, clockOut ?? existing.clockOut, description ?? existing.description, existing.id
      );
      res.json({ ...existing, clockIn: clockIn ?? existing.clockIn, clockOut: clockOut ?? existing.clockOut, description: description ?? existing.description });
    } catch (error) {
      res.status(500).json({ error: 'Failed to update time entry' });
    }
  });

  app.delete("/api/time-entries/:id", authenticateToken, (req: any, res: any) => {
    try {
      const existing = db.prepare('SELECT id FROM time_entries WHERE id = ? AND userId = ?').get(req.params.id, req.user.id);
      if (!existing) {
        return res.status(404).json({ error: 'Entry not found' });
      }
      db.prepare('DELETE FROM time_entries WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Failed to delete time entry' });
    }
  });

  // Unknown API routes must 404 as JSON — without this they fall through to
  // the SPA shell and return index.html with HTTP 200.
  app.all('/api/*', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // Global error handler
  app.use((err: any, req: any, res: any, next: any) => {
    console.error("Unhandled error:", err);
    res.status(500).json({ error: "Internal server error" });
  });

  const PORT = 3000;
  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
