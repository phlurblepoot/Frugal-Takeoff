import { randomUUID } from 'node:crypto';
import type { Locator } from '@playwright/test';
import { test, expect, login, seedCustomerWithPortfolio } from './fixtures/test';

// Mirrors src/utils/money.ts's formatMoney — used to derive assertion
// strings from seeded cents amounts instead of hand-computing literals.
const fmtCents = (cents: number): string =>
  (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD' });

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
  const seeded = await seedCustomerWithPortfolio(request, apiToken.token, { withPayApp: true });
  const payApp = seeded.payApp!;
  // Both legs are unpaid, so the combined Outstanding figure and the
  // Overview tile's "contract $X · invoices $Y" sub-line both apply.
  const combinedOutstandingCents = seeded.invoiceAmountCents + payApp.billedCents;

  await authedPage.goto('/customers');
  const sidebarRow = authedPage.getByTestId('customer-sidebar-row').filter({ hasText: seeded.customerName });
  await expect(sidebarRow).toBeVisible();
  await sidebarRow.click();

  await expect(authedPage).toHaveURL(new RegExp(`/customers/${seeded.customerId}`));
  await expect(authedPage.getByTestId('customer-pane')).toBeVisible();

  // Overview is the default tab (no ?tab= yet).
  await expect(authedPage.getByTestId('customer-tab-overview')).toHaveClass(/text-accent-600/);

  // Stat tiles: Bidding=1, In progress=1, Outstanding=$1,650.00 (combined
  // invoice + pay-app legs, both unpaid), Open tasks=1 (1 overdue). The
  // combined tile also carries a muted "contract $X · invoices $Y" sub-line
  // since both legs' outstandingCents are > 0 (CustomerOverviewTab.tsx).
  const tileValue = async (label: string) => {
    const tile = authedPage.getByText(label, { exact: true }).locator('..');
    return tile;
  };
  await expect(await tileValue('Bidding')).toContainText('1');
  await expect(await tileValue('In progress')).toContainText('1');
  const outstandingTile = await tileValue('Outstanding');
  await expect(outstandingTile).toContainText(fmtCents(combinedOutstandingCents));
  await expect(outstandingTile).toContainText(`contract ${fmtCents(payApp.billedCents)}`);
  await expect(outstandingTile).toContainText(`invoices ${fmtCents(seeded.invoiceAmountCents)}`);
  const openTasksTile = await tileValue('Open tasks');
  await expect(openTasksTile).toContainText('1');
  await expect(openTasksTile).toContainText('1 overdue');

  // Needs-attention: the overdue task, the upcoming bid, the outstanding
  // invoice, and the outstanding (finalized, unpaid) pay application.
  const attentionRows = authedPage.getByTestId('customer-attention-row');
  await expect(attentionRows).toHaveCount(4);
  await expect(attentionRows.filter({ hasText: seeded.taskTitle })).toHaveCount(1);
  await expect(attentionRows.filter({ hasText: seeded.biddingProjectName })).toHaveCount(1);
  await expect(attentionRows.filter({ hasText: `Invoice #${seeded.invoiceNumber}` })).toHaveCount(1);
  await expect(attentionRows.filter({ hasText: `Application #${payApp.payAppNumber}` })).toHaveCount(1);

  // Tasks tab shows the seeded task.
  await authedPage.getByTestId('customer-tab-tasks').click();
  await expect(authedPage).toHaveURL(/tab=tasks/);
  await expect(authedPage.getByText(seeded.taskTitle)).toBeVisible();

  // Billing tab: two-row Contract/Invoices summary split + ledger rows for
  // both the sent/unpaid invoice and the finalized/unpaid pay application.
  await authedPage.getByTestId('customer-tab-billing').click();
  await expect(authedPage).toHaveURL(/tab=billing/);

  // "Contract" row (SOV/pay-app leg) — scope label→value lookups to this
  // row's own section so "Paid" (which also appears in the Invoices row and
  // the ledger's column header) resolves to the right element.
  const rowValue = (container: Locator, label: string) =>
    container.getByText(label, { exact: true }).locator('..');
  const contractSection = authedPage.getByText('Contract', { exact: true }).locator('..');
  await expect(contractSection).toBeVisible();
  await expect(rowValue(contractSection, 'Contract total')).toContainText(fmtCents(payApp.sovAmountCents));
  await expect(rowValue(contractSection, 'Billed')).toContainText(fmtCents(payApp.billedCents));
  await expect(rowValue(contractSection, 'Outstanding')).toContainText(fmtCents(payApp.billedCents));
  await expect(rowValue(contractSection, 'Paid')).toContainText('$0.00');

  // "Invoices" row (invoice leg).
  const invoicesSection = authedPage.getByText('Invoices', { exact: true }).locator('..');
  await expect(invoicesSection).toBeVisible();
  await expect(rowValue(invoicesSection, 'Invoiced')).toContainText(fmtCents(seeded.invoiceAmountCents));
  await expect(rowValue(invoicesSection, 'Paid')).toContainText('$0.00');

  const invoiceLedgerRow = authedPage.getByRole('row', { name: new RegExp(seeded.invoiceNumber) });
  await expect(invoiceLedgerRow).toBeVisible();
  await expect(invoiceLedgerRow).toContainText(seeded.inProgressProjectName);
  await expect(invoiceLedgerRow).toContainText('Invoice');
  await expect(invoiceLedgerRow).toContainText('Sent');
  await expect(invoiceLedgerRow).toContainText('$750.00');

  const payAppLedgerRow = authedPage.getByRole('row').filter({ hasText: 'Pay Application' });
  await expect(payAppLedgerRow).toBeVisible();
  await expect(payAppLedgerRow).toContainText(seeded.inProgressProjectName);
  await expect(payAppLedgerRow).toContainText('Finalized');
  await expect(payAppLedgerRow).toContainText(fmtCents(payApp.billedCents));

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
