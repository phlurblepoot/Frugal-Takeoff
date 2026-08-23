import type { Browser } from '@playwright/test';
import { test, expect, login, seedProjectWithPage } from './fixtures/test';

// WS1 acceptance proof: two independently-authenticated browser contexts
// (two real socket connections, same JWT — mirrors two tabs/devices for the
// bootstrap admin user) land on the same project and see each other via the
// realtime presence protocol (sessions-snapshot / session-joined /
// session-left), not the old full-array `global-users` broadcast.
//
// UserPresenceOverlay hides itself on canvas `/page/` routes (it has its own
// sidebar list there — see UserPresenceOverlay.tsx), so this uses the
// non-canvas Takeoffs tab. Its floating button lives at a unique
// `.fixed.bottom-6.right-6.z-50` container (NotesBoard's similarly-positioned
// element is `absolute`, not `fixed`), so all assertions are scoped inside it
// to avoid colliding with "admin" text rendered elsewhere in the shell (e.g.
// the logged-in-user indicator).

async function openAuthedContext(browser: Browser, token: string, user: unknown) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(
    ([tok, userJson]) => {
      localStorage.setItem('token', tok);
      localStorage.setItem('user', userJson);
    },
    [token, JSON.stringify(user)] as const,
  );
  return { context, page };
}

test('two live sessions see each other in the presence overlay, and departure is reflected live', async ({ browser, request }) => {
  const { token, user } = await login(request);
  const seeded = await seedProjectWithPage(request, token);
  const projectPath = `/project/${seeded.projectId}/takeoff`;

  const a = await openAuthedContext(browser, token, user);
  const b = await openAuthedContext(browser, token, user);

  try {
    await a.page.goto(projectPath);
    await b.page.goto(projectPath);

    const presence = b.page.locator('div.fixed.bottom-6.right-6.z-50');
    await presence.locator('button').click();
    await expect(presence.getByText('Active Users')).toBeVisible();
    // B's overlay excludes B's own socket (UserPresenceOverlay filters
    // u.id !== socket.id) but must show A's independently-connected session.
    await expect(presence.getByText('admin', { exact: true })).toBeVisible();

    // Close A's context — its socket disconnects, the server broadcasts
    // `session-left`, and B's context should drop the entry live. This is
    // driven by the disconnect handler, not the (much slower) heartbeat
    // sweep, but give it a generous window rather than a fixed sleep.
    await a.context.close();
    await expect(presence.getByText('No other users online')).toBeVisible({ timeout: 15_000 });
  } finally {
    await a.context.close().catch(() => {});
    await b.context.close();
  }
});
