import { test, expect, login, seedProjectWithPage } from './fixtures/test';
import { openAuthedContext } from './fixtures/collab';

// WS1 acceptance proof: two independently-authenticated browser contexts
// (two real socket connections, same JWT — mirrors two tabs/devices for the
// bootstrap admin user) land on the same project and see each other via the
// realtime presence protocol (sessions-snapshot / session-joined /
// session-left), not the old full-array `global-users` broadcast.
//
// Presence now lives in ONE place app-wide: the sidebar's SidebarPresence
// popover (`sidebar-presence` trigger / `presence-popover` content), which
// replaced the old floating bottom-right bubble AND the canvas tool-pane's
// own Collaboration block (Task 6, UI rehaul Wave 1). It's reachable the
// same way on every route, including canvas, so there is no more
// "hides on canvas" special case to prove.

test('two live sessions see each other in the presence overlay, and departure is reflected live', async ({ browser, request }) => {
  const { token, user } = await login(request);
  const seeded = await seedProjectWithPage(request, token);
  const projectPath = `/project/${seeded.projectId}/takeoff`;

  const a = await openAuthedContext(browser, token, user);
  const b = await openAuthedContext(browser, token, user);

  try {
    await a.page.goto(projectPath);
    await b.page.goto(projectPath);

    await b.page.getByTestId('sidebar-presence').click();
    const presence = b.page.getByTestId('presence-popover');
    await expect(presence.getByText(/Online now/i)).toBeVisible();
    // B's own row is folded into a self ("you") group, but A's
    // independently-connected session must still show up as its own row.
    await expect(presence.getByText('admin', { exact: false })).toBeVisible();

    // Close A's context — its socket disconnects, the server broadcasts
    // `session-left`, and B's context should drop the entry live. This is
    // driven by the disconnect handler, not the (much slower) heartbeat
    // sweep, but give it a generous window rather than a fixed sleep.
    await a.context.close();
    // Empty state: only the self row remains (marked "(you)"), no one else,
    // and no Follow checkboxes.
    await expect(presence.getByText(/\(you\)/)).toBeVisible({ timeout: 15_000 });
    await expect(presence.getByRole('checkbox')).toHaveCount(0);
  } finally {
    await a.context.close().catch(() => {});
    await b.context.close();
  }
});
