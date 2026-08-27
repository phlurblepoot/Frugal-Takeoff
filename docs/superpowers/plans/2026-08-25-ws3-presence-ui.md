# WS3 — Presence UI: Sessions, Follow, Page Guard, Live Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The online-users UI shows every session of every user (device labels + readable locations, own other sessions included), Follow works app-wide with a Stop pill, the broken page-view guard is rebuilt on live sessions, and the Dashboard + activity feeds go live.

**Architecture:** Everything builds on data that already flows: `useCollaboration().sessions` (SessionView[] with device/location/editing) and `useLiveQuery`. A new pure `src/utils/presence.ts` module (session grouping + readable location strings) feeds a rebuilt `UserPresenceOverlay`, a rebuilt canvas Collaboration sidebar, and new `FollowPill`/`PageViewerDots` components — deleting all three duplicated `collapseSessions` implementations. Follow keeps its existing mechanism (context navigates to the followed session's `location.path`) but gains missing semantics: stop on manual navigation, clear on disconnect, and a visible pill. The `/api/pages/active` endpoint + 5s poll die; guards read sessions directly. Dashboard/ProjectOverview convert to `useLiveQuery` with broad type filters (no new 'activity' event type — refetch on the entity events that generate activity).

**Tech Stack:** React 19 + existing CollaborationContext/useLiveQuery/useCollabEditing hooks, motion (AnimatePresence, already used in the overlay), lucide-react icons, Vitest RTL (fake-socket + mocked-context pattern from `src/hooks/useLiveQuery.test.tsx`), Playwright two-context specs (fixtures in `e2e/fixtures/`).

**Spec:** `docs/superpowers/specs/2026-08-23-realtime-collaboration-design.md` (§5 = WS3). Progress: `docs/superpowers/specs/2026-08-23-realtime-collaboration-checklist.md` — tick WS3 items with commit hashes in the same commit as the work.

## Global Constraints

- **No secure-context browser APIs** in `src/**` (plain-HTTP LAN; use the `uuid` package if an id is ever needed).
- No schema/migration changes; single-process; all existing tests keep passing (`npm run test` 1084+, `npm run lint` clean, `npm run test:e2e` 50+).
- Git: commit per task on `testing`; push only in the final task; commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **e2e selector contract:** `e2e/collab-presence.spec.ts` asserts against the overlay container `div.fixed.bottom-6.right-6.z-50`, the empty-state text `No other users online`, and visible user names. The rebuilt overlay MUST keep that container class string, that empty-state string, and name visibility — or the same commit updates the spec (prefer keeping them stable).
- **Ruled deviation (spec §5 wrote "canvas cursor/viewport-follow continues to work"):** exploration proved no viewport/cursor-follow ever existed — Follow was always only route navigation via context. WS3 keeps route-follow semantics and does NOT build new viewport tracking (YAGNI; "existing behavior" = none). The canvas Follow checkboxes keep working through the same context mechanism.
- Follow attaches to a **session** (`followedUserId` state actually holds a sessionId — keep the name to avoid churn; WS4 may rename). Passive: no notification to the followed user.
- Legacy `users`/`globalUsers` derivations in CollaborationContext stay (CanvasView/PdfCanvas cursors still consume them until WS4). What dies in WS3 is the three duplicated per-user collapse implementations.

## File Structure

| File | Responsibility |
|---|---|
| Create `src/utils/presence.ts` (+test) | pure helpers: `groupSessionsByUser`, `describeLocation`, `humanizeSection` |
| Modify `src/context/CollaborationContext.tsx` (+test additions) | follow stop-on-manual-nav, clear-on-disconnect, canvas-only location label |
| Rewrite `src/components/UserPresenceOverlay.tsx` (+test) | grouped per-user rows expandable to per-session rows |
| Create `src/components/FollowPill.tsx` (+test), modify `src/App.tsx` | "Following … — Stop" pill |
| Modify `src/pages/CanvasView.tsx`, `src/components/PdfCanvas.tsx` | sidebar rebuilt on sessions; per-session cursors; delete collapse copies |
| Create `src/components/PageViewerDots.tsx`; modify `src/pages/ProjectView.tsx`, `src/pages/ProjectsPage.tsx`, `server.ts`, `src/utils/store.ts` | guard rebuild; endpoint + poll deletion |
| Modify `src/pages/Dashboard.tsx`, `src/pages/project/ProjectOverview.tsx` | live conversion |
| Modify `src/hooks/useCollabEditing.ts`, `src/pages/project/ProjectSettings.tsx`, spec doc | carried items |
| Create `e2e/fixtures/collab.ts`, `e2e/collab-follow.spec.ts`; modify 3 existing collab specs | shared helper + follow proof |

---

### Task 1: Presence utils (pure module)

**Files:**
- Create: `src/utils/presence.ts`
- Test: `src/utils/presence.test.ts`

**Interfaces:**
- Consumes: `SessionView` type from `../context/CollaborationContext` (import type only — module stays render-free).
- Produces (later tasks import these exact names):

```ts
export interface UserGroup {
  userId: string;
  name: string;          // display name (from any session)
  color: string;         // first session's color
  isMe: boolean;
  sessions: SessionView[];  // all sessions for this user; for isMe, EXCLUDES mySessionId
}

// Groups sessions per user for the online list.
// - The caller's own session (mySessionId) is excluded; the "me" group appears
//   ONLY if I have other sessions (a forgotten office tab, the iPad).
// - Groups sorted: others alphabetically by name, me last.
export function groupSessionsByUser(sessions: SessionView[], mySessionId: string | null): UserGroup[];

// "billing" -> "Billing", "rfis" -> "RFIs", "punch" -> "Punch List",
// "page" -> "Canvas", "overview" -> "Overview", unknown -> capitalized input.
export function humanizeSection(section: string | undefined): string;

// Readable one-liner for a session's location.
// projectNames maps projectId -> project name (may be empty — degrade gracefully).
//  - null location                      -> 'Online'
//  - canvas page (pageId + label)       -> '<Project> · <page label>'  (or just label without a name)
//  - canvas page (pageId, no label)     -> '<Project> · Canvas'
//  - project route                      -> '<Project> · <humanized section>' (project name falls back to 'A project')
//  - '/dashboard'->'Dashboard', '/projects'->'Projects', '/tasks'->'Tasks', '/documents'->'Documents',
//    '/customers'(+/:id)->'Customers', '/time'->'Time', '/settings'->'Settings',
//    '/tools/pdf'->'PDF editor', '/tools/sheets'->'Spreadsheet editor', anything else -> 'Online'
export function describeLocation(
  location: SessionView['location'],
  projectNames: Record<string, string>,
): string;
```

- [ ] **Step 1: Write the failing test**

```ts
// src/utils/presence.test.ts
import { describe, it, expect } from 'vitest';
import { groupSessionsByUser, humanizeSection, describeLocation } from './presence';
import type { SessionView } from '../context/CollaborationContext';

const sess = (over: Partial<SessionView>): SessionView => ({
  sessionId: 's1', userId: 'u1', name: 'nathan', role: 'admin', color: '#3b82f6',
  device: 'Windows · Chrome', location: null, editing: null, cursor: null, lastActive: 1,
  ...over,
});

describe('groupSessionsByUser', () => {
  it('groups by user, excludes my own session, sorts others alphabetically with me last', () => {
    const groups = groupSessionsByUser([
      sess({ sessionId: 'me', userId: 'u1', name: 'nathan' }),
      sess({ sessionId: 'me2', userId: 'u1', name: 'nathan', device: 'iPad · Safari' }),
      sess({ sessionId: 'z1', userId: 'u3', name: 'zoe' }),
      sess({ sessionId: 'a1', userId: 'u2', name: 'amy' }),
      sess({ sessionId: 'a2', userId: 'u2', name: 'amy', device: 'Mac · Safari' }),
    ], 'me');
    expect(groups.map(g => g.name)).toEqual(['amy', 'zoe', 'nathan']);
    expect(groups[0].sessions).toHaveLength(2);
    expect(groups[2].isMe).toBe(true);
    expect(groups[2].sessions.map(s => s.sessionId)).toEqual(['me2']); // my own session excluded
  });

  it('omits the me-group when I have no other sessions', () => {
    const groups = groupSessionsByUser([
      sess({ sessionId: 'me', userId: 'u1' }),
      sess({ sessionId: 'b', userId: 'u2', name: 'amy' }),
    ], 'me');
    expect(groups.map(g => g.name)).toEqual(['amy']);
  });

  it('handles null mySessionId (socket not yet connected)', () => {
    const groups = groupSessionsByUser([sess({ sessionId: 'x', userId: 'u2', name: 'amy' })], null);
    expect(groups).toHaveLength(1);
    expect(groups[0].isMe).toBe(false);
  });
});

describe('humanizeSection', () => {
  it.each([
    ['billing', 'Billing'], ['rfis', 'RFIs'], ['punch', 'Punch List'],
    ['page', 'Canvas'], ['overview', 'Overview'], ['issues', 'Issues'],
    ['takeoff', 'Takeoff'], ['proposal', 'Proposal'], ['weird', 'Weird'], [undefined, 'Overview'],
  ])('%s -> %s', (input, expected) => expect(humanizeSection(input as any)).toBe(expected));
});

describe('describeLocation', () => {
  const names = { p1: 'Dania Beach' };
  it('null -> Online', () => expect(describeLocation(null, names)).toBe('Online'));
  it('canvas with label', () => expect(describeLocation(
    { path: '/project/p1/page/pg1', projectId: 'p1', section: 'page', pageId: 'pg1', label: 'Level 06' }, names))
    .toBe('Dania Beach · Level 06'));
  it('canvas without label', () => expect(describeLocation(
    { path: '/project/p1/page/pg1', projectId: 'p1', section: 'page', pageId: 'pg1' }, names))
    .toBe('Dania Beach · Canvas'));
  it('project section', () => expect(describeLocation(
    { path: '/project/p1/billing', projectId: 'p1', section: 'billing' }, names))
    .toBe('Dania Beach · Billing'));
  it('unknown project name degrades', () => expect(describeLocation(
    { path: '/project/pX/issues', projectId: 'pX', section: 'issues' }, names))
    .toBe('A project · Issues'));
  it.each([
    ['/dashboard', 'Dashboard'], ['/projects', 'Projects'], ['/tasks', 'Tasks'],
    ['/documents', 'Documents'], ['/customers', 'Customers'], ['/customers/c1', 'Customers'],
    ['/time', 'Time'], ['/settings', 'Settings'], ['/tools/pdf', 'PDF editor'],
    ['/tools/sheets', 'Spreadsheet editor'], ['/whatever', 'Online'],
  ])('%s -> %s', (path, expected) => expect(describeLocation({ path }, names)).toBe(expected));
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run --project ui src/utils/presence.test.ts` → module not found.

- [ ] **Step 3: Implement**

```ts
// src/utils/presence.ts
// Pure presence helpers shared by the online list, canvas sidebar, follow
// pill, and page-viewer dots. Render-free by design.
import type { SessionView } from '../context/CollaborationContext';

export interface UserGroup {
  userId: string;
  name: string;
  color: string;
  isMe: boolean;
  sessions: SessionView[];
}

export function groupSessionsByUser(sessions: SessionView[], mySessionId: string | null): UserGroup[] {
  const byUser = new Map<string, SessionView[]>();
  let myUserId: string | null = null;
  for (const s of sessions) {
    if (s.sessionId === mySessionId) { myUserId = s.userId; continue; }
    const list = byUser.get(s.userId) ?? [];
    list.push(s);
    byUser.set(s.userId, list);
  }
  const groups: UserGroup[] = [];
  for (const [userId, list] of byUser) {
    groups.push({
      userId,
      name: list[0].name,
      color: list[0].color,
      isMe: userId === myUserId,
      sessions: list,
    });
  }
  groups.sort((a, b) => (a.isMe === b.isMe ? a.name.localeCompare(b.name) : a.isMe ? 1 : -1));
  return groups;
}

const SECTION_LABELS: Record<string, string> = {
  overview: 'Overview', takeoff: 'Takeoff', page: 'Canvas', billing: 'Billing',
  issues: 'Issues', rfis: 'RFIs', punch: 'Punch List', notes: 'Notes',
  time: 'Time', proposal: 'Proposal', settings: 'Settings', documents: 'Documents',
};

export function humanizeSection(section: string | undefined): string {
  if (!section) return 'Overview';
  return SECTION_LABELS[section] ?? section.charAt(0).toUpperCase() + section.slice(1);
}

const PATH_LABELS: [RegExp, string][] = [
  [/^\/dashboard$/, 'Dashboard'], [/^\/projects$/, 'Projects'], [/^\/tasks$/, 'Tasks'],
  [/^\/documents$/, 'Documents'], [/^\/customers(\/|$)/, 'Customers'], [/^\/time$/, 'Time'],
  [/^\/settings$/, 'Settings'], [/^\/tools\/pdf$/, 'PDF editor'], [/^\/tools\/sheets$/, 'Spreadsheet editor'],
];

export function describeLocation(
  location: SessionView['location'],
  projectNames: Record<string, string>,
): string {
  if (!location) return 'Online';
  if (location.projectId) {
    const project = projectNames[location.projectId] ?? 'A project';
    if (location.pageId) return `${project} · ${location.label || 'Canvas'}`;
    return `${project} · ${humanizeSection(location.section)}`;
  }
  for (const [re, label] of PATH_LABELS) if (re.test(location.path)) return label;
  return 'Online';
}
```

- [ ] **Step 4: Run** — the test file passes; `npm run lint` clean.
- [ ] **Step 5: Commit**

```bash
git add src/utils/presence.ts src/utils/presence.test.ts
git commit -m "feat(presence): session grouping + readable location helpers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Follow semantics + location-label fix in CollaborationContext

**Files:**
- Modify: `src/context/CollaborationContext.tsx` (follow effect ~L157-163; set-location effect ~L136-141; label-reset effect ~L144-146)
- Test: extend `src/context/CollaborationContext.test.tsx`

**Interfaces:**
- Produces (behavior contract — each is a test):
  1. **Clear-on-disconnect:** when `followedUserId` is set and no session with that id exists in `sessions`, `followedUserId` resets to null (today it silently dangles).
  2. **Auto-navigation still works:** followed session's `location.path` change → `navigate(path)` (existing behavior, keep).
  3. **Stop on manual navigation:** if the pathname changes to something that is neither the followed session's current path nor the path we just auto-navigated to, `followedUserId` resets to null.
  4. **Canvas-only label:** `set-location` sends `label` ONLY on canvas routes (pathname matching `/page/`); other routes send `label: undefined` — kills the stale-canvas-name gotcha where `/project/x/billing` inherited a leftover page name.
- Consumed by: FollowPill (Task 4) reads `sessions` + `followedUserId` + `setFollowedUserId` — no new context surface needed.

- [ ] **Step 1: Write the failing tests** (extend the existing test file — it already has `fakeSocket`, `SESSION`, `mount()` and mocks; add a navigate spy by mocking `useNavigate` if not already, and a `Probe` that exposes `followedUserId` + a `follow(id)` button):

```tsx
// additions to src/context/CollaborationContext.test.tsx — adapt to the file's existing
// scaffolding (fakeSocket, SESSION fixture, mount helper). New/updated pieces:

const navigateSpy = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useNavigate: () => navigateSpy,
}));

