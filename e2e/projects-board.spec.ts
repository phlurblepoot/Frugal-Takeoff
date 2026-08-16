import { randomUUID } from 'node:crypto';
import { test, expect, login } from './fixtures/test';

// Characterization spec for the three-tab Projects board (src/pages/ProjectsPage.tsx)
// introduced by the customers/projects reorg: statuses collapsed to
// bidding|in_progress, archived is a flag (not a stage), and lostBid marks an
// archived project that never converted.
//
// The suite shares one server/DB across every spec file (see e2e/pages.spec.ts's
// header comment), so every project ever seeded by any spec is present on this
// board. To get exact per-tab counts we seed all three projects under ONE fresh
// customer and use the board's own "customer filter" dropdown to scope the view
// to just that customer — the counts badge is computed from the filtered set
// (see ProjectsPage.tsx: `groups = groupSummaries(filtered, sort)`).

async function seedBoardProjects(request: import('@playwright/test').APIRequestContext, token: string) {
  const auth = { Authorization: `Bearer ${token}` };
  const short = randomUUID().slice(0, 8);

  const custRes = await request.post('/api/customers', {
    headers: auth,
    data: { name: `E2E Board Customer ${short}` },
  });
  if (!custRes.ok()) throw new Error(`customer create failed: ${custRes.status()} ${await custRes.text()}`);
  const customer = await custRes.json();
  const customerId = customer.id as string;
  const customerName = customer.name as string;

  const biddingId = randomUUID();
  const biddingName = `E2E Board Bidding ${short}`;
  const p1 = await request.post('/api/projects', {
    headers: auth,
    data: {
      id: biddingId, name: biddingName, createdAt: Date.now(), customerId,
      status: 'bidding', pages: [], takeoffs: [], version: 1,
    },
  });
  if (!p1.ok()) throw new Error(`bidding project create failed: ${p1.status()} ${await p1.text()}`);

  const inProgressId = randomUUID();
  const inProgressName = `E2E Board Active ${short}`;
  const p2 = await request.post('/api/projects', {
    headers: auth,
    data: {
      id: inProgressId, name: inProgressName, createdAt: Date.now(), customerId,
      status: 'in_progress', pages: [], takeoffs: [], version: 1,
    },
  });
  if (!p2.ok()) throw new Error(`in-progress project create failed: ${p2.status()} ${await p2.text()}`);

  // Archived + lost: created with archived/lostBid already set in the meta
  // blob (decomposeProject stashes any unrecognised top-level key into meta).
  const archivedLostId = randomUUID();
  // Deliberately doesn't contain the word "Lost" — the spec asserts the Lost
  // badge separately from the project name, and a name containing "Lost"
  // would make that assertion ambiguous (substring match on both).
  const archivedLostName = `E2E Board Declined ${short}`;
  const p3 = await request.post('/api/projects', {
    headers: auth,
    data: {
      id: archivedLostId, name: archivedLostName, createdAt: Date.now(), customerId,
      status: 'bidding', archived: true, lostBid: true, pages: [], takeoffs: [], version: 1,
    },
  });
  if (!p3.ok()) throw new Error(`archived-lost project create failed: ${p3.status()} ${await p3.text()}`);

  return {
    customerId, customerName,
    biddingId, biddingName,
    inProgressId, inProgressName,
    archivedLostId, archivedLostName,
  };
}

test('three tabs show counts, per-tab content, and the Lost badge in archive', async ({ authedPage, request }) => {
  const { token } = await login(request);
  const seeded = await seedBoardProjects(request, token);

  await authedPage.goto('/projects');
  await expect(authedPage.getByTestId('stage-tab-bidding')).toBeVisible();

  // Scope the board to just this customer's three projects via the customer
  // filter (first <select> in the controls row — the sort select is second
  // and carries its own aria-label).
  await authedPage.locator('select').first().selectOption({ label: seeded.customerName });

  const biddingTab = authedPage.getByTestId('stage-tab-bidding');
  const inProgressTab = authedPage.getByTestId('stage-tab-in_progress');
  const archiveTab = authedPage.getByTestId('stage-tab-archive');

  await expect(biddingTab).toContainText('1');
  await expect(inProgressTab).toContainText('1');
  // Archive deliberately carries no count badge.
  await expect(archiveTab).not.toContainText(/\d/);

  // Bidding tab is selected by default and shows only the bidding project.
  await expect(authedPage.getByTestId('project-row')).toHaveCount(1);
  await expect(authedPage.getByTestId('project-row').first()).toContainText(seeded.biddingName);

  await inProgressTab.click();
  await expect(authedPage.getByTestId('project-row')).toHaveCount(1);
  await expect(authedPage.getByTestId('project-row').first()).toContainText(seeded.inProgressName);

  await archiveTab.click();
  await expect(authedPage.getByTestId('project-row')).toHaveCount(1);
  const archiveRow = authedPage.getByTestId('project-row').first();
  await expect(archiveRow).toContainText(seeded.archivedLostName);
  await expect(archiveRow.getByText('Lost', { exact: true })).toBeVisible();
});

test('?stage= deep link selects the right tab, including a legacy param', async ({ authedPage, request }) => {
  const { token } = await login(request);
  const seeded = await seedBoardProjects(request, token);

  // A fresh (non-legacy) tab id.
  await authedPage.goto('/projects?stage=in_progress');
  await expect(authedPage.getByTestId('stage-tab-in_progress')).toHaveClass(/border-accent-500/);
  const search = authedPage.getByPlaceholder('Search projects…');
  await search.fill(seeded.inProgressName);
  await expect(authedPage.getByTestId('project-row')).toHaveCount(1);
  await expect(authedPage.getByTestId('project-row').first()).toContainText(seeded.inProgressName);

  // Legacy ?stage=estimating must land on the Bidding tab (pre-collapse
  // bookmark), per LEGACY_STAGE_PARAMS in ProjectsPage.tsx.
  await authedPage.goto('/projects?stage=estimating');
  await expect(authedPage.getByTestId('stage-tab-bidding')).toHaveClass(/border-accent-500/);
  const search2 = authedPage.getByPlaceholder('Search projects…');
  await search2.fill(seeded.biddingName);
  await expect(authedPage.getByTestId('project-row')).toHaveCount(1);
  await expect(authedPage.getByTestId('project-row').first()).toContainText(seeded.biddingName);
});
