import { test, expect, seedProjectWithPage, login } from './fixtures/test';
import type { Page } from '@playwright/test';

// ─────────────────────────────────────────────────────────────────────────────
// CanvasView — scale calibration + measurement drawing characterization.
//
// This is a CHARACTERIZATION spec for the drawing engine (PdfCanvas + the
// CanvasView handlers). It locks in the *current* behavior, including the
// quirks discovered while writing it. It does NOT try to fix the app.
//
// DRAW MECHANICS (discovered by reading src/components/PdfCanvas.tsx and
// src/pages/CanvasView.tsx):
//
//   • The canvas is a Konva <Stage> rendered into a <canvas> inside the
//     [data-testid="canvas-surface"] wrapper. It listens for REAL mouse events
//     (onMouseDown/onMouseMove/onMouseUp on the Stage). We drive it with
//     page.mouse, which generates genuine pointer events. Konva reads the
//     pointer position from the last move, so every click must be a real
//     move→down→up at the target screen coords (page.mouse.click does this).
//
//   • TOOL ENABLEMENT: the length/area/count tools are DISABLED unless BOTH
//     (a) page.scaleConfig is set AND (b) something is selected (a takeoff or a
//     measurement). The seed creates a project with NO takeoffs, so we must
//     calibrate the scale first, then create + select a takeoff before drawing.
//     (When a takeoff exists at load, CanvasView auto-selects the first one.)
//
//   • SCALE: pick tool-scale, click P1 then P2. The SECOND click fires
//     onSetScale(pixelDistanceBetweenTheTwoClicks) which opens the
//     ScaleCalibrationModal. Type the real distance into [scale-input] and
//     press [scale-apply]. After that, page.scaleConfig =
//     { pixelDistance: <image-space px between clicks>, realWorldDistance, unit }.
//
//   • LENGTH / AREA: each click on the background adds a vertex
//     (handleMouseDown → setActivePoints). The segment is FINISHED by pressing
//     Enter (finalizeSegment), OR by clicking within ~10px (image space) of the
//     LAST point (not the start). There is NO finish button. We use Enter — the
//     most deterministic. A finished length with NO existing selected
//     measurement that matches the tool creates a NEW measurement and selects
//     it; a selected empty placeholder gets filled instead.
//
//   • COUNT: each click commits a brand-new count Measurement immediately
//     (one measurement per click). No finish step.
//
//   • SELF-REFERENTIAL DETERMINISM: we never rely on the absolute screen→image
//     px ratio. We calibrate "spanPx screen → realDist" then draw using the
//     SAME screen coords. Because calibration and measurement share the screen→
//     image transform, the measured real value is a known fraction of realDist
//     regardless of the auto-fit zoom. A length over half the calibration span
//     reads ~half the real distance; a WxH rectangle reads W*H real area.
//
// VALUE FORMATS (src/utils/math.ts):
//   • length, ft, no takeoff unit → feet-inches e.g.  5' - 0"   or   2 1/2"
//   • area,   ft, no takeoff unit → "50.00 sq ft"
//   • count                       → "1 each" (per row)
// We parse all three robustly below.
// ─────────────────────────────────────────────────────────────────────────────

/** Parse a displayed measurement value into a number in its base unit.
 *  - feet/inches like `5' - 0"`, `11"`, `2 1/2"`, `0"` → decimal FEET
 *  - `50.00 sq ft` → 50.0 (sq ft)
 *  - `1 each` → 1 (count) */
