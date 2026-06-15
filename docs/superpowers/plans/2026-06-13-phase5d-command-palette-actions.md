# Phase 5d — ⌘K Contextual Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the ⌘K command palette context-aware (spec §4.3: "navigation + actions ('clock in', 'new issue')"). When the user is inside a project, surface project-section navigation + create actions ("New issue", "New punch item", "New task", "Open proposal", "Project settings"), and wire a `?new=1` convention so a "New X" command lands on the section AND focuses its create form.

**Architecture:** `CommandPalette.tsx` already detects the canvas route via `matchPath`. Add a `matchPath('/project/:projectId/*', pathname)` to extract the current `projectId`, and build a second `useMemo` of CONTEXTUAL actions (project nav + create intents) that is prepended to `staticActions` when a project is active. Create actions navigate with `?new=1`; `ProjectIssues`, `ProjectPunch`, and `TasksPage` read that param on mount and focus their create input. Admin-only actions (Project Settings, Billing) gate on the localStorage role.

**SAFETY INVARIANT:** tsc/test/build green after each task. Purely additive — no existing command/shortcut behavior changes.

**Tech Stack:** React 19, react-router 7 (`useLocation`, `matchPath`, `useSearchParams`), the existing CommandPalette + section pages.

**Pattern references:**
- `src/components/CommandPalette.tsx` — `staticActions` useMemo (the Action shape `{id,type:'action',title,subtitle?,icon,run}`), `onCanvas` matchPath usage, `navigate` calls.
- The role check used elsewhere: `JSON.parse(localStorage.getItem('user')||'{}').role === 'admin'` (ProjectBilling/ProjectSettings).
- Section create forms: `ProjectIssues.tsx`, `ProjectPunch.tsx`, `TasksPage.tsx` — locate the create-form title/description input(s) to focus.
- Project nav targets (the routes that exist): `''`(overview), `/takeoff`, `/proposal`, `/documents`, `/punch`, `/issues`, `/time`, `/billing`(admin), `/notes`, `/settings`(admin).

---

## Task 1: Contextual project actions in the command palette

**Files:** `src/components/CommandPalette.tsx`.

- [ ] **Step 1:** Add current-project detection near the existing `onCanvas`:
  ```ts
  const projMatch = matchPath('/project/:projectId/*', location.pathname) || matchPath('/project/:projectId', location.pathname);
  const projectId = projMatch?.params?.projectId as string | undefined;
  const isAdmin = (() => { try { return JSON.parse(localStorage.getItem('user') || '{}').role === 'admin'; } catch { return false; } })();
  ```

- [ ] **Step 2:** Build a `contextualActions` useMemo (Action[]), empty when `!projectId`, else:
  - **Create actions** (with `?new=1`):
    - `New issue` → `navigate(\`/project/${projectId}/issues?new=1\`)` (icon: AlertCircle or similar)
    - `New punch item` → `/project/${projectId}/punch?new=1` (icon: ClipboardCheck)
    - `New task` → `/tasks?new=1` (icon: ListTodo) — Tasks is company-level
  - **Open actions:**
    - `Open proposal` → `/project/${projectId}/proposal` (icon: FileText)
  - **Project navigation:**
    - `Project overview` → `/project/${projectId}`
    - `Takeoff & estimate` → `/project/${projectId}/takeoff`
    - `Documents` → `/project/${projectId}/documents`
    - `Punch & checklists` → `/project/${projectId}/punch`
    - `Issues` → `/project/${projectId}/issues`
    - `Time` → `/project/${projectId}/time`
    - `Notes` → `/project/${projectId}/notes`
  - **Admin-only** (only push when `isAdmin`):
    - `Billing` → `/project/${projectId}/billing`
    - `Project settings` → `/project/${projectId}/settings`
  - Give each a unique `id` (e.g. `'ctx:new-issue'`), an icon (reuse already-imported lucide icons where possible; add new imports as needed — AlertCircle, ClipboardCheck, StickyNote, DollarSign, SlidersHorizontal, LayoutGrid). Wrap each `run` with `navigate(...)` (close() already runs before `run` in `runItem`).
  - Memoize on `[projectId, isAdmin, navigate]`.

