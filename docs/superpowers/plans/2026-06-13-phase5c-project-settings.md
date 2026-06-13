# Phase 5c — Project Settings Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add an admin-only **Project Settings** section (`/project/:id/settings`, spec §4.2) that consolidates project metadata editing (name, contractor, address, due date), the lifecycle stage control, and a danger zone (archive + delete). Remove the scattered inline metadata-edit affordances from the ProjectView header (they move to Settings), keeping the monolith leaner.

**Architecture:** Mirror the existing admin section pattern (`ProjectBilling`): a section page gated by an `isAdmin()` check + access-denied panel for non-admins, with the sidebar entry `adminOnly`. The section loads the full project (`getProject`) and persists via the existing `saveProject` granular-update pattern (optimistic + rollback, as the ProjectView handlers already do). ProjectView's header becomes read-only display for those fields (keeping `ProjectStageControl` inline since stage is a frequent workflow action), with an admin-only "Settings" link.

**SAFETY INVARIANT:** tsc/test/build green after every task. Reuse `saveProject` and `deleteProject`; do not invent new endpoints.

**Tech Stack:** React 19 + react-router 7, the ui component library, `src/utils/store.ts`, `AddressAutocomplete`, `ProjectStageControl`. No server changes expected (project metadata already persists via `PUT /api/projects/:id`).

**Pattern references:**
- Admin gating + access-denied + load-full-project: `src/pages/project/ProjectBilling.tsx` (`isAdmin()` from localStorage role, the access-denied panel) and how it's nav-gated (`adminOnly: true` in Sidebar PROJECT_NAV + `requireAdmin`-style UI).
- The granular save handlers to port: ProjectView's `handleSaveProjectName` (~1820), `handleSaveContractor` (~1679), `handleSaveAddress` (~1668), `handleSaveDueDate` (~1657) — each does optimistic update + `saveProject` + rollback on error. Read them for the exact pattern (incl. version handling).
- Delete: `deleteProject(id)` (store) — used in `ProjectsPage`/`Dashboard`; navigate away after.
- Archive: how a project's archived/status is set — `ProjectStageControl` (sets status incl. archived) and/or an `archived` flag; read `src/components/ProjectStageControl.tsx` + the Project type.
- Section shell: `ProjectProposal.tsx` (just shipped) for full-project load + Skeleton + tokens.

**Project fields in scope:** `name`, `contractor`, `address`, `bidDueDate`, `status`/stage (via ProjectStageControl), `archived`. Contract value (`contractValueCents` is a billing rollup) is managed in Billing — only include a base `contractValue` editor IF the Project type has an editable base field and `saveProject` accepts it; otherwise DEFER and note it.

---

## File Structure

**Create:**
- `src/pages/project/ProjectSettings.tsx` — the admin settings section

**Modify:**
- `src/App.tsx` — add `/settings` route
- `src/components/shell/Sidebar.tsx` — add Project Settings nav entry (LAST, adminOnly)
- `src/pages/ProjectView.tsx` — remove inline metadata-edit affordances (name/contractor/address/dueDate edit state + handlers + edit buttons); keep read-only display + `ProjectStageControl`; add admin "Settings" link

---

## Task 1: ProjectSettings admin section + route + nav

**Files:** Create `src/pages/project/ProjectSettings.tsx`; modify `src/App.tsx`, `src/components/shell/Sidebar.tsx`.

- [ ] **Step 1: Read** `src/pages/project/ProjectBilling.tsx` (admin gate + access-denied panel), `src/pages/project/ProjectProposal.tsx` (full-project load pattern), ProjectView's `handleSaveProjectName`/`handleSaveContractor`/`handleSaveAddress`/`handleSaveDueDate` (the optimistic-save+rollback+version pattern), `src/components/ProjectStageControl.tsx` (props: projectId/version/status + how it persists), and the `Project` type in `src/types.ts` (confirm `archived`, `status`, `bidDueDate`, `contractor`, `address`, and whether an editable base `contractValue` exists).

