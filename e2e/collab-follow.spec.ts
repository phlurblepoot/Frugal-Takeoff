import { test, expect, login, seedProjectWithPage } from './fixtures/test';
import { openAuthedContext } from './fixtures/collab';

// WS3 acceptance proof: app-wide session-scoped Follow (spec §5 + CollaborationContext
// lines ~159-182) — following a session auto-navigates you to wherever it goes, Stop
// halts that, and any manual navigation of your own clears it silently.
//
// Both contexts authenticate as the SAME seeded admin (openAuthedContext, same idiom
// as collab-presence.spec.ts) — two independent socket connections/sessions for one
// user. That's deliberate: Follow is keyed on sessionId (CollaborationContext's
// `followedUserId` state is misleadingly named — see WS3 self-review notes — but it
// truly stores a sessionId), so two sessions of the same account already exercise the
// session-scoped semantics without needing a second real user account (no e2e helper
// for that exists).
//
// IMPORTANT ROUTING DECISION: UserPresenceOverlay (the bottom-right popover) groups
// sessions by userId (src/utils/presence.ts groupSessionsByUser) and only renders a
// Follow checkbox for a group where `!isMe` — see UserPresenceOverlay.test.tsx
// ("shows the user's own second session under a 'You' row without a follow
// checkbox"). Since both contexts here share one userId, that checkbox is
// deliberately absent in the popover. CanvasView's own "Other Users" sidebar list
// (src/pages/CanvasView.tsx ~1733-1791), however, filters by sessionId only and
// offers Follow regardless of whose account it is — that's the one surface a
// same-account second session can actually be followed from, so scenarios 2-4 open
// Follow there. Scenario 1 (the session-list/device-label proof) uses the popover,
// exactly as it's the one surface meant to show the "You" grouping.
//
// SESSION CONTINUITY: once A is following B, B must navigate via in-app clicks, NOT
// `page.goto` — a full navigation tears down B's socket (a fresh reload gets a brand
// new server-assigned sessionId), which reads to CollaborationContext as B's session
// vanishing (`session-left`), clearing the follow relationship instead of moving it.
// A's own navigations are safe to do as `page.goto` throughout, since A is the
// follower, not the followed.
test.describe('app-wide session-scoped Follow', () => {
  test('session list, follow-navigation, Stop, and manual-nav-clears-follow', async ({ browser, request }) => {
    // Four scenarios, two contexts, several full-page reloads (each re-establishing
    // a socket) plus a 3s bounded wait for the Stop negative assertion — comfortably
    // over the 30s default under load. Same idiom as printout-email-large.spec.ts.
    test.setTimeout(60_000);
    const { token, user } = await login(request);
    const seeded = await seedProjectWithPage(request, token);
    const projectPath = `/project/${seeded.projectId}/takeoff`;
    const canvasPath = `/project/${seeded.projectId}/page/${seeded.pageId}`;

    const a = await openAuthedContext(browser, token, user);
    const b = await openAuthedContext(browser, token, user);

    try {
      await a.page.goto(projectPath);
      await b.page.goto(projectPath);

      // ── Scenario 1: session list shows B's device under a "You" row, and
      // offers no Follow checkbox there (own-session gate — see routing note above).
      const presence = a.page.locator('div.fixed.bottom-6.right-6.z-50');
      await presence.locator('button').click();
      await expect(presence.getByText('Active Users')).toBeVisible();
      await expect(presence.getByText('You')).toBeVisible();
      // headless Chromium on Linux -> deviceLabel() (server/realtime/deviceLabel.ts)
      // produces "Linux · Chrome".
      await expect(presence.getByText(/Chrome/)).toBeVisible();
      await expect(presence.getByRole('checkbox')).toHaveCount(0);

      // Open CanvasView's left tools panel — it starts closed (isLeftSidebarOpen
      // defaults to false) — to reach the "Other Users" Follow checkbox.
      await a.page.goto(canvasPath);
      await a.page.locator('button.right-0.translate-x-full').click();
      const followCheckbox = a.page.getByLabel('Follow');
      await expect(followCheckbox).toBeVisible();

      // ── Scenario 2: follow B. B is already on the Takeoff tab — a
      // different path from A's canvas page — so checking Follow immediately
      // syncs A there too (CollaborationContext navigates to the followed
      // session's CURRENT path on follow, not just its future moves; see
      // lines ~161-170). That unmounts CanvasView, and the checkbox with it,
      // so assert the sync via A's URL/pill rather than the checkbox's
      // checked state (which races the navigation and is gone by the time
      // we'd read it). Use `.click()`, not `.check()` — `.check()` waits to
      // confirm the box reads checked post-click, but the click itself
      // unmounts the checkbox (navigation away), so that confirmation would
      // spin against a detached node until the test times out.
      await followCheckbox.click();
      await expect(a.page).toHaveURL(new RegExp(`/project/${seeded.projectId}/takeoff$`), { timeout: 15_000 });
      await expect(a.page.getByText(/Following/)).toBeVisible();

      // B then moves (in-app) to Billing — A should follow live too.
      await b.page.getByRole('button', { name: 'Billing' }).click();
      await expect(a.page).toHaveURL(/\/billing$/, { timeout: 15_000 });
      await expect(a.page.getByText(/Following/)).toBeVisible();

      // ── Scenario 3: Stop halts further auto-navigation.
      await a.page.getByRole('button', { name: 'Stop' }).click();
      await expect(a.page.getByText(/Following/)).toHaveCount(0);

      await b.page.getByRole('button', { name: 'Takeoff & Estimate' }).click();
      // Bounded wait for the one allowed negative assertion: prove A did NOT
      // follow B back to the Takeoff tab.
      await a.page.waitForTimeout(3_000);
      await expect(a.page).toHaveURL(/\/billing$/);

      // ── Scenario 4: re-follow, then A's OWN manual navigation clears the pill.
      // B is still on the Takeoff tab (from scenario 3), a different path from
      // A's canvas page, so — as in scenario 2 — the follow click itself
      // triggers an immediate sync-navigation that unmounts the checkbox;
      // `.click()` (not `.check()`) avoids waiting on the now-detached node.
      await a.page.goto(canvasPath);
      await a.page.locator('button.right-0.translate-x-full').click();
      await a.page.getByLabel('Follow').click();
      await expect(a.page).toHaveURL(new RegExp(`/project/${seeded.projectId}/takeoff$`), { timeout: 15_000 });
      await expect(a.page.getByText(/Following/)).toBeVisible();

      await a.page.getByRole('button', { name: 'All Projects' }).click();
      await expect(a.page.getByText(/Following/)).toHaveCount(0);
    } finally {
      await a.context.close().catch(() => {});
      await b.context.close().catch(() => {});
    }
  });
});
