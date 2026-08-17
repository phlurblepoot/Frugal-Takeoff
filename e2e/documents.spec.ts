import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { test, expect, seedCustomerWithPortfolio, seedDocumentsPortfolio } from './fixtures/test';

// Characterization spec for the global Documents page (unified-documents
// spec, docs/superpowers/specs/2026-08-17-unified-documents-design.md):
// src/pages/documents/{DocumentsPage,DocumentsTable,DocumentsFilterBar,
// DocumentsBulkBar,UploadDocumentsModal}.tsx + server/documents.ts.
//
// The suite shares one server/DB across every spec file (playwright.config.ts
// runs workers:1, fullyParallel:false but never resets .e2e-data), so every
// test seeds its own uniquely-named customer/project via
// seedDocumentsPortfolio()/seedCustomerWithPortfolio() and scopes row
// assertions to those seeded ids/names rather than assuming a clean table.
//
// The desktop table (`<table>`, visible at this suite's 1440x900 viewport)
// and the `md:hidden` mobile card list render the SAME data-testid
// ("documents-row"/"doc-row-select") simultaneously in the DOM — CSS
// display:none doesn't remove nodes. Every row locator below is scoped to
// `page.locator('table')` first so counts aren't doubled by the hidden
// mobile duplicate.
const tableRows = (page: Page) => page.locator('table [data-testid="documents-row"]');
const rowFor = (page: Page, name: string) => tableRows(page).filter({ hasText: name });

test('documents page: project + kind multi-select filters, search narrows, real source links, type badges', async ({
  authedPage, request, apiToken,
}) => {
  const seeded = await seedDocumentsPortfolio(request, apiToken.token);

  await authedPage.goto('/documents');
  await expect(authedPage.getByTestId('documents-upload')).toBeVisible();

  // ── Project multi-select: pick both the bidding (0 docs) and in-progress
  // (4 seeded docs) projects — proves the filter is an OR across ids, not an
  // exact single match. ──────────────────────────────────────────────────
  // level:1 + exact — the EmptyState's "No matching documents" h3 also
  // contains the substring "Documents" and would otherwise strict-mode-clash
  // once the bidding-only selection briefly empties the table.
  const heading = authedPage.getByRole('heading', { name: 'Documents', exact: true, level: 1 });
  await authedPage.getByTestId('doc-filter-project').click();
  const projectPanel = authedPage.getByTestId('doc-filter-project').locator('..');
  await projectPanel.getByText(seeded.biddingProjectName, { exact: true }).click();
  // Wait for the first selection's URL write (setSearchParams) to land before
  // firing the second click — both read `prev` searchParams and reapply a
  // patch, so two clicks fired faster than the first commit can race and the
  // second overwrites the first instead of adding to it.
  await expect(authedPage).toHaveURL(new RegExp(`projectIds=${seeded.biddingProjectId}`));
  await projectPanel.getByText(seeded.inProgressProjectName, { exact: true }).click();
  await heading.click(); // outside click — closes the popover (MultiSelectDropdown's mousedown-outside listener)

  const projectIdsParam = new URL(authedPage.url()).searchParams.get('projectIds')?.split(',') ?? [];
  expect(projectIdsParam).toContain(seeded.biddingProjectId);
  expect(projectIdsParam).toContain(seeded.inProgressProjectId);

  await expect(rowFor(authedPage, seeded.invoiceFileName)).toHaveCount(1);
  await expect(rowFor(authedPage, seeded.payAppFileName)).toHaveCount(1);
  await expect(rowFor(authedPage, seeded.printoutFileName)).toHaveCount(1);
  await expect(tableRows(authedPage).filter({ hasText: 'site-photo-' })).toHaveCount(1);
  await expect(tableRows(authedPage)).toHaveCount(4);

  // Type badges — server-canonical kind -> UI label (docTypes.ts KIND_META).
  await expect(rowFor(authedPage, seeded.invoiceFileName).getByText('Invoice', { exact: true })).toBeVisible();
  await expect(rowFor(authedPage, seeded.payAppFileName).getByText('Pay App Export', { exact: true })).toBeVisible();
  await expect(rowFor(authedPage, seeded.printoutFileName).getByText('Printout', { exact: true })).toBeVisible();
  await expect(tableRows(authedPage).filter({ hasText: 'site-photo-' }).getByText('Issue Photo', { exact: true })).toBeVisible();

  // Real source links (server/documents.ts SIMPLE_RESOLVERS href templates) —
  // asserted via the anchor's href rather than clicking through, so the test
  // doesn't have to navigate away and back for each row.
  await expect(rowFor(authedPage, seeded.invoiceFileName).locator('a'))
    .toHaveAttribute('href', `/project/${seeded.inProgressProjectId}/billing?tab=invoices`);
  await expect(rowFor(authedPage, seeded.payAppFileName).locator('a'))
    .toHaveAttribute('href', `/project/${seeded.inProgressProjectId}/billing?tab=pay-apps`);
  await expect(rowFor(authedPage, seeded.printoutFileName).locator('a'))
    .toHaveAttribute('href', `/project/${seeded.inProgressProjectId}/proposal`);
  await expect(tableRows(authedPage).filter({ hasText: 'site-photo-' }).locator('a'))
    .toHaveAttribute('href', `/project/${seeded.inProgressProjectId}/issues`);

  // Screenshot for Nathan of a populated, filtered page (spec item f).
  await authedPage.screenshot({ path: 'test-results/documents-page.png', fullPage: true });

  // ── Kind multi-select on top of the still-active project filter: narrow to
  // just Invoice + Printout. ─────────────────────────────────────────────
  await authedPage.getByTestId('doc-filter-type').click();
  const typePanel = authedPage.getByTestId('doc-filter-type').locator('..');
  await typePanel.getByText('Invoice', { exact: true }).click();
  await expect(authedPage).toHaveURL(/kinds=invoice/); // see the project multi-select comment above — same race
  await typePanel.getByText('Printout', { exact: true }).click();
  await heading.click(); // close the popover
  await expect(tableRows(authedPage)).toHaveCount(2);
  await expect(rowFor(authedPage, seeded.invoiceFileName)).toHaveCount(1);
  await expect(rowFor(authedPage, seeded.printoutFileName)).toHaveCount(1);
  await expect(rowFor(authedPage, seeded.payAppFileName)).toHaveCount(0);

  // ── Search narrows further, on top of the same filters. ────────────────
  const searchTerm = seeded.invoiceFileName.replace('.pdf', '');
  await authedPage.getByLabel('Search documents', { exact: true }).fill(searchTerm);
  await expect(tableRows(authedPage)).toHaveCount(1);
  await expect(rowFor(authedPage, seeded.invoiceFileName)).toHaveCount(1);

  // Note: "Load more" (>100 rows) is impractical to seed for this suite and
  // is intentionally not exercised here.
});