function FollowProbe() {
  const { sessions, followedUserId, setFollowedUserId } = useCollaboration();
  return (
    <div>
      <span data-testid="followed">{followedUserId ?? 'none'}</span>
      <button data-testid="follow-sB" onClick={() => setFollowedUserId('sB')}>follow</button>
      <span data-testid="count">{sessions.length}</span>
    </div>
  );
}

const OTHER = { ...SESSION, sessionId: 'sB', userId: 'u2', name: 'sam',
  location: { path: '/project/p1/billing', projectId: 'p1', section: 'billing' } };

it('navigates to the followed session path and clears follow when the session disconnects', async () => {
  render(<MemoryRouter initialEntries={['/dashboard']}><CollaborationProvider><FollowProbe /></CollaborationProvider></MemoryRouter>);
  act(() => fakeSocket.fire('sessions-snapshot', { selfId: 'sA', sessions: [SESSION, OTHER] }));
  act(() => { screen.getByTestId('follow-sB').click(); });
  await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith('/project/p1/billing'));
  act(() => fakeSocket.fire('session-left', { sessionId: 'sB' }));
  await waitFor(() => expect(screen.getByTestId('followed').textContent).toBe('none'));
});

it('sends label only on canvas routes', () => {
  // mount at a canvas path: assert set-location emitted with a label;
  // mount at /project/p1/billing: assert set-location emitted with label: undefined.
  // (two renders with different initialEntries; inspect fakeSocket.emit calls for 'set-location')
});
```

Write the second test out fully (inspect `fakeSocket.emit.mock.calls.filter(c => c[0] === 'set-location')`, asserting `label` presence/absence). For the stop-on-manual-navigation behavior, jsdom + MemoryRouter makes simulating a real user navigation awkward inside the provider test; cover it instead at the FollowPill/e2e level (Task 4 RTL asserts Stop works; Task 9's e2e asserts manual navigation stops following for real). Note this in the test file as a comment.

- [ ] **Step 2: Run to verify the new tests fail.**

- [ ] **Step 3: Implement** in `CollaborationContext.tsx`:

```tsx
  // Follow: navigate to wherever the followed session goes; clear when it vanishes.
  const followNavRef = useRef<string | null>(null);
  useEffect(() => {
    if (!followedUserId) return;
    const followed = sessions.find(s => s.sessionId === followedUserId);
    if (!followed) { setFollowedUserId(null); followNavRef.current = null; return; }
    const path = followed.location?.path;
    if (path && path !== location.pathname) {
      followNavRef.current = path;
      navigate(path);
    }
  }, [followedUserId, sessions, location.pathname, navigate]);

  // Manual navigation (anywhere that isn't the followed path or our own auto-nav) stops following.
  useEffect(() => {
    if (!followedUserId) return;
    const followedPath = sessions.find(s => s.sessionId === followedUserId)?.location?.path;
    if (location.pathname !== followedPath && location.pathname !== followNavRef.current) {
      setFollowedUserId(null);
      followNavRef.current = null;
    }
    // deliberately keyed on pathname only: this is a "did the URL move under us" check
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);
```

And the set-location effect:

```tsx
  useEffect(() => {
    if (!socket) return;
    const isCanvas = location.pathname.includes('/page/');
    socket.emit('set-location', locationFromPath(location.pathname, location.search, isCanvas ? currentPageName : undefined));
  }, [socket, location.pathname, location.search, currentPageName]);
```

(Also update `latestLocationRef` the same way — it must store the same payload that is emitted; keep the reconnect re-emit intact.)

- [ ] **Step 4: Run** — context tests + full ui project + lint.
- [ ] **Step 5: Commit**

```bash
git add src/context/CollaborationContext.tsx src/context/CollaborationContext.test.tsx
git commit -m "feat(presence): follow clears on disconnect + stops on manual nav; canvas-only location labels

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Rebuild UserPresenceOverlay on sessions

**Files:**
- Rewrite: `src/components/UserPresenceOverlay.tsx`
- Test: `src/components/UserPresenceOverlay.test.tsx` (new)

**Interfaces:**
- Consumes: `useCollaboration()` (`sessions`, `mySessionId`, `followedUserId`, `setFollowedUserId`), `groupSessionsByUser`/`describeLocation` (Task 1), `getProjectsSummary` from store (for the projectId→name map), `useNavigate`.
- Produces (behavior contract):
  - Container keeps EXACTLY `className="fixed bottom-6 right-6 z-50"` and the toggle-button + popover structure (e2e contract). Badge count = number of user groups (not sessions).
  - Empty state text stays exactly `No other users online`.
  - One row per user group: avatar (first letter, color), name (own group labeled `You`), session count shown when >1 (e.g. `2 sessions`).
  - Rows with >1 session expand/collapse (chevron) to per-session sub-rows; single-session users render their session inline (device + location on the main row, no expansion).
  - Each session row: `device` label + `describeLocation(...)` + a Follow checkbox (`followedUserId === session.sessionId`; own sessions get NO follow checkbox) + click navigates to `session.location?.path` when present.
  - Project names: on first popover open, fetch `getProjectsSummary()` and build `{[id]: name}`; refresh while open via `useLiveQuery(loadNames, { types: ['project'] })` where `loadNames` no-ops until the popover has been opened once.
  - Hidden on canvas routes exactly as before (`location.pathname.includes('/page/')` → null).
  - Restyle to the app's current token idiom (`bg-surface`, `text-ink`, `text-ink-soft`, `border-edge` — mirror Dashboard.tsx's classes) while preserving the container class string above.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/UserPresenceOverlay.test.tsx
