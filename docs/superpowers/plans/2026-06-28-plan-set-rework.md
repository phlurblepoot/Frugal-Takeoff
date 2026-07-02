# Plan Set Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make plan-set revisions correct: one living, editable measurement set per logical sheet (on the current revision), older revisions auto-copied-forward then frozen read-only; totals/printouts/proposal all use the one set; duplicate page numbers blocked within a set; a hybrid raw-text+OCR extract; and industry-standard plan-set UX.

**Architecture:** Approach C from the spec (`docs/superpowers/specs/2026-06-28-plan-set-rework-design.md`). Add a durable `sheetId` to every page; a "logical sheet" is the group of pages sharing a `sheetId`, ordered by plan-set order, newest = current/living. `current vs superseded` is **derived** (positional), not a stored flag. Measurements stay on pages (no mass move); on revision they're copied onto the new current page and the prior page becomes read-only history. A versioned, non-destructive migration backfills `sheetId`, suffixes existing within-set duplicate page numbers, and establishes the invariant `current = newest revision = living set`.

**Tech Stack:** React 19 + react-router 7, TypeScript, Vite, Express 4 + better-sqlite3 (versioned migrations), exceljs/jsPDF (unrelated), pdf.js + Tesseract (extract), vitest (unit), Playwright (e2e). Money/geometry unaffected.

**Key invariants (hold after every task):** `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run build` green. The Playwright canvas suite (`npm run test:e2e`) is the regression gate for canvas-touching tasks. No measurement data is ever deleted by the migration.

**Reference (current code, from the 2026-06-25 exploration):**
- `src/types.ts`: `ProjectPage` (~93-129, has `planSetId?`, `pageNumber`, `measurements: Measurement[]`, `scaleConfig`), `Measurement` (~10-23, has decorative `planSetId?`), `PlanSet` (~70-75), `Project.pages/planSets/takeoffs` (~155-184).
- `src/utils/planSets.ts`: `sheetKey(page)` (5-8, lowercased pageNumber), `comparePlanSets`, `allowedPlanSets`, `computeRevisionModel(project, selectedPlanSetId)` (54-119) returning `{ visiblePages, currentPageIds, revisionsBySheet, revisionNumberByPageId, latestPageIdBySheet, status }`.
- `src/pages/ProjectView.tsx`: `handleAddPages` (~669-894, builds new pages with `measurements: []`), `handleConfirmAddPages` (~1454), `maybeOfferCarryForward` (~1517-1573, the optional copy dialog), `handleCopyMeasurementsForward` (~316-347), `revisionModel` useMemo (~1579), `getTakeoffTotals` (~1589), `handlePrint` (~1140), plan-set selector (~1863-1898).
- `src/components/PageNamingStep.tsx`: naming inputs + `handleExtractText`/`recognizePage` (~191-299), `extractTextFromVectorRegion` (~21-61), `renderPdfPageToDataUrl` (~65-80).
- `src/utils/pdf.ts`: `buildOcrCrop` (~120-173), `ocrParamsFor` (~176-187), `cleanSheetNumber` (~192-208), `cleanDescriptionText`, `detectPageInfo`, `loadPdfPagesGenerator` (~540-556 OCR fallback), `detectSheetNumberFromItems`/`detectDescriptionFromItems`.
- `src/pages/project/proposal/proposalGenerator.ts`: `computeTakeoffTotals(project, currentPageIds)` (~442-536, filters `project.pages.filter(p => currentPageIds.has(p.id))`), `buildHighlightsPdf` (~51-402, same filter).
- `src/pages/project/ProjectProposal.tsx`: `computeRevisionModel(project, '').currentPageIds` (~91-92).
- `src/pages/project/ProjectPagesTab.tsx`: revision badges (~320, 486), context menu (~620-650).
- `src/components/PlanSetRevisions.tsx`, `PlanSetCompare.tsx`, `PlanSetManager.tsx`, `AddPagesModal.tsx`.
- Server: `server/migrationList.ts` (latest migration = 14; pages/measurements/plan_sets tables created in migration 3; next = 15), `server/projectStore.ts` (`loadProject` ~58-99 assembles measurements onto pages; `decomposeProject` ~144-207 DELETE+reinsert child tables, spreads unknown fields into `attrs`).

