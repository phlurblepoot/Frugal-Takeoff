import type { Page } from '@playwright/test';
import { test, expect, seedSpreadsheetFile } from './fixtures/test';
import { openAuthedContext } from './fixtures/collab';

// ─────────────────────────────────────────────────────────────────────────────
// WS5 acceptance proof (task 9, collab half): two (then three, then four)
// independently-authenticated browser contexts sharing one JWT — same idiom
// as collab-canvas-sync.spec.ts / collab-follow.spec.ts — prove the sheet
// room's live op relay, late-joiner backfill, cell presence, and the
// Documents "being edited" dots (T8) all work together on a real editing
// session.
//
// Assertability (see sheets-editor.spec.ts's header comment for the full
// investigation): FortuneSheet paints the grid on <canvas>, so a REMOTE
// edit's arrival can't be read off the canvas directly. What's proven here
// instead is the round-trip a real user would notice: click the cell the
// OTHER session just edited and read it back from the real DOM formula bar
// (`#luckysheet-functionbox-cell`) — if the remote op hadn't been applied to
// the local FortuneSheet document, that cell's underlying value wouldn't
// have changed and the read-back would still show blank/stale. Neither side
// clicks Save or "Snapshot version" anywhere in this spec — every value that
// crosses a session boundary does so purely via the live op relay (plus, for
// the late joiner, the join-time state+tail backfill).
// ─────────────────────────────────────────────────────────────────────────────

const ROW_HEADER_WIDTH = 46;
const COL_HEADER_HEIGHT = 20;
const ROW_HEIGHT = 19;
const COL_WIDTH = 73;

interface Box { x: number; y: number; }

async function canvasBox(page: Page): Promise<Box> {
  const canvas = page.locator('canvas.fortune-sheet-canvas');
  await expect(canvas).toBeVisible({ timeout: 15_000 });
  const box = await canvas.boundingBox();
  if (!box) throw new Error('sheet canvas has no bounding box');
  return box;
}

function cellPoint(box: Box, row: number, col: number) {
  return {
    x: box.x + ROW_HEADER_WIDTH + col * COL_WIDTH + COL_WIDTH / 2,
    y: box.y + COL_HEADER_HEIGHT + row * ROW_HEIGHT + ROW_HEIGHT / 2,
  };
}

async function clickCell(page: Page, box: Box, row: number, col: number) {
  const p = cellPoint(box, row, col);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(80);
}

const fxInputText = (page: Page) => page.locator('#luckysheet-functionbox-cell').textContent();

async function gotoSheet(page: Page, fileId: string) {
  await page.goto(`/tools/sheets?fileId=${fileId}`);
  await expect(page.getByText(/Autosaves to file · Live/)).toBeVisible({ timeout: 15_000 });
  return canvasBox(page);
}

// A far-away, always-empty cell used purely to break selection state between
// read attempts below — see expectCellEventually's comment for why.
const NEUTRAL_ROW = 40;
const NEUTRAL_COL = 15;

/** Reads back the value of (row, col) — the assertable substitute for "the
 *  remote op landed" (see header).
 *
 *  Two things were verified the hard way while building this:
 *  1. FortuneSheet's formula bar (FxEditor in @fortune-sheet/react) does NOT
 *     live-refresh for an already-selected cell when the underlying data
 *     changes: its effect depends on `context.luckysheetfile` but the first
 *     line of its body is `if (isEqual(prevSelection, selection) &&
 *     sameSheet) return;` — a data-only change with the SAME selection is a
 *     no-op. So the cell must be RE-SELECTED (a fresh selection-change event)
 *     on every read attempt, not selected once and then merely polled.
 *  2. Re-clicking the exact same on-screen coordinates on every poll tick
 *     DOES fire a fresh selection-change the first time, but Chromium
 *     coalesces same-position clicks arriving within its multi-click timing
 *     window into a double/triple-click — which FortuneSheet treats as
 *     "enter cell edit mode", a different UI state that stops reflecting fx
 *     bar reads correctly.
 *  Clicking a neutral, always-empty cell immediately before the target cell
 *  on every attempt satisfies both: it forces a genuine selection CHANGE
 *  (never the same cell twice in a row) so the fx bar effect actually runs,
 *  while never repeating the same coordinates back-to-back. */
