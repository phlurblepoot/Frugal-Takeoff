// server/routes.ts
import express from 'express';
import fsSync from 'fs';
import type Database from 'better-sqlite3';
import {
  listProjects, loadProject, createProject, saveProject, deleteProject,
  listProjectSummaries, patchProject, ValidationError, ConflictError, NotFoundError,
} from './projectStore';
import { putDataUrl, putBuffer, getMeta, getDataUrlString, saveNewVersion, listVersions } from './files';
import { pathFor, statFile, deleteFileContent } from './fileStore';
import { logActivity, listActivity } from './activity';

export interface RouteDeps {
  db: Database.Database;
  dataDir: string;
  dbFile: string;
  authenticateToken: express.RequestHandler;
  requireAdmin: express.RequestHandler;
  // Verifies a JWT from a query parameter (for streaming URLs that can't set
  // headers). Returns the decoded user or null.
  verifyToken: (token: string) => unknown | null;
}

export function registerDataRoutes(app: express.Express, deps: RouteDeps): void {
  const { db, dataDir, dbFile, authenticateToken, requireAdmin, verifyToken } = deps;

  // ── Projects ──────────────────────────────────────────────────────────────

  app.get('/api/projects', authenticateToken, (_req, res) => {
    try {
      res.json(listProjects(db));
    } catch (e) {
      console.error('Error fetching projects:', e);
      res.status(500).json({ error: 'Failed to fetch projects' });
    }
  });

  // NOTE: must be registered before '/api/projects/:id' or Express matches
  // 'summary' as a project id.
  app.get('/api/projects/summary', authenticateToken, (_req, res) => {
    try {
      res.json(listProjectSummaries(db));
    } catch (e) {
      console.error('Error fetching project summaries:', e);
      res.status(500).json({ error: 'Failed to fetch project summaries' });
    }
  });

  app.get('/api/projects/:id/summary', authenticateToken, (req, res) => {
    try {
      const row = listProjectSummaries(db, req.params.id)[0];
      if (!row) return res.status(404).json({ error: 'Project not found' });
      res.json(row);
    } catch (e) {
      console.error('Error fetching project summary:', e);
      res.status(500).json({ error: 'Failed to fetch project summary' });
    }
  });

  app.get('/api/projects/:id', authenticateToken, (req, res) => {
    try {
      const project = loadProject(db, req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      res.json(project);
    } catch (e) {
      console.error('Error fetching project:', e);
      res.status(500).json({ error: 'Failed to fetch project' });
    }
  });

  app.post('/api/projects', authenticateToken, (req, res) => {
    try {
      const result = createProject(db, req.body);
      logActivity(db, {
        projectId: req.body?.id, userId: (req as any).user?.id,
        type: 'project_created', message: `Project "${req.body?.name ?? 'Untitled'}" created`,
      });
      res.json({ success: true, version: result.version });
    } catch (e) {
      if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
      console.error('Error creating project:', e);
      res.status(500).json({ error: 'Failed to create project' });
    }
  });

  app.put('/api/projects/:id', authenticateToken, (req, res) => {
    try {
      const result = saveProject(db, req.params.id, req.body);
      res.json({ success: true, version: result.version });
    } catch (e) {
      if (e instanceof ConflictError) return res.status(409).json({ error: e.message, code: 'version_conflict' });
      if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
      console.error('Error updating project:', e);
      res.status(500).json({ error: 'Failed to update project' });
    }
  });

  app.patch('/api/projects/:id', authenticateToken, (req, res) => {
    try {
      const result = patchProject(db, req.params.id, req.body);
      if (req.body?.status !== undefined) {
        logActivity(db, {
          projectId: req.params.id, userId: (req as any).user?.id,
          type: 'status_changed', message: `Stage changed to ${req.body.status}`,
        });
      }
      res.json({ success: true, ...result });
    } catch (e) {
      if (e instanceof NotFoundError) return res.status(404).json({ error: e.message });
      if (e instanceof ConflictError) return res.status(409).json({ error: e.message, code: 'version_conflict' });
      if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
      console.error('Error patching project:', e);
      res.status(500).json({ error: 'Failed to update project' });
    }
  });

  app.delete('/api/projects/:id', authenticateToken, (req, res) => {
    try {
      const name = (db.prepare('SELECT name FROM projects WHERE id = ?').get(req.params.id) as any)?.name;
      deleteProject(db, dataDir, req.params.id);
      logActivity(db, {
        userId: (req as any).user?.id,
        type: 'project_deleted', message: `Project "${name ?? 'Untitled'}" deleted`,
      });
      res.json({ success: true });
    } catch (e) {
      console.error('Error deleting project:', e);
      res.status(500).json({ error: 'Failed to delete project' });
    }
  });

  app.get('/api/activity', authenticateToken, (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' && req.query.projectId ? req.query.projectId : undefined;
      res.json({ items: listActivity(db, Number(req.query.limit) || 30, projectId) });
    } catch (e) {
      console.error('Error fetching activity:', e);
      res.status(500).json({ error: 'Failed to fetch activity' });
    }
  });

  app.get('/api/projects/:id/storage', authenticateToken, (req, res) => {
    try {
      const project = loadProject(db, req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const { version, status, ...legacyShape } = project;
      const dataBytes = Buffer.byteLength(JSON.stringify(legacyShape), 'utf8');
      const img = db.prepare(
        'SELECT COUNT(*) as count, COALESCE(SUM(size), 0) as bytes FROM files WHERE projectId = ?'
      ).get(req.params.id) as { count: number; bytes: number };
      const noteRow = db.prepare(
        'SELECT COALESCE(SUM(length(CAST(data AS BLOB))), 0) as bytes FROM notes WHERE projectId = ?'
      ).get(req.params.id) as { bytes: number };
      res.json({
        totalBytes: dataBytes + img.bytes + noteRow.bytes,
        dataBytes,
        imageBytes: img.bytes,
        noteBytes: noteRow.bytes,
        imageCount: img.count,
      });
    } catch (e) {
      console.error('Error computing project storage:', e);
      res.status(500).json({ error: 'Failed to compute project storage' });
    }
  });

  // ── Images (legacy compat) + files ────────────────────────────────────────

  app.get('/api/images/:id', authenticateToken, (req, res) => {
    try {
      const data = getDataUrlString(db, dataDir, req.params.id);
      if (data == null) return res.status(404).json({ error: 'Image not found' });
      res.json({ data });
    } catch (e) {
      res.status(500).json({ error: 'Failed to fetch image' });
    }
  });

  // Public (used in <img src> / pdf.js URLs) — kept public deliberately.
  app.get('/api/images/:id/raw', (req, res) => {
    try {
      const meta = getMeta(db, req.params.id);
      const st = statFile(dataDir, req.params.id);
      if (!meta || !st) return res.status(404).send('Image not found');
      res.set('Content-Type', meta.mime);
      res.set('Content-Length', String(st.size));
      res.set('Cache-Control', 'public, max-age=31536000');
      fsSync.createReadStream(pathFor(dataDir, req.params.id)).pipe(res);
    } catch (e) {
      res.status(500).send('Failed to fetch image');
    }
  });

  app.post('/api/images', authenticateToken, (req, res) => {
    try {
      const { id, data } = req.body;
      if (typeof id !== 'string' || !id || typeof data !== 'string' || !data) {
        return res.status(400).json({ error: 'id and data are required' });
      }
      putDataUrl(db, dataDir, id, data);
      res.json({ success: true });
    } catch (e) {
      console.error('Error saving image:', e);
      res.status(500).json({ error: 'Failed to save image' });
    }
  });

  app.post(
    '/api/files/:id',
    express.raw({ limit: '100mb', type: () => true }),
    authenticateToken,
    (req, res) => {
      try {
        const body = req.body as Buffer;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          return res.status(400).json({ error: 'Empty body' });
        }
        const mime = (req.get('Content-Type') || 'application/octet-stream').split(';')[0].trim();
        // Optional labeling so project-context uploads land attributed
        // (Phase 1 left projectId NULL on this legacy-compat endpoint).
        // Known limitation (internal single-tenant): re-POSTing an existing
        // file id with a different ?projectId relabels it. Real uploads use
        // fresh UUIDs so this only triggers on deliberate re-posts.
        const q = req.query;
        putBuffer(db, dataDir, req.params.id, body, mime, {
          projectId: typeof q.projectId === 'string' && q.projectId ? q.projectId : undefined,
          kind: typeof q.kind === 'string' && q.kind ? q.kind : undefined,
          name: typeof q.name === 'string' && q.name ? q.name : undefined,
        });
        res.json({ success: true });
      } catch (e) {
        console.error('Error saving file:', e);
        res.status(500).json({ error: 'Failed to save file' });
      }
    }
  );

  // Streaming read with HTTP Range support. Auth via Authorization header or
  // ?token= (media elements and pdf.js can't always set headers).
  app.get('/api/files/:id/content', (req, res) => {
    try {
      const header = req.headers['authorization'];
      const bearer = header && header.split(' ')[1];
      const token = bearer || String(req.query.token || '');
      if (!token || !verifyToken(token)) return res.status(401).json({ error: 'Authentication required' });

      const meta = getMeta(db, req.params.id);
      const st = statFile(dataDir, req.params.id);
      if (!meta || !st) return res.status(404).json({ error: 'File not found' });

      const filePath = pathFor(dataDir, req.params.id);
      res.set('Accept-Ranges', 'bytes');
      res.set('Content-Type', meta.mime);

      const range = req.headers.range;
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!m) return res.status(416).set('Content-Range', `bytes */${st.size}`).end();
        let start = m[1] === '' ? NaN : parseInt(m[1], 10);
        let end = m[2] === '' ? NaN : parseInt(m[2], 10);
        if (Number.isNaN(start)) { start = st.size - end; end = st.size - 1; } // suffix range
        if (Number.isNaN(end) || end >= st.size) end = st.size - 1;
        if (Number.isNaN(start) || start < 0 || start > end) {
          return res.status(416).set('Content-Range', `bytes */${st.size}`).end();
        }
        res.status(206);
        res.set('Content-Range', `bytes ${start}-${end}/${st.size}`);
        res.set('Content-Length', String(end - start + 1));
        fsSync.createReadStream(filePath, { start, end }).pipe(res);
      } else {
        res.set('Content-Length', String(st.size));
        fsSync.createReadStream(filePath).pipe(res);
      }
    } catch (e) {
      console.error('Error streaming file:', e);
      res.status(500).json({ error: 'Failed to stream file' });
    }
  });

  // Save-as-version: archive current content, overwrite live id in place.
  app.post(
    '/api/files/:id/versions',
    express.raw({ limit: '100mb', type: () => true }),
    authenticateToken,
    (req, res) => {
      try {
        const body = req.body as Buffer;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          return res.status(400).json({ error: 'Empty body' });
        }
        const target = getMeta(db, req.params.id);
        if (!target) return res.status(404).json({ error: 'File not found' });
        if (target.parentFileId) return res.status(400).json({ error: 'Cannot version a historical file row' });
        const mime = (req.get('Content-Type') || 'application/octet-stream').split(';')[0].trim();
        const result = saveNewVersion(db, dataDir, req.params.id, body, mime);
        res.json({ success: true, ...result });
      } catch (e) {
        console.error('Error saving file version:', e);
        res.status(500).json({ error: 'Failed to save file version' });
      }
    }
  );

  app.get('/api/files/:id/versions', authenticateToken, (req, res) => {
    try {
      const versions = listVersions(db, req.params.id).map(({ sha256, legacyFormat, ...slim }: any) => slim);
      if (versions.length === 0) return res.status(404).json({ error: 'File not found' });
      res.json(versions);
    } catch (e) {
      res.status(500).json({ error: 'Failed to list file versions' });
    }
  });

  app.get('/api/files/:id/meta', authenticateToken, (req, res) => {
    try {
      const meta = getMeta(db, req.params.id);
      if (!meta) return res.status(404).json({ error: 'File not found' });
      const { sha256, legacyFormat, ...slim } = meta as any;
      res.json(slim);
    } catch (e) {
      res.status(500).json({ error: 'Failed to fetch file metadata' });
    }
  });

  app.get('/api/projects/:id/files', authenticateToken, (req, res) => {
    try {
      res.json(db.prepare(`
        SELECT id, projectId, name, mime, size, kind, parentFileId, versionNumber, createdAt
        FROM files WHERE projectId = ? AND parentFileId IS NULL
        ORDER BY createdAt DESC
      `).all(req.params.id));
    } catch (e) {
      console.error('Error listing project files:', e);
      res.status(500).json({ error: 'Failed to list project files' });
    }
  });

  // ── Storage admin ─────────────────────────────────────────────────────────

  // Conservative reference walk: serialize every project aggregate plus every
  // remaining JSON blob (checklists, notes) and shares, collect every
  // string and every /api/images|files/<id> URL. A file is an orphan only if
  // its id appears nowhere.
  const collectReferencedFileIds = (): Set<string> => {
    const referenced = new Set<string>();
    const urlRe = /\/api\/(?:images|files)\/([^/"'?\s]+)/g;
    const addString = (s: string) => {
      referenced.add(s);
      let m: RegExpExecArray | null;
      urlRe.lastIndex = 0;
      while ((m = urlRe.exec(s)) !== null) {
        try { referenced.add(decodeURIComponent(m[1])); } catch { referenced.add(m[1]); }
      }
    };
    const walk = (v: any) => {
      if (v == null) return;
      if (typeof v === 'string') { addString(v); return; }
      if (Array.isArray(v)) { for (const x of v) walk(x); return; }
      if (typeof v === 'object') { for (const k in v) walk(v[k]); return; }
    };
    for (const p of listProjects(db)) walk(p);
    for (const table of ['checklists', 'notes']) {
      let rows: { data: string }[] = [];
      try { rows = db.prepare(`SELECT data FROM ${table}`).all() as { data: string }[]; } catch { continue; }
      for (const r of rows) {
        if (!r.data) continue;
        try { walk(JSON.parse(r.data)); } catch { addString(r.data); }
      }
    }
    // shares reference files directly (single-file shares) or via JSON page lists
    const shareRows = db.prepare('SELECT resourceId FROM shares').all() as { resourceId: string }[];
    for (const r of shareRows) {
      addString(r.resourceId);
      try { walk(JSON.parse(r.resourceId)); } catch { /* plain id */ }
    }
    // Files attributed to a live project are referenced by definition (e.g.
    // standalone Documents uploads whose id never appears in project JSON).
    const projectFileRows = db.prepare(
      'SELECT id FROM files WHERE projectId IS NOT NULL AND projectId IN (SELECT id FROM projects)'
    ).all() as { id: string }[];
    for (const r of projectFileRows) referenced.add(r.id);
    return referenced;
  };

  app.get('/api/storage/stats', authenticateToken, requireAdmin, (_req, res) => {
    try {
      let databaseBytes = 0;
      try { databaseBytes = fsSync.statSync(dbFile).size; } catch { /* ignore */ }
      const sumLen = (sql: string): number => {
        try { return (db.prepare(sql).get() as { bytes: number }).bytes; } catch { return 0; }
      };
      const breakdown = {
        images: sumLen('SELECT COALESCE(SUM(size), 0) as bytes FROM files'),
        projects: sumLen(`SELECT COALESCE(SUM(length(CAST(coalesce(meta,'') AS BLOB))), 0) as bytes FROM projects`)
          + sumLen(`SELECT COALESCE(SUM(length(CAST(coalesce(attrs,'') AS BLOB))), 0) as bytes FROM pages`)
          + sumLen(`SELECT COALESCE(SUM(length(CAST(points AS BLOB)) + length(CAST(coalesce(attrs,'') AS BLOB))), 0) as bytes FROM measurements`)
          + sumLen(`SELECT COALESCE(SUM(length(CAST(coalesce(attrs,'') AS BLOB))), 0) as bytes FROM takeoffs`),
        templates: sumLen('SELECT COALESCE(SUM(length(CAST(data AS BLOB))), 0) as bytes FROM templates'),
        notes: sumLen('SELECT COALESCE(SUM(length(CAST(data AS BLOB))), 0) as bytes FROM notes'),
        checklists: sumLen('SELECT COALESCE(SUM(length(CAST(data AS BLOB))), 0) as bytes FROM checklists'),
      };
      const imageCount = (db.prepare('SELECT COUNT(*) as c FROM files').get() as { c: number }).c;
      const fileBytesByProject = new Map<string, number>(
        (db.prepare('SELECT projectId, SUM(size) as bytes FROM files WHERE projectId IS NOT NULL GROUP BY projectId').all() as any[])
          .map(r => [r.projectId, r.bytes])
      );
      const projects = (db.prepare('SELECT id, name FROM projects').all() as { id: string; name: string | null }[])
        .map(r => ({ id: r.id, name: r.name || 'Untitled', totalBytes: fileBytesByProject.get(r.id) ?? 0 }))
        .sort((a, b) => b.totalBytes - a.totalBytes);
      res.json({ databaseBytes, breakdown, imageCount, projectCount: projects.length, projects });
    } catch (e) {
      console.error('Error computing storage stats:', e);
      res.status(500).json({ error: 'Failed to compute storage stats' });
    }
  });

  // Version-history rows are referenced via their parent: keep them as
  // long as the live file is referenced. Defined once and used by both
  // the GET and POST orphan handlers below.
  const isOrphan = (
    r: { id: string; parentFileId: string | null },
    referenced: Set<string>
  ) => !referenced.has(r.id) && !(r.parentFileId && referenced.has(r.parentFileId));

  app.get('/api/storage/orphans', authenticateToken, requireAdmin, (_req, res) => {
    try {
      const referenced = collectReferencedFileIds();
      const rows = db.prepare('SELECT id, size, parentFileId FROM files').all() as
        { id: string; size: number; parentFileId: string | null }[];
      let count = 0, bytes = 0;
      for (const r of rows) if (isOrphan(r, referenced)) { count++; bytes += r.size; }
      res.json({ count, bytes });
    } catch (e) {
      console.error('Error finding orphaned files:', e);
      res.status(500).json({ error: 'Failed to find orphaned files' });
    }
  });

  app.post('/api/storage/orphans/cleanup', authenticateToken, requireAdmin, (_req, res) => {
    try {
      const referenced = collectReferencedFileIds();
      const rows = db.prepare('SELECT id, size, parentFileId FROM files').all() as
        { id: string; size: number; parentFileId: string | null }[];
      const orphans = rows.filter(r => isOrphan(r, referenced));
      const bytesFreed = orphans.reduce((a, r) => a + r.size, 0);
      const tx = db.transaction(() => {
        const stmt = db.prepare('DELETE FROM files WHERE id = ?');
        for (const o of orphans) stmt.run(o.id);
      });
      tx();
      for (const o of orphans) deleteFileContent(dataDir, o.id);
      res.json({ deleted: orphans.length, bytesFreed });
    } catch (e) {
      console.error('Error cleaning up orphaned files:', e);
      res.status(500).json({ error: 'Failed to clean up orphaned files' });
    }
  });

  // ── Search (normalized) ───────────────────────────────────────────────────

  app.get('/api/search', authenticateToken, (req, res) => {
    try {
      const q = String(req.query.q || '').trim().toLowerCase();
      if (q.length < 2) return res.json({ results: [] });
      const like = `%${q}%`;
      const results: any[] = [];

      const projRows = db.prepare(`
        SELECT id, name, contractor, address FROM projects
        WHERE lower(coalesce(name,'') || ' ' || coalesce(contractor,'') || ' ' || coalesce(address,'')) LIKE ?
        LIMIT 6
      `).all(like) as any[];
      for (const p of projRows) {
        results.push({ type: 'project', id: `project:${p.id}`, title: p.name || 'Untitled', subtitle: p.contractor || p.address || '', projectId: p.id });
      }

      const pageRows = db.prepare(`
        SELECT pg.id, pg.projectId, pg.name, pg.pageNumber, pr.name as projectName
        FROM pages pg JOIN projects pr ON pr.id = pg.projectId
        WHERE lower(coalesce(pg.pageNumber,'') || ' ' || coalesce(pg.name,'') || ' ' || coalesce(pg.attrs,'')) LIKE ?
        LIMIT 12
      `).all(like) as any[];
      for (const pg of pageRows) {
        results.push({
          type: 'page',
          id: `page:${pg.projectId}:${pg.id}`,
          title: [pg.pageNumber, pg.name].filter(Boolean).join(' — ') || 'Page',
          subtitle: pg.projectName || 'Untitled',
          projectId: pg.projectId,
          pageId: pg.id,
        });
      }

      const takeoffRows = db.prepare(`
        SELECT t.id, t.projectId, t.name, pr.name as projectName
        FROM takeoffs t JOIN projects pr ON pr.id = t.projectId
        WHERE lower(coalesce(t.name,'')) LIKE ?
        LIMIT 6
      `).all(like) as any[];
      for (const t of takeoffRows) {
        results.push({ type: 'takeoff', id: `takeoff:${t.projectId}:${t.id}`, title: t.name, subtitle: t.projectName || 'Untitled', projectId: t.projectId });
      }

      res.json({ results });
    } catch (e) {
      console.error('Error running search:', e);
      res.status(500).json({ error: 'Search failed' });
    }
  });

  // ── Public share file serving (metadata share routes stay in server.ts) ──

  const sendFileById = (res: express.Response, id: string, cacheSeconds: number) => {
    const meta = getMeta(db, id);
    const st = statFile(dataDir, id);
    if (!meta || !st) return res.status(404).send('File not found');
    res.set('Content-Type', meta.mime);
    res.set('Content-Length', String(st.size));
    res.set('Cache-Control', `public, max-age=${cacheSeconds}`);
    fsSync.createReadStream(pathFor(dataDir, id)).pipe(res);
  };

  app.get('/api/share/:shareId/image/:index', (req, res) => {
    try {
      const share = db.prepare('SELECT type, resourceId FROM shares WHERE id = ?').get(req.params.shareId) as { type: string; resourceId: string } | undefined;
      if (!share || share.type !== 'pages') return res.status(404).send('Share not found');
      const pages = JSON.parse(share.resourceId) as { imageId: string }[];
      const idx = parseInt(req.params.index, 10);
      if (isNaN(idx) || idx < 0 || idx >= pages.length) return res.status(404).send('Page not found');
      sendFileById(res, pages[idx].imageId, 3600);
    } catch {
      res.status(500).send('Server error');
    }
  });

  app.get('/api/share/:shareId', (req, res) => {
    try {
      const share = db.prepare('SELECT resourceId FROM shares WHERE id = ?').get(req.params.shareId) as { resourceId: string } | undefined;
      if (!share) return res.status(404).send('Share not found');
      sendFileById(res, share.resourceId, 3600);
    } catch {
      res.status(500).send('Server error');
    }
  });

  // ── Editor drafts (per user, per file) ────────────────────────────────────

  const DRAFT_KINDS = ['pdf', 'sheet'];
  const MAX_DRAFT_BYTES = 20 * 1024 * 1024; // generous cap for big workbooks

  app.get('/api/drafts/:fileId', authenticateToken, (req, res) => {
    try {
      const row = db.prepare('SELECT kind, data, updatedAt FROM drafts WHERE userId = ? AND fileId = ?')
        .get((req as any).user.id, req.params.fileId);
      if (!row) return res.status(404).json({ error: 'No draft' });
      res.json(row);
    } catch (e) {
      res.status(500).json({ error: 'Failed to fetch draft' });
    }
  });

  app.put('/api/drafts/:fileId', authenticateToken, (req, res) => {
    try {
      const { kind, data } = req.body ?? {};
      if (!DRAFT_KINDS.includes(kind)) return res.status(400).json({ error: 'kind must be pdf or sheet' });
      if (typeof data !== 'string' || !data) return res.status(400).json({ error: 'data must be a non-empty string' });
      if (Buffer.byteLength(data, 'utf8') > MAX_DRAFT_BYTES) {
        return res.status(413).json({ error: 'Draft too large' });
      }
      db.prepare('INSERT OR REPLACE INTO drafts (userId, fileId, kind, data, updatedAt) VALUES (?, ?, ?, ?, ?)')
        .run((req as any).user.id, req.params.fileId, kind, data, Date.now());
      res.json({ success: true });
    } catch (e) {
      console.error('Error saving draft:', e);
      res.status(500).json({ error: 'Failed to save draft' });
    }
  });

  app.delete('/api/drafts/:fileId', authenticateToken, (req, res) => {
    try {
      db.prepare('DELETE FROM drafts WHERE userId = ? AND fileId = ?')
        .run((req as any).user.id, req.params.fileId);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to delete draft' });
    }
  });
}