---

## Task 1: Sheet-identity revision model (pure logic)

**Files:** Modify `src/types.ts`; rewrite `src/utils/planSets.ts`; Test `src/utils/planSets.test.ts` (create if absent).

Goal: `computeRevisionModel` keys off a durable `sheetId`; current/superseded is positional; the public return shape is preserved so callers don't churn.

- [ ] **Step 1 — Type.** In `src/types.ts` `ProjectPage`, add `sheetId?: string;` (durable logical-sheet id; optional for legacy/in-flight pages — the migration backfills it). Add a doc comment: "All revisions of one sheet share a sheetId. Newest revision (by plan-set order) is current/living; older are read-only history."

- [ ] **Step 2 — Failing tests** in `src/utils/planSets.test.ts` for a new pure helper `groupSheets(project)` and the revised `computeRevisionModel`:

```ts
import { describe, it, expect } from 'vitest';
import { computeRevisionModel, effectiveSheetId } from './planSets';
import type { Project, ProjectPage } from '../types';

const page = (o: Partial<ProjectPage>): ProjectPage => ({
  id: 'p', name: '', pageNumber: '', description: '', imageId: '', thumbnailId: '',
  imageWidth: 0, imageHeight: 0, measurements: [], scaleConfig: null, ...o,
} as ProjectPage);

const proj = (pages: ProjectPage[], planSets: any[]): Project => ({
  id: 'pr', name: 'x', createdAt: 0, pages, takeoffs: [], planSets,
} as Project);

const sets = [
  { id: 's1', name: 'Set 1', createdAt: 1 },
  { id: 's2', name: 'Set 2', createdAt: 2 },
];

it('current revision is the newest page sharing a sheetId', () => {
  const a1 = page({ id: 'a1', sheetId: 'A', pageNumber: 'A-101', planSetId: 's1', measurements: [{ id: 'm', type: 'length', points: [], takeoffId: 't' } as any] });
  const a2 = page({ id: 'a2', sheetId: 'A', pageNumber: 'A-101', planSetId: 's2', measurements: [{ id: 'm2', type: 'length', points: [], takeoffId: 't' } as any] });
  const m = computeRevisionModel(proj([a1, a2], sets), '');
  expect([...m.currentPageIds]).toEqual(['a2']);            // newest only
  expect(m.status('a1')).toBe('superseded');
  expect(m.status('a2')).toBe('current');
  expect(m.revisionNumberByPageId.get('a1')).toBe(1);
  expect(m.revisionNumberByPageId.get('a2')).toBe(2);
});

it('as-of an older set shows that revision (read-only history)', () => {
  const a1 = page({ id: 'a1', sheetId: 'A', pageNumber: 'A-101', planSetId: 's1' });
  const a2 = page({ id: 'a2', sheetId: 'A', pageNumber: 'A-101', planSetId: 's2' });
  const m = computeRevisionModel(proj([a1, a2], sets), 's1');  // as of Set 1
  expect([...m.currentPageIds]).toEqual(['a1']);
});

it('falls back to pageNumber when sheetId is missing (legacy)', () => {
  const a1 = page({ id: 'a1', pageNumber: 'A-101', planSetId: 's1' });
  const a2 = page({ id: 'a2', pageNumber: 'A-101', planSetId: 's2' });
  const m = computeRevisionModel(proj([a1, a2], sets), '');
  expect([...m.currentPageIds]).toEqual(['a2']);
});

it('distinct sheetIds with the same pageNumber are separate sheets (not revisions)', () => {
  const a1 = page({ id: 'a1', sheetId: 'A', pageNumber: 'A-101', planSetId: 's1' });
  const b1 = page({ id: 'b1', sheetId: 'B', pageNumber: 'A-101', planSetId: 's1' });
  const m = computeRevisionModel(proj([a1, b1], sets), '');
  expect(new Set(m.currentPageIds)).toEqual(new Set(['a1', 'b1']));
});
```

