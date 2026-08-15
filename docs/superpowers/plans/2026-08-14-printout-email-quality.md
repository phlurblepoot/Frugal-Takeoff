# Printout Transport Fix + Email-Ready Quality — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Printout saves stop failing/hanging on large plan sets (stream raw bytes instead of base64 JSON), and a new "Email-ready" quality option shrinks printouts/proposals to ≤18MB.

**Architecture:** Vector printouts are generated exactly as today. Saves switch from `saveFile` (base64-in-JSON, 50MB server cap) to the existing `saveBinaryFile` streaming path (100MB cap). A new `shrinkPdfToBudget` post-processor re-renders the *generated* PDF's pages to JPEGs via pdf.js only when the file exceeds the budget. The 4 dead quality presets become 2 (`best` | `email`).

**Tech Stack:** React + TS (Vite), pdf-lib 1.17.1, pdfjs-dist (legacy build, worker via `?url` import), vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-14-printout-email-quality-design.md` — read it first.

## Global Constraints

- Branch: `testing` (commit here; do NOT create PRs or push to other branches).
- Email target: 18 * 1024 * 1024 bytes (`EMAIL_TARGET_BYTES`); over-budget results are SAVED anyway + warned, never rejected.
- Never lower quality below floors: JPEG quality 0.45, long side 1000px.
- Run `npx vitest run` (714 tests must stay green) before each commit; run `npx tsc --noEmit` too.
- Never modify `data/` or any live data. Test with scratch/e2e data only.
- Comments: match existing density/idiom — explain *why*, not *what changed*.

---

### Task 1: `shrinkPdf` module (pure budget math + browser render loop)

**Files:**
- Create: `src/pages/project/proposal/shrinkPdf.ts`
- Create: `src/pages/project/proposal/shrinkPdf.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces (Task 4 relies on these exact names):
  - `EMAIL_TARGET_BYTES: number`
  - `shrinkPdfToBudget(pdfBytes: ArrayBuffer, budgetBytes: number, onProgress?: (msg: string) => void): Promise<ShrinkResult>`
  - `interface ShrinkResult { bytes: ArrayBuffer; overBudget: boolean }`
  - Pure helpers (unit-tested, used internally): `usableBudget`, `pageBudget`, `attemptSequence`, `dataUrlBytes`.

- [ ] **Step 1: Write the failing tests** — `src/pages/project/proposal/shrinkPdf.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  EMAIL_TARGET_BYTES,
  usableBudget,
  pageBudget,
  attemptSequence,
  dataUrlBytes,
  JPEG_QUALITY_LADDER,
  START_LONG_SIDE,
  MIN_LONG_SIDE,
} from './shrinkPdf';

describe('email target', () => {
  it('is 18MB', () => {
    expect(EMAIL_TARGET_BYTES).toBe(18 * 1024 * 1024);
  });
});

describe('usableBudget', () => {
  it('reserves 3% + fixed overhead for PDF structure', () => {
    const b = usableBudget(18 * 1024 * 1024);
    expect(b).toBeLessThan(18 * 1024 * 1024 * 0.97);
    expect(b).toBeGreaterThan(17 * 1024 * 1024 * 0.97 - 128 * 1024);
  });
  it('never goes negative on tiny budgets', () => {
    expect(usableBudget(1000)).toBe(0);
  });
});

describe('pageBudget (running-remainder rollover)', () => {
  it('splits the remaining budget across the remaining pages', () => {
    expect(pageBudget(1000, 4)).toBe(250);
  });
  it('rolls surplus from cheap pages into later pages', () => {
    // 1000 across 4 pages → 250 each; first page only used 100,
    // so the remaining 900 across 3 pages → 300 each.
    expect(pageBudget(1000 - 100, 3)).toBe(300);
  });
  it('clamps to 0 when earlier pages overshot the whole budget', () => {
    expect(pageBudget(-500, 2)).toBe(0);
  });
});

describe('attemptSequence', () => {
  it('walks the full quality ladder at each scale before shrinking the scale', () => {
    const steps = attemptSequence();
    expect(steps.slice(0, JPEG_QUALITY_LADDER.length).map(s => s.quality))
      .toEqual([...JPEG_QUALITY_LADDER]);
    expect(new Set(steps.slice(0, JPEG_QUALITY_LADDER.length).map(s => s.longSide)).size).toBe(1);
    expect(steps[0].longSide).toBe(START_LONG_SIDE);
  });
  it('shrinks the long side by 0.8× per round and terminates at the floor', () => {
    const steps = attemptSequence();
    const scales = [...new Set(steps.map(s => s.longSide))];
    expect(scales[1]).toBe(Math.round(START_LONG_SIDE * 0.8));
    expect(scales[scales.length - 1]).toBe(MIN_LONG_SIDE);
    // Finite: floors terminate the walk.
    expect(steps.length).toBeLessThan(50);
  });
  it('never emits a long side below the floor', () => {
    for (const s of attemptSequence()) expect(s.longSide).toBeGreaterThanOrEqual(MIN_LONG_SIDE);
  });
});

describe('dataUrlBytes', () => {
  it('reports the decoded byte size of a base64 data URL', () => {
    // "hello" → 5 bytes → base64 "aGVsbG8="
    expect(dataUrlBytes('data:image/jpeg;base64,aGVsbG8=')).toBe(5);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/pages/project/proposal/shrinkPdf.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/pages/project/proposal/shrinkPdf.ts`:

