# Document Actions & File Picker Rollout — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every document-producing editor gets the same Generate → Open/Download → Send bar with an up-to-date chip and version/overwrite prompt; every upload site gets one "Add files" button backed by the server-file picker (with an Upload tab and drag-and-drop).

**Architecture:** Server gains a by-source document lookup (single + batch) and an `overwrite` upload mode; entities without `updatedAt` get one (additive migration 30). Client gains `useGeneratedDocument(s)` hooks, a `DocumentActionsBar` (owns generate/open/download/send + the dialogs), `DocumentStatusChip`, a `FilePickerModal` Upload tab + `returnBlobs`, `AddFilesButton`, and `useDropZone`; each editor is then reduced to `build()` + `send()` callbacks.

**Tech Stack:** TypeScript, Express + better-sqlite3, React 18 + react-router + Tailwind, jsPDF/pdf-lib/xlsx, vitest (`server` + `ui` projects), Playwright, `uuid` (never `crypto.randomUUID` in client code).

**Spec:** `docs/superpowers/specs/2026-08-29-document-actions-rollout-design.md`

## Global Constraints
- Branch `testing`; commit per task; do NOT push (controller pushes). No PRs.
- Client ids via `import { v4 as uuidv4 } from 'uuid'`.
- Button set per editor: `Save` · `Generate` · `Open` + `Download` (only when a file exists) · `Send`. Old "Download PDF" buttons removed.
- Regenerate over an existing file → dialog **Save as new version** (default) / **Overwrite** / Cancel. Upload `mode=version|overwrite`.
- Send reuses the current file iff `file.createdAt >= entity.updatedAt` AND chosen header email === default; otherwise generate first (same dialog if a stale file exists). Generate/Send save first; failed save aborts.
- Up-to-date chip states: "No PDF yet" / "PDF up to date" / "PDF out of date" (Excel wording for pay apps: "No Excel yet" / "Excel up to date" / "Excel out of date").
- Open = `DocumentViewerModal` everywhere. Download = `downloadBlob(await fetchFileBlob(id), name)`.
- Picker project filter defaults to the current project when opened inside a project; global for EmailComposer / RFI response.
- Admin-only kinds stay admin-only (`NON_ADMIN_EXCLUDED_KINDS`); by-source returns 404/null for non-admins on those kinds.
- Migration 30 is ADDITIVE (adds `updatedAt` to invoices, change_orders, issues, rfis, aia_pay_apps; backfilled from `createdAt` or now).
- Run `npm run lint`, `npx vitest run --project server|ui` before each commit; `npm run build` + Playwright on the final task.
- Takeoff prints/exports unchanged. Sent-record columns out of scope. Logo/note images out of scope.

---

## File Structure

**Server**
- `server/migrationList.ts` — migration 30 `updated-at-columns`.
- `server/billingStore.ts`, `server/issueStore.ts`, `server/rfiStore.ts`, `server/aiaStore.ts` — set `updatedAt = Date.now()` on every mutating write (save, status, lines, photos, response).
- `server/documents.ts` — `findDocumentBySource(db, {sourceType, sourceId, kind}, isAdmin)`, `findDocumentsBySource(db, {sourceType, sourceIds[], kind}, isAdmin)`.
- `server/files.ts` — `PutOpts.mode?: 'version' | 'overwrite'`; `overwriteLive(db, dataDir, id, buf, mime)`; draft invalidation on version/overwrite.
- `server/routes.ts` — `GET /api/documents/by-source`, `mode` query param on `POST /api/files/:id`.

**Client shared**
- `src/utils/store.ts` — `getDocumentBySource`, `getDocumentsBySource`, `FileUploadOpts.mode`, `GeneratedDoc` type.
- `src/hooks/useGeneratedDocument.ts` (+ `.test.tsx`) — single + batch hooks, `isUpToDate(file, updatedAt)` pure helper.
- `src/components/documents/DocumentStatusChip.tsx`, `VersionOrOverwriteDialog.tsx`, `DocumentActionsBar.tsx` (+ tests).
- `src/components/FilePickerModal.tsx` — Upload tab, `returnBlobs`, `defaultTab`.
- `src/components/documents/AddFilesButton.tsx`, `src/hooks/useDropZone.ts` (+ tests).

**Editors / lists (modified):** InvoiceEditor, ChangeOrderEditor, AiaPayAppEditor (+ aiaExcel.ts split), IssueEditor, RfiEditor, DailyReportEditor, ProjectPunch, ProposalEditor; InvoicesSection, ChangeOrdersSection, AiaPayApplications, ProjectIssues, ProjectRfis, ProjectDailyReports.

**Upload sites (modified):** Issue/RFI/CO/Daily photo cards, PunchItemEditor, TaskEditor, EmailComposer, AddPagesModal, NewProject, PdfEditor, SpreadsheetEditor, AiaScheduleOfValues.

**Tests:** per file above; `e2e/document-actions.spec.ts`; changelog entry in `src/pages/Settings.tsx`.

---

### Task 1: Migration 30 — `updatedAt` on invoices, change_orders, issues, rfis, aia_pay_apps + stores stamp it

**Files:**
- Modify: `server/migrationList.ts` (append after version 29)
- Modify: `server/billingStore.ts` (saveInvoice ~99, setInvoiceStatus ~173, saveChangeOrder ~282, setChangeOrderStatus ~304, addChangeOrderPhoto ~313, removeChangeOrderPhoto ~328), `server/issueStore.ts` (saveIssue, setIssueStatus, addPhoto, removePhoto, markIssueSent), `server/rfiStore.ts` (saveRfi, setRfiStatus, addPhoto, removePhoto, markRfiSent, setRfiResponse), `server/aiaStore.ts` (savePayAppLines, setPayApp)
- Test: `server/migrationList.test.ts`, `server/billingStore.test.ts`, `server/issueStore.test.ts`, `server/rfiStore.test.ts`, `server/aiaStore.test.ts`

