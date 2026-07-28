# AI-Assisted Sheet Reading & Revision Matching — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bundled, local GPU vision model that reads each full plan sheet for its number/description and matches new pages to existing sheets when adding a plan set, prefilling the existing review UI (user confirms), with a clean fallback to today's OCR flow when the model is unavailable.

**Architecture:** A server-side `AiRunner` (node-llama-cpp + Qwen2.5-VL-3B GGUF on CUDA) sits behind a small interface so all surrounding logic is unit-testable with a fake. Pure modules (prompt build/parse, single-flight queue, route handlers) are TDD'd; the real runner and Docker/CUDA are verified manually on the GPU host. The client auto-runs reads/matches during import through same-origin `/api/ai/*` endpoints and prefills `PageNamingStep`.

**Tech Stack:** Node/Express + better-sqlite3, node-llama-cpp (CUDA), Qwen2.5-VL-3B-Instruct GGUF, React 19 + Vite, Vitest, existing `server/files.ts`/`server/fileStore.ts` file storage and `PageNamingStep` review UI.

**Reference reading (before starting):**
- Spec: `docs/superpowers/specs/2026-07-02-ai-sheet-reading-design.md`
- Route/registration pattern: `server/routes.ts` (`registerDataRoutes`, `registerEmailRoutes`), and `server.ts:157` where they're wired with `{ db, dataDir, dbFile, authenticateToken, requireAdmin, verifyToken }`.
- Image bytes on disk: `server/fileStore.ts` (`readFileContent(dataDir, id): Buffer | null`).
- Review model: `src/components/PageNamingStep.tsx` (`NamingStepPage`, `ExistingSheet`, `matchSheetId`).
- Import prefill today: `src/pages/NewProject.tsx` (`detectPageInfo` → `pendingPages`) and `src/components/AddPagesModal.tsx`.

**Conventions:** `npm test` runs `vitest run`. Tests are colocated `*.test.ts`. Push to the `testing` branch only; do not open PRs unless asked (per `CLAUDE.md`).

---

## File Structure

**Phase 1 — server (all new unless noted):**
- `server/ai/types.ts` — `SheetRead`, `SheetMatch`, `ExistingSheetRef`, `AiInfo`, `AiRunner` interface.
- `server/ai/prompt.ts` — pure: `buildReadPrompt`, `parseReadResponse`, `buildMatchPrompt`, `parseMatchResponse`, normalization.
- `server/ai/queue.ts` — pure: `createSingleFlightQueue({ timeoutMs })`.
- `server/ai/disabledRunner.ts` — `createDisabledRunner(): AiRunner` (always unavailable).
- `server/ai/handlers.ts` — pure request handlers: `handleStatus`, `handleReadSheet`, `handleMatchSheet` (take a runner + an image loader; no Express types).
- `server/ai/runner.ts` — real `AiRunner` (node-llama-cpp, CUDA). Manual verification.
- `server/ai/index.ts` — `getAiRunner(env): AiRunner` singleton factory (real or disabled).
- `server/aiRoutes.ts` — `registerAiRoutes(app, deps)` thin Express wrappers around handlers.
- `server.ts` — MODIFY: wire `registerAiRoutes`.
- `Dockerfile` — MODIFY: CUDA build arg + node-llama-cpp CUDA + `/models` volume.
- `docs/ai-sheet-reading-runbook.md` — new ops doc.

**Phase 2 — client:**
- `src/utils/aiSheets.ts` — `getAiStatus`, `readSheet`, `matchSheet`, `runWithConcurrency`, `applyReadToPage`, `applyMatchToPage`, `aiAutoNameEnabled`.
- `src/components/PageNamingStep.tsx` — MODIFY: AI badge + confidence per row.
- `src/pages/NewProject.tsx` — MODIFY: auto-run AI read during import.
- `src/components/AddPagesModal.tsx` — MODIFY: auto-run AI read + match during add-set.
- `src/pages/Settings.tsx` — MODIFY: "AI Sheet Reading" section.

---

# PHASE 1 — Server inference, endpoints, graceful disable, Docker/CUDA

## Task 1: Shared AI types

**Files:**
- Create: `server/ai/types.ts`

- [ ] **Step 1: Write the types**

```ts
// server/ai/types.ts
// Shared types for the local AI sheet-reading feature. Kept dependency-free so
// both the pure logic (prompt/handlers) and the real runner import them.

/** Result of reading one plan sheet. */
export interface SheetRead {
  /** Sheet identifier, normalized upper-case (e.g. "A-201", "S1.1"). '' if unknown. */
  sheetNumber: string;
  /** Sheet title/description (e.g. "SECOND FLOOR PLAN"). '' if unknown. */
  sheetTitle: string;
  /** Discipline label if the model inferred one (e.g. "Architectural"). Optional. */
  discipline?: string;
  /** Model confidence, clamped to 0..1. */
  confidence: number;
}

/** An existing logical sheet a new page can be matched against. */
export interface ExistingSheetRef {
  sheetId: string;
  number: string;
  title: string;
}

/** Result of matching a new page against existing sheets. */
export interface SheetMatch {
  /** A sheetId from the provided list, or null for "new sheet". */
  matchSheetId: string | null;
  confidence: number;
  reason?: string;
}

/** Capability/info for the status endpoint. */
export interface AiInfo {
  model: string;
  device: 'cuda' | 'cpu' | 'none';
}

/** The inference boundary. Faked in tests; real impl in runner.ts. */
export interface AiRunner {
  available(): Promise<boolean>;
  info(): AiInfo;
  readSheet(input: { image: Buffer; embeddedText?: string }): Promise<SheetRead>;
  matchSheet(input: { page: SheetRead; existing: ExistingSheetRef[] }): Promise<SheetMatch>;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/ai/types.ts
git commit -m "feat(ai): shared types for sheet reading"
```

---

## Task 2: Prompt building + response parsing (pure)