- [ ] **Step 3 — Run, verify fail:** `npx vitest run src/utils/planSets.test.ts` → fails (`effectiveSheetId` not exported / wrong behavior).

- [ ] **Step 4 — Implement** in `src/utils/planSets.ts`:
  - Add `export const effectiveSheetId = (p: ProjectPage): string => p.sheetId || (p.pageNumber?.trim().toLowerCase() ? 'pn:' + p.pageNumber.trim().toLowerCase() : 'id:' + p.id);` — durable id when present, else a stable fallback from page number, else the page's own id (unkeyed pages are their own sheet). Keep `sheetKey` for import matching (it's the human page-number key).
  - Rewrite `computeRevisionModel` to group pages by `effectiveSheetId` (instead of `sheetKey`). Keep the return shape: `revisionsBySheet` (now keyed by effectiveSheetId), `revisionNumberByPageId`, `latestPageIdBySheet`, `visiblePages`, `currentPageIds`, `status`. The "current" page per sheet = the newest revision whose plan set is allowed by the as-of selection (`allowedPlanSets`), else newest overall. Pages with no planSetId are always allowed. Preserve oldest→newest ordering via `comparePlanSets`.
  - `status(pageId)`: `'current'` if it's its sheet's current page; `'superseded'` if it's an older revision of a sheet with ≥2 revisions; `'unique'` if its sheet has exactly one revision.

- [ ] **Step 5 — Run, verify pass:** `npx vitest run src/utils/planSets.test.ts` → PASS. Then `npx tsc --noEmit`.

- [ ] **Step 6 — Commit:** `git add src/types.ts src/utils/planSets.ts src/utils/planSets.test.ts && git commit -m "feat(plansets): sheetId-keyed revision model (current=newest, derived superseded)"`

---

## Task 2: Duplicate page-number validation + suffix helpers (pure logic)

**Files:** Create `src/utils/sheetNaming.ts`; Test `src/utils/sheetNaming.test.ts`.

- [ ] **Step 1 — Failing tests** `src/utils/sheetNaming.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { findDuplicatePageNumbers, suffixPageNumber } from './sheetNaming';

it('flags duplicate non-blank page numbers within one set (case-insensitive)', () => {
  const rows = [
    { id: '1', planSetId: 's1', pageNumber: 'A-101' },
    { id: '2', planSetId: 's1', pageNumber: 'a-101' },  // dup of #1
    { id: '3', planSetId: 's1', pageNumber: 'A-102' },
    { id: '4', planSetId: 's2', pageNumber: 'A-101' },  // different set → ok
    { id: '5', planSetId: 's1', pageNumber: '' },        // blank → exempt
    { id: '6', planSetId: 's1', pageNumber: '' },        // blank → exempt
  ];
  const dups = findDuplicatePageNumbers(rows);
  expect(new Set(dups)).toEqual(new Set(['1', '2']));
});

it('suffixes to the next free " (n)" within the set', () => {
  const taken = new Set(['a-101', 'a-101 (2)']);
  expect(suffixPageNumber('A-101', taken)).toBe('A-101 (3)');
  expect(suffixPageNumber('A-102', taken)).toBe('A-102 (2)');
});
```

- [ ] **Step 2 — Run, verify fail:** `npx vitest run src/utils/sheetNaming.test.ts`.

- [ ] **Step 3 — Implement** `src/utils/sheetNaming.ts`:

```ts
export interface NumberedRow { id: string; planSetId?: string; pageNumber?: string | null; }
const norm = (s?: string | null) => (s ?? '').trim().toLowerCase();

/** Ids of rows whose page number collides with another row in the SAME plan set.
 *  Blank page numbers are exempt. */
export function findDuplicatePageNumbers(rows: NumberedRow[]): string[] {
  const seen = new Map<string, string[]>(); // `${set} ${num}` -> ids
  for (const r of rows) {
    const num = norm(r.pageNumber);
    if (!num) continue;
    const key = (r.planSetId ?? '') + ' ' + num;
    (seen.get(key) ?? seen.set(key, []).get(key)!).push(r.id);
  }
  const out: string[] = [];
  for (const ids of seen.values()) if (ids.length > 1) out.push(...ids);
  return out;
}

/** Next free "Base (n)" given a set of already-taken (normalized) page numbers. */
export function suffixPageNumber(base: string, takenNormalized: Set<string>): string {
  let n = 2;
  while (takenNormalized.has(norm(`${base} (${n})`))) n++;
  return `${base} (${n})`;
}
```

- [ ] **Step 4 — Run, verify pass; tsc.** `npx vitest run src/utils/sheetNaming.test.ts && npx tsc --noEmit`

- [ ] **Step 5 — Commit:** `git add src/utils/sheetNaming.ts src/utils/sheetNaming.test.ts && git commit -m "feat(plansets): duplicate page-number detection + suffix helper"`

---

## Task 3: Hybrid extract (raw text + OCR fuzzy match) — pure matcher

**Files:** Create `src/utils/extractMatch.ts`; Test `src/utils/extractMatch.test.ts`.

- [ ] **Step 1 — Failing tests** `src/utils/extractMatch.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { reconcileExtract } from './extractMatch';

it('returns the raw candidate closest to the OCR string', () => {
  const r = reconcileExtract({ rawCandidates: ['A-101', 'SCALE 1/4"', 'NORTH'], ocrText: 'A-1O1' });
  expect(r.value).toBe('A-101');         // clean chars from raw
  expect(r.confidence).toBe('high');
});

it('falls back to cleaned OCR when no raw candidate is close', () => {
  const r = reconcileExtract({ rawCandidates: ['TOTALLY DIFFERENT'], ocrText: 'A-205' });
  expect(r.value).toBe('A-205');
  expect(r.confidence).toBe('low');      // OCR-only
});

it('uses OCR directly when there are no raw candidates', () => {
  const r = reconcileExtract({ rawCandidates: [], ocrText: 'E-3.1' });
  expect(r.value).toBe('E-3.1');
  expect(r.confidence).toBe('low');
});

it('is high-confidence when raw and OCR agree exactly', () => {
  const r = reconcileExtract({ rawCandidates: ['A-101'], ocrText: 'A-101' });
  expect(r.confidence).toBe('high');
});

it('returns empty + low when nothing is available', () => {
  const r = reconcileExtract({ rawCandidates: [], ocrText: '' });
  expect(r.value).toBe('');
  expect(r.confidence).toBe('low');
});
```

- [ ] **Step 2 — Run, verify fail.**

- [ ] **Step 3 — Implement** `src/utils/extractMatch.ts`:

```ts
export type ExtractConfidence = 'high' | 'low';
export interface ReconcileInput { rawCandidates: string[]; ocrText: string; }
export interface ReconcileResult { value: string; confidence: ExtractConfidence; }

const normalize = (s: string) => s.trim().toUpperCase().replace(/\s+/g, ' ');

/** Levenshtein distance. */
function lev(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    d[i][j] = Math.min(d[i-1][j] + 1, d[i][j-1] + 1, d[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
  return d[m][n];
}
/** 1 = identical, 0 = totally different. */
const sim = (a: string, b: string) => {
  const A = normalize(a), B = normalize(b);
  if (!A && !B) return 1;
  const L = Math.max(A.length, B.length) || 1;
  return 1 - lev(A, B) / L;
};

/**
 * Reconcile a region's raw PDF-text candidates against an OCR read.
 * - With raw candidates: return the one most similar to OCR (clean characters,
 *   OCR disambiguates which). High confidence when the best match is strong.
 * - Otherwise fall back to the OCR text (low confidence).
 */
export function reconcileExtract({ rawCandidates, ocrText }: ReconcileInput): ReconcileResult {
  const ocr = ocrText.trim();
  const cands = rawCandidates.map(c => c.trim()).filter(Boolean);
  if (cands.length) {
    let best = cands[0], bestScore = -1;
    for (const c of cands) { const s = ocr ? sim(c, ocr) : 0; if (s > bestScore) { bestScore = s; best = c; } }
    // Strong agreement OR no OCR to compare but a single obvious candidate.
    const confident = ocr ? bestScore >= 0.6 : cands.length === 1;
    if (confident) return { value: best, confidence: 'high' };
    // Weak match: prefer the readable OCR if we have it, else the best raw.
    return { value: ocr || best, confidence: 'low' };
  }
  return { value: ocr, confidence: 'low' };
}
```

- [ ] **Step 4 — Run, verify pass; tsc.**

- [ ] **Step 5 — Commit:** `git add src/utils/extractMatch.ts src/utils/extractMatch.test.ts && git commit -m "feat(extract): raw-text + OCR fuzzy reconciliation (pure)"`

---

## Task 4: Wire hybrid extract into the region tool + import detection

**Files:** Modify `src/components/PageNamingStep.tsx` (`recognizePage`, ~191-299); Modify `src/utils/pdf.ts` (region detection used by import, around `detectPageInfo`/`loadPdfPagesGenerator`).

- [ ] **Step 1 — PageNamingStep.recognizePage:** change the vector-first/OCR-fallback to ALWAYS gather both, then reconcile:
  - Compute `rawCandidates` = the individual text-layer strings overlapping the region (return them as an array from `extractTextFromVectorRegion`, or add a sibling that returns the array). Currently it joins to one string; expose the per-item array.
  - Run OCR on the region crop (the existing `buildOcrCrop` + Tesseract path) to get `ocrText` — run it always (not only when raw is empty).
  - `const { value, confidence } = reconcileExtract({ rawCandidates, ocrText });` then `cleanSheetNumber(value)` (number mode) or `cleanDescriptionText(value)` (description mode).
  - Return `{ value, confidence }` so the caller can mark the row's confidence (used by Task 6's "needs review" flag). Store the per-page confidence in PageNamingStep state.
  - Keep performance sane: OCR only runs when the user invokes Extract (manual), so always-OCR there is fine.

- [ ] **Step 2 — Import auto-detect (pdf.ts):** in `loadPdfPagesGenerator`'s per-page detection (where `detectSheetNumberFromItems`/embedded text is used to populate the suggested page number), also produce a `detectionConfidence` per page: `'high'` when embedded text gave a clean sheet number; `'low'` when it fell back to OCR or filename heuristics. Thread `detectionConfidence` (and `detectedDescriptionConfidence`) out of the generator's yielded page data so the importer can flag low-confidence pages in the review step. (Do NOT change the existing extraction order for import beyond surfacing confidence — full hybrid reconciliation at import time is optional; the manual Extract tool gets the full reconcile.)

- [ ] **Step 3 — Tests/build:** `npx tsc --noEmit && npm run build`. (UI wiring; the pure matcher is already unit-tested. Add a small test only if a new pure helper is introduced in pdf.ts.)

- [ ] **Step 4 — Commit:** `git add src/components/PageNamingStep.tsx src/utils/pdf.ts && git commit -m "feat(extract): hybrid reconcile in region tool + confidence from import detection"`

---

## Task 5: Server — sheetId persistence + backfill migration (migration 15)

**Files:** Modify `server/migrationList.ts` (add migration 15); verify `server/projectStore.ts` round-trips `sheetId`; Test `server/migrationList.test.ts` (or a new `server/planSetMigration.test.ts`).

