import type { APIRequestContext, Page } from '@playwright/test';
import ExcelJS from 'exceljs';
import { test, expect, seedSpreadsheetFile } from './fixtures/test';

// ─────────────────────────────────────────────────────────────────────────────
// WS5 acceptance proof (task 9, single-user half): the spreadsheet editor
// rebuild (docs/superpowers/plans/2026-08-26-ws5-spreadsheet-rebuild.md).
// FortuneSheet paints the grid on a <canvas> (`.fortune-sheet-canvas`) with no
// per-cell DOM text nodes, so "grid renders values" and "edited value
// visible" can't be asserted the way a normal HTML table would be. What IS
// real, queryable DOM text: the name box (`.fortune-name-box`, shows the
// selected cell's address, e.g. "A1") and the formula/value bar
// (`#luckysheet-functionbox-cell` / `.fortune-fx-input`, a contenteditable
// that shows the SELECTED cell's raw value) — both driven by FortuneSheet's
// own React state, not canvas pixels. Clicking a cell and reading these two
// elements is the assertable substitute used throughout this spec.
//
// The autosave/data-loss-regression proof itself does NOT rely on the DOM at
// all: it downloads the file's live bytes via `/api/files/:id/content` and
// parses them with exceljs IN THE SPEC — independently of sheetBridge.ts
// (the code under test) — so a real fold-to-disk regression can't hide
// behind a UI that merely looks right.
//
// Autosave timing: the client debounces its authoritative state-sync ~2s
// after the last edit, and the server's flush engine folds dirty sessions to
// disk on its own interval — playwright.config.ts overrides that interval to
// 2s via SHEET_FLUSH_INTERVAL_MS (production default is 15s) so this spec
// doesn't have to wait out the real cadence. `expect.poll` absorbs the
// remaining timing slop rather than a fixed sleep.
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

/** row/col are 0-indexed grid coordinates (row 0 = spreadsheet row "1"). */
function cellPoint(box: Box, row: number, col: number) {
  return {
    x: box.x + ROW_HEADER_WIDTH + col * COL_WIDTH + COL_WIDTH / 2,
    y: box.y + COL_HEADER_HEIGHT + row * ROW_HEIGHT + ROW_HEIGHT / 2,
  };
}

async function clickCell(page: Page, box: Box, row: number, col: number) {
  const p = cellPoint(box, row, col);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(80); // let FortuneSheet's selection state settle
}

const nameBoxText = (page: Page) => page.locator('.fortune-name-box').textContent();
const fxInputText = (page: Page) => page.locator('#luckysheet-functionbox-cell').textContent();

async function downloadAndParse(
  request: APIRequestContext, token: string, fileId: string,
): Promise<ExcelJS.Workbook> {
  const res = await request.get(`/api/files/${fileId}/content`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok()) throw new Error(`file download failed: ${res.status()} ${await res.text()}`);
  const buf = await res.body();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}

async function versionCount(request: APIRequestContext, token: string, fileId: string): Promise<number> {
  const res = await request.get(`/api/files/${fileId}/versions`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok()) throw new Error(`versions fetch failed: ${res.status()} ${await res.text()}`);
  const versions = (await res.json()) as unknown[];
  return versions.length;
}