```ts
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
// @ts-ignore
import pdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

// Email providers cap messages around 25MB *after* base64 encoding (~35%
// inflation), so 18MB of file reliably clears Gmail/Outlook with headroom.
export const EMAIL_TARGET_BYTES = 18 * 1024 * 1024;

export const JPEG_QUALITY_LADDER = [0.75, 0.65, 0.55, 0.45] as const;
export const START_LONG_SIDE = 2200;
export const MIN_LONG_SIDE = 1000;
const SCALE_STEP = 0.8;
const FIXED_OVERHEAD_BYTES = 64 * 1024;

export interface ShrinkResult {
  bytes: ArrayBuffer;
  /** true → floors were hit and the result still exceeds the budget; caller warns. */
  overBudget: boolean;
}

export interface LadderStep { longSide: number; quality: number }

/** Budget available for page images once pdf-lib structure overhead is reserved. */
export function usableBudget(budgetBytes: number): number {
  return Math.max(0, budgetBytes * 0.97 - FIXED_OVERHEAD_BYTES);
}

/** Even split of what's left over the pages still to encode — pages that come
 *  in under their share automatically roll their surplus forward. */
export function pageBudget(remainingBudget: number, remainingPages: number): number {
  return Math.max(0, remainingBudget) / Math.max(1, remainingPages);
}

/** All (longSide, quality) attempts for one page, best first: the full quality
 *  ladder at each scale, scales shrinking 0.8× per round down to the floor. */
export function attemptSequence(startLongSide: number = START_LONG_SIDE): LadderStep[] {
  const steps: LadderStep[] = [];
  let ls = Math.max(startLongSide, MIN_LONG_SIDE);
  for (;;) {
    for (const quality of JPEG_QUALITY_LADDER) steps.push({ longSide: ls, quality });
    if (ls === MIN_LONG_SIDE) break;
    ls = Math.max(Math.round(ls * SCALE_STEP), MIN_LONG_SIDE);
  }
  return steps;
}

/** Decoded byte size of a base64 data URL (without materializing the bytes). */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  const b64 = dataUrl.slice(comma + 1);
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

// Shrinks an already-generated PDF under a byte budget by re-rendering each
// page to a JPEG (overlays are already burned into the page content, so no
// measurement math is involved). Under-budget inputs pass through untouched —
// email mode on a small job keeps full vector quality.
export async function shrinkPdfToBudget(
  pdfBytes: ArrayBuffer,
  budgetBytes: number,
  onProgress?: (msg: string) => void,
): Promise<ShrinkResult> {
  if (pdfBytes.byteLength <= budgetBytes) {
    return { bytes: pdfBytes, overBudget: false };
  }

  const { PDFDocument } = await import('pdf-lib');
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(pdfBytes.slice(0)) });
  const srcPdf = await loadingTask.promise;
  const outDoc = await PDFDocument.create();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not create canvas context for PDF compression');

  try {
    const pageCount = srcPdf.numPages;
    let remaining = usableBudget(budgetBytes);

    for (let i = 1; i <= pageCount; i++) {
      onProgress?.(`Compressing page ${i} of ${pageCount}…`);
      const page = await srcPdf.getPage(i);
      const vp1 = page.getViewport({ scale: 1 }); // PDF points
      const maxDim = Math.max(vp1.width, vp1.height);
      const budget = pageBudget(remaining, pageCount - i + 1);

      let best: { dataUrl: string; bytes: number } | null = null;
      let renderedLongSide = 0;
      for (const step of attemptSequence()) {
        // Cap at 2× — matches the app's standard raster space; upscaling a
        // small (e.g. letter-size) page past that only inflates bytes.
        const scale = Math.min(2, step.longSide / maxDim);
        if (Math.round(vp1.width * scale) !== canvas.width || step.longSide !== renderedLongSide) {
          const vp = page.getViewport({ scale });
          canvas.width = Math.round(vp.width);
          canvas.height = Math.round(vp.height);
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' } as any).promise;
          renderedLongSide = step.longSide;
        }
        const dataUrl = canvas.toDataURL('image/jpeg', step.quality);
        const bytes = dataUrlBytes(dataUrl);
        best = { dataUrl, bytes }; // keep the last attempt — it's the smallest so far
        if (bytes <= budget) break;
      }

      const jpg = await outDoc.embedJpg(best!.dataUrl);
      // Page keeps its original physical size in points so prints stay to scale.
      const outPage = outDoc.addPage([vp1.width, vp1.height]);
      outPage.drawImage(jpg, { x: 0, y: 0, width: vp1.width, height: vp1.height });
      remaining -= best!.bytes;
      page.cleanup();
    }
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    try { await srcPdf.destroy(); } catch { /* ignore */ }
  }

  const out = await outDoc.save();
  const bytes = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
  return { bytes, overBudget: bytes.byteLength > budgetBytes };
}
```

