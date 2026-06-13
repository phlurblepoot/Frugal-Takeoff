import { test, expect, seedProjectWithPage } from './fixtures/test';

test('authed user reaches the dashboard without redirect to login', async ({ authedPage }) => {
  await authedPage.goto('/dashboard');
  // Should stay on /dashboard (not bounce to /login) and render the dashboard.
  await expect(authedPage).toHaveURL(/\/dashboard/);
  await expect(authedPage.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
});

test('seeded project loads under an authed session', async ({ authedPage, apiToken, request }) => {
  const { projectId, name } = await seedProjectWithPage(request, apiToken.token);

  await authedPage.goto(`/project/${projectId}`);
  await expect(authedPage).toHaveURL(new RegExp(`/project/${projectId}`));
  // The project overview renders the project name once the summary loads.
  await expect(authedPage.getByText(name)).toBeVisible();
});
