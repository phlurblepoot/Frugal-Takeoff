# Phase 5b — Proposal Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Extract the Proposal feature out of the ProjectView monolith into (a) a reusable, framework-free PDF-generation module and (b) its own `/proposal` project section (generate / printout history / send), per spec §4.2.

**Architecture:** Behavior-preserving, in two movements. **First** move the PDF engine (`buildHighlightsPdf`, the jsPDF proposal builder, and the small helpers) into `src/pages/project/proposal/proposalGenerator.ts` as standalone functions taking explicit params — ProjectView keeps working by calling the module (zero UX change, app stays green). **Then** build `ProjectProposal.tsx`, a section that loads the full project and orchestrates the same generator (its own takeoff selection + options + printout history + send), wire the `/proposal` route + nav, and finally remove the now-redundant proposal UI from ProjectView.

**SAFETY INVARIANT:** the app must `tsc`-clean, `npm test`-green, and `npm run build`-succeed after EVERY task. The proposal PDF output must stay byte-equivalent through the extraction (Task 1 changes call sites, not logic). This is HIGH-risk code (PDF.js worker, pdf-lib dynamic import, interactive takeoff selection) — move logic verbatim; do not "improve" it.

**Tech Stack:** React 19 + react-router 7, jsPDF, pdf-lib (dynamic import), pdfjs-dist (worker configured at module scope), Vitest. Reuse `src/utils/math.ts` (now tested in 5a) and `src/utils/store.ts`.

**Pattern references:**
- Section page shell: `src/pages/project/ProjectIssues.tsx` / `ProjectPunch.tsx` (load data, `useParams`/`useProjectOutlet`) — but Proposal needs the FULL project (like ProjectView/CanvasView load it themselves via `getProject`).
- Printout/share handlers already exist in ProjectView: `handleViewPrintout`, `handleDownloadPrintout`, `handleSharePrintout`, `handleDeletePrintout`/`confirmDeletePrintout`, and the send handler calling `sendProjectProposal`.
- Nav/route wiring: how `issues`/`punch` were added (Sidebar PROJECT_NAV + App.tsx + ProjectLayout).

**Current coupling (from exploration; line numbers are approximate — LOCATE by name, the file shifted in 5a):**
- `buildHighlightsPdf(project, selectedTakeoffIds, quality, onProgress?, currentPageIds?)` — top-level async, closure-free, ~lines 56-407. Uses pdf-lib (dynamic import), pdfjs (`getFile`/`getImage`), math utils, local `dataUrlToUint8Array`/`hexToRgb`.
- `handleGenerateProposal(includeCostDetail, includeHighlights, headerColor, coverNotes, fontFamily, validUntil, terms, includeSignature, includeTakeoffList)` — component method ~1872-2403. Reads: `project`, `selectedTakeoffIds`, `proposalCustomTitle`, `getTakeoffTotals()`, `revisionModel.currentPageIds`, `proposalHeaderColor`, `highlightQuality`, `proposalIncludeCostDetail`, `proposalIncludeTakeoffList`, `settings` (from `getSettings()`). Calls jsPDF, `buildHighlightsPdf`, pdf-lib merge, `saveFile`, `saveProject`. Side effects: builds a `Printout`, appends to `project.printouts`, `saveProject`, `setActiveTab('printouts')`, clears `selectedTakeoffIds`.
- Local helpers to move: `dataUrlToUint8Array`, `hexToRgb`, `formatCurrency`, `HIGHLIGHT_QUALITY_PRESETS`, `HighlightQuality` type, `getProposalPrefsKey`.
- `Printout` type: `src/types.ts` `{ id, name, fileId, createdAt, type?: 'pdf'|'excel' }`.
- Send: `sendProjectProposal(projectId, fileId, message?) → Project` (store.ts). Reads `project.email` for reply-to; `project.proposalSentAt` shown post-send.
- Proposal config persistence: localStorage key `proposal-prefs-{userId}` + `getUserPreferences`/`saveUserPreferences` (booleans serialized 'true'/'false').

