# Phase 3b: Project Sections & Documents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the project into a real multi-section container — Overview, Takeoff & Estimate, Documents, Notes, Time as nested routes — with the PDF/spreadsheet editors opening project files by id, saving as new file versions, and autosaving server-side drafts.

**Architecture:** A nested route tree under `/project/:projectId` (ProjectLayout registers the sidebar context and shares a lightweight summary via outlet context; the existing ProjectView monolith becomes the `takeoff` section unchanged). The server grows four small surfaces on the Phase 1 data layer: single-project summary + per-project activity, project file listing/metadata + labeled uploads, **archive-then-overwrite file versioning** (live content keeps its id so every reference stays valid; each save snapshots the old content into a version row pointing at the original), and a `drafts` table (migration 7) keyed by (userId, fileId). Editors gain a `?fileId=` entry path (fetch meta + content), save via the version endpoint, and mirror their existing serialized working state (PDF: annotations JSON; sheets: FortuneSheet JSON) to server drafts for crash/refresh safety.

**Tech Stack:** Express 4 + better-sqlite3, Vitest (server node project + ui jsdom project), Supertest, React 19 + react-router 7 nested routes, Phase 2 ui library, pdf-lib/pdfjs + FortuneSheet (existing editor internals).

**Spec:** `docs/superpowers/specs/2026-06-11-cohesive-app-design.md` (§4.2 project sections, §6 editors-as-components + drafts + versioning, §3.2 files versioning columns). This is sub-plan **3b** of Phase 3 (3a shipped: lifecycle, pipeline, dashboard, bid removal).

**Branch:** all work on `testing` (per project CLAUDE.md — push directly, no PRs).

---

## Context You Must Know Before Starting

1. **Files data model (Phase 1):** `files` table has `id, projectId, name, mime, size, sha256, kind, parentFileId, versionNumber (default 1), legacyFormat, createdAt`; content lives at `data/files/<shard>/<id>` via `server/fileStore.ts`. `server/files.ts` exposes `putBuffer(db, dataDir, id, buf, mime, opts)` with `PutOpts {projectId?, kind?, name?}` — opts carry over from the existing row when omitted. `GET /api/files/:id/content` streams with Range support; auth via Bearer header OR `?token=` (`verifyToken` dep). `POST /api/files/:id` accepts raw binary, currently ignores query params.
2. **Versioning semantics (locked in):** the LIVE content always keeps the original file id (printouts/proposals/shares reference it). `POST /api/files/:id/versions` first copies the current content to a NEW row whose `parentFileId = :id` and `versionNumber =` the old live number, then overwrites `:id` in place and bumps its `versionNumber`. History = rows `WHERE parentFileId = :id`. This matches spec §3.2 ("saves create a new row pointing at the original").
3. **Orphan-cleanup hazard:** `collectReferencedFileIds` in `server/routes.ts` walks project JSON/notes/checklists/shares. Archived version rows are referenced NOWHERE, so without a guard the admin orphan cleanup would delete version history. Task 3 must exclude files whose `parentFileId` is itself a referenced id.
4. **PDF editor internals (src/pages/PdfEditor.tsx):** tabs are `TabSnapshot {id, fileName, pdfBytes: ArrayBuffer, renderedPages, annotations: Annotation[], history, histIdx, source?: PrintoutSource}` (~line 70). `PrintoutSource {projectId, printoutId, fileId}` (~64). `openPdf(file, currentTabId, currentTabs, source?)` (~789) ingests a File. Mount effect (~392-465) consumes `location.state.{file,source}` ONCE and restores IndexedDB tabs first. `savePdf()` (~1165) builds annotated bytes via pdf-lib, then `saveFile(source.fileId, dataUrl)` (an in-place overwrite — Task 9 replaces this with versioning) and BAKES: new bytes become `pdfBytes`, annotations cleared. Annotations are pure JSON — `{annotations}` + a re-fetched base PDF fully reconstructs a session. IndexedDB persistence is `saveStateToIDB()` (~632).
5. **Spreadsheet editor internals (src/pages/SpreadsheetEditor.tsx):** tabs are `FileTab {id, fileName, sheets: FortuneSheet[], source?}`. The FortuneSheet JSON alone reconstructs a tab (no xlsx bytes needed). `scheduleSave()` debounces `saveStateToIDB()` by 1500ms on every change (~209). `handleSave()` (~368) builds xlsx via `fortuneSheetsToXlsxBytes` and overwrites via `saveFile` — Task 10 replaces with versioning.
6. **store.ts file helpers:** `saveFile(id, dataUrl)` = POST /api/images (dataURL); `saveBinaryFile(id, blob)` = POST /api/files/:id raw; `getFile(id)` = GET /api/images/:id → dataURL; `getImageUrl(id)` = public `/api/images/:id/raw`. `formatBytes` is exported. Writes are never auto-retried.
7. **Notes:** `NotesBoard` props are `{projectId, initialNote: ProjectNote | null, onSave: (note) => void}` — already standalone-capable. `getProjectNotes(projectId)` / `saveProjectNotes(projectId, note)` exist in store.ts. The NotesOverlay (canvas use) stays.
8. **Current routes (post-3a):** flat children — `project/:projectId` → ProjectView, `project/:projectId/page/:pageId` → CanvasView. Sidebar PROJECT_NAV maps `?tab=` onto ProjectView; that gets replaced by real section routes in Task 6. `useRegisterProjectShell` is currently called from BOTH ProjectView and CanvasView — Task 6 centralizes it into ProjectLayout (the per-page calls must be removed or section-switching would null the sidebar name).
9. **Where old links land:** after nesting, `/project/:id` index = Overview. Links that mean "open the project" (ProjectsPage cards, Dashboard, ⌘K project results) stay pointing at the index. Links that mean "back to the sheet grid" (CanvasView back-links, NewProject post-create, ⌘K takeoff results) move to `/project/:id/takeoff`. Old `?tab=` bookmarks redirect (Overview checks the param).
10. **3a leftovers folded into this phase:** legacy Submitted/Responded/Accepted toggles in ProjectView (TODO comment ~3273; `handleToggleStatus` ~2962 has no other callers); orphaned `src/pages/ServerSettings.tsx` (no route, no imports); unknown `/api/*` paths currently fall through to the SPA shell as HTML 200 (Task 4 adds a JSON 404 guard).
11. **Testing/infra:** server tests `server/*.test.ts` (node), ui tests jsdom (`globals: true`). `npm test`, `npm run lint` (tsc over everything), boot via `STORAGE_PATH=$(mktemp -d) npm run dev` (kill stale `tsx server.ts` first if port 3000 is busy). Migrations auto-backup; tests use temp dirs only. Line numbers are approximate — anchor by content; NEEDS_CONTEXT over guessing.
12. **req.user** is `{id, username, role}`; routes tests stub `{id: 'u1', role: 'admin'}` and `verifyToken: token === 'good-token'`.

## File Structure

```
server/migrationList.ts          # + migration 7 'drafts'
server/projectStore.ts           # listProjectSummaries(db, id?) gains optional id filter
server/activity.ts               # listActivity(db, limit, projectId?) gains project filter
server/files.ts                  # + saveNewVersion(), listVersions()
server/routes.ts                 # + /api/projects/:id/summary, /api/projects/:id/files,
                                 #   /api/files/:id/meta, /api/files/:id/versions (GET+POST),
                                 #   /api/drafts/:fileId (GET/PUT/DELETE); upload labeling;
                                 #   orphan walk excludes version rows; activity ?projectId=
server.ts                        # + JSON 404 guard for unknown /api/* before the SPA shell
server/*.test.ts                 # new/extended suites per task
src/utils/store.ts               # + ProjectFile/Draft types, getProjectSummary, getProjectFiles,
                                 #   getFileMeta, listFileVersions, uploadProjectFile,
                                 #   saveFileVersion, fetchFileBlob, getDraft/putDraft/deleteDraft;
                                 #   getActivity(limit, projectId?), getMyTimeEntries(projectId?)
src/pages/project/ProjectLayout.tsx     # NEW: outlet frame + shell registration + shared summary
src/pages/project/ProjectOverview.tsx   # NEW: stage-aware home (details/activity/hours/actions)
src/pages/project/ProjectDocuments.tsx  # NEW: files by kind, upload, open-in-editor, versions
src/pages/project/ProjectNotes.tsx      # NEW: NotesBoard as a section page
src/pages/project/ProjectTime.tsx       # NEW: per-project hours + clock in/out
src/pages/ProjectView.tsx        # becomes the /takeoff section; printout-open simplified to
                                 #   ?fileId= navigation; legacy toggles removed; shell-reg removed
src/pages/CanvasView.tsx         # back-links → /takeoff; shell-reg removed
src/pages/PdfEditor.tsx          # ?fileId= entry, save-as-version, draft autosave/restore
src/pages/SpreadsheetEditor.tsx  # same
src/components/shell/Sidebar.tsx # PROJECT_NAV → real section routes (Overview/Takeoff/Documents/Notes/Time)
src/components/shell/Sidebar.test.tsx   # updated project-mode tests
src/components/CommandPalette.tsx# takeoff results → /project/:id/takeoff?tab=takeoffs
src/App.tsx                      # nested project routes
src/pages/ServerSettings.tsx     # DELETED (orphaned)
```

Section vocabulary (sidebar + routes, locked in): **Overview** `/project/:id` · **Takeoff & Estimate** `/project/:id/takeoff` (ProjectView with its internal `?tab=` pages/takeoffs/printouts/email intact — the spec's separate Proposal section waits for the Phase 5 monolith split) · **Documents** `/documents` · **Notes** `/notes` · **Time** `/time` · canvas stays `/project/:id/page/:pageId` (nested under the layout).

---

### Task 1: Server — Single-Project Summary + Per-Project Activity

**Files:**
- Modify: `server/projectStore.ts` (optional id filter)
- Modify: `server/activity.ts` (optional projectId filter)
- Modify: `server/routes.ts` (new route + query param)
- Test: `server/routes.test.ts`, `server/activity.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `server/routes.test.ts`:

```ts
describe('GET /api/projects/:id/summary', () => {
  it('returns the single slim row', async () => {
    await request(app).post('/api/projects').send(PROJECT);
    const res = await request(app).get('/api/projects/p1/summary');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'p1', name: 'Test Project', status: 'estimating', version: 1 });
    expect(res.body.pages).toBeUndefined();
  });

  it('404s for unknown projects', async () => {
    expect((await request(app).get('/api/projects/nope/summary')).status).toBe(404);
  });
});

