# RFI Number Non-Reuse + Blank SOV Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (1) RFI numbers become a per-project high-water counter so a deleted RFI's number is never reissued; (2) the Billing → SOV tab gets a "Download SOV" button producing the standard AIA G702/G703 workbook with all billing at $0, requiring no pay application.

**Architecture:** Change 1 is server-only: migration 20 adds `projects.rfiCounter` (backfilled to MAX(number)) and `createRfi` switches to `max(counter, MAX(number)) + 1`, writing the counter back. Change 2 is client-only: the export-context assembly buried in `AiaPayAppEditor.handleExport` moves to a shared `aiaExportShared.ts` module, which also gains a pure `buildBlankSovContext` producing a synthetic zero pay app + zeroed G702/G703; a new button on `AiaScheduleOfValues` wires them to the existing `exportAiaXlsx` (admin template still honored).

**Tech Stack:** better-sqlite3 (server), React + exceljs (client, lazy-loaded), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-30-rfi-numbers-and-blank-sov-design.md`

## Global Constraints

- Branch `testing`; push only to `testing`; no PRs unless asked (CLAUDE.md).
- Migration 20 is ADDITIVE: one new column `projects.rfiCounter INTEGER NOT NULL DEFAULT 0`, backfilled; no other schema changes.
- RFI numbering: never reuse an issued number; deleting RFIs never lowers the next number; numbering never resets.
- Blank SOV export: full G702+G703 workbook (or admin template when configured), all billing $0, balance-to-finish = scheduled values, Application No / dates blank (not "0"), filename `AIA-<project>-SOV.xlsx`. Pay-app export behavior unchanged.
- Test commands: `npx vitest run <file>`; full suite `npm test`; typecheck `npm run lint`; build `npm run build`. 666 pre-existing tests must stay green.
- Commit per task, conventional message + trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Line numbers cited below are approximate — locate by content.

---

### Task 1: RFI counter (migration 20 + createRfi, TDD)

**Files:**
- Modify: `server/migrationList.ts` (append after migration 19 `rfis`, before the closing `];`)
- Modify: `server/rfiStore.ts` (`createRfi` transaction, ~lines 44-51)
- Test: `server/rfiStore.test.ts` (add cases to the existing numbering coverage)

**Interfaces:**
- Consumes: existing tables `projects`, `rfis`; existing `createRfi`/`deleteRfi` signatures (unchanged).
- Produces: `projects.rfiCounter` column; `createRfi` returns `{ id, number }` exactly as before — no caller changes.

- [ ] **Step 1: Write the failing tests**

Add to `server/rfiStore.test.ts` (inside the main describe, using the existing `db`/project setup — project id per the file's existing convention):

```ts
  it('never reuses a deleted RFI number', () => {
    createRfi(db, 'p1', { title: 'a' });                      // RFI-001
    const b = createRfi(db, 'p1', { title: 'b' });            // RFI-002
    deleteRfi(db, b.id);
    expect(createRfi(db, 'p1', { title: 'c' }).number).toBe(3); // not 2
  });

  it('continues numbering after all RFIs are deleted', () => {
    const a = createRfi(db, 'p1', { title: 'a' });
    const b = createRfi(db, 'p1', { title: 'b' });
    deleteRfi(db, a.id);
    deleteRfi(db, b.id);
    expect(createRfi(db, 'p1', { title: 'c' }).number).toBe(3); // not 1
  });

  it('recovers when the counter is behind existing rows (max guard)', () => {
    createRfi(db, 'p1', { title: 'a' });                       // counter → 1
    db.prepare('UPDATE projects SET rfiCounter = 0 WHERE id = ?').run('p1');
    expect(createRfi(db, 'p1', { title: 'b' }).number).toBe(2); // MAX guard wins
  });
```

Adapt the project id / setup to the file's existing pattern (read it first).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run server/rfiStore.test.ts`
Expected: FAIL — first new test gets number 2 (reuse), and the max-guard test errors on the missing `rfiCounter` column until the migration lands.