function parseValue(text: string): number {
  const t = text.trim();
  // area / generic "<num> <unit>"
  const sqft = t.match(/^([\d.]+)\s*sq/i);
  if (sqft) return parseFloat(sqft[1]);
  const each = t.match(/^(\d+)\s*each/i);
  if (each) return parseInt(each[1], 10);

  // feet-inches:  F' - I FRAC"   |   I FRAC"   |   FRAC"   |   0"
  let feet = 0;
  const feetMatch = t.match(/(\d+)\s*'/);
  if (feetMatch) feet += parseInt(feetMatch[1], 10);
  // strip the feet portion, then parse the inches portion
  const afterFeet = feetMatch ? t.slice(t.indexOf("'") + 1) : t;
  const inchSection = afterFeet.replace(/[-]/g, ' ').replace(/"/g, ' ').trim();
  if (inchSection) {
    // could be "I N/D" or "I" or "N/D"
    const fracM = inchSection.match(/(\d+)\s*\/\s*(\d+)/);
    let inches = 0;
    let whole = inchSection;
    if (fracM) {
      inches += parseInt(fracM[1], 10) / parseInt(fracM[2], 10);
      whole = inchSection.replace(fracM[0], '').trim();
    }
    if (whole) {
      const w = parseFloat(whole);
      if (!Number.isNaN(w)) inches += w;
    }
    feet += inches / 12;
  }
  return feet;
}

interface Box { x: number; y: number; width: number; height: number; }

async function surfaceBox(page: Page): Promise<Box> {
  const surface = page.getByTestId('canvas-surface');
  await expect(surface).toBeVisible();
  const box = await surface.boundingBox();
  if (!box) throw new Error('canvas-surface has no bounding box');
  return box;
}

/** Click at screen coords relative to the canvas-surface box. Konva needs the
 *  pointer to have MOVED to the spot first; page.mouse.click does move+down+up. */
async function clickCanvas(page: Page, box: Box, dx: number, dy: number) {
  await page.mouse.move(box.x + dx, box.y + dy);
  await page.mouse.click(box.x + dx, box.y + dy);
  // Small settle so Konva commits the click before the next gesture.
  await page.waitForTimeout(60);
}

/** Open the canvas for a seeded page and wait for the Konva canvas to mount. */
async function gotoCanvas(page: Page, projectId: string, pageId: string) {
  await page.goto(`/project/${projectId}/page/${pageId}`);
  await expect(page.getByTestId('canvas-surface')).toBeVisible();
  // The Konva <canvas> element must exist (background image fit + listeners up).
  await expect(page.locator('[data-testid="canvas-surface"] canvas').first()).toBeVisible();
  await page.waitForTimeout(400);
}

/** Calibrate: click P1 at (x1,y1) and P2 at (x2,y2) [box-relative], enter
 *  `realDist` ft, apply. After this the page has a real ft/px scale. */
async function calibrate(
  page: Page, box: Box,
  p1: [number, number], p2: [number, number], realDist: string,
) {
  await page.getByTestId('tool-scale').click();
  await clickCanvas(page, box, p1[0], p1[1]);
  await clickCanvas(page, box, p2[0], p2[1]);
  await expect(page.getByTestId('scale-input')).toBeVisible();
  await page.getByTestId('scale-input').fill(realDist);
  await page.getByTestId('scale-apply').click();
  await expect(page.getByTestId('scale-input')).toBeHidden();
}

/** Create a takeoff of the given type via the sidebar "New" button + modal,
 *  then ensure it's the selected takeoff (creation selects it; we also click it
 *  to be safe). Requires a scale to already be set (the New button is gated on
 *  page.scaleConfig). */
async function createTakeoff(page: Page, name: string, type: 'length' | 'area' | 'count') {
  // The "New" button (Plus) in the sidebar header.
  await page.getByRole('button', { name: 'New' }).click();
  await expect(page.getByTestId('takeoff-name-input')).toBeVisible();
  await page.getByTestId('takeoff-name-input').fill(name);
  // The "Measurement Type" <select> has no testid; locate by its option set.
  const typeSelect = page.locator('select').filter({ has: page.locator('option[value="count"]') }).first();
  await typeSelect.selectOption(type);
  await page.getByTestId('btn-create-takeoff').click();
  await expect(page.getByTestId('takeoff-name-input')).toBeHidden();
}

test.describe('CanvasView drawing engine', () => {
  // 1 + 2: calibrate 400px=10ft, then a 200px length must read ~5 ft.
  test('scale calibration enables tools and a half-span length reads ~half', async ({ authedPage, request }) => {
    const { token } = await login(request);
    const { projectId, pageId } = await seedProjectWithPage(request, token, { withScale: false });
    await gotoCanvas(authedPage, projectId, pageId);
    const box = await surfaceBox(authedPage);

    // Before any scale, length tool is disabled — clicking it surfaces the
    // tool-disabled message rather than activating.
    // (We just confirm the tool button exists; enablement is exercised below.)
    await expect(authedPage.getByTestId('tool-length')).toBeVisible();

    // Calibrate: 400px horizontal span = 10 ft. Use a vertical center line.
    const cy = box.height / 2;
    const x1 = box.width / 2 - 200;
    const x2 = box.width / 2 + 200;
    await calibrate(authedPage, box, [x1, cy], [x2, cy], '10');

    // Now a takeoff can be created (the New button is gated on scaleConfig).
    await createTakeoff(authedPage, 'Linear', 'length');
    await expect(authedPage.getByTestId('tool-length')).toBeEnabled();

    // Draw a 200px length (half the calibration span) → ~5 ft.
    await authedPage.getByTestId('tool-length').click();
    await clickCanvas(authedPage, box, x1, cy);
    await clickCanvas(authedPage, box, x1 + 200, cy);
    await authedPage.keyboard.press('Enter');

    const value = authedPage.getByTestId('measurement-value').first();
    await expect(value).toBeVisible();
    const feet = parseValue(await value.innerText());
    expect(feet).toBeGreaterThan(4.7);
    expect(feet).toBeLessThan(5.3);
  });

  // 3: rectangle area. Calibrate 400px=10ft (0.025 ft/screenpx along the
  // calibration axis). Draw a 400px×200px rectangle → 10ft × 5ft = 50 sq ft.
  test('area measurement reads ~expected square feet', async ({ authedPage, request }) => {
    const { token } = await login(request);
    const { projectId, pageId } = await seedProjectWithPage(request, token, { withScale: false });
    await gotoCanvas(authedPage, projectId, pageId);
    const box = await surfaceBox(authedPage);

    const cy = box.height / 2;
    const left = box.width / 2 - 200;
    const right = box.width / 2 + 200; // 400px span = 10 ft
    await calibrate(authedPage, box, [left, cy], [right, cy], '10');

    await createTakeoff(authedPage, 'Surface', 'area');
    await expect(authedPage.getByTestId('tool-area')).toBeEnabled();

    // Rectangle: width 400px (=10ft), height 200px (=5ft) → 50 sq ft.
    const top = cy - 100;
    const bot = cy + 100; // 200px tall
    await authedPage.getByTestId('tool-area').click();
    await clickCanvas(authedPage, box, left, top);
    await clickCanvas(authedPage, box, right, top);
    await clickCanvas(authedPage, box, right, bot);
    await clickCanvas(authedPage, box, left, bot);
    await authedPage.keyboard.press('Enter');

    const value = authedPage.getByTestId('measurement-value').first();
    await expect(value).toBeVisible();
    const sqft = parseValue(await value.innerText());
    // Tolerance ±5 sq ft (~10%) to absorb sub-pixel rounding in the transform.
    expect(sqft).toBeGreaterThan(45);
    expect(sqft).toBeLessThan(55);
  });

  // 4: count tool — each click commits one count measurement. A count takeoff
  // renders a per-page count badge (NOT measurement-row), so we assert the
  // badge reads "3" after three clicks.
  test('count tool commits one measurement per click', async ({ authedPage, request }) => {
    const { token } = await login(request);
    const { projectId, pageId } = await seedProjectWithPage(request, token, { withScale: false });
    await gotoCanvas(authedPage, projectId, pageId);
    const box = await surfaceBox(authedPage);

    const cy = box.height / 2;
    await calibrate(authedPage, box, [box.width / 2 - 200, cy], [box.width / 2 + 200, cy], '10');

    await createTakeoff(authedPage, 'Fixtures', 'count');
    await expect(authedPage.getByTestId('tool-count')).toBeEnabled();

    await authedPage.getByTestId('tool-count').click();
    await clickCanvas(authedPage, box, box.width / 2 - 100, cy - 80);
    await clickCanvas(authedPage, box, box.width / 2, cy);
    await clickCanvas(authedPage, box, box.width / 2 + 100, cy + 80);

    // The count takeoff card shows a per-page count badge. The takeoff total
    // chip also reads "3 each". Assert the sidebar contains a "3" count.
    const sidebar = authedPage.getByTestId('measurement-sidebar');
    await expect(sidebar.getByText('3 each')).toBeVisible();
  });

  // 5: a drawn length measurement appears as a measurement-row in the sidebar.
  test('drawn measurement appears in the sidebar', async ({ authedPage, request }) => {
    const { token } = await login(request);
    const { projectId, pageId } = await seedProjectWithPage(request, token, { withScale: false });
    await gotoCanvas(authedPage, projectId, pageId);
    const box = await surfaceBox(authedPage);

    const cy = box.height / 2;
    const x1 = box.width / 2 - 200;
    await calibrate(authedPage, box, [x1, cy], [box.width / 2 + 200, cy], '10');
    await createTakeoff(authedPage, 'Linear', 'length');

    await authedPage.getByTestId('tool-length').click();
    await clickCanvas(authedPage, box, x1, cy);
    await clickCanvas(authedPage, box, x1 + 200, cy);
    await authedPage.keyboard.press('Enter');

    await expect(authedPage.getByTestId('measurement-row')).toHaveCount(1);
    await expect(authedPage.getByTestId('measurement-value').first()).toBeVisible();
  });

  // 6: delete a measurement via its row trash button → confirm dialog → it
  // leaves the sidebar.
  test('deleting a measurement removes its row', async ({ authedPage, request }) => {
    const { token } = await login(request);
    const { projectId, pageId } = await seedProjectWithPage(request, token, { withScale: false });
    await gotoCanvas(authedPage, projectId, pageId);
    const box = await surfaceBox(authedPage);

    const cy = box.height / 2;
    const x1 = box.width / 2 - 200;
    await calibrate(authedPage, box, [x1, cy], [box.width / 2 + 200, cy], '10');
    await createTakeoff(authedPage, 'Linear', 'length');

    await authedPage.getByTestId('tool-length').click();
    await clickCanvas(authedPage, box, x1, cy);
    await clickCanvas(authedPage, box, x1 + 200, cy);
    await authedPage.keyboard.press('Enter');

    const row = authedPage.getByTestId('measurement-row');
    await expect(row).toHaveCount(1);

    // The row's delete button is the Trash2 button titled "Delete Measurement".
    await row.first().hover();
    await row.first().getByTitle('Delete Measurement').click();
    await authedPage.getByTestId('btn-confirm-delete').click();

    await expect(authedPage.getByTestId('measurement-row')).toHaveCount(0);
  });

  // 7: undo/redo. Characterized real behavior — handleUndo for an "add" action
  // removes the measurement; handleRedo restores it. btn-undo/btn-redo are
  // disabled when the respective stack is empty.
  test('undo removes the drawn measurement and redo restores it', async ({ authedPage, request }) => {
    const { token } = await login(request);
    const { projectId, pageId } = await seedProjectWithPage(request, token, { withScale: false });
    await gotoCanvas(authedPage, projectId, pageId);
    const box = await surfaceBox(authedPage);

    const cy = box.height / 2;
    const x1 = box.width / 2 - 200;
    await calibrate(authedPage, box, [x1, cy], [box.width / 2 + 200, cy], '10');
    await createTakeoff(authedPage, 'Linear', 'length');

    await authedPage.getByTestId('tool-length').click();
    await clickCanvas(authedPage, box, x1, cy);
    await clickCanvas(authedPage, box, x1 + 200, cy);
    await authedPage.keyboard.press('Enter');
    await expect(authedPage.getByTestId('measurement-row')).toHaveCount(1);

    await authedPage.getByTestId('btn-undo').click();
    await expect(authedPage.getByTestId('measurement-row')).toHaveCount(0);

    await authedPage.getByTestId('btn-redo').click();
    await expect(authedPage.getByTestId('measurement-row')).toHaveCount(1);
  });
});
