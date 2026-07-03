# AI-Assisted Sheet Reading & Revision Matching — Design Spec

**Date:** 2026-07-02
**Status:** Approved (pending final user review of this document)

## Goal

Add a bundled, GPU-accelerated **local** vision model that reads each full plan
sheet and returns its **sheet number + description**, and **matches new pages to
existing sheets** when adding a plan set. No external calls, no API key. The AI
prefills; the user confirms/edits in the review UI that already exists. The
feature is **additive** — if the model is unavailable, everything falls back to
today's OCR + manual-region flow.

## Principles / Constraints

- **Fully local.** Runs on the server's GPU (RTX 5070). Nothing leaves the box.
  No API key, no external service.
- **Whole-page understanding.** The model reads the entire rendered sheet, not a
  hand-drawn region — many plan sets don't put the title block neatly in a
  corner.
- **Human-in-the-loop.** AI output is a *suggestion* that prefills the existing
  review step. The user always confirms before anything is saved. The AI never
  silently commits names or revision matches.
- **Graceful degradation.** Model missing / errored / slow → the UI silently
  falls back to the current OCR + manual-region naming and manual
  revision-of/new dropdown. Import is never blocked.
- **Testable without a GPU.** The model runner sits behind an injectable
  interface with a fake, so all server logic is unit-testable in CI without
  weights or a GPU.

## Architecture Overview

```
Client (browser)                     Server (Node/Express + GPU)
────────────────                     ──────────────────────────────
pdf.js render page  ──img/imageId──▶ POST /api/ai/read-sheet
+ embedded text                        └▶ AiRunner (node-llama-cpp, CUDA)
                                          Qwen2.5-VL-3B (GGUF) on RTX 5070
PageNamingStep  ◀── {number,title, ──────┘  reads whole page → strict JSON
  prefilled +      discipline,conf}
  AI badge/conf
                    ──existing───────▶ POST /api/ai/match-sheet
                      sheets + new       └▶ AiRunner (text) → {matchSheetId|null,
  Revision-of  ◀──   page fields              confidence, reason}
  preselected
```

Page raster JPEGs already live server-side (each `ProjectPage` has an `imageId`
resolved through `server/files.ts`), and the original PDF is stored too
(`sourcePdfFileId`). So the server can read any page image directly — **no
server-side PDF rasterizer is required**.

## Components

### 1. `server/ai/runner.ts` — inference wrapper (new)

- Wraps **`node-llama-cpp`** with the **CUDA** backend.
- Loads a GGUF vision model + its vision projector (mmproj) **once, lazily on
  first request**. Default **Qwen2.5-VL-3B-Instruct** (Q4_K_M), configurable.
- Exposes a small interface so it can be faked in tests:
  ```ts
  export interface AiRunner {
    available(): Promise<boolean>;
    readSheet(input: { image: Buffer; embeddedText?: string }): Promise<SheetRead>;
    matchSheet(input: { page: SheetRead; existing: ExistingSheet[] }): Promise<SheetMatch>;
    info(): { model: string; device: 'cuda' | 'cpu' | 'none' };
  }
  ```
- **Single-flight queue:** serialize GPU calls (one model context) so batch page
  reads queue instead of thrashing VRAM. Per-call timeout (default 30s).
- **Model weights** are downloaded on first run to a mounted **`/models`
  volume** (not baked into the image), keyed by a configured repo/filename.
- **Config (env, overridable in Settings where sensible):**
  `AI_ENABLED` (default on), `AI_MODEL_REPO` / `AI_MODEL_FILE` / `AI_MMPROJ_FILE`,
  `AI_MODELS_DIR` (default `/models`), `AI_GPU_LAYERS` (default all),
  `AI_MAX_IMAGE_PX` (default 1568 longest side), `AI_TIMEOUT_MS` (default 30000).

### 2. Endpoints (in `server/routes.ts` or a new `server/aiRoutes.ts`)

All require `authenticateToken`.

- `GET /api/ai/status` → `{ available: boolean, model: string, device: string }`.
  Cheap; used by the client to decide whether to offer AI. Never triggers a
  model load beyond a quick capability check.
- `POST /api/ai/read-sheet`
  - Body: `{ imageId?: string, imageBase64?: string, embeddedText?: string }`
    (supports a stored `imageId` **or** an inline client-rendered image, so it
    works before or after the image is persisted).
  - Loads the JPEG (from `files.ts` by id, or decodes base64), downsizes to
    `AI_MAX_IMAGE_PX`, runs `readSheet`.
  - Prompt instructs the model it's reading a construction/architectural drawing
    sheet; extract the **sheet identifier** (e.g. `A-201`, `S1.1`, `M-2.0`,
    `E001`), the **sheet title/description** (e.g. `SECOND FLOOR PLAN`), the
    **discipline**, and a **confidence 0..1**. The **embedded PDF text layer is
    passed as a reference hint** when present (reduces hallucination on vector
    PDFs; the model still reads scanned/image-only sheets from the image).
  - Output constrained to **strict JSON** via a GBNF grammar; server validates +
    normalizes (uppercase/trim number). Parse failure → best-effort value with
    low confidence.
  - Returns `SheetRead = { sheetNumber: string; sheetTitle: string; discipline?: string; confidence: number }`.
