import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test, expect, seedProjectWithPage } from './fixtures/test';

// Characterization spec for the shared document-actions rollout (spec
// docs/superpowers/specs/2026-08-29-document-actions-rollout): the
// DocumentActionsBar (Generate/Open/Download/Send + status chip + the
// version-or-overwrite dialog) mounted in the invoice editor, and the
// AddFilesButton/FilePickerModal (Upload tab) mounted via PhotoDropCard in
// the issue editor.
//
// DocumentActionsBar and VersionOrOverwriteDialog each render their own
// `<Modal>`, and Modal portals to document.body (src/components/ui/Modal.tsx)
// — so once the version dialog is open there are TWO role="dialog" elements
// on the page. Its testids (doc-version-new/overwrite/cancel) are unique on
// the page regardless, so those steps query them directly on `authedPage`
// rather than through a `dialog` locator; the invoice editor's own dialog
// locator is only used for the line-item edit, which happens before that
// second dialog exists.

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_PHOTO_PNG = join(__dirname, 'fixtures', 'assets', 'test-page.png');

test('invoice document actions: generate → edit goes out of date → version → /versions has 2 rows', async ({
  authedPage, apiToken, request,
}) => {
  const { token } = apiToken;
  const auth = { Authorization: `Bearer ${token}` };
  const { projectId } = await seedProjectWithPage(request, token);

  const short = randomUUID().slice(0, 8);
  const invoiceNumber = `INV-${short}`;
  const invRes = await request.post(`/api/projects/${projectId}/invoices`, {
    headers: auth,
    data: {
      number: invoiceNumber,
      date: Date.now(),
      status: 'draft',
      lines: [{ description: 'Work performed', qty: 1, unitPrice: 500 }],
    },
  });
  if (!invRes.ok()) throw new Error(`invoice seed failed: ${invRes.status()} ${await invRes.text()}`);
  const invoice = await invRes.json();

  await authedPage.goto(`/project/${projectId}/billing?tab=invoices`);
  await authedPage.getByRole('row', { name: new RegExp(invoiceNumber) }).click();

  // Only the invoice editor's Modal is open at this point — safe to scope to
  // it for the line-item edit below.
  const editorDialog = authedPage.getByRole('dialog');
  await expect(editorDialog).toBeVisible();
  await expect(authedPage.getByTestId('doc-status')).toHaveText('No PDF yet');
  await expect(authedPage.getByTestId('doc-open')).toHaveCount(0);
  await expect(authedPage.getByTestId('doc-download')).toHaveCount(0);

  await authedPage.getByTestId('doc-generate').click();
  await expect(authedPage.getByTestId('doc-status')).toHaveText('PDF up to date', { timeout: 30_000 });
  await expect(authedPage.getByTestId('doc-open')).toBeVisible();
  await expect(authedPage.getByTestId('doc-download')).toBeVisible();

  // Edit the one line item → dirty → Save invoice → the stored PDF (built
  // from the pre-edit record) is now stale.
  const lineRow = editorDialog.locator('table tbody tr').first();
  await lineRow.getByRole('textbox').first().fill('Work performed - revised');
  await authedPage.getByRole('button', { name: 'Save invoice' }).click();
  await expect(authedPage.getByTestId('doc-status')).toHaveText('PDF out of date');

  // Regenerate: a file already exists, so the version/overwrite dialog asks
  // first. It is a second, separately-portaled Modal — query its testids
  // directly rather than through editorDialog.
  await authedPage.getByTestId('doc-generate').click();
  await expect(authedPage.getByText('Replace the existing PDF?')).toBeVisible();
  await authedPage.getByTestId('doc-version-new').click();
  await expect(authedPage.getByTestId('doc-status')).toHaveText('PDF up to date', { timeout: 30_000 });

  const bySource = await request.get(
    `/api/documents/by-source?sourceType=invoice&sourceId=${invoice.id}&kind=invoice`,
    { headers: auth },
  );
  expect(bySource.ok()).toBeTruthy();
  const doc = await bySource.json();
  const versionsRes = await request.get(`/api/files/${doc.id}/versions`, { headers: auth });
  expect(versionsRes.ok()).toBeTruthy();
  const versions = await versionsRes.json();
  expect(versions).toHaveLength(2);
});

test('issue editor: Add photos opens on the Upload tab; an uploaded image appears on the card', async ({
  authedPage, apiToken, request,
}) => {
  const { token } = apiToken;
  const { projectId } = await seedProjectWithPage(request, token);

  await authedPage.goto(`/project/${projectId}/issues`);
  await authedPage.getByLabel('New issue').fill('E2E photo issue');
  await authedPage.getByRole('button', { name: 'Add issue' }).click();

  const editorDialog = authedPage.getByRole('dialog');
  await expect(editorDialog).toBeVisible();
  await expect(editorDialog.getByTestId('issue-photo-dropzone')).toBeVisible();
  await expect(editorDialog.locator('[data-testid="issue-photo-dropzone"] img')).toHaveCount(0);

  await editorDialog.getByTestId('add-files-button').click();
  // PhotoDropCard's AddFilesButton passes defaultTab="upload", so the picker
  // (a second, separately-portaled Modal) opens straight on the Upload panel
  // — no "Upload" tab click needed.
  await expect(authedPage.getByTestId('picker-upload-panel')).toBeVisible();

  await authedPage.getByTestId('picker-upload-input').setInputFiles({
    name: 'issue-photo.png',
    mimeType: 'image/png',
    buffer: readFileSync(TEST_PHOTO_PNG),
  });

  // The picker stores the upload immediately, links it to the issue, and
  // closes itself.
  await expect(authedPage.getByTestId('picker-upload-panel')).toBeHidden({ timeout: 15_000 });
  await expect(editorDialog.locator('[data-testid="issue-photo-dropzone"] img')).toHaveCount(1);
});