// Reuse the fake-socket + mocked-context scaffolding idiom (see src/hooks/useLiveQuery.test.tsx).
// Mock ../context/CollaborationContext's useCollaboration to return controlled sessions;
// mock ../utils/store getProjectsSummary to resolve [{id:'p1', name:'Dania Beach', ...}].
// Tests:
//  1. renders nothing on canvas routes (MemoryRouter at /project/p1/page/pg9)
//  2. badge shows group count: sessions = [me, amy-chrome, amy-ipad] -> badge '1'
//  3. open popover: amy row shows '2 sessions'; expanding shows both device labels
//     ('Windows · Chrome', 'iPad · Safari') and readable locations ('Dania Beach · Billing')
//     after getProjectsSummary resolves
//  4. own second session appears under a 'You' row without a follow checkbox
//  5. follow checkbox toggles setFollowedUserId with the SESSION id
//  6. empty state: only my own single session -> popover text 'No other users online'
```

Write all six out fully (the mocked `useCollaboration` returns `{sessions, mySessionId:'me', followedUserId:null, setFollowedUserId: spy, socket: fakeSocket}`; sessions fixtures mirror Task 1's `sess()` helper).

- [ ] **Step 2: Run to verify it fails** (current component doesn't render device labels/groups).

- [ ] **Step 3: Rewrite the component.** Full structure (adapt styling classes to what Dashboard.tsx actually uses — read it first):

```tsx
// src/components/UserPresenceOverlay.tsx
import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronDown, ChevronRight, Monitor, Users } from 'lucide-react';
import { useCollaboration } from '../context/CollaborationContext';
import { groupSessionsByUser, describeLocation } from '../utils/presence';
import { useLiveQuery } from '../hooks/useLiveQuery';
import { getProjectsSummary } from '../utils/store';