describe('GET /api/activity?projectId=', () => {
  it('filters the feed to one project', async () => {
    await request(app).post('/api/projects').send(PROJECT);
    await request(app).post('/api/projects').send({ ...PROJECT, id: 'p2', name: 'Other' });
    await request(app).patch('/api/projects/p1').send({ version: 1, status: 'awarded' });
    const res = await request(app).get('/api/activity?projectId=p1');
    expect(res.body.items.length).toBeGreaterThan(0);
    for (const item of res.body.items) expect(item.projectId).toBe('p1');
  });
});
```

Append to `server/activity.test.ts` (inside the existing describe, after the limit test):

```ts
  it('filters by projectId when given', () => {
    logActivity(db, { projectId: 'p1', type: 'a', message: 'one' });
    logActivity(db, { projectId: 'p9', type: 'a', message: 'two' });
    logActivity(db, { type: 'a', message: 'three' });
    const items = listActivity(db, 10, 'p1');
    expect(items).toHaveLength(1);
    expect(items[0].message).toBe('one');
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/routes.test.ts server/activity.test.ts`
Expected: FAIL — summary 404s on the route (no such route → SPA-less test app 404), activity filter not implemented.

- [ ] **Step 3: Implement the filters**

In `server/projectStore.ts`, change `listProjectSummaries`'s signature and SQL:

```ts
export function listProjectSummaries(db: Database.Database, id?: string): any[] {
  const rows = db.prepare(`
    SELECT id, name, status, contractor, address, bidDueDate, version, createdAt, updatedAt,
           COALESCE(json_extract(meta, '$.archived'), 0) AS archived
    FROM projects ${id ? 'WHERE id = ?' : ''} ORDER BY createdAt DESC
  `).all(...(id ? [id] : [])) as any[];
```

(the rest of the function body is unchanged — counts/pageIds maps still scan globally, which is fine for a single-id call at this scale).

In `server/activity.ts`, change `listActivity`:

```ts
export function listActivity(db: Database.Database, limit = 30, projectId?: string): any[] {
  const capped = Math.max(1, Math.min(100, Math.floor(limit) || 30));
  return db.prepare(`
    SELECT a.id, a.projectId, a.userId, a.type, a.message, a.createdAt,
           p.name AS projectName, u.username AS username
    FROM activity a
    LEFT JOIN projects p ON p.id = a.projectId
    LEFT JOIN users u ON u.id = a.userId
    ${projectId ? 'WHERE a.projectId = ?' : ''}
    ORDER BY a.createdAt DESC, a.rowid DESC
    LIMIT ?
  `).all(...(projectId ? [projectId, capped] : [capped]));
}
```

- [ ] **Step 4: Add the route + query param in `server/routes.ts`**

Directly after the existing `GET /api/projects/summary` route (still before `GET /api/projects/:id`):

```ts
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
```

(Route-order note: `/api/projects/:id/summary` has more segments than `/api/projects/:id`, so Express disambiguates regardless of order — but keep it adjacent to the list-summary route for readability.)

In the existing `GET /api/activity` handler, pass the filter:

```ts
      const projectId = typeof req.query.projectId === 'string' && req.query.projectId ? req.query.projectId : undefined;
      res.json({ items: listActivity(db, Number(req.query.limit) || 30, projectId) });
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run server/routes.test.ts server/activity.test.ts && npm run lint`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add server/projectStore.ts server/activity.ts server/routes.ts server/routes.test.ts server/activity.test.ts
git commit -m "feat: single-project summary endpoint and per-project activity filter"
```

---

### Task 2: Server — Project Files Listing, File Meta, Labeled Uploads

**Files:**
- Modify: `server/routes.ts`
- Test: `server/routes.test.ts` (append)

- [ ] **Step 1: Write the failing tests** (append to `server/routes.test.ts`)

```ts
describe('project files', () => {
  beforeEach(async () => {
    await request(app).post('/api/projects').send(PROJECT);
  });

  it('POST /api/files/:id labels uploads via query params', async () => {
    const res = await request(app)
      .post('/api/files/doc1?projectId=p1&kind=document&name=Contract.pdf')
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('pdfbytes'));
    expect(res.status).toBe(200);
    const meta = await request(app).get('/api/files/doc1/meta');
    expect(meta.status).toBe(200);
    expect(meta.body).toMatchObject({
      id: 'doc1', projectId: 'p1', kind: 'document', name: 'Contract.pdf',
      mime: 'application/pdf', versionNumber: 1, parentFileId: null,
    });
  });

  it('GET /api/projects/:id/files lists live files newest-first, no version rows', async () => {
    await request(app).post('/api/files/doc1?projectId=p1&kind=document&name=A.pdf')
      .set('Content-Type', 'application/pdf').send(Buffer.from('a'));
    await request(app).post('/api/files/doc2?projectId=p1&kind=spreadsheet&name=B.xlsx')
      .set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .send(Buffer.from('b'));
    const res = await request(app).get('/api/projects/p1/files');
    expect(res.status).toBe(200);
    expect(res.body.map((f: any) => f.id).sort()).toEqual(['doc1', 'doc2']);
    expect(res.body[0].sha256).toBeUndefined(); // slim listing
  });

  it('GET /api/files/:id/meta 404s for unknown files', async () => {
    expect((await request(app).get('/api/files/nope/meta')).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/routes.test.ts`
Expected: FAIL — meta route missing; labels not applied.

- [ ] **Step 3: Implement in `server/routes.ts`**

1. In the existing `POST /api/files/:id` handler, replace the bare `putBuffer(db, dataDir, req.params.id, body, mime);` with:

```ts
        // Optional labeling so project-context uploads land attributed
        // (Phase 1 left projectId NULL on this legacy-compat endpoint).
        const q = req.query;
        putBuffer(db, dataDir, req.params.id, body, mime, {
          projectId: typeof q.projectId === 'string' && q.projectId ? q.projectId : undefined,
          kind: typeof q.kind === 'string' && q.kind ? q.kind : undefined,
          name: typeof q.name === 'string' && q.name ? q.name : undefined,
        });
```

2. Add the two read routes (place them near the existing files routes; `/api/files/:id/meta` and `/api/files/:id/content` don't conflict — different literal segments):

```ts
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run server/routes.test.ts && npm run lint`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add server/routes.ts server/routes.test.ts
git commit -m "feat: project file listing, file metadata endpoint, labeled uploads"
```

---

### Task 3: Server — File Versioning (Archive-Then-Overwrite)

**Files:**
- Modify: `server/files.ts` (saveNewVersion, listVersions)
- Modify: `server/routes.ts` (POST/GET versions; orphan-walk guard)
- Test: `server/files.test.ts`, `server/routes.test.ts` (append)

- [ ] **Step 1: Write the failing unit tests** (append to `server/files.test.ts`)

```ts
import { saveNewVersion, listVersions } from './files';

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
});
```

(`db`/`dir` come from the file's existing `beforeEach`; add the needed imports to the top if missing.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/files.test.ts`
Expected: FAIL — `saveNewVersion` not exported.

- [ ] **Step 3: Implement in `server/files.ts`** (append; add `import crypto from 'crypto';` to the top)

```ts
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
```

- [ ] **Step 4: Add the routes + orphan guard in `server/routes.ts`**

1. Import `saveNewVersion, listVersions` from `./files`.
2. Add, adjacent to `POST /api/files/:id`:

```ts
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
        if (!getMeta(db, req.params.id)) return res.status(404).json({ error: 'File not found' });
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
```

3. **Orphan guard:** in BOTH `GET /api/storage/orphans` and `POST /api/storage/orphans/cleanup`, the per-row orphan test is currently `!referenced.has(r.id)`. The rows query must also select `parentFileId`, and the test becomes:

```ts
      const rows = db.prepare('SELECT id, size, parentFileId FROM files').all() as
        { id: string; size: number; parentFileId: string | null }[];
      // Version-history rows are referenced via their parent: keep them as
      // long as the live file is referenced.
      const isOrphan = (r: { id: string; parentFileId: string | null }) =>
        !referenced.has(r.id) && !(r.parentFileId && referenced.has(r.parentFileId));
```

Use `isOrphan(r)` in place of the previous check in both handlers (define the helper once above them).

- [ ] **Step 5: Integration tests** (append to `server/routes.test.ts`)

```ts
describe('file versions over HTTP', () => {
  beforeEach(async () => {
    await request(app).post('/api/files/f1?projectId=p1&kind=printout&name=Bid.pdf')
      .set('Content-Type', 'application/pdf').send(Buffer.from('v1'));
  });

  it('POST /versions archives and bumps; content endpoint serves the new bytes', async () => {
    const res = await request(app).post('/api/files/f1/versions')
      .set('Content-Type', 'application/pdf').send(Buffer.from('v2'));
    expect(res.status).toBe(200);
    expect(res.body.versionNumber).toBe(2);
    const content = await request(app).get('/api/files/f1/content?token=good-token');
    expect(content.body.toString()).toBe('v2');
    const versions = await request(app).get('/api/files/f1/versions');
    expect(versions.body).toHaveLength(2);
    expect(versions.body[1].versionNumber).toBe(1);
  });

  it('404s when versioning an unknown file', async () => {
    expect((await request(app).post('/api/files/nope/versions')
      .set('Content-Type', 'application/pdf').send(Buffer.from('x'))).status).toBe(404);
  });

  it('orphan cleanup spares version history of referenced files', async () => {
    // reference f1 from a project printout
    await request(app).post('/api/projects').send({
      ...PROJECT, printouts: [{ id: 'po1', name: 'Bid set', fileId: 'f1', createdAt: 1 }],
    });
    await request(app).post('/api/files/f1/versions')
      .set('Content-Type', 'application/pdf').send(Buffer.from('v2'));
    const cleanup = await request(app).post('/api/storage/orphans/cleanup');
    expect(cleanup.status).toBe(200);
    const versions = await request(app).get('/api/files/f1/versions');
    expect(versions.body).toHaveLength(2); // history survived
  });
});
```

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run server/files.test.ts server/routes.test.ts && npm run lint`
Expected: PASS, clean.

- [ ] **Step 7: Commit**

```bash
git add server/files.ts server/files.test.ts server/routes.ts server/routes.test.ts
git commit -m "feat: archive-then-overwrite file versioning with orphan-safe history"
```

---

### Task 4: Server — Drafts (Migration 7) + API 404 Guard

**Files:**
- Modify: `server/migrationList.ts` (migration 7)
- Modify: `server/routes.ts` (draft routes)
- Modify: `server.ts` (API 404 guard)
- Test: `server/migrationList.test.ts`, `server/routes.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `server/migrationList.test.ts`:

```ts
describe('migration 7: drafts', () => {
  it('creates the drafts table keyed by user+file', () => {
    const db = openDb(':memory:');
    runMigrations(db, tmpDir(), migrations);
    expect(tableNames(db)).toContain('drafts');
    db.prepare(`INSERT INTO drafts (userId, fileId, kind, data, updatedAt) VALUES ('u1','f1','pdf','{}',1)`).run();
    // same key replaces, different user coexists
    db.prepare(`INSERT OR REPLACE INTO drafts (userId, fileId, kind, data, updatedAt) VALUES ('u1','f1','pdf','{"a":1}',2)`).run();
    db.prepare(`INSERT INTO drafts (userId, fileId, kind, data, updatedAt) VALUES ('u2','f1','pdf','{}',1)`).run();
    expect((db.prepare('SELECT COUNT(*) AS c FROM drafts').get() as any).c).toBe(2);
    db.close();
  });
});
```

Append to `server/routes.test.ts`:

```ts
describe('drafts', () => {
  it('PUT/GET/DELETE round-trip scoped to the user', async () => {
    const put = await request(app).put('/api/drafts/f1')
      .send({ kind: 'pdf', data: JSON.stringify({ annotations: [] }) });
    expect(put.status).toBe(200);
    const get = await request(app).get('/api/drafts/f1');
    expect(get.status).toBe(200);
    expect(get.body.kind).toBe('pdf');
    expect(JSON.parse(get.body.data)).toEqual({ annotations: [] });
    expect(typeof get.body.updatedAt).toBe('number');
    await request(app).delete('/api/drafts/f1').expect(200);
    expect((await request(app).get('/api/drafts/f1')).status).toBe(404);
  });

  it('rejects invalid payloads', async () => {
    expect((await request(app).put('/api/drafts/f1').send({ kind: 'pdf' })).status).toBe(400);
    expect((await request(app).put('/api/drafts/f1').send({ kind: 'nope', data: '{}' })).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/migrationList.test.ts server/routes.test.ts`
Expected: FAIL — no drafts table / routes.

- [ ] **Step 3: Append migration 7 to `server/migrationList.ts`**

```ts
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
```

- [ ] **Step 4: Add draft routes to `server/routes.ts`** (anywhere after the files routes)

```ts
  // ── Editor drafts (per user, per file) ────────────────────────────────────

  const DRAFT_KINDS = ['pdf', 'sheet'];
  const MAX_DRAFT_BYTES = 20 * 1024 * 1024; // generous cap for big workbooks

  app.get('/api/drafts/:fileId', authenticateToken, (req, res) => {
    try {
      const row = db.prepare('SELECT kind, data, updatedAt FROM drafts WHERE userId = ? AND fileId = ?')
        .get((req as any).user?.id, req.params.fileId);
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
        .run((req as any).user?.id, req.params.fileId, kind, data, Date.now());
      res.json({ success: true });
    } catch (e) {
      console.error('Error saving draft:', e);
      res.status(500).json({ error: 'Failed to save draft' });
    }
  });

  app.delete('/api/drafts/:fileId', authenticateToken, (req, res) => {
    try {
      db.prepare('DELETE FROM drafts WHERE userId = ? AND fileId = ?')
        .run((req as any).user?.id, req.params.fileId);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to delete draft' });
    }
  });
```

NOTE: the JSON body for PUT can exceed Express's default limit for huge workbooks — confirm the app-level `express.json({ limit: '50mb' })` (set in server.ts) covers it; if the routes test app uses a smaller limit, mirror server.ts.

- [ ] **Step 5: Add the API 404 guard in `server.ts`**

Locate where the Vite middleware / static serving is mounted in `startServer()` (anchor: `vite.middlewares` or `express.static`). Immediately BEFORE that block, add:

```ts
  // Unknown API routes must 404 as JSON — without this they fall through to
  // the SPA shell and return index.html with HTTP 200.
  app.all('/api/*', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
```

(All real API routes — server.ts's own and registerDataRoutes' — are registered before this point; verify by reading the startup order. Socket.io and `/share/:id` page serving are unaffected.)

- [ ] **Step 6: Run to verify pass + boot**

Run: `npx vitest run server/migrationList.test.ts server/routes.test.ts && npm test && npm run lint`
Expected: all green. Boot check: `pkill -f "tsx server.ts" 2>/dev/null; STORAGE_PATH=$(mktemp -d) timeout 25 npm run dev 2>&1 | head -25` — migration 7 applies; then while it's briefly up, `curl -s -o /dev/null -w "%{http_code}" localhost:3000/api/definitely-not-real` would be 404 (optional spot-check — the timeout window makes this fiddly; the guard is also exercised implicitly in Task 13's smoke).

- [ ] **Step 7: Commit**

```bash
git add server/migrationList.ts server/migrationList.test.ts server/routes.ts server/routes.test.ts server.ts
git commit -m "feat: editor drafts table and endpoints; JSON 404 for unknown API routes"
```

---

### Task 5: Client Store — Files, Versions, Drafts, Summary Helpers

**Files:**
- Modify: `src/utils/store.ts` (append + two signature extensions)

No unit tests (thin fetch wrappers, consistent with the file's pattern); lint + consumers verify.

- [ ] **Step 1: Extend two existing functions**

1. `getActivity` gains a project filter:

```ts
export const getActivity = async (limit = 20, projectId?: string): Promise<ActivityItem[]> => {
  const qs = `limit=${limit}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`;
  const res = await fetchWithRetry(`/api/activity?${qs}`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res);
  return (await res.json()).items;
};
```

2. `getMyTimeEntries` gains one too (the server route already supports `?projectId=`):

```ts
export const getMyTimeEntries = async (projectId?: string): Promise<TimeEntryLite[]> => {
  const url = projectId ? `/api/time-entries?projectId=${encodeURIComponent(projectId)}` : '/api/time-entries';
  const res = await fetchWithRetry(url, { headers: { ...getAuthHeaders() } });
  await handleResponse(res);
  return await res.json();
};
```

(Both are backward-compatible — audit existing call sites compile unchanged.)

- [ ] **Step 2: Append the new helpers**

```ts
// ── Phase 3b: project files, versions, drafts ────────────────────────────────

export interface ProjectFile {
  id: string;
  projectId: string | null;
  name: string | null;
  mime: string;
  size: number;
  kind: string;
  parentFileId: string | null;
  versionNumber: number;
  createdAt: number;
}

export interface EditorDraft {
  kind: 'pdf' | 'sheet';
  data: string;
  updatedAt: number;
}

export const getProjectSummary = async (id: string): Promise<ProjectSummary | null> => {
  const res = await fetchWithRetry(`/api/projects/${encodeURIComponent(id)}/summary`, {
    headers: { ...getAuthHeaders() },
  });
  if (res.status === 404) return null;
  await handleResponse(res);
  return await res.json();
};

export const getProjectFiles = async (projectId: string): Promise<ProjectFile[]> => {
  const res = await fetchWithRetry(`/api/projects/${encodeURIComponent(projectId)}/files`, {
    headers: { ...getAuthHeaders() },
  });
  await handleResponse(res);
  return await res.json();
};

export const getFileMeta = async (id: string): Promise<ProjectFile | null> => {
  const res = await fetchWithRetry(`/api/files/${encodeURIComponent(id)}/meta`, {
    headers: { ...getAuthHeaders() },
  });
  if (res.status === 404) return null;
  await handleResponse(res);
  return await res.json();
};

export const listFileVersions = async (id: string): Promise<ProjectFile[]> => {
  const res = await fetchWithRetry(`/api/files/${encodeURIComponent(id)}/versions`, {
    headers: { ...getAuthHeaders() },
  });
  await handleResponse(res);
  return await res.json();
};

// Upload a new project document. Returns the generated file id.
export const uploadProjectFile = async (
  projectId: string,
  file: File,
  kind: string
): Promise<string> => {
  const id = crypto.randomUUID();
  const qs = `projectId=${encodeURIComponent(projectId)}&kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(file.name)}`;
  const res = await fetchWithRetry(`/api/files/${id}?${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream', ...getAuthHeaders() },
    body: file,
  }, { timeoutMs: 300_000 });
  await handleResponse(res);
  return id;
};