Note: the vitest environment has no canvas — that is fine; the tests only import the pure helpers. Keep them and `shrinkPdfToBudget` in one module (they are one unit; the render loop is the only DOM-touching part).

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/pages/project/proposal/shrinkPdf.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Full check + commit**

Run: `npx vitest run && npx tsc --noEmit`
```bash
git add src/pages/project/proposal/shrinkPdf.ts src/pages/project/proposal/shrinkPdf.test.ts
git commit -m "feat(printout): shrinkPdfToBudget — budget-driven PDF page recompression"
```

---

### Task 2: Transport fix — stream printout saves, fix the eternal spinner

**Files:**
- Modify: `src/utils/store.ts` (~line 214, `saveBinaryFile`)
- Modify: `src/pages/ProjectView.tsx` (~lines 1105–1162, `handlePrint`)
- Modify: `src/pages/project/ProjectProposal.tsx` (generate save ~284–302, send-path save ~725–734, `handleDownload` ~320)

**Interfaces:**
- Consumes: existing `saveBinaryFile`, `getImageUrl` from `src/utils/store.ts`.
- Produces: `saveBinaryFile(id: string, blob: Blob, opts?: { projectId?: string; kind?: string; name?: string })` — Task 4 and the e2e task rely on printouts being saved through this path.

**Background (read the spec):** `saveFile` posts base64-in-JSON to `/api/images` and dies at the server's 50MB JSON cap for big printouts (413). In `handlePrint` the failure happens inside a `FileReader.onloadend` callback *outside* the try/catch → eternal spinner. `saveBinaryFile` already streams raw bytes to `POST /api/files/:id` (100MB cap) and takes a Blob directly — no FileReader needed.