**Interfaces:**
- Produces: column `updatedAt INTEGER NOT NULL DEFAULT 0` on the five tables, backfilled to `createdAt` when that column exists (invoices/change_orders/issues/rfis) else `Date.now()`; every list/get on those entities now returns `updatedAt` (they `SELECT *`).

- [ ] **Step 1: Failing tests**

`server/migrationList.test.ts`:
```ts
describe('migration 30 — updatedAt columns', () => {
  it('adds updatedAt to the five tables and backfills from createdAt', () => {
    const dir = tmpDir(); const db = openDb(':memory:');
    runMigrations(db, dir, migrations.filter(m => m.version <= 29));
    db.prepare(`INSERT INTO projects (id, name, createdAt, version, updatedAt, meta) VALUES ('p1','P',1,1,1,'{}')`).run();
    db.prepare(`INSERT INTO invoices (id, projectId, number, status, createdAt, version) VALUES ('i1','p1','1','draft',12345,1)`).run();
    runMigrations(db, dir, migrations.filter(m => m.version <= 30));
    for (const t of ['invoices','change_orders','issues','rfis','aia_pay_apps']) expect(columnNames(db, t)).toContain('updatedAt');
    expect((db.prepare('SELECT updatedAt FROM invoices WHERE id = ?').get('i1') as any).updatedAt).toBe(12345);
    db.close();
  });
});
```
(Check each table's actual NOT NULL columns in `migrationList.ts` before writing the INSERT and adapt; if `aia_pay_apps` has no `createdAt`, the migration backfills `Date.now()` and the test asserts `> 0`.)

Per store test file, one case each, e.g. `server/billingStore.test.ts`:
```ts
it('saveInvoice and setInvoiceStatus bump updatedAt', async () => {
  const { id } = createInvoice(db, 'p1', { number: '1', lines: [] });
  const before = (getInvoice(db, id) as any).updatedAt;
  await new Promise(r => setTimeout(r, 2));
  saveInvoice(db, id, { ...getInvoice(db, id), version: 1, terms: 'net 30' });
  expect((getInvoice(db, id) as any).updatedAt).toBeGreaterThan(before);
});
```
Repeat the same shape for change orders (save + photo add), issues (save + photo), RFIs (save + response), pay apps (savePayAppLines / setPayApp) — one `it` per store using that store's real create/save function signatures (read them first).

- [ ] **Step 2: Run** `npx vitest run server/migrationList.test.ts server/billingStore.test.ts server/issueStore.test.ts server/rfiStore.test.ts server/aiaStore.test.ts` → FAIL.

- [ ] **Step 3: Implement**

Migration:
```ts
  {
    version: 30,
    name: 'updated-at-columns',
    // ADDITIVE. The document-actions bar needs "record changed since the PDF
    // was generated"; only proposals/daily_reports/projects carried updatedAt.
    up({ db }) {
      const hasCol = (t: string, c: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as any[]).some(x => x.name === c);
      for (const t of ['invoices', 'change_orders', 'issues', 'rfis', 'aia_pay_apps']) {
        if (hasCol(t, 'updatedAt')) continue;
        db.exec(`ALTER TABLE ${t} ADD COLUMN updatedAt INTEGER NOT NULL DEFAULT 0`);
        if (hasCol(t, 'createdAt')) db.exec(`UPDATE ${t} SET updatedAt = COALESCE(createdAt, 0)`);
        db.prepare(`UPDATE ${t} SET updatedAt = ? WHERE updatedAt = 0`).run(Date.now());
      }
    },
  },
```
Stores: add `updatedAt = ?` (bound `Date.now()`) to every UPDATE statement that mutates the entity, and to the INSERT in each `create*` (value `now`). For photo join-table writes (`addChangeOrderPhoto`, issue/rfi `addPhoto`/`removePhoto`) run `UPDATE <entity> SET updatedAt = ? WHERE id = ?` alongside. `setRfiResponse` and `markIssueSent`/`markRfiSent` too.

- [ ] **Step 4: Run** the five test files → PASS; then `npx vitest run --project server` + `npm run lint`.
- [ ] **Step 5: Commit** `git add server/ && git commit -m "feat(db): migration 30 — updatedAt on invoices/COs/issues/RFIs/pay apps; stores stamp it"`

---

### Task 2: Server — by-source lookup + `overwrite` upload mode + draft invalidation

**Files:**
- Modify: `server/documents.ts` (add after `listDocuments`), `server/files.ts` (`PutOpts` ~77, `store()` ~164-193, new `overwriteLive`), `server/routes.ts` (`GET /api/documents` ~1135 → add `/by-source` BEFORE it is fine since paths differ; `POST /api/files/:id` ~994-1033 → `mode`)
- Test: `server/documents.test.ts`, `server/files.test.ts`

**Interfaces (produced):**
```ts
// server/documents.ts
export interface SourceDoc { id: string; name: string | null; mime: string; size: number; createdAt: number; versionNumber: number }
export function findDocumentBySource(db, q: { sourceType: string; sourceId: string; kind: string }, isAdmin: boolean): SourceDoc | null
export function findDocumentsBySource(db, q: { sourceType: string; sourceIds: string[]; kind: string }, isAdmin: boolean): Record<string, SourceDoc | null>   // max 200 ids
// server/files.ts
export interface PutOpts { …; mode?: 'version' | 'overwrite' }
// routes
GET /api/documents/by-source?sourceType=&kind=&sourceId=X          → 200 SourceDoc | 404
GET /api/documents/by-source?sourceType=&kind=&sourceIds=a,b,c     → 200 { [id]: SourceDoc | null }
POST /api/files/:id?…&mode=overwrite                               → same response shape; on a source hit: same fileId, versionNumber unchanged, no archived row, bytes replaced, createdAt = now
```
Both version and overwrite paths delete rows from `drafts WHERE fileId = <liveId>` and call `deps.sheetStore?.clearSession(liveId)` (route level).

- [ ] **Step 1: Failing tests**

`server/documents.test.ts` (uses existing `upload`, `buildApp`, `db`):
```ts
describe('by-source lookup', () => {
  it('returns the live document for a source triple, 404 when none', async () => {
    const fid = await upload('f1', { projectId: 'p1', kind: 'invoice', name: 'Invoice-1.pdf', sourceType: 'invoice', sourceId: 'inv-1' });
    const hit = await request(app).get('/api/documents/by-source?sourceType=invoice&sourceId=inv-1&kind=invoice');
    expect(hit.status).toBe(200);
    expect(hit.body).toMatchObject({ id: fid, name: 'Invoice-1.pdf', versionNumber: 1 });
    expect((await request(app).get('/api/documents/by-source?sourceType=invoice&sourceId=nope&kind=invoice')).status).toBe(404);
  });
  it('hides admin-only kinds from non-admins and batches', async () => {
    await upload('f1', { projectId: 'p1', kind: 'invoice', name: 'a', sourceType: 'invoice', sourceId: 'inv-1' });
    await upload('f2', { projectId: 'p1', kind: 'issue-report', name: 'b', sourceType: 'issue', sourceId: 'is-1' });
    const user = buildApp('user');
    expect((await request(user).get('/api/documents/by-source?sourceType=invoice&sourceId=inv-1&kind=invoice')).status).toBe(404);
    const batch = await request(app).get('/api/documents/by-source?sourceType=invoice&kind=invoice&sourceIds=inv-1,inv-2');
    expect(batch.body['inv-1'].id).toBe('f1');
    expect(batch.body['inv-2']).toBeNull();
    const batchUser = await request(user).get('/api/documents/by-source?sourceType=invoice&kind=invoice&sourceIds=inv-1');
    expect(batchUser.body['inv-1']).toBeNull();
  });
  it('after a versioned regenerate the lookup returns the same id with the new version', async () => {
    const a = await upload('f1', { projectId: 'p1', kind: 'invoice', name: 'a', sourceType: 'invoice', sourceId: 'inv-1' }, 'v1');
    const b = await upload('f9', { projectId: 'p1', kind: 'invoice', name: 'a', sourceType: 'invoice', sourceId: 'inv-1' }, 'v2');
    expect(b).toBe(a);
    const hit = await request(app).get('/api/documents/by-source?sourceType=invoice&sourceId=inv-1&kind=invoice');
    expect(hit.body.versionNumber).toBe(2);
  });
});
```
`server/files.test.ts` (read its harness first; use the raw route or `putBuffer` directly):
```ts
describe('overwrite mode', () => {
  it('replaces the live bytes in place: same id, no archived row, versionNumber unchanged, createdAt refreshed', async () => {
    const id = await upload('f1', { projectId: 'p1', kind: 'invoice', name: 'a', sourceType: 'invoice', sourceId: 'inv-1' }, 'v1');
    const before = getMeta(db, id)!;
    await new Promise(r => setTimeout(r, 2));
    const res = await request(app).post(`/api/files/zzz?projectId=p1&kind=invoice&name=a&sourceType=invoice&sourceId=inv-1&mode=overwrite`)
      .set('Content-Type', 'application/pdf').send(Buffer.from('v2'));
    expect(res.body.fileId).toBe(id);
    const after = getMeta(db, id)!;
    expect(after.versionNumber).toBe(before.versionNumber);
    expect(after.createdAt).toBeGreaterThan(before.createdAt);
    expect(readFileContent(dir, id)!.toString()).toBe('v2');
    expect(db.prepare('SELECT COUNT(*) c FROM files WHERE parentFileId = ?').get(id)).toEqual({ c: 0 });
  });
  it('version mode (default) still archives', async () => { /* same setup without mode → parentFileId row count 1, versionNumber 2 */ });
  it('both modes clear a pdf draft for the file', async () => {
    const id = await upload('f1', { projectId: 'p1', kind: 'invoice', name: 'a', sourceType: 'invoice', sourceId: 'inv-1' }, 'v1');
    db.prepare(`INSERT INTO drafts (userId, fileId, kind, data, updatedAt) VALUES ('u1', ?, 'pdf', '{}', 1)`).run(id);
    await upload('f2', { projectId: 'p1', kind: 'invoice', name: 'a', sourceType: 'invoice', sourceId: 'inv-1' }, 'v2');
    expect(db.prepare('SELECT COUNT(*) c FROM drafts WHERE fileId = ?').get(id)).toEqual({ c: 0 });
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

`server/documents.ts`:
```ts
export interface SourceDoc { id: string; name: string | null; mime: string; size: number; createdAt: number; versionNumber: number }
const SOURCE_COLS = 'id, name, mime, size, createdAt, versionNumber, kind';
export function findDocumentsBySource(db: Database.Database, q: { sourceType: string; sourceIds: string[]; kind: string }, isAdmin: boolean): Record<string, SourceDoc | null> {
  const out: Record<string, SourceDoc | null> = {};
  const ids = [...new Set(q.sourceIds.filter(Boolean))].slice(0, 200);
  for (const id of ids) out[id] = null;
  if (!ids.length) return out;
  if (!isAdmin && (NON_ADMIN_EXCLUDED_KINDS as readonly string[]).includes(q.kind)) return out;
  if ((ALWAYS_EXCLUDED_KINDS as readonly string[]).includes(q.kind)) return out;
  const rows = db.prepare(`SELECT ${SOURCE_COLS}, sourceId FROM files
    WHERE parentFileId IS NULL AND sourceType = ? AND kind = ? AND sourceId IN (${ids.map(() => '?').join(',')})
    ORDER BY createdAt ASC, id ASC`).all(q.sourceType, q.kind, ...ids) as any[];
  for (const r of rows) if (!out[r.sourceId]) { const { sourceId, kind, ...doc } = r; out[sourceId] = doc; }
  return out;
}
export function findDocumentBySource(db: Database.Database, q: { sourceType: string; sourceId: string; kind: string }, isAdmin: boolean): SourceDoc | null {
  return findDocumentsBySource(db, { sourceType: q.sourceType, sourceIds: [q.sourceId], kind: q.kind }, isAdmin)[q.sourceId] ?? null;
}
```
Route (next to `GET /api/documents`):
```ts
  app.get('/api/documents/by-source', authenticateToken, (req, res) => {
    const isAdmin = (req as any).user?.role === 'admin';
    const { sourceType, kind, sourceId, sourceIds } = req.query as Record<string, string | undefined>;
    if (!sourceType || !kind) return res.status(400).json({ error: 'sourceType and kind are required' });
    if (typeof sourceIds === 'string') return res.json(findDocumentsBySource(db, { sourceType, kind, sourceIds: sourceIds.split(',').map(s => s.trim()).filter(Boolean) }, isAdmin));
    if (!sourceId) return res.status(400).json({ error: 'sourceId or sourceIds is required' });
    const doc = findDocumentBySource(db, { sourceType, sourceId, kind }, isAdmin);
    if (!doc) return res.status(404).json({ error: 'No document for this source' });
    res.json(doc);
  });
```
`server/files.ts`: `PutOpts.mode?: 'version' | 'overwrite'`. In `store()` at the upsert hit: if `opts.mode === 'overwrite'` → `overwriteLive(db, dataDir, existingId, buf, mime)` else `saveNewVersion(...)`; in both cases `db.prepare('DELETE FROM drafts WHERE fileId = ?').run(existingId)` (guard with a table-exists check like the customerId guard in decomposeProject, since older migration paths call putBuffer before `drafts` exists — check `sqlite_master`). `overwriteLive`:
```ts
export function overwriteLive(db: Database.Database, dataDir: string, id: string, buf: Buffer, mime: string): void {
  const { size, sha256 } = writeFileContent(dataDir, id, buf);   // atomic rename over the same path
  db.prepare('UPDATE files SET mime = ?, size = ?, sha256 = ?, legacyFormat = NULL, createdAt = ?, archived = 0 WHERE id = ?').run(mime, size, sha256, Date.now(), id);
}
```
Confirm `saveNewVersion` already sets the live row's `createdAt = now` (it re-enters putBuffer → upsertRow; verify `createdAt` is refreshed — if upsertRow carries the old createdAt over, set it explicitly). Route: `mode: str(req.query.mode) === 'overwrite' ? 'overwrite' : undefined` into PutOpts; after a `versioned` result call `deps.sheetStore?.clearSession(result.id)`.

- [ ] **Step 4: Run** → PASS; `npx vitest run --project server`; `npm run lint`.
- [ ] **Step 5: Commit** `git commit -am "feat(files): by-source document lookup (single+batch), overwrite upload mode, draft invalidation on regenerate"`

---

### Task 3: Client store helpers + `useGeneratedDocument(s)` hooks

**Files:**
- Modify: `src/utils/store.ts` (`FileUploadOpts` ~239, `uploadQuery` ~253, after `getDocuments` ~750)
- Create: `src/hooks/useGeneratedDocument.ts`, `src/hooks/useGeneratedDocument.test.tsx`, `src/utils/store.bySource.test.ts`

**Interfaces (produced):**
```ts
// store.ts
export interface FileUploadOpts { …; mode?: 'version' | 'overwrite' }           // uploadQuery sets q.set('mode', …)
export interface GeneratedDoc { id: string; name: string | null; mime: string; size: number; createdAt: number; versionNumber: number }
export const getDocumentBySource = (q: { sourceType: string; sourceId: string; kind: string }): Promise<GeneratedDoc | null>   // 404 → null
export const getDocumentsBySource = (q: { sourceType: string; sourceIds: string[]; kind: string }): Promise<Record<string, GeneratedDoc | null>>
// useGeneratedDocument.ts
export const isUpToDate = (file: GeneratedDoc | null, updatedAt: number | null | undefined): boolean | null   // null when no file; true when no updatedAt
export interface GeneratedDocState { file: GeneratedDoc | null; upToDate: boolean | null; loading: boolean; refresh: () => Promise<void> }
export function useGeneratedDocument(q: { sourceType: string; sourceId: string | undefined; kind: string; updatedAt?: number | null; enabled?: boolean }): GeneratedDocState
export function useGeneratedDocuments(q: { sourceType: string; sourceIds: string[]; kind: string; updatedAtById?: Record<string, number | null | undefined>; enabled?: boolean }): { byId: Record<string, { file: GeneratedDoc | null; upToDate: boolean | null }>; loading: boolean; refresh: () => Promise<void> }
```
Both hooks refetch on `useLiveQuery(refresh, { types: ['file'] })` (debounced) — file events don't carry sourceId, so refetch on any file event; cheap (one small request).

- [ ] **Step 1: Failing tests** — `store.bySource.test.ts` (mock fetch: 200 → doc, 404 → null, batch passes `sourceIds=a%2Cb`; `mode=overwrite` appears in the upload URL). `useGeneratedDocument.test.tsx`: `isUpToDate(null, 5) === null`, `isUpToDate({createdAt: 10}, 5) === true`, `isUpToDate({createdAt: 4}, 5) === false`, `isUpToDate({createdAt: 4}, undefined) === true`; hook renders with mocked `getDocumentBySource` and exposes `file/upToDate`; `enabled: false` never fetches; batch hook maps ids. Mock `useLiveQuery` (`vi.mock('./useLiveQuery', () => ({ useLiveQuery: vi.fn() }))`).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** (helpers via `fetchWithRetry` + `handleResponse`, 404 → null; hooks with `useState/useEffect/useCallback`, request-id guard against out-of-order responses like FilePickerModal).
- [ ] **Step 4: Run → PASS**, `npx vitest run --project ui`, lint. **Step 5: Commit** `git commit -am "feat(documents): by-source client helpers + useGeneratedDocument hooks"`

---

### Task 4: `DocumentStatusChip`, `VersionOrOverwriteDialog`, `DocumentActionsBar`

**Files:**
- Create: `src/components/documents/DocumentStatusChip.tsx`, `VersionOrOverwriteDialog.tsx`, `DocumentActionsBar.tsx`, `DocumentActionsBar.test.tsx`, `VersionOrOverwriteDialog.test.tsx`
- Consumes: Task 3 hooks; `persistGeneratedDocument`, `fetchFileBlob`, `getFileMeta`, `DocumentRow`; `DocumentViewerModal` (props: row, customTypes, onClose, onOpenInEditor, onDownload, onArchive); `downloadBlob` (move it from `src/pages/documents/DocumentsTable.tsx:31-40` to `src/utils/download.ts` and re-export from DocumentsTable to keep imports working); `EmailComposer`; `useConfirm`; `openTargetFor` from `src/pages/documents/openTarget.ts`; `getDocumentTypes`.

**Interfaces (produced):**
```tsx
export type DocFormat = 'pdf' | 'xlsx';
export const DocumentStatusChip: React.FC<{ file: GeneratedDoc | null; upToDate: boolean | null; format?: DocFormat; size?: 'sm' }>
// labels: no file → "No PDF yet" (slate), true → "PDF up to date" (emerald), false → "PDF out of date" (amber); 'xlsx' swaps PDF→Excel

export const VersionOrOverwriteDialog: React.FC<{ open: boolean; fileName: string; versionNumber: number; onChoose: (mode: 'version' | 'overwrite') => void; onCancel: () => void }>
// Title "Replace the existing PDF?"; body: "<fileName> already exists (version N). Save the new PDF as version N+1, or overwrite it?"; buttons Cancel / Overwrite (secondary) / Save as new version (primary, default focus)

export interface DocumentActionsBarProps {
  source: { sourceType: string; sourceId: string };
  kind: string;                                  // document kind for persistGeneratedDocument
  format: DocFormat;
  projectId: string;
  fileName: string;                              // e.g. `Invoice-12.pdf`
  build: (opts: { headerEmail?: string }) => Promise<Blob>;
  dirty: boolean;
  save: () => Promise<boolean>;                  // true = saved
  updatedAt: number | null | undefined;
  readOnly?: boolean;
  onGenerated?: (fileId: string) => void | Promise<void>;
  send?: {
    blockedReason?: string;                       // shown as title when set; button disabled
    composer: Omit<EmailComposerProps, 'open' | 'onClose' | 'onSend' | 'projectId' | 'primaryAttachmentName'>;
    sendFn: (fileId: string, m: { to: string; cc?: string; bcc?: string; subject: string; body: string; attachmentFileIds: string[] }) => Promise<void>;
  };
  size?: 'sm';
  testIdPrefix?: string;                         // default 'doc'
}
export const DocumentActionsBar: React.FC<DocumentActionsBarProps>
```
Behavior:
- `useGeneratedDocument({ ...source, kind, updatedAt })` → chip + `Open`/`Download` visible iff `file`.
- **Generate** (`data-testid="${p}-generate"`): if `dirty` → `await save()`; false → toast 'Save failed — nothing generated', return. If `file` exists → `VersionOrOverwriteDialog`; cancel → return. Then `build({})` → `persistGeneratedDocument(blob, { projectId, kind, name: fileName, sourceType, sourceId, mode })` → `onGenerated?.(fileId)` → `refresh()` → toast 'PDF generated' (or 'Excel generated'). Busy state disables all buttons; progress text optional.
- **Open**: fetch `getFileMeta(file.id)` → build a `DocumentRow` (`{ ...meta, kind, archived: false, projectId, projectName: null, customerId: null, customerName: null, source: null }`) → `DocumentViewerModal` with `onOpenInEditor = row => navigate(openTargetFor(row))`, `onDownload = download`, `onArchive` = no-op resolved promise (bar never archives; hide if the modal shows the button when `onArchive` is provided — check its UI; pass a prop or accept the button).
- **Download**: `downloadBlob(await fetchFileBlob(file.id), file.name ?? fileName)`.
- **Send** (`data-testid="${p}-send"`; hidden when `!send`; disabled with `send.blockedReason ?? (dirty ? 'Save first' : undefined)`): opens `EmailComposer` (`primaryAttachmentName = fileName`). `onSend(m)`: `const headerOverride = m.headerEmail && m.headerEmail !== send.composer.defaultHeaderEmail ? m.headerEmail : undefined;` if `file && upToDate && !headerOverride` → `fileId = file.id`; else → if `file` → dialog (cancel = abort send, rethrow so the composer stays open) → `build({ headerEmail: headerOverride })` → persist with chosen mode → `onGenerated` → `refresh()`; then `await send.sendFn(fileId, m)`; toast 'Sent'.
- `readOnly` → only Open/Download rendered.

- [ ] **Step 1: Failing tests** (RTL; mock `../../utils/store` partially: `persistGeneratedDocument`, `fetchFileBlob`, `getFileMeta`, `getDocumentBySource`; mock `../../hooks/useGeneratedDocument` to control `file/upToDate`; mock `EmailComposer` with a stub that exposes an `onSend` trigger button):
  1. no file → chip "No PDF yet", no Open/Download; Generate → build → persist called with `{kind, sourceType, sourceId, name}` and no `mode`; onGenerated called with returned fileId.
  2. dirty → Generate calls save first; save resolves false → persist NOT called, toast shown.
  3. file exists → Generate opens the dialog; "Overwrite" → persist called with `mode: 'overwrite'`; "Save as new version" → `mode: 'version'`; Cancel → nothing.
  4. Send with `file && upToDate` → build NOT called, sendFn called with file.id.
  5. Send with stale file → dialog → version → build + persist + sendFn with new id.
  6. Send with header override while up to date → build called with `{ headerEmail }`.
  7. Send blocked when dirty (button disabled, title 'Save first'); `send.blockedReason` wins.
  8. Download → fetchFileBlob + downloadBlob (mock `../../utils/download`).
  9. `format: 'xlsx'` labels.
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement** the three components (+ move `downloadBlob`). **Step 4: Run → PASS**, ui suite, lint. **Step 5: Commit** `git commit -am "feat(documents): DocumentActionsBar + status chip + version/overwrite dialog"`

---

### Task 5: `FilePickerModal` Upload tab + `returnBlobs`, `AddFilesButton`, `useDropZone`

**Files:**
- Modify: `src/components/FilePickerModal.tsx` (props ~18-27, render ~135-174), `src/components/FilePickerModal.test.tsx`
- Create: `src/components/documents/AddFilesButton.tsx` (+ `.test.tsx`), `src/hooks/useDropZone.ts` (+ `.test.tsx`)

**Interfaces (produced):**
```tsx
export interface FilePickerUploadConfig { kind: string; projectId?: string; customerId?: string; sourceType?: string; sourceId?: string; accept?: string /* input accept attr */; multi?: boolean }
export interface FilePickerModalProps {
  …existing…;
  upload?: FilePickerUploadConfig;               // enables the Upload tab
  defaultTab?: 'existing' | 'upload';            // default 'existing'
  returnBlobs?: boolean;                         // when true, onPickBlobs is called instead of onPick
  onPickBlobs?: (picked: { row: DocumentRow; blob: Blob }[]) => void | Promise<void>;
}
// AddFilesButton
export interface AddFilesButtonProps {
  label: string;                                 // "Add photos" / "Add files" / "Attach files"
  accept: 'pdf' | 'image' | 'any';
  multi?: boolean;                               // default true
  upload?: FilePickerUploadConfig;
  defaultTab?: 'existing' | 'upload';
  initialProjectIds?: string[];
  excludeFileIds?: string[];
  returnBlobs?: boolean;
  onPick?: (rows: DocumentRow[]) => void | Promise<void>;
  onPickBlobs?: (picked: { row: DocumentRow; blob: Blob }[]) => void | Promise<void>;
  variant?: 'primary' | 'secondary' | 'ghost'; size?: 'sm'; className?: string; disabled?: boolean; title?: string;
}
// useDropZone
export function useDropZone(onFiles: (files: File[]) => void, opts?: { accept?: 'pdf' | 'image' | 'any'; disabled?: boolean }): { dragActive: boolean; dropProps: { onDragEnter, onDragOver, onDragLeave, onDrop } }
```
Upload tab: drag-drop zone + `<input type="file">` (accept/multiple from config, `capture="environment"` when accept is an image and the device is touch — keep simple: pass `capture` through config if needed); uploads via `uploadProjectFile(projectId, f, kind, { sourceType, sourceId })` when `projectId` set, else `saveBinaryFile(uuidv4(), f, { kind, name: f.name, customerId, sourceType, sourceId })`; per-file progress list; partial failure toast "Uploaded X of Y"; resolves each uploaded id to a `DocumentRow` via `getFileMeta` (fill the missing DocumentRow fields with nulls/kind) and calls `onPick(rows)` (or `onPickBlobs` with the original File as blob when `returnBlobs`) then closes. Existing tab: unchanged; when `returnBlobs`, confirm fetches each `fetchFileBlob(row.id)` before calling `onPickBlobs`. Tabs rendered above the filter bar (Existing / Upload) — hidden when `upload` is undefined.

- [ ] **Step 1: Failing tests** — FilePickerModal: Upload tab appears only with `upload`; `defaultTab='upload'` starts there; selecting two files uploads both (mock `uploadProjectFile`), calls `onPick` with rows built from mocked `getFileMeta`, closes; one failure → "Uploaded 1 of 2" toast + onPick with the one; `returnBlobs` on Existing → `onPickBlobs` with blobs from mocked `fetchFileBlob`. AddFilesButton: opens modal with the passed props (mock FilePickerModal and assert props). useDropZone: dragover sets `dragActive`, drop with 2 files (one filtered out by accept) calls `onFiles` with 1; disabled → no-op.
- [ ] **Step 2 → 5:** RED, implement, GREEN, ui suite + lint, commit `git commit -am "feat(files): picker Upload tab + returnBlobs, AddFilesButton, useDropZone"`

---

### Task 6: Invoice + Change order editors → bar; list rows Open + chip

**Files:**
- Modify: `src/pages/project/billing/InvoiceEditor.tsx` (remove `handleDownloadPdf` 169-187, footer 191-195, Send button 235, EmailComposer 268-294; keep `buildBytes`), `ChangeOrderEditor.tsx` (same: 209-227, 235-239, 321-324, 339-351; photos card stays — Task 11 swaps its button), `InvoicesSection.tsx` (~67-75), `ChangeOrdersSection.tsx` (~66-80)
- Tests: `InvoiceEditor.test.tsx` (create if missing), `ChangeOrderEditor.test.tsx`, `InvoicesSection.test.tsx`, `ChangeOrdersSection.test.tsx`

**Consumes:** `DocumentActionsBar`, `useGeneratedDocuments`, `DocumentStatusChip`, `DocumentViewerModal`, `sendInvoice(id, payload)`, `sendChangeOrder(id, payload)`; entity `updatedAt` (Task 1 — add `updatedAt: number` to `Invoice`, `InvoiceListItem`, `ChangeOrder`, `ChangeOrderListItem` types in store.ts).

- [ ] **Step 1: Failing tests** — editor: renders `doc-generate` and `doc-send`, no "Download PDF" button; `build` passed to the bar produces bytes from the **saved** entity (assert `buildInvoicePdf` mock receives the server-loaded invoice after `save` — i.e. the bar's `save` prop calls the editor's save and the editor re-reads via `getInvoice`); list: rows show chip + Open when `getDocumentsBySource` (mocked) returns a file for that id; Open opens the viewer modal (mock it).
- [ ] **Step 2 → 5:** implement:
  - Editor: `const save = async () => { try { await handleSave(); return true; } catch { return false; } }` (existing handleSave returns void; wrap). `build = ({ headerEmail }) => buildBytes(headerEmail).then(b => new Blob([b], { type: 'application/pdf' }))` but `buildBytes` must read the freshly saved entity: after save, call `getInvoice(invoice.id)` and build from that (store in a ref). Bar props: `source={{ sourceType: 'invoice', sourceId: invoice.id }} kind="invoice" format="pdf" fileName={pdfFileName} dirty={dirty} updatedAt={invoice.updatedAt} send={{ composer: { title: 'Send invoice', defaultTo, defaultCc, defaultBcc, defaultSubject, defaultBody, headerEmailOptions, defaultHeaderEmail }, sendFn: (fileId, m) => sendInvoice(invoice.id, { ...m, fileId }).then(onSaved) }}`. Mount the bar in the modal footer (left of Close/Save). CO: `kind: 'change-order'`, `sourceType: 'change-order'`, `sendChangeOrder`.
  - Lists: `const docs = useGeneratedDocuments({ sourceType: 'invoice', kind: 'invoice', sourceIds: rows.map(r => r.id), updatedAtById })`; actions cell gets `<DocumentStatusChip size="sm" …/>` + Open (Eye icon) when `docs.byId[r.id]?.file`; Open → `DocumentViewerModal` (shared small `useDocumentViewer()` helper in `src/components/documents/useDocumentViewer.tsx` returning `{ open(fileId, kind, projectId), modal }` — create it in this task and reuse in Tasks 7–9).
  - Commit `git commit -am "feat(billing): invoice + change order editors use DocumentActionsBar; list rows show PDF status + Open"`

---

### Task 7: Issue + RFI editors → bar (+ RFI response picker); list rows

**Files:** `src/pages/project/issues/IssueEditor.tsx` (remove handleDownload 138-152, action row 232-235, composer 250-262; `openComposer` dirty guard replaced by bar's save-first), `src/pages/project/rfi/RfiEditor.tsx` (173-187, 322-325, 340-352; response card 300-321 gets `AddFilesButton` single/any/global with `upload: { kind: 'rfi-response', projectId, sourceType: 'rfi', sourceId }` → `setRfiResponse(rfi.id, { fileId })` — keep its Download response), `ProjectIssues.tsx` (~88-98), `ProjectRfis.tsx` (~96-110); tests as Task 6.
- Bars: issue `kind 'issue-report'`, source `issue`, fileName `ISS-###.pdf`, `sendIssue`; RFI `kind 'rfi'`, source `rfi`, `RFI-###.pdf`, `sendRfi`. `updatedAt` types added to `Issue/IssueListItem/Rfi/RfiListItem`.
- Commit `git commit -am "feat(issues,rfis): DocumentActionsBar + list status; RFI response via file picker"`

---

### Task 8: Daily report + Punch → bar; daily list rows

**Files:** `src/pages/project/daily/DailyReportEditor.tsx` (197-215, footer 265-269, 379-392), `src/pages/project/ProjectPunch.tsx` (174-188, header 194-197, 296-310 — `buildPunchDoc` returns a jsPDF doc: `build = () => Promise.resolve(new Blob([buildPunchDoc(headerEmail).output('arraybuffer')], { type: 'application/pdf' }))`; `dirty=false`, `save = async () => true`, `updatedAt` = max `updatedAt` of punch items if available else `null` — check `PunchItem` type; if no updatedAt anywhere, pass `null` (chip shows up to date whenever a file exists) and note it), `ProjectDailyReports.tsx` (~121-131); tests.
- Daily: `kind 'daily-report'`, source `dailyReport`, `dailyReportFileName(report, projectName)`, `sendDailyReport`. Punch: `kind 'punch-report'`, source `punch`/`projectId`, `sendPunchReport(projectId, …)`.
- Commit `git commit -am "feat(daily,punch): DocumentActionsBar; daily list status"`

---

### Task 9: AIA pay apps — split `exportAiaXlsx`, xlsx bar, list rows

**Files:** `src/pages/project/billing/aiaExcel.ts` (~607-631: add `export async function buildAiaXlsxBlob(ctx, template?): Promise<Blob>`; make `exportAiaXlsx` = build + optional persist + `downloadBlob` — keep for any other caller, grep), `AiaPayAppEditor.tsx` (183-215 handleExport removed; footer 250-257 → bar with `format: 'xlsx'`, `kind 'payapp-export'`, source `payapp`/`app.id`, fileName `Pay App #N — G702.xlsx`, `build = async () => { const env = await resolveAiaExportEnv(projectId); if (env.templateLoadFailed) toast(...); return buildAiaXlsxBlob(ctx, env.template); }`, `dirty`, `save`, `updatedAt: data.app.updatedAt`, no `send`), `AiaPayApplications.tsx` (~89-105 chip + Open → viewer modal; "Open in editor" from the viewer goes to `/tools/sheets?fileId=` via `openTargetFor` — verify the xlsx mime maps there); tests incl. `aiaExcel.test.ts` build-returns-blob.
- Commit `git commit -am "feat(aia): generate/open Excel via DocumentActionsBar; pay-app list status"`

---

### Task 10: Proposal editor adopts the shared bar

**Files:** `src/pages/project/proposal/ProposalEditor.tsx` (replace `renderAndStore`/`handleGenerate`/`handleSend`/header buttons 168-202 and the EmailComposer with the bar; keep `useProposalEmailDefaults` for `send.composer`), `useProposalDraft.ts` (expose `save(): Promise<boolean>` — already), `ProposalEditor.test.tsx`, `e2e/proposal.spec.ts` (selectors: keep `data-testid="btn-generate-proposal"`/`btn-send-proposal` by passing `testIdPrefix="btn"`? No — bar test ids are `${prefix}-generate`; pass `testIdPrefix="proposal"` and update the e2e to `proposal-generate` / `proposal-send`).
- Bar props: source `proposal`/`proposal.id`, kind `proposal`, fileName `${proposalFileName(project)}.pdf`, `build = ({ headerEmail }) => renderPdf(headerEmail)` (existing), `dirty`, `save`, `updatedAt: proposal.updatedAt`, `readOnly`, `onGenerated = fileId => setProposalFile(proposal.id, fileId).then(reload)`, `send.blockedReason = draft.lines.length === 0 ? 'Add at least one price line' : undefined`, `send.sendFn = (fileId, m) => sendProposal(proposal.id, { ...m, fileId }).then(() => reload())` (ProposalLockedError → toast + reload as today). Remove the always-regenerate behavior (spec: reuse if up to date).
- Commit `git commit -am "refactor(proposals): editor uses the shared DocumentActionsBar"`

---

### Task 11: Photo cards + EmailComposer → `AddFilesButton` + drag-and-drop

**Files:** `IssueEditor.tsx` (photos card 206-231), `RfiEditor.tsx` (274-299), `ChangeOrderEditor.tsx` (294-319), `DailyReportEditor.tsx` (340-364), `src/pages/project/punch/PunchItemEditor.tsx` (105-128 per stage), `src/pages/tasks/TaskEditor.tsx` (~180-200 per stage; keep its `saveBinaryFile` path with project-or-customer attribution → pass `upload: { kind: 'task-photo', projectId?, customerId?, sourceType: 'task', sourceId }`), `src/components/EmailComposer.tsx` (226-233: replace the Add attachment input with `AddFilesButton label="Attach files" accept="any" defaultTab="existing" upload={{ kind: 'email-attachment', projectId }} onPick={rows => append {fileId: row.id, name: row.name}}` — global picker: no `initialProjectIds`), plus the proposal photo/attachment cards (`ProposalPhotosCard`, `ProposalAttachmentsCard`) switch their two buttons to one `AddFilesButton`.
- Each photo card: `AddFilesButton label="Add photos" accept="image" defaultTab="upload" upload={{ kind: '<x>-photo', projectId, sourceType, sourceId, accept: 'image/*' }} initialProjectIds={[projectId]} excludeFileIds={photos.map(p => p.fileId)} onPick={rows => for each addXPhoto(id, row.id) then reload}` (RFI/daily keep their dirty guard by passing `disabled={dirty} title="Save your changes first"`). Card root gets `useDropZone(files => uploadThenAdd(files), { accept: 'image' })` with a visible drag highlight (`ring-2 ring-accent-500` when `dragActive`).
- Tests: one per card (button present, old input gone, onPick adds via mocked API, drop calls upload); EmailComposer test updated.
- Commit `git commit -am "feat(files): AddFilesButton + drag-and-drop on every photo/attachment card and the email composer"`

---

### Task 12: Plan-set, PDF editor, spreadsheet editor, SOV import pickers

**Files:** `src/components/AddPagesModal.tsx` (223-239: add `AddFilesButton label="Choose from documents" accept="pdf" returnBlobs onPickBlobs={picked => setNewPlanSetFiles(prev => [...prev, ...picked.map(p => new File([p.blob], p.row.name ?? 'plan.pdf', { type: 'application/pdf' }))])}` beside the existing input — the split pipeline consumes `File[]` unchanged), `src/pages/NewProject.tsx` (910-917 same), `src/pages/PdfEditor.tsx` (toolbar: "Open from documents" → `AddFilesButton accept="pdf" multi={false} onPick={rows => navigate(`/tools/pdf?fileId=${rows[0].id}`)}`; "Import pages from documents" → `returnBlobs` → `importPages(new File([blob], name))`; "Insert image from documents" → `accept="image" returnBlobs` → `insertImageFile(file)`), `src/pages/SpreadsheetEditor.tsx` (937-949: "Open from documents" → navigate `/tools/sheets?fileId=`), `src/pages/project/billing/AiaScheduleOfValues.tsx` (138+: "Import from documents" → `accept="any" returnBlobs multi={false}` → run the existing parse on `blob.arrayBuffer()`; filter to spreadsheet mimes via the picker's kinds/mimes — pass `initialKinds?` no; the picker's `accept` only knows pdf/image/any; add `accept: 'spreadsheet'` → mimes `['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.ms-excel','text/csv']` to `FilePickerModal.MIMES` and `AddFilesButton` in this task).
- Tests: AddPagesModal/NewProject (picked blob becomes a File in state), PdfEditor/SpreadsheetEditor (button navigates / calls handler — keep light: mock AddFilesButton and assert wiring), SOV import (mocked blob parses lines).
- Commit `git commit -am "feat(files): pick existing files for plan sets, PDF/spreadsheet editors and SOV import"`

---

### Task 13: E2E, changelog v2.9.0, full verification

**Files:** `e2e/document-actions.spec.ts` (new), `e2e/proposal.spec.ts` (updated ids from Task 10), `src/pages/Settings.tsx` (changelog entry v2.9.0 — mention migration 30 additive).
- e2e 1 (admin): seed project + invoice via API (`POST /api/projects/:id/invoices`, see `seedCustomerWithPortfolio` in `e2e/fixtures/seed.ts:761`), open the invoice editor (Billing → Invoices tab → row), assert chip "No PDF yet", click `doc-generate`, assert chip "PDF up to date" and Open/Download visible; edit a line and Save → chip "PDF out of date"; click `doc-generate` → dialog → "Save as new version" → chip up to date; `GET /api/files/:id/versions` shows 2 rows.
- e2e 2: issue editor → "Add photos" opens the picker on the Upload tab; upload one image via `setInputFiles`; photo appears.
- Run `npm run lint`, `npm test`, `npm run build`, `npm run test:e2e` (report exact counts; re-run known flaky specs once).
- Commit `git commit -am "test: document-actions e2e; docs: changelog v2.9.0"`