test('upload popup: batch upload with per-file type override, change-type, delete a direct upload; a sourced row shows archive not delete', async ({
  authedPage, request, apiToken,
}) => {
  const seeded = await seedDocumentsPortfolio(request, apiToken.token);
  const short = randomUUID().slice(0, 8);

  await authedPage.goto(`/documents?projectIds=${seeded.inProgressProjectId}`);

  await authedPage.getByTestId('documents-upload').click();
  const modal = authedPage.getByTestId('documents-upload-modal');
  await expect(modal).toBeVisible();

  const fileAName = `upload-a-${short}.txt`;
  const fileBName = `upload-b-${short}.txt`;
  await modal.locator('input[type="file"]').setInputFiles([
    { name: fileAName, mimeType: 'text/plain', buffer: Buffer.from('doc a contents') },
    { name: fileBName, mimeType: 'text/plain', buffer: Buffer.from('doc b contents') },
  ]);

  // Attribute the batch to the seeded project (locks Customer to match).
  await authedPage.getByLabel('Project', { exact: true }).selectOption({ label: seeded.inProgressProjectName });
  await expect(authedPage.getByLabel('Customer', { exact: true })).toHaveValue(seeded.customerId);

  // Per-file type override: shared type stays "Document" for file A; file B
  // gets flipped to "Photo" individually.
  await authedPage.getByLabel('Set type per file', { exact: true }).check();
  await authedPage.getByLabel(`Type for ${fileBName}`, { exact: true }).selectOption({ label: 'Photo' });

  await authedPage.getByRole('button', { name: 'Upload (2)' }).click();
  await expect(modal).toBeHidden();

  await expect(rowFor(authedPage, fileAName).getByText('Document', { exact: true })).toBeVisible();
  await expect(rowFor(authedPage, fileBName).getByText('Photo', { exact: true })).toBeVisible();

  // Change type on file A: Document -> Spreadsheet. Scoped to the open
  // change-type popover (its own wrapping div, same idiom as
  // MultiSelectDropdown) — the sidebar's own "Spreadsheet" tool nav button
  // shares the same accessible name page-wide.
  const changeTypeTrigger = rowFor(authedPage, fileAName).getByTestId('doc-change-type');
  await changeTypeTrigger.click();
  const changeTypePanel = changeTypeTrigger.locator('..');
  await changeTypePanel.getByRole('button', { name: 'Spreadsheet' }).click();
  await expect(rowFor(authedPage, fileAName).getByText('Spreadsheet', { exact: true })).toBeVisible();

  // Delete file A (direct upload, unsourced — deletable per documentsPolicy.ts).
  await rowFor(authedPage, fileAName).getByLabel('Delete', { exact: true }).click();
  await authedPage.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(rowFor(authedPage, fileAName)).toHaveCount(0);

  // A generated/sourced row (the seeded invoice) has no delete affordance —
  // only archive (labeled "Managed by its source" since row.source is set)
  // and no change-type menu (not a direct-upload kind).
  const invoiceRow = rowFor(authedPage, seeded.invoiceFileName);
  await expect(invoiceRow.getByLabel('Delete', { exact: true })).toHaveCount(0);
  await expect(invoiceRow.getByTestId('doc-change-type')).toHaveCount(0);
  await expect(invoiceRow.getByTitle('Managed by its source — archive here')).toBeVisible();

  // The affordance actually works, not just renders: archiving a sourced row
  // completes (PATCH archived=true) and it leaves the default view, same as
  // a direct upload's Archive — only the delete tier differs between them.
  await invoiceRow.getByTitle('Managed by its source — archive here').click();
  await expect(rowFor(authedPage, seeded.invoiceFileName)).toHaveCount(0);
});