- [ ] **Step 2: Build `ProjectSettings.tsx`:**
  - `const admin = isAdmin();` (mirror ProjectBilling's `isAdmin` exactly — same localStorage role read). If `!admin`, render the SAME access-denied panel ProjectBilling shows (copy its markup/message). Do NOT load/persist anything for non-admins.
  - `useParams` projectId; load full project via `getProject(projectId)` into state; `reload()`; Skeleton while loading; not-found guard.
  - **Metadata editors** (each a Field with Input/controls, saved via the ported optimistic pattern):
    - Name — text input → `saveProject({ ...project, name })` (optimistic + rollback). Port `handleSaveProjectName`'s logic (incl. how it manages `version`).
    - Contractor — text input → save `contractor`.
    - Address — `AddressAutocomplete` (same component ProjectView uses) → save `address`.
    - Due date — `<input type="date">` (convert bidDueDate ms ↔ date string the way ProjectView does) → save `bidDueDate`.
    - Stage — render `<ProjectStageControl projectId={...} version={...} status={...} onChange={reload}/>` (match its real prop names).
    - (Contract value — include ONLY if the Project type has an editable base field accepted by saveProject; else add a `// DEFERRED: contract value managed in Billing` note.)
  - **Danger Zone** (a visually distinct card):
    - Archive: a button toggling archived state. Use whatever mechanism exists (`ProjectStageControl` archived status OR an `archived` flag via saveProject). On success reload + toast.
    - Delete project: a button → `useConfirm` ("Delete this project and all its data? This cannot be undone.") → `deleteProject(project.id)` → `navigate('/projects')` + toast. (Match how ProjectsPage deletes.)
  - Use ui components (Card, CardBody, Field, Input, Button) + `useToast`/`useConfirm`. Save buttons disabled while in flight; surface 409/errors as toasts.

- [ ] **Step 3: Route** — `src/App.tsx`: add `{ path: 'settings', element: <ProjectSettings /> }` under `project/:projectId` (place LAST among the section routes). Import `ProjectSettings` (match sibling style).

- [ ] **Step 4: Nav** — `src/components/shell/Sidebar.tsx` PROJECT_NAV: add a Project Settings entry as the LAST item, `adminOnly: true`, icon `Settings` (or `SlidersHorizontal`) from lucide-react. Match sibling shape + `match` predicate (`endsWith('/settings')`). The existing `!item.adminOnly || isAdmin` filter hides it from non-admins.

- [ ] **Step 5: Verify** — `npx tsc --noEmit` clean; `npm run lint`; `npm test` green; `npm run build`. (The section coexists with ProjectView's inline edits until Task 2.)

- [ ] **Step 6: Commit**

```bash
git add src/pages/project/ProjectSettings.tsx src/App.tsx src/components/shell/Sidebar.tsx
git commit -m "feat: admin Project Settings section (metadata, stage, danger zone) + route + nav"
```

---

## Task 2: Remove inline metadata edits from ProjectView header

**Files:** `src/pages/ProjectView.tsx`.

- [ ] **Step 1: Remove** the inline EDIT affordances for name, contractor, address, due date:
  - The `isEditingProjectName`/`isEditingContractor`/`isEditingAddress`/`isEditingDueDate` state + their `edit*` value state.
  - The handlers `handleSaveProjectName`, `handleSaveContractor`, `handleSaveAddress`, `handleSaveDueDate`.
  - The inline edit UI (the pencil/edit buttons, the input+save/cancel toggles, the `AddressAutocomplete` in edit mode).
  - Replace each with a READ-ONLY display of the value (project.name as the heading; contractor/address/due-date shown as plain text/labels — keep whatever non-editable display existed, or a simple label row). If `AddressAutocomplete` is now unused in ProjectView, remove its import.
  - **KEEP** `ProjectStageControl` in the header (stage is a frequent workflow action, not a setting).
  - Add a small admin-only **"Settings"** affordance in the header (e.g. a gear button/link) → `navigate(\`/project/${projectId}/settings\`)`, so editing is discoverable. Gate it on the same admin check the app uses (`JSON.parse(localStorage.getItem('user')||'{}').role === 'admin'`).

- [ ] **Step 2: Verify** — `npx tsc --noEmit` clean (surfaces every dead ref); `npm run lint`; `npm test` green; `npm run build`. Grep `grep -n "isEditingProjectName\|handleSaveContractor\|handleSaveAddress\|handleSaveDueDate\|handleSaveProjectName" src/pages/ProjectView.tsx` → expect nothing.

- [ ] **Step 3: Commit**

```bash
git add src/pages/ProjectView.tsx
git commit -m "refactor: move project metadata editing to Settings section (header read-only)"
```

---

## Task 3: Full verification + push

- [ ] **Step 1: Full gate** — `npm run lint && npm test && npm run build` green.

- [ ] **Step 2: Live smoke** (boot temp dir, login admin/admin + a non-admin 'user'): confirm `/api/projects/:id` PUT still updates name/contractor/address/bidDueDate (the section just reuses saveProject — the API is unchanged). Verify a non-admin loading the settings route sees the access-denied panel (the section gates client-side) and that the nav entry is hidden for non-admins. Confirm delete removes the project.

- [ ] **Step 3: Final review** — dispatch a code-review subagent (sonnet) over the 5c range. Focus: (1) admin gating — section shows access-denied for non-admins, nav entry adminOnly, and IMPORTANTLY no metadata write path is admin-only-bypassable in a way that breaks non-admin expectations (note: project metadata edits were previously available to all roles in the header — confirm whether moving them behind admin is intended; if non-admins legitimately edited project name before, FLAG it); (2) the ported save handlers preserve the optimistic+rollback+version behavior; (3) delete navigates away + confirms; (4) ProjectView header has no dangling refs and stage control still works; (5) AddressAutocomplete reused, not forked. Fix Critical/Important.
  - **NOTE for the reviewer/me:** the old inline edits were NOT admin-gated (any user could rename a project from the header). Moving them into an admin-only section is a deliberate access-control tightening per spec §4.2 ("Project Settings (admin)"). This is intended — but confirm it doesn't break a workflow where field users renamed projects. If it's a concern, the section can stay admin-gated while a minimal rename stays available; default to the spec (admin-only) and note it for Nathan.

- [ ] **Step 4: Push**

```bash
git push origin testing
```

- [ ] **Step 5: Memory** — record 5c shipped: admin Project Settings section (metadata/stage/danger-zone); inline header edits removed (now read-only + Settings link); access-control note (project metadata editing is now admin-only — a deliberate tightening, flag to Nathan). Next: 5d ⌘K actions.

---

## Self-Review Notes (author)

- **Access-control change:** the most important nuance — moving metadata edits into an admin-only section TIGHTENS access (previously any user could edit from the header). This matches spec §4.2 but is a behavior change worth flagging to Nathan; ProjectStageControl stays in the header so stage workflow isn't gated.
- **No server change:** project metadata already persists via `PUT /api/projects/:id`; the section reuses `saveProject`. Danger-zone delete reuses `deleteProject`.
- **Reuse, don't fork:** `AddressAutocomplete`, `ProjectStageControl`, the optimistic-save pattern, and the access-denied panel all come from existing code.
- **Deferred:** base contract-value editing if there's no clean project field (it's a billing rollup); any project-level template/tax/markup defaults (not currently in the data model).