---

## File Structure

**Create:**
- `src/pages/project/proposal/proposalGenerator.ts` — `buildHighlightsPdf`, `generateProposalPdf(...)`, helpers, `HIGHLIGHT_QUALITY_PRESETS`, `HighlightQuality`, `getProposalPrefsKey`
- `src/pages/project/proposal/proposalGenerator.test.ts` — unit tests for the PURE helpers only
- `src/pages/project/ProjectProposal.tsx` — the `/proposal` section

**Modify:**
- `src/pages/ProjectView.tsx` — import from the module; thin `handleGenerateProposal` wrapper (Task 1); later REMOVE the proposal UI (Task 4)
- `src/App.tsx` — add `/proposal` route
- `src/components/shell/Sidebar.tsx` — add Proposal nav entry (position 3, between Takeoff and Documents)

---

## Task 1: Extract the proposal PDF engine into a module (behavior-preserving)

**Goal:** Move the PDF-building logic OUT of ProjectView into `proposalGenerator.ts` with NO behavior change. ProjectView's `handleGenerateProposal` becomes a thin orchestrator that gathers React state + settings and calls the module.

**Files:** Create `src/pages/project/proposal/proposalGenerator.ts`; modify `src/pages/ProjectView.tsx`.

- [ ] **Step 1: Read** the full current bodies of `buildHighlightsPdf`, `handleGenerateProposal`, and the helpers `dataUrlToUint8Array`/`hexToRgb`/`formatCurrency`/`HIGHLIGHT_QUALITY_PRESETS`/`HighlightQuality`/`getProposalPrefsKey` in `src/pages/ProjectView.tsx`. Note the exact imports each uses.