- [ ] **Step 1: Extend `saveBinaryFile` with optional labeling query params** (`putBuffer` on the server already accepts `?projectId=&kind=&name=`; see `server/routes.ts:650-678`):

```ts
export const saveBinaryFile = async (
  id: string,
  blob: Blob,
  opts?: { projectId?: string; kind?: string; name?: string },
): Promise<void> => {
  const headers: Record<string, string> = {
    'Content-Type': blob.type || 'application/octet-stream',
    ...getAuthHeaders(),
  };
  const q = new URLSearchParams();
  if (opts?.projectId) q.set('projectId', opts.projectId);
  if (opts?.kind) q.set('kind', opts.kind);
  if (opts?.name) q.set('name', opts.name);
  const qs = q.toString();
  const res = await fetchWithRetry(`/api/files/${encodeURIComponent(id)}${qs ? `?${qs}` : ''}`, {
    method: 'POST',
    headers,
    body: blob,
  }, { timeoutMs: 300_000 });
  await handleResponse(res);
};
```

Existing callers (`NewProject.tsx:233,452`, `ProjectView.tsx:707,932`) pass no opts — unchanged.

- [ ] **Step 2: Rewrite `handlePrint` in ProjectView** — Read the current function first (lines ~1105–1162). Replace the whole body after `buildHighlightsPdf` so nothing runs in a `FileReader` callback:

```ts
  const handlePrint = async () => {
    if (!project || selectedTakeoffIds.size === 0) return;
    setIsPrinting(true);
    setProgressMessage('Preparing pages…');

    try {
      const pdfBuffer = await buildHighlightsPdf(
        project,
        selectedTakeoffIds,
        highlightQuality,
        (msg) => setProgressMessage(msg),
        revisionModel.currentPageIds,
      );

      if (!pdfBuffer) {
        toast('No pages found with the selected takeoffs.', { type: 'warning' });
        return;
      }

      setProgressMessage('Saving…');
      const name = `Printout - ${new Date().toLocaleString()}`;
      const fileId = uuidv4();
      // Raw streaming save — base64-in-JSON dies at the server's JSON body cap
      // for big plan-set printouts, and silently at that (413).
      await saveBinaryFile(fileId, new Blob([pdfBuffer], { type: 'application/pdf' }), {
        projectId: project.id, kind: 'printout', name,
      });

      const newPrintout: Printout = {
        id: uuidv4(),
        name,
        fileId,
        createdAt: Date.now(),
        type: 'pdf',
      };

      const updatedProject = {
        ...project,
        printouts: [...(project.printouts || []), newPrintout],
      };

      await saveProject(updatedProject);
      setProject(updatedProject);
      setSelectedTakeoffIds(new Set());
      // Printout history now lives in the Proposal section.
      navigate(`/project/${projectId}/proposal`);
    } catch (error) {
      console.error('Error generating PDF:', error);
      toast('Failed to generate PDF.', { type: 'error' });
    } finally {
      setIsPrinting(false);
      setProgressMessage('');
    }
  };
```

Keep passing `highlightQuality` to `buildHighlightsPdf` for now — Task 4 removes that parameter.

- [ ] **Step 3: Switch both ProjectProposal saves.** In `handleGenerate` (~lines 284–302) replace the FileReader + `saveFile` block:

```ts
      setProgress('Saving…');
      const fileId = uuidv4();
      await saveBinaryFile(fileId, new Blob([pdfBytes], { type: 'application/pdf' }), {
        projectId: project.id, kind: 'printout', name: suggestedName,
      });
```

(Concretely: delete the `const pdfBlob = …` + `const base64data …` + `await saveFile(…)` lines and save the Blob directly — the `newPrintout` / `saveProject` code below stays.) Do the same in the `onSend` regenerate path (~lines 725–734):

```ts
              const tempFileId = uuidv4();
              await saveBinaryFile(tempFileId, new Blob([pdfBytes], { type: 'application/pdf' }), {
                projectId: project.id, kind: 'printout', name: 'Proposal (header email override)',
              });
              fileIdToSend = tempFileId;
```

