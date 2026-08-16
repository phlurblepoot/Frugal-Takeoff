import { randomUUID } from 'node:crypto';
import { test, expect, login, seedCustomerWithPortfolio } from './fixtures/test';

// Characterization spec for the customers split view (src/pages/customers/*)
// introduced by the customers/projects reorg: persistent sidebar + a tabbed
// pane (Overview / Projects / Tasks / Billing / Settings), Billing + money
// figures admin-gated end to end (server omits the fields; the client never
// renders them).
//
// The suite shares one server/DB across every spec file, so each test seeds
// its own uniquely-named customer via seedCustomerWithPortfolio() and scopes
// all assertions to that customer's own rows/text.

test('admin: sidebar select, overview tiles + attention, tasks tab, billing tab, settings edit', async ({ authedPage, request, apiToken }) => {
  const seeded = await seedCustomerWithPortfolio(request, apiToken.token);

  await authedPage.goto('/customers');
  const sidebarRow = authedPage.getByTestId('customer-sidebar-row').filter({ hasText: seeded.customerName });
  await expect(sidebarRow).toBeVisible();
  await sidebarRow.click();

  await expect(authedPage).toHaveURL(new RegExp(`/customers/${seeded.customerId}`));
  await expect(authedPage.getByTestId('customer-pane')).toBeVisible();

  // Overview is the default tab (no ?tab= yet).
  await expect(authedPage.getByTestId('customer-tab-overview')).toHaveClass(/text-accent-600/);

  // Stat tiles: Bidding=1, In progress=1, Outstanding=$750.00, Open tasks=1 (1 overdue).
  const tileValue = async (label: string) => {
    const tile = authedPage.getByText(label, { exact: true }).locator('..');
    return tile;
  };
  await expect(await tileValue('Bidding')).toContainText('1');
  await expect(await tileValue('In progress')).toContainText('1');
  await expect(await tileValue('Outstanding')).toContainText('$750.00');
  const openTasksTile = await tileValue('Open tasks');
  await expect(openTasksTile).toContainText('1');
  await expect(openTasksTile).toContainText('1 overdue');

  // Needs-attention: the overdue task, the upcoming bid, and the outstanding invoice.
  const attentionRows = authedPage.getByTestId('customer-attention-row');
  await expect(attentionRows).toHaveCount(3);
  await expect(attentionRows.filter({ hasText: seeded.taskTitle })).toHaveCount(1);
  await expect(attentionRows.filter({ hasText: seeded.biddingProjectName })).toHaveCount(1);
  await expect(attentionRows.filter({ hasText: `Invoice #${seeded.invoiceNumber}` })).toHaveCount(1);

  // Tasks tab shows the seeded task.
  await authedPage.getByTestId('customer-tab-tasks').click();
  await expect(authedPage).toHaveURL(/tab=tasks/);
  await expect(authedPage.getByText(seeded.taskTitle)).toBeVisible();

  // Billing tab: rollup + ledger row for the sent/unpaid invoice.
  await authedPage.getByTestId('customer-tab-billing').click();
  await expect(authedPage).toHaveURL(/tab=billing/);
  await expect(authedPage.getByText('Contract total')).toBeVisible();
  await expect(authedPage.getByText('Invoiced')).toBeVisible();
  const ledgerRow = authedPage.getByRole('row', { name: new RegExp(seeded.invoiceNumber) });
  await expect(ledgerRow).toBeVisible();
  await expect(ledgerRow).toContainText(seeded.inProgressProjectName);
  await expect(ledgerRow).toContainText('Invoice');
  await expect(ledgerRow).toContainText('Sent');
  await expect(ledgerRow).toContainText('$750.00');

  // Settings tab: edit a field and save.
  await authedPage.getByTestId('customer-tab-settings').click();
  await expect(authedPage).toHaveURL(/tab=settings/);
  const newPhone = `555-${randomUUID().slice(0, 4)}`;
  const phoneInput = authedPage.locator('#cust-phone');
  await phoneInput.fill(newPhone);
  await authedPage.getByRole('button', { name: 'Save' }).click();
  await expect(authedPage.getByText('Customer saved.')).toBeVisible();
  await expect(phoneInput).toHaveValue(newPhone);
});

test('non-admin: no Billing tab, no $ tiles, ?tab=billing falls back to overview', async ({ page, request, apiToken }) => {
  const seeded = await seedCustomerWithPortfolio(request, apiToken.token);

  // Create a fresh non-admin user via the admin token, then log in as them.
  const username = `e2e-nonadmin-${randomUUID().slice(0, 8)}`;
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

  // Deep-link straight into the customer with a stale/bookmarked ?tab=billing —
  // must fall back to overview rather than crash or render nothing.
  await page.goto(`/customers/${seeded.customerId}?tab=billing`);
  await expect(page.getByTestId('customer-pane')).toBeVisible();
  await expect(page.getByTestId('customer-tab-overview')).toHaveClass(/text-accent-600/);

  // No Billing tab button at all for a non-admin.
  await expect(page.getByTestId('customer-tab-billing')).toHaveCount(0);

  // Overview renders 3 tiles (no Outstanding): Bidding, In progress, Open tasks.
  await expect(page.getByText('Bidding', { exact: true })).toBeVisible();
  await expect(page.getByText('In progress', { exact: true })).toBeVisible();
  await expect(page.getByText('Open tasks', { exact: true })).toBeVisible();
  await expect(page.getByText('Outstanding', { exact: true })).toHaveCount(0);

  // Attention still lists the overdue task and the upcoming bid (non-money
  // items), but never the outstanding invoice (money-gated server-side).
  const attentionRows = page.getByTestId('customer-attention-row');
  await expect(attentionRows).toHaveCount(2);
  await expect(attentionRows.filter({ hasText: seeded.taskTitle })).toHaveCount(1);
  await expect(attentionRows.filter({ hasText: seeded.biddingProjectName })).toHaveCount(1);
  await expect(attentionRows.filter({ hasText: 'Invoice #' })).toHaveCount(0);

  // The header's admin-outstanding slot renders nothing for a non-admin.
  await expect(page.getByTestId('customer-outstanding-slot')).toBeEmpty();
});