test('bulk select: archive + delete a subset via the bulk bar', async ({ authedPage, request, apiToken }) => {
  const seeded = await seedCustomerWithPortfolio(request, apiToken.token);
  const auth = { Authorization: `Bearer ${apiToken.token}` };
  const short = randomUUID().slice(0, 8);

  // Two direct uploads (deletable + archivable) and rely on the base
  // portfolio having nothing else on this project — three-row bulk exercise:
  // select 2 of them, archive one behavior, delete the other.
  const nameA = `bulk-a-${short}.txt`;
  const nameB = `bulk-b-${short}.txt`;
  for (const name of [nameA, nameB]) {
    const fileId = randomUUID();
    const res = await request.post(
      `/api/files/${fileId}?projectId=${seeded.inProgressProjectId}&kind=document&name=${encodeURIComponent(name)}`,
      { headers: { ...auth, 'Content-Type': 'text/plain' }, data: Buffer.from('bulk fixture bytes') },
    );
    if (!res.ok()) throw new Error(`bulk fixture upload failed: ${res.status()} ${await res.text()}`);
  }

  await authedPage.goto(`/documents?projectIds=${seeded.inProgressProjectId}`);
  await expect(tableRows(authedPage)).toHaveCount(2);

  // Select-all via the header checkbox, confirm the bulk bar reflects both.
  // .click() + a separate assertion, not .check() — these are React
  // controlled checkboxes whose `checked` prop only reflects after a
  // re-render, and Playwright's .check() samples the DOM property
  // immediately after its own click with no further retry.
  const bulkBar = authedPage.getByTestId('documents-bulkbar');
  const selectAll = authedPage.locator('table thead').getByRole('checkbox', { name: 'Select all documents' });
  await selectAll.click();
  await expect(selectAll).toBeChecked();
  await expect(bulkBar).toContainText('2 selected');

  // Scoped to the bulk bar — per-row Archive buttons share the same
  // accessible name ("Archive") and would otherwise make this a strict-mode
  // violation.
  await bulkBar.getByRole('button', { name: 'Archive' }).click();
  await expect(tableRows(authedPage)).toHaveCount(0);

  // Both rows moved into the Archived view.
  const archivedToggle = authedPage.getByTestId('doc-filter-archived');
  await archivedToggle.click();
  await expect(archivedToggle).toBeChecked();
  await expect(tableRows(authedPage)).toHaveCount(2);

  // Bulk-delete one of the two out of the archived view (deletable rows are
  // still direct uploads regardless of archived state).
  await rowFor(authedPage, nameA).getByLabel(`Select ${nameA}`, { exact: true }).check();
  await expect(bulkBar).toContainText('1 selected');
  await bulkBar.getByRole('button', { name: 'Delete (1 of 1)' }).click();
  await authedPage.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(rowFor(authedPage, nameA)).toHaveCount(0);
  await expect(rowFor(authedPage, nameB)).toHaveCount(1);
});