// Save-as-version: live content keeps its id; old bytes become history.
export const saveFileVersion = async (id: string, blob: Blob): Promise<{ versionNumber: number }> => {
  const res = await fetchWithRetry(`/api/files/${encodeURIComponent(id)}/versions`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream', ...getAuthHeaders() },
    body: blob,
  }, { timeoutMs: 300_000 });
  await handleResponse(res);
  return await res.json();
};

// Authenticated binary fetch of a file's live content.
export const fetchFileBlob = async (id: string): Promise<Blob> => {
  const res = await fetchWithRetry(`/api/files/${encodeURIComponent(id)}/content`, {
    headers: { ...getAuthHeaders() },
  }, { timeoutMs: 300_000 });
  await handleResponse(res);
  return await res.blob();
};

export const getDraft = async (fileId: string): Promise<EditorDraft | null> => {
  const res = await fetchWithRetry(`/api/drafts/${encodeURIComponent(fileId)}`, {
    headers: { ...getAuthHeaders() },
  });
  if (res.status === 404) return null;
  await handleResponse(res);
  return await res.json();
};

export const putDraft = async (fileId: string, kind: 'pdf' | 'sheet', data: string): Promise<void> => {
  const res = await fetchWithRetry(`/api/drafts/${encodeURIComponent(fileId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ kind, data }),
  });
  await handleResponse(res);
};

export const deleteDraft = async (fileId: string): Promise<void> => {
  const res = await fetchWithRetry(`/api/drafts/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: { ...getAuthHeaders() },
  });
  await handleResponse(res);
};
```

(Check `fetchWithRetry`'s options signature in this file — it takes `(url, init, opts?)` with `{timeoutMs, retries}`; match it exactly. `crypto.randomUUID()` is available in all target browsers; the codebase also has `uuid` if preferred — use `crypto.randomUUID()`.)

- [ ] **Step 3: Verify and commit**

Run: `npm run lint && npm test`
Expected: clean / green.

```bash
git add src/utils/store.ts
git commit -m "feat: client store — project files, versions, drafts, single summary"
```

---

### Task 6: ProjectLayout, Nested Routes & Section Sidebar

**Files:**
- Create: `src/pages/project/ProjectLayout.tsx`
- Create: `src/pages/project/ProjectOverview.tsx` (PLACEHOLDER-FREE STUB — Task 7 fills it; this task ships a minimal working Overview so the app never breaks)
- Modify: `src/App.tsx` (nested routes)
- Modify: `src/components/shell/Sidebar.tsx` (PROJECT_NAV → section routes)
- Modify: `src/components/shell/Sidebar.test.tsx`
- Modify: `src/pages/ProjectView.tsx`, `src/pages/CanvasView.tsx` (remove shell registration; back-link targets)
- Modify: `src/pages/NewProject.tsx`, `src/components/CommandPalette.tsx` (takeoff targets)

- [ ] **Step 1: Create the layout**

```tsx
// src/pages/project/ProjectLayout.tsx
import React, { useEffect, useState } from 'react';
import { Outlet, useOutletContext, useParams } from 'react-router-dom';
import { ProjectSummary, getProjectSummary } from '../../utils/store';
import { useRegisterProjectShell } from '../../context/ProjectShellContext';