Update the imports in `ProjectProposal.tsx`: add `saveBinaryFile`, `getImageUrl`; remove `saveFile` if now unused in the file.

- [ ] **Step 4: Stream `handleDownload`.** Replace the `getFile` (giant JSON envelope) download with the raw streaming URL. Keep the Excel-vs-PDF logic but key it off `printout.type`/name only (a blob has no data-url prefix to sniff):

```ts
  const handleDownload = async (printout: Printout) => {
    const res = await fetch(getImageUrl(printout.fileId));
    if (!res.ok) { toast('Failed to download file.', { type: 'error' }); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const isExcel = printout.type === 'excel' || printout.name.toLowerCase().endsWith('.xlsx');
    const extension = isExcel ? '.xlsx' : '.pdf';
    link.download = printout.name.endsWith(extension) ? printout.name : `${printout.name}${extension}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };
```

Mirror whatever cleanup lines the current implementation has after `click()` — Read it before replacing.

- [ ] **Step 5: Verify + commit**

Run: `npx vitest run && npx tsc --noEmit`
Run: `npx playwright test e2e/export.spec.ts` (needs the Chromium libs; if the environment lacks them, note it and let the final task run it)
Expected: suites green; export spec records a printout.

```bash
git add src/utils/store.ts src/pages/ProjectView.tsx src/pages/project/ProjectProposal.tsx
git commit -m "fix(printout): stream printout saves past the 50MB JSON cap; no more silent eternal spinner"
```

---

### Task 3: Quality presets → `best` | `email` + legacy normalization

**Files:**
- Modify: `src/pages/project/proposal/proposalGenerator.ts` (~lines 398–405, `HIGHLIGHT_QUALITY_PRESETS`)
- Modify: `src/pages/ProjectView.tsx` (~line 126 default state, ~line 158 pref read)
- Modify: `src/pages/project/ProjectProposal.tsx` (~line 72 default state, ~lines 153, 166 pref reads)
- Test: `src/pages/project/proposal/proposalGenerator.highlights.test.ts` (append)

**Interfaces:**
- Produces: `HIGHLIGHT_QUALITY_PRESETS = { best, email }` (each `{ label: string }`), `type HighlightQuality = 'best' | 'email'`, `normalizeHighlightQuality(value: unknown): HighlightQuality`. Task 4 gates the shrink on `quality === 'email'`.
- The dropdowns in `ProjectProposal.tsx` (~line 524) and `ProjectTakeoffsTab.tsx` (~line 91) iterate `Object.entries(HIGHLIGHT_QUALITY_PRESETS)` generically — they need **no** change; verify the `ProjectTakeoffsTab` entries cast still typechecks (`[HighlightQuality, { label: string }][]`).

- [ ] **Step 1: Write failing tests** — append to `proposalGenerator.highlights.test.ts`:

```ts
import { HIGHLIGHT_QUALITY_PRESETS, normalizeHighlightQuality } from './proposalGenerator';

describe('highlight quality presets', () => {
  it('offers exactly best + email', () => {
    expect(Object.keys(HIGHLIGHT_QUALITY_PRESETS)).toEqual(['best', 'email']);
  });

  it('normalizes legacy stored preset values to best', () => {
    for (const legacy of ['full', 'large', 'standard', 'compact', '', undefined, null, 42]) {
      expect(normalizeHighlightQuality(legacy)).toBe('best');
    }
  });

  it('keeps valid values', () => {
    expect(normalizeHighlightQuality('email')).toBe('email');
    expect(normalizeHighlightQuality('best')).toBe('best');
  });
});
```

(Match the test file's existing import style — extend an existing import line rather than duplicating it if one already pulls from `./proposalGenerator`.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/pages/project/proposal/proposalGenerator.highlights.test.ts`
Expected: FAIL — `normalizeHighlightQuality` not exported; preset keys differ.

- [ ] **Step 3: Implement.** Replace the presets block in `proposalGenerator.ts`:

```ts
// ── Highlight quality presets ────────────────────────────────────────────────
// 'best' keeps the copied vector pages untouched. 'email' post-shrinks the
// result to EMAIL_TARGET_BYTES (see shrinkPdf.ts) so it survives provider
// attachment limits. The old Full/Large/Standard/Compact raster presets died
// with the raster pipeline — stored prefs holding them normalize to 'best'.
export const HIGHLIGHT_QUALITY_PRESETS = {
  best:  { label: 'Best quality (vector)' },
  email: { label: 'Email-ready (under 25MB sent)' },
} as const;
export type HighlightQuality = keyof typeof HIGHLIGHT_QUALITY_PRESETS;

export function normalizeHighlightQuality(value: unknown): HighlightQuality {
  return value === 'email' || value === 'best' ? value : 'best';
}
```

Then update the readers/defaults:
- `ProjectView.tsx:126` → `useState<HighlightQuality>('best')`
- `ProjectView.tsx:158` → `if (prefs['proposal-highlightQuality']) setHighlightQuality(normalizeHighlightQuality(prefs['proposal-highlightQuality']));`
- `ProjectProposal.tsx:72` → `useState<HighlightQuality>('best')`
- `ProjectProposal.tsx:153` → `if (p.highlightQuality) setHighlightQuality(normalizeHighlightQuality(p.highlightQuality));`
- `ProjectProposal.tsx:166` → same normalization for `prefs['proposal-highlightQuality']`.
- Add `normalizeHighlightQuality` to each file's existing `proposalGenerator` import. Drop any now-unused `as HighlightQuality` casts on those lines.

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS. Typecheck confirms no other code references `.maxDim` / `.jpegQuality` (grep to be sure: `grep -rn "maxDim\|jpegQuality" src/`).

- [ ] **Step 5: Commit**

```bash
git add src/pages/project/proposal/proposalGenerator.ts src/pages/project/proposal/proposalGenerator.highlights.test.ts src/pages/ProjectView.tsx src/pages/project/ProjectProposal.tsx
git commit -m "feat(printout): quality menu becomes best|email; legacy preset values normalize to best"
```

---

### Task 4: Wire email mode into printout + proposal generation

**Files:**
- Modify: `src/pages/project/proposal/proposalGenerator.ts` (`buildHighlightsPdf` signature ~line 52, its internal caller ~line 1034, `generateProposalPdf` save section ~lines 1028–1066, `ProposalGenResult` ~line 554)
- Modify: `src/pages/ProjectView.tsx` (`handlePrint` — as rewritten by Task 2)
- Modify: `src/pages/project/ProjectProposal.tsx` (`handleGenerate` result handling)

**Interfaces:**
- Consumes: `shrinkPdfToBudget`, `EMAIL_TARGET_BYTES`, `ShrinkResult` from `./shrinkPdf` (Task 1); `HighlightQuality` = `'best' | 'email'` (Task 3); Task 2's `handlePrint` shape.
- Produces: `buildHighlightsPdf(project, selectedTakeoffIds, onProgress?, currentPageIds?)` (quality param GONE); `ProposalGenResult { pdfBytes; suggestedName; overBudget?: boolean }`.

- [ ] **Step 1: Remove the dead `_quality` parameter.** `buildHighlightsPdf` signature becomes:

```ts
export async function buildHighlightsPdf(
  project: Project,
  selectedTakeoffIds: Set<string>,
  onProgress?: (msg: string) => void,
  currentPageIds?: Set<string>,
): Promise<ArrayBuffer | null> {
```

Update both call sites: `proposalGenerator.ts:~1034` (drop `highlightQuality` arg) and `ProjectView.tsx` `handlePrint` (drop `highlightQuality` arg). Remove the now-unused `HighlightQuality` import in files that no longer need it (ProjectView still needs it for state typing).

- [ ] **Step 2: Shrink in `generateProposalPdf`.** In the save section (after the merge, before `return`), gate on the option:

```ts
  let overBudget = false;
  if (highlightQuality === 'email') {
    const shrunk = await shrinkPdfToBudget(pdfBytes, EMAIL_TARGET_BYTES, onProgress);
    pdfBytes = shrunk.bytes;
    overBudget = shrunk.overBudget;
  }
```

(`pdfBytes` is currently `let`-compatible? It is declared `let pdfBytes: ArrayBuffer;` at ~line 1029 — reuse it.) Extend the result type and return:

```ts
export interface ProposalGenResult { pdfBytes: ArrayBuffer; suggestedName: string; overBudget?: boolean }
// …
  return { pdfBytes, suggestedName, overBudget };
```

Import at top of `proposalGenerator.ts`: `import { shrinkPdfToBudget, EMAIL_TARGET_BYTES } from './shrinkPdf';`

- [ ] **Step 3: Shrink in `handlePrint`** (ProjectView). After the `if (!pdfBuffer)` guard:

```ts
      let outBuffer: ArrayBuffer = pdfBuffer;
      if (highlightQuality === 'email') {
        const shrunk = await shrinkPdfToBudget(pdfBuffer, EMAIL_TARGET_BYTES, (msg) => setProgressMessage(msg));
        outBuffer = shrunk.bytes;
        if (shrunk.overBudget) {
          toast(`Printout is ${(outBuffer.byteLength / 1048576).toFixed(1)}MB — above the 18MB email target; some providers may reject it.`, { type: 'warning' });
        }
      }
```

…and save `outBuffer` (not `pdfBuffer`) in the Blob. Import `shrinkPdfToBudget`, `EMAIL_TARGET_BYTES` from `./project/proposal/shrinkPdf`.

- [ ] **Step 4: Surface the proposal warning.** In `ProjectProposal.handleGenerate`, destructure and toast after saving succeeds:

```ts
      const { pdfBytes, suggestedName, overBudget } = await generateProposalPdf(/* …unchanged args… */);
      // … save (Task 2 shape) …
      if (overBudget) {
        toast(`Proposal is ${(pdfBytes.byteLength / 1048576).toFixed(1)}MB — above the 18MB email target; some providers may reject it.`, { type: 'warning' });
      }
      toast('Proposal generated', { type: 'success' });
```

- [ ] **Step 5: Verify + commit**

Run: `npx vitest run && npx tsc --noEmit`
Expected: green.

```bash
git add src/pages/project/proposal/proposalGenerator.ts src/pages/ProjectView.tsx src/pages/project/ProjectProposal.tsx
git commit -m "feat(printout): email-ready quality — post-shrink printouts/proposals to the 18MB email target"
```

---

### Task 5: E2E coverage + full verification

**Files:**
- Modify: `e2e/export.spec.ts` (add an email-mode print test)
- Create: `e2e/printout-email-large.spec.ts` (gated big-PDF proof)

**Interfaces:**
- Consumes: `seedProjectWithTakeoffMeasurement` from `e2e/fixtures/seed.ts`; the print-modal quality `<select>` (in `ProjectTakeoffsTab`, near the Print button — find it by its accessible label/`id`; add `data-testid="print-quality-select"` to it if it has no stable hook, in `src/pages/project/ProjectTakeoffsTab.tsx` ~line 86).

- [ ] **Step 1: Email-mode print test** (append to `export.spec.ts`, reusing its helpers `gotoTakeoffsTab` / `selectFirstTakeoff`):

```ts
test('Print with Email-ready quality records a printout (pass-through path)', async ({
  authedPage, apiToken, request,
}) => {
  const { token } = apiToken;
  const { projectId } = await seedProjectWithTakeoffMeasurement(request, token);
  await gotoTakeoffsTab(authedPage, projectId);
  await selectFirstTakeoff(authedPage);
  await authedPage.getByTestId('print-quality-select').selectOption('email');
  await authedPage.getByTestId('btn-print').click();
  // Small seeded page → result is far under 18MB → pass-through; printout recorded.
  await expect(authedPage).toHaveURL(new RegExp(`/project/${projectId}/proposal`), { timeout: 30_000 });
  await expect(authedPage.getByText(/^Printout - /).first()).toBeVisible({ timeout: 15_000 });
});
```

