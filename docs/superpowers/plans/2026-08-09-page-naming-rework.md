# Page Naming Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Uploads name pages with numeric placeholders (pageNumber "1","2",…) instead of guessed sheet names; the naming modal gains an AI engine that transcribes just the selected region via the existing local VLM.

**Architecture:** Delete the upload-time positional detectors in `src/utils/pdf.ts` and have all four upload call sites write sequential placeholder numbers. Add a `transcribe-region` op through the existing local AI stack (prompt → runner → handler → route). In `PageNamingStep`'s extract tool, add a Text/OCR|AI engine toggle that routes the existing Extract Current/All buttons, and fix the stale revision-rematch after Extract All.

**Tech Stack:** React + pdf.js + Tesseract (client), Express + llama-server/Qwen2.5-VL (server, existing), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-09-page-naming-rework-design.md`

## Global Constraints

- Branch `testing`; push only to `testing`; no PRs unless asked (CLAUDE.md).
- Placeholders: `pageNumber = String(seq)`, `description = ''`, name via the shared compose formula (displays "1"); sequence starts at (pages already in the TARGET plan set) + 1 and runs across all files in the batch; new project / new plan set starts at 1. `detectionConfidence: 'low'` on every uploaded page.
- The detectors are DELETED (`detectSheetNumberFromItems`, `detectDescriptionFromItems`, `detectPageInfo`, `getPositionedText`) — grep before deleting each additional symbol they used; keep anything still referenced elsewhere. Embedded-text extraction + OCR fallback (search indexing), thumbnails, and AI-image rendering are UNCHANGED.
- AI region read: engine toggle (Text/OCR | AI read) on the existing extract tool; Extract Current / Extract All run the selected engine; AI option disabled with a hint when unavailable; switching to AI triggers warmup. Route `POST /api/ai/transcribe-region`, body `{ imageBase64, mode: 'number'|'description' }`, returns `{ text, confidence }`. Cleaning stays client-side via the existing `cleanSheetNumber`/`cleanDescriptionText`.
- After Extract All in review mode with number mode, revision auto-match must refresh (no stale `matchSheetId`).
- No changes to: AI Scan, inline rename, sheetId assignment, duplicate-suffix rules, server-side validation.
- Test commands: `npx vitest run <path>`; full `npm test`; `npm run lint` (tsc); `npm run build`. 693 pre-existing tests — those not deliberately deleted with the detectors must stay green.
- Commit per task, conventional message + trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Line numbers below are approximate — locate by content.

---

### Task 1: `composePageName` helper + dedupe the 6 formula sites (TDD)

**Files:**
- Modify: `src/utils/sheetNaming.ts` (add helper)
- Modify: `src/utils/sheetNaming.test.ts` (add cases)
- Modify: `src/components/PageNamingStep.tsx` (~:233 `updateField`, ~:430 extract-all apply)
- Modify: `src/utils/aiSheets.ts` (~:119 `applyReadToPage`)
- Modify: `src/pages/NewProject.tsx` (~:626 `handleSaveChanges`)
- Modify: `src/pages/ProjectView.tsx` (~:623 inline rename save, ~:1545 `handleConfirmAddPages`)

**Interfaces:**
- Produces: `composePageName(pageNumber?: string | null, description?: string | null, fallback = ''): string` — Tasks 2 and 4 call it.

- [ ] **Step 1: Write the failing tests** (append to `sheetNaming.test.ts`):

```ts
describe('composePageName', () => {
  it('joins number and description', () => {
    expect(composePageName('A-101', 'First Floor Plan')).toBe('A-101 - First Floor Plan');
  });
  it('number only / description only', () => {
    expect(composePageName('A-101', '')).toBe('A-101');
    expect(composePageName('', 'Roof Plan')).toBe('Roof Plan');
  });
  it('both blank → fallback', () => {
    expect(composePageName('', '', 'Page 3')).toBe('Page 3');
    expect(composePageName(undefined, null)).toBe('');
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/utils/sheetNaming.test.ts` → FAIL (no export).

- [ ] **Step 3: Implement in `sheetNaming.ts`:**

```ts
/** The one canonical display-name formula: "NUM - DESC", else whichever
 *  part exists, else the fallback. Previously duplicated at 6 call sites. */
export function composePageName(
  pageNumber?: string | null,
  description?: string | null,
  fallback = '',
): string {
  const num = (pageNumber ?? '').trim();
  const desc = (description ?? '').trim();
  return num && desc ? `${num} - ${desc}` : num || desc || fallback;
}
```

- [ ] **Step 4: Replace the 6 duplicated formulas** with `composePageName(...)` (import it in each file). The sites (locate each by its `` `${...} - ${...}` `` template):
  1. `PageNamingStep.tsx` `updateField` (fallback: `p.name`)
  2. `PageNamingStep.tsx` extract-all apply block (fallback: `p.name`)
  3. `aiSheets.ts` `applyReadToPage` (fallback: `page.name`)
  4. `NewProject.tsx` `handleSaveChanges` (keep its existing fallback expression)
  5. `ProjectView.tsx` inline-rename save (`handleSaveRenamePage`)
  6. `ProjectView.tsx` `handleConfirmAddPages`
  Behavior-preserving: same operands, same fallbacks. NOTE: `composePageName` trims; the old inline formulas did not — that is an accepted (desirable) normalization.

- [ ] **Step 5: Verify + commit**

Run: `npx vitest run src/utils/ && npm run lint` → PASS/clean.

```bash
git add src/utils/sheetNaming.ts src/utils/sheetNaming.test.ts src/components/PageNamingStep.tsx src/utils/aiSheets.ts src/pages/NewProject.tsx src/pages/ProjectView.tsx
git commit -m "refactor(naming): single composePageName helper replaces 6 duplicated formulas

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Numeric placeholders at upload + detector deletion

**Files:**
- Modify: `src/utils/pdf.ts` (delete detectors; stop computing positional detection in `renderOnePage` ~:510-545)
- Modify: `src/pages/NewProject.tsx` (`handleProcessFiles` ~:154-300 + retry ~:401-510)
- Modify: `src/pages/ProjectView.tsx` (`handleAddPages` ~:648-800 + retry ~:886-1000)
- Modify/Delete: tests covering the deleted detectors (grep `detectPageInfo\|detectSheetNumberFromItems\|detectDescriptionFromItems\|getPositionedText` in `src/**/*.test.ts`); update any e2e assertions on auto-detected names (grep `e2e/` for name/pageNumber expectations)

**Interfaces:**
- Consumes: `composePageName` (Task 1).
- Produces: `loadPdfPagesGenerator` page results WITHOUT `detectedPageNumber` / `detectedDescription` / `detectionConfidence` fields (remove from its result type); upload call sites now own naming.

- [ ] **Step 1: Delete the detectors from `pdf.ts`**

Remove `detectSheetNumberFromItems`, `detectDescriptionFromItems`, `detectPageInfo`, `getPositionedText` and the calls in `renderOnePage` (the `getTextContent`→positioned-items→detect block, keeping the plain `extractedText` join and the OCR fallback exactly as they are). Then for each now-unreferenced supporting symbol (`SHEET_RE_STRICT`, `BOILERPLATE_RE`, `TITLE_KEYWORDS_RE`, `findBestSheetNumber`, `stripNum`, `SHEET_RE`, page-label reading `getPageLabels`, `suggestedName` computation): `grep -rn "<symbol>" src/ server/` and delete ONLY if it has no remaining references outside pdf.ts's own deleted code. Remove the dropped fields from the generator's result type and from `PendingPage`-building code paths that read them.

- [ ] **Step 2: Rewrite the four upload call sites**

Common shape (adapt to each site's existing variables — each already has a per-page counter or can derive one):

```ts
// Placeholder numbering: pages arrive named 1, 2, 3, … (continuing after any
// pages already in the target plan set); all real naming happens in the
// naming modal (extract tools / AI). Sequence spans every file in the batch.
const placeholder = String(seq); // seq = existingCountInTargetSet + running index (1-based)
const newPage = {
  id: uuidv4(),
  name: composePageName(placeholder, ''),   // → "1"
  pageNumber: placeholder,
  description: '',
  ...,
  detectionConfidence: 'low' as const,
};
```

Site specifics:
- `NewProject.tsx` main + retry: target set is brand new → `existingCountInTargetSet = 0`; reuse the existing `globalPageNum`-style counter for `seq` (verify it is 1-based and increments across files; the retry path must continue from the count of already-processed pages, matching how it numbers today).
- `ProjectView.tsx` `handleAddPages` + retry: before the loop compute `const existingInSet = project.pages.filter(p => (p.planSetId ?? null) === (targetPlanSetId ?? null)).length;` using whatever variable holds the destination plan set id in that handler (new-set flow → 0 existing). Keep the `revisionOf` computation but feed it the placeholder number (it consults `existingPageNums`; placeholder-to-placeholder matches are intended). Keep `searchTextIndexed`/`extractedText`/thumbnail/AI-image handling untouched.

- [ ] **Step 3: Update/delete tests**

Delete the detector unit tests found in Step 1's grep. Update any test asserting upload auto-naming to assert placeholders instead. Check `e2e/pages.spec.ts` (and other e2e specs) for assertions on detected names — update expectations to placeholder names; do not delete coverage.

- [ ] **Step 4: Verify + commit**

Run: `npx vitest run src/` → PASS. `npm run lint` → clean. `npm test` → full suite green.

```bash
git add -A src/ e2e/
git commit -m "feat(naming): uploads use numeric placeholder page numbers; delete auto-detectors

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Server `transcribe-region` (TDD)

**Files:**
- Modify: `server/ai/types.ts`, `server/ai/prompt.ts`, `server/ai/runner.ts`, `server/ai/disabledRunner.ts`, `server/ai/handlers.ts`, `server/aiRoutes.ts`
- Test: `server/ai/prompt.test.ts`, `server/ai/handlers.test.ts` (append)

**Interfaces:**
- Produces: `POST /api/ai/transcribe-region` → 200 `{ text: string, confidence: number }`, 400 (missing/bad imageBase64 or mode), 503 (unconfigured), 502 (inference error). Runner gains `transcribeRegion(input: { image: Buffer; mode: TranscribeMode; idleTimeoutMs?: number }): Promise<TranscribeResult>`. Task 4's client calls the route.

- [ ] **Step 1: Failing tests**

`prompt.test.ts` — mirror the existing read-prompt test style:

```ts
describe('buildTranscribePrompt', () => {
  it('number mode mentions sheet number and JSON shape', () => {
    const p = buildTranscribePrompt('number');
    expect(p).toContain('sheet number');
    expect(p).toContain('"text"');
    expect(p).toContain('ONLY the text');
  });
  it('description mode does not steer toward sheet numbers', () => {
    expect(buildTranscribePrompt('description')).not.toContain('sheet number');
  });
});
describe('parseTranscribeResponse', () => {
  it('parses text + clamps confidence', () => {
    expect(parseTranscribeResponse('{"text":" A-101 ","confidence":1.7}'))
      .toEqual({ text: 'A-101', confidence: 1 });
  });
  it('tolerates prose around the JSON', () => {
    expect(parseTranscribeResponse('Sure! {"text":"ROOF PLAN","confidence":0.9} hope that helps'))
      .toEqual({ text: 'ROOF PLAN', confidence: 0.9 });
  });
  it('malformed → empty low-confidence', () => {
    expect(parseTranscribeResponse('nope')).toEqual({ text: '', confidence: 0 });
  });
  it('does not uppercase (cleaning is client-side)', () => {
    expect(parseTranscribeResponse('{"text":"Level 06 Floor Plan","confidence":0.8}').text)
      .toBe('Level 06 Floor Plan');
  });
});
```

`handlers.test.ts` — clone the existing `handleReadSheet` test group's fake-runner pattern for `handleTranscribeRegion`: 503 when `configured()` false; 400 when `imageBase64` missing/undecodable; 400 when `mode` is not `'number'`/`'description'`; 200 happy path passes decoded Buffer + mode to the runner and returns its result; 502 when the runner throws.

- [ ] **Step 2: Run to verify failure** — `npx vitest run server/ai/` → FAIL (missing exports).

- [ ] **Step 3: Implement**

`types.ts`:

```ts
/** Region transcription: read exactly what's in a small crop, no interpretation. */
export type TranscribeMode = 'number' | 'description';
export interface TranscribeResult { text: string; confidence: number; }
```
and extend `AiRunner` with `transcribeRegion(input: { image: Buffer; mode: TranscribeMode; idleTimeoutMs?: number }): Promise<TranscribeResult>;`

`prompt.ts`:

```ts
export function buildTranscribePrompt(mode: TranscribeMode): string {
  const target = mode === 'number'
    ? `The crop should contain a drawing sheet number (e.g. "A-101", "S2.1", "RC-A-106"). Return just that token as written, reading each character and digit carefully.`
    : `The crop should contain a sheet title or description. Return it verbatim as written.`;
  return (
    `This image is a small cropped region of a construction drawing. ` +
    `Read ONLY the text visible in the image. Do not interpret, summarize, expand abbreviations, or add anything that is not printed. ` +
    target +
    ` If the crop contains several lines, return them joined with single spaces in reading order.\n` +
    `Respond with ONLY a JSON object, no prose, exactly of the form ` +
    `{"text": string, "confidence": number between 0 and 1}. ` +
    `Use an empty string and low confidence if the crop is unreadable.`
  );
}

export function parseTranscribeResponse(raw: string): TranscribeResult {
  const obj = extractJson(raw);
  if (!obj) return { text: '', confidence: 0 };
  // No uppercasing here — the client applies the same cleaners as the OCR path.
  return { text: String(obj.text ?? '').trim(), confidence: clamp01(obj.confidence) };
}
```

`runner.ts` — add a method mirroring `readSheet`'s body exactly (clearIdle → waitReady → data URL → messages with `buildTranscribePrompt(mode)` → `queue.enqueue(chat)` → log a short raw slice as `[ai] transcribe raw:` → `parseTranscribeResponse` → in the same finally/arm-idle position `readSheet` uses, re-arm idle with `idleTimeoutMs`). Read `readSheet`'s full implementation first and copy its error/idle handling verbatim.

`disabledRunner.ts` — add `transcribeRegion` following the exact pattern of the file's existing `readSheet` stub (read the file; mirror whatever it does — reject/throw with the disabled reason).

`handlers.ts`:

```ts
export async function handleTranscribeRegion(
  runner: AiRunner,
  body: { imageBase64?: string; mode?: string; idleTimeoutMs?: number },
): Promise<HandlerResult> {
  if (!runner.configured()) return { status: 503, body: { error: 'ai unavailable' } };
  if (body.mode !== 'number' && body.mode !== 'description') {
    return { status: 400, body: { error: "mode must be 'number' or 'description'" } };
  }
  if (!body.imageBase64) return { status: 400, body: { error: 'imageBase64 required' } };
  const image = decodeBase64Image(body.imageBase64);
  if (!image) return { status: 400, body: { error: 'bad imageBase64' } };
  try {
    const result = await runner.transcribeRegion({ image, mode: body.mode, idleTimeoutMs: body.idleTimeoutMs });
    return { status: 200, body: result };
  } catch (e: any) {
    return { status: 502, body: { error: String(e?.message ?? e) } };
  }
}
```

`aiRoutes.ts` — after the read-sheet route:

```ts
  app.post('/api/ai/transcribe-region', authenticateToken, async (req, res) => {
    const r = await handleTranscribeRegion(runner, req.body || {});
    res.status(r.status).json(r.body);
  });
```

- [ ] **Step 4: Verify + commit**

Run: `npx vitest run server/ai/ && npm run lint` → PASS/clean.

```bash
git add server/ai/ server/aiRoutes.ts
git commit -m "feat(ai): transcribe-region op — VLM reads only a cropped region

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Client engine toggle + rematch fix + full verification

**Files:**
- Modify: `src/utils/aiSheets.ts` (client fetch fn)
- Modify: `src/utils/pdf.ts` (`buildRegionCrop`)
- Modify: `src/components/PageNamingStep.tsx` (toggle UI ~:812-831 area, `handleExtractText`/`recognizePage` ~:327-459, extract-all apply ~:420-434)

**Interfaces:**
- Consumes: Task 3 route; `composePageName` (Task 1); existing `cleanSheetNumber`/`cleanDescriptionText`, `renderPdfPageToDataUrl` cache, `getAiStatus`/`warmupAi`/`getAiIdleTimeoutMs`.

- [ ] **Step 1: `aiSheets.ts` client fn** (mirror `readSheet`'s style):

```ts
export interface TranscribeResult { text: string; confidence: number; }

export async function transcribeRegion(input: { imageBase64: string; mode: 'number' | 'description'; idleTimeoutMs?: number }): Promise<TranscribeResult | null> {
  try {
    const res = await fetch('/api/ai/transcribe-region', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }, body: JSON.stringify(input),
    });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}
```

- [ ] **Step 2: `pdf.ts` `buildRegionCrop`** (next to `buildOcrCrop`; same geometry, NO grayscale/contrast — the VLM wants the original pixels):

```ts
/** Crop a region (0–100 percentages) as a plain COLOR JPEG for the vision
 *  model — same geometry as buildOcrCrop but without the Tesseract-oriented
 *  grayscale/contrast preprocessing. Upscaled so the short side is ≥200px. */
export async function buildRegionCrop(
  imageUrl: string,
  region: { x: number; y: number; width: number; height: number }
): Promise<string> {
  const img = await loadImage(imageUrl);
  const naturalW = img.naturalWidth || img.width;
  const naturalH = img.naturalHeight || img.height;
  const sx = Math.max(0, (region.x / 100) * naturalW);
  const sy = Math.max(0, (region.y / 100) * naturalH);
  const sw = Math.max(1, Math.min(naturalW - sx, (region.width / 100) * naturalW));
  const sh = Math.max(1, Math.min(naturalH - sy, (region.height / 100) * naturalH));
  const upscale = Math.min(6, Math.max(1, 200 / Math.min(sw, sh)));
  const dw = Math.max(1, Math.round(sw * upscale));
  const dh = Math.max(1, Math.round(sh * upscale));
  const canvas = document.createElement('canvas');
  canvas.width = dw; canvas.height = dh;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create canvas context for region crop');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, dw, dh);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
  return canvas.toDataURL('image/jpeg', 0.85);
}
```

- [ ] **Step 3: `PageNamingStep.tsx` engine toggle + routing**

1. State: `const [extractEngine, setExtractEngine] = useState<'text' | 'ai'>('text');` plus `const [aiEngineAvailable, setAiEngineAvailable] = useState(false);` — an effect that runs when the preview modal opens calls `getAiStatus().then(s => setAiEngineAvailable(!!s.available))`.
2. UI, directly under the Extract Number / Extract Description buttons (match their styling conventions):

```tsx
<div className="flex items-center gap-2 text-xs">
  <span className="text-ink-faint">Engine:</span>
  <Button size="sm" variant={extractEngine === 'text' ? 'primary' : 'secondary'}
    onClick={() => setExtractEngine('text')}>Text/OCR</Button>
  <Button size="sm" variant={extractEngine === 'ai' ? 'primary' : 'secondary'}
    disabled={!aiEngineAvailable}
    title={aiEngineAvailable ? 'Read the selected region with the local AI model' : 'AI model not available on this server'}
    onClick={async () => { setExtractEngine('ai'); warmupAi(await getAiIdleTimeoutMs()); }}>
    AI read
  </Button>
</div>
```

(Adapt `Button` props to the component set actually imported in the modal footer — reuse whatever the Extract mode buttons use.)
3. In `recognizePage` (the per-page pipeline inside `handleExtractText`): branch at the top —

```ts
if (extractEngine === 'ai') {
  // Same source image the OCR path uses (cached full render / legacy fallback).
  const src = await getPageRenderSrc(pg); // reuse the existing cached-render + fallback resolution already in this function
  const crop = await buildRegionCrop(src, rect);
  const result = await transcribeRegion({ imageBase64: crop, mode: extractionType === 'pageNumber' ? 'number' : 'description', idleTimeoutMs: await getAiIdleTimeoutMs() });
  const rawText = result?.text ?? '';
  const cleaned = extractionType === 'pageNumber' ? cleanSheetNumber(rawText) : cleanDescriptionText(rawText);
  return { value: cleaned, confidence: (result && result.confidence >= 0.5 && cleaned) ? 'high' : 'low' };
}
```

Refactor the existing image-source resolution into a small local helper if it isn't one (the OCR path already resolves: source-PDF cached render → loaded preview src → stored image → thumbnail); BOTH engines must use it. The text/OCR path is otherwise untouched.
4. Extract All with the AI engine: keep the existing per-page loop; add lightweight progress — a `const [extractProgress, setExtractProgress] = useState<{done:number,total:number}|null>(null)` updated per page (both engines fine, but required for AI where each page costs an inference) and rendered near the footer buttons as `Extracting… {done}/{total}`; clear in the `finally`.

- [ ] **Step 4: Rematch after Extract All (review mode)**

In the extract-all apply block (the one that writes `pendingPages` directly), after applying results when `reviewMode && extractionType === 'pageNumber'`: recompute matches for the affected pages with the SAME logic `updateField` uses (`autoMatch`), e.g. run the existing `rematchAll()` (or an equivalent map) as part of the same state update so `matchSheetId` reflects the new numbers. Keep the manual "Re-match by page #" button.

- [ ] **Step 5: Full verification**

Run: `npx vitest run src/ server/ai/` → PASS; `npm run lint` → clean; `npm test` → full suite; `npm run build` → green.
Then check e2e: `grep -rn "pageNumber\|Extract" e2e/` — if `npm run test:e2e` is runnable in this environment, run the pages spec; if Chromium libs are missing, note it in the report instead (do not fake it).

- [ ] **Step 6: Commit**

```bash
git add src/utils/aiSheets.ts src/utils/pdf.ts src/components/PageNamingStep.tsx
git commit -m "feat(naming): AI region-read engine in extract tool + rematch after Extract All

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
