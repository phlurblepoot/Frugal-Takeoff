# Task Relations — Design

**Date:** 2026-07-05
**Status:** Approved (design), pending implementation plan
**Migration:** 18 (additive, no data risk)

## Summary

Enhance the company-wide task list so a task can be **related to** a project and/or
customer — not as the doer of the work, but as the subject it concerns. Setting a
project auto-derives and locks that project's customer. Tasks become reachable and
pre-filtered from project and customer pages, and upcoming task deadlines surface on
the dashboard and project home page (mirroring the existing bid-due list). A global
filter lets any task list be narrowed by project or customer.

## Decisions (locked)

- **Link model:** one project + one customer per task. Setting a project auto-fills and
  **locks** its customer. A task may have: nothing, customer only, or project + its
  customer. No many-to-many.
- **Dashboard deadline scope:** defaults to the logged-in user's tasks, with a toggle to
  show all tasks.
- **Per-page task list:** a link/button on project and customer pages navigates to the
  **existing** Tasks page with the filter pre-applied (`?projectId=X` / `?customerId=Y`).
  No embedded/duplicated list UI.
- **First-pass add-on:** global project/customer filter dropdowns on the main task list.

## 1. Data model (migration 18, additive)

Add two nullable columns to `tasks`:

- `projectId TEXT` — optional link to a project
- `customerId TEXT` — optional link to a customer

Plus indexes `idx_tasks_projectId` and `idx_tasks_customerId` for filtering. No backfill;
existing tasks remain unlinked (both NULL).

**Derivation rule (enforced server-side in `taskStore`):** whenever a task is created or
saved with a non-empty `projectId`, the server looks up that project's `customerId` and
writes it — the client never sets `customerId` independently while a project is set.
Clearing the project clears the derived customer, **unless** the customer was set directly
with no project. Enforcing this in one place keeps the "project auto-assigns its customer"
invariant from drifting.

## 2. Server (`taskStore.ts` + routes)

- `createTask` / `saveTask` accept `projectId` and `customerId`. Validate each references a
  real row (mirroring `validateAssignee` for users): unknown ids are rejected with
  `ValidationError`. Apply the derivation rule after validation.
- `listTasks` gains an optional filter argument:
  `listTasks(db, { projectId?, customerId?, assigneeUserId? })`. Filters compose (AND).
  The route reads them from query params: `GET /api/tasks?projectId=…&customerId=…`.
- `getTask` and task list rows return `projectId`, `customerId`, and joined display names
  (`projectName`, `customerName`) via `LEFT JOIN`, so the UI shows relation chips without
  extra fetches.

## 3. Task editor + create form (`TasksPage`, `TaskEditor`)

- Two new controls: a **Project** select and a **Customer** select, each a searchable
  dropdown of existing projects/customers (plus a "— none —" option).
- Selecting a project auto-selects and **disables** the customer field, showing the derived
  customer. Choosing "— none —" for project re-enables the customer field so it can be set
  directly.
- The create form and the editor modal share the same two controls.

## 4. Global filtering (in-scope add-on)

On the main Tasks page, add **Project** and **Customer** filter dropdowns alongside the
existing status filter chips. Selecting one narrows the list. These same dropdowns are
driven by query params, powering the per-page entry point below.

## 5. Per-page entry (link to filtered global list)

- **Project view** and **Customer detail** each get a "Tasks" button/link that navigates to
  `/tasks?projectId=X` (or `?customerId=Y`).
- `TasksPage` reads these query params on load, applies them to the filter dropdowns, and —
  when a task is created from that pre-filtered view — **pre-fills** the new task's
  project/customer so it is linked on creation.
- A small banner ("Showing tasks for *Project X* — clear") makes the active scope obvious
  and offers a one-click way back to the unfiltered list.

## 6. Deadline widgets (mirror the bid-due list)

- **Dashboard:** an "Upcoming task deadlines" card beside the existing bid-due card. Defaults
  to **my tasks** (assignee = current user) that have a due date, sorted soonest-first, with
  overdue shown in red. A small **toggle** switches to all tasks. Reuses the visual pattern
  from the bid-due list (`Dashboard.tsx`).
- **Project home:** the same card, scoped to that project's tasks (no toggle needed).

## 7. Testing

- `taskStore.test.ts`: derivation rule (project sets customer; clearing project clears
  derived customer; customer-only preserved; invalid project/customer rejected), and each
  `listTasks` filter (project, customer, assignee, composed).
- `Dashboard.test.tsx`: my-tasks/all toggle, soonest-first sort, overdue styling.
- Route tests (`routes.test.ts`): new `?projectId` / `?customerId` query params on
  `GET /api/tasks`, and create/save accepting + validating the relation fields.

## Out of scope (future list)

Priority field; task-count badges on project/customer cards; due-soon/overdue email
reminders (needs a scheduled job); comments/activity thread; watchers/multiple assignees;
recurring tasks; kanban/calendar views; convert-Issue/Punch-to-task.