- `POST /api/ai/match-sheet`
  - Body: `{ page: SheetRead, existingSheets: ExistingSheet[] }` where
    `ExistingSheet = { sheetId: string; number: string; title: string }`.
  - Text-based prompt: given the new page's number/title/discipline and the list
    of existing sheets, decide which existing sheet this is a **revision of**, or
    `"new"`. Handles renumbered/retitled sheets that pure number-matching misses.
  - Returns `SheetMatch = { matchSheetId: string | null; confidence: number; reason?: string }`.
    `matchSheetId` must be one of the provided `sheetId`s or `null`.

### 3. Client wiring

- **`src/utils/aiSheets.ts` (new):** thin fetch helpers — `getAiStatus()`,
  `readSheet()`, `matchSheet()` — plus a small in-memory cache of the status so
  the UI doesn't re-poll per page.
- **Import (`NewProject`, `AddPagesModal`) — auto-run on every page:** after
  pages render (and the embedded text layer is extracted, as today), if
  `getAiStatus().available`, kick off `readSheet` for each page through a small
  concurrency-limited queue, updating the existing **progress indicator**. Each
  result **prefills** the page's number/description in `PageNamingStep`. The
  manual region-draw + OCR path stays available as a **per-page override**.
- **Add plan set — revision matching:** after reading each incoming page, call
  `matchSheet` against the current sheets (`existingSheets` already computed for
  the review UI) and **pre-select** "Revision of X" / "New sheet". User confirms.
- **Confidence surfacing:** each reviewed row gets an **"AI" badge + confidence**;
  low-confidence rows reuse the existing **amber "needs review"** nudge. Optional:
  store AI confidence on the page `attrs` for later display (round-trips via
  decompose/load; no schema change).
- **Fallback:** if `getAiStatus()` is unavailable or a call errors/times out,
  the row simply falls back to the current heuristic prefill (PDF labels →
  filename → repeated tokens) and manual dropdown — no error surfaced beyond a
  quiet indicator.

### 4. Settings

- New **"AI Sheet Reading"** section: enable/disable toggle, model **status/info**
  (from `/api/ai/status`), a **re-download / reload model** action, and the
  **"Auto-name with AI"** toggle (on when available). Advanced fields
  (model file, max image px) may be surfaced read-only from env.

### 5. Docker / infra (heaviest/riskiest part)

- Base image gains the **CUDA runtime** libraries; `node-llama-cpp` is built with
  **CUDA** support. Gated behind a **build arg** (e.g. `WITH_CUDA`) so a CPU-only
  build still succeeds with the feature simply disabled (`device: 'cpu'`/`'none'`
  → `available:false`).
- **GPU passthrough** (NVIDIA Container Toolkit) — already configured for the
  5070.
- **Model weights** download at runtime to the mounted `/models` volume on first
  use; documented in the runbook (image size, first-boot download time, VRAM).

## Data Flow & Privacy

- Everything stays on the server/GPU. Page images already live server-side;
  embedded text is already inside the stored PDF. **No external calls.**
- Nothing new is persisted except the user-confirmed number/description (already
  stored today) and optionally the AI confidence in page `attrs`.

## Failure Handling

- Model can't load (no GPU / weights missing / disabled) → `available:false`;
  UI uses the existing flow.
- Per-page inference error or timeout → that page falls back to heuristic
  prefill; other pages proceed.
- Concurrency capped; GPU calls single-flighted so a large set can't overload
  VRAM.

## Testing

- **Server (no GPU/weights in CI):** the `AiRunner` interface is faked. Unit test
  the prompt builders, strict-JSON parse/validate/normalize, `match-sheet`
  resolver (must return a provided id or null; rejects hallucinated ids), the
  single-flight queue (serialization + timeout), the image-load/downsize path,
  and the graceful-disable path (`available:false`).
- **Client:** read/match wiring prefill, the concurrency-limited import queue,
  confidence badges + amber nudge, and the `status:unavailable` fallback.
- No model weights in CI; a real end-to-end model smoke is a manual step on the
  GPU host.

## Phasing (single spec, two dependent phases)

- **Phase 1 — Server inference + endpoints + graceful disable + Docker/CUDA.**
  Ships the `AiRunner` (with fake for tests), `/api/ai/status|read-sheet|
  match-sheet`, config, single-flight queue, model download-to-volume, and the
  CUDA build (behind the build arg). Verifiable independently via the endpoints
  and the fake runner; manual GPU smoke on the host.
- **Phase 2 — Client wiring.** `aiSheets.ts`, auto-run import queue + progress,
  `PageNamingStep` prefill + AI badge/confidence, revision-match pre-selection,
  Settings section, and fallback. Depends on Phase 1's endpoints.

## Open Items (resolve during planning, not blockers)

- Verify the pinned **`node-llama-cpp`** version's multimodal API supports the
  **Qwen2.5-VL-3B** GGUF + mmproj; if it misbehaves in llama.cpp, default to
  **MiniCPM-V 2.6** (also supported). Model stays configurable, so low risk.
- Confirm the exact GGUF repo/filenames for the default model + mmproj and pin
  them.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Backend | Local, server-side, bundled |
| Inference engine | `node-llama-cpp` + GGUF, CUDA (RTX 5070) |
| Default model | Qwen2.5-VL-3B-Instruct (configurable) |
| Input | Whole rendered page + embedded text hint |
| Revision matching | Model-driven (`match-sheet`), user confirms |
| Import trigger | Auto-run on every page (with progress) |
| Review UX | Existing `PageNamingStep`, AI badge + confidence, amber nudge |
| Model weights | Downloaded to mounted `/models` volume at runtime |
| Fallback | Current OCR + manual region / manual dropdown |