- [ ] **Step 3:** Prepend contextual actions to the action list. Update the existing `filteredActions`/`staticActions` composition so the items list becomes `[...contextualActions, ...staticActions]` then filtered by query the same way. Concretely: introduce `const allActions = useMemo(() => [...contextualActions, ...staticActions], [contextualActions, staticActions]);` and have `filteredActions` filter `allActions` instead of `staticActions`. Keep the existing no-query behavior (show all actions). The search-results merge (`items`) is unchanged.

- [ ] **Step 4:** (Optional polish) add a `subtitle: 'Project'` (or the project section group) to contextual actions so they're visually distinguishable; not required.

- [ ] **Step 5: Verify** — `npx tsc --noEmit` clean; `npm run lint`; `npm test` green; `npm run build`. If there's an existing `CommandPalette.test.tsx`, run it; if it asserts the action list, update expectations. (No new test required, but if the test infra easily supports it, add a test that on a `/project/p1/...` route the palette includes "New issue" and "Project settings" only when admin.)

- [ ] **Step 6: Commit**

```bash
git add src/components/CommandPalette.tsx
git commit -m "feat: contextual project actions in command palette (new issue/punch/task, nav)"
```

---

## Task 2: `?new=1` create-focus in Issues / Punch / Tasks

**Files:** `src/pages/project/ProjectIssues.tsx`, `src/pages/project/ProjectPunch.tsx`, `src/pages/TasksPage.tsx`.

Make the "New X" commands feel like create actions: when the section loads with `?new=1`, focus (and scroll to) the create form's primary input.

- [ ] **Step 1:** In each of the three pages:
  - Import `useSearchParams` from react-router-dom (if not present).
  - Add a `ref` to the create form's primary input (Issues: the title input; Punch: the description input; Tasks: the title input — locate the existing create-form input and attach a `ref`).
  - On mount, if `searchParams.get('new') === '1'`, `inputRef.current?.focus()` (and optionally `scrollIntoView({block:'center'})`). Use a `useEffect` keyed on the param. After focusing, it's fine to leave the param (or clear it via `setSearchParams({}, {replace:true})` to avoid re-focus on re-render — prefer clearing it so back-nav is clean).
  - Do NOT change any other behavior of these pages.

- [ ] **Step 2: Verify** — `npx tsc --noEmit` clean; `npm run lint`; `npm test` green; `npm run build`.

- [ ] **Step 3: Commit**

```bash
git add src/pages/project/ProjectIssues.tsx src/pages/project/ProjectPunch.tsx src/pages/TasksPage.tsx
git commit -m "feat: focus create form when opened via ?new=1 (command palette new actions)"
```

---

## Task 3: Full verification + push

- [ ] **Step 1: Full gate** — `npm run lint && npm test && npm run build` green.

- [ ] **Step 2: Smoke (note for Nathan — UI/browser)**: ⌘K on a project route shows "New issue", "New punch item", "New task", "Open proposal", project nav, and (admin only) "Billing"/"Project settings"; selecting "New issue" lands on Issues with the create field focused; ⌘K off a project route shows only the global actions (no contextual ones); admin-only actions hidden for non-admins.

- [ ] **Step 3: Final review** — dispatch a code-review subagent (sonnet) over the 5d range. Focus: (1) contextual actions only appear when a projectId is matched; admin-only actions gated on role; (2) prepend doesn't break the existing query-filter or search-results merge or keyboard nav (`items`/`selected` still consistent); (3) `?new=1` focus is additive and doesn't disrupt the sections' normal load; param cleared to avoid re-focus loops; (4) no duplicate action ids; icons imported. Fix Critical/Important.

- [ ] **Step 4: Push**

```bash
git push origin testing
```

- [ ] **Step 5: Memory** — record 5d shipped: command palette is now project-context-aware (create + nav actions, admin-gated), `?new=1` focuses create forms. Next: 5e (the big one — full ProjectView/CanvasView monolith decomposition).

---

## Self-Review Notes (author)

- **Purely additive:** contextual actions are prepended only when inside a project; all existing commands, shortcuts, search, and keyboard nav are untouched. The `?new=1` wiring is a no-op when the param is absent.
- **Admin gating:** Billing + Project Settings actions are hidden for non-admins (matching the nav), so the palette doesn't advertise admin destinations to members.
- **Consistency:** create intents route to the real section + `?new=1`; the section owns the actual create form (no duplicate create UI in the palette).
- **Deferred:** richer actions (e.g. "clock in to THIS project", "generate proposal now") — keep v1 to navigation + new-form focus.