Check `export.spec.ts`'s existing print test for the real print-button testid and post-print assertions and mirror them exactly (the snippet above assumes `btn-print` per that spec's comments).

- [ ] **Step 2: Gated large-PDF proof** — `e2e/printout-email-large.spec.ts`. Skipped unless the big fixture exists, so CI stays fast; run it locally as the real-browser proof (house rule for canvas-adjacent changes):

```ts
import { test, expect } from './fixtures/test';
import { existsSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Real-plan-set proof for the transport fix + email shrink. Gated on the big
// local fixture so CI never pays the 60MB cost.
const BIG_PDF = 'docs/TEG Dania Beach REV.pdf';

test.skip(!existsSync(BIG_PDF), 'big plan-set fixture not present');
test.setTimeout(600_000);

test('email-mode printout of a 60MB plan set lands under the 18MB target', async ({
  authedPage, apiToken, request,
}) => {
  const { token } = apiToken;
  const auth = { Authorization: `Bearer ${token}` };

  // 1. Upload the source PDF via the raw streaming endpoint.
  const srcFileId = randomUUID();
  const upload = await request.post(`/api/files/${srcFileId}`, {
    headers: { ...auth, 'Content-Type': 'application/pdf' },
    data: readFileSync(BIG_PDF),
  });
  expect(upload.ok()).toBeTruthy();

  // 2. Seed a project whose pages reference the source PDF pages (vector path)
  //    with one takeoff measured on every page. Mirror the page shape used by
  //    seedProjectWithTakeoffMeasurement, adding sourcePdfFileId/sourcePdfPageNum
  //    (dimensions ~ the 2.0× raster space: use 2 * pdf page points; exact values
  //    don't matter for size — measurements just make pages printable).
  //    Build 40 pages → printout would be ~63MB vector, forcing the shrink.
  //    [Implementer: construct the project JSON inline here following
  //     seedProjectWithTakeoffMeasurement's shape and POST /api/projects.]

  // 3. Print with Email-ready quality (UI), wait for the proposal page.

  // 4. Fetch the recorded printout's raw bytes and assert the budget:
  //    const size = Number((await request.head(`/api/images/${fileId}/raw`)).headers()['content-length']);
  //    expect(size).toBeLessThanOrEqual(18 * 1024 * 1024);
  //    expect(size).toBeGreaterThan(1024 * 1024); // sanity: real content
});
```

Flesh out steps 2–4 fully (no placeholders in the committed spec): 40-page project JSON via a loop, each page `{ id, name: `Sheet ${n}`, imageWidth: 2 * 2592, imageHeight: 2 * 1728, sourcePdfFileId: srcFileId, sourcePdfPageNum: n, measurements: [lengthMeasurement(takeoffId)] }` (points like `[{x:200,y:200},{x:800,y:200}]`), then the same UI steps as Step 1's test, then the content-length assertion. If actual page dimensions differ from 2592×1728pt, read them with pdf-lib in the spec setup instead of hardcoding.

- [ ] **Step 3: Run everything**

Run: `npx vitest run` → 714+ green.
Run: `npx tsc --noEmit` → clean.
Run: `npx playwright test` → all specs green, including the gated large spec (fixture present locally). Expected: the large spec proves ≤18MB.

- [ ] **Step 4: Commit**

```bash
git add e2e/export.spec.ts e2e/printout-email-large.spec.ts src/pages/project/ProjectTakeoffsTab.tsx
git commit -m "test(e2e): email-quality print coverage + gated 60MB plan-set proof"
```

---

## Execution notes

- Wave 1: Task 1 ∥ Task 2 (no file overlap). Wave 2: Task 3. Wave 3: Task 4. Wave 4: Task 5. Tasks 3/4/5 share files with earlier waves — do not parallelize across waves.
- After all tasks: code-review pass, then push to `testing`.