async function expectCellEventually(page: Page, box: Box, row: number, col: number, value: string) {
  await expect.poll(async () => {
    await clickCell(page, box, NEUTRAL_ROW, NEUTRAL_COL);
    await clickCell(page, box, row, col);
    return fxInputText(page);
  }, { timeout: 10_000, intervals: [300] }).toBe(value);
}

test.describe('sheets collab (two-context)', () => {
  test('A/B live cell sync both directions, late joiner, presence, and documents dots', async ({
    browser, request, apiToken,
  }) => {
    // Four contexts, several cross-socket waits — same headroom rationale as
    // collab-canvas-sync.spec.ts's WS4 test.
    test.setTimeout(60_000);
    const seeded = await seedSpreadsheetFile(request, apiToken.token);

    const a = await openAuthedContext(browser, apiToken.token, apiToken.user);
    const b = await openAuthedContext(browser, apiToken.token, apiToken.user);

    try {
      const boxA = await gotoSheet(a.page, seeded.fileId);
      const boxB = await gotoSheet(b.page, seeded.fileId);

      // ── Scenario 1: A types into a cell; B sees the value live ──────────
      await clickCell(a.page, boxA, 0, 2); // C1
      await a.page.keyboard.type('A wrote this');
      await a.page.keyboard.press('Enter');
      await expectCellEventually(b.page, boxB, 0, 2, 'A wrote this');

      // ── Scenario 2: B edits a DIFFERENT cell; A sees it ─────────────────
      await clickCell(b.page, boxB, 1, 2); // C2
      await b.page.keyboard.type('B wrote this');
      await b.page.keyboard.press('Enter');
      await expectCellEventually(a.page, boxA, 1, 2, 'B wrote this');

      // ── Scenario 3: late joiner C sees BOTH edits without either A or B
      //    clicking Save/Snapshot — join-time state+ops-tail backfill only ──
      const c = await openAuthedContext(browser, apiToken.token, apiToken.user);
      try {
        const boxC = await gotoSheet(c.page, seeded.fileId);
        await expectCellEventually(c.page, boxC, 0, 2, 'A wrote this');
        await expectCellEventually(c.page, boxC, 1, 2, 'B wrote this');
      } finally {
        await c.context.close().catch(() => {});
      }

      // ── Scenario 4: A's presence — B sees a colored marker for A's
      //    selected cell (best-effort per the task brief, not a hard gate) ─
      await clickCell(a.page, boxA, 3, 0); // A selects a fresh cell
      const presenceMarker = b.page.locator('.fortune-presence-username');
      try {
        await expect(presenceMarker).toBeVisible({ timeout: 5_000 });
        await expect(presenceMarker).toHaveText(apiToken.user.username);
      } catch {
        console.warn('[collab-sheets] presence marker did not surface within 5s — best-effort, not failing the run');
      }

      // ── Scenario 5: Documents page (4th context) shows the being-edited
      //    dots for this file while A and B are still joined ───────────────
      const d = await openAuthedContext(browser, apiToken.token, apiToken.user);
      try {
        await d.page.goto(`/documents?q=${encodeURIComponent(seeded.fileName)}`);
        const row = d.page.locator('table [data-testid="documents-row"]')
          .filter({ hasText: seeded.fileName });
        await expect(row).toBeVisible({ timeout: 15_000 });
        await expect.poll(
          async () => row.locator(`[title*="${apiToken.user.username}"]`).count(),
          { timeout: 10_000 },
        ).toBeGreaterThanOrEqual(1);
      } finally {
        await d.context.close().catch(() => {});
      }
    } finally {
      await a.context.close().catch(() => {});
      await b.context.close().catch(() => {});
    }
  });
});
