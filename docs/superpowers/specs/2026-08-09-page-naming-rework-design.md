# Page Naming Rework — Design Spec

Date: 2026-08-09
Status: Approved by Nathan

## Purpose

Uploads stop guessing sheet names. Pages arrive with numeric placeholder
numbers (1, 2, 3, …) and all naming happens in the naming modal, which gains a
third extraction engine: the local AI model reading ONLY the selected region
("transcribe"), alongside the existing Text/OCR reconcile and the whole-sheet
AI Scan (both unchanged).

## Decisions (from brainstorm)

- Placeholders go in **`pageNumber`** ("1", "2", …), description blank, `name`
  from the existing `num - desc` formula (displays as "1"). Revision
  auto-matching keys off page numbers as today — placeholder pages in a new
  set auto-match same-numbered pages (placeholder or real) in prior sets;
  that is intended behavior.
- AI region read is an **engine toggle** (Text/OCR | AI read) on the existing
  extract tool — the Extract Current / Extract All Pages buttons run the
  selected engine. No separate buttons.
- The upload-time detectors are **deleted**, not disabled.

## 1. Upload naming — numeric placeholders

Applies to all four call sites: `NewProject.tsx` `handleProcessFiles` +
retry, `ProjectView.tsx` `handleAddPages` + retry.

- Each processed page gets `pageNumber = String(seq)`, `description = ''`,
  `name` via the shared formula (= the placeholder number),
  `detectionConfidence: 'low'` (so the modal's amber needs-review nudge shows
  on every un-named page).
- **Sequence**: starts at `existingCount + 1` where `existingCount` is the
  number of pages already in the TARGET plan set (0 for a new project or a
  new plan set), and increments across all files/pages of the upload batch in
  processing order. New revision sets therefore start at 1 — placeholder
  pages auto-match the prior set's same-numbered sheets (per decision above).
- **Deleted** from `src/utils/pdf.ts`: `detectSheetNumberFromItems`,
  `detectDescriptionFromItems`, `detectPageInfo`, `getPositionedText` (and
  the scoring regexes/constants used only by them: `SHEET_RE_STRICT`,
  `BOILERPLATE_RE`, `TITLE_KEYWORDS_RE`, etc. — keep anything the region
  tool or search still uses, e.g. `findBestSheetNumber` only if still
  referenced; delete its tests with it). `loadPdfPagesGenerator` stops
  computing positional detection; `detectionConfidence` output is dropped
  from `pdf.ts` (call sites hardcode `'low'`).
- **Kept unchanged**: embedded text-layer extraction + full-page OCR fallback
  (feeds `extractedText` / search indexing), thumbnail + AI-image rendering,
  `suggestedName` (may become unused by naming — remove its computation only
  if nothing else consumes it), page-label reading may be deleted if only
  the naming path used it.
- A shared helper (new `src/utils/pageNaming.ts` or added to
  `sheetNaming.ts`): `composePageName(pageNumber, description): string`
  replacing the 6 duplicated `` `${num} - ${desc}` `` formulas
  (`PageNamingStep.tsx` ×2, `aiSheets.ts`, `NewProject.tsx`,
  `ProjectView.tsx` ×2) — plus `placeholderNumbers(startAt, count)` used by
  the upload flows. Pure, tested.

## 2. AI region read ("transcribe") — server

New route on the existing local AI stack (`server/aiRoutes.ts` →
`server/ai/handlers.ts` → runner; same auth, single-flight queue, timeouts,
idle unload, 503-when-unconfigured):

- `POST /api/ai/transcribe-region` — body `{ imageBase64: string, mode:
  'number' | 'description' }`. Always base64 (crops are made client-side);
  no imageId variant.
- `server/ai/prompt.ts`: `buildTranscribePrompt(mode)` — instruct the model
  to read ONLY the text visible in the cropped image and return JSON
  `{ "text": string, "confidence": number }`; no interpretation, no
  expansion, preserve what's written. Number mode adds a hint that the crop
  should contain a sheet number (e.g. A-101, S2.1) and to return just that
  token. `parseTranscribeResponse(raw)` → `{ text, confidence }` (text
  trimmed; number mode NOT uppercased server-side — cleaning stays client-
  side for parity with the OCR path).
- Handler `handleTranscribeRegion` mirroring `handleReadSheet` (validation,
  503, error mapping). Tests mirror the existing prompt/handler tests.

## 3. AI region read — client

- `src/utils/aiSheets.ts`: `transcribeRegion(imageBase64, mode):
  Promise<{ text: string; confidence: number }>`.
- `src/utils/pdf.ts`: new `buildRegionCrop(dataUrl, rectPct)` — plain COLOR
  crop of the region (percent rect, same geometry as `buildOcrCrop`),
  upscaled so the short side is ≥200px, JPEG. No grayscale/contrast/gamma —
  that preprocessing is for Tesseract, not the VLM.
- `PageNamingStep.tsx`:
  - New engine state `'text' | 'ai'` + toggle UI next to the mode buttons.
    AI option disabled with a hint when `getAiStatus()` reports unavailable;
    selecting AI triggers `warmupAi()` (fire-and-forget).
  - `handleExtractText` routes per page by engine. AI path: reuse the cached
    2.0× page render → `buildRegionCrop` → `transcribeRegion` → clean via
    the SAME `cleanSheetNumber` / `cleanDescriptionText` → apply through the
    same paths, with `extractConfidence = confidence >= 0.5 ? 'high' :
    'low'`. Legacy raster pages (no source PDF) use the same fallback image
    the OCR path uses.
  - Extract All with AI engine: sequential-ish batching
    (`runWithConcurrency`, limit 2 — the server queue is single-flight
    anyway) with the existing N-of-M progress treatment.

## 4. Rematch after Extract All (both engines)

In review mode, the Extract All path currently writes results directly and
leaves `matchSheetId` stale. After applying extract-all results (number
mode), auto-matching re-runs for the affected pages (same logic as
`updateField`'s page-number edit path / `rematchAll`). The manual "Re-match
by page #" button stays.

## 5. Out of scope

- AI Scan (whole-sheet read + match passes) — unchanged.
- Inline single-page rename on the pages tab — unchanged (still no dup
  check there).
- No server-side page-number validation; duplicate suffixing rules
  unchanged.
- No changes to sheetId assignment or the revision model.
- Region tool remains desktop-mouse only.

## Testing

- `pageNaming` helper tests (compose formula incl. blank cases,
  placeholder sequences, continuation from existing count).
- Server: `buildTranscribePrompt` / `parseTranscribeResponse` tests (both
  modes, malformed JSON, clamped confidence), `handleTranscribeRegion`
  route/handler tests (validation 400s, 503 unconfigured, happy path with a
  stubbed runner).
- Client: engine routing unit tests where practical (pure pieces:
  `buildRegionCrop` geometry is canvas-bound — cover the rect math if
  extracted; cleaning parity covered by existing cleaner tests), rematch-
  after-extract-all covered via the pure rematch helper if extracted.
- Deleted detector tests removed with the detectors; upload call-site tests
  updated to assert numeric placeholders.
- Full suite green; `npm run build` green.
