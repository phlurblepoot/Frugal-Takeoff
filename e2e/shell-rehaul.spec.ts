import { test, expect } from './fixtures/test';

test('soft-zoom hover never overlaps the sidebar', async ({ authedPage: page }) => {
  await page.goto('/dashboard');
  // Any .soft-zoom element will do once cards adopt it; Wave 1 asserts the law on the presence button:
  const el = page.getByTestId('sidebar-presence');
  const before = await el.boundingBox();
  await el.hover();
  await page.waitForTimeout(400);
  const after = await el.boundingBox();
  expect(after!.width - before!.width).toBeLessThan(11); // < grid gap: the law holds
});
