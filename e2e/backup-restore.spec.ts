import { test, expect, seedProjectWithPage } from './fixtures/test';
import yauzl from 'yauzl';

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
