# Proposal Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn proposals into first-class, numbered, versioned project entities with mixed takeoff/manual price lines, alternates, photos, PDF attachments, revise-with-lineage, and admin-only lifecycle — and move takeoff prints out of the proposal page into Documents.

**Architecture:** New `proposals` / `proposal_lines` / `proposal_photos` / `proposal_attachments` tables (migration 28, which also converts legacy `project.printouts[]`/`proposalPhotoIds` data). Server gets `proposalStore.ts` (pure SQL functions, pattern of `dailyReportStore.ts`) + `proposalRoutes.ts` (admin-gated, registered from `routes.ts`). Client replaces the 947-line `ProjectProposal.tsx` with a list page + full-page editor built from focused cards, a reusable `FilePickerModal`, and a refactored jsPDF/pdf-lib generator that renders from the saved proposal snapshot.

**Tech Stack:** TypeScript, Express + better-sqlite3 (server), React 18 + react-router + Tailwind (client), jsPDF + pdf-lib (PDF), vitest (unit; `server` + `ui` projects), Playwright (e2e), `uuid` package for ids (never `crypto.randomUUID` in client code — plain-HTTP LAN has no secure context).

**Spec:** `docs/superpowers/specs/2026-08-28-proposal-rework-design.md`

## Global Constraints

- Git: commit each task; push to `testing` branch only (`git push origin testing`). No PRs.
- Client ids: `import { v4 as uuidv4 } from 'uuid'`. Server may use `crypto.randomUUID()` (node) — existing stores do; `uuid` is also fine.
- Money is integer cents everywhere in the new tables (`amountCents`), matching billing.
- Proposal number is INTERNAL ONLY: never on the PDF, never in the filename. Filename = `Proposal – <project name> – <YYYY-MM-DD>.pdf`.
- Takeoff print filename = `Takeoff Print – <project name> – <YYYY-MM-DD>`; Excel = `Takeoff Export – <project name> – <YYYY-MM-DD>`.
- Proposals are ADMIN-ONLY: every proposal route uses `authenticateToken, requireAdmin`; the `proposal` and `proposal-signed` document kinds are in `NON_ADMIN_EXCLUDED_KINDS`; client pages redirect non-admins.
- Locking: any write to a proposal whose `status !== 'draft'` or `legacy = 1` → 409, except status transitions `sent → accepted|declined` and setting `signedFileId` on a sent/accepted proposal.
- Kind vocabularies are mirrored in THREE places and must be edited together: `server/files.ts` `SYSTEM_KINDS`, `server/documents.ts` `KIND_LABELS`, `src/pages/documents/docTypes.ts` `KIND_META`.
- Run `npm test` (vitest, both projects) and `npm run lint` (tsc) before every commit. E2E: `npm run test:e2e` (needs Chromium libs; if unavailable, say so in the task report rather than claiming it ran).
- Migration 28 transforms real data. It runs automatically on next server start against `testing` data; Nathan must be told before the Unraid pull (memory: migration testing protocol). Nothing in this plan runs it against production.

---

## File Structure

**Server (new):**
- `server/proposalStore.ts` — all SQL for proposals/lines/photos/attachments; numbering; lock checks; revise/copy.
- `server/proposalStore.test.ts`
- `server/proposalRoutes.ts` — `registerProposalRoutes(app, deps)`; CRUD, photos, attachments, status, send, outstanding.
- `server/proposalRoutes.test.ts`

**Server (modified):**
- `server/migrationList.ts` — migration 28.
- `server/migrationList.test.ts` — migration 28 tests.
- `server/files.ts` — `SYSTEM_KINDS` + `DIRECT_UPLOAD_KINDS` additions.
- `server/documents.ts` — labels, `NON_ADMIN_EXCLUDED_KINDS`, resolvers, `mimes` filter, delete guard for proposal-referenced files, `resolvePrintouts` removed.
- `server/documents.test.ts`
- `server/routes.ts` — remove `/send-proposal`; register proposal routes; `mimes` query param; `company-document` accepted without projectId (already allowed — verify).
- `server/projectStore.ts` — remove `droppedSourceFileIds` printouts/proposalPhotoIds cascade.
- `server/projectStore.test.ts` — drop the cascade tests.

**Client (new):**
- `src/pages/project/proposal/proposalMath.ts` (+ `.test.ts`) — pure: line totals, override detection, measurement summary, derive/re-derive.
- `src/pages/project/proposal/ProposalsList.tsx`
- `src/pages/project/proposal/ProposalEditor.tsx`
- `src/pages/project/proposal/PricingLinesCard.tsx` (+ `.test.tsx`)
- `src/pages/project/proposal/InclusionsExclusionsCard.tsx`
- `src/pages/project/proposal/PaymentScheduleCard.tsx`
- `src/pages/project/proposal/ProposalOptionsCard.tsx`
- `src/pages/project/proposal/ProposalPhotosCard.tsx`
- `src/pages/project/proposal/ProposalAttachmentsCard.tsx`
- `src/pages/project/proposal/ReviseDialog.tsx`
- `src/pages/project/proposal/AcceptDialog.tsx`
- `src/pages/project/proposal/HistoryMenu.tsx` (moved out of ProjectProposal.tsx)
- `src/pages/project/proposal/proposalLetterhead.ts` — shared `buildLetterhead(settings, headerEmail?)` (extracted from the duplicated logo/brand code).
- `src/components/FilePickerModal.tsx` (+ `.test.tsx`)
- `e2e/proposal.spec.ts`

**Client (modified):**
- `src/types.ts` — remove `Printout` + six legacy `Project` fields.
- `src/utils/store.ts` — proposal API helpers + types; `mimes` in `DocumentFilters`; remove `sendProjectProposal`.
- `src/pages/documents/docTypes.ts` — new kinds; `company-document` direct-upload.
- `src/pages/documents/UploadDocumentsModal.tsx` — allow no project for `company-document`.
- `src/pages/project/proposal/proposalGenerator.ts` — new signature + layout.
- `src/pages/project/proposal/proposalGenerator.test.ts`
- `src/pages/project/ProjectTakeoffsTab.tsx`, `src/pages/ProjectView.tsx` — print/export/proposal buttons.
- `src/App.tsx`, `src/components/shell/Sidebar.tsx`, `src/components/CommandPalette.tsx` — routes + admin gating.
- `src/pages/Dashboard.tsx` — outstanding proposals card.
- `e2e/export.spec.ts`, `e2e/documents.spec.ts`

**Deleted:** `src/pages/project/ProjectProposal.tsx`.

---

### Task 1: Migration 28 — proposal tables + legacy data transform

**Files:**
- Modify: `server/migrationList.ts` (append after version 27, ~line 1250)
- Test: `server/migrationList.test.ts`

**Interfaces:**
- Produces tables `proposals`, `proposal_lines`, `proposal_photos`, `proposal_attachments` exactly as in spec §3. Columns are referenced verbatim by Task 3.
- Legacy rows get `legacy = 1`; file rows for takeoff prints get `kind = 'takeoff-print' | 'takeoff-export'`, `sourceType = 'takeoff-print'`, `sourceId = <old printout id>`.

- [ ] **Step 1: Write the failing tests**

Append to `server/migrationList.test.ts`:

```ts
describe('migration 28 — proposals', () => {
  // Seeds a project whose meta carries the legacy printouts/proposal shape,
  // runs everything up to 27, then 28 on top.
  const seedLegacy = () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    runMigrations(db, dir, migrations.filter(m => m.version <= 27));
    const meta = {
      printouts: [
        { id: 'po-prop-1', name: 'Proposal – Old Job', fileId: 'f-prop-1', createdAt: 1000, type: 'pdf' },
        { id: 'po-print-1', name: 'Printout - 1/2/2026, 9:00:00 AM', fileId: 'f-print-1', createdAt: 2000, type: 'pdf' },
        { id: 'po-xls-1', name: 'Excel Export - 1/2/2026, 9:05:00 AM', fileId: 'f-xls-1', createdAt: 3000, type: 'excel' },
        { id: 'po-prop-2', name: 'Proposal – Old Job', fileId: 'f-prop-2', createdAt: 4000, type: 'pdf' },
      ],
      proposalFileId: 'f-prop-2',
      proposalSentAt: 4500,
      proposalPhotoIds: ['f-photo-1', 'f-photo-2'],
      proposalCoverNotes: 'notes here',
      proposalTerms: 'terms here',
      legendOnAllPages: true,
    };
    db.prepare(`INSERT INTO projects (id, name, createdAt, version, updatedAt, meta) VALUES ('p1', 'Old Job', 1, 1, 1, ?)`).run(JSON.stringify(meta));
    const ins = db.prepare(`INSERT INTO files (id, projectId, name, mime, size, sha256, kind, parentFileId, versionNumber, legacyFormat, createdAt, sourceType, sourceId, archived)
      VALUES (?, 'p1', ?, ?, 1, 'x', ?, NULL, 1, NULL, ?, ?, ?, 0)`);
    ins.run('f-prop-1', 'Proposal – Old Job', 'application/pdf', 'printout', 1000, 'printout', 'po-prop-1');
    ins.run('f-print-1', 'Printout - 1/2/2026, 9:00:00 AM', 'application/pdf', 'printout', 2000, 'printout', 'po-print-1');
    ins.run('f-xls-1', 'Excel Export - 1/2/2026, 9:05:00 AM', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'printout', 3000, 'printout', 'po-xls-1');
    ins.run('f-prop-2', 'Proposal – Old Job', 'application/pdf', 'proposal', 4000, 'proposal', 'p1');
    ins.run('f-photo-1', 'a.jpg', 'image/jpeg', 'proposal-photo', 100, 'proposal', 'p1');
    ins.run('f-photo-2', 'b.jpg', 'image/jpeg', 'proposal-photo', 101, 'proposal', 'p1');
    runMigrations(db, dir, migrations.filter(m => m.version <= 28));
    return db;
  };

  it('creates the four tables', () => {
    const db = seedLegacy();
    const tables = tableNames(db);
    for (const t of ['proposals', 'proposal_lines', 'proposal_photos', 'proposal_attachments']) expect(tables).toContain(t);
    for (const c of ['number', 'revisedFromId', 'status', 'legacy', 'inclusions', 'exclusions', 'paymentSchedule', 'showGrandTotal', 'fileId', 'signedFileId', 'sentTo', 'version']) {
      expect(columnNames(db, 'proposals')).toContain(c);
    }
    for (const c of ['kind', 'takeoffId', 'amountCents', 'derivedAmountCents', 'measurementSummary', 'isAlternate']) {
      expect(columnNames(db, 'proposal_lines')).toContain(c);
    }
    expect(columnNames(db, 'proposal_photos')).toContain('caption');
    db.close();
  });

  it('converts legacy proposal printouts into numbered legacy proposals, sent = the one matching proposalFileId', () => {
    const db = seedLegacy();
    const rows = db.prepare('SELECT * FROM proposals WHERE projectId = ? ORDER BY number').all('p1') as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ number: 1, legacy: 1, status: 'draft', fileId: 'f-prop-1', coverNotes: 'notes here', terms: 'terms here' });
    expect(rows[1]).toMatchObject({ number: 2, legacy: 1, status: 'sent', fileId: 'f-prop-2', sentAt: 4500 });
    // file rows re-pointed at the proposal id under kind 'proposal'
    const f1 = db.prepare('SELECT kind, sourceType, sourceId FROM files WHERE id = ?').get('f-prop-1') as any;
    expect(f1).toEqual({ kind: 'proposal', sourceType: 'proposal', sourceId: rows[0].id });
    const f2 = db.prepare('SELECT kind, sourceType, sourceId FROM files WHERE id = ?').get('f-prop-2') as any;
    expect(f2).toEqual({ kind: 'proposal', sourceType: 'proposal', sourceId: rows[1].id });
    db.close();
  });

  it('attaches legacy proposal photos to the LATEST legacy proposal', () => {
    const db = seedLegacy();
    const latest = db.prepare('SELECT id FROM proposals WHERE projectId = ? ORDER BY number DESC LIMIT 1').get('p1') as any;
    const photos = db.prepare('SELECT fileId, sortOrder FROM proposal_photos WHERE proposalId = ? ORDER BY sortOrder').all(latest.id) as any[];
    expect(photos).toEqual([{ fileId: 'f-photo-1', sortOrder: 0 }, { fileId: 'f-photo-2', sortOrder: 1 }]);
    const ph = db.prepare('SELECT sourceType, sourceId FROM files WHERE id = ?').get('f-photo-1') as any;
    expect(ph).toEqual({ sourceType: 'proposal', sourceId: latest.id });
    db.close();
  });

  it('relabels takeoff printouts/exports with the new kinds + names', () => {
    const db = seedLegacy();
    const pr = db.prepare('SELECT kind, name, sourceType, sourceId FROM files WHERE id = ?').get('f-print-1') as any;
    expect(pr.kind).toBe('takeoff-print');
    expect(pr.sourceType).toBe('takeoff-print');
    expect(pr.sourceId).toBe('po-print-1');
    expect(pr.name).toMatch(/^Takeoff Print – Old Job – \d{4}-\d{2}-\d{2}$/);
    const xl = db.prepare('SELECT kind, name, sourceType FROM files WHERE id = ?').get('f-xls-1') as any;
    expect(xl.kind).toBe('takeoff-export');
    expect(xl.sourceType).toBe('takeoff-print');
    expect(xl.name).toMatch(/^Takeoff Export – Old Job – \d{4}-\d{2}-\d{2}$/);
    db.close();
  });

  it('strips the six legacy keys from project meta and leaves the rest', () => {
    const db = seedLegacy();
    const meta = JSON.parse((db.prepare('SELECT meta FROM projects WHERE id = ?').get('p1') as any).meta);
    for (const k of ['printouts', 'proposalFileId', 'proposalSentAt', 'proposalPhotoIds', 'proposalCoverNotes', 'proposalTerms']) {
      expect(meta).not.toHaveProperty(k);
    }
    expect(meta.legendOnAllPages).toBe(true);
    db.close();
  });

  it('is idempotent on a project with no legacy keys', () => {
    const dir = tmpDir();
    const db = openDb(':memory:');
    runMigrations(db, dir, migrations.filter(m => m.version <= 27));
    db.prepare(`INSERT INTO projects (id, name, createdAt, version, updatedAt, meta) VALUES ('p2', 'Clean', 1, 1, 1, '{}')`).run();
    runMigrations(db, dir, migrations.filter(m => m.version <= 28));
    expect(db.prepare('SELECT COUNT(*) c FROM proposals').get()).toEqual({ c: 0 });
    db.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/migrationList.test.ts -t "migration 28"`
Expected: FAIL — `proposals` table missing.

- [ ] **Step 3: Implement migration 28**

Append to the `migrations` array in `server/migrationList.ts` (after the version 27 entry, before the closing `];`):