**Files:**
- Create: `server/ai/prompt.ts`
- Test: `server/ai/prompt.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// server/ai/prompt.test.ts
import { describe, it, expect } from 'vitest';
import { buildReadPrompt, parseReadResponse, buildMatchPrompt, parseMatchResponse } from './prompt';

describe('buildReadPrompt', () => {
  it('asks for strict JSON and mentions sheet number + title', () => {
    const p = buildReadPrompt();
    expect(p).toMatch(/JSON/i);
    expect(p).toMatch(/sheetNumber/);
    expect(p).toMatch(/sheetTitle/);
  });
  it('includes the embedded text hint when provided', () => {
    const p = buildReadPrompt('A-201 SECOND FLOOR PLAN');
    expect(p).toContain('A-201 SECOND FLOOR PLAN');
  });
  it('omits the hint section when there is no embedded text', () => {
    expect(buildReadPrompt('')).not.toMatch(/reference text/i);
  });
});

describe('parseReadResponse', () => {
  it('parses clean JSON and upper-cases/trims the number', () => {
    const r = parseReadResponse('{"sheetNumber":" a-201 ","sheetTitle":"Second Floor Plan","discipline":"Architectural","confidence":0.9}');
    expect(r).toEqual({ sheetNumber: 'A-201', sheetTitle: 'Second Floor Plan', discipline: 'Architectural', confidence: 0.9 });
  });
  it('extracts JSON embedded in prose', () => {
    const r = parseReadResponse('Sure! Here you go:\n{"sheetNumber":"S1.1","sheetTitle":"Foundation Plan","confidence":0.8}\nHope that helps.');
    expect(r.sheetNumber).toBe('S1.1');
    expect(r.sheetTitle).toBe('Foundation Plan');
  });
  it('clamps confidence to 0..1', () => {
    expect(parseReadResponse('{"sheetNumber":"A1","sheetTitle":"x","confidence":5}').confidence).toBe(1);
    expect(parseReadResponse('{"sheetNumber":"A1","sheetTitle":"x","confidence":-3}').confidence).toBe(0);
  });
  it('returns a low-confidence empty read on unparseable output', () => {
    expect(parseReadResponse('the model said nothing useful')).toEqual({ sheetNumber: '', sheetTitle: '', confidence: 0 });
  });
});

describe('buildMatchPrompt', () => {
  it('lists existing sheets by id/number/title and the new page', () => {
    const p = buildMatchPrompt(
      { sheetNumber: 'A-201', sheetTitle: 'Second Floor Plan', confidence: 0.9 },
      [{ sheetId: 's1', number: 'A-101', title: 'First Floor Plan' }, { sheetId: 's2', number: 'A-201', title: 'Second Floor' }],
    );
    expect(p).toContain('s1');
    expect(p).toContain('A-101');
    expect(p).toContain('Second Floor Plan');
    expect(p).toMatch(/"new"/);
  });
});

describe('parseMatchResponse', () => {
  const ids = ['s1', 's2'];
  it('accepts a valid id', () => {
    expect(parseMatchResponse('{"matchSheetId":"s2","confidence":0.95}', ids)).toEqual({ matchSheetId: 's2', confidence: 0.95, reason: undefined });
  });
  it('maps "new" / unknown ids to null', () => {
    expect(parseMatchResponse('{"matchSheetId":"new","confidence":0.7}', ids).matchSheetId).toBeNull();
    expect(parseMatchResponse('{"matchSheetId":"HALLUCINATED","confidence":0.7}', ids).matchSheetId).toBeNull();
  });
  it('keeps a short reason and clamps confidence', () => {
    const r = parseMatchResponse('{"matchSheetId":"s1","confidence":2,"reason":"same number"}', ids);
    expect(r).toEqual({ matchSheetId: 's1', confidence: 1, reason: 'same number' });
  });
  it('returns null match on unparseable output', () => {
    expect(parseMatchResponse('nonsense', ids)).toEqual({ matchSheetId: null, confidence: 0, reason: undefined });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run server/ai/prompt.test.ts`
Expected: FAIL ("Cannot find module './prompt'").

- [ ] **Step 3: Implement**

```ts
// server/ai/prompt.ts
import type { SheetRead, SheetMatch, ExistingSheetRef } from './types';

/** Pull the first balanced JSON object out of a string, tolerant of surrounding prose. */
function extractJson(raw: string): any | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === '{') depth++;
    else if (raw[i] === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(raw.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

const clamp01 = (n: unknown): number => {
  const v = typeof n === 'number' && isFinite(n) ? n : 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
};

export function buildReadPrompt(embeddedText?: string): string {
  const hint = embeddedText && embeddedText.trim()
    ? `\n\nFor reference, here is text extracted from the drawing's PDF layer (may be noisy or incomplete). Prefer it when it agrees with what you see:\n"""${embeddedText.trim().slice(0, 2000)}"""`
    : '';
  return (
    `You are reading a single sheet from a set of construction/architectural drawings. ` +
    `Identify the sheet's number and its title from anywhere on the page (often but not always in a title block along an edge). ` +
    `The sheet number is the drawing identifier such as "A-201", "S1.1", "M-2.0", or "E001". ` +
    `The title is the sheet's name such as "SECOND FLOOR PLAN" or "ROOF DETAILS". ` +
    `Respond with ONLY a JSON object, no prose, exactly of the form ` +
    `{"sheetNumber": string, "sheetTitle": string, "discipline": string, "confidence": number between 0 and 1}. ` +
    `Use empty strings when unsure and a low confidence.` +
    hint
  );
}

export function parseReadResponse(raw: string): SheetRead {
  const obj = extractJson(raw);
  if (!obj) return { sheetNumber: '', sheetTitle: '', confidence: 0 };
  const sheetNumber = String(obj.sheetNumber ?? '').trim().toUpperCase();
  const sheetTitle = String(obj.sheetTitle ?? '').trim();
  const discipline = obj.discipline ? String(obj.discipline).trim() : undefined;
  return { sheetNumber, sheetTitle, discipline, confidence: clamp01(obj.confidence) };
}

export function buildMatchPrompt(page: SheetRead, existing: ExistingSheetRef[]): string {
  const list = existing.map(e => `- id="${e.sheetId}" number="${e.number}" title="${e.title}"`).join('\n');
  return (
    `You are matching a new drawing sheet against an existing set to decide if it is a REVISION of one of them ` +
    `(the same logical sheet re-issued) or a brand new sheet. Sheet numbers or titles may have changed slightly between revisions.\n\n` +
    `New sheet: number="${page.sheetNumber}" title="${page.sheetTitle}"${page.discipline ? ` discipline="${page.discipline}"` : ''}\n\n` +
    `Existing sheets:\n${list || '(none)'}\n\n` +
    `Respond with ONLY a JSON object of the form ` +
    `{"matchSheetId": string, "confidence": number, "reason": string}, ` +
    `where matchSheetId is one of the ids above if this is a revision of that sheet, or the literal "new" if it is a new sheet.`
  );
}