- [ ] **Step 1 — Round-trip `sheetId`:** confirm `decomposeProject`/`loadProject` preserve `page.sheetId`. If pages are stored with known columns + an `attrs` JSON of the remainder, `sheetId` lands in `attrs` automatically. If the decompose explicitly whitelists page fields, add `sheetId` to the preserved set (column or attrs). Write a quick round-trip test: save a project whose page has `sheetId: 'X'`, reload, assert it's still `'X'`.

- [ ] **Step 2 — Failing migration test** `server/planSetMigration.test.ts`: build a pre-migration DB fixture (run migrations up to 14) seeding a project with: plan set s1 (older) page A-101 with measurements [m1]; plan set s2 (newer) page A-101 carried-forward copy with measurements [m1']; plus s1 with two pages both "B-200" (within-set duplicate). Run migration 15. Assert:
  - both A-101 pages get the SAME `sheetId`; both B-200 pages get DISTINCT `sheetId`s and one is suffixed to `B-200 (2)`;
  - the **current** A-101 (newest, s2) has measurements (living set); the older is retained;
  - no measurements were deleted (count preserved or copied-forward, never fewer than the source).

- [ ] **Step 3 — Implement migration 15** in `server/migrationList.ts` (`{ version: 15, name: 'plan-set-sheet-identity', up(db) { ... } }`). Algorithm, per project:
  1. Load all pages (id, projectId, planSetId, pageNumber, sortOrder) + plan-set order.
  2. **Suffix within-set duplicates:** for each plan set, find non-blank page numbers used by >1 page; for the 2nd+ occurrence, set pageNumber = `suffixPageNumber(base, takenInSet)` (reuse the same logic as `src/utils/sheetNaming.ts` — duplicate the tiny helper server-side or inline it; keep behavior identical). Persist the new pageNumber.
  3. **Assign sheetId:** group pages across the whole project by normalized pageNumber (post-suffix). Each group = one sheet → one new `sheetId` (uuid) written to every page in the group (into the page row's attrs/column). Blank-numbered pages each get their own `sheetId`.
  4. **Establish current=newest=living:** for each sheet, order revisions by plan-set order; the newest is current. If the current page has zero measurements but an older revision has some, COPY the most-recent non-empty revision's measurement rows onto the current page (new measurement ids, `pageId` = current page). Do NOT delete the source rows (they remain as that older revision's frozen history).
  5. Bump the schema version. The framework backs up the DB before applying (existing behavior) and VACUUMs after.
  - Mark this migration clearly in a comment as **data-transforming + supervised** (per the migration protocol).

- [ ] **Step 4 — Run, verify pass:** `npx vitest run server/planSetMigration.test.ts`, then the FULL `npm test` (schema change — run everything, watch the verify-migration tool; update its expected `LATEST_SCHEMA_VERSION`/table checks if it enumerates schema version).

- [ ] **Step 5 — Commit:** `git add server/migrationList.ts server/projectStore.ts server/planSetMigration.test.ts scripts/verify-migration.ts && git commit -m "feat(plansets): migration 15 — backfill sheetId, suffix dup page numbers, current=living"`

---

## Task 6: Auto copy-forward on revision (replace the optional carry dialog)

**Files:** Modify `src/pages/ProjectView.tsx` (`handleAddPages`/`handleConfirmAddPages`/`maybeOfferCarryForward`/`handleCopyMeasurementsForward`); add a pure helper in `src/utils/planSets.ts` + test.

- [ ] **Step 1 — Pure helper + test** in `planSets.ts`/`planSets.test.ts`:

```ts
// planSets.ts
/** Build the measurements + scale to seed a NEW revision of a sheet from its
 *  current living page. Returns fresh-id copies (caller assigns to the new page). */
export function carryForwardFrom(currentPage: ProjectPage, newId: () => string) {
  return {
    measurements: currentPage.measurements.map(m => ({ ...m, id: newId() })),
    scaleConfig: currentPage.scaleConfig ? { ...currentPage.scaleConfig } : null,
    scaleRegions: (currentPage as any).scaleRegions,
    isMultiRegion: (currentPage as any).isMultiRegion,
  };
}
```
Test: given a current page with 2 measurements + a scaleConfig, `carryForwardFrom` returns 2 measurements with NEW ids (not equal to originals) and a cloned scaleConfig.

- [ ] **Step 2 — Wire into add-set:** when a new revision page is committed for an existing sheet (its `sheetId` was matched in the review step, Task 7), seed the new page via `carryForwardFrom(currentLivingPageOfThatSheet, uuidv4)` so the new revision is never empty; the previously-current page keeps its measurements (now positionally superseded → read-only). Assign the new page `sheetId = <matched sheetId>`; new sheets get a fresh `sheetId`.

- [ ] **Step 3 — Remove the old behavior:** delete `maybeOfferCarryForward` (the optional dialog) and the manual `handleCopyMeasurementsForward` context-menu action + its menu item (the copy is now automatic on revision; editing happens only on the current revision). Keep imports tidy.

- [ ] **Step 4 — Verify:** `npx tsc --noEmit && npm run build`; manually reason that adding a revision yields exactly one editable (current) copy + a read-only prior. Run `npm run test:e2e` for the canvas/takeoff specs (no regression).

- [ ] **Step 5 — Commit:** `git add src/pages/ProjectView.tsx src/utils/planSets.ts src/utils/planSets.test.ts && git commit -m "feat(plansets): automatic copy-forward on revision; drop optional carry dialog"`

---

## Task 7: Add-set Revision Review step (UI)

**Files:** Modify `src/components/PageNamingStep.tsx` and/or `src/components/AddPagesModal.tsx` and the add-pages flow in `src/pages/ProjectView.tsx`.

- [ ] **Step 1 — Per-row match + editable name + confidence.** In the naming/review step, for each incoming page show: editable Page # + Description (existing inputs), the per-row **Extract** button (now hybrid), a **match dropdown** with options computed from the current project sheets: `Revision of {pageNumber}` (when the page number matches an existing sheet's number → preselect, store the target `sheetId`), `New sheet` (default when no match), `Unchanged / skip` (when identical to current — optional; at minimum offer Revision/New). Editing the Page # recomputes the match + the duplicate check.

- [ ] **Step 2 — Confidence flag.** Mark rows whose detection confidence is `low` (from Task 4) with a "needs review" amber indicator. Show a count in the footer; the Commit button shows "(N need review)" but stays enabled (soft nudge).

- [ ] **Step 3 — Duplicate block + suffix.** Use `findDuplicatePageNumbers` over the in-progress rows (same plan set). Highlight colliding rows red, show "duplicate" inline, and **disable Commit** until resolved. Provide a one-click **Suffix** button per colliding row that calls `suffixPageNumber(base, takenInSet)` and updates the field.

- [ ] **Step 4 — Commit wiring.** On Commit, assign each page its `sheetId` (matched sheet's id, or a fresh uuid for New), and for revisions seed measurements via `carryForwardFrom` (Task 6). Persist via the existing save path.

- [ ] **Step 5 — Verify:** `npx tsc --noEmit && npm run build`. Commit: `git add -A && git commit -m "feat(plansets): add-set revision review (match/confidence/duplicate-block/suffix)"`

---

## Task 8: Sheets-grid UX, revision switcher, read-only history & canvas, enlarged compare

**Files:** Modify `src/pages/project/ProjectPagesTab.tsx`, `src/components/PlanSetRevisions.tsx`, `src/components/PlanSetCompare.tsx`, the canvas (`src/pages/CanvasView.tsx`), and `src/pages/ProjectView.tsx` plan-set selector.

- [ ] **Step 1 — Grid treatment:** badges "Current · Rev N" on the current page; superseded pages **hidden by default** with a "Show superseded" toggle (when shown: dimmed + "read-only" badge). Use `computeRevisionModel` `status`/`revisionNumberByPageId`.
- [ ] **Step 2 — Per-sheet revision switcher:** a `Rev N ▾` control on a sheet opens `PlanSetRevisions` (already exists) — ensure it lists revisions newest-first, marks current, shows measurement counts, and each older revision has a read-only "View" that navigates to that page in read-only mode.
- [ ] **Step 3 — Read-only canvas:** when the opened page is NOT its sheet's current revision (use `computeRevisionModel(project,'').status(pageId) === 'superseded'`), show a banner "Viewing Rev N — read-only history" + "Go to current" (navigates to the current page id), and disable all measurement editing/drawing tools (gate the same way Phase 8 gated phone read-only). Frozen measurements still render.
- [ ] **Step 4 — Enlarged compare:** change `PlanSetCompare` from the small modal to a full-screen/large canvas (reuse `Modal` width="full" or a full-bleed overlay) with pan/zoom + an opacity slider between the two revisions. Keep its existing compare logic; just enlarge + add pan/zoom if not present.
- [ ] **Step 5 — Verify:** `npx tsc --noEmit && npm run build && npm run test:e2e` (canvas regression). Commit: `git add -A && git commit -m "feat(plansets): sheets grid treatment, revision switcher, read-only canvas, enlarged compare"`

---

## Task 9: Unify consumers + final verification

**Files:** Modify `src/pages/project/ProjectProposal.tsx`; confirm `proposalGenerator.ts` consumers; full gates.

- [ ] **Step 1 — Proposal consistency:** `ProjectProposal` already uses `computeRevisionModel(project,'').currentPageIds`; confirm it now reflects the sheetId model (it will, since computeRevisionModel changed). Confirm `computeTakeoffTotals` + `buildHighlightsPdf` are unchanged in interface (still take `currentPageIds`) and therefore consistent with the Pages/Takeoffs tab. Add a test that, given the Task-1 fixtures, `computeTakeoffTotals(project, computeRevisionModel(project,'').currentPageIds)` counts only the current revision's measurements (no double counting across revisions).
- [ ] **Step 2 — Full gates:** `npx tsc --noEmit && npm run lint && npm test && npm run build && npm run test:e2e`.
- [ ] **Step 3 — Commit:** `git add -A && git commit -m "test(plansets): consumers count only the current living set"`

---

## Final Review + Ship (controller, not a task step)

- Dispatch a final opus review over the whole diff: sheetId model + migration correctness (no measurement loss, current=living invariant), duplicate blocking, hybrid extract, read-only history/canvas, consumers unified. Fix findings.
- Push to `testing`. ⚠️ **Migration 15 is data-transforming + supervised — flag to Nathan before he pulls/runs on real data** (non-destructive: backfills sheetId, suffixes duplicate page numbers, copies measurements forward; nothing deleted; a DB backup is taken automatically before it applies).
- Write memory.

---

## Self-Review Notes (author)

- **Spec coverage:** #1 (Task 6 auto copy-forward + Task 1 model), #2 (Task 1 + Task 9 consumers), #3 (Task 2 + Task 7 block/suffix + Task 5 migration suffix), #4 (Task 3 + Task 4), #5 UI (Task 7 review + Task 8 grid/switcher/history/canvas/compare). Migration (Task 5). All covered.
- **Pure-logic-first:** Tasks 1-3 are pure + unit-tested (the crux), de-risking the UI/migration tasks that build on them.
- **Type consistency:** `effectiveSheetId`, `carryForwardFrom`, `reconcileExtract` ({value, confidence}), `findDuplicatePageNumbers`/`suffixPageNumber`, `computeRevisionModel` return shape preserved — names used consistently across tasks.
- **Migration is the high-risk task** (opus implementer, fixture tests, non-destructive, supervised) — isolated as Task 5 with its own test harness.
- **Canvas tasks run the Playwright suite** as the regression gate.