- [ ] **Step 3: Add migration 20**

In `server/migrationList.ts`, insert before the final `];`:

```ts
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
```

- [ ] **Step 4: Switch `createRfi` to the counter**

In `server/rfiStore.ts`, replace the transaction body of `createRfi` (currently `MAX(number)+1`) with:

```ts
  const tx = db.transaction(() => {
    // Never reuse an issued number: the high-water counter survives deletes.
    // MAX(number) is a guard so numbering can't collide even if the counter
    // were ever behind (e.g., imported rows).
    const counter = (db.prepare('SELECT rfiCounter c FROM projects WHERE id = ?').get(projectId) as any).c;
    const max = (db.prepare('SELECT COALESCE(MAX(number), 0) m FROM rfis WHERE projectId = ?').get(projectId) as any).m;
    number = Math.max(counter, max) + 1;
    db.prepare(`INSERT INTO rfis (id, projectId, number, title, question, specRef, drawingRef, attention, responseNeededBy,
                responseText, responseFileId, status, version, sentAt, answeredAt, createdAt)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 1, NULL, NULL, ?)`)
      .run(id, projectId, number, input.title!.trim(), input.question ?? null, input.specRef ?? null,
           input.drawingRef ?? null, input.attention ?? null, input.responseNeededBy ?? null,
           input.status ?? 'open', Date.now());
    db.prepare('UPDATE projects SET rfiCounter = ? WHERE id = ?').run(number, projectId);
  });
```

Everything else in the function (validation, `requireProject`, return) stays as is.

- [ ] **Step 5: Run until green, then the full server suite**

Run: `npx vitest run server/rfiStore.test.ts` → PASS (all, including pre-existing sequential-numbering tests)
Run: `npx vitest run server/` → PASS (routes tests create RFIs too; nothing else may break)

- [ ] **Step 6: Commit**

```bash
git add server/migrationList.ts server/rfiStore.ts server/rfiStore.test.ts
git commit -m "feat(rfi): never reuse RFI numbers — migration 20 per-project high-water counter

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Shared AIA export module (TDD on the pure part)

**Files:**
- Create: `src/pages/project/billing/aiaExportShared.ts`
- Create: `src/pages/project/billing/aiaExportShared.test.ts`
- Modify: `src/pages/project/billing/AiaPayAppEditor.tsx` (`handleExport`, ~lines 136-200 — becomes a thin consumer)

**Interfaces:**
- Consumes: `getProject`, `getSettings`, `getAiaSettings`, `getSov`, `getFile` and types `AiaSovLine`, `AiaSettings`, `AiaPayApp`, `AiaG702`, `AiaG703Row` from `src/utils/store.ts`; `AiaTemplateMapping` type from `./aiaExcel`.
- Produces (Task 3 relies on these exact signatures):
  - `resolveAiaExportEnv(projectId: string): Promise<AiaExportEnv>` where `AiaExportEnv = { project, settings, aiaSettings, sovLines, company: { name, address?, phone?, email?, logoDataUrl? }, template?: { templateBuf: ArrayBuffer; mapping: AiaTemplateMapping }, templateLoadFailed: boolean }` — the logo/template resolution moved verbatim from `AiaPayAppEditor.handleExport`; on template load/parse failure `template` is undefined and `templateLoadFailed` is true (the caller toasts).
  - `buildBlankSovContext(sovLines: AiaSovLine[], aiaSettings: AiaSettings, projectId: string): { app: AiaPayApp; g703: AiaG703Row[]; g702: AiaG702 }` — pure.

- [ ] **Step 1: Write the failing pure tests**

```ts
// src/pages/project/billing/aiaExportShared.test.ts
import { describe, it, expect } from 'vitest';
import { buildBlankSovContext } from './aiaExportShared';
import { AiaSovLine } from '../../../utils/store';

