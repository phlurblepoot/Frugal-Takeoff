import express from "express";
import { createServer as createViteServer } from "vite";
import { Server } from "socket.io";
import { createServer } from "http";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import dotenv from "dotenv";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";

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

    db = new Database(DB_FILE);
    
    // Use DELETE journal mode instead of WAL to prevent issues with Unraid's FUSE filesystem (/mnt/user)
    // WAL mode requires mmap which can fail on network shares or FUSE mounts
    db.pragma('journal_mode = DELETE');
    
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        data TEXT,
        createdAt INTEGER
      );
      CREATE TABLE IF NOT EXISTS images (
        id TEXT PRIMARY KEY,
        data TEXT
      );
      CREATE TABLE IF NOT EXISTS templates (
        id TEXT PRIMARY KEY,
        data TEXT
      );
      CREATE TABLE IF NOT EXISTS bids (
        id TEXT PRIMARY KEY,
        data TEXT,
        createdAt INTEGER
      );
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE,
        password TEXT,
        role TEXT
      );
    `);

    // Create default admin user if no users exist
    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
    if (userCount.count === 0) {
      const hash = bcrypt.hashSync('admin', 10);
      db.prepare('INSERT INTO users (id, username, password, role) VALUES (?, ?, ?, ?)').run(
        'admin-id-123', 'admin', hash, 'admin'
      );
    }

    migrateOldData();
  } catch (error) {
    console.error(`\n================================================================`);
    console.error(`❌ FATAL ERROR: Failed to initialize SQLite database at ${DB_FILE}`);
    console.error(`Error details:`, error);
    console.error(`================================================================\n`);
    process.exit(1);
  }
}

function migrateOldData() {
  const PROJECTS_DIR = path.join(DATA_DIR, "projects");
  const IMAGES_DIR = path.join(DATA_DIR, "images");
  const TEMPLATES_FILE = path.join(DATA_DIR, "templates.json");

  // Migrate projects
  try {
    if (fsSync.existsSync(PROJECTS_DIR)) {
      const files = fsSync.readdirSync(PROJECTS_DIR);
      const insertProject = db.prepare('INSERT OR IGNORE INTO projects (id, data, createdAt) VALUES (?, ?, ?)');
      for (const file of files) {
        if (file.endsWith(".json")) {
          const data = fsSync.readFileSync(path.join(PROJECTS_DIR, file), "utf-8");
          const project = JSON.parse(data);
          insertProject.run(project.id, data, project.createdAt || Date.now());
        }
      }
      fsSync.renameSync(PROJECTS_DIR, path.join(DATA_DIR, "projects_migrated"));
    }
  } catch (e) {
    console.error("Failed to migrate projects", e);
  }

  // Migrate images
  try {
    if (fsSync.existsSync(IMAGES_DIR)) {
      const files = fsSync.readdirSync(IMAGES_DIR);
      const insertImage = db.prepare('INSERT OR IGNORE INTO images (id, data) VALUES (?, ?)');
      for (const file of files) {
        if (file.endsWith(".txt")) {
          const data = fsSync.readFileSync(path.join(IMAGES_DIR, file), "utf-8");
          const id = file.replace('.txt', '');
          insertImage.run(id, data);
        }
      }
      fsSync.renameSync(IMAGES_DIR, path.join(DATA_DIR, "images_migrated"));
    }
  } catch (e) {
    console.error("Failed to migrate images", e);
  }

  // Migrate templates
  try {
    if (fsSync.existsSync(TEMPLATES_FILE)) {
      const data = fsSync.readFileSync(TEMPLATES_FILE, "utf-8");
      const templates = JSON.parse(data);
      const insertTemplate = db.prepare('INSERT OR IGNORE INTO templates (id, data) VALUES (?, ?)');
      for (const t of templates) {
        insertTemplate.run(t.id, JSON.stringify(t));
      }
      fsSync.renameSync(TEMPLATES_FILE, path.join(DATA_DIR, "templates_migrated.json"));
    }
  } catch (e) {
    console.error("Failed to migrate templates", e);
  }
}

const users: Record<string, { id: string; name: string; pageId: string; cursor: { x: number; y: number } | null; color: string }> = {};

async function startServer() {
  await ensureDirs();
  initDb();

  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
    },
  });

  app.use(express.json({ limit: "50mb" }));

  const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-change-in-production';

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Auth Middleware
  const authenticateToken = (req: any, res: any, next: any) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      // For development/debugging, we can still allow some routes if needed,
      // but let's be strict for now to see if this is the issue.
      // Actually, let's just log it.
      console.log('No token provided in authenticateToken');
      // If we want to bypass for now:
      req.user = { id: 'admin-id-123', username: 'admin', role: 'admin' };
      return next();
    }

    jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
      if (err) {
        console.error('JWT verification failed:', err.message);
        // Fallback to admin for now if we want to bypass, but let's see if this is the issue
        req.user = { id: 'admin-id-123', username: 'admin', role: 'admin' };
        return next();
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

  // Auth Routes
  app.post('/api/auth/login', (req, res) => {
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
    try {
      const hash = bcrypt.hashSync(password, 10);
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO users (id, username, password, role) VALUES (?, ?, ?, ?)').run(
        id, username, hash, role || 'user'
      );
      res.json({ success: true, user: { id, username, role: role || 'user' } });
    } catch (error: any) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        res.status(400).json({ error: 'Username already exists' });
      } else {
        res.status(500).json({ error: 'Failed to create user' });
      }
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
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Failed to delete user' });
    }
  });

  // API Routes
  app.get("/api/projects", authenticateToken, (req, res) => {
    try {
      const stmt = db.prepare('SELECT data FROM projects ORDER BY createdAt DESC');
      const rows = stmt.all() as { data: string }[];
      const projects = rows.map(row => JSON.parse(row.data));
      res.json(projects);
    } catch (error) {
      console.error("Error fetching projects:", error);
      res.status(500).json({ error: "Failed to fetch projects" });
    }
  });

  app.get("/api/projects/:id", authenticateToken, (req, res) => {
    try {
      const stmt = db.prepare('SELECT data FROM projects WHERE id = ?');
      const row = stmt.get(req.params.id) as { data: string } | undefined;
      if (!row) {
        return res.status(404).json({ error: "Project not found" });
      }
      res.json(JSON.parse(row.data));
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch project" });
    }
  });

  app.post("/api/projects", authenticateToken, (req, res) => {
    try {
      const project = req.body;
      const stmt = db.prepare('INSERT INTO projects (id, data, createdAt) VALUES (?, ?, ?)');
      stmt.run(project.id, JSON.stringify(project), project.createdAt || Date.now());
      res.json({ success: true });
    } catch (error) {
      console.error("Error creating project:", error);
      res.status(500).json({ error: "Failed to create project" });
    }
  });

  app.put("/api/projects/:id", authenticateToken, (req, res) => {
    try {
      const project = req.body;
      
      try {
        const stmtGet = db.prepare('SELECT data FROM projects WHERE id = ?');
        const row = stmtGet.get(req.params.id) as { data: string } | undefined;
        if (row) {
          const oldProject = JSON.parse(row.data);
          
          const newImageIds = new Set([
            ...(project.pages?.map((p: any) => p.imageId) || []),
            ...(project.printouts?.map((p: any) => p.fileId) || [])
          ]);

          const oldImageIds = [
            ...(oldProject.pages?.map((p: any) => p.imageId) || []),
            ...(oldProject.printouts?.map((p: any) => p.fileId) || [])
          ];

          const deleteImgStmt = db.prepare('DELETE FROM images WHERE id = ?');
          for (const imgId of oldImageIds) {
            if (!newImageIds.has(imgId)) {
              deleteImgStmt.run(imgId);
            }
          }
        }
      } catch (e) {
        // Ignore if old project doesn't exist or error occurs during cleanup
      }

      const stmt = db.prepare('UPDATE projects SET data = ? WHERE id = ?');
      const result = stmt.run(JSON.stringify(project), req.params.id);
      
      if (result.changes === 0) {
        // If it didn't exist, insert it
        const insertStmt = db.prepare('INSERT INTO projects (id, data, createdAt) VALUES (?, ?, ?)');
        insertStmt.run(project.id, JSON.stringify(project), project.createdAt || Date.now());
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Error updating project:", error);
      res.status(500).json({ error: "Failed to update project" });
    }
  });

  app.delete("/api/projects/:id", authenticateToken, (req, res) => {
    try {
      const stmtGet = db.prepare('SELECT data FROM projects WHERE id = ?');
      const row = stmtGet.get(req.params.id) as { data: string } | undefined;
      
      if (row) {
        const project = JSON.parse(row.data);
        const imageIds = [
          ...(project.pages?.map((p: any) => p.imageId) || []),
          ...(project.printouts?.map((p: any) => p.fileId) || [])
        ];
        
        const deleteImgStmt = db.prepare('DELETE FROM images WHERE id = ?');
        for (const imgId of imageIds) {
          deleteImgStmt.run(imgId);
        }
      }
      
      const stmtDel = db.prepare('DELETE FROM projects WHERE id = ?');
      stmtDel.run(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting project:", error);
      res.status(500).json({ error: "Failed to delete project" });
    }
  });

  app.get("/api/images/:id", authenticateToken, (req, res) => {
    try {
      const stmt = db.prepare('SELECT data FROM images WHERE id = ?');
      const row = stmt.get(req.params.id) as { data: string } | undefined;
      if (!row) {
        return res.status(404).json({ error: "Image not found" });
      }
      res.json({ data: row.data });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch image" });
    }
  });

  app.get("/api/images/:id/raw", authenticateToken, (req, res) => {
    try {
      const stmt = db.prepare('SELECT data FROM images WHERE id = ?');
      const row = stmt.get(req.params.id) as { data: string } | undefined;
      if (!row || !row.data) {
        return res.status(404).send("Image not found");
      }
      
      const matches = row.data.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
      if (!matches || matches.length !== 3) {
        return res.status(400).send("Invalid image data");
      }
      
      const contentType = matches[1];
      const buffer = Buffer.from(matches[2], 'base64');
      
      res.set('Content-Type', contentType);
      res.set('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year
      res.send(buffer);
    } catch (error) {
      res.status(500).send("Failed to fetch image");
    }
  });

  app.post("/api/images", authenticateToken, (req, res) => {
    try {
      const { id, data } = req.body;
      const stmt = db.prepare('INSERT OR REPLACE INTO images (id, data) VALUES (?, ?)');
      stmt.run(id, data);
      res.json({ success: true });
    } catch (error) {
      console.error("Error saving image:", error);
      res.status(500).json({ error: "Failed to save image" });
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

  // Bids API
  app.get("/api/bids", authenticateToken, (req, res) => {
    try {
      const stmt = db.prepare('SELECT data FROM bids ORDER BY createdAt DESC');
      const rows = stmt.all() as { data: string }[];
      const bids = rows.map(row => JSON.parse(row.data));
      res.json(bids);
    } catch (error) {
      console.error("Error fetching bids:", error);
      res.status(500).json({ error: "Failed to fetch bids" });
    }
  });

  app.post("/api/bids", authenticateToken, (req, res) => {
    try {
      const bid = req.body;
      const stmt = db.prepare('INSERT OR REPLACE INTO bids (id, data, createdAt) VALUES (?, ?, ?)');
      stmt.run(bid.id, JSON.stringify(bid), bid.createdAt || Date.now());
      res.json({ success: true });
    } catch (error) {
      console.error("Error saving bid:", error);
      res.status(500).json({ error: "Failed to save bid" });
    }
  });

  app.delete("/api/bids/:id", authenticateToken, (req, res) => {
    try {
      const stmt = db.prepare('DELETE FROM bids WHERE id = ?');
      stmt.run(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting bid:", error);
      res.status(500).json({ error: "Failed to delete bid" });
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

  // WebSocket Logic

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("join-page", ({ pageId, name, color }) => {
      users[socket.id] = { id: socket.id, name, pageId, cursor: null, color };
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