export function parseMatchResponse(raw: string, validIds: string[]): SheetMatch {
  const obj = extractJson(raw);
  if (!obj) return { matchSheetId: null, confidence: 0, reason: undefined };
  const id = String(obj.matchSheetId ?? '').trim();
  const matchSheetId = validIds.includes(id) ? id : null;
  const reason = obj.reason ? String(obj.reason).trim().slice(0, 200) : undefined;
  return { matchSheetId, confidence: clamp01(obj.confidence), reason };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run server/ai/prompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/ai/prompt.ts server/ai/prompt.test.ts
git commit -m "feat(ai): prompt builders + tolerant JSON parsers"
```

---

## Task 3: Single-flight queue (pure)

**Files:**
- Create: `server/ai/queue.ts`
- Test: `server/ai/queue.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// server/ai/queue.test.ts
import { describe, it, expect } from 'vitest';
import { createSingleFlightQueue } from './queue';

const deferred = () => { let resolve!: (v: any) => void; const p = new Promise(r => (resolve = r)); return { p, resolve }; };

describe('createSingleFlightQueue', () => {
  it('runs tasks one at a time in order', async () => {
    const q = createSingleFlightQueue({ timeoutMs: 1000 });
    const order: number[] = [];
    const running: number[] = [];
    const make = (n: number) => async () => {
      running.push(n);
      expect(running.length).toBe(1); // never two at once
      await new Promise(r => setTimeout(r, 5));
      running.pop();
      order.push(n);
      return n;
    };
    const results = await Promise.all([q.enqueue(make(1)), q.enqueue(make(2)), q.enqueue(make(3))]);
    expect(results).toEqual([1, 2, 3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('rejects a task that exceeds the timeout but keeps the queue alive', async () => {
    const q = createSingleFlightQueue({ timeoutMs: 20 });
    await expect(q.enqueue(() => new Promise(() => {}))).rejects.toThrow(/tim)/i);
    await expect(q.enqueue(async () => 'ok')).resolves.toBe('ok');
  });

  it('a rejecting task does not block the next', async () => {
    const q = createSingleFlightQueue({ timeoutMs: 1000 });
    await expect(q.enqueue(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(q.enqueue(async () => 42)).resolves.toBe(42);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run server/ai/queue.test.ts`
Expected: FAIL ("Cannot find module './queue'").

- [ ] **Step 3: Implement**

```ts
// server/ai/queue.ts
// Serializes async tasks so only one runs at a time (one GPU context), with a
// per-task timeout. A slow/failed task never wedges the queue.

export interface SingleFlightQueue {
  enqueue<T>(fn: () => Promise<T>): Promise<T>;
}

export function createSingleFlightQueue({ timeoutMs }: { timeoutMs: number }): SingleFlightQueue {
  let tail: Promise<unknown> = Promise.resolve();

  function withTimeout<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`ai task timed out after ${timeoutMs}ms`)), timeoutMs);
      Promise.resolve()
        .then(fn)
        .then(v => { clearTimeout(timer); resolve(v); })
        .catch(e => { clearTimeout(timer); reject(e); });
    });
  }

  return {
    enqueue<T>(fn: () => Promise<T>): Promise<T> {
      const run = tail.then(() => withTimeout(fn), () => withTimeout(fn));
      // Keep the chain alive regardless of this task's outcome.
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run server/ai/queue.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/ai/queue.ts server/ai/queue.test.ts
git commit -m "feat(ai): single-flight queue with per-task timeout"
```

---

## Task 4: Disabled runner (pure)

**Files:**
- Create: `server/ai/disabledRunner.ts`
- Test: `server/ai/disabledRunner.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// server/ai/disabledRunner.test.ts
import { describe, it, expect } from 'vitest';
import { createDisabledRunner } from './disabledRunner';

describe('createDisabledRunner', () => {
  it('is never available and reports device "none"', async () => {
    const r = createDisabledRunner('disabled by config');
    expect(await r.available()).toBe(false);
    expect(r.info()).toEqual({ model: 'disabled by config', device: 'none' });
  });
  it('rejects readSheet and matchSheet', async () => {
    const r = createDisabledRunner();
    await expect(r.readSheet({ image: Buffer.from('') })).rejects.toThrow(/unavailable/i);
    await expect(r.matchSheet({ page: { sheetNumber: '', sheetTitle: '', confidence: 0 }, existing: [] })).rejects.toThrow(/unavailable/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run server/ai/disabledRunner.test.ts`
Expected: FAIL ("Cannot find module './disabledRunner'").

- [ ] **Step 3: Implement**

```ts
// server/ai/disabledRunner.ts
import type { AiRunner } from './types';

/** A runner used when AI is disabled or the model failed to load. */
export function createDisabledRunner(reason = 'disabled'): AiRunner {
  const unavailable = () => Promise.reject(new Error('ai runner unavailable'));
  return {
    available: () => Promise.resolve(false),
    info: () => ({ model: reason, device: 'none' }),
    readSheet: unavailable,
    matchSheet: unavailable,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run server/ai/disabledRunner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/ai/disabledRunner.ts server/ai/disabledRunner.test.ts
git commit -m "feat(ai): disabled runner stub"
```

---

## Task 5: Pure request handlers

**Files:**
- Create: `server/ai/handlers.ts`
- Test: `server/ai/handlers.test.ts`

**Context:** Handlers are framework-free so they can be unit-tested with a fake runner and a fake image loader. Express wiring comes in Task 6. Each handler returns `{ status: number; body: unknown }`.

- [ ] **Step 1: Write the failing tests**

```ts
// server/ai/handlers.test.ts
import { describe, it, expect } from 'vitest';
import { handleStatus, handleReadSheet, handleMatchSheet } from './handlers';
import type { AiRunner, SheetRead, SheetMatch } from './types';

const okRead: SheetRead = { sheetNumber: 'A-201', sheetTitle: 'Second Floor Plan', confidence: 0.9 };
const okMatch: SheetMatch = { matchSheetId: 's2', confidence: 0.8 };

const fakeRunner = (over: Partial<AiRunner> = {}): AiRunner => ({
  available: () => Promise.resolve(true),
  info: () => ({ model: 'fake', device: 'cuda' }),
  readSheet: () => Promise.resolve(okRead),
  matchSheet: () => Promise.resolve(okMatch),
  ...over,
});

const loadImage = (id: string) => (id === 'img1' ? Buffer.from('jpeg') : null);

describe('handleStatus', () => {
  it('reports availability + info', async () => {
    expect(await handleStatus(fakeRunner())).toEqual({ status: 200, body: { available: true, model: 'fake', device: 'cuda' } });
  });
});

describe('handleReadSheet', () => {
  it('503 when runner unavailable', async () => {
    const r = await handleReadSheet(fakeRunner({ available: () => Promise.resolve(false) }), loadImage, { imageId: 'img1' });
    expect(r.status).toBe(503);
  });
  it('reads from a stored imageId', async () => {
    const r = await handleReadSheet(fakeRunner(), loadImage, { imageId: 'img1', embeddedText: 'x' });
    expect(r).toEqual({ status: 200, body: okRead });
  });
  it('reads from inline base64 when no id', async () => {
    const b64 = Buffer.from('jpeg').toString('base64');
    const r = await handleReadSheet(fakeRunner(), loadImage, { imageBase64: `data:image/jpeg;base64,${b64}` });
    expect(r.status).toBe(200);
  });
  it('400 when neither image source is provided', async () => {
    const r = await handleReadSheet(fakeRunner(), loadImage, {});
    expect(r.status).toBe(400);
  });
  it('404 when the imageId is unknown', async () => {
    const r = await handleReadSheet(fakeRunner(), loadImage, { imageId: 'nope' });
    expect(r.status).toBe(404);
  });
  it('502 when the model throws', async () => {
    const r = await handleReadSheet(fakeRunner({ readSheet: () => Promise.reject(new Error('boom')) }), loadImage, { imageId: 'img1' });
    expect(r.status).toBe(502);
  });
});

describe('handleMatchSheet', () => {
  it('503 when unavailable', async () => {
    const r = await handleMatchSheet(fakeRunner({ available: () => Promise.resolve(false) }), { page: okRead, existingSheets: [] });
    expect(r.status).toBe(503);
  });
  it('400 when page missing', async () => {
    const r = await handleMatchSheet(fakeRunner(), { existingSheets: [] } as any);
    expect(r.status).toBe(400);
  });
  it('returns the match', async () => {
    const r = await handleMatchSheet(fakeRunner(), { page: okRead, existingSheets: [{ sheetId: 's2', number: 'A-201', title: 'x' }] });
    expect(r).toEqual({ status: 200, body: okMatch });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run server/ai/handlers.test.ts`
Expected: FAIL ("Cannot find module './handlers'").

- [ ] **Step 3: Implement**

```ts
// server/ai/handlers.ts
import type { AiRunner, ExistingSheetRef, SheetRead } from './types';

export interface HandlerResult { status: number; body: unknown; }

/** Loader maps an image id to its bytes on disk (null if missing). */
export type ImageLoader = (id: string) => Buffer | null;

export async function handleStatus(runner: AiRunner): Promise<HandlerResult> {
  const available = await runner.available().catch(() => false);
  const info = runner.info();
  return { status: 200, body: { available, model: info.model, device: info.device } };
}

function decodeBase64Image(input: string): Buffer | null {
  const comma = input.indexOf(',');
  const b64 = input.startsWith('data:') && comma >= 0 ? input.slice(comma + 1) : input;
  try { const buf = Buffer.from(b64, 'base64'); return buf.length ? buf : null; } catch { return null; }
}

export async function handleReadSheet(
  runner: AiRunner,
  loadImage: ImageLoader,
  body: { imageId?: string; imageBase64?: string; embeddedText?: string },
): Promise<HandlerResult> {
  if (!(await runner.available().catch(() => false))) return { status: 503, body: { error: 'ai unavailable' } };

  let image: Buffer | null = null;
  if (body.imageId) {
    image = loadImage(body.imageId);
    if (!image) return { status: 404, body: { error: 'image not found' } };
  } else if (body.imageBase64) {
    image = decodeBase64Image(body.imageBase64);
    if (!image) return { status: 400, body: { error: 'bad imageBase64' } };
  } else {
    return { status: 400, body: { error: 'imageId or imageBase64 required' } };
  }

  try {
    const read = await runner.readSheet({ image, embeddedText: body.embeddedText });
    return { status: 200, body: read };
  } catch (e: any) {
    return { status: 502, body: { error: String(e?.message ?? e) } };
  }
}

export async function handleMatchSheet(
  runner: AiRunner,
  body: { page?: SheetRead; existingSheets?: ExistingSheetRef[] },
): Promise<HandlerResult> {
  if (!(await runner.available().catch(() => false))) return { status: 503, body: { error: 'ai unavailable' } };
  if (!body.page) return { status: 400, body: { error: 'page required' } };
  const existing = Array.isArray(body.existingSheets) ? body.existingSheets : [];
  try {
    const match = await runner.matchSheet({ page: body.page, existing });
    return { status: 200, body: match };
  } catch (e: any) {
    return { status: 502, body: { error: String(e?.message ?? e) } };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run server/ai/handlers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/ai/handlers.ts server/ai/handlers.test.ts
git commit -m "feat(ai): framework-free request handlers"
```

---

## Task 6: Real runner, factory, Express routes, server wiring

**Files:**
- Create: `server/ai/runner.ts`, `server/ai/index.ts`, `server/aiRoutes.ts`
- Modify: `server.ts`
- Add dependency: `node-llama-cpp`

**Note on verification:** `runner.ts` needs the GPU/model and cannot be unit-tested in CI. Verify it manually on the GPU host (Step 7). The rest of the system already works via the fake runner (Tasks 1–5), so this task only adds the real backend + wiring.

- [ ] **Step 1: Confirm the node-llama-cpp multimodal API**

Use the `document-specialist` agent (or read `node_modules/node-llama-cpp` docs) to confirm, for the installed version, how to: load a model with `gpuLayers`, load a paired vision projector (mmproj), and pass an image + text prompt to get a completion. Record the exact calls used in `runner.ts`. If the installed version cannot do Qwen2.5-VL vision, switch the default model files to MiniCPM-V 2.6 (same interface) per the spec's open item.

Run: `npm install node-llama-cpp`
Expected: installs; note the resolved version.

- [ ] **Step 2: Implement the real runner**

```ts
// server/ai/runner.ts
// Real AiRunner backed by node-llama-cpp on CUDA. Loads lazily on first use and
// serializes calls through the single-flight queue. Any load/inference failure
// degrades to "unavailable" rather than throwing at import time.
//
// The exact multimodal calls (loadModel / mmproj / image input) must match the
// installed node-llama-cpp version — confirm in Step 1 and adjust `infer()`.
import { readFileSync } from 'node:fs';
import type { AiRunner, AiInfo, SheetRead, SheetMatch, ExistingSheetRef } from './types';
import { createSingleFlightQueue } from './queue';
import { buildReadPrompt, parseReadResponse, buildMatchPrompt, parseMatchResponse } from './prompt';

export interface RunnerConfig {
  modelPath: string;      // absolute path to the GGUF model
  mmprojPath: string;     // absolute path to the vision projector GGUF
  gpuLayers: number;      // -1 / large = all on GPU
  timeoutMs: number;
  modelLabel: string;     // shown in /status
}

export function createLlamaRunner(cfg: RunnerConfig): AiRunner {
  const queue = createSingleFlightQueue({ timeoutMs: cfg.timeoutMs });
  let device: AiInfo['device'] = 'cpu';
  let loadPromise: Promise<any> | null = null;
  let loadFailed = false;

  // Lazily import + load. Returns an object exposing a `complete(prompt, image?)`.
  async function ensureLoaded(): Promise<any> {
    if (loadFailed) throw new Error('ai model failed to load');
    if (!loadPromise) {
      loadPromise = (async () => {
        // Dynamic import so a missing/native-broken dep can't crash server start.
        const mod: any = await import('node-llama-cpp');
        const llama = await mod.getLlama();
        device = llama?.gpu ? 'cuda' : 'cpu';
        const model = await llama.loadModel({ modelPath: cfg.modelPath, gpuLayers: cfg.gpuLayers });
        // NOTE: confirm the vision-projector + image-input API for the installed
        // version in Step 1 and wire it here. Shape of `complete`:
        //   complete(prompt: string, image?: Buffer) => Promise<string>
        const ctx = await model.createContext();
        return {
          async complete(prompt: string, image?: Buffer): Promise<string> {
            const session = new mod.LlamaChatSession({ contextSequence: ctx.getSequence() });
            const opts: any = { maxTokens: 256, temperature: 0 };
            if (image) opts.images = [image]; // adjust per confirmed API
            return session.prompt(prompt, opts);
          },
        };
      })().catch(err => { loadFailed = true; throw err; });
    }
    return loadPromise;
  }

  return {
    async available(): Promise<boolean> {
      try { await ensureLoaded(); return true; } catch { return false; }
    },
    info(): AiInfo { return { model: cfg.modelLabel, device }; },
    async readSheet({ image, embeddedText }): Promise<SheetRead> {
      const engine = await ensureLoaded();
      const raw = await queue.enqueue(() => engine.complete(buildReadPrompt(embeddedText), image));
      return parseReadResponse(raw);
    },
    async matchSheet({ page, existing }: { page: SheetRead; existing: ExistingSheetRef[] }): Promise<SheetMatch> {
      const engine = await ensureLoaded();
      const raw = await queue.enqueue(() => engine.complete(buildMatchPrompt(page, existing)));
      return parseMatchResponse(raw, existing.map(e => e.sheetId));
    },
  };
}
```

- [ ] **Step 3: Implement the factory**

```ts
// server/ai/index.ts
import path from 'node:path';
import { existsSync } from 'node:fs';
import type { AiRunner } from './types';
import { createDisabledRunner } from './disabledRunner';
import { createLlamaRunner } from './runner';

let singleton: AiRunner | null = null;

/** Build (once) the AiRunner from env. Falls back to the disabled runner when
 *  AI is turned off or the configured model files are absent. */
export function getAiRunner(env: NodeJS.ProcessEnv = process.env): AiRunner {
  if (singleton) return singleton;
  if (env.AI_ENABLED === 'false' || env.AI_ENABLED === '0') {
    singleton = createDisabledRunner('disabled by AI_ENABLED');
    return singleton;
  }
  const modelsDir = env.AI_MODELS_DIR || '/models';
  const modelPath = env.AI_MODEL_PATH || path.join(modelsDir, env.AI_MODEL_FILE || 'qwen2.5-vl-3b-instruct-q4_k_m.gguf');
  const mmprojPath = env.AI_MMPROJ_PATH || path.join(modelsDir, env.AI_MMPROJ_FILE || 'qwen2.5-vl-3b-instruct-mmproj-f16.gguf');
  if (!existsSync(modelPath) || !existsSync(mmprojPath)) {
    singleton = createDisabledRunner('model files not found');
    return singleton;
  }
  singleton = createLlamaRunner({
    modelPath,
    mmprojPath,
    gpuLayers: Number(env.AI_GPU_LAYERS ?? -1),
    timeoutMs: Number(env.AI_TIMEOUT_MS ?? 30000),
    modelLabel: env.AI_MODEL_FILE || 'qwen2.5-vl-3b-instruct',
  });
  return singleton;
}
```

- [ ] **Step 4: Implement the Express routes**

```ts
// server/aiRoutes.ts
import type express from 'express';
import { readFileContent } from './fileStore';
import { handleStatus, handleReadSheet, handleMatchSheet } from './ai/handlers';
import type { AiRunner } from './ai/types';

export interface AiRouteDeps {
  dataDir: string;
  authenticateToken: express.RequestHandler;
  runner: AiRunner;
}

export function registerAiRoutes(app: express.Express, deps: AiRouteDeps): void {
  const { dataDir, authenticateToken, runner } = deps;
  const loadImage = (id: string) => readFileContent(dataDir, id);

  app.get('/api/ai/status', authenticateToken, async (_req, res) => {
    const r = await handleStatus(runner);
    res.status(r.status).json(r.body);
  });

  app.post('/api/ai/read-sheet', authenticateToken, async (req, res) => {
    const r = await handleReadSheet(runner, loadImage, req.body || {});
    res.status(r.status).json(r.body);
  });

  app.post('/api/ai/match-sheet', authenticateToken, async (req, res) => {
    const r = await handleMatchSheet(runner, req.body || {});
    res.status(r.status).json(r.body);
  });
}
```

- [ ] **Step 5: Wire into `server.ts`**

Add the import near the other route imports (`server.ts:19`):

```ts
import { registerAiRoutes } from './server/aiRoutes';
import { getAiRunner } from './server/ai';
```

After the `registerEmailRoutes(app, { ... })` call (around `server.ts:541`), add:

```ts
  registerAiRoutes(app, {
    dataDir: DATA_DIR,
    authenticateToken,
    runner: getAiRunner(),
  });
```

- [ ] **Step 6: Type-check + full test run (fake-runner suite still green)**

Run: `npx tsc --noEmit && npx vitest run server/ai`
Expected: no type errors; all `server/ai/*.test.ts` pass. (No GPU exercised — the real runner isn't invoked by tests.)

- [ ] **Step 7: Manual GPU smoke (on the host with the 5070)**

With the model files present in `/models` and the container built with CUDA (Task 7):

```bash
# from an authenticated session; TOKEN = a valid JWT
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3331/api/ai/status
# → {"available":true,"model":"qwen2.5-vl-3b-instruct","device":"cuda"}

curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"imageId":"<a real page imageId>"}' http://localhost:3331/api/ai/read-sheet
# → {"sheetNumber":"A-201","sheetTitle":"...","confidence":0.x}
```

Expected: `available:true`, `device:"cuda"`, and a plausible read on a real sheet. If `available:false`, check model paths + CUDA build.

- [ ] **Step 8: Commit**

```bash
git add server/ai/runner.ts server/ai/index.ts server/aiRoutes.ts server.ts package.json package-lock.json
git commit -m "feat(ai): node-llama-cpp runner, factory, and /api/ai routes"
```

---

## Task 7: Docker/CUDA build + model volume + runbook

**Files:**
- Modify: `Dockerfile`
- Create: `docs/ai-sheet-reading-runbook.md`

**Note:** Infra task, verified by building/running the image on the GPU host, not by CI.

- [ ] **Step 1: Add a CUDA build path to the Dockerfile**

Read the current `Dockerfile` first. Introduce a build arg so CPU-only builds still succeed (feature auto-disabled at runtime via the factory):

```dockerfile
# Toggle the GPU build. Default off so CPU-only/CI builds are unaffected.
ARG WITH_CUDA=0
ENV WITH_CUDA=${WITH_CUDA}

# When WITH_CUDA=1, ensure CUDA runtime libraries are present in the final image
# (base image or apt) and let node-llama-cpp build its CUDA backend on install:
#   ENV NODE_LLAMA_CPP_CUDA=1   # (name per the confirmed node-llama-cpp version)
# Model weights are NOT baked in; they load at runtime from the mounted volume.
VOLUME ["/models"]
ENV AI_MODELS_DIR=/models
```

Follow the node-llama-cpp docs (from Task 6 Step 1) for the exact env/flags that force a CUDA build, and match the CUDA version to the RTX 5070 (Blackwell → CUDA 12.x).

- [ ] **Step 2: Write the runbook**

```markdown
# AI Sheet Reading — Ops Runbook

## What it is
A local vision model (default Qwen2.5-VL-3B GGUF) runs on the server GPU to read
plan-sheet numbers/titles and match revisions. Fully local; no external calls.

## Requirements
- NVIDIA GPU (tested: RTX 5070) with the NVIDIA Container Toolkit configured.
- Image built with `--build-arg WITH_CUDA=1`.
- A host directory mounted at `/models`.

## First-time setup
1. Create a models dir on the host and mount it to `/models`.
2. Download the model + vision projector GGUF into it:
   - `qwen2.5-vl-3b-instruct-q4_k_m.gguf`
   - `qwen2.5-vl-3b-instruct-mmproj-f16.gguf`
   (Exact filenames must match `AI_MODEL_FILE` / `AI_MMPROJ_FILE`.)
3. Run the container with GPU access (e.g. `--gpus all`).

## Config (env)
- `AI_ENABLED` (default on; set `false` to disable)
- `AI_MODELS_DIR` (default `/models`), `AI_MODEL_FILE`, `AI_MMPROJ_FILE`
- `AI_GPU_LAYERS` (default all), `AI_TIMEOUT_MS` (default 30000)

## Verify
`GET /api/ai/status` → `{"available":true,"device":"cuda"}`.
If `available:false`: confirm model files exist in `/models`, the image was built
with CUDA, and the container sees the GPU (`nvidia-smi` inside the container).

## Fallback
If unavailable, the app silently uses the existing OCR + manual-region naming.
```

- [ ] **Step 3: Manual verification (GPU host)**

Build with `--build-arg WITH_CUDA=1`, mount `/models` with the weights, start with `--gpus all`, and confirm `/api/ai/status` returns `device:"cuda"`. Confirm a CPU-only build (default args) starts fine and `/api/ai/status` returns `available:false`.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile docs/ai-sheet-reading-runbook.md
git commit -m "feat(ai): CUDA build arg, /models volume, ops runbook"
```

---

# PHASE 2 — Client wiring (depends on Phase 1 endpoints)

## Task 8: Client AI helpers + pure apply functions

**Files:**
- Create: `src/utils/aiSheets.ts`
- Test: `src/utils/aiSheets.test.ts`

**Context:** `getAuthHeaders` lives in `src/utils/store.ts`. `runWithConcurrency` bounds parallel reads. `applyReadToPage` / `applyMatchToPage` are pure so they can be unit-tested and reused by both import flows.

- [ ] **Step 1: Write the failing tests**

```ts
// src/utils/aiSheets.test.ts
import { describe, it, expect } from 'vitest';
import { runWithConcurrency, applyReadToPage, applyMatchToPage } from './aiSheets';

describe('runWithConcurrency', () => {
  it('runs all items, never exceeding the limit, preserving order', async () => {
    let active = 0, maxActive = 0;
    const work = (n: number) => async () => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 3));
      active--; return n * 2;
    };
    const results = await runWithConcurrency([1, 2, 3, 4, 5].map(work), 2);
    expect(results).toEqual([2, 4, 6, 8, 10]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});

describe('applyReadToPage', () => {
  const base = { id: 'p1', name: 'Page 1', pageNumber: '', description: '', detectionConfidence: 'low' as const };
  it('fills number/description/name from a confident read', () => {
    const out = applyReadToPage(base, { sheetNumber: 'A-201', sheetTitle: 'Second Floor Plan', confidence: 0.9 });
    expect(out.pageNumber).toBe('A-201');
    expect(out.description).toBe('Second Floor Plan');
    expect(out.name).toBe('A-201 - Second Floor Plan');
    expect(out.aiConfidence).toBe(0.9);
    expect(out.detectionConfidence).toBe('high');
  });
  it('marks low detectionConfidence when the read is weak', () => {
    const out = applyReadToPage(base, { sheetNumber: 'A1', sheetTitle: '', confidence: 0.2 });
    expect(out.detectionConfidence).toBe('low');
  });
  it('leaves the page unchanged when the read is empty', () => {
    const out = applyReadToPage(base, { sheetNumber: '', sheetTitle: '', confidence: 0 });
    expect(out).toEqual(base);
  });
});

describe('applyMatchToPage', () => {
  const base = { id: 'p1', name: 'A-201', pageNumber: 'A-201', description: '', detectionConfidence: 'high' as const };
  it('sets matchSheetId from a confident match', () => {
    expect(applyMatchToPage(base, { matchSheetId: 's2', confidence: 0.9 }).matchSheetId).toBe('s2');
  });
  it('sets New sheet ("") when the match is null', () => {
    expect(applyMatchToPage(base, { matchSheetId: null, confidence: 0.9 }).matchSheetId).toBe('');
  });
  it('does not override when confidence is below 0.5', () => {
    expect(applyMatchToPage(base, { matchSheetId: 's2', confidence: 0.3 }).matchSheetId).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/utils/aiSheets.test.ts`
Expected: FAIL ("Cannot find module './aiSheets'").

- [ ] **Step 3: Implement**

```ts
// src/utils/aiSheets.ts
import { getAuthHeaders } from './store';

export interface SheetRead { sheetNumber: string; sheetTitle: string; discipline?: string; confidence: number; }
export interface SheetMatch { matchSheetId: string | null; confidence: number; reason?: string; }
export interface AiStatus { available: boolean; model: string; device: string; }
export interface ExistingSheetRef { sheetId: string; number: string; title: string; }

/** Minimal shape of a review page the apply helpers touch. */
export interface AiPage {
  id: string;
  name: string;
  pageNumber?: string;
  description?: string;
  detectionConfidence?: 'high' | 'low';
  matchSheetId?: string;
  aiConfidence?: number;
}

let statusCache: AiStatus | null = null;

export async function getAiStatus(force = false): Promise<AiStatus> {
  if (statusCache && !force) return statusCache;
  try {
    const res = await fetch('/api/ai/status', { headers: getAuthHeaders() });
    statusCache = res.ok ? await res.json() : { available: false, model: 'n/a', device: 'none' };
  } catch {
    statusCache = { available: false, model: 'n/a', device: 'none' };
  }
  return statusCache;
}

export async function readSheet(input: { imageId?: string; imageBase64?: string; embeddedText?: string }): Promise<SheetRead | null> {
  try {
    const res = await fetch('/api/ai/read-sheet', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }, body: JSON.stringify(input),
    });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

export async function matchSheet(input: { page: SheetRead; existingSheets: ExistingSheetRef[] }): Promise<SheetMatch | null> {
  try {
    const res = await fetch('/api/ai/match-sheet', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }, body: JSON.stringify(input),
    });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

/** Run thunks with a bounded concurrency, preserving result order. */
export async function runWithConcurrency<T>(thunks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results = new Array<T>(thunks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, thunks.length) }, async () => {
    while (next < thunks.length) {
      const i = next++;
      results[i] = await thunks[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

/** Local per-user toggle (server AI_ENABLED is the master switch). */
export function aiAutoNameEnabled(): boolean {
  return localStorage.getItem('aiAutoName') !== 'false';
}
export function setAiAutoNameEnabled(on: boolean): void {
  localStorage.setItem('aiAutoName', on ? 'true' : 'false');
}

/** Apply a read to a page (pure). Empty reads leave the page untouched. */
export function applyReadToPage<T extends AiPage>(page: T, read: SheetRead): T {
  if (!read.sheetNumber && !read.sheetTitle) return page;
  const pageNumber = read.sheetNumber || page.pageNumber || '';
  const description = read.sheetTitle || page.description || '';
  const name = pageNumber && description ? `${pageNumber} - ${description}` : pageNumber || description || page.name;
  return {
    ...page,
    pageNumber,
    description,
    name,
    aiConfidence: read.confidence,
    detectionConfidence: read.confidence >= 0.5 && !!read.sheetNumber ? 'high' : 'low',
  };
}

/** Apply a match to a page (pure). Below 0.5 confidence leaves matchSheetId as-is. */
export function applyMatchToPage<T extends AiPage>(page: T, match: SheetMatch): T {
  if (match.confidence < 0.5) return page;
  return { ...page, matchSheetId: match.matchSheetId ?? '' };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/utils/aiSheets.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/utils/aiSheets.ts src/utils/aiSheets.test.ts
git commit -m "feat(ai): client AI helpers + pure apply functions"
```

---

## Task 9: AI confidence field + badge in PageNamingStep

**Files:**
- Modify: `src/components/PageNamingStep.tsx`

**Context:** `NamingStepPage` already has `pageNumber`, `description`, `detectionConfidence`, `matchSheetId`. Add an optional `aiConfidence?: number` and show a small "AI" badge on rows that carry one. The existing amber "needs review" nudge stays as-is (driven by `detectionConfidence`).

- [ ] **Step 1: Add the field to `NamingStepPage`**

In the `NamingStepPage` interface (near `matchSheetId?`), add:

```ts
  /** Confidence 0..1 from the local AI read, when the page was AI-named. Drives
   *  the "AI" badge + tooltip in the review grid; absent for OCR/heuristic names. */
  aiConfidence?: number;
```

- [ ] **Step 2: Render the badge**

Inside the per-page card header area (near the existing page-number badge around line 594, the `absolute top-3 left-3` badge), add — guarded by `page.aiConfidence !== undefined`:

```tsx
{page.aiConfidence !== undefined && (
  <div
    className="absolute bottom-3 left-3 bg-accent-600/90 backdrop-blur-md text-white text-[10px] font-black px-2.5 py-1.5 rounded-lg shadow-sm"
    title={`Named by AI (${Math.round(page.aiConfidence * 100)}% confidence)`}
  >
    AI {Math.round(page.aiConfidence * 100)}%
  </div>
)}
```

(Use the actual `page` variable name from the surrounding `.map(...)`; confirm the card is `relative` so `absolute` positions correctly — it is: the thumbnail wrapper is `relative` at ~line 570.)

- [ ] **Step 3: Type-check + build**

Run: `npx tsc --noEmit && npm run build`
Expected: no errors; build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/components/PageNamingStep.tsx
git commit -m "feat(ai): AI confidence badge on review rows"
```

---

## Task 10: Auto-run AI read during NewProject import

**Files:**
- Modify: `src/pages/NewProject.tsx`

**Context:** After the existing per-page `detectPageInfo(...)` loop builds `pendingPages` (around `src/pages/NewProject.tsx:243`), run an AI read pass that overrides names when AI is available. Each `pendingPage` carries `imageId` (set on save) and `extractedText`. Reuse the existing progress indicator state.

- [ ] **Step 1: Import the helpers**

At the top of `NewProject.tsx`:

```ts
import { getAiStatus, readSheet, runWithConcurrency, applyReadToPage, aiAutoNameEnabled } from '../utils/aiSheets';
```

- [ ] **Step 2: Add the AI pass after `pendingPages` is built**

After `setPendingPages(builtPages)` (the point where the heuristic `pendingPages` array is finalized), add:

```ts
// AI naming pass: when the local model is available and auto-naming is on,
// override the heuristic names with the model's read. Falls back silently.
if (aiAutoNameEnabled() && (await getAiStatus()).available) {
  setProcessingMessage('Reading sheets with AI…');
  const pages = builtPages; // the array just set into pendingPages
  const reads = await runWithConcurrency(
    pages.map(pg => async () => readSheet({
      imageBase64: pageThumbnails[pg.id] || undefined,   // client already has the rendered image
      imageId: pg.imageId || undefined,
      embeddedText: pg.extractedText,
    })),
    3,
  );
  const named = pages.map((pg, i) => (reads[i] ? applyReadToPage(pg, reads[i]!) : pg));
  setPendingPages(named);
}
```

Adjust the local variable names (`builtPages`, `pageThumbnails`, `setProcessingMessage`) to the ones actually present in `NewProject.tsx`. If there is no dedicated progress message setter, reuse the existing upload progress state.

- [ ] **Step 3: Type-check + build**

Run: `npx tsc --noEmit && npm run build`
Expected: no errors.

- [ ] **Step 4: Manual verification**

With a GPU build + model present: create a project, upload a multi-page PDF; the naming step should open with AI-filled numbers/titles and "AI %" badges. With AI off/unavailable: identical behavior to today (heuristic names, no badges), no errors in the console/network beyond a single `/api/ai/status`.

- [ ] **Step 5: Commit**

```bash
git add src/pages/NewProject.tsx
git commit -m "feat(ai): auto-run AI sheet reading on new-project import"
```

---

## Task 11: Auto-run AI read + match in AddPagesModal

**Files:**
- Modify: `src/components/AddPagesModal.tsx`

**Context:** `AddPagesModal` builds `pendingPages` and, for the add-set flow, computes `reviewSheets` (the existing `ExistingSheet[]` = `{ sheetId, pageNumber }`). For AI matching, build `ExistingSheetRef[]` = `{ sheetId, number, title }`, where `title` comes from the sheet's current page name/description (available on `project`). Run the read pass first, then the match pass to pre-select `matchSheetId`.

- [ ] **Step 1: Import the helpers**

```ts
import { getAiStatus, readSheet, matchSheet, runWithConcurrency, applyReadToPage, applyMatchToPage, aiAutoNameEnabled } from '../utils/aiSheets';
```

- [ ] **Step 2: After `pendingPages` is built for the name step, run read (+ match for add-set)**

At the point the modal transitions to `name_pages` with a finalized `pendingPages` array:

```ts
if (aiAutoNameEnabled() && (await getAiStatus()).available) {
  const pages = builtPages;
  const reads = await runWithConcurrency(
    pages.map(pg => async () => readSheet({
      imageBase64: pendingThumbnails[pg.id] || undefined,
      imageId: pg.imageId || undefined,
      embeddedText: pg.extractedText,
    })),
    3,
  );
  let named = pages.map((pg, i) => (reads[i] ? applyReadToPage(pg, reads[i]!) : pg));

  // Add-set flow only: ask the model which existing sheet each page revises.
  if (!isNamingExistingPages && reviewSheetRefs.length) {
    const matches = await runWithConcurrency(
      named.map((pg, i) => async () => {
        const read = reads[i];
        if (!read) return null;
        return matchSheet({ page: read, existingSheets: reviewSheetRefs });
      }),
      3,
    );
    named = named.map((pg, i) => (matches[i] ? applyMatchToPage(pg, matches[i]!) : pg));
  }
  setPendingPages(named);
}
```

Where `reviewSheetRefs` is built next to the existing `reviewSheets`:

```ts
const reviewSheetRefs = reviewSheets.map(s => ({
  sheetId: s.sheetId,
  number: s.pageNumber,
  // Title = the current page's description/name for that sheet (best available).
  title: sheetTitleFor(project, s.sheetId),
}));
```

Add a small helper `sheetTitleFor(project, sheetId)` that finds the current page for that `sheetId` (via `effectiveSheetId` from `src/utils/planSets.ts`) and returns its `description` (fallback `name`, fallback `''`). Keep it in `AddPagesModal.tsx` (or `planSets.ts` if it fits better).

- [ ] **Step 3: Type-check + build**

Run: `npx tsc --noEmit && npm run build`
Expected: no errors.

- [ ] **Step 4: Manual verification**

Add a plan set to an existing project: the Revision Review step opens with AI-filled names, "AI %" badges, and pre-selected "Revision of X" / "New sheet" per page. Rename-existing-pages flow (no `existingSheets`) shows AI names but no match step. AI off/unavailable → today's behavior.

- [ ] **Step 5: Commit**

```bash
git add src/components/AddPagesModal.tsx
git commit -m "feat(ai): auto-run AI read + revision matching on add-set"
```

---

## Task 12: Settings — "AI Sheet Reading" section

**Files:**
- Modify: `src/pages/Settings.tsx`

**Context:** Add a section showing model status (from `/api/ai/status`) and the local "Auto-name with AI" toggle. Follow the existing Settings section markup.

- [ ] **Step 1: Add state + load status**

In the Settings component:

```ts
import { getAiStatus, aiAutoNameEnabled, setAiAutoNameEnabled, type AiStatus } from '../utils/aiSheets';
// ...
const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);
const [autoName, setAutoName] = useState<boolean>(aiAutoNameEnabled());
useEffect(() => { getAiStatus(true).then(setAiStatus); }, []);
```

- [ ] **Step 2: Render the section**

Add a new section (matching the surrounding section styling):

```tsx
<section className="...existing section classes...">
  <h3 className="...existing heading classes...">AI Sheet Reading</h3>
  <p className="text-sm text-slate-500 dark:text-slate-400">
    {aiStatus?.available
      ? `Local model ready: ${aiStatus.model} (${aiStatus.device}). Imported sheets are read and named automatically.`
      : 'No local model detected. Page naming falls back to text/OCR extraction. See the ops runbook to enable it.'}
  </p>
  <label className="flex items-center gap-3 mt-3">
    <input
      type="checkbox"
      checked={autoName}
      disabled={!aiStatus?.available}
      onChange={e => { setAutoName(e.target.checked); setAiAutoNameEnabled(e.target.checked); }}
    />
    <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
      Auto-name imported pages with AI
    </span>
  </label>
</section>
```

- [ ] **Step 3: Type-check + build**

Run: `npx tsc --noEmit && npm run build`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/pages/Settings.tsx
git commit -m "feat(ai): Settings section for AI sheet reading status + toggle"
```

---

## Task 13: Final review + full suite + push

- [ ] **Step 1: Full test + build**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: type-check clean, all unit tests pass, build succeeds.

- [ ] **Step 2: Dispatch a final code reviewer**

Per subagent-driven-development, dispatch a final `code-reviewer` over the whole change set (server AI modules + client wiring), focusing on: graceful-disable correctness (no throw at import/start when the dep or model is absent), that no page data can leave the server, and that the import flow never blocks when AI is unavailable.

- [ ] **Step 3: Push to testing**

```bash
git push origin testing
```

(Do not open a PR unless the user asks — per `CLAUDE.md`.)

---

## Self-Review notes (author)

- **Spec coverage:** inference service (T6), status/read/match endpoints (T5–T6), whole-page read with embedded-text hint (T2/T6), model-driven matching (T2/T6/T11), auto-run on import (T10/T11), review prefill + AI badge/confidence + amber nudge (T8/T9), Settings section (T12), graceful fallback (T4/T5/T8/T10/T11), Docker/CUDA + `/models` volume + runbook (T7), testable-without-GPU via the `AiRunner` fake (T1–T5, T8). All spec sections map to a task.
- **Open items (from the spec) handled explicitly:** node-llama-cpp vision API + model-file pinning is Task 6 Step 1 (with MiniCPM-V fallback); server-side image downsizing is intentionally omitted (the model's clip/preprocessor resizes) to avoid adding an image dependency — revisit only if latency is a problem.
- **Type consistency:** `SheetRead`/`SheetMatch`/`ExistingSheetRef`/`AiRunner` are defined once in `server/ai/types.ts` and mirrored on the client in `aiSheets.ts`; `AiPage.matchSheetId` maps to `NamingStepPage.matchSheetId`; `aiConfidence` added to both the client `AiPage` and `NamingStepPage`.
```
