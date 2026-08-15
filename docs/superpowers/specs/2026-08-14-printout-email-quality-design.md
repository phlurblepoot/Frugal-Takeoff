# Printout transport fix + Email-ready quality option — Design

Date: 2026-08-14
Status: Approved by Nathan (conversation), implementation to follow

## Problem

1. **Printout saves fail on large plan sets.** Vector printouts copy source PDF
   pages (`buildHighlightsPdf`). A 60MB/40-page plan set produces a ~63MB
   printout (~84MB as base64), which the save path — `saveFile` → POST
   `/api/images` with a base64-in-JSON body — cannot carry past
   `express.json({ limit: "50mb" })`. The server answers **413**.
   - In `ProjectView.handlePrint` the save runs inside a `FileReader.onloadend`
     callback *outside* the try/catch, so the rejection is swallowed and the
     "Generating PDF…" overlay spins forever.
   - In `ProjectProposal` the same failure is caught and surfaces as
     "Failed to generate proposal PDF."
2. **No email-friendly output.** Even when saving works, a 60MB printout can't
   be emailed. Provider limits are ~25MB *after* base64 encoding (~35%
   inflation), so the safe attachment size is ~18MB.
3. **Dead UI.** The quality dropdown (Full/Large/Standard/Compact,
   `HIGHLIGHT_QUALITY_PRESETS`) is ignored by the vector pipeline
   (`_quality` param) — it is a no-op today.

## Decisions (agreed with Nathan)

- Quality menu simplifies to **2 options**: `best` (vector, current behavior)
  and `email` (target ≤ **18MB** file size, labeled "Email-ready", chosen so the
  encoded attachment clears 25MB provider limits).
- If the floors are hit and the result is still over 18MB: **save best effort
  and warn** with the actual size (never fail, never go below the readable floor).
- Shrink mechanism: **post-process the vector printout** (approach A) — build
  vector first; only if over budget, re-render the *generated* PDF's pages via
  pdf.js to JPEGs and reassemble with pdf-lib. Overlay code runs once,
  untouched; no new overlay coordinate math.

## Design

### 1. Transport fix (both quality modes)

- `ProjectView.handlePrint`: delete the `FileReader` dance. Build a
  `Blob([pdfBuffer], { type: 'application/pdf' })` and `await
  saveBinaryFile(fileId, blob)` (existing helper → POST `/api/files/:id`, raw
  streaming, 100MB `express.raw` limit). Everything awaited inside the existing
  try/catch, so failures now toast instead of hanging. Pass `?projectId=` and
  `?name=` query labels like plan-set uploads do (putBuffer supports them).
- `ProjectProposal` generate flow: same switch — Blob + `saveBinaryFile`
  replaces the FileReader + `saveFile` pair. (Already inside try/catch.)
- `ProjectProposal.handleDownload`: replace `getFile(fileId)` (giant JSON
  envelope) with a fetch of the streaming URL (`getImageUrl(id)` =
  `/api/images/:id/raw`) → blob → object URL → anchor click. Keep the
  Excel-vs-PDF extension logic keyed off `printout.type` (the dataUrl-prefix
  sniff no longer applies to a blob; `printout.type === 'excel'` is already
  written by the Excel export path).
- Out of scope, unchanged: Excel export save (small payloads), PdfEditor viewer
  (already streams via `fetchFileBlob`), server email attachments (read from
  disk, format-agnostic).

### 2. Quality selector

- `HIGHLIGHT_QUALITY_PRESETS` replaced by:
  ```ts
  export const HIGHLIGHT_QUALITY_PRESETS = {
    best:  { label: 'Best quality (vector)' },
    email: { label: 'Email-ready (under 25MB sent)' },
  } as const;
  export type HighlightQuality = keyof typeof HIGHLIGHT_QUALITY_PRESETS;
  ```
- Legacy stored prefs (`proposal-highlightQuality` server pref and the
  localStorage proposal-prefs blob) may hold `full|large|standard|compact` —
  normalize any unknown value to `best` at read time (one small
  `normalizeHighlightQuality()` helper used by both readers; never write legacy
  values back).
- The dropdowns in ProjectProposal, and the print modal (ProjectTakeoffsTab,
  fed from ProjectView state) render the two options. Default stays `best`
  (maps from old default `standard`).

### 3. Email-ready shrink — `shrinkPdfToBudget`

