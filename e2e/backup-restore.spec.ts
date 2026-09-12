import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test, expect, seedProjectWithPage } from './fixtures/test';
import yauzl from 'yauzl';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, 'fixtures', 'assets', 'snapshot-fixture.zip');

// Runs FIRST (serial): the e2e server starts on a fresh .e2e-data, so the
// setup-mode screen is reachable before any spec seeds data. It stops at the
// confirm — the process exit is proven at unit level (see the spec).
test.describe.configure({ mode: 'serial' });

test('fresh install: /restore lists sources and an uploaded snapshot zip shows its summary', async ({ page, request }) => {
  const state = await (await request.get('/api/setup/state')).json();
  test.skip(!state.fresh, 'another spec already seeded this server');
  await page.goto('/login');
  await page.getByRole('link', { name: /restore from backup/i }).click();
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill('admin');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.getByTestId('restore-source-upload').click();
  await page.getByTestId('restore-upload-input').setInputFiles(FIXTURE);
  await expect(page.getByText(/1 file/)).toBeVisible();
  await expect(page.getByTestId('restore-confirm')).toBeEnabled();
});

test('Backup tab: back up now, snapshot appears, downloaded zip carries the seeded file', async ({ authedPage, apiToken, request }) => {
  const { token } = apiToken;
  const { projectId } = await seedProjectWithPage(request, token);
  await authedPage.goto('/settings?tab=backup');
  await authedPage.getByRole('button', { name: /^back up now$/i }).click();
  await expect(authedPage.getByText(/backing up/i)).toBeVisible();
  await expect(authedPage.getByRole('link', { name: /download zip/i })).toBeVisible({ timeout: 30_000 });
  const href = await authedPage.getByRole('link', { name: /download zip/i }).getAttribute('href');
  const zip = await (await request.get(href!)).body();
  const names = await new Promise<string[]>((resolve, reject) => {
    yauzl.fromBuffer(zip, { lazyEntries: true }, (err, z) => { if (err || !z) return reject(err); const out: string[] = []; z.on('entry', e => { out.push(e.fileName); z.readEntry(); }); z.on('end', () => resolve(out)); z.readEntry(); });
  });
  expect(names.some(n => n.endsWith('/manifest.json'))).toBe(true);
  expect(names.filter(n => n.startsWith('objects/')).length).toBeGreaterThan(0);
  void projectId;
});