const line = (over: Partial<AiaSovLine>): AiaSovLine => ({
  id: 'l1', projectId: 'p1', itemNo: '1', description: 'Stucco',
  scheduledValueCents: 100000, retainagePercent: null, isChangeOrder: 0,
  changeOrderId: null, sortOrder: 0, version: 1, createdAt: 1, ...over,
});

describe('buildBlankSovContext', () => {
  it('zeroes every billing column and sets balance = scheduled', () => {
    const { g703 } = buildBlankSovContext([line({})], {}, 'p1');
    expect(g703).toHaveLength(1);
    const r = g703[0];
    expect(r.previousCents).toBe(0);
    expect(r.thisPeriodCents).toBe(0);
    expect(r.storedCents).toBe(0);
    expect(r.totalToDateCents).toBe(0);
    expect(r.percentComplete).toBe(0);
    expect(r.retainageCents).toBe(0);
    expect(r.balanceToFinishCents).toBe(100000);
    expect(r.sovLineId).toBe('l1');
  });

  it('orders rows by sortOrder', () => {
    const { g703 } = buildBlankSovContext([
      line({ id: 'b', sortOrder: 2, description: 'second' }),
      line({ id: 'a', sortOrder: 1, description: 'first' }),
    ], {}, 'p1');
    expect(g703.map(r => r.description)).toEqual(['first', 'second']);
  });

  it('computes G702 contract sums and zeroes all progress lines', () => {
    const { g702 } = buildBlankSovContext([
      line({ id: 'a', scheduledValueCents: 100000 }),
      line({ id: 'b', scheduledValueCents: 25000, isChangeOrder: 1 }),
      line({ id: 'c', scheduledValueCents: -5000, isChangeOrder: 1 }),
    ], {}, 'p1');
    expect(g702.L1originalContractCents).toBe(100000);
    expect(g702.L2changeOrdersCents).toBe(20000);
    expect(g702.L3contractSumToDateCents).toBe(120000);
    expect(g702.L4totalCompletedStoredCents).toBe(0);
    expect(g702.L5aRetainageWorkCents).toBe(0);
    expect(g702.L5bRetainageStoredCents).toBe(0);
    expect(g702.L5retainageCents).toBe(0);
    expect(g702.L6earnedLessRetainageCents).toBe(0);
    expect(g702.L7lessPreviousCents).toBe(0);
    expect(g702.L8currentPaymentDueCents).toBe(0);
    expect(g702.L9balanceToFinishCents).toBe(120000);
    expect(g702.changeOrders).toEqual({ additionsCents: 25000, deductionsCents: -5000, netCents: 20000 });
  });

  it('synthetic app has number 0, blank dates, and settings retainage (default 10)', () => {
    const a = buildBlankSovContext([line({})], { retainagePercent: 5 }, 'p1').app;
    expect(a.number).toBe(0);
    expect(a.periodTo).toBeNull();
    expect(a.applicationDate).toBeNull();
    expect(a.retainagePercent).toBe(5);
    expect(buildBlankSovContext([line({})], {}, 'p1').app.retainagePercent).toBe(10);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/pages/project/billing/aiaExportShared.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `aiaExportShared.ts`**

Read `AiaPayAppEditor.tsx`'s `handleExport` first — the env-resolution code below must be MOVED from it verbatim (logo fetch→dataURL, template fileId→arrayBuffer + mapping JSON.parse with catch):

```ts
// src/pages/project/billing/aiaExportShared.ts
// Shared assembly for AIA G702/G703 exports: resolves everything an export
// needs that isn't the pay app itself (project, settings, logo, admin
// template), plus a pure builder for the zero-charge "blank SOV" export used
// before any pay application exists.
import {
  AiaG702, AiaG703Row, AiaPayApp, AiaSettings, AiaSovLine, Project, Settings,
  getAiaSettings, getFile, getProject, getSettings, getSov,
} from '../../../utils/store';
import type { AiaTemplateMapping } from './aiaExcel';

export interface AiaExportEnv {
  project: Project | null;
  settings: Settings;
  aiaSettings: AiaSettings;
  sovLines: AiaSovLine[];
  company: { name: string; address?: string; phone?: string; email?: string; logoDataUrl?: string };
  template?: { templateBuf: ArrayBuffer; mapping: AiaTemplateMapping };
  // True when a template is configured but failed to load/parse (caller toasts;
  // export falls back to the built-in recreation).
  templateLoadFailed: boolean;
}

export async function resolveAiaExportEnv(projectId: string): Promise<AiaExportEnv> {
  const [project, settings, aiaSettings, sovLines] = await Promise.all([
    getProject(projectId),
    getSettings(),
    getAiaSettings(projectId),
    getSov(projectId),
  ]);

  // Resolve logo to a data URL the same way Invoice/Proposal exports do.
  let logoDataUrl: string | undefined;
  const logoUrl = settings.logoUrl;
  if (logoUrl) {
    if (logoUrl.startsWith('data:')) {
      logoDataUrl = logoUrl;
    } else {
      try {
        const resp = await fetch(logoUrl);
        const blob = await resp.blob();
        logoDataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      } catch { /* skip logo on fetch error */ }
    }
  }

  // Resolve an admin-configured template (best-effort: fall back to the
  // recreation on any load/parse error so export always works).
  let template: { templateBuf: ArrayBuffer; mapping: AiaTemplateMapping } | undefined;
  let templateLoadFailed = false;
  const templateFileId = settings.aiaTemplateFileId;
  if (templateFileId) {
    try {
      const dataUrl = await getFile(templateFileId);
      if (!dataUrl) throw new Error('template file missing');
      const buf = await (await fetch(dataUrl)).arrayBuffer();
      const mapping = JSON.parse(settings.aiaTemplateMapping || '{}') as AiaTemplateMapping;
      template = { templateBuf: buf, mapping };
    } catch {
      templateLoadFailed = true;
      template = undefined;
    }
  }

  return {
    project,
    settings,
    aiaSettings,
    sovLines,
    company: {
      name: settings.companyName || settings.appName,
      address: settings.companyAddress,
      phone: settings.companyPhone,
      email: settings.companyEmail,
      logoDataUrl,
    },
    template,
    templateLoadFailed,
  };
}

// Pure. A synthetic zero pay app over the SOV: every billing column $0,
// balance-to-finish = scheduled value — the pre-project "here is the SOV for
// approval" document. number 0 renders as a blank Application No.
export function buildBlankSovContext(
  sovLines: AiaSovLine[],
  aiaSettings: AiaSettings,
  projectId: string,
): { app: AiaPayApp; g703: AiaG703Row[]; g702: AiaG702 } {
  const g703: AiaG703Row[] = [...sovLines]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
    .map(l => ({
      sovLineId: l.id, itemNo: l.itemNo, description: l.description,
      isChangeOrder: l.isChangeOrder, scheduledValueCents: l.scheduledValueCents,
      previousCents: 0, thisPeriodCents: 0, storedCents: 0,
      totalToDateCents: 0, percentComplete: 0,
      balanceToFinishCents: l.scheduledValueCents, retainageCents: 0,
    }));
  const L1 = g703.filter(r => !r.isChangeOrder).reduce((a, r) => a + r.scheduledValueCents, 0);
  const co = g703.filter(r => r.isChangeOrder);
  const additions = co.filter(r => r.scheduledValueCents > 0).reduce((a, r) => a + r.scheduledValueCents, 0);
  const deductions = co.filter(r => r.scheduledValueCents < 0).reduce((a, r) => a + r.scheduledValueCents, 0);
  const L2 = additions + deductions;
  const L3 = L1 + L2;
  const retainagePercent = aiaSettings.retainagePercent ?? 10;
  const app: AiaPayApp = {
    id: 'sov-preview', projectId, number: 0, periodTo: null, applicationDate: null,
    retainagePercent,
    storedRetainagePercent: aiaSettings.storedRetainagePercent ?? retainagePercent,
    status: 'draft', version: 1, createdAt: 0,
  };
  const g702: AiaG702 = {
    L1originalContractCents: L1,
    L2changeOrdersCents: L2,
    L3contractSumToDateCents: L3,
    L4totalCompletedStoredCents: 0,
    L5aRetainageWorkCents: 0,
    L5bRetainageStoredCents: 0,
    L5retainageCents: 0,
    L6earnedLessRetainageCents: 0,
    L7lessPreviousCents: 0,
    L8currentPaymentDueCents: 0,
    L9balanceToFinishCents: L3,
    changeOrders: { additionsCents: additions, deductionsCents: deductions, netCents: L2 },
  };
  return { app, g703, g702 };
}
```

Type caveat: check what `getProject`/`getSettings` actually return in `src/utils/store.ts` — if there is no exported `Project`/`Settings` type with these names, use the actual return types (e.g. `Awaited<ReturnType<typeof getProject>>`) rather than inventing names.

- [ ] **Step 4: Refactor `AiaPayAppEditor.handleExport` to consume it**

Replace the env-resolution portion (the `Promise.all`, logo block, and template block) with:

```ts
      const env = await resolveAiaExportEnv(projectId);
      if (env.templateLoadFailed) {
        toast('AIA template failed to load — exporting standard G702/G703 instead', { type: 'error' });
      }
      await exportAiaXlsx({
        projectName: env.project?.name ?? 'Project',
        contractor: env.project?.contractor ?? undefined,
        company: env.company,
        aiaSettings: env.aiaSettings,
        app: data.app,
        sovLines: env.sovLines,
        g702: data.g702,
        g703: data.g703,
      }, env.template);
```

Keep the surrounding try/catch/finally, toasts, and `setExporting` exactly as they are. Remove now-unused imports (`getProject`, `getSettings`, `getAiaSettings`, `getSov`, `getFile`, `AiaTemplateMapping` — whichever are no longer referenced).

- [ ] **Step 5: Run until green + typecheck**

Run: `npx vitest run src/pages/project/billing/` → PASS (new pure tests + existing 9 AIA Excel tests)
Run: `npm run lint` → clean

- [ ] **Step 6: Commit**

```bash
git add src/pages/project/billing/aiaExportShared.ts src/pages/project/billing/aiaExportShared.test.ts src/pages/project/billing/AiaPayAppEditor.tsx
git commit -m "refactor(billing): shared AIA export env + pure blank-SOV context builder

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Blank Application No, filename override, Download SOV button, full verify

**Files:**
- Modify: `src/pages/project/billing/aiaExcel.ts` (~line 331 recreation `H3`, ~line 476 template `applicationNo`, `sanitizeFilename` export, `exportAiaXlsx` signature ~line 536)
- Modify: `src/pages/project/billing/aiaExcel.test.ts` (one added test)
- Modify: `src/pages/project/billing/AiaScheduleOfValues.tsx` (imports, handler, header button)

**Interfaces:**
- Consumes: Task 2's `resolveAiaExportEnv` / `buildBlankSovContext`; existing `exportAiaXlsx(ctx, template?)`.
- Produces: `exportAiaXlsx(ctx, template?, filename?)` — third optional param overrides the download name; `sanitizeFilename` exported from `aiaExcel.ts`.

- [ ] **Step 1: Write the failing workbook test**

In `src/pages/project/billing/aiaExcel.test.ts`, add (adapt the fixture reference to the file's existing fixture name):

```ts
  it('leaves the Application No blank for a zero-numbered (blank SOV) app', async () => {
    const wb = await buildAiaWorkbook({ ...baseCtx, app: { ...baseCtx.app, number: 0 } });
    const g702 = wb.getWorksheet('G702')!;
    expect(g702.getCell('H3').value).toBe('');
  });
```

Run: `npx vitest run src/pages/project/billing/aiaExcel.test.ts`
Expected: the new test FAILS (cell holds 0), existing tests PASS.

- [ ] **Step 2: Implement the aiaExcel changes**

1. Recreation (~line 331): `setCell(ws, 'H3', app.number > 0 ? app.number : '', { align: 'right' }); // input — G703 I3`
2. Template fill (~line 476): `setMapped(g702ws, c.applicationNo, app.number > 0 ? app.number : '');`
3. Export `sanitizeFilename` (add `export` to the existing function).
4. `exportAiaXlsx` signature and download name:

```ts
export async function exportAiaXlsx(
  ctx: AiaExportCtx,
  template?: { templateBuf: ArrayBuffer; mapping: AiaTemplateMapping },
  filename?: string,
): Promise<void> {
```

and `a.download = filename ?? \`AIA-${sanitizeFilename(ctx.projectName)}-App${ctx.app.number}.xlsx\`;`

Run: `npx vitest run src/pages/project/billing/aiaExcel.test.ts` → PASS (all 10).

- [ ] **Step 3: Add the Download SOV button**

In `src/pages/project/billing/AiaScheduleOfValues.tsx`:

1. Imports: add `Download` to the lucide import; add `import { exportAiaXlsx, sanitizeFilename } from './aiaExcel';` and `import { resolveAiaExportEnv, buildBlankSovContext } from './aiaExportShared';`.
2. State: `const [downloading, setDownloading] = useState(false);`
3. Handler (place near the other handlers):

```ts
  // Zero-charge SOV export — the same G702/G703 workbook (or admin template) a
  // pay-app export produces, with all billing at $0. Lets the SOV be presented
  // for approval before any pay application exists.
  const handleDownloadSov = async () => {
    if (!lines || lines.length === 0) return;
    setDownloading(true);
    try {
      const env = await resolveAiaExportEnv(projectId);
      if (env.templateLoadFailed) {
        toast('AIA template failed to load — exporting standard G702/G703 instead', { type: 'error' });
      }
      const blank = buildBlankSovContext(env.sovLines, env.aiaSettings, projectId);
      await exportAiaXlsx({
        projectName: env.project?.name ?? 'Project',
        contractor: env.project?.contractor ?? undefined,
        company: env.company,
        aiaSettings: env.aiaSettings,
        app: blank.app,
        sovLines: env.sovLines,
        g702: blank.g702,
        g703: blank.g703,
      }, env.template, `AIA-${sanitizeFilename(env.project?.name ?? 'Project')}-SOV.xlsx`);
      toast('SOV downloaded', { type: 'success' });
    } catch {
      toast('Failed to export SOV', { type: 'error' });
    } finally {
      setDownloading(false);
    }
  };
```

4. Button — first in the CardHeader actions cluster (before "Seed from estimate"):

```tsx
            <Button size="sm" variant="secondary" onClick={handleDownloadSov}
              disabled={busy || downloading || !lines || lines.length === 0}>
              <Download size={14} />{downloading ? 'Exporting…' : 'Download SOV'}
            </Button>
```

- [ ] **Step 4: Full verification**

Run: `npx vitest run src/pages/project/billing/` → PASS
Run: `npm run lint` → clean
Run: `npm test` → full suite PASS (669 pre-existing incl. Task 1/2 additions, plus the new workbook test)
Run: `npm run build` → succeeds

- [ ] **Step 5: Commit**

```bash
git add src/pages/project/billing/aiaExcel.ts src/pages/project/billing/aiaExcel.test.ts src/pages/project/billing/AiaScheduleOfValues.tsx
git commit -m "feat(billing): Download SOV — zero-charge G702/G703 export from the SOV tab

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
