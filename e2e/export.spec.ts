import { test, expect, seedProjectWithTakeoffMeasurement } from './fixtures/test';
import type { Page } from '@playwright/test';

// Characterization spec for the Takeoffs-tab exports (Print PDF + Excel).
//
// IMPORTANT real-behavior notes (read handleExportExcel / handlePrint in
// src/pages/ProjectView.tsx):
//
//  • Both export buttons (btn-print, btn-export-excel) are rendered ONLY when
//    `selectedTakeoffIds.size > 0` — the toolbar block is gated behind that
//    condition. So every export test MUST first select at least one takeoff.
//    The per-row select control is a bare <input type="checkbox"> inside the
//    desktop takeoffs-table row (no dedicated testid), so we target it by role.
//
//  • Excel export does NOT trigger a browser download. handleExportExcel writes
//    the workbook to the server via saveFile(), appends an "Excel Export - …"
//    Printout (type 'excel') to project.printouts, then navigates to
//    /project/:id/proposal. The actual file download lives elsewhere (the
//    Proposal section's per-printout Download button). So the correct, real
//    assertion here is: an Excel printout appears in the Proposal section's
//    "Printout history" after the export. We do NOT assert on a download event,
//    nor on workbook binary content.
//
//  • Print (handlePrint → buildHighlightsPdf) returns null and records NO
//    printout unless some CURRENT page carries a measurement whose takeoffId is
//    in the selected set. To exercise the full Print path without slow canvas
//    drawing, we seed a project that already has one takeoff + one length
//    measurement wired to it (seedProjectWithTakeoffMeasurement). On success it
//    records a "Printout - …" entry (type 'pdf') and navigates to /proposal.
//
// Each test seeds a FRESH project to avoid cross-test bleed (shared server/DB).

async function gotoTakeoffsTab(page: Page, projectId: string) {
  await page.goto(`/project/${projectId}/takeoff?tab=takeoffs`);
  await expect(page.getByTestId('takeoffs-table')).toBeVisible();
}

// Scope to the desktop table — both the desktop table and the mobile cards
// render data-testid="takeoff-row" (CSS toggles visibility, not presence).
function takeoffRows(page: Page) {
  return page.getByTestId('takeoffs-table').getByTestId('takeoff-row');
}

// Select the first takeoff by checking its row checkbox (the toolbar with the
// export buttons only appears once a takeoff is selected).
async function selectFirstTakeoff(page: Page) {
  const row = takeoffRows(page).first();
  await expect(row).toBeVisible();
  await row.getByRole('checkbox').check();
}

test('Excel export records an Excel printout in the Proposal section', async ({
  authedPage,
  apiToken,
  request,
}) => {
  const { token } = apiToken;
  const { projectId, takeoffName } = await seedProjectWithTakeoffMeasurement(request, token);

  await gotoTakeoffsTab(authedPage, projectId);
  // The seeded takeoff renders as a row.
  await expect(takeoffRows(authedPage)).toHaveCount(1);
  await expect(takeoffRows(authedPage).first()).toContainText(takeoffName);

  // Export needs a selection: the buttons don't exist until one takeoff is on.
  await expect(authedPage.getByTestId('btn-export-excel')).toHaveCount(0);
  await selectFirstTakeoff(authedPage);

  const excelBtn = authedPage.getByTestId('btn-export-excel');
  await expect(excelBtn).toBeVisible();
  await excelBtn.click();

  // characterization: NO browser download fires. handleExportExcel persists the
  // workbook server-side, appends an "Excel Export - …" printout, and navigates
  // to the Proposal section, where the printout history now shows it.
  await expect(authedPage).toHaveURL(new RegExp(`/project/${projectId}/proposal`));
  await expect(authedPage.getByText('Printout history')).toBeVisible();
  await expect(authedPage.getByText(/Excel Export -/)).toBeVisible();
});

test('Print records a PDF printout in the Proposal section', async ({
  authedPage,
  apiToken,
  request,
}) => {
  const { token } = apiToken;
  const { projectId, takeoffName } = await seedProjectWithTakeoffMeasurement(request, token);

  await gotoTakeoffsTab(authedPage, projectId);
  await expect(takeoffRows(authedPage)).toHaveCount(1);
  await expect(takeoffRows(authedPage).first()).toContainText(takeoffName);

  await expect(authedPage.getByTestId('btn-print')).toHaveCount(0);
  await selectFirstTakeoff(authedPage);

  const printBtn = authedPage.getByTestId('btn-print');
  await expect(printBtn).toBeVisible();
  await printBtn.click();

  // Print rasterizes/stamps the highlights PDF — it can be slow. The seeded
  // measurement (bound to the selected takeoff) makes the page eligible, so
  // buildHighlightsPdf returns bytes, a "Printout - …" entry is recorded, and
  // handlePrint navigates to /proposal. Give it a generous timeout.
  await expect(authedPage).toHaveURL(new RegExp(`/project/${projectId}/proposal`), {
    timeout: 30_000,
  });
  await expect(authedPage.getByText('Printout history')).toBeVisible();
  await expect(authedPage.getByText(/^Printout -/)).toBeVisible({ timeout: 15_000 });
});