```ts
  {
    version: 28,
    name: 'proposals',
    // DATA-TRANSFORMING (supervised). Proposals become first-class rows
    // (spec 2026-08-28 §3). Legacy project-meta proposals/printouts are
    // converted: proposal printouts → numbered `legacy=1` proposal rows;
    // remaining printouts → takeoff-print/takeoff-export documents; the six
    // legacy meta keys are stripped. File bytes are never touched.
    up({ db }) {
      db.exec(`
        CREATE TABLE proposals (
          id TEXT PRIMARY KEY,
          projectId TEXT NOT NULL,
          number INTEGER NOT NULL,
          revisedFromId TEXT,
          status TEXT NOT NULL DEFAULT 'draft',
          legacy INTEGER NOT NULL DEFAULT 0,
          title TEXT,
          validUntil TEXT,
          fontFamily TEXT,
          coverNotes TEXT,
          terms TEXT,
          inclusions TEXT NOT NULL DEFAULT '[]',
          exclusions TEXT NOT NULL DEFAULT '[]',
          paymentSchedule TEXT,
          showGrandTotal INTEGER NOT NULL DEFAULT 1,
          includeCostDetail INTEGER NOT NULL DEFAULT 0,
          includeSignature INTEGER NOT NULL DEFAULT 1,
          highlightQuality TEXT NOT NULL DEFAULT 'best',
          fileId TEXT,
          signedFileId TEXT,
          sentAt INTEGER,
          sentTo TEXT,
          acceptedAt INTEGER,
          declinedAt INTEGER,
          version INTEGER NOT NULL DEFAULT 1,
          createdBy TEXT,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL,
          UNIQUE(projectId, number)
        );
        CREATE INDEX idx_proposals_project ON proposals(projectId);
        CREATE INDEX idx_proposals_status ON proposals(status);
        CREATE TABLE proposal_lines (
          id TEXT PRIMARY KEY,
          proposalId TEXT NOT NULL,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          kind TEXT NOT NULL,
          takeoffId TEXT,
          description TEXT NOT NULL DEFAULT '',
          amountCents INTEGER NOT NULL DEFAULT 0,
          derivedAmountCents INTEGER,
          measurementSummary TEXT,
          isAlternate INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_proposal_lines_proposal ON proposal_lines(proposalId);
        CREATE TABLE proposal_photos (
          id TEXT PRIMARY KEY,
          proposalId TEXT NOT NULL,
          fileId TEXT NOT NULL,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          caption TEXT,
          createdAt INTEGER NOT NULL,
          UNIQUE(proposalId, fileId)
        );
        CREATE INDEX idx_proposal_photos_proposal ON proposal_photos(proposalId);
        CREATE TABLE proposal_attachments (
          id TEXT PRIMARY KEY,
          proposalId TEXT NOT NULL,
          fileId TEXT NOT NULL,
          sortOrder INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL,
          UNIQUE(proposalId, fileId)
        );
        CREATE INDEX idx_proposal_attachments_proposal ON proposal_attachments(proposalId);
      `);

      const LEGACY_KEYS = ['printouts', 'proposalFileId', 'proposalSentAt', 'proposalPhotoIds', 'proposalCoverNotes', 'proposalTerms'];
      const isoDate = (ts: number) => new Date(Number.isFinite(ts) ? ts : Date.now()).toISOString().slice(0, 10);
      const fileKind = db.prepare('SELECT kind, name FROM files WHERE id = ?');
      const setFile = db.prepare('UPDATE files SET kind = ?, name = ?, sourceType = ?, sourceId = ? WHERE id = ?');
      const setFileSource = db.prepare('UPDATE files SET sourceType = ?, sourceId = ? WHERE id = ?');
      const insProposal = db.prepare(`INSERT INTO proposals
        (id, projectId, number, status, legacy, coverNotes, terms, fileId, sentAt, version, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 1, ?, ?)`);
      const insPhoto = db.prepare('INSERT OR IGNORE INTO proposal_photos (id, proposalId, fileId, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?)');

      const rows = db.prepare('SELECT id, name, meta FROM projects ORDER BY createdAt, id').all() as { id: string; name: string | null; meta: string | null }[];
      let proposalsMade = 0, printsRelabeled = 0, photosMoved = 0;
      for (const row of rows) {
        let p: any = null;
        try { p = row.meta ? JSON.parse(row.meta) : null; } catch { console.warn(`[migrations] 28: project ${row.id} has unparseable meta (skipped)`); continue; }
        if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
        if (!LEGACY_KEYS.some(k => k in p)) continue; // already migrated / never had proposals

        const projectName = (row.name && row.name.trim()) || 'Untitled';
        const printouts: any[] = Array.isArray(p.printouts) ? p.printouts.filter((x: any) => x && typeof x === 'object' && typeof x.fileId === 'string') : [];
        const isProposalPrintout = (po: any) => {
          const f = fileKind.get(po.fileId) as { kind: string; name: string | null } | undefined;
          if (f?.kind === 'proposal') return true;
          const nm = String(po.name ?? f?.name ?? '');
          return /^Proposal\b/i.test(nm);
        };
        const proposalPrintouts = printouts.filter(isProposalPrintout).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
        const otherPrintouts = printouts.filter(po => !isProposalPrintout(po));

        let lastProposalId: string | null = null;
        proposalPrintouts.forEach((po, i) => {
          const id = crypto.randomUUID();
          const createdAt = Number.isFinite(po.createdAt) ? po.createdAt : Date.now();
          const isSent = typeof p.proposalFileId === 'string' && p.proposalFileId === po.fileId;
          insProposal.run(id, row.id, i + 1, isSent ? 'sent' : 'draft',
            typeof p.proposalCoverNotes === 'string' ? p.proposalCoverNotes : null,
            typeof p.proposalTerms === 'string' ? p.proposalTerms : null,
            po.fileId, isSent && Number.isFinite(p.proposalSentAt) ? p.proposalSentAt : null,
            createdAt, createdAt);
          const f = fileKind.get(po.fileId) as { kind: string; name: string | null } | undefined;
          if (f) setFile.run('proposal', f.name ?? po.name ?? null, 'proposal', id, po.fileId);
          lastProposalId = id;
          proposalsMade++;
        });
        // proposalFileId not among the printouts (sent via regenerate path) —
        // still becomes its own sent proposal so the sent PDF isn't orphaned.
        if (typeof p.proposalFileId === 'string' && p.proposalFileId && !proposalPrintouts.some(po => po.fileId === p.proposalFileId) && fileKind.get(p.proposalFileId)) {
          const id = crypto.randomUUID();
          const ts = Number.isFinite(p.proposalSentAt) ? p.proposalSentAt : Date.now();
          insProposal.run(id, row.id, proposalPrintouts.length + 1, 'sent',
            typeof p.proposalCoverNotes === 'string' ? p.proposalCoverNotes : null,
            typeof p.proposalTerms === 'string' ? p.proposalTerms : null,
            p.proposalFileId, ts, ts, ts);
          const f = fileKind.get(p.proposalFileId) as { kind: string; name: string | null };
          setFile.run('proposal', f.name, 'proposal', id, p.proposalFileId);
          lastProposalId = id;
          proposalsMade++;
        }

        const photoIds: string[] = Array.isArray(p.proposalPhotoIds) ? p.proposalPhotoIds.filter((x: any) => typeof x === 'string' && x) : [];
        if (lastProposalId && photoIds.length) {
          photoIds.forEach((fid, i) => {
            if (!fileKind.get(fid)) return;
            insPhoto.run(crypto.randomUUID(), lastProposalId, fid, i, Date.now());
            setFileSource.run('proposal', lastProposalId, fid);
            photosMoved++;
          });
        }
        // No proposal to hang them on: photos stay as proposal-photo uploads
        // attributed to the project (sourceType cleared so they're loose).
        if (!lastProposalId && photoIds.length) {
          photoIds.forEach(fid => { if (fileKind.get(fid)) setFileSource.run(null, null, fid); });
        }

        for (const po of otherPrintouts) {
          const f = fileKind.get(po.fileId) as { kind: string; name: string | null } | undefined;
          if (!f) continue;
          const isExcel = po.type === 'excel' || /\.xlsx$/i.test(String(po.name ?? f.name ?? ''));
          const kind = isExcel ? 'takeoff-export' : 'takeoff-print';
          const name = `${isExcel ? 'Takeoff Export' : 'Takeoff Print'} – ${projectName} – ${isoDate(po.createdAt)}`;
          const srcId = typeof po.id === 'string' && po.id ? po.id : crypto.randomUUID();
          setFile.run(kind, name, 'takeoff-print', srcId, po.fileId);
          printsRelabeled++;
        }

        for (const k of LEGACY_KEYS) delete p[k];
        db.prepare('UPDATE projects SET meta = ? WHERE id = ?').run(JSON.stringify(p), row.id);
      }
      console.log(`[migrations] 28: ${proposalsMade} legacy proposals, ${photosMoved} photos moved, ${printsRelabeled} takeoff prints relabeled`);
    },
  },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run server/migrationList.test.ts`
Expected: PASS (all, including the pre-existing suites — migration 23 tests still pass because 28 only runs when included).

Note: `server/migrationList.test.ts` has a test asserting the latest version / table list somewhere near the top (`describe('migrations 1-3…')` and possibly a "runs all migrations" test). If a test enumerates expected tables for a full run, add the four new tables to it.

- [ ] **Step 5: Run the whole server project + lint, commit**

```bash
npx vitest run --project server && npm run lint
git add server/migrationList.ts server/migrationList.test.ts
git commit -m "feat(proposals): migration 28 — proposal tables + legacy printout/proposal conversion"
```

---

### Task 2: Server document kinds, resolvers, guards, `mimes` filter

**Files:**
- Modify: `server/files.ts:46-69`
- Modify: `server/documents.ts` (KIND_LABELS ~line 19, NON_ADMIN_EXCLUDED_KINDS :15, DocumentFilters :39, listDocuments :99, SIMPLE_RESOLVERS :211, resolvePrintouts :266, deleteDocument :410)
- Modify: `server/routes.ts:1133-1163` (`mimes` param)
- Test: `server/documents.test.ts`

**Interfaces:**
- Produces: `DocumentFilters.mimes?: string[]` — prefix match (`'application/pdf'`, `'image/'`).
- Produces: kinds `takeoff-print`, `takeoff-export`, `company-document`, `proposal-signed` known to the server; `company-document` is a direct-upload kind.
- Produces: `deleteDocument` refuses (409) files referenced by `proposal_photos.fileId`, `proposal_attachments.fileId`, `proposals.fileId`, `proposals.signedFileId`.
- Source resolution: `sourceType 'proposal'` → looks up `proposals` table, label `Proposal #<number>`, href `/project/<pid>/proposal/<id>`; `sourceType 'takeoff-print'` → label = file name, href `/project/<pid>/takeoff`.

- [ ] **Step 1: Write the failing tests**

Append to `server/documents.test.ts` (inside the file's existing structure, using its `upload`, `buildApp`, `app`, `db` helpers; the `beforeEach` already creates project `p1`):

```ts
describe('proposal rework kinds', () => {
  const insertProposal = (id: string, number: number, projectId = 'p1') =>
    db.prepare(`INSERT INTO proposals (id, projectId, number, status, createdAt, updatedAt) VALUES (?, ?, ?, 'draft', 1, 1)`).run(id, projectId, number);

  it('resolves a proposal document to "Proposal #n" with an editor href', async () => {
    insertProposal('prop-1', 3);
    await upload('f1', { projectId: 'p1', kind: 'proposal', name: 'Proposal – Test – 2026-08-28', sourceType: 'proposal', sourceId: 'prop-1' });
    const res = await request(app).get('/api/documents');
    const row = res.body.rows.find((r: any) => r.id === 'f1');
    expect(row.source).toEqual({ type: 'proposal', id: 'prop-1', label: 'Proposal #3', href: '/project/p1/proposal/prop-1' });
  });

  it('resolves a takeoff-print to its own name with the Takeoffs-tab href', async () => {
    await upload('f2', { projectId: 'p1', kind: 'takeoff-print', name: 'Takeoff Print – Test – 2026-08-28', sourceType: 'takeoff-print', sourceId: 'po-9' });
    const res = await request(app).get('/api/documents');
    const row = res.body.rows.find((r: any) => r.id === 'f2');
    expect(row.source).toEqual({ type: 'takeoff-print', id: 'po-9', label: 'Takeoff Print – Test – 2026-08-28', href: '/project/p1/takeoff' });
  });

  it('hides proposal + proposal-signed from non-admins but shows takeoff prints', async () => {
    insertProposal('prop-1', 1);
    await upload('f1', { projectId: 'p1', kind: 'proposal', name: 'p', sourceType: 'proposal', sourceId: 'prop-1' });
    await upload('f2', { projectId: 'p1', kind: 'proposal-signed', name: 's', sourceType: 'proposal', sourceId: 'prop-1' });
    await upload('f3', { projectId: 'p1', kind: 'takeoff-print', name: 't', sourceType: 'takeoff-print', sourceId: 'po-1' });
    const res = await request(buildApp('user')).get('/api/documents');
    const ids = res.body.rows.map((r: any) => r.id);
    expect(ids).not.toContain('f1');
    expect(ids).not.toContain('f2');
    expect(ids).toContain('f3');
  });

  it('accepts company-document as a direct-upload kind with no project', async () => {
    await upload('f4', { kind: 'company-document', name: 'Warranty.pdf' });
    const res = await request(app).get('/api/documents?kinds=company-document');
    expect(res.body.rows.map((r: any) => r.id)).toEqual(['f4']);
    // and it can be re-typed / deleted like any direct upload
    const del = await request(app).delete('/api/files/f4');
    expect(del.status).toBe(200);
  });

  it('filters by mime prefix', async () => {
    await request(app).post('/api/files/pdf1?projectId=p1&kind=document&name=a.pdf').set('Content-Type', 'application/pdf').send(Buffer.from('%PDF'));
    await request(app).post('/api/files/img1?projectId=p1&kind=photo&name=a.jpg').set('Content-Type', 'image/jpeg').send(Buffer.from('x'));
    const pdfs = await request(app).get('/api/documents?mimes=application/pdf');
    expect(pdfs.body.rows.map((r: any) => r.id)).toEqual(['pdf1']);
    const imgs = await request(app).get('/api/documents?mimes=image/');
    expect(imgs.body.rows.map((r: any) => r.id)).toEqual(['img1']);
  });

  it('refuses to delete a file referenced by a proposal (photo, attachment, pdf, signed)', async () => {
    insertProposal('prop-1', 1);
    await upload('att', { projectId: 'p1', kind: 'document', name: 'spec.pdf' });
    db.prepare(`INSERT INTO proposal_attachments (id, proposalId, fileId, sortOrder, createdAt) VALUES ('a1', 'prop-1', 'att', 0, 1)`).run();
    const res = await request(app).delete('/api/files/att');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/proposal/i);
    await upload('ph', { projectId: 'p1', kind: 'photo', name: 'x.jpg' });
    db.prepare(`INSERT INTO proposal_photos (id, proposalId, fileId, sortOrder, createdAt) VALUES ('p1x', 'prop-1', 'ph', 0, 1)`).run();
    expect((await request(app).delete('/api/files/ph')).status).toBe(409);
  });
});
```

Also UPDATE the existing test in this file that asserts a `printout` row's href is `/project/p1/proposal` (search `resolvePrintouts` / `'printout'` cases around lines 242 and 304): change the expectation to whatever it now is under the new resolver — a `kind:'printout'` row with `sourceType:'printout'` no longer has a resolver, so it should come back with `source: { type: 'printout', id, label: 'Printout', href: null }`. Simplest: change those tests to upload with `kind: 'takeoff-print', sourceType: 'takeoff-print'` and assert the new label/href (the legacy `printout` kind no longer exists after migration 28).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/documents.test.ts`
Expected: FAIL (unknown kinds rejected / wrong source shapes / mimes ignored / delete returns 200).

- [ ] **Step 3: Implement**

`server/files.ts`:
```ts
export const SYSTEM_KINDS = [
  'plan-source', 'plan', 'proposal', 'proposal-photo', 'proposal-signed', 'printout',
  'takeoff-print', 'takeoff-export',
  'invoice', 'change-order', 'change-order-photo', 'issue-report',
  'issue-photo', 'punch-report', 'punch-photo', 'rfi', 'rfi-photo',
  'rfi-response', 'task-photo', 'payapp-export', 'email-attachment',
  'settings-asset', 'daily-report', 'daily-report-photo',
] as const;
// ...
export const DIRECT_UPLOAD_KINDS = ['document', 'spreadsheet', 'photo', 'other', 'company-document'] as const;
```

`server/documents.ts`:
```ts
export const NON_ADMIN_EXCLUDED_KINDS = ['invoice', 'payapp-export', 'change-order', 'proposal', 'proposal-signed'] as const;

// KIND_LABELS additions:
  'proposal-signed': 'Signed Proposal',
  'takeoff-print': 'Takeoff Print',
  'takeoff-export': 'Takeoff Export',
  'company-document': 'Company Document',

// DocumentFilters addition:
  // Mime prefix filter (e.g. ['application/pdf'] or ['image/']) — used by the
  // FilePickerModal's `accept` option. OR'd together.
  mimes?: string[];

// in listDocuments, after the `q` clause:
  if (filters.mimes?.length) {
    where.push(`(${filters.mimes.map(() => 'f.mime LIKE ?').join(' OR ')})`);
    params.push(...filters.mimes.map(m => `${m}%`));
  }

// SIMPLE_RESOLVERS: REPLACE the `proposal` entry:
  proposal: {
    sql: ph => `SELECT id, number FROM proposals WHERE id IN (${ph})`,
    label: row => `Proposal #${row.number ?? '?'}`,
    href: pid => pid ? `/project/${pid}/proposal` : null, // per-row href set below
  },
```
The proposal href needs the proposal id, which `SimpleResolver.href(projectId)` can't carry. Extend the resolver shape: `href: (projectId: string | null, sourceId: string) => string | null` and update every existing entry to ignore the second arg (`href: (pid) => …` already type-checks with fewer params). Then `proposal.href = (pid, id) => pid ? `/project/${pid}/proposal/${id}` : null` and in `resolveSources` call `resolver.href(r.projectId, r.sourceId as string)`.

Add a `takeoff-print` resolver (no table — label is the file's own name) — replace `resolvePrintouts` entirely:
```ts
// takeoff-print / takeoff-export files (and the legacy `printout` kind that
// migration 28 relabels) carry no table row: the file's own name is the
// label; click-through is the project's Takeoffs tab.
function resolveTakeoffPrints(rows: RawRow[], out: Map<string, DocumentSource>): void {
  for (const r of rows) {
    if (r.sourceType !== 'takeoff-print' || !r.sourceId) continue;
    out.set(r.id, {
      type: 'takeoff-print', id: r.sourceId,
      label: (r.name && r.name.trim()) || genericLabel(r.kind),
      href: r.projectId ? `/project/${r.projectId}/takeoff` : null,
    });
  }
}
```
and in `resolveSources` replace `resolvePrintouts(db, rows, out)` with `resolveTakeoffPrints(rows, out)`. Delete `resolvePrintouts`.

In `deleteDocument`, BEFORE the `current.sourceType` check:
```ts
  const proposalRef = db.prepare(`
    SELECT 1 FROM proposal_photos WHERE fileId = ?
    UNION SELECT 1 FROM proposal_attachments WHERE fileId = ?
    UNION SELECT 1 FROM proposals WHERE fileId = ? OR signedFileId = ?
    LIMIT 1`).get(id, id, id, id);
  if (proposalRef) return { ok: false, status: 409, error: 'This file is attached to a proposal — remove it from the proposal first' };
```

`server/routes.ts` GET `/api/documents`: add `mimes: csv(q.mimes),` to the `filters` object.

- [ ] **Step 4: Run tests**

Run: `npx vitest run server/documents.test.ts server/files.test.ts server/routes.test.ts`
Expected: PASS. (If a `files.test.ts` case enumerates `SYSTEM_KINDS` or `DIRECT_UPLOAD_KINDS` exactly, update it.)

- [ ] **Step 5: Commit**

```bash
npx vitest run --project server && npm run lint
git add server/files.ts server/documents.ts server/routes.ts server/documents.test.ts server/files.test.ts
git commit -m "feat(documents): proposal-signed/takeoff-print/takeoff-export/company-document kinds, mime filter, proposal delete guard"
```

---

### Task 3: `server/proposalStore.ts`

**Files:**
- Create: `server/proposalStore.ts`
- Test: `server/proposalStore.test.ts`

**Interfaces (produced — Task 4 and the client rely on these exact names):**

```ts
export class ValidationError extends Error {}
export class ConflictError extends Error {}
export class NotFoundError extends Error {}
export class LockedError extends Error {}   // proposal is not a draft (or is legacy) → route maps to 409 { code: 'locked' }

export const PROPOSAL_STATUSES = ['draft', 'sent', 'accepted', 'declined'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export interface ProposalLineInput {
  id?: string; kind: 'manual' | 'takeoff'; takeoffId?: string | null; description?: string;
  amountCents: number; derivedAmountCents?: number | null; measurementSummary?: string | null; isAlternate?: boolean;
}
export interface PaymentScheduleRow { description: string; percent?: number | null; amountCents?: number | null; }
export interface ProposalInput {
  title?: string | null; validUntil?: string | null; fontFamily?: string | null;
  coverNotes?: string | null; terms?: string | null;
  inclusions?: string[]; exclusions?: string[];
  paymentSchedule?: PaymentScheduleRow[] | null;
  showGrandTotal?: boolean; includeCostDetail?: boolean; includeSignature?: boolean;
  highlightQuality?: 'best' | 'email';
  lines?: ProposalLineInput[];
}
export interface CreateProposalInput extends ProposalInput {
  takeoffIds?: string[];           // seed takeoff lines (description = takeoff name, amount 0, derived null)
  revisedFromId?: string;          // copy from this proposal
  carryPhotos?: boolean;           // default true when revising
  carryAttachments?: boolean;      // default true when revising
}

export function listProposals(db, projectId): ProposalSummary[]
export function listOutstanding(db): (ProposalSummary & { projectName: string })[]   // status = 'sent', all projects, ORDER BY validUntil NULLS LAST, sentAt
export function getProposal(db, id): Proposal | null      // full: lines[], photos[] (with caption), attachments[] (with file name/mime/size via JOIN files)
export function createProposal(db, projectId, input: CreateProposalInput, createdBy?): { id: string; number: number; version: number }
export function saveProposal(db, id, input: ProposalInput & { version: number }): { version: number }   // lines replaced wholesale when provided
export function deleteProposal(db, id): void              // draft + non-legacy only, else LockedError; returns nothing; caller deletes the generated file
export function setProposalFile(db, id, fileId): void     // after Generate; allowed on drafts only
export function addPhoto(db, id, fileId): void            // draft only; idempotent
export function updatePhoto(db, id, fileId, patch: { caption?: string | null; sortOrder?: number }): void
export function removePhoto(db, id, fileId): void
export function addAttachment(db, id, fileId): void       // draft only; file must exist and be application/pdf → else ValidationError
export function updateAttachment(db, id, fileId, patch: { sortOrder: number }): void
export function removeAttachment(db, id, fileId): void
export function markSent(db, id, sentTo: { to: string; cc?: string; subject: string }): { version: number }   // from draft only
export function setStatus(db, id, status: 'accepted' | 'declined', signedFileId?: string | null): { version: number }  // from sent only
export function setSignedFile(db, id, fileId | null): void  // sent | accepted only
```

`ProposalSummary` = every `proposals` column (booleans as 0/1 ints, `inclusions/exclusions/paymentSchedule/sentTo` parsed to JSON) plus `revisedFromNumber: number | null`, `totalCents` (sum non-alternate `amountCents`), `alternateCount`, `hasOverride` (any takeoff line with `derivedAmountCents IS NOT NULL AND amountCents != derivedAmountCents`), `photoCount`, `attachmentCount`.

- [ ] **Step 1: Write the failing tests**

`server/proposalStore.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import { putBuffer } from './files';
import {
  createProposal, getProposal, listProposals, listOutstanding, saveProposal, deleteProposal,
  addPhoto, updatePhoto, removePhoto, addAttachment, removeAttachment, markSent, setStatus, setProposalFile,
  LockedError, ConflictError, ValidationError, NotFoundError,
} from './proposalStore';

let db: Database.Database;
let dir: string;

beforeEach(() => {
  dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-prop-'));
  db = openDb(':memory:');
  runMigrations(db, dir, migrations);
  db.prepare(`INSERT INTO projects (id, name, createdAt, version, updatedAt, meta) VALUES ('p1', 'Job A', 1, 1, 1, '{}')`).run();
  db.prepare(`INSERT INTO projects (id, name, createdAt, version, updatedAt, meta) VALUES ('p2', 'Job B', 1, 1, 1, '{}')`).run();
  db.prepare(`INSERT INTO takeoffs (id, projectId, name, type, color, sortOrder, attrs) VALUES ('t1', 'p1', 'Stucco', 'area', '#fff', 0, '{}')`).run();
  db.prepare(`INSERT INTO takeoffs (id, projectId, name, type, color, sortOrder, attrs) VALUES ('t2', 'p1', 'Trim', 'length', '#fff', 1, '{}')`).run();
});

const pdf = (id: string) => putBuffer(db, dir, id, Buffer.from('%PDF'), 'application/pdf', { projectId: 'p1', kind: 'document', name: `${id}.pdf` });
const jpg = (id: string) => putBuffer(db, dir, id, Buffer.from('x'), 'image/jpeg', { projectId: 'p1', kind: 'proposal-photo', name: `${id}.jpg` });

describe('numbering + seeding', () => {
  it('numbers per project starting at 1 and seeds takeoff lines by name', () => {
    const a = createProposal(db, 'p1', { takeoffIds: ['t1', 't2'] });
    const b = createProposal(db, 'p1', {});
    const c = createProposal(db, 'p2', {});
    expect([a.number, b.number, c.number]).toEqual([1, 2, 1]);
    const full = getProposal(db, a.id)!;
    expect(full.lines.map(l => [l.kind, l.takeoffId, l.description, l.amountCents, l.derivedAmountCents])).toEqual([
      ['takeoff', 't1', 'Stucco', 0, null], ['takeoff', 't2', 'Trim', 0, null],
    ]);
    expect(full.status).toBe('draft');
    expect(full.showGrandTotal).toBe(true);
  });

  it('ignores takeoff ids that belong to another project', () => {
    db.prepare(`INSERT INTO takeoffs (id, projectId, name, type, color, sortOrder, attrs) VALUES ('t9', 'p2', 'Other', 'area', '#fff', 0, '{}')`).run();
    const a = createProposal(db, 'p1', { takeoffIds: ['t1', 't9'] });
    expect(getProposal(db, a.id)!.lines).toHaveLength(1);
  });

  it('numbers never reuse after a delete', () => {
    const a = createProposal(db, 'p1', {});
    const b = createProposal(db, 'p1', {});
    deleteProposal(db, b.id);
    expect(createProposal(db, 'p1', {}).number).toBe(3);
    void a;
  });
});

describe('save + lock', () => {
  it('replaces lines wholesale, bumps version, 409s stale saves', () => {
    const { id, version } = createProposal(db, 'p1', {});
    const r = saveProposal(db, id, {
      version, title: 'Bid', inclusions: ['a'], exclusions: ['b'], showGrandTotal: false,
      paymentSchedule: [{ description: '50% on start', percent: 50 }],
      lines: [
        { kind: 'takeoff', takeoffId: 't1', description: 'Stucco', amountCents: 420000, derivedAmountCents: 418700, measurementSummary: '4,120 sq ft', isAlternate: false },
        { kind: 'manual', description: 'Scaffold', amountCents: 350000 },
        { kind: 'manual', description: 'Color coat', amountCents: 220000, isAlternate: true },
      ],
    });
    expect(r.version).toBe(2);
    const p = getProposal(db, id)!;
    expect(p.title).toBe('Bid');
    expect(p.inclusions).toEqual(['a']);
    expect(p.paymentSchedule).toEqual([{ description: '50% on start', percent: 50, amountCents: null }]);
    expect(p.showGrandTotal).toBe(false);
    expect(p.lines.map(l => l.sortOrder)).toEqual([0, 1, 2]);
    expect(() => saveProposal(db, id, { version: 1, title: 'stale' })).toThrow(ConflictError);
    const s = listProposals(db, 'p1')[0];
    expect(s.totalCents).toBe(770000);
    expect(s.alternateCount).toBe(1);
    expect(s.hasOverride).toBe(true);
  });

  it('rejects non-integer cents and unknown kinds', () => {
    const { id, version } = createProposal(db, 'p1', {});
    expect(() => saveProposal(db, id, { version, lines: [{ kind: 'manual', description: 'x', amountCents: 1.5 }] })).toThrow(ValidationError);
    expect(() => saveProposal(db, id, { version, lines: [{ kind: 'weird' as any, description: 'x', amountCents: 1 }] })).toThrow(ValidationError);
  });

  it('locks after markSent: save/delete/photo/attachment all throw LockedError', () => {
    const { id, version } = createProposal(db, 'p1', {});
    pdf('gen'); setProposalFile(db, id, 'gen');
    markSent(db, id, { to: 'a@b.c', subject: 'Proposal' });
    const p = getProposal(db, id)!;
    expect(p.status).toBe('sent');
    expect(p.sentTo).toEqual({ to: 'a@b.c', cc: undefined, subject: 'Proposal' });
    expect(p.sentAt).toBeGreaterThan(0);
    expect(() => saveProposal(db, id, { version: p.version, title: 'x' })).toThrow(LockedError);
    expect(() => deleteProposal(db, id)).toThrow(LockedError);
    jpg('ph1');
    expect(() => addPhoto(db, id, 'ph1')).toThrow(LockedError);
    pdf('att1');
    expect(() => addAttachment(db, id, 'att1')).toThrow(LockedError);
    void version;
  });

  it('legacy proposals are locked even while draft', () => {
    const { id } = createProposal(db, 'p1', {});
    db.prepare('UPDATE proposals SET legacy = 1 WHERE id = ?').run(id);
    const p = getProposal(db, id)!;
    expect(() => saveProposal(db, id, { version: p.version, title: 'x' })).toThrow(LockedError);
  });
});

describe('status transitions', () => {
  it('draft → sent → accepted with signed file; declined from sent; nothing else', () => {
    const { id } = createProposal(db, 'p1', {});
    expect(() => setStatus(db, id, 'accepted')).toThrow(ValidationError); // not sent yet
    pdf('gen'); setProposalFile(db, id, 'gen');
    markSent(db, id, { to: 'a@b.c', subject: 's' });
    expect(() => markSent(db, id, { to: 'a@b.c', subject: 's' })).toThrow(LockedError); // already sent
    pdf('signed');
    setStatus(db, id, 'accepted', 'signed');
    const p = getProposal(db, id)!;
    expect(p.status).toBe('accepted');
    expect(p.signedFileId).toBe('signed');
    expect(p.acceptedAt).toBeGreaterThan(0);
    expect(() => setStatus(db, id, 'declined')).toThrow(ValidationError); // accepted is terminal
  });

  it('listOutstanding returns sent proposals across projects sorted by validUntil', () => {
    const a = createProposal(db, 'p1', { validUntil: '2026-09-30' });
    const b = createProposal(db, 'p2', { validUntil: '2026-09-01' });
    const c = createProposal(db, 'p1', {});
    for (const x of [a, b, c]) { pdf(`g-${x.id}`); setProposalFile(db, x.id, `g-${x.id}`); markSent(db, x.id, { to: 'x@y.z', subject: 's' }); }
    setStatus(db, c.id, 'declined');
    const out = listOutstanding(db);
    expect(out.map(o => o.id)).toEqual([b.id, a.id]);
    expect(out[0].projectName).toBe('Job B');
  });
});

describe('photos + attachments', () => {
  it('adds idempotently with sortOrder, updates caption, removes', () => {
    const { id } = createProposal(db, 'p1', {});
    jpg('ph1'); jpg('ph2');
    addPhoto(db, id, 'ph1'); addPhoto(db, id, 'ph1'); addPhoto(db, id, 'ph2');
    updatePhoto(db, id, 'ph1', { caption: 'North wall' });
    let p = getProposal(db, id)!;
    expect(p.photos.map(x => [x.fileId, x.sortOrder, x.caption])).toEqual([['ph1', 0, 'North wall'], ['ph2', 1, null]]);
    removePhoto(db, id, 'ph1');
    p = getProposal(db, id)!;
    expect(p.photos.map(x => x.fileId)).toEqual(['ph2']);
  });

  it('attachments must be PDFs and existing files', () => {
    const { id } = createProposal(db, 'p1', {});
    jpg('notpdf');
    expect(() => addAttachment(db, id, 'notpdf')).toThrow(ValidationError);
    expect(() => addAttachment(db, id, 'missing')).toThrow(NotFoundError);
    pdf('a1');
    addAttachment(db, id, 'a1');
    const p = getProposal(db, id)!;
    expect(p.attachments).toEqual([expect.objectContaining({ fileId: 'a1', sortOrder: 0, name: 'a1.pdf', mime: 'application/pdf' })]);
    removeAttachment(db, id, 'a1');
    expect(getProposal(db, id)!.attachments).toEqual([]);
  });
});

describe('revise', () => {
  it('copies lines/text/options, links lineage, carries photos+attachments by default, can skip them', () => {
    const src = createProposal(db, 'p1', {});
    saveProposal(db, src.id, {
      version: src.version, title: 'Original', coverNotes: 'n', terms: 't', inclusions: ['i'], exclusions: ['e'],
      showGrandTotal: false, includeCostDetail: true,
      lines: [{ kind: 'takeoff', takeoffId: 't1', description: 'Stucco', amountCents: 100, derivedAmountCents: 90, isAlternate: false },
              { kind: 'manual', description: 'M', amountCents: 5, isAlternate: true }],
    });
    jpg('ph1'); addPhoto(db, src.id, 'ph1'); updatePhoto(db, src.id, 'ph1', { caption: 'c' });
    pdf('a1'); addAttachment(db, src.id, 'a1');
    pdf('gen'); setProposalFile(db, src.id, 'gen');
    markSent(db, src.id, { to: 'a@b.c', subject: 's' });

    const rev = createProposal(db, 'p1', { revisedFromId: src.id });
    const r = getProposal(db, rev.id)!;
    expect(r.number).toBe(2);
    expect(r.revisedFromId).toBe(src.id);
    expect(r.revisedFromNumber).toBe(1);
    expect(r.status).toBe('draft');
    expect(r.fileId).toBeNull();          // generated PDF is NOT carried
    expect(r.title).toBe('Original');
    expect(r.showGrandTotal).toBe(false);
    expect(r.includeCostDetail).toBe(true);
    expect(r.lines.map(l => [l.kind, l.description, l.amountCents, l.derivedAmountCents, l.isAlternate])).toEqual([
      ['takeoff', 'Stucco', 100, 90, false], ['manual', 'M', 5, true],
    ]);
    expect(r.lines[0].id).not.toBe(getProposal(db, src.id)!.lines[0].id);
    expect(r.photos.map(p => [p.fileId, p.caption])).toEqual([['ph1', 'c']]);
    expect(r.attachments.map(a => a.fileId)).toEqual(['a1']);

    const bare = createProposal(db, 'p1', { revisedFromId: src.id, carryPhotos: false, carryAttachments: false });
    const b = getProposal(db, bare.id)!;
    expect(b.photos).toEqual([]);
    expect(b.attachments).toEqual([]);
    expect(b.lines).toHaveLength(2);
  });

  it('refuses to revise across projects or from a missing proposal', () => {
    const src = createProposal(db, 'p1', {});
    expect(() => createProposal(db, 'p2', { revisedFromId: src.id })).toThrow(ValidationError);
    expect(() => createProposal(db, 'p1', { revisedFromId: 'nope' })).toThrow(NotFoundError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/proposalStore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `server/proposalStore.ts`**

```ts
// server/proposalStore.ts — proposals as first-class rows
// (spec docs/superpowers/specs/2026-08-28-proposal-rework-design.md §3–§4).
// Pure SQL functions; no HTTP concerns. Pattern: dailyReportStore.ts.
import type Database from 'better-sqlite3';
import crypto from 'crypto';

export class ValidationError extends Error {}
export class ConflictError extends Error {}
export class NotFoundError extends Error {}
export class LockedError extends Error {}

export const PROPOSAL_STATUSES = ['draft', 'sent', 'accepted', 'declined'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
const FONTS = ['helvetica', 'times', 'courier'];

export interface ProposalLineInput {
  id?: string; kind: 'manual' | 'takeoff'; takeoffId?: string | null; description?: string;
  amountCents: number; derivedAmountCents?: number | null; measurementSummary?: string | null; isAlternate?: boolean;
}
export interface PaymentScheduleRow { description: string; percent?: number | null; amountCents?: number | null; }
export interface ProposalInput {
  title?: string | null; validUntil?: string | null; fontFamily?: string | null;
  coverNotes?: string | null; terms?: string | null;
  inclusions?: string[]; exclusions?: string[];
  paymentSchedule?: PaymentScheduleRow[] | null;
  showGrandTotal?: boolean; includeCostDetail?: boolean; includeSignature?: boolean;
  highlightQuality?: 'best' | 'email';
  lines?: ProposalLineInput[];
}
export interface CreateProposalInput extends ProposalInput {
  takeoffIds?: string[]; revisedFromId?: string; carryPhotos?: boolean; carryAttachments?: boolean;
}

const parseJson = <T>(s: string | null, fallback: T): T => { try { return s == null ? fallback : (JSON.parse(s) as T); } catch { return fallback; } };
const strArr = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(Boolean) : [];

function requireProject(db: Database.Database, projectId: string): { name: string | null } {
  const row = db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as { name: string | null } | undefined;
  if (!row) throw new NotFoundError('Project not found');
  return row;
}
function rowOf(db: Database.Database, id: string): any {
  const row = db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as any;
  if (!row) throw new NotFoundError('Proposal not found');
  return row;
}
// Every write except status transitions goes through here.
function requireDraft(db: Database.Database, id: string): any {
  const row = rowOf(db, id);
  if (row.legacy || row.status !== 'draft') throw new LockedError('Proposal is locked — revise it to make changes');
  return row;
}
const bump = (db: Database.Database, id: string) =>
  db.prepare('UPDATE proposals SET version = version + 1, updatedAt = ? WHERE id = ?').run(Date.now(), id);

function normalizeSchedule(v: unknown): PaymentScheduleRow[] | null {
  if (v == null) return null;
  if (!Array.isArray(v)) throw new ValidationError('paymentSchedule must be an array or null');
  return v.map((r: any) => {
    if (!r || typeof r !== 'object' || typeof r.description !== 'string') throw new ValidationError('paymentSchedule rows need a description');
    const percent = r.percent == null ? null : Number(r.percent);
    const amountCents = r.amountCents == null ? null : r.amountCents;
    if (percent !== null && !Number.isFinite(percent)) throw new ValidationError('paymentSchedule percent must be a number');
    if (amountCents !== null && !Number.isInteger(amountCents)) throw new ValidationError('paymentSchedule amountCents must be an integer');
    return { description: r.description, percent, amountCents };
  });
}

function validateLines(lines: unknown): Required<Omit<ProposalLineInput, 'id'>>[] {
  if (!Array.isArray(lines)) throw new ValidationError('lines must be an array');
  return lines.map((l: any) => {
    if (!l || typeof l !== 'object') throw new ValidationError('bad line');
    if (l.kind !== 'manual' && l.kind !== 'takeoff') throw new ValidationError('line kind must be manual|takeoff');
    if (!Number.isInteger(l.amountCents)) throw new ValidationError('amountCents must be an integer');
    if (l.derivedAmountCents != null && !Number.isInteger(l.derivedAmountCents)) throw new ValidationError('derivedAmountCents must be an integer');
    if (l.kind === 'takeoff' && (typeof l.takeoffId !== 'string' || !l.takeoffId)) throw new ValidationError('takeoff lines need a takeoffId');
    return {
      kind: l.kind, takeoffId: l.kind === 'takeoff' ? l.takeoffId : null,
      description: typeof l.description === 'string' ? l.description : '',
      amountCents: l.amountCents, derivedAmountCents: l.derivedAmountCents ?? null,
      measurementSummary: typeof l.measurementSummary === 'string' ? l.measurementSummary : null,
      isAlternate: !!l.isAlternate,
    };
  });
}

function writeLines(db: Database.Database, proposalId: string, lines: ReturnType<typeof validateLines>): void {
  db.prepare('DELETE FROM proposal_lines WHERE proposalId = ?').run(proposalId);
  const ins = db.prepare(`INSERT INTO proposal_lines (id, proposalId, sortOrder, kind, takeoffId, description, amountCents, derivedAmountCents, measurementSummary, isAlternate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  lines.forEach((l, i) => ins.run(crypto.randomUUID(), proposalId, i, l.kind, l.takeoffId, l.description, l.amountCents, l.derivedAmountCents, l.measurementSummary, l.isAlternate ? 1 : 0));
}

const SUMMARY_SQL = `
  SELECT p.*,
    (SELECT number FROM proposals r WHERE r.id = p.revisedFromId) AS revisedFromNumber,
    (SELECT COALESCE(SUM(amountCents), 0) FROM proposal_lines l WHERE l.proposalId = p.id AND l.isAlternate = 0) AS totalCents,
    (SELECT COUNT(*) FROM proposal_lines l WHERE l.proposalId = p.id AND l.isAlternate = 1) AS alternateCount,
    (SELECT COUNT(*) FROM proposal_lines l WHERE l.proposalId = p.id AND l.kind = 'takeoff' AND l.derivedAmountCents IS NOT NULL AND l.amountCents != l.derivedAmountCents) AS overrideCount,
    (SELECT COUNT(*) FROM proposal_photos ph WHERE ph.proposalId = p.id) AS photoCount,
    (SELECT COUNT(*) FROM proposal_attachments a WHERE a.proposalId = p.id) AS attachmentCount
  FROM proposals p`;

function shapeSummary(r: any) {
  const { overrideCount, ...rest } = r;
  return {
    ...rest,
    legacy: !!r.legacy, showGrandTotal: !!r.showGrandTotal, includeCostDetail: !!r.includeCostDetail, includeSignature: !!r.includeSignature,
    inclusions: strArr(parseJson(r.inclusions, [])), exclusions: strArr(parseJson(r.exclusions, [])),
    paymentSchedule: parseJson<PaymentScheduleRow[] | null>(r.paymentSchedule, null),
    sentTo: parseJson<{ to: string; cc?: string; subject: string } | null>(r.sentTo, null),
    hasOverride: overrideCount > 0,
  };
}

export function listProposals(db: Database.Database, projectId: string): any[] {
  return (db.prepare(`${SUMMARY_SQL} WHERE p.projectId = ? ORDER BY p.number DESC`).all(projectId) as any[]).map(shapeSummary);
}

export function listOutstanding(db: Database.Database): any[] {
  return (db.prepare(`${SUMMARY_SQL} WHERE p.status = 'sent'
      ORDER BY CASE WHEN p.validUntil IS NULL THEN 1 ELSE 0 END, p.validUntil, p.sentAt`).all() as any[])
    .map(r => ({ ...shapeSummary(r), projectName: (db.prepare('SELECT name FROM projects WHERE id = ?').get(r.projectId) as any)?.name ?? null }));
}

export function getProposal(db: Database.Database, id: string): any | null {
  const r = db.prepare(`${SUMMARY_SQL} WHERE p.id = ?`).get(id) as any;
  if (!r) return null;
  const lines = (db.prepare('SELECT * FROM proposal_lines WHERE proposalId = ? ORDER BY sortOrder').all(id) as any[])
    .map(l => ({ ...l, isAlternate: !!l.isAlternate }));
  const photos = db.prepare('SELECT id, fileId, sortOrder, caption FROM proposal_photos WHERE proposalId = ? ORDER BY sortOrder, createdAt').all(id);
  const attachments = db.prepare(`SELECT a.id, a.fileId, a.sortOrder, f.name, f.mime, f.size
    FROM proposal_attachments a LEFT JOIN files f ON f.id = a.fileId WHERE a.proposalId = ? ORDER BY a.sortOrder, a.createdAt`).all(id);
  return { ...shapeSummary(r), lines, photos, attachments };
}

function applyInput(db: Database.Database, id: string, input: ProposalInput, existing: any): void {
  if (input.fontFamily != null && !FONTS.includes(input.fontFamily)) throw new ValidationError('bad fontFamily');
  if (input.highlightQuality != null && input.highlightQuality !== 'best' && input.highlightQuality !== 'email') throw new ValidationError('bad highlightQuality');
  if (input.validUntil != null && input.validUntil !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(input.validUntil)) throw new ValidationError('validUntil must be YYYY-MM-DD');
  const schedule = input.paymentSchedule === undefined ? undefined : normalizeSchedule(input.paymentSchedule);
  db.prepare(`UPDATE proposals SET title = ?, validUntil = ?, fontFamily = ?, coverNotes = ?, terms = ?, inclusions = ?, exclusions = ?,
      paymentSchedule = ?, showGrandTotal = ?, includeCostDetail = ?, includeSignature = ?, highlightQuality = ? WHERE id = ?`)
    .run(
      input.title === undefined ? existing.title : input.title,
      input.validUntil === undefined ? existing.validUntil : (input.validUntil || null),
      input.fontFamily === undefined ? existing.fontFamily : input.fontFamily,
      input.coverNotes === undefined ? existing.coverNotes : input.coverNotes,
      input.terms === undefined ? existing.terms : input.terms,
      input.inclusions === undefined ? existing.inclusions : JSON.stringify(strArr(input.inclusions)),
      input.exclusions === undefined ? existing.exclusions : JSON.stringify(strArr(input.exclusions)),
      schedule === undefined ? existing.paymentSchedule : (schedule === null ? null : JSON.stringify(schedule)),
      input.showGrandTotal === undefined ? existing.showGrandTotal : (input.showGrandTotal ? 1 : 0),
      input.includeCostDetail === undefined ? existing.includeCostDetail : (input.includeCostDetail ? 1 : 0),
      input.includeSignature === undefined ? existing.includeSignature : (input.includeSignature ? 1 : 0),
      input.highlightQuality === undefined ? existing.highlightQuality : input.highlightQuality,
      id,
    );
  if (input.lines !== undefined) writeLines(db, id, validateLines(input.lines));
}

export function createProposal(db: Database.Database, projectId: string, input: CreateProposalInput, createdBy?: string): { id: string; number: number; version: number } {
  requireProject(db, projectId);
  const id = crypto.randomUUID();
  const now = Date.now();
  let number = 0;
  const tx = db.transaction(() => {
    number = ((db.prepare('SELECT COALESCE(MAX(number), 0) m FROM proposals WHERE projectId = ?').get(projectId) as any).m as number) + 1;
    let source: any = null;
    if (input.revisedFromId) {
      source = db.prepare('SELECT * FROM proposals WHERE id = ?').get(input.revisedFromId) as any;
      if (!source) throw new NotFoundError('Source proposal not found');
      if (source.projectId !== projectId) throw new ValidationError('Cannot revise a proposal from another project');
    }
    db.prepare(`INSERT INTO proposals (id, projectId, number, revisedFromId, status, legacy, title, validUntil, fontFamily, coverNotes, terms,
        inclusions, exclusions, paymentSchedule, showGrandTotal, includeCostDetail, includeSignature, highlightQuality,
        version, createdBy, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, 'draft', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
      .run(id, projectId, number, source?.id ?? null,
        source?.title ?? null, source?.validUntil ?? null, source?.fontFamily ?? null, source?.coverNotes ?? null, source?.terms ?? null,
        source?.inclusions ?? '[]', source?.exclusions ?? '[]', source?.paymentSchedule ?? null,
        source ? source.showGrandTotal : 1, source ? source.includeCostDetail : 0, source ? source.includeSignature : 1, source?.highlightQuality ?? 'best',
        createdBy ?? null, now, now);
    if (source) {
      const srcLines = db.prepare('SELECT * FROM proposal_lines WHERE proposalId = ? ORDER BY sortOrder').all(source.id) as any[];
      writeLines(db, id, validateLines(srcLines.map(l => ({ ...l, isAlternate: !!l.isAlternate }))));
      if (input.carryPhotos !== false) {
        const ins = db.prepare('INSERT INTO proposal_photos (id, proposalId, fileId, sortOrder, caption, createdAt) VALUES (?, ?, ?, ?, ?, ?)');
        for (const ph of db.prepare('SELECT fileId, sortOrder, caption FROM proposal_photos WHERE proposalId = ? ORDER BY sortOrder').all(source.id) as any[]) {
          ins.run(crypto.randomUUID(), id, ph.fileId, ph.sortOrder, ph.caption, now);
        }
      }
      if (input.carryAttachments !== false) {
        const ins = db.prepare('INSERT INTO proposal_attachments (id, proposalId, fileId, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?)');
        for (const a of db.prepare('SELECT fileId, sortOrder FROM proposal_attachments WHERE proposalId = ? ORDER BY sortOrder').all(source.id) as any[]) {
          ins.run(crypto.randomUUID(), id, a.fileId, a.sortOrder, now);
        }
      }
    } else if (input.takeoffIds?.length) {
      const ids = input.takeoffIds.filter(x => typeof x === 'string' && x);
      const rows = ids.length
        ? db.prepare(`SELECT id, name FROM takeoffs WHERE projectId = ? AND id IN (${ids.map(() => '?').join(',')}) ORDER BY sortOrder`).all(projectId, ...ids) as any[]
        : [];
      // preserve the caller's order
      const byId = new Map(rows.map(r => [r.id, r]));
      writeLines(db, id, validateLines(ids.filter(x => byId.has(x)).map(x => ({ kind: 'takeoff', takeoffId: x, description: byId.get(x).name ?? '', amountCents: 0, derivedAmountCents: null }))));
    }
    // explicit fields on create (e.g. validUntil from tests / defaults from user prefs)
    const { takeoffIds, revisedFromId, carryPhotos, carryAttachments, ...rest } = input;
    if (Object.keys(rest).length) applyInput(db, id, rest, db.prepare('SELECT * FROM proposals WHERE id = ?').get(id));
  });
  tx();
  return { id, number, version: 1 };
}

export function saveProposal(db: Database.Database, id: string, input: ProposalInput & { version: number }): { version: number } {
  const row = requireDraft(db, id);
  if (!Number.isInteger(input.version)) throw new ValidationError('version required');
  if (row.version !== input.version) throw new ConflictError('proposal was modified');
  const tx = db.transaction(() => { applyInput(db, id, input, row); bump(db, id); });
  tx();
  return { version: row.version + 1 };
}

export function deleteProposal(db: Database.Database, id: string): void {
  requireDraft(db, id);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM proposal_lines WHERE proposalId = ?').run(id);
    db.prepare('DELETE FROM proposal_photos WHERE proposalId = ?').run(id);
    db.prepare('DELETE FROM proposal_attachments WHERE proposalId = ?').run(id);
    db.prepare('DELETE FROM proposals WHERE id = ?').run(id);
  });
  tx();
}

export function setProposalFile(db: Database.Database, id: string, fileId: string): void {
  requireDraft(db, id);
  db.prepare('UPDATE proposals SET fileId = ?, updatedAt = ? WHERE id = ?').run(fileId, Date.now(), id);
}

const requireFile = (db: Database.Database, fileId: unknown) => {
  if (typeof fileId !== 'string' || !fileId) throw new ValidationError('fileId is required');
  const f = db.prepare('SELECT id, mime FROM files WHERE id = ?').get(fileId) as { id: string; mime: string } | undefined;
  if (!f) throw new NotFoundError('File not found');
  return f;
};

export function addPhoto(db: Database.Database, id: string, fileId: string): void {
  requireDraft(db, id); requireFile(db, fileId);
  if (db.prepare('SELECT 1 FROM proposal_photos WHERE proposalId = ? AND fileId = ?').get(id, fileId)) return;
  const max = (db.prepare('SELECT COALESCE(MAX(sortOrder), -1) m FROM proposal_photos WHERE proposalId = ?').get(id) as any).m;
  db.prepare('INSERT INTO proposal_photos (id, proposalId, fileId, sortOrder, caption, createdAt) VALUES (?, ?, ?, ?, NULL, ?)').run(crypto.randomUUID(), id, fileId, max + 1, Date.now());
}
export function updatePhoto(db: Database.Database, id: string, fileId: string, patch: { caption?: string | null; sortOrder?: number }): void {
  requireDraft(db, id);
  const row = db.prepare('SELECT caption, sortOrder FROM proposal_photos WHERE proposalId = ? AND fileId = ?').get(id, fileId) as any;
  if (!row) throw new NotFoundError('Photo not on this proposal');
  if (patch.sortOrder !== undefined && !Number.isInteger(patch.sortOrder)) throw new ValidationError('sortOrder must be an integer');
  db.prepare('UPDATE proposal_photos SET caption = ?, sortOrder = ? WHERE proposalId = ? AND fileId = ?')
    .run(patch.caption === undefined ? row.caption : (patch.caption || null), patch.sortOrder ?? row.sortOrder, id, fileId);
}
export function removePhoto(db: Database.Database, id: string, fileId: string): void {
  requireDraft(db, id);
  db.prepare('DELETE FROM proposal_photos WHERE proposalId = ? AND fileId = ?').run(id, fileId);
}

export function addAttachment(db: Database.Database, id: string, fileId: string): void {
  requireDraft(db, id);
  const f = requireFile(db, fileId);
  if (f.mime !== 'application/pdf') throw new ValidationError('Only PDF files can be attached');
  if (db.prepare('SELECT 1 FROM proposal_attachments WHERE proposalId = ? AND fileId = ?').get(id, fileId)) return;
  const max = (db.prepare('SELECT COALESCE(MAX(sortOrder), -1) m FROM proposal_attachments WHERE proposalId = ?').get(id) as any).m;
  db.prepare('INSERT INTO proposal_attachments (id, proposalId, fileId, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?)').run(crypto.randomUUID(), id, fileId, max + 1, Date.now());
}
export function updateAttachment(db: Database.Database, id: string, fileId: string, patch: { sortOrder: number }): void {
  requireDraft(db, id);
  if (!Number.isInteger(patch.sortOrder)) throw new ValidationError('sortOrder must be an integer');
  const r = db.prepare('UPDATE proposal_attachments SET sortOrder = ? WHERE proposalId = ? AND fileId = ?').run(patch.sortOrder, id, fileId);
  if (r.changes === 0) throw new NotFoundError('Attachment not on this proposal');
}
export function removeAttachment(db: Database.Database, id: string, fileId: string): void {
  requireDraft(db, id);
  db.prepare('DELETE FROM proposal_attachments WHERE proposalId = ? AND fileId = ?').run(id, fileId);
}

export function markSent(db: Database.Database, id: string, sentTo: { to: string; cc?: string; subject: string }): { version: number } {
  const row = requireDraft(db, id);
  if (!row.fileId) throw new ValidationError('Generate the proposal PDF before sending');
  db.prepare(`UPDATE proposals SET status = 'sent', sentAt = ?, sentTo = ?, version = version + 1, updatedAt = ? WHERE id = ?`)
    .run(Date.now(), JSON.stringify({ to: sentTo.to, cc: sentTo.cc, subject: sentTo.subject }), Date.now(), id);
  return { version: row.version + 1 };
}

export function setStatus(db: Database.Database, id: string, status: 'accepted' | 'declined', signedFileId?: string | null): { version: number } {
  const row = rowOf(db, id);
  if (status !== 'accepted' && status !== 'declined') throw new ValidationError('status must be accepted|declined');
  if (row.status !== 'sent') throw new ValidationError('Only a sent proposal can be accepted or declined');
  if (signedFileId) requireFile(db, signedFileId);
  const now = Date.now();
  db.prepare(`UPDATE proposals SET status = ?, acceptedAt = ?, declinedAt = ?, signedFileId = COALESCE(?, signedFileId), version = version + 1, updatedAt = ? WHERE id = ?`)
    .run(status, status === 'accepted' ? now : null, status === 'declined' ? now : null, signedFileId ?? null, now, id);
  return { version: row.version + 1 };
}

export function setSignedFile(db: Database.Database, id: string, fileId: string | null): void {
  const row = rowOf(db, id);
  if (row.status !== 'sent' && row.status !== 'accepted') throw new ValidationError('Signed copy only applies to sent or accepted proposals');
  if (fileId) requireFile(db, fileId);
  db.prepare('UPDATE proposals SET signedFileId = ?, updatedAt = ? WHERE id = ?').run(fileId, Date.now(), id);
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run server/proposalStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run lint && npx vitest run --project server
git add server/proposalStore.ts server/proposalStore.test.ts
git commit -m "feat(proposals): proposalStore — numbering, lines, photos, attachments, revise, lifecycle"
```

---

### Task 4: `server/proposalRoutes.ts` + wiring + legacy route/cascade removal

**Files:**
- Create: `server/proposalRoutes.ts`
- Modify: `server/routes.ts` — import + call `registerProposalRoutes` inside `registerDataRoutes`; inside `registerEmailRoutes` replace `POST /api/projects/:id/send-proposal` (lines ~1693-1734) with `POST /api/proposals/:id/send`.
- Modify: `server/projectStore.ts:258-287, 300-330` — delete `droppedSourceFileIds` and the post-commit cascade in `saveProject` (keep `referencedFileIds` if anything else uses it; grep first — if unused, delete it too).
- Modify: `server/projectStore.test.ts:236-330` — delete the printout/proposal-photo cascade tests.
- Modify: `server/routes.test.ts:1483-1566` — replace the send-proposal block with a `POST /api/proposals/:id/send` block.
- Modify: `server/realtime/changeFeed.ts:9` and `src/hooks/useLiveQuery.ts:5` — add `'proposal'` to `EntityType`.
- Test: `server/proposalRoutes.test.ts`

**Interfaces (produced):**
```
GET    /api/proposals/outstanding                     (admin)  → summaries + projectName   ← REGISTER BEFORE /api/proposals/:id
GET    /api/projects/:id/proposals                    (admin)
POST   /api/projects/:id/proposals                    (admin)  body CreateProposalInput → { id, number, version }
GET    /api/proposals/:id                             (admin)
PUT    /api/proposals/:id                             (admin)  body ProposalInput & { version } → { success, version }
DELETE /api/proposals/:id                             (admin)  deletes generated file too (all versions)
POST   /api/proposals/:id/file                        (admin)  { fileId } → setProposalFile
POST   /api/proposals/:id/photos                      { fileId }
PATCH  /api/proposals/:id/photos/:fileId              { caption?, sortOrder? }
DELETE /api/proposals/:id/photos/:fileId
POST   /api/proposals/:id/attachments                 { fileId }
PATCH  /api/proposals/:id/attachments/:fileId         { sortOrder }
DELETE /api/proposals/:id/attachments/:fileId
POST   /api/proposals/:id/status                      { status: 'accepted'|'declined', signedFileId? }
POST   /api/proposals/:id/send   (in registerEmailRoutes)  SendBody → markSent on SMTP success
Errors: NotFound→404, Validation→400, Conflict→409 {code:'version_conflict'}, Locked→409 {code:'locked'}
Broadcast: { type: 'proposal', id, projectId, version?, action }
Activity: proposal_created / proposal_sent / proposal_accepted / proposal_declined
```

- [ ] **Step 1: Write failing route tests**

`server/proposalRoutes.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import { registerDataRoutes } from './routes';

let db: Database.Database;
let dir: string;
let events: any[];

const buildApp = (role: 'admin' | 'user') => {
  const a = express();
  a.use(express.json({ limit: '50mb' }));
  registerDataRoutes(a, {
    db, dataDir: dir, dbFile: path.join(dir, 'app.db'),
    authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: 'u1', role, username: 'nate' }; next(); },
    requireAdmin: (req: any, res: any, next: any) => (req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
    verifyToken: () => null,
    broadcastChange: (ev) => events.push(ev),
  });
  return a;
};
let app: express.Express;

beforeEach(() => {
  dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-prt-'));
  db = openDb(':memory:');
  runMigrations(db, dir, migrations);
  events = [];
  db.prepare(`INSERT INTO projects (id, name, createdAt, version, updatedAt, meta) VALUES ('p1', 'Job A', 1, 1, 1, '{}')`).run();
  db.prepare(`INSERT INTO takeoffs (id, projectId, name, type, color, sortOrder, attrs) VALUES ('t1', 'p1', 'Stucco', 'area', '#fff', 0, '{}')`).run();
  app = buildApp('admin');
});

const uploadPdf = async (id: string) => {
  const res = await request(app).post(`/api/files/${id}?projectId=p1&kind=document&name=${id}.pdf`).set('Content-Type', 'application/pdf').send(Buffer.from('%PDF'));
  expect(res.status).toBe(200);
  return res.body.fileId as string;
};

describe('proposal routes', () => {
  it('non-admin gets 403 on every proposal route', async () => {
    const u = buildApp('user');
    expect((await request(u).get('/api/projects/p1/proposals')).status).toBe(403);
    expect((await request(u).post('/api/projects/p1/proposals').send({})).status).toBe(403);
    expect((await request(u).get('/api/proposals/outstanding')).status).toBe(403);
    expect((await request(u).get('/api/proposals/x')).status).toBe(403);
  });

  it('create seeded from takeoffs, list, get, save, delete; broadcasts + activity', async () => {
    const c = await request(app).post('/api/projects/p1/proposals').send({ takeoffIds: ['t1'] });
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ number: 1, version: 1 });
    const id = c.body.id;
    expect(events.at(-1)).toMatchObject({ type: 'proposal', id, projectId: 'p1', action: 'created' });
    expect(db.prepare(`SELECT type FROM activity WHERE projectId = 'p1'`).all()).toEqual([{ type: 'proposal_created' }]);

    const list = await request(app).get('/api/projects/p1/proposals');
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ id, number: 1, status: 'draft', totalCents: 0 });

    const g = await request(app).get(`/api/proposals/${id}`);
    expect(g.body.lines[0]).toMatchObject({ kind: 'takeoff', takeoffId: 't1', description: 'Stucco' });

    const s = await request(app).put(`/api/proposals/${id}`).send({ version: 1, title: 'T', lines: [{ kind: 'manual', description: 'x', amountCents: 100 }] });
    expect(s.status).toBe(200);
    expect(s.body.version).toBe(2);
    const stale = await request(app).put(`/api/proposals/${id}`).send({ version: 1, title: 'old' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('version_conflict');

    const d = await request(app).delete(`/api/proposals/${id}`);
    expect(d.status).toBe(200);
    expect((await request(app).get(`/api/proposals/${id}`)).status).toBe(404);
  });

  it('outstanding lists sent proposals; :id route does not swallow "outstanding"', async () => {
    const c = await request(app).post('/api/projects/p1/proposals').send({ validUntil: '2026-09-15' });
    const fid = await uploadPdf('gen');
    await request(app).post(`/api/proposals/${c.body.id}/file`).send({ fileId: fid });
    db.prepare(`UPDATE proposals SET status = 'sent', sentAt = 5 WHERE id = ?`).run(c.body.id);
    const o = await request(app).get('/api/proposals/outstanding');
    expect(o.status).toBe(200);
    expect(o.body).toEqual([expect.objectContaining({ id: c.body.id, projectName: 'Job A', validUntil: '2026-09-15' })]);
  });

  it('photos + attachments routes; attachments must be PDFs; locked after sent → 409 locked', async () => {
    const c = await request(app).post('/api/projects/p1/proposals').send({});
    const id = c.body.id;
    const att = await uploadPdf('spec');
    expect((await request(app).post(`/api/proposals/${id}/attachments`).send({ fileId: att })).status).toBe(200);
    const img = await request(app).post('/api/files/img?projectId=p1&kind=proposal-photo&name=a.jpg').set('Content-Type', 'image/jpeg').send(Buffer.from('x'));
    expect((await request(app).post(`/api/proposals/${id}/attachments`).send({ fileId: img.body.fileId })).status).toBe(400);
    expect((await request(app).post(`/api/proposals/${id}/photos`).send({ fileId: img.body.fileId })).status).toBe(200);
    expect((await request(app).patch(`/api/proposals/${id}/photos/${img.body.fileId}`).send({ caption: 'cap' })).status).toBe(200);
    const g = await request(app).get(`/api/proposals/${id}`);
    expect(g.body.photos[0].caption).toBe('cap');
    expect(g.body.attachments[0]).toMatchObject({ fileId: att, name: 'spec.pdf' });

    db.prepare(`UPDATE proposals SET status = 'sent' WHERE id = ?`).run(id);
    const locked = await request(app).delete(`/api/proposals/${id}/photos/${img.body.fileId}`);
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe('locked');
  });

  it('status accepted/declined from sent only, logs activity', async () => {
    const c = await request(app).post('/api/projects/p1/proposals').send({});
    expect((await request(app).post(`/api/proposals/${c.body.id}/status`).send({ status: 'accepted' })).status).toBe(400);
    db.prepare(`UPDATE proposals SET status = 'sent' WHERE id = ?`).run(c.body.id);
    const signed = await uploadPdf('signed');
    const r = await request(app).post(`/api/proposals/${c.body.id}/status`).send({ status: 'accepted', signedFileId: signed });
    expect(r.status).toBe(200);
    expect((await request(app).get(`/api/proposals/${c.body.id}`)).body).toMatchObject({ status: 'accepted', signedFileId: signed });
    expect(db.prepare(`SELECT type FROM activity WHERE projectId = 'p1' ORDER BY rowid`).all().map((x: any) => x.type)).toEqual(['proposal_created', 'proposal_accepted']);
  });

  it('revise via POST with revisedFromId + carry flags', async () => {
    const c = await request(app).post('/api/projects/p1/proposals').send({});
    const img = await request(app).post('/api/files/img?projectId=p1&kind=proposal-photo&name=a.jpg').set('Content-Type', 'image/jpeg').send(Buffer.from('x'));
    await request(app).post(`/api/proposals/${c.body.id}/photos`).send({ fileId: img.body.fileId });
    const r = await request(app).post('/api/projects/p1/proposals').send({ revisedFromId: c.body.id, carryPhotos: false });
    expect(r.body.number).toBe(2);
    const g = await request(app).get(`/api/proposals/${r.body.id}`);
    expect(g.body.revisedFromNumber).toBe(1);
    expect(g.body.photos).toEqual([]);
  });
});
```

And in `server/routes.test.ts`, replace the `send-proposal` describe block (~1483-1566) with:

```ts
describe('POST /api/proposals/:id/send', () => {
  // mirrors the existing email-route harness in this file (registerEmailRoutes
  // with a stubbed transporter) — reuse the same `sent` capture + buildTransporter stub.
  it('sends the proposal PDF, marks sent with sentTo, logs proposal_sent, 409s a second send', async () => {
    // arrange: project p1, proposal draft with a generated fileId
    await request(app).post('/api/projects').send(PROJECT);
    const c = await request(app).post('/api/projects/p1/proposals').send({});
    const up = await request(app).post('/api/files/gen?projectId=p1&kind=proposal&name=Proposal.pdf&sourceType=proposal&sourceId=' + c.body.id)
      .set('Content-Type', 'application/pdf').send(Buffer.from('%PDF'));
    await request(app).post(`/api/proposals/${c.body.id}/file`).send({ fileId: up.body.fileId });
    const res = await request(emailApp).post(`/api/proposals/${c.body.id}/send`).send({ to: 'gc@x.com', cc: 'me@x.com', subject: 'Our proposal', body: 'hi', fileId: up.body.fileId });
    expect(res.status).toBe(200);
    expect(sent[0].to).toBe('gc@x.com');
    expect(sent[0].attachments[0].filename).toMatch(/\.pdf$/);
    const row = db.prepare('SELECT status, sentTo FROM proposals WHERE id = ?').get(c.body.id) as any;
    expect(row.status).toBe('sent');
    expect(JSON.parse(row.sentTo)).toEqual({ to: 'gc@x.com', cc: 'me@x.com', subject: 'Our proposal' });
    expect(db.prepare(`SELECT type FROM activity WHERE type = 'proposal_sent'`).all()).toHaveLength(1);
    const again = await request(emailApp).post(`/api/proposals/${c.body.id}/send`).send({ to: 'gc@x.com', subject: 's', fileId: up.body.fileId });
    expect(again.status).toBe(409);
  });

  it('does not mark sent when SMTP fails', async () => {
    await request(app).post('/api/projects').send(PROJECT);
    const c = await request(app).post('/api/projects/p1/proposals').send({});
    const up = await request(app).post('/api/files/gen2?projectId=p1&kind=proposal&name=P.pdf').set('Content-Type', 'application/pdf').send(Buffer.from('%PDF'));
    await request(app).post(`/api/proposals/${c.body.id}/file`).send({ fileId: up.body.fileId });
    const res = await request(failingEmailApp).post(`/api/proposals/${c.body.id}/send`).send({ to: 'gc@x.com', subject: 's', fileId: up.body.fileId });
    expect(res.status).toBe(500);
    expect((db.prepare('SELECT status FROM proposals WHERE id = ?').get(c.body.id) as any).status).toBe('draft');
  });
});
```
Read the existing send-proposal tests first (lines ~1220-1290 set up `emailApp` with a stubbed `buildTransporter` whose `sendMail` pushes into a `sent` array) and adapt the names (`emailApp`, `sent`, `failingEmailApp`) to what that harness actually calls them; add a failing-transport variant if none exists (`buildTransporter: () => ({ sendMail: async () => { throw new Error('smtp down'); } })`).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/proposalRoutes.test.ts server/routes.test.ts`
Expected: FAIL (404s — routes not registered).

- [ ] **Step 3: Implement `server/proposalRoutes.ts`**

```ts
// server/proposalRoutes.ts — admin-only proposal API
// (spec docs/superpowers/specs/2026-08-28-proposal-rework-design.md §4).
import express from 'express';
import type Database from 'better-sqlite3';
import { logActivity } from './activity';
import { listVersions, removeFile } from './files';
import { requestMeta, type BroadcastChange } from './realtime/changeFeed';
import {
  listProposals, listOutstanding, getProposal, createProposal, saveProposal, deleteProposal, setProposalFile,
  addPhoto, updatePhoto, removePhoto, addAttachment, updateAttachment, removeAttachment, setStatus,
  ValidationError, ConflictError, NotFoundError, LockedError,
} from './proposalStore';

export interface ProposalRouteDeps {
  db: Database.Database;
  dataDir: string;
  authenticateToken: express.RequestHandler;
  requireAdmin: express.RequestHandler;
  broadcastChange: BroadcastChange;
}

export const proposalErr = (e: unknown, res: express.Response) => {
  if (e instanceof NotFoundError) return res.status(404).json({ error: e.message });
  if (e instanceof LockedError) return res.status(409).json({ error: e.message, code: 'locked' });
  if (e instanceof ConflictError) return res.status(409).json({ error: e.message, code: 'version_conflict' });
  if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
  console.error('Proposal route error:', e);
  return res.status(500).json({ error: 'Proposal operation failed' });
};

export function registerProposalRoutes(app: express.Express, deps: ProposalRouteDeps): void {
  const { db, dataDir, authenticateToken, requireAdmin } = deps;
  const gate = [authenticateToken, requireAdmin];
  const broadcast = (req: express.Request, id: string, projectId: string, action: 'created' | 'updated' | 'deleted', version?: number) =>
    deps.broadcastChange({ type: 'proposal', id, projectId, version, action, ...requestMeta(req) });
  const user = (req: express.Request) => (req as any).user ?? {};

  // Must precede /api/proposals/:id or Express reads "outstanding" as an id.
  app.get('/api/proposals/outstanding', ...gate, (_req, res) => {
    try { res.json(listOutstanding(db)); } catch (e) { proposalErr(e, res); }
  });

  app.get('/api/projects/:id/proposals', ...gate, (req, res) => {
    try { res.json(listProposals(db, req.params.id)); } catch (e) { proposalErr(e, res); }
  });

  app.post('/api/projects/:id/proposals', ...gate, (req, res) => {
    try {
      const r = createProposal(db, req.params.id, req.body ?? {}, user(req).username);
      logActivity(db, { projectId: req.params.id, userId: user(req).id, type: 'proposal_created', message: `Proposal #${r.number} created` });
      broadcast(req, r.id, req.params.id, 'created', r.version);
      res.json(r);
    } catch (e) { proposalErr(e, res); }
  });

  app.get('/api/proposals/:id', ...gate, (req, res) => {
    try {
      const p = getProposal(db, req.params.id);
      if (!p) return res.status(404).json({ error: 'Proposal not found' });
      res.json(p);
    } catch (e) { proposalErr(e, res); }
  });

  app.put('/api/proposals/:id', ...gate, (req, res) => {
    try {
      const r = saveProposal(db, req.params.id, req.body ?? {});
      const row = getProposal(db, req.params.id);
      if (row) broadcast(req, req.params.id, row.projectId, 'updated', r.version);
      res.json({ success: true, ...r });
    } catch (e) { proposalErr(e, res); }
  });

  app.delete('/api/proposals/:id', ...gate, (req, res) => {
    try {
      const before = getProposal(db, req.params.id);
      if (!before) return res.status(404).json({ error: 'Proposal not found' });
      deleteProposal(db, req.params.id);
      if (before.fileId) {
        try { for (const v of listVersions(db, before.fileId)) removeFile(db, dataDir, v.id); }
        catch (e) { console.warn('[proposals] could not remove generated file', e); }
      }
      broadcast(req, req.params.id, before.projectId, 'deleted');
      res.json({ success: true });
    } catch (e) { proposalErr(e, res); }
  });

  app.post('/api/proposals/:id/file', ...gate, (req, res) => {
    try {
      if (typeof req.body?.fileId !== 'string' || !req.body.fileId) return res.status(400).json({ error: 'fileId is required' });
      setProposalFile(db, req.params.id, req.body.fileId);
      const row = getProposal(db, req.params.id);
      if (row) broadcast(req, req.params.id, row.projectId, 'updated');
      res.json({ success: true });
    } catch (e) { proposalErr(e, res); }
  });

  // photos / attachments — same shape, different store fns
  const subResource = (name: 'photos' | 'attachments', fns: {
    add: (db: Database.Database, id: string, fileId: string) => void;
    update: (db: Database.Database, id: string, fileId: string, patch: any) => void;
    remove: (db: Database.Database, id: string, fileId: string) => void;
  }) => {
    const after = (req: express.Request, res: express.Response) => {
      const row = getProposal(db, req.params.id);
      if (row) broadcast(req, req.params.id, row.projectId, 'updated');
      res.json({ success: true });
    };
    app.post(`/api/proposals/:id/${name}`, ...gate, (req, res) => {
      try { fns.add(db, req.params.id, req.body?.fileId); after(req, res); } catch (e) { proposalErr(e, res); }
    });
    app.patch(`/api/proposals/:id/${name}/:fileId`, ...gate, (req, res) => {
      try { fns.update(db, req.params.id, req.params.fileId, req.body ?? {}); after(req, res); } catch (e) { proposalErr(e, res); }
    });
    app.delete(`/api/proposals/:id/${name}/:fileId`, ...gate, (req, res) => {
      try { fns.remove(db, req.params.id, req.params.fileId); after(req, res); } catch (e) { proposalErr(e, res); }
    });
  };
  subResource('photos', { add: addPhoto, update: updatePhoto, remove: removePhoto });
  subResource('attachments', { add: addAttachment, update: updateAttachment, remove: removeAttachment });

  app.post('/api/proposals/:id/status', ...gate, (req, res) => {
    try {
      const status = req.body?.status;
      const r = setStatus(db, req.params.id, status, req.body?.signedFileId ?? null);
      const row = getProposal(db, req.params.id);
      if (row) {
        logActivity(db, { projectId: row.projectId, userId: user(req).id, type: `proposal_${status}`, message: `Proposal #${row.number} ${status}` });
        broadcast(req, req.params.id, row.projectId, 'updated', r.version);
      }
      res.json({ success: true, ...r });
    } catch (e) { proposalErr(e, res); }
  });
}
```

Wire into `server/routes.ts`:
- `import { registerProposalRoutes, proposalErr } from './proposalRoutes';` and `import { getProposal, markSent, LockedError as ProposalLockedError } from './proposalStore';`
- At the end of `registerDataRoutes` (before its closing brace): `registerProposalRoutes(app, { db, dataDir, authenticateToken, requireAdmin, broadcastChange: deps.broadcastChange });`
- In `registerEmailRoutes`, replace the `send-proposal` route with:

```ts
  // Send a proposal PDF via SMTP (admin only). Marks sent only after SMTP succeeds.
  app.post('/api/proposals/:id/send', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const p = getProposal(db, req.params.id);
      if (!p) return res.status(404).json({ error: 'Proposal not found' });
      if (p.legacy || p.status !== 'draft') return res.status(409).json({ error: 'Proposal already sent', code: 'locked' });
      const { to, fileId, message, cc, bcc, subject: subjectIn, body, attachmentFileIds } = req.body as SendBody;
      if (!to || !fileId) return res.status(400).json({ error: 'to and fileId are required' });
      const project = loadProject(db, p.projectId);
      const subject = subjectIn?.trim() || `Proposal — ${project?.name ?? 'Untitled'}`;
      await send((req as any).user.id, {
        to, cc, bcc, subject,
        text: body ?? message ?? 'Please find the attached proposal.',
        attachments: buildSendAttachments(db, { fileId, attachmentName: 'Proposal.pdf' }, attachmentFileIds),
        inReplyTo: project?.email?.messageId || undefined,
      });
      const r = markSent(db, p.id, { to, cc, subject });
      logActivity(db, { projectId: p.projectId, userId: (req as any).user?.id, type: 'proposal_sent', message: `Proposal #${p.number} emailed to ${to}` });
      deps.broadcastChange({ type: 'proposal', id: p.id, projectId: p.projectId, version: r.version, action: 'updated', ...requestMeta(req) });
      res.json({ success: true, ...r });
    } catch (e: any) {
      if (e instanceof ProposalLockedError) return proposalErr(e, res);
      console.error('Error sending proposal:', e);
      res.status(500).json({ error: e.message || 'Failed to send proposal' });
    }
  });
```

`server/projectStore.ts`: delete `droppedSourceFileIds`, the `dropped` variable and post-commit loop in `saveProject`, and (if now unused) `referencedFileIds` + the `listVersions/removeFile` imports. `saveProject` keeps its `dataDir?` parameter for signature stability.

`server/realtime/changeFeed.ts` + `src/hooks/useLiveQuery.ts`: add `| 'proposal'` to `EntityType`.

`server/projectStore.test.ts`: delete the describe block(s) at ~236-330 covering "printout/proposal-photo cascade".

- [ ] **Step 4: Run tests**

Run: `npx vitest run --project server`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run lint
git add server/proposalRoutes.ts server/proposalRoutes.test.ts server/routes.ts server/routes.test.ts server/projectStore.ts server/projectStore.test.ts server/realtime/changeFeed.ts src/hooks/useLiveQuery.ts
git commit -m "feat(proposals): admin proposal routes, send route, drop legacy send-proposal + printout cascade"
```

---

### Task 5: Client types, API helpers, document kinds

**Files:**
- Modify: `src/types.ts:80-86` (delete `Printout`), `:195-218` (delete `printouts`, `proposalFileId`, `proposalSentAt`, `proposalPhotoIds`, `proposalCoverNotes`, `proposalTerms`)
- Modify: `src/utils/store.ts` — remove `sendProjectProposal` (:357); add `mimes` to `DocumentFilters` + `getDocuments`; add proposal API section.
- Modify: `src/pages/documents/docTypes.ts` — new kinds + `company-document` direct-upload.
- Modify: `src/pages/documents/documentsPolicy.ts` — no change needed (company-document is direct-upload via `isDirectUploadKind`).
- Test: `src/pages/documents/docTypes.test.ts` (extend), `src/utils/store.proposals.test.ts` (new, small)

**Interfaces (produced — every later client task imports these):**

```ts
// src/utils/store.ts
export type ProposalStatus = 'draft' | 'sent' | 'accepted' | 'declined';
export interface ProposalLine {
  id: string; sortOrder: number; kind: 'manual' | 'takeoff'; takeoffId: string | null;
  description: string; amountCents: number; derivedAmountCents: number | null;
  measurementSummary: string | null; isAlternate: boolean;
}
export interface ProposalLineInput extends Omit<ProposalLine, 'id' | 'sortOrder'> { id?: string }
export interface ProposalPhoto { id: string; fileId: string; sortOrder: number; caption: string | null }
export interface ProposalAttachment { id: string; fileId: string; sortOrder: number; name: string | null; mime: string | null; size: number | null }
export interface PaymentScheduleRow { description: string; percent: number | null; amountCents: number | null }
export interface ProposalSummary {
  id: string; projectId: string; number: number; revisedFromId: string | null; revisedFromNumber: number | null;
  status: ProposalStatus; legacy: boolean; title: string | null; validUntil: string | null;
  fontFamily: 'helvetica' | 'times' | 'courier' | null; coverNotes: string | null; terms: string | null;
  inclusions: string[]; exclusions: string[]; paymentSchedule: PaymentScheduleRow[] | null;
  showGrandTotal: boolean; includeCostDetail: boolean; includeSignature: boolean; highlightQuality: 'best' | 'email';
  fileId: string | null; signedFileId: string | null;
  sentAt: number | null; sentTo: { to: string; cc?: string; subject: string } | null;
  acceptedAt: number | null; declinedAt: number | null;
  version: number; createdBy: string | null; createdAt: number; updatedAt: number;
  totalCents: number; alternateCount: number; hasOverride: boolean; photoCount: number; attachmentCount: number;
}
export interface Proposal extends ProposalSummary { lines: ProposalLine[]; photos: ProposalPhoto[]; attachments: ProposalAttachment[] }
export interface OutstandingProposal extends ProposalSummary { projectName: string | null }
export interface ProposalSaveInput {
  version: number; title?: string | null; validUntil?: string | null; fontFamily?: string | null;
  coverNotes?: string | null; terms?: string | null; inclusions?: string[]; exclusions?: string[];
  paymentSchedule?: PaymentScheduleRow[] | null; showGrandTotal?: boolean; includeCostDetail?: boolean;
  includeSignature?: boolean; highlightQuality?: 'best' | 'email'; lines?: ProposalLineInput[];
}
export class ProposalLockedError extends Error {}

export const getProposals = (projectId: string): Promise<ProposalSummary[]>
export const getOutstandingProposals = (): Promise<OutstandingProposal[]>
export const getProposal = (id: string): Promise<Proposal>
export const createProposal = (projectId: string, input: { takeoffIds?: string[]; revisedFromId?: string; carryPhotos?: boolean; carryAttachments?: boolean } & Partial<Omit<ProposalSaveInput, 'version'>>): Promise<{ id: string; number: number; version: number }>
export const saveProposal = (id: string, input: ProposalSaveInput): Promise<{ version: number }>   // 409 version_conflict → throws ConflictError(id); 409 locked → throws ProposalLockedError
export const deleteProposal = (id: string): Promise<void>
export const setProposalFile = (id: string, fileId: string): Promise<void>
export const addProposalPhoto = (id: string, fileId: string): Promise<void>
export const updateProposalPhoto = (id: string, fileId: string, patch: { caption?: string | null; sortOrder?: number }): Promise<void>
export const removeProposalPhoto = (id: string, fileId: string): Promise<void>
export const addProposalAttachment = (id: string, fileId: string): Promise<void>
export const updateProposalAttachment = (id: string, fileId: string, patch: { sortOrder: number }): Promise<void>
export const removeProposalAttachment = (id: string, fileId: string): Promise<void>
export const setProposalStatus = (id: string, status: 'accepted' | 'declined', signedFileId?: string | null): Promise<{ version: number }>
export const sendProposal = (id: string, payload: { to: string; cc?: string; bcc?: string; subject?: string; body?: string; fileId: string; attachmentFileIds?: string[] }): Promise<{ version: number }>
```

- [ ] **Step 1: Write the failing tests**

Extend `src/pages/documents/docTypes.test.ts`:
```ts
it('knows the proposal-rework kinds and treats company-document as a direct upload', () => {
  expect(kindLabel('takeoff-print')).toBe('Takeoff Print');
  expect(kindLabel('takeoff-export')).toBe('Takeoff Export');
  expect(kindLabel('proposal-signed')).toBe('Signed Proposal');
  expect(kindLabel('company-document')).toBe('Company Document');
  expect(isDirectUploadKind('company-document')).toBe(true);
  expect(isDirectUploadKind('takeoff-print')).toBe(false);
  expect(KIND_OPTIONS.map(o => o.id)).not.toContain('printout');
});
```

New `src/utils/store.proposals.test.ts` (ui project, jsdom):
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { saveProposal, ProposalLockedError, ConflictError, getDocuments } from './store';

const mockFetch = (status: number, body: unknown) => {
  const fn = vi.fn(async () => ({ ok: status < 400, status, json: async () => body, blob: async () => new Blob() }));
  vi.stubGlobal('fetch', fn);
  return fn;
};
beforeEach(() => { localStorage.setItem('token', 't'); });

describe('proposal API helpers', () => {
  it('maps 409 locked to ProposalLockedError and 409 version_conflict to ConflictError', async () => {
    mockFetch(409, { error: 'locked', code: 'locked' });
    await expect(saveProposal('x', { version: 1 })).rejects.toBeInstanceOf(ProposalLockedError);
    mockFetch(409, { error: 'stale', code: 'version_conflict' });
    await expect(saveProposal('x', { version: 1 })).rejects.toBeInstanceOf(ConflictError);
  });
  it('getDocuments forwards mimes', async () => {
    const fn = mockFetch(200, { rows: [], total: 0 });
    await getDocuments({ mimes: ['application/pdf', 'image/'] });
    expect(String(fn.mock.calls[0][0])).toContain('mimes=application%2Fpdf%2Cimage%2F');
  });
});
```
(`fetchWithRetry` wraps `fetch`; check its retry conditions in `store.ts` — a 409 is not retried, so the stub is called once.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/pages/documents/docTypes.test.ts src/utils/store.proposals.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/pages/documents/docTypes.ts` — in `KIND_META` remove the `printout` entry and add:
```ts
  'proposal-signed':    { label: 'Signed Proposal',    tone: 'blue' },
  'takeoff-print':      { label: 'Takeoff Print',      tone: 'slate' },
  'takeoff-export':     { label: 'Takeoff Export',     tone: 'green' },
  'company-document':   { label: 'Company Document',   tone: 'violet' },
```
and `export const DIRECT_UPLOAD_KINDS = ['document', 'spreadsheet', 'photo', 'other', 'company-document'] as const;`

`src/types.ts`: delete the `Printout` interface and the six `Project` fields listed above. Run `npm run lint` — every compile error is a call site that must be removed or rewritten in Tasks 9 and 13 (`ProjectView.tsx`, `ProjectProposal.tsx`, `documents/*`, `e2e` seeds are not type-checked). For THIS task, get `lint` green by: (a) leaving `ProjectProposal.tsx` compiling via a temporary `// @ts-nocheck` at the top of the file (it is deleted in Task 13); (b) in `ProjectView.tsx` handlePrint/handleExportExcel, temporarily remove the `printouts:` spread and the `Printout` import (Task 9 rewrites those functions fully).

`src/utils/store.ts`:
- `DocumentFilters` gains `mimes?: string[]`; `getDocuments` adds `if (filters.mimes?.length) p.set('mimes', filters.mimes.join(','));`
- Delete `sendProjectProposal`.
- Add a "Proposals" section after the daily-report helpers:

```ts
// ── Proposals (admin-only; spec 2026-08-28) ─────────────────────────────────
export class ProposalLockedError extends Error { constructor() { super('Proposal is locked'); this.name = 'ProposalLockedError'; } }
const proposalJson = (method: string, url: string, body?: unknown) =>
  fetchWithRetry(url, { method, headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
// 409s carry a `code`: locked (not a draft) vs version_conflict (stale save).
const handleProposalResponse = async (res: Response, id: string) => {
  if (res.status === 409) {
    const body = await res.clone().json().catch(() => ({}));
    if (body?.code === 'locked') throw new ProposalLockedError();
    throw new ConflictError(id);
  }
  await handleResponse(res);
};
export const getProposals = async (projectId: string): Promise<ProposalSummary[]> => {
  const res = await proposalJson('GET', `/api/projects/${projectId}/proposals`); await handleResponse(res); return res.json();
};
export const getOutstandingProposals = async (): Promise<OutstandingProposal[]> => {
  const res = await proposalJson('GET', '/api/proposals/outstanding'); await handleResponse(res); return res.json();
};
export const getProposal = async (id: string): Promise<Proposal> => {
  const res = await proposalJson('GET', `/api/proposals/${id}`); await handleResponse(res); return res.json();
};
export const createProposal = async (projectId: string, input: { takeoffIds?: string[]; revisedFromId?: string; carryPhotos?: boolean; carryAttachments?: boolean } & Partial<Omit<ProposalSaveInput, 'version'>>) => {
  const res = await proposalJson('POST', `/api/projects/${projectId}/proposals`, input); await handleResponse(res);
  return res.json() as Promise<{ id: string; number: number; version: number }>;
};
export const saveProposal = async (id: string, input: ProposalSaveInput): Promise<{ version: number }> => {
  const res = await proposalJson('PUT', `/api/proposals/${id}`, input); await handleProposalResponse(res, id); return res.json();
};
export const deleteProposal = async (id: string): Promise<void> => {
  const res = await proposalJson('DELETE', `/api/proposals/${id}`); await handleProposalResponse(res, id);
};
export const setProposalFile = async (id: string, fileId: string): Promise<void> => {
  const res = await proposalJson('POST', `/api/proposals/${id}/file`, { fileId }); await handleProposalResponse(res, id);
};
const sub = (name: 'photos' | 'attachments') => ({
  add: async (id: string, fileId: string) => { const res = await proposalJson('POST', `/api/proposals/${id}/${name}`, { fileId }); await handleProposalResponse(res, id); },
  update: async (id: string, fileId: string, patch: Record<string, unknown>) => { const res = await proposalJson('PATCH', `/api/proposals/${id}/${name}/${encodeURIComponent(fileId)}`, patch); await handleProposalResponse(res, id); },
  remove: async (id: string, fileId: string) => { const res = await proposalJson('DELETE', `/api/proposals/${id}/${name}/${encodeURIComponent(fileId)}`); await handleProposalResponse(res, id); },
});
const photosApi = sub('photos'); const attachmentsApi = sub('attachments');
export const addProposalPhoto = photosApi.add;
export const updateProposalPhoto = (id: string, fileId: string, patch: { caption?: string | null; sortOrder?: number }) => photosApi.update(id, fileId, patch);
export const removeProposalPhoto = photosApi.remove;
export const addProposalAttachment = attachmentsApi.add;
export const updateProposalAttachment = (id: string, fileId: string, patch: { sortOrder: number }) => attachmentsApi.update(id, fileId, patch);
export const removeProposalAttachment = attachmentsApi.remove;
export const setProposalStatus = async (id: string, status: 'accepted' | 'declined', signedFileId?: string | null): Promise<{ version: number }> => {
  const res = await proposalJson('POST', `/api/proposals/${id}/status`, { status, signedFileId: signedFileId ?? null }); await handleResponse(res); return res.json();
};
export const sendProposal = async (id: string, payload: { to: string; cc?: string; bcc?: string; subject?: string; body?: string; fileId: string; attachmentFileIds?: string[] }): Promise<{ version: number }> => {
  const res = await proposalJson('POST', `/api/proposals/${id}/send`, payload); await handleProposalResponse(res, id); return res.json();
};
```
plus the interfaces listed under Interfaces above.

- [ ] **Step 4: Run tests + lint**

Run: `npx vitest run --project ui && npm run lint`
Expected: PASS / clean (with the two temporary measures noted).

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/utils/store.ts src/utils/store.proposals.test.ts src/pages/documents/docTypes.ts src/pages/documents/docTypes.test.ts src/pages/ProjectView.tsx src/pages/project/ProjectProposal.tsx
git commit -m "feat(proposals): client types, proposal API helpers, new document kinds"
```

---

### Task 6: `proposalMath.ts` — pure line math

**Files:**
- Create: `src/pages/project/proposal/proposalMath.ts`
- Test: `src/pages/project/proposal/proposalMath.test.ts`

**Interfaces (produced):**
```ts
export const toCents = (dollars: number): number            // Math.round(dollars * 100)
export const centsToDollars = (c: number): string           // '1,234.56' style via formatCurrency without '$'? → use formatCurrency(c/100)
export const isOverridden = (l: Pick<ProposalLine,'kind'|'amountCents'|'derivedAmountCents'>): boolean
export const measurementSummary = (t: TakeoffTotals): string   // e.g. "4,120.00 sq ft" — from t.totalRealValue + UNIT_LABELS[t.unit]||t.unit
export const derivedCents = (t: TakeoffTotals): number      // toCents(roundUpTo100(calculateTakeoffTotalCost(t, t.totalRealValue)))
export function rederiveLines(lines: ProposalLine[], totals: TakeoffTotals[]): { lines: ProposalLine[]; missingTakeoffIds: string[] }
   // for each takeoff line: if takeoff found → derived = derivedCents(t), summary = measurementSummary(t), description unchanged;
   //   if NOT overridden before → amountCents = new derived; if overridden → keep amountCents. Missing takeoffs → unchanged + listed.
export function lineFromTakeoff(t: TakeoffTotals): ProposalLineInput
export function proposalTotals(lines: ProposalLine[]): { totalCents: number; alternateCents: number; takeoffLines: ProposalLine[]; manualLines: ProposalLine[]; altTakeoff: ProposalLine[]; altManual: ProposalLine[] }
export function scheduleAmountCents(row: PaymentScheduleRow, totalCents: number): number   // percent → round(total*percent/100), else amountCents ?? 0
```

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { isOverridden, rederiveLines, proposalTotals, scheduleAmountCents, lineFromTakeoff, measurementSummary, derivedCents, toCents } from './proposalMath';
import type { TakeoffTotals } from './proposalGenerator';
import type { ProposalLine } from '../../../utils/store';

const t = (id: string, name: string, cost: number, val = 100, unit = 'sqft'): TakeoffTotals =>
  ({ id, name, type: 'area', color: '#fff', unit, costPerUnit: cost, totalRealValue: val, pageBreakdown: [] } as any);
const line = (o: Partial<ProposalLine>): ProposalLine =>
  ({ id: 'l', sortOrder: 0, kind: 'manual', takeoffId: null, description: '', amountCents: 0, derivedAmountCents: null, measurementSummary: null, isAlternate: false, ...o });

describe('proposalMath', () => {
  it('detects overrides only on takeoff lines with a derived amount', () => {
    expect(isOverridden(line({ kind: 'takeoff', amountCents: 100, derivedAmountCents: 90 }))).toBe(true);
    expect(isOverridden(line({ kind: 'takeoff', amountCents: 90, derivedAmountCents: 90 }))).toBe(false);
    expect(isOverridden(line({ kind: 'takeoff', amountCents: 90, derivedAmountCents: null }))).toBe(false);
    expect(isOverridden(line({ kind: 'manual', amountCents: 5, derivedAmountCents: 1 }))).toBe(false);
  });

  it('derives cents from takeoff cost rounded up to $100 and builds a summary', () => {
    const tk = t('t1', 'Stucco', 10.15, 41.7); // 423.255 → roundUpTo100 → 500
    expect(derivedCents(tk)).toBe(50000);
    expect(measurementSummary(tk)).toBe('41.70 sq ft');
    expect(lineFromTakeoff(tk)).toEqual({ kind: 'takeoff', takeoffId: 't1', description: 'Stucco', amountCents: 50000, derivedAmountCents: 50000, measurementSummary: '41.70 sq ft', isAlternate: false });
  });

  it('rederives non-overridden lines, keeps overrides, reports missing takeoffs', () => {
    const lines = [
      line({ id: 'a', kind: 'takeoff', takeoffId: 't1', amountCents: 10000, derivedAmountCents: 10000 }),
      line({ id: 'b', kind: 'takeoff', takeoffId: 't2', amountCents: 99900, derivedAmountCents: 10000 }),
      line({ id: 'c', kind: 'takeoff', takeoffId: 'gone', amountCents: 5, derivedAmountCents: 5 }),
      line({ id: 'd', kind: 'manual', amountCents: 7 }),
    ];
    const r = rederiveLines(lines, [t('t1', 'A', 2, 100), t('t2', 'B', 2, 100)]); // 200 → 200
    expect(r.lines.find(l => l.id === 'a')).toMatchObject({ amountCents: 20000, derivedAmountCents: 20000, measurementSummary: '100.00 sq ft' });
    expect(r.lines.find(l => l.id === 'b')).toMatchObject({ amountCents: 99900, derivedAmountCents: 20000 });
    expect(r.lines.find(l => l.id === 'c')).toMatchObject({ amountCents: 5 });
    expect(r.lines.find(l => l.id === 'd')).toMatchObject({ amountCents: 7 });
    expect(r.missingTakeoffIds).toEqual(['gone']);
  });

  it('totals exclude alternates and split groups', () => {
    const r = proposalTotals([
      line({ kind: 'takeoff', takeoffId: 't', amountCents: 100 }),
      line({ kind: 'manual', amountCents: 20 }),
      line({ kind: 'manual', amountCents: 5, isAlternate: true }),
      line({ kind: 'takeoff', takeoffId: 'u', amountCents: 7, isAlternate: true }),
    ]);
    expect(r.totalCents).toBe(120);
    expect(r.alternateCents).toBe(12);
    expect([r.takeoffLines.length, r.manualLines.length, r.altTakeoff.length, r.altManual.length]).toEqual([1, 1, 1, 1]);
  });

  it('schedule rows resolve percent or fixed cents', () => {
    expect(scheduleAmountCents({ description: '', percent: 50, amountCents: null }, 12345)).toBe(6173);
    expect(scheduleAmountCents({ description: '', percent: null, amountCents: 700 }, 12345)).toBe(700);
    expect(toCents(19.999)).toBe(2000);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/pages/project/proposal/proposalMath.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// src/pages/project/proposal/proposalMath.ts — pure helpers for proposal lines.
import { calculateTakeoffTotalCost, roundUpTo100, UNIT_LABELS } from '../../../utils/math';
import type { TakeoffTotals } from './proposalGenerator';
import type { ProposalLine, ProposalLineInput, PaymentScheduleRow } from '../../../utils/store';

export const toCents = (dollars: number): number => Math.round(dollars * 100);

export const isOverridden = (l: Pick<ProposalLine, 'kind' | 'amountCents' | 'derivedAmountCents'>): boolean =>
  l.kind === 'takeoff' && l.derivedAmountCents !== null && l.amountCents !== l.derivedAmountCents;

const unitLabel = (t: TakeoffTotals) =>
  UNIT_LABELS[t.unit || ''] || t.unit || (t.type === 'area' ? 'sq ft' : t.type === 'length' ? 'ft' : 'ea');

export const measurementSummary = (t: TakeoffTotals): string =>
  `${t.totalRealValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${unitLabel(t)}`;

export const derivedCents = (t: TakeoffTotals): number =>
  toCents(roundUpTo100(calculateTakeoffTotalCost(t, t.totalRealValue)));

export function lineFromTakeoff(t: TakeoffTotals): ProposalLineInput {
  const d = derivedCents(t);
  return { kind: 'takeoff', takeoffId: t.id, description: t.name, amountCents: d, derivedAmountCents: d, measurementSummary: measurementSummary(t), isAlternate: false };
}

export function rederiveLines(lines: ProposalLine[], totals: TakeoffTotals[]): { lines: ProposalLine[]; missingTakeoffIds: string[] } {
  const byId = new Map(totals.map(t => [t.id, t]));
  const missing: string[] = [];
  const out = lines.map(l => {
    if (l.kind !== 'takeoff' || !l.takeoffId) return l;
    const t = byId.get(l.takeoffId);
    if (!t) { missing.push(l.takeoffId); return l; }
    const d = derivedCents(t);
    const overridden = isOverridden(l);
    return { ...l, derivedAmountCents: d, measurementSummary: measurementSummary(t), amountCents: overridden ? l.amountCents : d };
  });
  return { lines: out, missingTakeoffIds: missing };
}

export function proposalTotals(lines: ProposalLine[]) {
  const base = lines.filter(l => !l.isAlternate);
  const alt = lines.filter(l => l.isAlternate);
  const sum = (xs: ProposalLine[]) => xs.reduce((s, l) => s + l.amountCents, 0);
  return {
    totalCents: sum(base), alternateCents: sum(alt),
    takeoffLines: base.filter(l => l.kind === 'takeoff'), manualLines: base.filter(l => l.kind === 'manual'),
    altTakeoff: alt.filter(l => l.kind === 'takeoff'), altManual: alt.filter(l => l.kind === 'manual'),
  };
}

export const scheduleAmountCents = (row: PaymentScheduleRow, totalCents: number): number =>
  row.percent != null ? Math.round(totalCents * row.percent / 100) : (row.amountCents ?? 0);
```

- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `git add src/pages/project/proposal/proposalMath.ts src/pages/project/proposal/proposalMath.test.ts && git commit -m "feat(proposals): pure line math (derive/override/totals)"`

---

### Task 7: `FilePickerModal` (reusable server-file picker)

**Files:**
- Create: `src/components/FilePickerModal.tsx`
- Test: `src/components/FilePickerModal.test.tsx`

**Interfaces (produced):**
```tsx
export interface FilePickerModalProps {
  open: boolean;
  onClose: () => void;
  onPick: (rows: DocumentRow[]) => void | Promise<void>;
  accept?: 'pdf' | 'image' | 'any';       // default 'any' → mimes filter ['application/pdf'] | ['image/'] | none
  multi?: boolean;                          // default true
  excludeFileIds?: string[];                // already-attached → hidden
  initialProjectIds?: string[];             // pre-filter (e.g. current project); user can clear it
  title?: string;                           // default 'Choose files'
}
export const FilePickerModal: React.FC<FilePickerModalProps>
```
Behavior: renders `Modal` (width `'xl'` if available, else `'lg'`) containing `DocumentsFilterBar` (q, projects, customers, kinds, archived; `isAdmin` from localStorage user role; `unassigned` toggle hidden — pass `isAdmin={false}` for that prop only to hide it while still letting admins see admin kinds server-side), a scrollable list of rows (`MimeIcon` + name + kind pill via `kindLabel/kindTone` + project name + date + size) with checkboxes (radio-like when `!multi`), hover preview via `DocumentHoverPreview` on hover-capable pointers, "Load more" (PAGE_SIZE 100), footer `Cancel` / `Add N file(s)`. Fetches via `getDocuments({ ..., mimes })`; loads `getProjectsSummary()`, `getCustomers()`, `getDocumentTypes()` for the filter options (same as DocumentsPage). Resets selection on open.

- [ ] **Step 1: Write failing tests**

```tsx
// src/components/FilePickerModal.test.tsx
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FilePickerModal } from './FilePickerModal';

vi.mock('../utils/store', async (orig) => ({
  ...(await orig<typeof import('../utils/store')>()),
  getDocuments: vi.fn(async (f: any) => ({
    rows: [
      { id: 'a', name: 'Warranty.pdf', mime: 'application/pdf', size: 10, kind: 'company-document', createdAt: 1, versionNumber: 1, archived: false, projectId: null, projectName: null, customerId: null, customerName: null, source: null },
      { id: 'b', name: 'Spec.pdf', mime: 'application/pdf', size: 10, kind: 'document', createdAt: 2, versionNumber: 1, archived: false, projectId: 'p1', projectName: 'Job', customerId: null, customerName: null, source: null },
    ].filter(r => !f.q || r.name.toLowerCase().includes(f.q.toLowerCase())),
    total: 2,
  })),
  getProjectsSummary: vi.fn(async () => []),
  getCustomers: vi.fn(async () => []),
  getDocumentTypes: vi.fn(async () => []),
}));
import { getDocuments } from '../utils/store';

beforeEach(() => { localStorage.setItem('user', JSON.stringify({ id: 'u', role: 'admin' })); vi.clearAllMocks(); });

describe('FilePickerModal', () => {
  it('lists documents, requests the pdf mime filter, hides excluded ids, and returns picked rows', async () => {
    const onPick = vi.fn();
    render(<FilePickerModal open onClose={() => {}} onPick={onPick} accept="pdf" excludeFileIds={['b']} />);
    await screen.findByText('Warranty.pdf');
    expect(screen.queryByText('Spec.pdf')).toBeNull();
    expect((getDocuments as any).mock.calls[0][0].mimes).toEqual(['application/pdf']);
    fireEvent.click(screen.getByRole('checkbox', { name: /Warranty\.pdf/ }));
    fireEvent.click(screen.getByRole('button', { name: /Add 1 file/ }));
    await waitFor(() => expect(onPick).toHaveBeenCalledWith([expect.objectContaining({ id: 'a' })]));
  });

  it('single-select mode replaces the selection', async () => {
    const onPick = vi.fn();
    render(<FilePickerModal open onClose={() => {}} onPick={onPick} multi={false} />);
    await screen.findByText('Spec.pdf');
    fireEvent.click(screen.getByRole('checkbox', { name: /Warranty\.pdf/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Spec\.pdf/ }));
    fireEvent.click(screen.getByRole('button', { name: /Add 1 file/ }));
    await waitFor(() => expect(onPick).toHaveBeenCalledWith([expect.objectContaining({ id: 'b' })]));
  });

  it('search re-queries', async () => {
    render(<FilePickerModal open onClose={() => {}} onPick={() => {}} />);
    await screen.findByText('Spec.pdf');
    fireEvent.change(screen.getByLabelText('Search documents'), { target: { value: 'warr' } });
    await waitFor(() => expect((getDocuments as any).mock.calls.at(-1)[0].q).toBe('warr'), { timeout: 2000 });
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/components/FilePickerModal.test.tsx` → FAIL.

- [ ] **Step 3: Implement `src/components/FilePickerModal.tsx`**

```tsx
// src/components/FilePickerModal.tsx — pick files already on the server.
// Reuses the Documents page's filter bar + row presentation
// (spec docs/superpowers/specs/2026-08-28-proposal-rework-design.md §5).
import React, { useEffect, useMemo, useState } from 'react';
import { Customer } from '../types';
import { DocumentRow, ProjectSummary, getCustomers, getDocumentTypes, getDocuments, getProjectsSummary } from '../utils/store';
import { Button, Modal, Skeleton, StatusPill } from './ui';
import { DocumentsFilterBar } from '../pages/documents/DocumentsFilterBar';
import { DocumentHoverPreview } from '../pages/documents/DocumentHoverPreview';
import { MimeIcon } from '../pages/documents/MimeIcon';
import { CustomDocType, KIND_OPTIONS, kindLabel, kindTone } from '../pages/documents/docTypes';
import { MultiSelectOption } from '../pages/documents/MultiSelectDropdown';

const PAGE_SIZE = 100;
const MIMES: Record<NonNullable<FilePickerModalProps['accept']>, string[] | undefined> = { pdf: ['application/pdf'], image: ['image/'], any: undefined };
const isAdmin = () => (JSON.parse(localStorage.getItem('user') || '{}').role) === 'admin';
const fmtSize = (n: number) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

export interface FilePickerModalProps {
  open: boolean;
  onClose: () => void;
  onPick: (rows: DocumentRow[]) => void | Promise<void>;
  accept?: 'pdf' | 'image' | 'any';
  multi?: boolean;
  excludeFileIds?: string[];
  initialProjectIds?: string[];
  title?: string;
}

export const FilePickerModal: React.FC<FilePickerModalProps> = ({
  open, onClose, onPick, accept = 'any', multi = true, excludeFileIds = [], initialProjectIds = [], title = 'Choose files',
}) => {
  const [q, setQ] = useState('');
  const [projectIds, setProjectIds] = useState<string[]>(initialProjectIds);
  const [customerIds, setCustomerIds] = useState<string[]>([]);
  const [kinds, setKinds] = useState<string[]>([]);
  const [archived, setArchived] = useState(false);
  const [rows, setRows] = useState<DocumentRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Map<string, DocumentRow>>(new Map());
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customTypes, setCustomTypes] = useState<CustomDocType[]>([]);
  const [hover, setHover] = useState<{ row: DocumentRow; x: number; y: number } | null>(null);
  const [hoverCapable] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia('(hover: hover)').matches);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelected(new Map());
    setProjectIds(initialProjectIds);
    getProjectsSummary().then(setProjects).catch(() => setProjects([]));
    getCustomers().then(setCustomers).catch(() => setCustomers([]));
    getDocumentTypes().then(setCustomTypes).catch(() => setCustomTypes([]));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const filterKey = `${open}|${q}|${projectIds.join(',')}|${customerIds.join(',')}|${kinds.join(',')}|${archived}|${accept}`;
  const fetchPage = async (offset: number) => {
    setLoading(true);
    try {
      const res = await getDocuments({ q: q || undefined, projectIds, customerIds, kinds, archived, mimes: MIMES[accept], limit: PAGE_SIZE, offset });
      setRows(prev => offset === 0 ? res.rows : [...prev, ...res.rows]);
      setTotal(res.total);
    } catch { if (offset === 0) { setRows([]); setTotal(0); } }
    finally { setLoading(false); }
  };
  useEffect(() => { if (open) fetchPage(0); }, [filterKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const excluded = useMemo(() => new Set(excludeFileIds), [excludeFileIds]);
  const visible = rows.filter(r => !excluded.has(r.id));
  const projectOptions: MultiSelectOption[] = projects.map(p => ({ id: p.id, label: p.name }));
  const customerOptions: MultiSelectOption[] = customers.map(c => ({ id: c.id, label: c.name }));
  const kindOptions: MultiSelectOption[] = [...KIND_OPTIONS, ...customTypes.map(t => ({ id: `custom:${t.id}`, label: t.label }))];

  const toggle = (row: DocumentRow) => setSelected(prev => {
    const next = multi ? new Map(prev) : new Map<string, DocumentRow>();
    if (prev.has(row.id) && multi) next.delete(row.id); else next.set(row.id, row);
    return next;
  });

  const confirm = async () => {
    setPicking(true);
    try { await onPick([...selected.values()]); onClose(); } finally { setPicking(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title={title} width="lg"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={confirm} disabled={selected.size === 0 || picking}>Add {selected.size} file{selected.size === 1 ? '' : 's'}</Button>
      </>}>
      <DocumentsFilterBar
        q={q} onQChange={setQ}
        projectOptions={projectOptions} projectIds={projectIds} onProjectIdsChange={setProjectIds}
        customerOptions={customerOptions} customerIds={customerIds} onCustomerIdsChange={setCustomerIds}
        kindOptions={kindOptions} kinds={kinds} onKindsChange={setKinds}
        archived={archived} onArchivedChange={setArchived}
        isAdmin={false} unassigned={false} onUnassignedChange={() => {}}
      />
      <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-edge">
        {loading && rows.length === 0 ? (
          <div className="space-y-2 p-3">{[0, 1, 2].map(i => <Skeleton key={i} className="h-8" />)}</div>
        ) : visible.length === 0 ? (
          <p className="p-4 text-sm text-ink-faint">No files match.</p>
        ) : (
          <ul className="divide-y divide-edge">
            {visible.map(row => (
              <li key={row.id} className="flex items-center gap-3 px-3 py-2 hover:bg-surface-2"
                  onMouseEnter={hoverCapable ? (e) => setHover({ row, x: e.clientX, y: e.clientY }) : undefined}
                  onMouseLeave={hoverCapable ? () => setHover(null) : undefined}>
                <input type="checkbox" aria-label={row.name ?? row.id} checked={selected.has(row.id)} onChange={() => toggle(row)} className="h-4 w-4 accent-accent-600" />
                <MimeIcon mime={row.mime} kind={row.kind} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">{row.name ?? row.id}</p>
                  <p className="truncate text-xs text-ink-faint">{row.projectName ?? row.customerName ?? '—'} · {new Date(row.createdAt).toLocaleDateString()} · {fmtSize(row.size)}</p>
                </div>
                <StatusPill tone={kindTone(row.kind)}>{kindLabel(row.kind, customTypes)}</StatusPill>
              </li>
            ))}
          </ul>
        )}
        {rows.length < total && (
          <div className="p-2 text-center"><Button variant="ghost" onClick={() => fetchPage(rows.length)} disabled={loading}>Load more</Button></div>
        )}
      </div>
      {hover && <DocumentHoverPreview row={hover.row} startX={hover.x} startY={hover.y} customTypes={customTypes} onHide={() => setHover(null)} />}
    </Modal>
  );
};
```
Check `MimeIcon`'s and `StatusPill`'s actual prop names before writing (`grep -n "export const MimeIcon" -A 3 src/pages/documents/MimeIcon.tsx`, `sed -n 20,36p src/components/ui/StatusPill.tsx`) and adjust; check `DocumentHoverPreview`'s full prop list (line 26-34) — it may require more props (e.g. `anchorRect`); pass what it needs.

- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `git add src/components/FilePickerModal.tsx src/components/FilePickerModal.test.tsx && git commit -m "feat(files): reusable FilePickerModal (server-file picker with Documents filters)"`

---

### Task 8: `proposalGenerator.ts` refactor — render from a Proposal snapshot

**Files:**
- Modify: `src/pages/project/proposal/proposalGenerator.ts` (lines 569-1107: `ProposalOptions`, `resolveGrandTotal`, `generateProposalPdf`)
- Create: `src/pages/project/proposal/proposalLetterhead.ts`
- Test: `src/pages/project/proposal/proposalGenerator.test.ts` (update), `src/pages/project/proposal/proposalGenerator.layout.test.ts` (new)

**Interfaces (produced):**
```ts
// proposalLetterhead.ts
export async function buildLetterhead(settings: Record<string, string>, headerEmail?: string): Promise<LetterheadContext>
// resolves logo (fetch → dataURL, invert when settings.invertLogoOnDocuments === 'true'), brandRgb from settings.companyBrandColor || '#99CB38'

// proposalGenerator.ts
export interface ProposalRenderInput {
  proposal: Proposal;                          // saved snapshot (lines, inclusions, terms, options…)
  project: Project;
  takeoffTotals: TakeoffTotals[];              // for the cost-detail page only
  currentPageIds: Set<string>;                 // for the highlights merge
  settings: Record<string, string>;
  letterhead: LetterheadContext;
  photos: { dataUrl: string; caption: string | null }[];
  attachments: ArrayBuffer[];                  // PDF bytes, in order — appended untouched
  includeHighlights: boolean;
}
export function proposalFileName(project: Project, when?: Date): string   // `Proposal – ${project.name} – ${YYYY-MM-DD}`
export async function generateProposalPdf(input: ProposalRenderInput, onProgress?: (msg: string) => void): Promise<ProposalGenResult>
// ProposalGenResult unchanged: { pdfBytes, suggestedName, overBudget? }
```
Remove: `ProposalOptions`, `resolveGrandTotal`, `getProposalPrefsKey`, `normalizeHighlightQuality` stays. Keep exported: `computeTakeoffTotals`, `TakeoffTotals`, `buildHighlightsPdf`, `HIGHLIGHT_QUALITY_PRESETS`, `HighlightQuality`, `formatCurrency`, `hexToRgb`, `dataUrlToUint8Array`, `EMAIL_TARGET_BYTES` re-export if any.

Page order (spec §6): cover → pricing (takeoff table, additional table, grand total box, payment schedule) → inclusions/exclusions → notes (flowing) → alternates page → cost detail (opt) → terms + signature (opt) → photos w/ captions → page numbers → highlights → attachments → email shrink.

- [ ] **Step 1: Update existing tests + write layout tests**

In `proposalGenerator.test.ts` delete the `getProposalPrefsKey` and `resolveGrandTotal` describes. Add `proposalGenerator.layout.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { generateProposalPdf, proposalFileName, ProposalRenderInput } from './proposalGenerator';
import type { Proposal } from '../../../utils/store';
import type { Project } from '../../../types';

const project = { id: 'p', name: 'Dania Beach', createdAt: 0, pages: [], takeoffs: [], address: '1 Main St' } as unknown as Project;
const line = (o: Partial<Proposal['lines'][number]>) => ({ id: 'l', sortOrder: 0, kind: 'manual', takeoffId: null, description: 'x', amountCents: 100, derivedAmountCents: null, measurementSummary: null, isAlternate: false, ...o }) as Proposal['lines'][number];
const base = (o: Partial<Proposal> = {}): Proposal => ({
  id: 'pr', projectId: 'p', number: 7, revisedFromId: null, revisedFromNumber: null, status: 'draft', legacy: false,
  title: null, validUntil: null, fontFamily: 'helvetica', coverNotes: '', terms: '', inclusions: [], exclusions: [], paymentSchedule: null,
  showGrandTotal: true, includeCostDetail: false, includeSignature: false, highlightQuality: 'best',
  fileId: null, signedFileId: null, sentAt: null, sentTo: null, acceptedAt: null, declinedAt: null, version: 1, createdBy: null, createdAt: 0, updatedAt: 0,
  totalCents: 0, alternateCount: 0, hasOverride: false, photoCount: 0, attachmentCount: 0,
  lines: [], photos: [], attachments: [], ...o,
});
const input = (proposal: Proposal, extra: Partial<ProposalRenderInput> = {}): ProposalRenderInput => ({
  proposal, project, takeoffTotals: [], currentPageIds: new Set(), settings: {},
  letterhead: { brandRgb: [153, 203, 56], company: { name: 'Big Bear' } } as any,
  photos: [], attachments: [], includeHighlights: false, ...extra,
});
const pages = async (bytes: ArrayBuffer) => (await PDFDocument.load(bytes)).getPageCount();
const makePdf = async (n: number) => { const d = await PDFDocument.create(); for (let i = 0; i < n; i++) d.addPage(); return (await d.save()).buffer as ArrayBuffer; };

describe('proposal layout', () => {
  it('names the file from project + date, never the number', () => {
    expect(proposalFileName(project, new Date('2026-08-28T12:00:00'))).toBe('Proposal – Dania Beach – 2026-08-28');
  });

  it('a bare proposal is a single cover/pricing page', async () => {
    const { pdfBytes, suggestedName } = await generateProposalPdf(input(base({ lines: [line({})] })));
    expect(await pages(pdfBytes)).toBe(1);
    expect(suggestedName).toMatch(/^Proposal – Dania Beach – \d{4}-\d{2}-\d{2}$/);
    expect(suggestedName).not.toContain('#7');
  });

  it('alternates add a separate page; attachments append their pages untouched', async () => {
    const p = base({ lines: [line({ id: 'a' }), line({ id: 'b', isAlternate: true })] });
    const plain = await generateProposalPdf(input(p));
    expect(await pages(plain.pdfBytes)).toBe(2);
    const withAtt = await generateProposalPdf(input(p, { attachments: [await makePdf(3), await makePdf(2)] }));
    expect(await pages(withAtt.pdfBytes)).toBe(7);
  });

  it('long notes flow onto extra pages after the grand total (grand total stays on page 1)', async () => {
    const notes = Array.from({ length: 400 }, (_, i) => `Note line ${i} lorem ipsum dolor sit amet`).join('\n');
    const p = base({ lines: [line({})], coverNotes: notes });
    const { pdfBytes } = await generateProposalPdf(input(p));
    expect(await pages(pdfBytes)).toBeGreaterThan(2);
    // sanity: page 1 text includes the total label (pdf-lib can't extract text; use jsPDF's internal page content via the
    // generator's optional debug hook instead) — see `__lastPageTexts` below.
  });

  it('photos render 2-up with captions; terms add a page', async () => {
    const png = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
    const p = base({ lines: [line({})], terms: 'Pay on time.', photos: [] });
    const { pdfBytes } = await generateProposalPdf(input(p, { photos: [{ dataUrl: png, caption: 'North' }, { dataUrl: png, caption: null }, { dataUrl: png, caption: 'x' }] }));
    expect(await pages(pdfBytes)).toBe(3); // cover/pricing, terms, photos
  });
});
```
For the "grand total stays on page 1" assertion, add a tiny test-only hook: the generator records `sectionPages: Record<'grandTotal'|'notes'|'alternates'|'terms'|'photos'|'attachmentsStart', number>` (1-based page index where each section STARTS) on the result as `sections`. Assert `result.sections.grandTotal === 1` and `result.sections.notes === 1` and `sections.terms` etc. Add `sections` to `ProposalGenResult`.

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/pages/project/proposal/` → FAIL (signature mismatch).

- [ ] **Step 3: Implement**

`proposalLetterhead.ts`:
```ts
import { hexToRgb, invertImageDataUrl, LetterheadContext } from '../../../utils/documentLetterhead';
export async function buildLetterhead(settings: Record<string, string>, headerEmail?: string): Promise<LetterheadContext> {
  let logoDataUrl: string | undefined = settings.logoUrl || undefined;
  if (logoDataUrl && !logoDataUrl.startsWith('data:')) {
    try {
      const blob = await (await fetch(logoDataUrl)).blob();
      logoDataUrl = await new Promise<string>(r => { const fr = new FileReader(); fr.onload = () => r(fr.result as string); fr.readAsDataURL(blob); });
    } catch { logoDataUrl = undefined; }
  }
  if (logoDataUrl && settings.invertLogoOnDocuments === 'true') logoDataUrl = await invertImageDataUrl(logoDataUrl);
  return {
    brandRgb: hexToRgb(settings.companyBrandColor || '#99CB38'),
    company: { name: settings.companyName || settings.appName, phone: settings.companyPhone, email: headerEmail || settings.companyEmail, address: settings.companyAddress },
    logoDataUrl,
  };
}
```

`proposalGenerator.ts` — replace everything from `export interface ProposalOptions` to the end with the new renderer. Keep `drawFrame`, `drawSectionBand`, cover header (title/address/"PROPOSAL"), signature block, photo grid, page numbers, highlights merge, and shrink logic from the existing code; restructure as:

```ts
export interface ProposalRenderInput { /* as above */ }
export interface ProposalGenResult { pdfBytes: ArrayBuffer; suggestedName: string; overBudget?: boolean; sections: Record<string, number> }

export const proposalFileName = (project: Project, when: Date = new Date()): string =>
  `Proposal – ${project.name} – ${when.toISOString().slice(0, 10)}`;

export async function generateProposalPdf(input: ProposalRenderInput, onProgress?: (msg: string) => void): Promise<ProposalGenResult> {
  const { proposal, project, takeoffTotals, currentPageIds, letterhead: lc, photos, attachments, includeHighlights } = input;
  const font = proposal.fontFamily ?? 'helvetica';
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  const W = pdf.internal.pageSize.getWidth(); const H = pdf.internal.pageSize.getHeight();
  const [hR, hG, hB] = lc.brandRgb;
  const accent = [hR, hG, hB].map(c => Math.round(c + (255 - c) * 0.4)) as [number, number, number];
  const pageBottom = drawLetterheadFooter(pdf, lc);
  const pageTop = drawLetterheadHeader(pdf, lc);
  const drawFrame = () => { const t = drawLetterheadHeader(pdf, lc); drawLetterheadFooter(pdf, lc); return t; };
  const sections: Record<string, number> = {};
  const pageNo = () => (pdf as any).internal.getNumberOfPages() as number;
  const totals = proposalTotals(proposal.lines);   // from proposalMath
  const money = (c: number) => formatCurrency(c / 100);

  // Cursor-based flow: `y` is the next free baseline; ensure(h) starts a new
  // framed page with a "(cont.)" band when h points won't fit.
  let y = 0; let bandTitle = '';
  const newPage = (title: string) => { pdf.addPage(); drawFrame(); y = drawSectionBand(title); };
  const ensure = (h: number) => { if (y + h > pageBottom - 12) newPage(`${bandTitle} (cont.)`); };
  const drawSectionBand = (t: string) => { /* existing band code; returns pageTop + 48 */ };

  // ── Cover header ─────────────────────────────────────────────────────────
  /* existing "PROPOSAL" heading + title + address; set y = coverY + 30 */

  // ── Pricing ──────────────────────────────────────────────────────────────
  bandTitle = 'Pricing';
  const drawLineTable = (heading: string, lines: ProposalLine[], withSummary: boolean) => {
    if (!lines.length) return;
    ensure(60);
    // heading row (brand text, thin rule)
    // for each line: description (bold, wrapped to W-260), optional measurementSummary (8pt grey under description), amount right-aligned; row height = 18 + (summary ? 12 : 0) + extra wrapped lines*12
    // subtotal row when there are 2+ lines
  };
  drawLineTable('Takeoff pricing', totals.takeoffLines, true);
  drawLineTable('Additional pricing', totals.manualLines, false);
  if (proposal.showGrandTotal) {
    ensure(110);
    sections.grandTotal = pageNo();
    /* existing rounded "TOTAL PROPOSAL VALUE" box at y, using money(totals.totalCents); y += 100 */
    if (proposal.validUntil) { /* existing valid-until line */ y += 16; }
  }
  if (proposal.paymentSchedule?.length) {
    ensure(24 + proposal.paymentSchedule.length * 16);
    // "Payment schedule" small heading; rows: description … amount (scheduleAmountCents(row, totals.totalCents)); percent shown as "(50%)"
  }

  // ── Inclusions / Exclusions ───────────────────────────────────────────────
  if (proposal.inclusions.length || proposal.exclusions.length) {
    bandTitle = 'Inclusions & Exclusions';
    ensure(40); sections.inclusions = pageNo();
    // two columns (colW = (W-100)/2): "INCLUDED" bullets left, "EXCLUDED" bullets right; each bullet wrapped; y advances by the taller column; page-break per bullet row via ensure(14)
  }

  // ── Notes (flowing) ───────────────────────────────────────────────────────
  if (proposal.coverNotes?.trim()) {
    bandTitle = 'Notes';
    ensure(40); sections.notes = pageNo();
    // "Notes" small heading; splitTextToSize(notes, W-80) lines; per line ensure(16) then text
  }

  // ── Alternates page ───────────────────────────────────────────────────────
  if (totals.altTakeoff.length || totals.altManual.length) {
    bandTitle = 'Alternates';
    newPage('Alternates'); sections.alternates = pageNo();
    pdf.setFontSize(9); /* intro line: "The following are optional add-ons priced separately and not included in the total above." */ y += 18;
    drawLineTable('Takeoff alternates', totals.altTakeoff, true);
    drawLineTable('Additional alternates', totals.altManual, false);
  }

  // ── Cost detail (takeoff lines only) ──────────────────────────────────────
  if (proposal.includeCostDetail && totals.takeoffLines.length) {
    bandTitle = 'Cost Detail';
    newPage('Cost Detail'); sections.costDetail = pageNo();
    // for each takeoff line with a matching takeoffTotals entry: name row + existing cost-detail sub-rows (calculateTakeoffCostDetails / costPerUnit) — copy the existing sub-row code
  }

  // ── Terms + signature ────────────────────────────────────────────────────
  if (proposal.terms?.trim() || proposal.includeSignature) {
    bandTitle = 'Terms & Conditions';
    newPage('Terms & Conditions'); sections.terms = pageNo();
    /* existing terms flow using ensure(16) */
    if (proposal.includeSignature) { ensure(80); /* existing signature block drawn at max(y+30, …) */ }
  }

  // ── Photos ───────────────────────────────────────────────────────────────
  if (photos.length) {
    onProgress?.('Adding photos…');
    newPage('Photos'); sections.photos = pageNo();
    const M = 40, gap = 12, cellW = (W - 2 * M - gap) / 2, cellH = 150, capH = 14;
    let col = 0;
    for (const ph of photos) {
      if (y + cellH + capH > pageBottom) { newPage('Photos (cont.)'); col = 0; }
      const x = M + col * (cellW + gap);
      try { pdf.addImage(ph.dataUrl, 'JPEG', x, y, cellW, cellH, undefined, 'FAST'); } catch { /* skip */ }
      if (ph.caption) { pdf.setFontSize(8); pdf.setFont(font, 'italic'); pdf.setTextColor(71, 85, 105); pdf.text(pdf.splitTextToSize(ph.caption, cellW)[0], x, y + cellH + 10); }
      col++; if (col === 2) { col = 0; y += cellH + capH + gap; }
    }
  }

  // ── Page numbers ─────────────────────────────────────────────────────────
  /* existing loop */

  // ── Merge: highlights then attachments ───────────────────────────────────
  onProgress?.('Assembling…');
  const { PDFDocument } = await import('pdf-lib');
  const merged = await PDFDocument.create();
  const body = await PDFDocument.load(pdf.output('arraybuffer') as ArrayBuffer);
  (await merged.copyPages(body, body.getPageIndices())).forEach(p => merged.addPage(p));
  if (includeHighlights) {
    const hl = await buildHighlightsPdf(project, new Set(totals.takeoffLines.concat(totals.altTakeoff).map(l => l.takeoffId!)), m => onProgress?.(m), currentPageIds);
    if (hl) { const d = await PDFDocument.load(hl); (await merged.copyPages(d, d.getPageIndices())).forEach(p => merged.addPage(p)); }
  }
  if (attachments.length) sections.attachmentsStart = merged.getPageCount() + 1;
  for (const bytes of attachments) {
    try { const d = await PDFDocument.load(bytes, { ignoreEncryption: true }); (await merged.copyPages(d, d.getPageIndices())).forEach(p => merged.addPage(p)); }
    catch (e) { console.warn('[proposal] skipped unreadable attachment', e); }
  }
  const out = await merged.save();
  let pdfBytes = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;

  let overBudget = false;
  if (proposal.highlightQuality === 'email') { const s = await shrinkPdfToBudget(pdfBytes, EMAIL_TARGET_BYTES, onProgress); pdfBytes = s.bytes; overBudget = s.overBudget; }
  return { pdfBytes, suggestedName: proposalFileName(project), overBudget, sections };
}
```
Write the real drawing code for every `/* … */` above using the existing file's styles (colors, fonts, band, box) — the existing functions are the reference. Rows in `drawLineTable` use: description at x=40 (bold 10pt), summary at x=40 (8pt grey, next line), amount right-aligned at W-40 (bold 10pt), separator line rgb(226,232,240). Amounts print as `money(l.amountCents)` — overrides are NOT marked on the PDF.

- [ ] **Step 4: Run** — `npx vitest run src/pages/project/proposal/` → PASS. Run `npm run lint` — `ProjectProposal.tsx` is `@ts-nocheck` so it won't complain; `ProjectTakeoffsTab.tsx` imports `HIGHLIGHT_QUALITY_PRESETS, HighlightQuality, TakeoffTotals` which remain.

- [ ] **Step 5: Commit** `git add src/pages/project/proposal/ && git commit -m "feat(proposals): generator renders from proposal snapshot — split pricing, grand total before notes, alternates page, captions, attachments"`

---

### Task 9: Takeoffs tab — prints to Documents, Proposal button creates a draft

**Files:**
- Modify: `src/pages/ProjectView.tsx:1132-1197` (handlePrint), `:1199-1376` (handleExportExcel), the `Printout` import, and the props passed to `ProjectTakeoffsTab` (~:2105-2130)
- Modify: `src/pages/project/ProjectTakeoffsTab.tsx:114-121` (Proposal button), add "Takeoff prints" link; add `onCreateProposal: () => void` + `isAdmin: boolean` props
- Modify: `e2e/export.spec.ts:60-140`, `e2e/documents.spec.ts` (~:69-87, :297-335, :467-498 — seeded printout kind/href)
- Modify: `e2e/fixtures/seed.ts` (wherever it seeds a `printout` file — switch to `takeoff-print` + `sourceType: 'takeoff-print'`)

**Interfaces:**
- Consumes: `createProposal` (Task 5), `saveBinaryFile` (existing).
- Produces: `takeoffPrintName(project, kind: 'pdf'|'excel', when?: Date)` exported from `src/pages/project/proposal/proposalMath.ts`? No — put it in `src/utils/takeoffPrintNames.ts`:
  ```ts
  export const takeoffPrintName = (projectName: string, kind: 'pdf' | 'excel', when: Date = new Date()) =>
    `${kind === 'excel' ? 'Takeoff Export' : 'Takeoff Print'} – ${projectName} – ${when.toISOString().slice(0, 10)}`;
  export const takeoffPrintsUrl = (projectId: string) => `/documents?projectIds=${projectId}&kinds=takeoff-print,takeoff-export`;
  ```

- [ ] **Step 1: Write failing unit test** `src/utils/takeoffPrintNames.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { takeoffPrintName, takeoffPrintsUrl } from './takeoffPrintNames';
describe('takeoff print names', () => {
  it('names by kind + project + ISO date', () => {
    const d = new Date('2026-08-28T15:00:00Z');
    expect(takeoffPrintName('Dania Beach', 'pdf', d)).toBe('Takeoff Print – Dania Beach – 2026-08-28');
    expect(takeoffPrintName('Dania Beach', 'excel', d)).toBe('Takeoff Export – Dania Beach – 2026-08-28');
  });
  it('builds the filtered documents url', () => {
    expect(takeoffPrintsUrl('p1')).toBe('/documents?projectIds=p1&kinds=takeoff-print,takeoff-export');
  });
});
```
- [ ] **Step 2: Run** → FAIL. Create the util → PASS.

- [ ] **Step 3: Update the e2e specs (they are the characterization for this task)**

`e2e/export.spec.ts` — the three tests now assert:
```ts
  await expect(authedPage).toHaveURL(new RegExp(`/documents\\?projectIds=${projectId}&kinds=takeoff-print(,|%2C)takeoff-export`), { timeout: 30_000 });
  await expect(authedPage.getByText(/^Takeoff Print – /).first()).toBeVisible({ timeout: 15_000 });   // (or Takeoff Export for the excel test)
```
Add a fourth test:
```ts
test('Proposal button creates a draft seeded with the selected takeoffs and opens the editor', async ({ authedPage, apiToken, request }) => {
  const { token } = apiToken;
  const { projectId, takeoffName } = await seedProjectWithTakeoffMeasurement(request, token);
  await gotoTakeoffsTab(authedPage, projectId);
  await selectFirstTakeoff(authedPage);
  await authedPage.getByTestId('btn-proposal').click();
  await expect(authedPage).toHaveURL(new RegExp(`/project/${projectId}/proposal/[0-9a-f-]{36}$`));
  await expect(authedPage.getByTestId('pricing-lines')).toContainText(takeoffName);
});
test('Takeoff prints link goes to the filtered Documents view', async ({ authedPage, apiToken, request }) => {
  const { token } = apiToken;
  const { projectId } = await seedProjectWithTakeoffMeasurement(request, token);
  await gotoTakeoffsTab(authedPage, projectId);
  await authedPage.getByRole('link', { name: 'Takeoff prints' }).click();
  await expect(authedPage).toHaveURL(new RegExp(`/documents\\?projectIds=${projectId}&kinds=takeoff-print`));
});
```
`e2e/documents.spec.ts`: wherever the seeded printout row is asserted with label `'Printout'` and href `/project/:id/proposal`, change to label `'Takeoff Print'` and href `/project/${id}/takeoff`; in `e2e/fixtures/seed.ts` upload that file with `kind=takeoff-print&sourceType=takeoff-print&sourceId=<uuid>` and name `Takeoff Print – <project> – 2026-01-01`.

- [ ] **Step 4: Implement**

`ProjectView.tsx` `handlePrint`: replace from `setProgressMessage('Saving…')` through the `navigate` with:
```ts
      setProgressMessage('Saving…');
      const name = takeoffPrintName(project.name, 'pdf');
      await saveBinaryFile(uuidv4(), new Blob([outBuffer], { type: 'application/pdf' }), {
        projectId: project.id, kind: 'takeoff-print', name, sourceType: 'takeoff-print', sourceId: uuidv4(),
      });
      if (overBudget) toast(`Printout is ${(outBuffer.byteLength / 1048576).toFixed(1)}MB — above the 18MB email target; some providers may reject it.`, { type: 'warning' });
      setSelectedTakeoffIds(new Set());
      navigate(takeoffPrintsUrl(project.id));
```
`handleExportExcel`: same shape with `kind: 'takeoff-export'`, `takeoffPrintName(project.name, 'excel')`. Remove the `saveProject(updatedProject)` calls and the `Printout` import in both. Add:
```ts
  const handleCreateProposal = async () => {
    if (!project || selectedTakeoffIds.size === 0) return;
    try {
      const { id } = await createProposal(project.id, { takeoffIds: [...selectedTakeoffIds] });
      navigate(`/project/${project.id}/proposal/${id}`);
    } catch { toast('Failed to create proposal', { type: 'error' }); }
  };
```
and pass `onCreateProposal={handleCreateProposal}` + `isAdmin={isAdmin}` (there is an `isAdmin` local in ProjectView — grep; if not, `(JSON.parse(localStorage.getItem('user') || '{}').role) === 'admin'`).

`ProjectTakeoffsTab.tsx`: replace the Proposal button with
```tsx
                    {isAdmin && (
                      <button data-testid="btn-proposal" onClick={onCreateProposal} className="…same classes…">
                        <FileText size={14} />Proposal
                      </button>
                    )}
```
and add, in the right-hand group next to Delete-all (always visible):
```tsx
                  <Link to={takeoffPrintsUrl(projectId ?? '')} className="text-xs text-accent-600 hover:underline whitespace-nowrap">Takeoff prints</Link>
```

- [ ] **Step 5: Run** `npm run lint && npx vitest run --project ui`; run `npx playwright test e2e/export.spec.ts e2e/documents.spec.ts` (if Chromium libs are present — the proposal-button test will fail until Task 11 ships the editor with `data-testid="pricing-lines"`; that's expected — note it and move on).

- [ ] **Step 6: Commit** `git add src/utils/takeoffPrintNames.ts src/utils/takeoffPrintNames.test.ts src/pages/ProjectView.tsx src/pages/project/ProjectTakeoffsTab.tsx e2e/ && git commit -m "feat(takeoffs): prints/exports become takeoff-print documents; Proposal button seeds a draft"`

---

### Task 10: Routing, gating, `ProposalsList`, `ReviseDialog`, `AcceptDialog`

**Files:**
- Modify: `src/App.tsx:19,121` — replace the `ProjectProposal` route with two routes.
- Modify: `src/components/shell/Sidebar.tsx:50` — `adminOnly: true` on the proposal entry.
- Modify: `src/components/CommandPalette.tsx:107` — gate `ctx:proposal` on admin (look at how `billing` actions are gated in the same list and mirror it).
- Create: `src/pages/project/proposal/ProposalsList.tsx`, `ReviseDialog.tsx`, `AcceptDialog.tsx`, `proposalPresentation.ts` (+ `.test.ts`)
- Modify: `src/utils/activityLink.ts` — no change (prefix `proposal_` → `/proposal` list page is correct).

**Interfaces:**
- Consumes: `getProposals`, `createProposal`, `deleteProposal`, `setProposalStatus`, `ProposalSummary` (Task 5); `getSovLines`, `createSovLine` (existing); `FilePickerModal` (Task 7); `uploadProjectFile` (existing).
- Produces:
  ```ts
  // proposalPresentation.ts (pure)
  export const proposalLabel = (p: Pick<ProposalSummary,'number'|'revisedFromNumber'>) => p.revisedFromNumber ? `#${p.number} (rev. of #${p.revisedFromNumber})` : `#${p.number}`;
  export const expiryText = (p: Pick<ProposalSummary,'status'|'validUntil'>, today = new Date()): string | null   // sent only: 'expires in N days' | 'expires today' | 'expired N days ago'; null otherwise
  export const STATUS_TONE: Record<ProposalStatus, PillTone>   // draft: slate, sent: blue, accepted: emerald, declined: red
  ```
  ```tsx
  export const ReviseDialog: React.FC<{ open: boolean; source: ProposalSummary | null; onClose: () => void; onConfirm: (o: { carryPhotos: boolean; carryAttachments: boolean }) => Promise<void> }>
  export const AcceptDialog: React.FC<{ open: boolean; proposal: ProposalSummary | null; projectId: string; onClose: () => void; onConfirm: (o: { signedFileId: string | null; prefillSov: boolean }) => Promise<void> }>
  ```

- [ ] **Step 1: Write failing tests** `proposalPresentation.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { proposalLabel, expiryText } from './proposalPresentation';
describe('proposalPresentation', () => {
  it('labels revisions', () => {
    expect(proposalLabel({ number: 2, revisedFromNumber: 1 })).toBe('#2 (rev. of #1)');
    expect(proposalLabel({ number: 1, revisedFromNumber: null })).toBe('#1');
  });
  it('expiry only for sent proposals', () => {
    const today = new Date('2026-08-28T12:00:00');
    expect(expiryText({ status: 'draft', validUntil: '2026-08-30' }, today)).toBeNull();
    expect(expiryText({ status: 'sent', validUntil: null }, today)).toBeNull();
    expect(expiryText({ status: 'sent', validUntil: '2026-09-03' }, today)).toBe('expires in 6 days');
    expect(expiryText({ status: 'sent', validUntil: '2026-08-28' }, today)).toBe('expires today');
    expect(expiryText({ status: 'sent', validUntil: '2026-08-25' }, today)).toBe('expired 3 days ago');
  });
});
```
- [ ] **Step 2: Run** → FAIL. Implement `proposalPresentation.ts` (day math: `Math.round((Date.parse(validUntil+'T00:00:00') - startOfDay(today)) / 86400000)`) → PASS.

- [ ] **Step 3: Implement routing + gating**

`App.tsx`: `import { ProposalsList } from './pages/project/proposal/ProposalsList'; import { ProposalEditor } from './pages/project/proposal/ProposalEditor';` (Editor is created in Task 11 — create a stub file exporting `export const ProposalEditor: React.FC = () => null;` now so this compiles) and
```tsx
            { path: 'proposal', element: <ProposalsList /> },
            { path: 'proposal/:proposalId', element: <ProposalEditor /> },
```
Sidebar: `adminOnly: true` on `proposal`. CommandPalette: wrap `ctx:proposal` with the same admin check used for billing in that file.

- [ ] **Step 4: Implement `ProposalsList.tsx`**

```tsx
// src/pages/project/proposal/ProposalsList.tsx — /project/:id/proposal (admin)
import React, { useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { Plus, FileText, Copy, Send, Trash2, Check, X, ExternalLink, AlertTriangle } from 'lucide-react';
import { ProposalSummary, getProposals, createProposal, deleteProposal, setProposalStatus, getSovLines, createSovLine, getProposal } from '../../../utils/store';
import { useLiveQuery } from '../../../hooks/useLiveQuery';
import { useToast } from '../../../components/Toast';
import { useConfirm } from '../../../components/ConfirmDialog';
import { Button, Card, CardBody, CardHeader, EmptyState, Skeleton, StatusPill, Table, THead, TBody, TR, TH, TD } from '../../../components/ui';
import { formatCurrency } from './proposalGenerator';
import { proposalLabel, expiryText, STATUS_TONE } from './proposalPresentation';
import { ReviseDialog } from './ReviseDialog';
import { AcceptDialog } from './AcceptDialog';

const isAdmin = () => (JSON.parse(localStorage.getItem('user') || '{}').role) === 'admin';

export const ProposalsList: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [rows, setRows] = useState<ProposalSummary[] | null>(null);
  const [revising, setRevising] = useState<ProposalSummary | null>(null);
  const [accepting, setAccepting] = useState<ProposalSummary | null>(null);

  const load = () => { if (projectId) getProposals(projectId).then(setRows).catch(() => setRows([])); };
  useLiveQuery(load, { types: ['proposal'], projectId });

  if (!isAdmin()) return <Navigate to={`/project/${projectId}`} replace />;

  const openEditor = (id: string) => navigate(`/project/${projectId}/proposal/${id}`);
  const handleNew = async () => {
    try { const { id } = await createProposal(projectId!, {}); openEditor(id); }
    catch { toast('Failed to create proposal', { type: 'error' }); }
  };
  const handleDelete = async (p: ProposalSummary) => {
    if (!await confirm({ title: 'Delete draft?', message: `Delete proposal ${proposalLabel(p)}? This cannot be undone.`, confirmLabel: 'Delete', variant: 'danger' })) return;
    try { await deleteProposal(p.id); load(); } catch { toast('Failed to delete', { type: 'error' }); }
  };
  const handleDecline = async (p: ProposalSummary) => {
    if (!await confirm({ title: 'Mark declined?', message: `Mark proposal ${proposalLabel(p)} as declined by the customer?`, confirmLabel: 'Mark declined' })) return;
    try { await setProposalStatus(p.id, 'declined'); load(); } catch { toast('Failed to update', { type: 'error' }); }
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-8">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div><h1 className="text-xl font-bold text-ink">Proposals</h1><p className="text-sm text-ink-faint">Numbered internally; revisions keep their lineage.</p></div>
        <Button onClick={handleNew} data-testid="btn-new-proposal"><Plus size={16} />New proposal</Button>
      </div>
      <Card>
        <CardBody className="p-0">
          {rows === null ? <div className="space-y-2 p-4">{[0, 1, 2].map(i => <Skeleton key={i} className="h-8" />)}</div>
          : rows.length === 0 ? <EmptyState title="No proposals yet" description="Select takeoffs on the Takeoffs tab and click Proposal, or start a blank one." />
          : (
            <div className="overflow-x-auto">
              <Table>
                <THead><TR><TH>#</TH><TH>Title</TH><TH>Status</TH><TH className="text-right">Total</TH><TH>Alternates</TH><TH>Sent</TH><TH></TH></TR></THead>
                <TBody>
                  {rows.map(p => {
                    const exp = expiryText(p);
                    return (
                      <TR key={p.id} data-testid={`proposal-row-${p.number}`} className="cursor-pointer hover:bg-surface-2" onClick={() => openEditor(p.id)}>
                        <TD className="whitespace-nowrap font-medium">{proposalLabel(p)}{p.legacy && <span className="ml-1 text-xs text-ink-faint">(legacy)</span>}</TD>
                        <TD className="max-w-[16rem] truncate">{p.title || '—'}</TD>
                        <TD><StatusPill tone={STATUS_TONE[p.status]}>{p.status}</StatusPill>{exp && <span className={`ml-2 text-xs ${exp.startsWith('expired') ? 'text-red-600' : 'text-ink-faint'}`}>{exp}</span>}</TD>
                        <TD className="whitespace-nowrap text-right font-medium">
                          {formatCurrency(p.totalCents / 100)}
                          {p.hasOverride && <span title="Contains overridden takeoff amounts" className="ml-1 inline-block align-middle text-amber-500"><AlertTriangle size={12} /></span>}
                        </TD>
                        <TD className="text-xs text-ink-faint">{p.alternateCount || '—'}</TD>
                        <TD className="whitespace-nowrap text-xs text-ink-faint" title={p.sentTo ? `To: ${p.sentTo.to}${p.sentTo.cc ? ` · CC: ${p.sentTo.cc}` : ''}\n${p.sentTo.subject}` : undefined}>
                          {p.sentAt ? new Date(p.sentAt).toLocaleDateString() : '—'}
                        </TD>
                        <TD onClick={e => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1">
                            {p.fileId && <Button variant="ghost" title="Open PDF" onClick={() => navigate(`/tools/pdf?fileId=${p.fileId}`)}><FileText size={15} /></Button>}
                            {p.signedFileId && <Button variant="ghost" title="Signed copy" onClick={() => navigate(`/tools/pdf?fileId=${p.signedFileId}`)}><Check size={15} /></Button>}
                            <Button variant="ghost" title="Revise (new proposal from this one)" onClick={() => setRevising(p)}><Copy size={15} /></Button>
                            {p.status === 'draft' && !p.legacy && <Button variant="ghost" title="Open & send" onClick={() => openEditor(p.id)}><Send size={15} /></Button>}
                            {p.status === 'sent' && <>
                              <Button variant="ghost" title="Mark accepted" onClick={() => setAccepting(p)}><Check size={15} /></Button>
                              <Button variant="ghost" title="Mark declined" onClick={() => handleDecline(p)}><X size={15} /></Button>
                            </>}
                            {p.status === 'draft' && !p.legacy && <Button variant="ghost" title="Delete draft" onClick={() => handleDelete(p)}><Trash2 size={15} /></Button>}
                          </div>
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </div>
          )}
        </CardBody>
      </Card>

      <ReviseDialog open={!!revising} source={revising} onClose={() => setRevising(null)}
        onConfirm={async ({ carryPhotos, carryAttachments }) => {
          const { id } = await createProposal(projectId!, { revisedFromId: revising!.id, carryPhotos, carryAttachments });
          setRevising(null); openEditor(id);
        }} />
      <AcceptDialog open={!!accepting} proposal={accepting} projectId={projectId!} onClose={() => setAccepting(null)}
        onConfirm={async ({ signedFileId, prefillSov }) => {
          await setProposalStatus(accepting!.id, 'accepted', signedFileId);
          if (prefillSov) {
            const full = await getProposal(accepting!.id);
            const existing = await getSovLines(projectId!);
            if (existing.length && !await confirm({ title: 'SOV already has lines', message: 'Add the proposal lines to the existing schedule of values?', confirmLabel: 'Add lines' })) { /* skip */ }
            else for (const l of full.lines.filter(x => !x.isAlternate)) await createSovLine(projectId!, { description: l.description, scheduledValueCents: l.amountCents });
          }
          setAccepting(null); load();
          toast('Proposal accepted', { type: 'success' });
        }} />
    </div>
  );
};
```
(`getSovLines` — confirm the exact client helper name in `store.ts` near line 1460; use whatever lists SOV lines.)

`ReviseDialog.tsx`: `Modal` with two `Checkbox`es (`Bring over photos (N)` default checked, disabled when N=0; same for attachments), footer Cancel / "Create revision" (busy state). `AcceptDialog.tsx`: `Modal` with (a) signed copy section — "Upload signed PDF" file input (`uploadProjectFile(projectId, f, 'proposal-signed', { sourceType: 'proposal', sourceId: proposal.id })`) and "Choose existing" (`FilePickerModal accept="pdf" multi={false}`), showing the chosen file name with a clear ×; (b) `Checkbox` "Prefill the schedule of values from this proposal's N lines" (default checked; N = non-alternate line count — fetch via `getProposal` on open); footer Cancel / "Mark accepted".

- [ ] **Step 5: Run** `npm run lint && npx vitest run --project ui`. **Step 6: Commit** `git add src/App.tsx src/components/shell/Sidebar.tsx src/components/CommandPalette.tsx src/pages/project/proposal/ && git commit -m "feat(proposals): admin-gated proposals list with revise/accept/decline dialogs"`

---

### Task 11: `ProposalEditor` + pricing / inclusions / schedule / options cards

**Files:**
- Create: `src/pages/project/proposal/ProposalEditor.tsx` (replace the stub), `PricingLinesCard.tsx` (+ `.test.tsx`), `InclusionsExclusionsCard.tsx`, `PaymentScheduleCard.tsx`, `ProposalOptionsCard.tsx`, `HistoryMenu.tsx` (moved verbatim from `ProjectProposal.tsx:45-106`), `proposalPrefs.ts`
- Modify: `src/pages/project/proposal/proposalTextHistory.ts` — `pushHistory(history, entry, max = PROPOSAL_TEXT_HISTORY_MAX)` (add the optional cap so the line library can use 10).

**Interfaces:**
- Consumes: Tasks 5, 6, 8, 10.
- Produces:
  ```ts
  // proposalPrefs.ts — per-user prefs keys (server user preferences via getUserPreferences/saveUserPreferences)
  export const PREF_KEYS = { notes: 'proposal-coverNotes-history', terms: 'proposal-terms-history', inclusions: 'proposal-inclusions-history', exclusions: 'proposal-exclusions-history', lines: 'proposal-manualLine-history',
    font: 'proposal-fontFamily', quality: 'proposal-highlightQuality', costDetail: 'proposal-includeCostDetail', signature: 'proposal-includeSignature', grandTotal: 'proposal-showGrandTotal' } as const;
  export interface ManualLineMemory { description: string; amountCents: number }
  export const parseLineLibrary = (raw: string | undefined): ManualLineMemory[]
  export const pushLineLibrary = (lib: ManualLineMemory[], entry: ManualLineMemory): ManualLineMemory[]   // dedup by description (case-insensitive), newest first, cap 10
  export const optionDefaultsFromPrefs = (prefs: Record<string,string>): Partial<ProposalSaveInput>   // used on New proposal creation (Task 10's handleNew + Task 9's handleCreateProposal pass these to createProposal)
  ```
  ```tsx
  // PricingLinesCard
  export const PricingLinesCard: React.FC<{
    lines: ProposalLine[]; onChange: (lines: ProposalLine[]) => void; readOnly: boolean;
    takeoffTotals: TakeoffTotals[]; missingTakeoffIds: string[];
    showGrandTotal: boolean; onShowGrandTotalChange: (v: boolean) => void;
    lineLibrary: ManualLineMemory[];
  }>
  ```
  The editor owns `Proposal` state; cards are controlled.

- [ ] **Step 1: Write failing tests** `PricingLinesCard.test.tsx`:
```tsx
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PricingLinesCard } from './PricingLinesCard';
import { ConfirmProvider } from '../../../components/ConfirmDialog';

const t = (id: string, name: string) => ({ id, name, type: 'area', color: '#fff', unit: 'sqft', costPerUnit: 1, totalRealValue: 10000, pageBreakdown: [] } as any);
const takeoffLine = { id: 'l1', sortOrder: 0, kind: 'takeoff' as const, takeoffId: 't1', description: 'Stucco', amountCents: 1000000, derivedAmountCents: 1000000, measurementSummary: '10,000.00 sq ft', isAlternate: false };
const wrap = (ui: React.ReactElement) => render(<ConfirmProvider>{ui}</ConfirmProvider>);

describe('PricingLinesCard', () => {
  it('shows takeoff lines with measurement summary and derived amount', () => {
    wrap(<PricingLinesCard lines={[takeoffLine]} onChange={() => {}} readOnly={false} takeoffTotals={[t('t1', 'Stucco')]} missingTakeoffIds={[]} showGrandTotal onShowGrandTotalChange={() => {}} lineLibrary={[]} />);
    expect(screen.getByText('10,000.00 sq ft')).toBeInTheDocument();
    expect(screen.getByDisplayValue('10000.00')).toBeInTheDocument();
  });

  it('overriding a takeoff amount asks for confirmation, then marks the line overridden with a reset', async () => {
    const onChange = vi.fn();
    wrap(<PricingLinesCard lines={[takeoffLine]} onChange={onChange} readOnly={false} takeoffTotals={[t('t1', 'Stucco')]} missingTakeoffIds={[]} showGrandTotal onShowGrandTotalChange={() => {}} lineLibrary={[]} />);
    const amt = screen.getByDisplayValue('10000.00');
    fireEvent.change(amt, { target: { value: '9500' } });
    fireEvent.blur(amt);
    expect(await screen.findByText(/Override/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Override/ }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ amountCents: 950000, derivedAmountCents: 1000000 })]));
  });

  it('cancelling the confirmation restores the derived amount', async () => {
    const onChange = vi.fn();
    wrap(<PricingLinesCard lines={[takeoffLine]} onChange={onChange} readOnly={false} takeoffTotals={[t('t1', 'Stucco')]} missingTakeoffIds={[]} showGrandTotal onShowGrandTotalChange={() => {}} lineLibrary={[]} />);
    const amt = screen.getByDisplayValue('10000.00');
    fireEvent.change(amt, { target: { value: '1' } });
    fireEvent.blur(amt);
    fireEvent.click(await screen.findByRole('button', { name: /Cancel/ }));
    await waitFor(() => expect(screen.getByDisplayValue('10000.00')).toBeInTheDocument());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('an overridden line shows "was $X" and Reset restores it', () => {
    const onChange = vi.fn();
    wrap(<PricingLinesCard lines={[{ ...takeoffLine, amountCents: 950000 }]} onChange={onChange} readOnly={false} takeoffTotals={[t('t1', 'Stucco')]} missingTakeoffIds={[]} showGrandTotal onShowGrandTotalChange={() => {}} lineLibrary={[]} />);
    expect(screen.getByText(/overridden \(was \$10,000\.00\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Reset/ }));
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ amountCents: 1000000 })]);
  });

  it('adds a manual line, toggles alternate, and totals exclude alternates', () => {
    const onChange = vi.fn();
    const { rerender } = wrap(<PricingLinesCard lines={[takeoffLine]} onChange={onChange} readOnly={false} takeoffTotals={[]} missingTakeoffIds={[]} showGrandTotal onShowGrandTotalChange={() => {}} lineLibrary={[{ description: 'Scaffolding', amountCents: 350000 }]} />);
    fireEvent.click(screen.getByRole('button', { name: /Add manual line/ }));
    expect(onChange).toHaveBeenLastCalledWith([takeoffLine, expect.objectContaining({ kind: 'manual', amountCents: 0 })]);
    const manual = { id: 'm1', sortOrder: 1, kind: 'manual' as const, takeoffId: null, description: 'Scaffolding', amountCents: 350000, derivedAmountCents: null, measurementSummary: null, isAlternate: false };
    rerender(<ConfirmProvider><PricingLinesCard lines={[takeoffLine, manual]} onChange={onChange} readOnly={false} takeoffTotals={[]} missingTakeoffIds={[]} showGrandTotal onShowGrandTotalChange={() => {}} lineLibrary={[]} /></ConfirmProvider>);
    expect(screen.getByTestId('pricing-total')).toHaveTextContent('$13,500.00');
    fireEvent.click(screen.getAllByLabelText('Alternate')[1]);
    expect(onChange).toHaveBeenLastCalledWith([takeoffLine, expect.objectContaining({ id: 'm1', isAlternate: true })]);
  });

  it('flags a missing takeoff and offers removal', () => {
    const onChange = vi.fn();
    wrap(<PricingLinesCard lines={[takeoffLine]} onChange={onChange} readOnly={false} takeoffTotals={[]} missingTakeoffIds={['t1']} showGrandTotal onShowGrandTotalChange={() => {}} lineLibrary={[]} />);
    expect(screen.getByText(/takeoff no longer exists/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Remove line/ }));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
```
Check `ConfirmDialog.tsx` for the provider's exported name (`ConfirmProvider` or similar) and how `useConfirm` renders the dialog (buttons' labels come from `confirmLabel`; default cancel label "Cancel").

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

`proposalPrefs.ts` as specified (pure + small). `HistoryMenu.tsx`: move the component from `ProjectProposal.tsx:45-106` verbatim, exporting it.

`PricingLinesCard.tsx` — structure:
```tsx
export const PricingLinesCard: React.FC<Props> = ({ lines, onChange, readOnly, takeoffTotals, missingTakeoffIds, showGrandTotal, onShowGrandTotalChange, lineLibrary }) => {
  const confirm = useConfirm();
  const totals = proposalTotals(lines);
  const takeoffLines = lines.filter(l => l.kind === 'takeoff');
  const manualLines = lines.filter(l => l.kind === 'manual');
  const update = (id: string, patch: Partial<ProposalLine>) => onChange(lines.map(l => l.id === id ? { ...l, ...patch } : l));
  const remove = (id: string) => onChange(lines.filter(l => l.id !== id));
  const move = (id: string, dir: -1 | 1) => { /* swap within the same kind group, then renumber sortOrder over the whole array */ };
  const availableTakeoffs = takeoffTotals.filter(t => !takeoffLines.some(l => l.takeoffId === t.id));
  const addTakeoff = (t: TakeoffTotals) => onChange([...lines, { id: uuidv4(), sortOrder: lines.length, ...lineFromTakeoff(t) } as ProposalLine]);
  const addManual = (mem?: ManualLineMemory) => onChange([...lines, { id: uuidv4(), sortOrder: lines.length, kind: 'manual', takeoffId: null, description: mem?.description ?? '', amountCents: mem?.amountCents ?? 0, derivedAmountCents: null, measurementSummary: null, isAlternate: false }]);

  // Amount input: local text state per line (dollars, 2dp); commit on blur/Enter.
  // Takeoff line commit → if new cents !== derived && !readOnly → confirm({ title: 'Override takeoff amount?',
  //   message: `Override ${money(derived)} → ${money(next)} for this proposal only? The takeoff itself is not changed.`, confirmLabel: 'Override' })
  //   → yes: update(amountCents); no: reset local text to current amount.
  // Manual line commit → update immediately.
  ...
  return (
    <Card data-testid="pricing-lines">
      <CardHeader title="Pricing" actions={<Checkbox checked={showGrandTotal} onChange={e => onShowGrandTotalChange(e.target.checked)} label="Show grand total" disabled={readOnly} />} />
      <CardBody className="space-y-5">
        <Group title="Takeoff lines" empty="No takeoff lines. Add one from the project's takeoffs.">
          {takeoffLines.map(l => <LineRow key={l.id} line={l} … showSummary missing={missingTakeoffIds.includes(l.takeoffId!)} />)}
          {!readOnly && availableTakeoffs.length > 0 && <Select onChange={e => { const t = availableTakeoffs.find(x => x.id === e.target.value); if (t) addTakeoff(t); e.target.value = ''; }}><option value="">+ Add takeoff…</option>{availableTakeoffs.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>}
        </Group>
        <Group title="Manual lines" empty="No manual lines.">
          {manualLines.map(l => <LineRow key={l.id} line={l} … />)}
          {!readOnly && <div className="flex gap-2"><Button variant="secondary" onClick={() => addManual()}><Plus size={14} />Add manual line</Button>
            {lineLibrary.length > 0 && <Select aria-label="From library" onChange={e => { const m = lineLibrary[Number(e.target.value)]; if (m) addManual(m); e.target.value = ''; }}><option value="">From library…</option>{lineLibrary.map((m, i) => <option key={i} value={i}>{m.description} — {money(m.amountCents)}</option>)}</Select>}</div>}
        </Group>
        <div className="flex justify-end gap-6 border-t border-edge pt-3 text-sm">
          {totals.alternateCents > 0 && <span className="text-ink-faint">Alternates: {money(totals.alternateCents)}</span>}
          <span className="font-semibold" data-testid="pricing-total">Total: {money(totals.totalCents)}</span>
        </div>
      </CardBody>
    </Card>
  );
};
```
`LineRow`: description `Input` (full width), amount `Input type="number" step="0.01"` (right), `Checkbox aria-label="Alternate"`, ↑/↓ ghost buttons, remove ×. Under a takeoff line: `measurementSummary` in xs grey; if `isOverridden(line)`: `<span className="text-xs text-amber-600">overridden (was {money(derived)})</span> <Button variant="ghost" size="xs">Reset</Button>`; if missing: red xs text "This takeoff no longer exists" + `Remove line` button. Alternate rows get a subtle amber left border. All inputs `disabled={readOnly}`.

`InclusionsExclusionsCard.tsx`: two columns; each a `Textarea` (one bullet per line — split on `\n`, trim, drop empties on change) + `HistoryMenu` (history entries are the joined text). Props: `{ inclusions, exclusions, onChange(i, e), readOnly, inclusionsHistory, exclusionsHistory }`.

`PaymentScheduleCard.tsx`: `Checkbox` "Include payment schedule" (checked ⇔ `paymentSchedule !== null`; checking sets `[]`); rows: description `Input`, mode `Select` (% / $), value `Input`, remove; "Add row"; footer shows the sum of `scheduleAmountCents(row, totalCents)` vs total with a warning when percents ≠ 100. Props `{ schedule, totalCents, onChange, readOnly }`.

`ProposalOptionsCard.tsx`: title, valid-until (date), font `Select`, `Checkbox` include cost detail, include signature, highlight quality `Select` (from `HIGHLIGHT_QUALITY_PRESETS`), include highlights (`Checkbox`, editor-local, not persisted — same as today's `includeHighlights`). Props: `{ value: Pick<Proposal, 'title'|'validUntil'|'fontFamily'|'includeCostDetail'|'includeSignature'|'highlightQuality'>, includeHighlights, onChange, onIncludeHighlightsChange, readOnly }`.

`ProposalEditor.tsx` (host):
```tsx
export const ProposalEditor: React.FC = () => {
  const { projectId, proposalId } = useParams<{ projectId: string; proposalId: string }>();
  // state: project (getProject), proposal (getProposal), draft (editable copy of proposal), dirty flag, busy/progress, includeHighlights, prefs (histories + line library), emailDefaults (copy the resolver block from ProjectProposal.tsx:163-198), composing
  // derived: currentPageIds = computeRevisionModel(project).currentPageIds; takeoffTotals = computeTakeoffTotals(project, currentPageIds)
  // on load (draft && !legacy): const { lines, missingTakeoffIds } = rederiveLines(proposal.lines, takeoffTotals); setDraft({ ...proposal, lines }); if any line changed → dirty
  // readOnly = proposal.status !== 'draft' || proposal.legacy
  // useLiveQuery(reload, { types: ['proposal'], id: proposalId }) — on foreign update while dirty: toast "Updated elsewhere — reload to see changes" instead of clobbering
  // save(): saveProposal(id, { version, title, validUntil, fontFamily, coverNotes, terms, inclusions, exclusions, paymentSchedule, showGrandTotal, includeCostDetail, includeSignature, highlightQuality, lines: draft.lines.map(strip id/sortOrder) }) → set version, dirty=false; ConflictError → toast + reload; ProposalLockedError → toast + reload
  //   after a successful save: record histories (notes/terms/inclusions/exclusions via pushHistory; manual lines via pushLineLibrary) + saveUserPreferences
  // header bar: back link to list, "#n (rev. of #m)" + status pill + (readOnly ? "Locked — revise to change" : dirty ? "Unsaved changes" : "Saved"), buttons: Save (draft only), Generate PDF (Task 13), Send (Task 13), Open PDF (when fileId)
  // body grid: PricingLinesCard, InclusionsExclusionsCard, Notes card (Textarea + HistoryMenu), PaymentScheduleCard, Terms card (Textarea + HistoryMenu), ProposalOptionsCard, ProposalPhotosCard (Task 12), ProposalAttachmentsCard (Task 12)
  // non-admin → <Navigate to={`/project/${projectId}`} replace />
};
```
Write it fully (no `//` outlines left in the file). The `EditPresenceBanner`/`useCollabEditing` wiring from `ProjectProposal.tsx` can be reused with `entityType: 'proposal'`, `entityId: proposalId` (check the hook's signature at `src/hooks/useCollabEditing.ts`).

- [ ] **Step 4: Run** `npx vitest run --project ui && npm run lint`. **Step 5: Commit** `git add src/pages/project/proposal/ && git commit -m "feat(proposals): full-page editor with pricing lines (override confirm), inclusions/exclusions, payment schedule, options"`

---

### Task 12: Photos + attachments cards

**Files:**
- Create: `src/pages/project/proposal/ProposalPhotosCard.tsx`, `ProposalAttachmentsCard.tsx`
- Modify: `ProposalEditor.tsx` — mount both.

**Interfaces:**
- Consumes: `addProposalPhoto/updateProposalPhoto/removeProposalPhoto/addProposalAttachment/updateProposalAttachment/removeProposalAttachment`, `uploadProjectFile`, `getImageUrl`, `FilePickerModal`.
- Produces:
  ```tsx
  export const ProposalPhotosCard: React.FC<{ proposal: Proposal; projectId: string; readOnly: boolean; onChanged: () => void }>
  export const ProposalAttachmentsCard: React.FC<{ proposal: Proposal; projectId: string; readOnly: boolean; onChanged: () => void }>
  ```
  Both mutate through the API immediately (no dirty state) and call `onChanged()` so the editor reloads the proposal.

- [ ] **Step 1: Implement `ProposalPhotosCard`**
  - Grid of thumbnails (`<img src={getImageUrl(fileId)}>`), caption `Input placeholder="Caption (optional)"` under each → `updateProposalPhoto(id, fileId, { caption })` on blur when changed; ← → reorder buttons → `updateProposalPhoto` with swapped `sortOrder` for both; remove × → `removeProposalPhoto`.
  - Toolbar (draft only): hidden `<input type="file" accept="image/*" multiple>` + "Upload photos" (`uploadProjectFile(projectId, f, 'proposal-photo', { sourceType: 'proposal', sourceId: proposal.id })` then `addProposalPhoto`); "Choose existing" → `FilePickerModal accept="image" excludeFileIds={proposal.photos.map(p => p.fileId)} initialProjectIds={[projectId]}` → `addProposalPhoto` per picked row.
- [ ] **Step 2: Implement `ProposalAttachmentsCard`**
  - Ordered list: PDF icon, name, size, ↑/↓ (`updateProposalAttachment` swap), remove ×.
  - Toolbar (draft only): "Upload PDF" (`<input accept="application/pdf">`, `uploadProjectFile(projectId, f, 'document')` then `addProposalAttachment`); "Choose existing" → `FilePickerModal accept="pdf" excludeFileIds={…} initialProjectIds={[]}` (all files by default — spec says picker is global; the user can filter).
  - Hint text: "Attached PDFs are appended to the end of the generated proposal, in this order."
- [ ] **Step 3: Mount both in the editor** below the Terms card. **Step 4:** `npm run lint && npx vitest run --project ui`. Write one RTL test per card (renders photos/attachments from props; clicking remove calls the mocked API). **Step 5: Commit** `git commit -am "feat(proposals): photos (captions, pick existing) + PDF attachments cards"`

---

### Task 13: Generate + Send in the editor; delete the old page

**Files:**
- Modify: `src/pages/project/proposal/ProposalEditor.tsx`
- Delete: `src/pages/project/ProjectProposal.tsx`
- Modify: `src/utils/store.ts` — remove anything only the old page used (grep after deletion: `getProposalPrefsKey` callers etc.).

**Interfaces:**
- Consumes: `generateProposalPdf`, `proposalFileName`, `buildLetterhead` (Task 8), `persistGeneratedDocument`, `fetchFileBlob`, `setProposalFile`, `sendProposal`, `EmailComposer`, `resolveRecipient`.

- [ ] **Step 1: Implement `handleGenerate` in the editor**
```ts
  const buildPdf = async (headerEmail?: string) => {
    const settings = await getSettings();
    const letterhead = await buildLetterhead(settings, headerEmail);
    const photos = [] as { dataUrl: string; caption: string | null }[];
    for (const p of draft.photos) {
      try { const blob = await fetchFileBlob(p.fileId); photos.push({ dataUrl: await blobToDataUrl(blob), caption: p.caption }); } catch { /* skip */ }
    }
    const attachments: ArrayBuffer[] = [];
    for (const a of draft.attachments) {
      try { attachments.push(await (await fetchFileBlob(a.fileId)).arrayBuffer()); } catch { toast(`Skipped unreadable attachment ${a.name ?? ''}`, { type: 'warning' }); }
    }
    return generateProposalPdf({ proposal: draft, project, takeoffTotals, currentPageIds, settings, letterhead, photos, attachments, includeHighlights }, setProgress);
  };
  const handleGenerate = async () => {
    if (draft.lines.length === 0) { toast('Add at least one price line', { type: 'warning' }); return; }
    setBusy(true);
    try {
      if (dirty) await save();                              // Generate always saves first
      const { pdfBytes, suggestedName, overBudget } = await buildPdf();
      const { fileId } = await persistGeneratedDocument(new Blob([pdfBytes], { type: 'application/pdf' }), { projectId, kind: 'proposal', name: suggestedName, sourceType: 'proposal', sourceId: draft.id });
      await setProposalFile(draft.id, fileId);
      if (overBudget) toast(`Proposal is ${(pdfBytes.byteLength / 1048576).toFixed(1)}MB — above the 18MB email target`, { type: 'warning' });
      toast('Proposal PDF generated', { type: 'success' });
      await reload();
    } catch (e) { console.error(e); toast('Failed to generate proposal PDF', { type: 'error' }); }
    finally { setBusy(false); setProgress(''); }
  };
```
`blobToDataUrl` — small local helper (FileReader), or reuse one if `src/utils` has it (grep `readAsDataURL`).

- [ ] **Step 2: Send**
  - "Send" button enabled when `!readOnly && proposal.fileId && !dirty` (otherwise tooltip "Generate the PDF first" / "Save first").
  - `EmailComposer` props copied from `ProjectProposal.tsx:848-864` (defaults from `emailDefaults`, `primaryAttachmentName = proposalFileName(project) + '.pdf'`). `onSend`: if `m.headerEmail` differs from the company default → regenerate via `buildPdf(m.headerEmail)` + persist + `setProposalFile` (same as today's regenerate-on-header-email); then `await sendProposal(draft.id, { to, cc, bcc, subject, body, fileId, attachmentFileIds })`; toast "Proposal sent"; `reload()` (now locked).
- [ ] **Step 3: Delete `src/pages/project/ProjectProposal.tsx`**; remove its import from `App.tsx` (already replaced in Task 10 — verify). `grep -rn "ProjectProposal\|proposalPhotoIds\|proposalFileId\|printouts" src/ server/ e2e/` must return nothing except migration 28 + its test.
- [ ] **Step 4:** `npm run lint && npm test` (both projects) → green. **Step 5: Commit** `git add -A src/ && git commit -m "feat(proposals): generate + send from the editor; remove legacy ProjectProposal page"`

---

### Task 14: Dashboard outstanding card + company-document upload

**Files:**
- Modify: `src/pages/Dashboard.tsx` (after the "Upcoming bid deadlines" card)
- Modify: `src/pages/documents/UploadDocumentsModal.tsx` (~:112, :227)
- Test: `src/pages/documents/UploadDocumentsModal.test.tsx` (extend), `src/pages/Dashboard.test.tsx` if one exists (else skip — the card is a thin list)

- [ ] **Step 1: Dashboard**
  - `const [outstanding, setOutstanding] = useState<OutstandingProposal[] | null>(null);` loaded in `load()` only when `isAdmin` (`getOutstandingProposals().then(setOutstanding).catch(() => setOutstanding([]))`); add `'proposal'` to the `useLiveQuery` types.
  - Card (admin only), title "Outstanding proposals", rows: `{projectName} · #{number}{title ? ` — ${title}` : ''}` left, `formatCurrency(totalCents/100)` right, expiry text (`expiryText`) in xs (red when expired); click → `/project/${projectId}/proposal/${id}`; max 6 rows + "View all" link to `/projects`. Empty state "No proposals awaiting a response."
- [ ] **Step 2: UploadDocumentsModal** — when `sharedKind === 'company-document'` (or per-file kind is), the Project select is disabled/cleared and the hint reads "Company documents aren't tied to a project." The upload call already omits `projectId` when empty (`:112`). Extend the existing modal test: selecting `company-document` disables the project select and the upload query has no `projectId`.
- [ ] **Step 3:** `npm run lint && npx vitest run --project ui`. **Step 4: Commit** `git commit -am "feat(proposals): dashboard outstanding-proposals card; company-document uploads without a project"`

---

### Task 15: E2E `proposal.spec.ts`, full verification, changelog, memory

**Files:**
- Create: `e2e/proposal.spec.ts`
- Modify: `CHANGELOG.md` (or wherever `docs: changelog v2.7.2` lives — `git show 3774135 --stat` to find it) — add v2.8.0 entry.

- [ ] **Step 1: Write `e2e/proposal.spec.ts`** (admin `authedPage` fixture; `seedProjectWithTakeoffMeasurement` from export.spec's helpers — import or duplicate):
```ts
test('select takeoffs → Proposal → editor seeded; add manual + alternate; generate; list; revise carries photos; send locks', async ({ authedPage, apiToken, request }) => {
  const { token } = apiToken;
  const { projectId, takeoffName } = await seedProjectWithTakeoffMeasurement(request, token);
  await gotoTakeoffsTab(authedPage, projectId);
  await selectFirstTakeoff(authedPage);
  await authedPage.getByTestId('btn-proposal').click();
  await expect(authedPage).toHaveURL(new RegExp(`/project/${projectId}/proposal/[0-9a-f-]{36}$`));
  const pricing = authedPage.getByTestId('pricing-lines');
  await expect(pricing).toContainText(takeoffName);

  await pricing.getByRole('button', { name: /Add manual line/ }).click();
  const manualDesc = pricing.getByPlaceholder('Description').last();
  await manualDesc.fill('Scaffolding');
  const manualAmt = pricing.getByRole('spinbutton').last();
  await manualAmt.fill('3500'); await manualAmt.blur();
  await pricing.getByRole('button', { name: /Add manual line/ }).click();
  await pricing.getByPlaceholder('Description').last().fill('Color coat upgrade');
  await pricing.getByLabel('Alternate').last().check();

  await authedPage.getByRole('button', { name: 'Save' }).click();
  await expect(authedPage.getByText('Saved')).toBeVisible();
  await authedPage.getByRole('button', { name: /Generate PDF/ }).click();
  await expect(authedPage.getByText('Proposal PDF generated')).toBeVisible({ timeout: 30_000 });

  await authedPage.goto(`/project/${projectId}/proposal`);
  const row = authedPage.getByTestId('proposal-row-1');
  await expect(row).toContainText('#1');
  await expect(row).toContainText('draft');

  // revise → dialog → new #2 (rev. of #1)
  await row.getByTitle(/Revise/).click();
  await authedPage.getByRole('button', { name: /Create revision/ }).click();
  await expect(authedPage).toHaveURL(new RegExp(`/project/${projectId}/proposal/[0-9a-f-]{36}$`));
  await expect(authedPage.getByText('#2 (rev. of #1)')).toBeVisible();
  await expect(authedPage.getByTestId('pricing-lines')).toContainText('Scaffolding');
});

test('a draft proposal opens editable; a sent one opens read-only', async ({ authedPage, apiToken, request }) => {
  const { token } = apiToken;
  const { projectId } = await seedProjectWithTakeoffMeasurement(request, token);
  const auth = { Authorization: `Bearer ${token}` };
  const created = await request.post(`/api/projects/${projectId}/proposals`, { headers: auth, data: {} });
  const { id } = await created.json();
  await authedPage.goto(`/project/${projectId}/proposal/${id}`);
  await expect(authedPage.getByRole('button', { name: 'Save' })).toBeEnabled();

  // Lock path: needs a "sent" proposal. Sending requires SMTP; check e2e/ for
  // the stub the invoice/CO send tests use (grep "buildTransporter" / "smtp" in
  // e2e/ and playwright.config.ts). If one exists, send through the UI here and
  // assert the editor shows "Locked — revise to change" and Save is absent.
  // If none exists, stop at the draft assertion above — the lock is covered by
  // server/proposalStore.test.ts + server/proposalRoutes.test.ts.
});
```

- [ ] **Step 2: Full verification**
```bash
npm run lint
npm test                      # both vitest projects
npm run test:e2e              # if Chromium libs present; otherwise report "not run: <reason>"
```
Fix anything red.

- [ ] **Step 3: Changelog** — v2.8.0 entry summarizing: proposals as first-class numbered entities (multi-line pricing, alternates, overrides, inclusions/exclusions, payment schedule, photos w/ captions, PDF attachments, revise lineage, accept/decline + signed copy, outstanding dashboard card), takeoff prints moved to Documents, FilePickerModal, company documents, admin-only proposals, **migration 28 (data-transforming — back up before pull)**.

- [ ] **Step 4: Commit + push**
```bash
git add e2e/proposal.spec.ts CHANGELOG.md
git commit -m "test(proposals): e2e proposal flow; docs: changelog v2.8.0"
git push origin testing
```

- [ ] **Step 5: Report** — final message to Nathan must state: test counts (unit + e2e or why e2e didn't run), that migration 28 transforms data on next pull (supervised), and the manual smoke list: PDF eyeball (layout §6), SMTP send, FilePickerModal on the LAN, legacy-proposal rows after migration.