export interface ProjectOutletCtx {
  summary: ProjectSummary | null;
  refreshSummary: () => void;
}

// Convenience for section pages.
export const useProjectOutlet = () => useOutletContext<ProjectOutletCtx>();

// Thin frame for all project sections: registers the sidebar context once and
// shares a lightweight summary via outlet context. Sections that need full
// project data (ProjectView, CanvasView) keep loading it themselves.
export const ProjectLayout: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const [summary, setSummary] = useState<ProjectSummary | null>(null);

  const refreshSummary = () => {
    if (!projectId) return;
    getProjectSummary(projectId).then(setSummary).catch(() => {});
  };

  useEffect(() => {
    setSummary(null);
    refreshSummary();
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Register only once the name is known — the sidebar shows 'Project' until then.
  useRegisterProjectShell(summary?.id, summary?.name);

  return <Outlet context={{ summary, refreshSummary } satisfies ProjectOutletCtx} />;
};
```

- [ ] **Step 2: Create the minimal Overview** (complete and working; Task 7 replaces the body)

```tsx
// src/pages/project/ProjectOverview.tsx
import React from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { useProjectOutlet } from './ProjectLayout';
import { Skeleton } from '../../components/ui';

export const ProjectOverview: React.FC = () => {
  const [searchParams] = useSearchParams();
  const { summary } = useProjectOutlet();

  // Pre-3b bookmarks looked like /project/:id?tab=takeoffs — forward them to
  // the takeoff section, which still owns those tabs.
  const legacyTab = searchParams.get('tab');
  if (legacyTab) return <Navigate to={`takeoff?tab=${encodeURIComponent(legacyTab)}`} replace />;

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8">
      {summary ? (
        <h1 className="text-xl font-bold text-ink">{summary.name}</h1>
      ) : (
        <Skeleton className="h-7 w-64" />
      )}
    </div>
  );
};
```

- [ ] **Step 3: Restructure the routes in `src/App.tsx`**

Add imports for `ProjectLayout` and `ProjectOverview`. Replace the two flat project routes:

```tsx
        {
          path: 'project/:projectId',
          element: <ProjectView />,
        },
        {
          path: 'project/:projectId/page/:pageId',
          element: <CanvasView />,
        },
```

with the nested tree:

```tsx
        {
          path: 'project/:projectId',
          element: <ProjectLayout />,
          children: [
            { index: true, element: <ProjectOverview /> },
            { path: 'takeoff', element: <ProjectView /> },
            { path: 'documents', element: <ProjectDocuments /> },
            { path: 'notes', element: <ProjectNotes /> },
            { path: 'time', element: <ProjectTime /> },
            { path: 'page/:pageId', element: <CanvasView /> },
          ],
        },
```

Tasks 8 and 11 create `ProjectDocuments`, `ProjectNotes`, `ProjectTime`. To keep THIS task compiling, create three one-line stub pages now (each fully working, replaced later):

```tsx
// src/pages/project/ProjectDocuments.tsx  (Task 8 replaces the body)
import React from 'react';
export const ProjectDocuments: React.FC = () => (
  <div className="mx-auto max-w-5xl px-4 py-6 md:px-8 text-sm text-ink-faint">Documents — coming in this phase.</div>
);
```

```tsx
// src/pages/project/ProjectNotes.tsx  (Task 11 replaces the body)
import React from 'react';
export const ProjectNotes: React.FC = () => (
  <div className="mx-auto max-w-5xl px-4 py-6 md:px-8 text-sm text-ink-faint">Notes — coming in this phase.</div>
);
```

```tsx
// src/pages/project/ProjectTime.tsx  (Task 11 replaces the body)
import React from 'react';
export const ProjectTime: React.FC = () => (
  <div className="mx-auto max-w-5xl px-4 py-6 md:px-8 text-sm text-ink-faint">Time — coming in this phase.</div>
);
```

Import all three in App.tsx.

- [ ] **Step 4: Centralize shell registration**

Remove the `useRegisterProjectShell` import AND its call from BOTH `src/pages/ProjectView.tsx` and `src/pages/CanvasView.tsx` (one import + one hook line each — added in Phase 2 Task 10; the layout now owns registration, and the per-page cleanup-on-unmount would null the sidebar name on every section switch).

- [ ] **Step 5: Rewrite the Sidebar's project nav** (`src/components/shell/Sidebar.tsx`)

1. Lucide import: ensure `LayoutGrid, Ruler, FolderOpen, StickyNote, Clock` present; REMOVE `Printer, Mail` (now unused — verify with grep before removing).
2. Remove the `useNotes` import and the `const { openNotes } = useNotes();` line (Notes is a route now). Also remove the now-unused `activeTab`/`onProjectRoot` derivations.
3. Replace `PROJECT_NAV` with:

```tsx
// Project sections (spec §4.2), Phase 3b edition: real nested routes.
// 'Takeoff & Estimate' keeps its internal ?tab= sub-tabs; Punch/Issues/Billing
// arrive in Phase 4; Project Settings in Phase 5.
const PROJECT_NAV: {
  id: string;
  label: string;
  Icon: NavEntry['Icon'];
  path: string;
  match: (pathname: string, base: string) => boolean;
}[] = [
  { id: 'overview',  label: 'Overview',           Icon: LayoutGrid, path: '',           match: (p, b) => p === b },
  { id: 'takeoff',   label: 'Takeoff & Estimate', Icon: Ruler,      path: '/takeoff',   match: (p, b) => p.startsWith(`${b}/takeoff`) || p.startsWith(`${b}/page/`) },
  { id: 'documents', label: 'Documents',          Icon: FolderOpen, path: '/documents', match: (p, b) => p.startsWith(`${b}/documents`) },
  { id: 'notes',     label: 'Notes',              Icon: StickyNote, path: '/notes',     match: (p, b) => p.startsWith(`${b}/notes`) },
  { id: 'time',      label: 'Time',               Icon: Clock,      path: '/time',      match: (p, b) => p.startsWith(`${b}/time`) },
];
```

4. Replace the project-mode nav rows block (the `PROJECT_NAV.map(...)` plus the separate Notes NavRow) with:

```tsx
            <div className="space-y-0.5">
              {PROJECT_NAV.map(item => {
                const base = `/project/${projectId}`;
                return (
                  <NavRow
                    key={item.id}
                    label={item.label}
                    Icon={item.Icon}
                    expanded={expanded}
                    active={item.match(location.pathname, base)}
                    onClick={() => navigate(`${base}${item.path}`)}
                  />
                );
              })}
            </div>
```

(`FolderOpen` may collide with a different icon previously imported under that name in this file — it doesn't today; verify.)

- [ ] **Step 6: Update Sidebar tests** (`src/components/shell/Sidebar.test.tsx`)

In the project-mode describe block:
1. "swaps to project nav" test: replace the label list with `['Overview', 'Takeoff & Estimate', 'Documents', 'Notes', 'Time']`.
2. Replace the `?tab=` highlight test with route-based ones:

```tsx
  it('highlights the section matching the route', () => {
    renderProject('/project/p1/documents');
    expect(screen.getByRole('button', { name: /Documents/ }).className).toContain('glow-accent');
    expect(screen.getByRole('button', { name: /Overview/ }).className).not.toContain('glow-accent');
  });

  it('highlights Overview at the project root and Takeoff on canvas routes', () => {
    renderProject('/project/p1');
    expect(screen.getByRole('button', { name: /Overview/ }).className).toContain('glow-accent');
  });