test.describe('sheets editor (single-user)', () => {
  test('render, edit -> autosave -> fidelity proof, snapshot version, reload re-hydration', async ({
    authedPage, request, apiToken,
  }) => {
    const seeded = await seedSpreadsheetFile(request, apiToken.token);

    // ── Scenario 1: open -> grid renders, no error toasts ─────────────────
    await authedPage.goto(`/tools/sheets?fileId=${seeded.fileId}`);
    await expect(authedPage.getByText(/Autosaves to file · Live/)).toBeVisible({ timeout: 15_000 });

    const box = await canvasBox(authedPage);
    await clickCell(authedPage, box, 0, 0); // A1 — the seeded styled/known cell
    await expect.poll(() => nameBoxText(authedPage)).toBe('A1');
    await expect.poll(() => fxInputText(authedPage)).toBe(seeded.styledCell.value);
    await expect(authedPage.locator('.bg-red-600')).toHaveCount(0);

    // ── Scenario 2: edit a different cell -> autosave -> API-parse proves
    //    both the new value AND the untouched cell's formatting survived ──
    await clickCell(authedPage, box, 0, 1); // B1 — the seeded editable cell
    await expect.poll(() => nameBoxText(authedPage)).toBe('B1');
    const newValue = 'Edited via Playwright';
    await authedPage.keyboard.type(newValue);
    await authedPage.keyboard.press('Enter');

    await expect.poll(async () => {
      const wb = await downloadAndParse(request, apiToken.token, seeded.fileId);
      return wb.getWorksheet(seeded.sheetName)?.getCell('B1').value;
    }, { timeout: 20_000, intervals: [1000] }).toBe(newValue);

    const wbAfterEdit = await downloadAndParse(request, apiToken.token, seeded.fileId);
    const a1AfterEdit = wbAfterEdit.getWorksheet(seeded.sheetName)!.getCell('A1');
    expect(a1AfterEdit.font?.bold).toBe(true);
    expect(a1AfterEdit.fill).toMatchObject({
      type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00FF00' },
    });

    // ── Scenario 3: "Snapshot version" button increments the version count ─
    const before = await versionCount(request, apiToken.token, seeded.fileId);
    await authedPage.getByRole('button', { name: 'Snapshot version' }).click();
    await expect(authedPage.getByText('Version saved')).toBeVisible({ timeout: 10_000 });
    await expect.poll(
      () => versionCount(request, apiToken.token, seeded.fileId),
      { timeout: 10_000 },
    ).toBe(before + 1);

    // ── Scenario 4: reload -> edited value still shown (session re-hydration,
    //    served from the shared session's folded state, not a fresh import) ─
    await authedPage.reload();
    await expect(authedPage.getByText(/Autosaves to file · Live/)).toBeVisible({ timeout: 15_000 });
    const box2 = await canvasBox(authedPage);
    await clickCell(authedPage, box2, 0, 1); // B1 again
    await expect.poll(() => nameBoxText(authedPage)).toBe('B1');
    await expect.poll(() => fxInputText(authedPage)).toBe(newValue);
  });

  // Regression net for a fix-round finding: ad-hoc tabs (no fileId — no
  // collab session, so nothing rescues them the way a rejoin's
  // ensureSheetCelldata call does) have their OWN blank-on-remount exposure.
  // FortuneSheet's onChange fires as `data`-shaped the moment a document is
  // edited; switchTab flushes that straight into the outgoing tab's
  // `sheets`, and the Workbook remounts on every tab switch (its `key`
  // includes the active tab id) — so switching away from an edited ad-hoc
  // tab and back is the same "fresh mount fed a data-shaped sheet with no
  // celldata" trap as the collab-rejoin case, just reached through the tab
  // bar instead of a socket reconnect. Two LOCAL (never-uploaded) xlsx files
  // via the hidden file input exercise this without needing a seeded fileId.
  test('ad-hoc tabs: edit one, switch away and back, edited value survives (tab-switch data-shape regression)', async ({
    authedPage,
  }) => {
    const buildAdHocXlsx = async (a1Value: string): Promise<Buffer> => {
      const wb = new ExcelJS.Workbook();
      wb.addWorksheet('Sheet1').getCell('A1').value = a1Value;
      const buffer = (await wb.xlsx.writeBuffer()) as unknown as ArrayBuffer;
      return Buffer.from(buffer);
    };
    const xlsxMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

    await authedPage.goto('/tools/sheets');
    const fileInput = authedPage.locator('input[type="file"]');

    // Open ad-hoc file 1 — becomes the active tab.
    await fileInput.setInputFiles({
      name: 'adhoc1.xlsx', mimeType: xlsxMime, buffer: await buildAdHocXlsx('File1 A1'),
    });
    await expect(authedPage.getByText('adhoc1.xlsx', { exact: true })).toBeVisible();
    const box1 = await canvasBox(authedPage);
    await clickCell(authedPage, box1, 0, 0); // A1
    await expect.poll(() => fxInputText(authedPage)).toBe('File1 A1');

    // Open ad-hoc file 2 (same hidden input, reset after each use) — becomes
    // the new active tab, so file 1 is now the "outgoing" tab whenever we
    // switch away from it.
    await fileInput.setInputFiles({
      name: 'adhoc2.xlsx', mimeType: xlsxMime, buffer: await buildAdHocXlsx('File2 A1'),
    });
    await expect(authedPage.getByText('adhoc2.xlsx', { exact: true })).toBeVisible();

    // Switch to file 1 and edit B1 — this is the local edit that leaves
    // `currentSheetsRef` (and therefore file 1's flushed tab.sheets on the
    // next switch-away) `data`-shaped.
    await authedPage.getByText('adhoc1.xlsx', { exact: true }).click();
    const box1Active = await canvasBox(authedPage);
    await clickCell(authedPage, box1Active, 0, 1); // B1
    const editedValue = 'Edited ad-hoc';
    await authedPage.keyboard.type(editedValue);
    await authedPage.keyboard.press('Enter');

    // Switch away to file 2, then back to file 1 — two fresh Workbook
    // remounts of file 1's tab data around the edit.
    await authedPage.getByText('adhoc2.xlsx', { exact: true }).click();
    await expect(authedPage.locator('canvas.fortune-sheet-canvas')).toBeVisible();
    await authedPage.getByText('adhoc1.xlsx', { exact: true }).click();

    const box1Back = await canvasBox(authedPage);
    await clickCell(authedPage, box1Back, 0, 1); // B1
    await expect.poll(() => nameBoxText(authedPage)).toBe('B1');
    await expect.poll(() => fxInputText(authedPage)).toBe(editedValue);
    // A1 (never touched) must also still be intact — proof the whole sheet
    // wasn't blanked, not just that B1 happened to survive.
    await clickCell(authedPage, box1Back, 0, 0);
    await expect.poll(() => fxInputText(authedPage)).toBe('File1 A1');
  });
});