test('archive: a row leaves the default view, appears under Archived, restore returns it', async ({
  authedPage, request, apiToken,
}) => {
  const seeded = await seedCustomerWithPortfolio(request, apiToken.token);
  const auth = { Authorization: `Bearer ${apiToken.token}` };
  const short = randomUUID().slice(0, 8);
  const name = `archive-test-${short}.pdf`;

  const fileId = randomUUID();
  const res = await request.post(
    `/api/files/${fileId}?projectId=${seeded.inProgressProjectId}&kind=document&name=${encodeURIComponent(name)}`,
    { headers: { ...auth, 'Content-Type': 'application/pdf' }, data: Buffer.from('%PDF-1.4 archive fixture') },
  );
  if (!res.ok()) throw new Error(`archive fixture upload failed: ${res.status()} ${await res.text()}`);

  await authedPage.goto(`/documents?projectIds=${seeded.inProgressProjectId}`);
  await expect(rowFor(authedPage, name)).toHaveCount(1);

  await rowFor(authedPage, name).getByLabel('Archive', { exact: true }).click();
  await expect(rowFor(authedPage, name)).toHaveCount(0);

  const archivedToggle = authedPage.getByTestId('doc-filter-archived');
  await archivedToggle.click();
  await expect(archivedToggle).toBeChecked();
  await expect(authedPage).toHaveURL(/archived=1/);
  await expect(rowFor(authedPage, name)).toHaveCount(1);
  await expect(rowFor(authedPage, name).getByLabel('Restore', { exact: true })).toBeVisible();

  await rowFor(authedPage, name).getByLabel('Restore', { exact: true }).click();
  await expect(rowFor(authedPage, name)).toHaveCount(0);

  await archivedToggle.click();
  await expect(archivedToggle).not.toBeChecked();
  await expect(rowFor(authedPage, name)).toHaveCount(1);
});

test('project Documents nav lands on the global page pre-filtered to that project', async ({
  authedPage, request, apiToken,
}) => {
  const seeded = await seedCustomerWithPortfolio(request, apiToken.token);

  await authedPage.goto(`/project/${seeded.inProgressProjectId}`);
  await authedPage.getByRole('link', { name: 'Documents' }).click();

  await expect(authedPage).toHaveURL(new RegExp(`/documents\\?projectIds=${seeded.inProgressProjectId}$`));
  // A single selected project shows its own name as the dropdown summary
  // (MultiSelectDropdown.tsx: selected.length === 1 -> option label).
  await expect(authedPage.getByTestId('doc-filter-project')).toContainText(seeded.inProgressProjectName);
});

test('non-admin: billing kinds are absent, printout stays visible, page loads clean', async ({
  page, request, apiToken,
}) => {
  const seeded = await seedDocumentsPortfolio(request, apiToken.token);

  const username = `e2e-nonadmin-docs-${randomUUID().slice(0, 8)}`;
  const password = 'password123';
  const createRes = await request.post('/api/users', {
    headers: { Authorization: `Bearer ${apiToken.token}` },
    data: { username, password, role: 'user' },
  });
  if (!createRes.ok()) throw new Error(`user create failed: ${createRes.status()} ${await createRes.text()}`);
  const loginRes = await request.post('/api/auth/login', { data: { username, password } });
  if (!loginRes.ok()) throw new Error(`non-admin login failed: ${loginRes.status()} ${await loginRes.text()}`);
  const session = await loginRes.json();

  await page.addInitScript(
    ([token, user]) => {
      localStorage.setItem('token', token);
      localStorage.setItem('user', user);
    },
    [session.token, JSON.stringify(session.user)] as const,
  );

  await page.goto(`/documents?projectIds=${seeded.inProgressProjectId}`);
  await expect(page.getByTestId('documents-upload')).toBeVisible(); // page loads clean, no crash/blank state

  // Settle the fetch on a POSITIVE count first — `toHaveCount(0)` for the
  // billing rows below would trivially pass against the still-loading
  // skeleton (zero rows rendered yet either way), so a server-side gating
  // regression that actually returned those rows could slip through.
  // Waiting for the real settled count (printout + issue-photo, the two rows
  // this non-admin session should see) forces the fetch to complete before
  // the absence checks run.
  await expect(tableRows(page)).toHaveCount(2);

  await expect(rowFor(page, seeded.invoiceFileName)).toHaveCount(0);
  await expect(rowFor(page, seeded.payAppFileName)).toHaveCount(0);
  await expect(rowFor(page, seeded.printoutFileName)).toHaveCount(1);
  await expect(tableRows(page).filter({ hasText: 'site-photo-' })).toHaveCount(1); // issue-photo: not billing-priced either

  // Note: the Type filter's OPTION LIST (docTypes.ts KIND_OPTIONS) is a
  // static, role-agnostic constant — a non-admin can still pick "Invoice" as
  // a filter kind, it would just always return zero rows since the server
  // excludes those rows regardless of what's asked for. Only row visibility
  // is spec'd as role-gated (spec §Decisions "Role visibility"), so this test
  // doesn't assert on the dropdown's option list.
});