export const UserPresenceOverlay: React.FC = () => {
  const { sessions, mySessionId, followedUserId, setFollowedUserId } = useCollaboration();
  const [isOpen, setIsOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [projectNames, setProjectNames] = useState<Record<string, string>>({});
  const openedOnceRef = useRef(false);
  const location = useLocation();
  const navigate = useNavigate();

  const loadNames = async () => {
    if (!openedOnceRef.current) return;
    try {
      const list = await getProjectsSummary();
      setProjectNames(Object.fromEntries(list.map(p => [p.id, p.name])));
    } catch { /* names are cosmetic — degrade to 'A project' */ }
  };
  useLiveQuery(loadNames, { types: ['project'] });
  useEffect(() => { if (isOpen && !openedOnceRef.current) { openedOnceRef.current = true; void loadNames(); } }, [isOpen]);

  if (location.pathname.includes('/page/')) return null;

  const groups = groupSessionsByUser(sessions, mySessionId);

  return (
    <div className="fixed bottom-6 right-6 z-50">
      {/* toggle button: Users icon + badge {groups.length}, same shape as before */}
      {/* popover (AnimatePresence): */}
      {/*   groups.length === 0 -> <p>No other users online</p> */}
      {/*   else per group: header row (avatar circle w/ group.color, name or 'You', */}
      {/*     '(N sessions)' when N>1 with chevron toggling expanded[userId]); */}
      {/*   session rows (all rows when expanded or group has 1 session): */}
      {/*     <Monitor size={12}/> {s.device} · {describeLocation(s.location, projectNames)} */}
      {/*     [follow checkbox unless group.isMe]: checked={followedUserId===s.sessionId} */}
      {/*       onChange -> setFollowedUserId(checked ? s.sessionId : null) */}
      {/*     row click -> s.location?.path && (navigate(s.location.path), setIsOpen(false)) */}
    </div>
  );
};
```

Flesh out the full JSX (the comments above are the structure contract; write real markup with the token classes). Delete the old `collapseSessions` + local `User` interface entirely.

- [ ] **Step 4: Run** — component tests + full ui project + lint. Then `npx playwright test collab-presence` — MUST still pass (container class, empty-state text, name visibility preserved).
- [ ] **Step 5: Commit**

```bash
git add src/components/UserPresenceOverlay.tsx src/components/UserPresenceOverlay.test.tsx
git commit -m "feat(presence): online list shows per-user session groups with devices + locations

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: FollowPill

**Files:**
- Create: `src/components/FollowPill.tsx`
- Modify: `src/App.tsx` (mount beside `<UserPresenceOverlay />`)
- Test: `src/components/FollowPill.test.tsx`

**Interfaces:**
- Consumes: `useCollaboration()` (`sessions`, `followedUserId`, `setFollowedUserId`).
- Produces: renders null unless `followedUserId` matches a live session. Otherwise a fixed pill: top-center, `z-50`, mobile-safe (`top-[calc(3.5rem+env(safe-area-inset-top)+0.5rem)] md:top-4 left-1/2 -translate-x-1/2` — the mobile offset clears AppShell's fixed h-14 top bar), token styling, text `Following {name} ({device})` + a `Stop` button calling `setFollowedUserId(null)`.

- [ ] **Step 1: Write the failing test** (mocked context: no follow → renders nothing; followed session present → shows `Following sam (Mac · Safari)`; Stop click → `setFollowedUserId(null)`; followed id with no matching session → renders nothing).

```tsx
// src/components/FollowPill.test.tsx — mocked useCollaboration, three tests as above.
// Fixtures mirror Task 1's sess() helper.
```

Write it out fully.

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** the component per the contract (small: ~30 lines) and mount `<FollowPill />` in `App.tsx` directly after `<UserPresenceOverlay />`.
- [ ] **Step 4: Run** — tests + lint.
- [ ] **Step 5: Commit**

```bash
git add src/components/FollowPill.tsx src/components/FollowPill.test.tsx src/App.tsx
git commit -m "feat(presence): app-wide Following pill with Stop

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Canvas-side dedup — sidebar on sessions, per-session cursors

**Files:**
- Modify: `src/pages/CanvasView.tsx` (~L1733-1787 Collaboration section; delete `collapseSessions` at ~L2572-2585 + local `CollabUser` interface)
- Modify: `src/components/PdfCanvas.tsx` (~L2306-2317 inline collapse)

**Interfaces:**
- Consumes: `sessions`, `mySessionId` from `useCollaboration()` (CanvasView already destructures the context — add these two), `describeLocation`/`groupSessionsByUser` NOT needed here (page-scoped list is simpler — see below).
- Produces (behavior contract):
  - **CanvasView sidebar:** replace the `collapseSessions(globalUsers.filter(...))` list with a per-SESSION list of others on this page or elsewhere: `const otherSessions = sessions.filter(s => s.sessionId !== mySessionId)`. Render each session: avatar dot (color), `name` + `device` small text, location note when not on this page (`s.location?.pageId === pageId ? null : 'elsewhere'` — keep it simple: show `s.location?.label || 'another page'` when their pageId differs), Follow checkbox per session (`followedUserId === s.sessionId`). The cursor-color picker stays exactly as-is (it reads the current user via `globalUsers.find(u => u.id === socket?.id)` — keep untouched, it works). Section hidden when `otherSessions.length === 0` (same as today).
  - **PdfCanvas cursors:** drop the one-per-userId reduce. New filter: `remoteUsers.filter(u => u.id !== currentUserId && u.cursor && u.userId)` rendered directly — two sessions of the same user on the same page now (correctly) show two cursors. No other changes; props stay as-is.
  - Both `collapseSessions` implementations and their local interfaces are deleted. `grep -rn "collapseSessions" src/` must return zero hits after this task.

- [ ] **Step 1: Make the CanvasView sidebar change** (read the current block first; keep the surrounding section header/layout markup, swap the list source and row internals).
- [ ] **Step 2: Make the PdfCanvas filter change.**
- [ ] **Step 3: Verify** — `grep -rn "collapseSessions" src/` → nothing; `npm run lint` clean; `npx vitest run --project ui` green.
- [ ] **Step 4: Playwright proof (standing rule — canvas changes get real Playwright verification):** run the canvas-touching specs: `npx playwright test collab-presence collab-canvas-conflict canvas-drawing` (use the actual canvas spec filenames present in `e2e/` — list them first) and then the full `npm run test:e2e`. All green.
- [ ] **Step 5: Commit**

```bash
git add src/pages/CanvasView.tsx src/components/PdfCanvas.tsx
git commit -m "feat(presence): canvas sidebar lists sessions with devices; per-session cursors; collapseSessions deleted

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Page-view guard rebuilt on sessions; `/api/pages/active` deleted

**Files:**
- Modify: `server.ts` (~L394-404: delete the `/api/pages/active` route)
- Modify: `src/utils/store.ts` (delete `getActivePages`, ~L321-333)
- Modify: `src/pages/ProjectView.tsx` (delete `activePages` state ~L290 + poll effect ~L344-360; rewrite guard at ~L641)
- Modify: `src/pages/ProjectsPage.tsx` (rewrite delete-guard ~L338-348)
- Create: `src/components/PageViewerDots.tsx`
- Modify: the page-list row component (locate via `grep -rn "ProjectPagesTab" src/` — the extracted pages tab from Phase 5g) to render `<PageViewerDots pageId={page.id} />` beside each page name
- Test: `src/components/PageViewerDots.test.tsx` (new); adjust any tests referencing the deleted pieces (grep `getActivePages` and `pages/active` across `src/` and `server/`)

**Interfaces:**
- Consumes: `sessions`, `mySessionId` from `useCollaboration()`.
- Produces:
  - `PageViewerDots`: `React.FC<{ pageId: string }>` — renders up to 3 small overlapping avatar circles (first letter, session color, `title={name + ' · ' + device}`) for sessions (not mine) whose `location?.pageId === pageId`; null when none.
  - ProjectView rename guard (in `handleStartRenamePage`): `const viewers = sessions.filter(s => s.sessionId !== mySessionId && s.location?.pageId === page.id); if (viewers.length) { toast(\`"${page.name}" is being viewed by ${viewers[0].name} — try again when they leave\`, { type: 'warning' }); return; }` — replaces the dead `activePages.includes(page.id)` check. (Read the existing guard's toast wording first and keep its style.)
  - ProjectsPage delete guard: replace the `getActivePages()` fetch with `sessions.some(s => s.sessionId !== mySessionId && s.location?.projectId === p.id)`; preserve the existing block-vs-warn behavior shape of that handler (read it: if it blocked with a toast, keep blocking; ProjectsPage must be inside CollaborationProvider — it is, all routes are).
  - The 5-second `setInterval` polling in ProjectView is GONE — grep the file for `pages/active`/`activePages` afterward: zero hits.

- [ ] **Step 1: Write the failing PageViewerDots test** (mocked context; sessions with matching/non-matching pageId; assert initials render, own session excluded, null when none). Write it out fully.
- [ ] **Step 2: Run to verify it fails; implement the component.**
- [ ] **Step 3: Make the deletions + guard rewrites** per the contract (server route, store fn, ProjectView, ProjectsPage, pages-tab dots).
- [ ] **Step 4: Run** — `npm run test` (both projects; fix any test referencing deleted names), `npm run lint`.
- [ ] **Step 5: Commit**

```bash
git add server.ts src/utils/store.ts src/pages/ProjectView.tsx src/pages/ProjectsPage.tsx src/components/PageViewerDots.tsx src/components/PageViewerDots.test.tsx
# plus the pages-tab file located in Step 3
git commit -m "feat(presence): live page-view guard + viewer dots; /api/pages/active and 5s poll deleted

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Live Dashboard + ProjectOverview activity

**Files:**
- Modify: `src/pages/Dashboard.tsx` (~L60-65 mount effect), `src/pages/project/ProjectOverview.tsx` (~L31-35 effect)
- Test: `src/pages/Dashboard.test.tsx` (extend the existing file — it exists; read its scaffolding and add a live-refresh case following the ProjectIssues.test.tsx idiom)

**Interfaces:**
- Consumes: `useLiveQuery` (established idiom: extract the effect body into a named `load`, swap the effect for the hook, keep everything else).
- Filters (broad on purpose — activity is generated by these entity mutations; no new 'activity' event type is added):
  - Dashboard: `useLiveQuery(load, { types: ['project', 'task', 'issue', 'rfi', 'punch', 'invoice', 'changeOrder', 'payment', 'timeEntry', 'customer', 'file'] })`
  - ProjectOverview: same types + `projectId` in the filter.
- The existing 300ms debounce coalesces bursts; both screens' loads are cheap GETs (summary/activity/time/tasks).

- [ ] **Step 1: Write the failing Dashboard test** — foreign `{type:'task'}` event → the mocked `getActivity`/`getTasks` are called a second time (follow the mock structure already present in Dashboard.test.tsx; add the fake-socket mocked-context wiring from ProjectIssues.test.tsx if the file doesn't have it).
- [ ] **Step 2: Run to verify it fails; convert both screens.**
- [ ] **Step 3: Run** — ui suite + lint.
- [ ] **Step 4: Commit**

```bash
git add src/pages/Dashboard.tsx src/pages/Dashboard.test.tsx src/pages/project/ProjectOverview.tsx
git commit -m "feat(presence): dashboard + project overview live-refresh (activity feed streams)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Carried items — presence gating, spec deviation notes, e2e fixture promotion

**Files:**
- Modify: `src/hooks/useCollabEditing.ts` (+test addition), `src/pages/project/ProjectSettings.tsx`
- Modify: `docs/superpowers/specs/2026-08-23-realtime-collaboration-design.md` (§4 area)
- Create: `e2e/fixtures/collab.ts`; modify `e2e/collab-presence.spec.ts`, `e2e/collab-live-refresh.spec.ts`, `e2e/collab-canvas-conflict.spec.ts` (import the shared helper instead of local copies)

**Interfaces:**
- `useCollabEditing` gains an option: `enabled?: boolean` (default true). When false: no `set-editing` declare, no entity-changed subscription, `othersEditing` still computed (harmless), returned state otherwise inert. Hooks stay unconditional (the effect body early-returns). Test: `enabled: false` → no `set-editing` emit on mount/unmount.
- `ProjectSettings` passes `enabled: admin` — non-admins parked on /settings no longer show as "editing this" to admins (carried WS2 minor 8).
- Spec doc: add a short `### Accepted deviations & risks (WS1-WS2 as-built)` subsection at the end of §4 recording, one line each: global `io.emit` for entity-changed (non-admin sockets receive billing-entity metadata — ids only, no payloads); `bySessionId` is a client-chosen tab id, spoofable on the trusted LAN (echo-suppression only, no security use); sessionId = socket.id (reconnect-sensitive); Settings/Proposal share the `{type:'project'}` editing-presence namespace.
- `e2e/fixtures/collab.ts` exports the `openAuthedContext(browser, token)` helper currently duplicated inline in the collab specs (lift the implementation from `collab-presence.spec.ts:18-29`); all three existing collab specs import it from the fixture; behavior identical.

- [ ] **Step 1: useCollabEditing `enabled` option + failing test** (extend `src/hooks/useCollabEditing.test.tsx`: `enabled: false` → `fakeSocket.emit` never called with 'set-editing').
- [ ] **Step 2: ProjectSettings passes `enabled: admin`** (read how `admin` is derived in the file; the hook call is before the early returns — the flag makes that safe).
- [ ] **Step 3: Spec subsection + fixture promotion** (run the three modified e2e specs after: `npx playwright test collab-presence collab-live-refresh collab-canvas-conflict`).
- [ ] **Step 4: Run** — full `npm run test` + lint + the three e2e specs.
- [ ] **Step 5: Commit**

```bash
git add src/hooks/useCollabEditing.ts src/hooks/useCollabEditing.test.tsx src/pages/project/ProjectSettings.tsx docs/superpowers/specs/2026-08-23-realtime-collaboration-design.md e2e/fixtures/collab.ts e2e/collab-presence.spec.ts e2e/collab-live-refresh.spec.ts e2e/collab-canvas-conflict.spec.ts
git commit -m "chore(presence): carried items — presence gating for non-admin settings, spec deviation notes, shared e2e collab fixture

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Follow e2e, full verification, checklist, push

**Files:**
- Create: `e2e/collab-follow.spec.ts`
- Modify: `docs/superpowers/specs/2026-08-23-realtime-collaboration-checklist.md` (WS3 section)

- [ ] **Step 1: Full unit + lint green** (`npm run test`, `npm run lint`).

- [ ] **Step 2: Write the follow e2e** (two contexts via `e2e/fixtures/collab.ts`; single seeded admin account — sessions differ, which is exactly what session-scoped Follow needs):
  1. **Session list:** A opens the presence popover; asserts it shows a `You` group with the other session's device label visible (both contexts are Chromium — assert on the device string rendered, e.g. `/Chrome/` or the exact label; read what deviceLabel produces for headless Chromium first and assert that).
  2. **Follow navigation:** in A's popover, check the Follow checkbox for B's session. B navigates to a project's Billing tab (`page.goto` or in-app click). Assert A's URL becomes the same path (`expect(aPage).toHaveURL(/billing/, { timeout: 15_000 })`) and A shows the pill (`getByText(/Following/)`).
  3. **Stop:** A clicks Stop; B navigates again; assert A's URL does NOT change (fixed small wait is acceptable ONLY for this negative assertion — prefer `expect(aPage).not.toHaveURL(...)` after a bounded wait).
  4. **Stop on manual nav:** re-follow; A clicks a sidebar link itself; assert the pill disappears.

- [ ] **Step 3: Run `npm run test:e2e`** — full suite green including the new spec.

- [ ] **Step 4: Update the WS3 checklist section** — tick every item with its delivering commit hashes (per-task hashes from this plan's execution; use `git log --oneline` to collect them), add the plan path under the WS3 heading. Only verified-on-branch hashes. Do not touch other workstreams.

- [ ] **Step 5: Commit and push**

```bash
git add e2e/collab-follow.spec.ts docs/superpowers/specs/2026-08-23-realtime-collaboration-checklist.md
git commit -m "test(presence): two-context follow e2e; WS3 checklist complete

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push origin testing
```

---

## Self-Review Notes

- **Spec §5 coverage:** sessions list w/ device + location + own sessions (T1/T3), triplicated collapseSessions deleted (T3/T5 — grep-verified), app-wide session-scoped Follow with pill/stop semantics (T2/T4, e2e T9), page guard + viewer dots + poll deletion (T6), live dashboard + streaming activity (T7), Playwright follow proof + RTL grouping/labels (T1/T3/T9).
- **Ruled deviations (documented in Global Constraints):** no viewport/cursor-follow built (never existed; spec §5's "continues to work" clause refers to a behavior exploration disproved); `followedUserId` keeps its (misleading) name until WS4.
- **Carried items resolved:** WS2 minor 8 (non-admin settings presence — T8), spec deviation notes for bySessionId spoofability + metadata surface (T8), label staleness gotcha (T2), broken-guard shape mismatch (T6, both consumers).
- **Known risks for reviewers:** overlay rebuild vs the collab-presence e2e selector contract (T3 keeps container/empty-state/name rendering stable and runs the spec in-task); PdfCanvas per-session cursors change rendering multiplicity (T5 runs canvas e2e); Dashboard.test.tsx exists and its scaffolding must be extended, not replaced.
- Line numbers are as of commit `7516f6f` — locate by symbol when drifted.