```

3. The existing canvas-rail test asserts `All Projects` at `/project/p1/page/pg1` — keep; optionally add inside it: `expect(screen.getByTitle('Takeoff & Estimate')).toBeInTheDocument();` (collapsed rows expose labels via title).
4. The NotesProvider wrappers in the helpers may now be unnecessary (Sidebar no longer calls useNotes) — leave them; they're harmless.

- [ ] **Step 7: Update navigation targets that mean "back to the sheet grid"**

| File | Old | New |
|---|---|---|
| `src/pages/CanvasView.tsx` (~659) | ``navigate(`/project/${pId}`)`` | ``navigate(`/project/${pId}/takeoff`)`` |
| `src/pages/CanvasView.tsx` (~1253) | ``<Link to={`/project/${project.id}`}`` | ``<Link to={`/project/${project.id}/takeoff`}`` |
| `src/pages/CanvasView.tsx` (~1858) | ``to={`/project/${project.id}${searchTerm ? `?search=...` : ''}`}`` | ``to={`/project/${project.id}/takeoff${searchTerm ? `?search=...` : ''}`}`` (keep the search-param expression intact) |
| `src/pages/NewProject.tsx` (~604) | ``navigate(`/project/${projectId}`)`` | ``navigate(`/project/${projectId}/takeoff`)`` |
| `src/components/CommandPalette.tsx` (~129) | ``case 'takeoff': navigate(`/project/${item.projectId}`, { state: { activeTab: 'takeoffs' } });`` | ``case 'takeoff': navigate(`/project/${item.projectId}/takeoff?tab=takeoffs`);`` |

Leave pointing at the project root (Overview, intended): ProjectsPage card open, Dashboard links, CommandPalette `case 'project'`, Sidebar handled above. ProjectView-internal canvas links (`/project/:id/page/:id`) are unchanged and still valid under the nested tree.

- [ ] **Step 8: Verify**

Run: `npx vitest run src/components/shell && npm run lint && npm test`
Expected: shell tests green with the new assertions; everything else green.

Boot check: `pkill -f "tsx server.ts" 2>/dev/null; STORAGE_PATH=$(mktemp -d) timeout 25 npm run dev 2>&1 | head -25` — clean. Then in a browser (or note for Task 13): opening a project lands on Overview (name renders); sidebar shows the five sections; Takeoff & Estimate is the old ProjectView with its tabs; old `?tab=takeoffs` URL redirects into the takeoff section; canvas pages still open and highlight Takeoff & Estimate; sidebar name appears once the summary loads.

- [ ] **Step 9: Commit**

```bash
git add src/pages/project src/App.tsx src/components/shell src/pages/ProjectView.tsx src/pages/CanvasView.tsx src/pages/NewProject.tsx src/components/CommandPalette.tsx
git commit -m "feat: nested project sections — layout, routes, section sidebar"
```

---

### Task 7: Overview Section

**Files:**
- Modify: `src/pages/project/ProjectOverview.tsx` (replace the Task 6 stub body)

- [ ] **Step 1: Implement the full Overview**

Replace the entire file with:

```tsx
// src/pages/project/ProjectOverview.tsx
import React, { useEffect, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import {
  Activity as ActivityIcon, Building2, Calendar, Clock, FileText,
  FolderOpen, MapPin, Ruler, Upload,
} from 'lucide-react';
import { useProjectOutlet } from './ProjectLayout';
import {
  ActivityItem, TimeEntryLite, getActivity, getMyTimeEntries, clockIn,
} from '../../utils/store';
import { ProjectStageControl } from '../../components/ProjectStageControl';
import { useToast } from '../../components/Toast';
import {
  Button, Card, CardBody, CardHeader, EmptyState, Skeleton,
} from '../../components/ui';
import { timeAgo, hoursThisWeek } from '../Dashboard';

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString();

export const ProjectOverview: React.FC = () => {
  const [searchParams] = useSearchParams();
  const { summary, refreshSummary } = useProjectOutlet();
  const { toast } = useToast();
  const [activity, setActivity] = useState<ActivityItem[] | null>(null);
  const [entries, setEntries] = useState<TimeEntryLite[] | null>(null);

  const projectId = summary?.id;
  useEffect(() => {
    if (!projectId) return;
    getActivity(8, projectId).then(setActivity).catch(() => setActivity([]));
    getMyTimeEntries(projectId).then(setEntries).catch(() => setEntries([]));
  }, [projectId]);

  // Pre-3b bookmarks looked like /project/:id?tab=takeoffs — forward them.
  const legacyTab = searchParams.get('tab');
  if (legacyTab) return <Navigate to={`takeoff?tab=${encodeURIComponent(legacyTab)}`} replace />;

  const totalHours = entries
    ? entries.reduce((ms, e) => ms + ((e.clockOut ?? Date.now()) - e.clockIn), 0) / 3_600_000
    : null;
  const weekHours = entries ? hoursThisWeek(entries) : null;

  const handleClockIn = async () => {
    if (!projectId) return;
    try {
      await clockIn(projectId);
      toast('Clocked in to this project', { type: 'success' });
      getMyTimeEntries(projectId).then(setEntries).catch(() => {});
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Clock-in failed', { type: 'error' });
    }
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8">
      {/* Header: name + stage */}
      <div className="mb-5">
        {summary ? (
          <>
            <h1 className="text-xl font-bold text-ink">{summary.name}</h1>
            <div className="mt-2">
              <ProjectStageControl
                projectId={summary.id}
                version={summary.version}
                status={summary.status}
                onChanged={() => refreshSummary()}
              />
            </div>
          </>
        ) : (
          <Skeleton className="h-7 w-64" />
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Details */}
        <Card>
          <CardHeader title="Details" />
          <CardBody>
            {!summary ? (
              <div className="space-y-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-5" />)}</div>
            ) : (
              <dl className="space-y-2 text-sm">
                {summary.contractor && (
                  <div className="flex items-center gap-2 text-ink"><Building2 size={14} className="text-ink-faint" />{summary.contractor}</div>
                )}
                {summary.address && (
                  <div className="flex items-center gap-2 text-ink"><MapPin size={14} className="text-ink-faint" />{summary.address}</div>
                )}
                {summary.bidDueDate !== null && (
                  <div className="flex items-center gap-2 text-ink">
                    <Calendar size={14} className="text-ink-faint" />
                    Bid due {fmtDate(summary.bidDueDate)}
                  </div>
                )}
                <div className="flex items-center gap-4 pt-1 text-ink-soft">
                  <span className="flex items-center gap-1.5"><FileText size={14} className="text-ink-faint" />{summary.pageCount} pages</span>
                  <span className="flex items-center gap-1.5"><Ruler size={14} className="text-ink-faint" />{summary.takeoffCount} takeoffs</span>
                </div>
              </dl>
            )}
          </CardBody>
        </Card>

        {/* Next actions (spec §4.2: stage-aware home with next actions) */}
        <Card>
          <CardHeader title="Actions" />
          <CardBody className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={handleClockIn}>
              <Clock size={15} />Clock in to this project
            </Button>
            <Link to="takeoff"><Button variant="secondary"><Ruler size={15} />Open takeoff</Button></Link>
            <Link to="documents"><Button variant="secondary"><FolderOpen size={15} />Documents</Button></Link>
            <Link to="documents"><Button variant="secondary"><Upload size={15} />Upload a file</Button></Link>
          </CardBody>
        </Card>

        {/* Project activity */}
        <Card>
          <CardHeader title="Activity" actions={<ActivityIcon size={15} className="text-ink-faint" />} />
          <CardBody className="p-0">
            {activity === null ? (
              <div className="space-y-2 p-4">{[0, 1, 2].map(i => <Skeleton key={i} className="h-8" />)}</div>
            ) : activity.length === 0 ? (
              <EmptyState title="No activity yet" description="Events on this project show up here." />
            ) : (
              <ul className="divide-y divide-edge">
                {activity.map(a => (
                  <li key={a.id} className="px-4 py-2.5">
                    <p className="text-sm text-ink">{a.message}</p>
                    <p className="text-xs text-ink-faint">{a.username ? `${a.username} · ` : ''}{timeAgo(a.createdAt)}</p>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        {/* My hours on this project */}
        <Card>
          <CardHeader
            title="My hours on this project"
            actions={<Link to="time" className="text-xs font-medium text-accent-600 hover:underline">Project time</Link>}
          />
          <CardBody>
            {totalHours === null ? (
              <Skeleton className="h-12 w-28" />
            ) : (
              <div className="flex items-baseline gap-2">
                <Clock size={20} className="self-center text-ink-faint" />
                <span className="text-3xl font-bold text-ink">{totalHours.toFixed(1)}</span>
                <span className="text-sm text-ink-soft">hours total · {weekHours!.toFixed(1)} this week</span>
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
};
```

- [ ] **Step 2: Verify**

Run: `npm run lint && npm test`
Expected: clean / green (Dashboard's exported `timeAgo`/`hoursThisWeek` are reused — they're already unit-tested).

Boot check: open a project → Overview shows name, working stage dropdown (changes reflect after refreshSummary), details, actions (clock-in toasts and the entry appears under /time), per-project activity (stage change just made should appear), hours card.

- [ ] **Step 3: Commit**

```bash
git add src/pages/project/ProjectOverview.tsx
git commit -m "feat: project overview — stage, details, actions, activity, hours"
```

---

### Task 8: Documents Section

**Files:**
- Modify: `src/pages/project/ProjectDocuments.tsx` (replace the Task 6 stub)
- Test: `src/pages/project/ProjectDocuments.test.tsx` (helpers)

- [ ] **Step 1: Write the failing helper tests**

```tsx
// src/pages/project/ProjectDocuments.test.tsx
import { describe, it, expect } from 'vitest';
import { kindFromMime, openTargetFor } from './ProjectDocuments';

describe('kindFromMime', () => {
  it('classifies uploads', () => {
    expect(kindFromMime('application/pdf')).toBe('document');
    expect(kindFromMime('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('spreadsheet');
    expect(kindFromMime('application/vnd.ms-excel')).toBe('spreadsheet');
    expect(kindFromMime('image/png')).toBe('photo');
    expect(kindFromMime('text/plain')).toBe('other');
  });
});

describe('openTargetFor', () => {
  it('routes pdfs and sheets to their editors, images to raw view', () => {
    expect(openTargetFor({ mime: 'application/pdf', id: 'a' } as any)).toEqual({ type: 'pdf', url: '/tools/pdf?fileId=a' });
    expect(openTargetFor({ mime: 'application/vnd.ms-excel', id: 'b' } as any)).toEqual({ type: 'sheet', url: '/tools/sheets?fileId=b' });
    expect(openTargetFor({ mime: 'image/jpeg', id: 'c' } as any)).toEqual({ type: 'image', url: '/api/images/c/raw' });
    expect(openTargetFor({ mime: 'application/zip', id: 'd' } as any)).toEqual({ type: 'download', url: null });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/pages/project/ProjectDocuments.test.tsx`
Expected: FAIL — helpers not exported.

- [ ] **Step 3: Implement**

Replace `src/pages/project/ProjectDocuments.tsx` with:

```tsx
// src/pages/project/ProjectDocuments.tsx
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Download, FileText, History, Upload } from 'lucide-react';
import {
  ProjectFile, fetchFileBlob, formatBytes, getProjectFiles, listFileVersions, uploadProjectFile,
} from '../../utils/store';
import { useToast } from '../../components/Toast';
import {
  Button, EmptyState, Skeleton, StatusPill, Table, TBody, TD, TH, THead, TR,
} from '../../components/ui';

const SHEET_MIMES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
];

export const kindFromMime = (mime: string): string => {
  if (mime === 'application/pdf') return 'document';
  if (SHEET_MIMES.includes(mime)) return 'spreadsheet';
  if (mime.startsWith('image/')) return 'photo';
  return 'other';
};

export const openTargetFor = (f: Pick<ProjectFile, 'id' | 'mime'>):
  { type: 'pdf' | 'sheet' | 'image' | 'download'; url: string | null } => {
  if (f.mime === 'application/pdf') return { type: 'pdf', url: `/tools/pdf?fileId=${f.id}` };
  if (SHEET_MIMES.includes(f.mime)) return { type: 'sheet', url: `/tools/sheets?fileId=${f.id}` };
  if (f.mime.startsWith('image/')) return { type: 'image', url: `/api/images/${f.id}/raw` };
  return { type: 'download', url: null };
};

// Display order + labels for the kind filter. 'plan' covers internal canvas
// assets (page rasters/thumbnails/source pdfs) and is excluded from 'all'.
const KIND_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'document', label: 'Documents' },
  { id: 'proposal', label: 'Proposals' },
  { id: 'printout', label: 'Printouts' },
  { id: 'spreadsheet', label: 'Spreadsheets' },
  { id: 'photo', label: 'Photos' },
  { id: 'other', label: 'Other' },
  { id: 'plan', label: 'Plan assets' },
];

const downloadBlob = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
};

export const ProjectDocuments: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [files, setFiles] = useState<ProjectFile[] | null>(null);
  const [filter, setFilter] = useState('all');
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [versions, setVersions] = useState<ProjectFile[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = () => {
    if (!projectId) return;
    getProjectFiles(projectId).then(setFiles).catch(() => {
      setFiles([]);
      toast('Failed to load documents', { type: 'error' });
    });
  };
  useEffect(load, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const f of files ?? []) c.set(f.kind, (c.get(f.kind) ?? 0) + 1);
    return c;
  }, [files]);

  const visible = useMemo(() => {
    const all = files ?? [];
    if (filter === 'all') return all.filter(f => f.kind !== 'plan');
    return all.filter(f => f.kind === filter);
  }, [files, filter]);

  const handleUpload = async (list: FileList | null) => {
    if (!list || !projectId) return;
    setUploading(true);
    try {
      for (const file of Array.from(list)) {
        await uploadProjectFile(projectId, file, kindFromMime(file.type || 'application/octet-stream'));
      }
      toast(`Uploaded ${list.length} file${list.length > 1 ? 's' : ''}`, { type: 'success' });
      load();
    } catch {
      toast('Upload failed', { type: 'error' });
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const handleOpen = async (f: ProjectFile) => {
    const target = openTargetFor(f);
    if (target.type === 'pdf' || target.type === 'sheet') navigate(target.url!);
    else if (target.type === 'image') window.open(target.url!, '_blank');
    else {
      try {
        downloadBlob(await fetchFileBlob(f.id), f.name ?? f.id);
      } catch {
        toast('Download failed', { type: 'error' });
      }
    }
  };

  const handleHistory = async (f: ProjectFile) => {
    if (historyFor === f.id) { setHistoryFor(null); setVersions(null); return; }
    setHistoryFor(f.id);
    setVersions(null);
    try {
      setVersions(await listFileVersions(f.id));
    } catch {
      setVersions([]);
    }
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-ink">Documents</h1>
        <Button onClick={() => inputRef.current?.click()} disabled={uploading}>
          <Upload size={15} />{uploading ? 'Uploading…' : 'Upload'}
        </Button>
        <input ref={inputRef} type="file" multiple className="hidden" onChange={e => handleUpload(e.target.files)} />
      </div>

      {/* Kind filter chips */}
      <div className="mb-4 flex flex-wrap gap-1.5">
        {KIND_FILTERS.map(k => {
          const count = k.id === 'all'
            ? (files ?? []).filter(f => f.kind !== 'plan').length
            : counts.get(k.id) ?? 0;
          if (k.id !== 'all' && count === 0) return null;
          return (
            <button
              key={k.id}
              onClick={() => setFilter(k.id)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                filter === k.id
                  ? 'border-accent-500 bg-accent-50 text-accent-700 dark:bg-accent-900/30 dark:text-accent-300'
                  : 'border-edge text-ink-soft hover:bg-hover hover:text-ink'
              }`}
            >
              {k.label} · {count}
            </button>
          );
        })}
      </div>

      {files === null ? (
        <div className="space-y-2">{[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-10" />)}</div>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<FileText size={22} />}
          title="No documents yet"
          description="Upload contracts, photos, or plans — proposals and printouts you generate land here too."
          action={<Button onClick={() => inputRef.current?.click()}><Upload size={15} />Upload</Button>}
        />
      ) : (
        <Table>
          <THead>
            <TR><TH>Name</TH><TH>Kind</TH><TH>Size</TH><TH>Version</TH><TH>Added</TH><TH className="text-right">Actions</TH></TR>
          </THead>
          <TBody>
            {visible.map(f => (
              <React.Fragment key={f.id}>
                <TR interactive onClick={() => handleOpen(f)}>
                  <TD className="font-medium text-ink">{f.name ?? f.id}</TD>
                  <TD><StatusPill>{f.kind}</StatusPill></TD>
                  <TD className="text-ink-soft">{formatBytes(f.size)}</TD>
                  <TD className="text-ink-soft">v{f.versionNumber}</TD>
                  <TD className="text-ink-soft">{new Date(f.createdAt).toLocaleDateString()}</TD>
                  <TD className="text-right" onClick={e => e.stopPropagation()}>
                    <button onClick={() => handleHistory(f)} title="Version history"
                      className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-hover hover:text-ink">
                      <History size={14} />
                    </button>
                    <button
                      onClick={async () => {
                        try { downloadBlob(await fetchFileBlob(f.id), f.name ?? f.id); }
                        catch { toast('Download failed', { type: 'error' }); }
                      }}
                      title="Download"
                      className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-hover hover:text-ink"
                    >
                      <Download size={14} />
                    </button>
                  </TD>
                </TR>
                {historyFor === f.id && (
                  <TR>
                    <TD colSpan={6} className="bg-sunken/50">
                      {versions === null ? (
                        <Skeleton className="h-6 w-48" />
                      ) : versions.length <= 1 ? (
                        <span className="text-xs text-ink-faint">No earlier versions.</span>
                      ) : (
                        <ul className="space-y-1">
                          {versions.slice(1).map(v => (
                            <li key={v.id} className="flex items-center gap-3 text-xs text-ink-soft">
                              <span>v{v.versionNumber}</span>
                              <span>{new Date(v.createdAt).toLocaleString()}</span>
                              <button
                                onClick={async () => {
                                  try { downloadBlob(await fetchFileBlob(v.id), `${f.name ?? f.id} (v${v.versionNumber})`); }
                                  catch { toast('Download failed', { type: 'error' }); }
                                }}
                                className="text-accent-600 hover:underline"
                              >
                                download
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </TD>
                  </TR>
                )}
              </React.Fragment>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
};
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/pages/project/ProjectDocuments.test.tsx && npm run lint && npm test`
Expected: PASS (2 helper tests), all green.

Boot check: in a project → Documents: upload a PDF (appears as kind document), a photo; filter chips show counts; clicking a PDF row opens `/tools/pdf?fileId=…` (the editor's fileId path lands in Task 9 — until then the editor opens empty; that's expected mid-phase); download works; History on a never-versioned file shows "No earlier versions".

- [ ] **Step 5: Commit**

```bash
git add src/pages/project/ProjectDocuments.tsx src/pages/project/ProjectDocuments.test.tsx
git commit -m "feat: project documents — kind filters, upload, open, version history"
```

---

### Task 9: PDF Editor — fileId Entry, Save-as-Version, Drafts

**Files:**
- Modify: `src/pages/PdfEditor.tsx`
- Modify: `src/pages/ProjectView.tsx` (printout-open simplification)

No automated tests for this task — PdfEditor depends on pdfjs canvas rendering that jsdom can't execute; verification is the explicit manual checklist in Step 6 (and the server pieces are already test-covered). **This file is 2,142 lines: make ONLY the edits described. Anchor by content. If an anchor is ambiguous, NEEDS_CONTEXT — do not guess.** Adapt local variable/state names to what actually exists (the descriptions below name them per the current code).

- [ ] **Step 1: Loosen `PrintoutSource` and add imports**

1. In the `PrintoutSource` interface (~line 64), make `printoutId` optional: `printoutId?: string;` (Documents-opened files have no printout).
2. Add `useSearchParams` to the react-router-dom import.
3. Extend the store import with: `getFileMeta, fetchFileBlob, saveFileVersion, getDraft, putDraft, deleteDraft`.
4. Add `import { useConfirm } from '../components/ConfirmDialog';` and call `const confirm = useConfirm();` near the other hooks.

- [ ] **Step 2: Let `openPdf` seed initial annotations**

Change `openPdf`'s signature (~line 789) to accept an optional final parameter:

```ts
const openPdf = async (
  file: File,
  currentTabId: string | null,
  currentTabs: TabSnapshot[],
  source?: PrintoutSource,
  initialAnnotations?: Annotation[]
) => {
```

Where the new `TabSnapshot` is constructed inside it, use the seed:

```ts
  annotations: initialAnnotations ?? [],
  history: [initialAnnotations ?? []],
  histIdx: 0,
```

(match the existing construction shape exactly — only the two fields change; also seed the corresponding refs/state the same way the function already does for empty annotations).

- [ ] **Step 3: Add the `?fileId=` entry path to the mount effect**

In the mount effect (~392-465), after the IndexedDB restore and the existing `incoming` (location.state.file) handling, add an else-branch for the query param. Shape (adapt names):

```tsx
const [searchParams] = useSearchParams(); // component scope, near useLocation

// inside the mount effect, after `if (incoming) { ...openPdf(incoming...) }`:
} else {
  const fileIdParam = searchParams.get('fileId');
  if (fileIdParam) {
    try {
      const [meta, blob, draft] = await Promise.all([
        getFileMeta(fileIdParam),
        fetchFileBlob(fileIdParam),
        getDraft(fileIdParam).catch(() => null),
      ]);
      const base = meta?.name || `file-${fileIdParam}`;
      const fname = base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`;
      const f = new File([blob], fname, { type: 'application/pdf' });
      const src: PrintoutSource = { projectId: meta?.projectId ?? '', fileId: fileIdParam };

      let seed: Annotation[] | undefined;
      if (draft?.kind === 'pdf') {
        try {
          const parsed = JSON.parse(draft.data) as { annotations?: Annotation[] };
          if (parsed.annotations?.length) {
            const restore = await confirm({
              title: 'Restore draft?',
              message: 'You have unsaved annotations on this file from a previous session. Restore them?',
              confirmLabel: 'Restore',
              cancelLabel: 'Discard',
            });
            if (restore) seed = parsed.annotations;
            else deleteDraft(fileIdParam).catch(() => {});
          }
        } catch { /* unreadable draft — ignore */ }
      }
      await openPdf(f, null, restoredTabs, src, seed);
    } catch (e) {
      console.error('Failed to open file by id:', e);
      toast('Could not open the file', { type: 'error' });
    }
  }
}
```

(`restoredTabs` is whatever the effect's IDB-restore produced — same value the `incoming` branch passes. The effect is async already. `searchParams` read once on mount is fine.)

- [ ] **Step 4: Mirror annotations to a server draft**

Add a debounced effect near the other persistence effects (after the state declarations). Adapt the state names — the component keeps `tabs`, `activeTabId`, and an `annotations` state synced from `annotationsRef`:

```tsx
  // Mirror the active tab's annotations to a server-side draft (spec §6 —
  // crash/refresh safe). Only file-backed tabs draft; standalone tabs keep
  // IndexedDB-only persistence. Empty annotation sets still sync (clearing).
  useEffect(() => {
    const tab = tabs.find(t => t.id === activeTabId);
    const fileId = tab?.source?.fileId;
    if (!fileId) return;
    const handle = setTimeout(() => {
      putDraft(fileId, 'pdf', JSON.stringify({ annotations })).catch(() => {});
    }, 2000);
    return () => clearTimeout(handle);
  }, [annotations, activeTabId, tabs]);
```

- [ ] **Step 5: Save creates a version and clears the draft**

In `savePdf()` (~1165-1191), the printout branch currently does `await saveFile(currentSource.fileId, dataUrl)` (in-place overwrite). Replace that call with:

```ts
        await saveFileVersion(currentSource.fileId, new Blob([bytes], { type: 'application/pdf' }));
        deleteDraft(currentSource.fileId).catch(() => {});
```

(`bytes` is the `Uint8Array` from `buildAnnotatedPdf()`; the dataURL conversion for this call goes away — remove it if nothing else in the branch uses it.) Update the success toast to `'Saved — new version created'`. The existing bake behavior (new bytes become the tab's base, annotations cleared) stays exactly as is.

- [ ] **Step 6: Simplify ProjectView's printout-open handler**

In `src/pages/ProjectView.tsx` (~2606-2632), replace the body of `handleViewPrintout` — the dataURL fetch → blob → File → navigate-with-state dance — with direct query-param navigation:

```tsx
  const handleViewPrintout = (printout: Printout) => {
    const isExcel = printout.type === 'excel' || printout.name.toLowerCase().endsWith('.xlsx');
    navigate(isExcel ? `/tools/sheets?fileId=${printout.fileId}` : `/tools/pdf?fileId=${printout.fileId}`);
  };
```

(Drop the `async` if call sites don't await it; remove any now-unused locals. The `location.state.{file,source}` path in the editors stays for any other callers — ChecklistEditor still uses it.)

- [ ] **Step 7: Verify**

Run: `npm run lint && npm test`
Expected: clean / green.

Manual checklist (dev server, a project with a generated printout):
- [ ] Documents → click a PDF → editor opens it by fileId with the right name
- [ ] Draw two annotations → wait 3s → reload the editor URL → "Restore draft?" → Restore → annotations return
- [ ] Save → toast "Saved — new version created" → Documents shows v2; History shows v1 downloadable; the printout still opens (same id, new content)
- [ ] Reload again → no draft prompt (draft cleared on save)
- [ ] Printouts tab → open printout → same editor flow (no more blob passing)
- [ ] Standalone `/tools/pdf` (no fileId) → file picker flow unchanged; Save downloads locally

- [ ] **Step 8: Commit**

```bash
git add src/pages/PdfEditor.tsx src/pages/ProjectView.tsx
git commit -m "feat: pdf editor opens files by id, saves versions, drafts annotations"
```

---

### Task 10: Spreadsheet Editor — fileId Entry, Save-as-Version, Drafts

**Files:**
- Modify: `src/pages/SpreadsheetEditor.tsx`

Same rules as Task 9: no automated tests (FortuneSheet in jsdom), surgical edits only, adapt names, NEEDS_CONTEXT over guessing.

- [ ] **Step 1: Imports**

Add `useSearchParams` (react-router-dom); `getFileMeta, fetchFileBlob, saveFileVersion, getDraft, putDraft, deleteDraft` (store); `useConfirm` (ConfirmDialog, hook called near the top). Make `PrintoutSource.printoutId` optional here too (~line 15) if this file declares its own copy.

- [ ] **Step 2: `?fileId=` entry path**

In the mount effect (~258-301), after IDB restore and the `location.state.file` branch, add (adapt names — `openFile`/ingest helper is whatever function the state-file branch calls; FortuneSheet tabs are reconstructable from sheets JSON alone):

```tsx
} else {
  const fileIdParam = searchParams.get('fileId');
  if (fileIdParam) {
    try {
      const [meta, blob, draft] = await Promise.all([
        getFileMeta(fileIdParam),
        fetchFileBlob(fileIdParam),
        getDraft(fileIdParam).catch(() => null),
      ]);
      const base = meta?.name || `file-${fileIdParam}`;
      const fname = base.toLowerCase().endsWith('.xlsx') ? base : `${base}.xlsx`;
      const src: PrintoutSource = { projectId: meta?.projectId ?? '', fileId: fileIdParam };

      let draftSheets: FortuneSheet[] | null = null;
      if (draft?.kind === 'sheet') {
        try {
          const parsed = JSON.parse(draft.data) as { sheets?: FortuneSheet[] };
          if (parsed.sheets?.length) {
            const restore = await confirm({
              title: 'Restore draft?',
              message: 'You have unsaved spreadsheet changes from a previous session. Restore them?',
              confirmLabel: 'Restore',
              cancelLabel: 'Discard',
            });
            if (restore) draftSheets = parsed.sheets;
            else deleteDraft(fileIdParam).catch(() => {});
          }
        } catch { /* unreadable draft — ignore */ }
      }

      if (draftSheets) {
        // FortuneSheet JSON alone reconstructs the tab — skip xlsx parsing.
        addTabFromSheets(fname, draftSheets, src); // see Step 3
      } else {
        const f = new File([blob], fname, {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        });
        await /* the existing File-ingest function */ openFile(f, src);
      }
    } catch (e) {
      console.error('Failed to open file by id:', e);
      toast('Could not open the file', { type: 'error' });
    }
  }
}
```

- [ ] **Step 3: `addTabFromSheets` helper**

Add a small helper beside the existing ingest function that builds a `FileTab` directly (mirroring whatever the ingest function does after xlsx→FortuneSheet conversion — tab creation, `setTabs`, active-tab selection, IDB persist):

```tsx
  const addTabFromSheets = (fileName: string, sheets: FortuneSheet[], source?: PrintoutSource) => {
    const tab: FileTab = { id: uid(), fileName, sheets, source };
    // ...same setTabs / setActiveTabId / saveStateToIDB sequence the
    // xlsx-ingest path performs after conversion (reuse, don't duplicate,
    // if the ingest fn can be split to expose this step).
  };
```

- [ ] **Step 4: Mirror the draft on the existing debounce**

`scheduleSave()` (~209) already debounces `saveStateToIDB()` by 1500ms on every change. Inside the debounced callback (or immediately after the `saveStateToIDB()` call within it), add the server mirror for the active file-backed tab:

```tsx
        const tab = tabsRef.current?.find?.(t => t.id === activeTabIdRef?.current) /* adapt to actual refs/state */;
        const fileId = tab?.source?.fileId;
        if (fileId) {
          putDraft(fileId, 'sheet', JSON.stringify({ sheets: currentSheetsRef.current })).catch(() => {});
        }
```

(`currentSheetsRef` holds the live FortuneSheet JSON — the report confirms it's what `handleSave` serializes. If the active tab/source isn't reachable from refs inside the debounce, thread it through however `saveStateToIDB` already resolves the active tab.)

- [ ] **Step 5: Save creates a version and clears the draft**

In `handleSave()` (~368-385), replace `await saveFile(activeTab.source.fileId, bytesToDataUrl(bytes));` with:

```tsx
      await saveFileVersion(activeTab.source.fileId, new Blob([bytes], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }));
      deleteDraft(activeTab.source.fileId).catch(() => {});
```

Update the success toast to `'Saved — new version created'`.

- [ ] **Step 6: Verify**

Run: `npm run lint && npm test`
Expected: clean / green.

Manual checklist:
- [ ] Documents → click an .xlsx → opens by fileId
- [ ] Edit cells → wait 2s → reload → "Restore draft?" → Restore → edits return (loaded from JSON, not the xlsx)
- [ ] Save → new version toast → Documents v bump + history; reload → no draft prompt
- [ ] Standalone `/tools/sheets` flow unchanged

- [ ] **Step 7: Commit**

```bash
git add src/pages/SpreadsheetEditor.tsx
git commit -m "feat: spreadsheet editor opens files by id, saves versions, drafts state"
```

---

### Task 11: Notes & Time Sections

**Files:**
- Modify: `src/pages/project/ProjectNotes.tsx` (replace stub)
- Modify: `src/pages/project/ProjectTime.tsx` (replace stub)

- [ ] **Step 1: Implement ProjectNotes**

```tsx
// src/pages/project/ProjectNotes.tsx
import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { NotesBoard } from '../../components/NotesBoard';
import { getProjectNotes, saveProjectNotes } from '../../utils/store';
import { ProjectNote } from '../../types';
import { useToast } from '../../components/Toast';
import { Skeleton } from '../../components/ui';

// Full-page notes section. The same NotesBoard still powers the canvas
// overlay (NotesOverlay) — this page just gives it a permanent home.
export const ProjectNotes: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const { toast } = useToast();
  const [note, setNote] = useState<ProjectNote | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    setLoaded(false);
    getProjectNotes(projectId)
      .then(setNote)
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [projectId]);

  const handleSave = async (n: ProjectNote) => {
    if (!projectId) return;
    try {
      await saveProjectNotes(projectId, n);
      setNote(n);
    } catch {
      toast('Failed to save notes', { type: 'error' });
    }
  };

  if (!projectId) return null;
  return (
    <div className="flex h-screen flex-col">
      {!loaded ? (
        <div className="p-6"><Skeleton className="h-64" /></div>
      ) : (
        <div className="min-h-0 flex-1">
          <NotesBoard projectId={projectId} initialNote={note} onSave={handleSave} />
        </div>
      )}
    </div>
  );
};
```

(Check `NotesBoard`'s actual export style — match how `NotesOverlay.tsx` imports it. If NotesBoard expects explicit pixel sizing rather than filling its parent, mirror whatever container treatment NotesOverlay gives it and note the adaptation.)

- [ ] **Step 2: Implement ProjectTime**

```tsx
// src/pages/project/ProjectTime.tsx
import React, { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Clock, LogIn, LogOut } from 'lucide-react';
import { TimeEntryLite, clockIn, clockOut, getMyTimeEntries } from '../../utils/store';
import { hoursThisWeek } from '../Dashboard';
import { useToast } from '../../components/Toast';
import { Button, Card, CardBody, CardHeader, EmptyState, Skeleton } from '../../components/ui';

const fmtTime = (ms: number) => new Date(ms).toLocaleString();
const fmtDur = (ms: number) => `${(ms / 3_600_000).toFixed(2)}h`;

// My hours on this project. (Per-person/estimate-vs-actual breakdowns are
// Phase 4 alongside billing — this is the field-usable core.)
export const ProjectTime: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const { toast } = useToast();
  const [entries, setEntries] = useState<TimeEntryLite[] | null>(null);

  const load = () => {
    if (!projectId) return;
    getMyTimeEntries(projectId).then(setEntries).catch(() => setEntries([]));
  };
  useEffect(load, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const openEntry = entries?.find(e => e.clockOut === null) ?? null;
  const totalH = entries
    ? entries.reduce((ms, e) => ms + ((e.clockOut ?? Date.now()) - e.clockIn), 0) / 3_600_000
    : null;
  const weekH = entries ? hoursThisWeek(entries) : null;
  const recent = useMemo(
    () => (entries ?? []).slice().sort((a, b) => b.clockIn - a.clockIn).slice(0, 20),
    [entries]
  );

  const toggle = async () => {
    try {
      if (openEntry) {
        await clockOut();
        toast('Clocked out', { type: 'success' });
      } else {
        await clockIn(projectId);
        toast('Clocked in to this project', { type: 'success' });
      }
      load();
    } catch (e) {
      // e.g. "Already clocked in" (open entry on another project)
      toast(e instanceof Error ? e.message : 'Clock action failed', { type: 'error' });
    }
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-ink">Time</h1>
        <Button onClick={toggle} variant={openEntry ? 'secondary' : 'primary'}>
          {openEntry ? <LogOut size={15} /> : <LogIn size={15} />}
          {openEntry ? 'Clock out' : 'Clock in'}
        </Button>
      </div>

      <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader title="My hours — total" />
          <CardBody>
            {totalH === null ? <Skeleton className="h-9 w-24" /> : (
              <div className="flex items-baseline gap-2">
                <Clock size={18} className="self-center text-ink-faint" />
                <span className="text-2xl font-bold text-ink">{totalH.toFixed(1)}</span>
                <span className="text-sm text-ink-soft">hours on this project</span>
              </div>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="My hours — this week" />
          <CardBody>
            {weekH === null ? <Skeleton className="h-9 w-24" /> : (
              <div className="flex items-baseline gap-2">
                <Clock size={18} className="self-center text-ink-faint" />
                <span className="text-2xl font-bold text-ink">{weekH.toFixed(1)}</span>
                <span className="text-sm text-ink-soft">hours since Monday</span>
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Recent entries" />
        <CardBody className="p-0">
          {entries === null ? (
            <div className="space-y-2 p-4">{[0, 1, 2].map(i => <Skeleton key={i} className="h-8" />)}</div>
          ) : recent.length === 0 ? (
            <EmptyState icon={<Clock size={20} />} title="No time logged yet" description="Clock in to start tracking hours against this project." />
          ) : (
            <ul className="divide-y divide-edge">
              {recent.map(e => (
                <li key={e.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                  <span className="text-ink">{fmtTime(e.clockIn)}</span>
                  <span className="text-ink-soft">
                    {e.clockOut === null ? 'open' : fmtDur(e.clockOut - e.clockIn)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
};
```

- [ ] **Step 3: Verify and commit**

Run: `npm run lint && npm test`
Expected: clean / green. Boot check: Notes section draws and persists across reload (and the canvas overlay still works); Time section clock in/out round-trips and the entry shows in both the section and `/time`.

```bash
git add src/pages/project/ProjectNotes.tsx src/pages/project/ProjectTime.tsx
git commit -m "feat: project notes and time sections"
```

---

### Task 12: Cleanup — Legacy Toggles + Orphaned ServerSettings

**Files:**
- Modify: `src/pages/ProjectView.tsx`
- Delete: `src/pages/ServerSettings.tsx`

- [ ] **Step 1: Remove the legacy status toggles from ProjectView**

1. Delete the `handleToggleStatus` function (~line 2962 — `const handleToggleStatus = async (field: 'submitted' | 'responded' | 'accepted') => {...}`). It has no other callers (verified).
2. Delete the toggle-button row: the `{/* TODO 3b: retire submitted/responded/accepted toggles — superseded by lifecycle status */}` comment AND the `<div className="flex flex-wrap gap-2 mt-3 md:mt-4">` block containing the three `onClick={() => handleToggleStatus(...)}` buttons (~3273-3311). The stage pill (ProjectStageControl) above it stays.
3. Leave `submitted?/responded?/accepted?` in `src/types.ts` — they're legacy data fields that `deriveStatus` still reads.
4. `grep -n "handleToggleStatus" src/pages/ProjectView.tsx` — must be empty.

- [ ] **Step 2: Delete the orphaned ServerSettings page**

```bash
grep -rn "ServerSettings" src/ --include=*.tsx --include=*.ts
```

Expected: hits only inside `src/pages/ServerSettings.tsx` itself (it has no route and no importers — verified pre-plan). If anything else references it, STOP and report. Otherwise:

```bash
git rm src/pages/ServerSettings.tsx
```

- [ ] **Step 3: Verify and commit**

Run: `npm run lint && npm test`
Expected: clean / green.

```bash
git add src/pages/ProjectView.tsx
git commit -m "chore: retire legacy status toggles and orphaned ServerSettings page"
```

---

### Task 13: Full Verification + Push

**Files:** none (verification only)

- [ ] **Step 1: Full automated pass**

Run: `npm run lint && npm test && npm run build`
Expected: zero type errors, all suites green, build succeeds.

- [ ] **Step 2: Live API smoke** (boot with a temp dir, login admin/admin via curl)

- [ ] Migrations 1-7 apply on a fresh dir; second boot applies nothing
- [ ] `POST /api/files/x1?projectId=...&kind=document&name=t.pdf` then `/meta`, `/versions` (POST + GET), `GET /api/projects/:id/files` — shapes as specced
- [ ] `PUT/GET/DELETE /api/drafts/x1` round-trips
- [ ] `GET /api/nonexistent-zzz` under `/api/` → **404 JSON** (the new guard), while `/dashboard` still serves the SPA

- [ ] **Step 3: Browser smoke** (the parts a human should eyeball — hand to Nathan if not done in-session)

- [ ] Open a project → Overview (name, stage dropdown works, activity, hours, actions)
- [ ] Sidebar sections navigate + highlight: Overview / Takeoff & Estimate / Documents / Notes / Time; canvas page highlights Takeoff
- [ ] Old bookmark `/project/:id?tab=takeoffs` → lands in the takeoff section, takeoffs tab
- [ ] Documents: upload, filter chips, open PDF → annotate → draft restore on reload → Save → version history; xlsx same
- [ ] Printouts tab → open printout → editor by fileId; share links still serve
- [ ] Notes section draws/persists; canvas notes overlay still works
- [ ] Time section clock in/out; Overview hours move
- [ ] Legacy toggles gone from the takeoff header; stage pill intact
- [ ] Two-tab project conflict toast still works (PUT path unchanged)

- [ ] **Step 4: Tell Nathan, then push**

Migration 7 is **additive** (new empty `drafts` table — no data risk), but per protocol say so explicitly when pushing. Then:

```bash
git push origin testing
```

---

## Plan Self-Review Notes (already applied)

1. **Spec coverage (§4.2, §6, §3.2):** project sections as routes ✅ (Task 6: Overview/Takeoff/Documents/Notes/Time + canvas nested) · Overview stage-aware home with next actions ✅ (Task 7) · Documents "all project files by kind; click opens the right editor in context" ✅ (Task 8) · PDF/spreadsheet editors open any files row in project context ✅ (Tasks 9-10 `?fileId=`) · "Save creates a new version (history kept)" ✅ (Task 3 archive-then-overwrite; §3.2 "new row pointing at the original") · "annotations autosave as server-side drafts (crash/refresh safe)" ✅ (Tasks 4, 9, 10) · "server drafts replace IndexedDB-only cache" — for FILE-BACKED tabs ✅; standalone tool tabs intentionally keep IndexedDB (no server file to key a draft on) · Notes section ✅ (Task 11; canvas overlay retained per §4.2) · Time section ✅ (Task 11, reduced scope noted in-code: per-person/estimate-vs-actual goes with Phase 4 billing).
2. **Deliberate deviations/deferrals:** Proposal as a separate section waits for the Phase 5 ProjectView split (printouts/email tabs keep serving it — spec §4.2 list is fully realized then) · Project Settings section is Phase 5 · `/p/:id` URL rename remains declined (3a decision) · per-person project time = Phase 4 · editors keep their standalone `/tools/*` modes per spec §4.1.
3. **Type consistency:** `ProjectFile` (client) matches the slim listing/meta SELECT columns · `EditorDraft {kind,data,updatedAt}` matches the drafts SELECT · `saveNewVersion` return `{archivedVersionId, versionNumber}` matches route spread + client `{versionNumber}` subset · `ProjectOutletCtx {summary, refreshSummary}` matches `useProjectOutlet` consumers (Overview) · `useRegisterProjectShell(summary?.id, summary?.name)` matches its Phase 2 signature `(id?, name?)` · PROJECT_NAV `match(p, base)` consistent between definition and map call · Dashboard's exported `timeAgo`/`hoursThisWeek` imported by Overview/Time.
4. **Ordering constraints:** Task 6 ships stubs for Documents/Notes/Time so routes compile before Tasks 8/11 · Task 8's "open PDF" depends on Task 9 only for the editor side (noted as expected mid-phase) · Task 9's draft/version calls need Tasks 3-5 · orphan-guard ships WITH versioning (Task 3) so history can never be cleanup-deleted in between.
5. **Editor-task risk control:** Tasks 9-10 carry explicit anchors, adapt-the-names guidance, and NEEDS_CONTEXT escape hatches; no automated tests promised that jsdom can't run — manual checklists are the verification, with the server half fully test-covered.
6. **Placeholder scan:** Task 6's three stub pages are complete, working components explicitly replaced by later tasks (not TODOs); all other code steps are full code.