New module `src/pages/project/proposal/shrinkPdf.ts`:

```ts
export const EMAIL_TARGET_BYTES = 18 * 1024 * 1024;

export interface ShrinkResult {
  bytes: ArrayBuffer;      // ≤ budget, or best-effort if floors hit
  overBudget: boolean;     // true → caller warns with actual size
}

export async function shrinkPdfToBudget(
  pdfBytes: ArrayBuffer,
  budgetBytes: number,
  onProgress?: (msg: string) => void,
): Promise<ShrinkResult>;
```

- **Pass-through:** if `pdfBytes.byteLength <= budgetBytes`, return it
  unchanged (`overBudget: false`). Email mode on a small job keeps full vector
  quality.
- **Raster rebuild:** otherwise open `pdfBytes` with pdf.js (same
  `pdfjs-dist/legacy` build + worker config as `pdf.ts`), and for each page:
  render to a canvas at `scale = min(1, LONG_SIDE / max(w, h))` where the pixel
  long-side starts at **2200px**, then encode `canvas.toDataURL('image/jpeg', q)`
  walking `q` down `0.75 → 0.65 → 0.55 → 0.45` until the page fits its budget.
  If the floor quality still doesn't fit, drop the long side by ×0.8 (re-render)
  and walk `q` again; scale floor **1000px** long side. Whatever the floors
  produce is accepted.
- **Per-page budget:** `perPage = (budgetBytes * 0.97 - FIXED_OVERHEAD) / pageCount`
  (0.97 + `FIXED_OVERHEAD ≈ 64KB` reserve pdf-lib structure overhead). Pages
  that come in *under* their budget roll the surplus over to the remaining
  pages (running-remainder accounting), so a mixed set (dense sheets + light
  sheets) converges to best possible overall quality.
- **Assembly:** new pdf-lib document; each JPEG via `embedJpg`, page sized to
  the JPEG's dimensions in points (matches how legacy raster pages worked;
  aspect ratio preserved). `overBudget = final.byteLength > budgetBytes`.
- **Progress:** `onProgress('Compressing page X of Y…')` per page.
- The pure budget/ladder arithmetic lives in exported helpers
  (`planPageBudget`, `nextLadderStep`-style) so vitest covers them without a
  DOM; the render loop consumes them.

### 4. Wiring

- `handlePrint` (simple printout): after `buildHighlightsPdf`, when quality is
  `email`, run `shrinkPdfToBudget(buffer, EMAIL_TARGET_BYTES, onProgress)`;
  save the result; if `overBudget`, toast a warning with the final size in MB
  ("Printout is 21.4MB — larger than the 18MB email target; most providers may
  reject it.") but still save + navigate.
- `generateProposalPdf` (merged proposal): generate proposal body + highlights
  and merge exactly as today; when quality is `email`, shrink the **merged**
  result against `EMAIL_TARGET_BYTES`. (Proposal cover pages rasterize with the
  rest; acceptable — they are text-light jsPDF pages that compress small, and
  this keeps one shrink call instead of budget-splitting logic.) `overBudget`
  propagates so ProjectProposal can toast the same warning.
- `buildHighlightsPdf`'s unused `_quality` param is removed; quality is handled
  by the callers (it only ever gates the post-shrink step).

### 5. Errors & progress

- All failures inside the (now fully awaited) try/catch → error toast, spinner
  dismissed in `finally`/error paths.
- Progress messages: existing "Adding page X of Y…" then "Compressing page X of
  Y…" then "Saving…".

### 6. Testing

- **Vitest:** budget math units (per-page split + rollover, ladder stepping,
  floors, pass-through decision, overBudget flag); pref normalization
  (`legacy → best`); existing suites stay green (714 tests).
- **Playwright:** real-browser printout run on a seeded project — click print,
  assert a printout appears and no eternal spinner; email-mode run asserting
  the saved file honors the budget (small fixture budget to force the raster
  path). Canvas-adjacent changes require real-browser proof (house rule).
- **Manual (Nathan):** one real print of the Dania Beach project on testing.

## Out of scope

- Making Full/Large/Standard/Compact rasterize again (deleted instead).
- Changing the 50mb `express.json` limit (base64 JSON path no longer carries printouts).
- Streaming reads for the PdfEditor (already streaming) or server email (unaffected).