test('Settings Document Types: add, use in an upload, delete blocked while in use, rename reflects in the filter', async ({
  authedPage, request, apiToken,
}) => {
  const seeded = await seedCustomerWithPortfolio(request, apiToken.token);
  const short = randomUUID().slice(0, 8);
  const label = `E2E Warranty ${short}`;
  const renamedLabel = `E2E Warranty Renamed ${short}`;

  await authedPage.goto('/settings');
  await authedPage.getByRole('button', { name: 'General Settings' }).click();

  await authedPage.getByPlaceholder('e.g. Warranty').fill(label);
  await authedPage.getByRole('button', { name: 'Add' }).click();
  await expect(authedPage.getByText(label, { exact: true })).toBeVisible();

  // Use it in an upload.
  await authedPage.goto(`/documents?projectIds=${seeded.inProgressProjectId}`);
  await authedPage.getByTestId('documents-upload').click();
  const modal = authedPage.getByTestId('documents-upload-modal');
  const fileName = `warranty-doc-${short}.txt`;
  await modal.locator('input[type="file"]').setInputFiles([
    { name: fileName, mimeType: 'text/plain', buffer: Buffer.from('warranty doc') },
  ]);
  // Attribute to the seeded project — the row list below is filtered to it.
  await authedPage.getByLabel('Project', { exact: true }).selectOption({ label: seeded.inProgressProjectName });
  await authedPage.getByLabel('Type', { exact: true }).selectOption({ label });
  await authedPage.getByRole('button', { name: 'Upload (1)' }).click();
  await expect(modal).toBeHidden();
  await expect(rowFor(authedPage, fileName).getByText(label, { exact: true })).toBeVisible();

  // Delete is blocked while in use, with a count in the toast.
  await authedPage.goto('/settings');
  await authedPage.getByRole('button', { name: 'General Settings' }).click();
  const typeRow = authedPage.locator('li', { hasText: label });
  await typeRow.getByTitle('Delete').click();
  await expect(authedPage.getByText(`In use by 1 document — can't delete`)).toBeVisible();
  await expect(authedPage.getByText(label, { exact: true })).toBeVisible(); // still there, not removed

  // Rename reflects in the Documents type filter (and the row's own badge).
  // Not `typeRow.locator('input')` — entering edit mode replaces the label
  // <span> with an <input value=...>, and an input's value isn't part of its
  // textContent, so the `hasText: label` filter that found typeRow stops
  // matching the instant edit mode renders, and re-querying through it times
  // out. Only one row can be mid-edit at a time (single editingId state), so
  // a page-scoped query is unambiguous.
  await typeRow.getByTitle('Rename').click();
  await authedPage.locator('li input').fill(renamedLabel);
  // Unscoped — "Save" (exact) only exists while a row is mid-edit; the page's
  // other save action reads "Save Changes", so this stays unambiguous.
  await authedPage.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(authedPage.getByText(renamedLabel, { exact: true })).toBeVisible();

  await authedPage.goto(`/documents?projectIds=${seeded.inProgressProjectId}`);
  await expect(rowFor(authedPage, fileName).getByText(renamedLabel, { exact: true })).toBeVisible();
  await authedPage.getByTestId('doc-filter-type').click();
  const typePanel = authedPage.getByTestId('doc-filter-type').locator('..');
  await expect(typePanel.getByText(renamedLabel, { exact: true })).toBeVisible();
  await expect(typePanel.getByText(label, { exact: true })).toHaveCount(0);
});