- [ ] **Step 2: Create `proposalGenerator.ts`** and MOVE (verbatim) into it:
  - The module-scope helpers: `dataUrlToUint8Array`, `hexToRgb`, `formatCurrency`, `HIGHLIGHT_QUALITY_PRESETS`, the `HighlightQuality` type, `getProposalPrefsKey`. Export each.
  - `buildHighlightsPdf` (verbatim — it's already closure-free). Export it.
  - A new `export async function generateProposalPdf(args)` containing the **exact PDF-building body** of `handleGenerateProposal`, but parameterized instead of reading React state. Signature:
    ```ts
    export interface ProposalOptions {
      includeCostDetail: boolean; includeHighlights: boolean;
      headerColor: string; coverNotes: string;
      fontFamily: 'helvetica' | 'times' | 'courier';
      validUntil: string; terms: string;
      includeSignature: boolean; includeTakeoffList: boolean;
      customTitle: string; highlightQuality: HighlightQuality;
    }
    export interface ProposalGenResult { pdfBytes: ArrayBuffer; suggestedName: string; }
    export async function generateProposalPdf(
      project: Project,
      takeoffTotals: Array<{ /* the exact shape getTakeoffTotals() returns: id, name, color, type, unit, totalRealValue, pricePackage, costPerUnit, isAdvancedCost, customCosts */ }>,
      selectedTakeoffIds: Set<string>,
      currentPageIds: Set<string>,
      options: ProposalOptions,
      settings: Record<string, string>,
      onProgress?: (msg: string) => void,
    ): Promise<ProposalGenResult>
    ```
    - Inside, reproduce the jsPDF construction EXACTLY (cover page, takeoff-summary, terms, page numbering, highlights merge via `buildHighlightsPdf` + pdf-lib). Replace each former state read with the corresponding parameter: `proposalCustomTitle`→`options.customTitle`, `proposalHeaderColor`→`options.headerColor`, `highlightQuality`→`options.highlightQuality`, `proposalIncludeCostDetail`→`options.includeCostDetail`, etc.; `getTakeoffTotals()`→the `takeoffTotals` param; `revisionModel.currentPageIds`→`currentPageIds`; `settings`→the `settings` param. Replace `setProgressMessage(...)` with `onProgress?.(...)`.
    - Return `{ pdfBytes, suggestedName }` (the final merged PDF as ArrayBuffer + the printout name string it currently builds). Do NOT call `saveFile`/`saveProject`/`setActiveTab` here — those stay in ProjectView (the caller owns persistence + side effects).
    - Add the imports the moved code needs (jspdf, pdf-lib is dynamic import inside, math utils, store `getFile`/`getImage` used by buildHighlightsPdf, types).
    - The pdfjs worker is configured at ProjectView module scope (line ~17). Move that worker-config line into `proposalGenerator.ts` module scope too (buildHighlightsPdf depends on it). If ProjectView still uses pdfjs elsewhere, KEEP the config line there as well (duplicate module-scope config is harmless/idempotent) — verify ProjectView still has whatever pdfjs setup it needs.

- [ ] **Step 3: Rewrite ProjectView's `handleGenerateProposal`** as a thin wrapper that:
  1. guards `project`, sets `isGeneratingProposal`, etc. (unchanged),
  2. `const settings = await getSettings();`
  3. builds `options` from the `proposal*` state + the function's args,
  4. calls `const { pdfBytes, suggestedName } = await generateProposalPdf(project, getTakeoffTotals(), selectedTakeoffIds, revisionModel.currentPageIds, options, settings, setProgressMessage);`
  5. converts `pdfBytes`→base64 (the existing FileReader logic), `saveFile(fileId, base64)`, builds the `Printout`, appends to `project.printouts`, `saveProject`, `setActiveTab('printouts')`, clears selection, toasts on error — EXACTLY as before.
  - Remove the now-moved helper definitions + `buildHighlightsPdf` from ProjectView; import them from the module instead. Remove any imports that became unused (tsc will flag).

- [ ] **Step 4: Verify behavior preserved** — `npx tsc --noEmit` clean; `npm test` green; `npm run build` succeeds. The proposal flow in ProjectView is unchanged from the user's POV; this is a pure move. (No new unit test required in this task — Task 2 adds tests for the pure helpers.)

- [ ] **Step 5: Commit**

```bash
git add src/pages/project/proposal/proposalGenerator.ts src/pages/ProjectView.tsx
git commit -m "refactor: extract proposal PDF engine into proposalGenerator module"
```

---

## Task 2: Lock-in tests for the pure proposal helpers

**Files:** Create `src/pages/project/proposal/proposalGenerator.test.ts`.

Only the PURE, deterministic helpers are unit-tested (jsPDF/pdf-lib output is binary and not asserted here).

- [ ] **Step 1: Write tests** (characterization — derive expected from real output):
  - `hexToRgb('#1e293b')` → its real `{r,g,b}`; `hexToRgb('#ffffff')` → `{r:255,g:255,b:255}`; a 3-digit or invalid hex → whatever the function currently returns (capture it).
  - `formatCurrency(1234.5)` → its real string (e.g. `'$1,234.50'`); `formatCurrency(0)`; a negative.
  - `dataUrlToUint8Array('data:application/pdf;base64,QUJD')` → `Uint8Array` of `[65,66,67]` ('ABC').
  - `HIGHLIGHT_QUALITY_PRESETS` has keys `full|large|standard|compact` each with `label`,`maxDim`,`jpegQuality`.
  - `getProposalPrefsKey()` → `proposal-prefs-default` when localStorage has no `user` (jsdom); set `localStorage.setItem('user', JSON.stringify({id:'u1'}))` → `proposal-prefs-u1`.

- [ ] **Step 2: Run** `npx vitest run src/pages/project/proposal/proposalGenerator.test.ts` → green (reconcile expecteds to real output).

- [ ] **Step 3: Commit**

```bash
git add src/pages/project/proposal/proposalGenerator.test.ts
git commit -m "test: lock in proposal generator pure helpers"
```

---

## Task 3: ProjectProposal section + route + nav

**Files:** Create `src/pages/project/ProjectProposal.tsx`; modify `src/App.tsx`, `src/components/shell/Sidebar.tsx`.

This section is a NEW home for proposal generation, printout history, and send — reusing `generateProposalPdf`. It loads the full project itself (like ProjectView does).

- [ ] **Step 1: Build `ProjectProposal.tsx`:**
  - `useParams` projectId; load full project via `getProject(projectId)` into state; `reload()` to re-fetch. Loading skeleton; not-found guard.
  - Compute `revisionModel`/`currentPageIds` the same way ProjectView does (import `computeRevisionModel` from `src/utils/planSets`; read the exact call ProjectView makes and replicate it). If that proves heavy, default `currentPageIds` to "all page ids" and note it.
  - **Takeoff selection:** list `project.takeoffs` with checkboxes (default ALL checked) → a local `selectedTakeoffIds: Set<string>`. (Replaces ProjectView's interactive multi-select.)
  - **Options form:** reproduce the proposal config controls (customTitle, headerColor, fontFamily, validUntil, coverNotes, terms, includeCostDetail, includeHighlights, includeSignature, includeTakeoffList, highlightQuality) bound to local state, seeded from `getProposalPrefsKey()` localStorage + `getUserPreferences()` and saved back on change — port the persistence logic from ProjectView (move `getProposalPrefsKey` is already in the module). Use the app's ui components (Field/Input/Button/Card) where reasonable; an exact visual match to the old modal is not required, but all options must be present.
  - **Generate button:** `const settings = await getSettings(); const totals = getTakeoffTotals(project, currentPageIds)` — you'll need a standalone totals helper. If `getTakeoffTotals` is a component method in ProjectView, extract its pure core into the proposal module (`computeTakeoffTotals(project, currentPageIds)`) in this task and have BOTH ProjectView and the section call it (dedupe). Then `generateProposalPdf(...)` → base64 → `saveFile` → append `Printout` → `saveProject` → `reload()`. Show progress + errors via toast.
  - **Printout history:** grid of `project.printouts` (sorted desc) with View (`/tools/pdf?fileId=` or `/tools/sheets?fileId=`), Download (`getFile` → blob), Share (`createShare('printout', fileId, name)`), Delete (`saveProject` w/ filtered list + `deleteFile`). Port these handlers from ProjectView.
  - **Send:** if `project.email`, a send control selecting a PDF printout + optional message → `sendProjectProposal(project.id, fileId, message)` → `reload()`. Show `proposalSentAt` if present.
  - Mobile-friendly enough; this is desktop-primary.

- [ ] **Step 2: Route** — `src/App.tsx`: add `{ path: 'proposal', element: <ProjectProposal /> }` under `project/:projectId` (place it right after `takeoff`). Import `ProjectProposal` (match the named/default style of sibling imports).

- [ ] **Step 3: Nav** — `src/components/shell/Sidebar.tsx` PROJECT_NAV: insert a Proposal entry between Takeoff & Estimate and Documents (spec §4.2 order), NOT adminOnly. Use a fitting lucide icon (e.g. `FileText`). Match sibling entry shape + `match` predicate (`endsWith('/proposal')` or the file's style).

- [ ] **Step 4: Verify** — `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run build` all green. The new section coexists with ProjectView's proposal UI for now (removed in Task 4).

- [ ] **Step 5: Commit**

```bash
git add src/pages/project/ProjectProposal.tsx src/App.tsx src/components/shell/Sidebar.tsx src/pages/project/proposal/proposalGenerator.ts src/pages/ProjectView.tsx
git commit -m "feat: Proposal project section (generate, history, send) + route + nav"
```

---

## Task 4: Remove proposal UI from ProjectView

Now that `/proposal` owns proposal generation/history/send, strip it from ProjectView so there's one home.

**Files:** `src/pages/ProjectView.tsx`.

- [ ] **Step 1: Remove** from ProjectView: the Proposal-generation modal (`showProposalModal` JSX), the Send-Proposal modal, the **Printouts tab** (and its entry in `PROJECT_TAB_VALUES` / the tab bar), and the now-unused proposal/printout/send state + handlers (`handleGenerateProposal` wrapper, `handleView/Download/Share/DeletePrintout`, `confirmDeletePrintout`, the `proposal*`/`sendProposal*`/`printoutToDelete` state, the proposal-prefs persistence useEffects). Keep `selectedTakeoffIds` ONLY if still used by the takeoff tab for other purposes; otherwise remove it too.
  - Keep `computeTakeoffTotals` usage if the takeoff tab still shows totals — only proposal-specific code goes.
  - The `proposalGenerator` import in ProjectView should now be removable (the section owns generation). Remove it.
  - If a "Generate Proposal" button lived on the takeoff tab, replace it with a small link/note pointing to the Proposal section (e.g. a button that navigates to `../proposal`), so the workflow is discoverable.

- [ ] **Step 2: Verify** — `npx tsc --noEmit` clean (this surfaces every now-dead reference); `npm run lint`; `npm test`; `npm run build`. Grep `grep -n "showProposalModal\|handleGenerateProposal\|sendProposal\|printoutToDelete" src/pages/ProjectView.tsx` → expect nothing (or only an unavoidable remnant you can justify).

- [ ] **Step 3: Commit**

```bash
git add src/pages/ProjectView.tsx
git commit -m "refactor: remove proposal UI from ProjectView (now the Proposal section)"
```

---

## Task 5: Full verification + push

- [ ] **Step 1: Full gate** — `npm run lint && npm test && npm run build` green.

- [ ] **Step 2: Live smoke** (boot temp dir, login admin/admin): create a project with a takeoff + a page; via API/UI confirm a proposal can be generated (the printout appears in `project.printouts`), downloaded, and (if SMTP unconfigured, at least) the send endpoint is reachable. Since proposal generation is browser-side (jsPDF), the key automated checks are tsc/test/build; note that the visual proposal must be smoke-tested in the browser by Nathan.

- [ ] **Step 3: Final review** — dispatch an opus code-review over the 5b commit range. Focus: (1) Task 1 is behavior-preserving — the moved PDF code is verbatim, only state-reads became params; no logic/number changes; (2) no double-generation or broken pdfjs worker; (3) the section reuses the SAME generator (no forked copy); (4) `computeTakeoffTotals` deduped (one impl, both callers); (5) printout/send handlers behave identically; (6) ProjectView has no dangling proposal refs; (7) nav/route correct, not admin-gated. Fix Critical/Important, re-review.

- [ ] **Step 4: Push**

```bash
git push origin testing
```

- [ ] **Step 5: Memory** — record 5b shipped: Proposal extracted to `proposalGenerator.ts` + `/proposal` section; ProjectView shrunk by ~700+ LOC; behavior preserved; next 5c (Project Settings). Note the manual proposal-PDF smoke is pending with Nathan (jsPDF output not automatically asserted).

---

## Self-Review Notes (author)

- **Risk control:** Task 1 is a pure move (state-reads → params); the app keeps working because ProjectView still drives generation through the module. The section (Task 3) is additive and coexists before ProjectView's copy is removed (Task 4), so there's always a working proposal path. The build/test gate runs after every task.
- **Dedupe:** `computeTakeoffTotals` and `getProposalPrefsKey` become single shared impls used by both ProjectView (until Task 4) and the section — no forked logic.
- **Untestable surface:** jsPDF/pdf-lib binary output isn't asserted; only pure helpers are unit-tested. The proposal visual is on Nathan's manual smoke list (consistent with spec §8 — canvas/PDF workflows are the weakest automated coverage).
- **Deferred:** the takeoff-selection UX in the section is a simple checklist (all-selected default), not a port of ProjectView's interactive canvas selection — acceptable for v1; note it.
