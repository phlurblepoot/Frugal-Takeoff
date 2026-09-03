# Mail Phase 2 — Plan 2 of 2: Client UI + E2E

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** The visible Phase 2: link-from-thread modal with labeled chips, convert-thread menu, cross-user open with the reference card, reply chips everywhere, the project Mail tab, and the remaining polish — then e2e coverage and the push.

**Spec:** `docs/superpowers/specs/2026-09-03-mail-phase2-design.md` (authority). Plan 1's server routes are the contracts (read the LIVE routes, not this file). All Phase 1/Plan-1 global constraints hold. Trust boundary: link labels come from app data (safe), but subjects/participants in reference cards are email-derived — React text rendering only.

### Task 1: openThreadLink + ThreadReferenceCard (#5 foundation)
**Files:** `src/pages/mail/openThreadLink.ts` (+test), `src/pages/mail/ThreadReferenceCard.tsx` (+test), `src/utils/mailApi.ts` (`resolveThread`, `projectThreads`, `replyFlags`, links `label` typing)
`openThreadLink(link, navigate): Promise<'opened'|'card'>` — calls `mailApi.resolveThread` with the link's threadKey/subjectSnapshot/firstDate/participants; match → navigate `/mail/<accountId>/_/<threadKey>`; null → caller renders `ThreadReferenceCard` (modal: subject, participants, date, labeled item links, "linked by", muted "no copy of this conversation in your connected mailboxes"). REPLACE `SentThreadChip`/`useItemThreadLinks.myThread`'s exact-only probe with this helper (one resolution path everywhere; delete the per-account thread-probing code). Tests: opened path, card path, SentThreadChip now uses it.

### Task 2: Link picker + labeled chips (#2)
**Files:** `src/pages/mail/LinkPickerModal.tsx` (+test), ThreadView link strip edits (+test)
"+ Link" → modal: tabs/radio Customer | Project | Item; item = project select → type select (the linkable types) → item list (fetch per type via existing store fns — grep each list fn). Creates via `mailApi.createLink`; strip re-renders labeled chips (server labels from Plan 1); × on own links (`linkedByUserId === current user`; admin any — get role how the app does) → `deleteLink` + reload. Chips elsewhere (thread rows) show labels too (already server-side — verify only).

### Task 3: Convert a thread (#4)
**Files:** `src/pages/mail/CreateFromThreadMenu.tsx` (+test), ThreadView toolbar, touched create-flows
"Create ▾" → Task / RFI / Issue. Gather prefill: subject; latest INBOUND message's text (via mailApi.body → text, quote-stripped client-side is NOT available — use the body text as-is trimmed to ~2000 chars, or the thread snippet on failure). Task: create via the tasks store fn (title, description, projectId/customerId from the thread's project link when present) → `createLink(threadKey,'task',id)` → navigate to tasks with the editor open (follow `?new=1`-style conventions — read TaskEditor's flow). RFI/Issue: need projectId — from the thread's project link, else a small project-select step in the menu; create (title/question=subject, description=text) → link → navigate to the item editor. Tests per path incl. the no-project-link RFI case.

### Task 4: Reply chips (#6)
**Files:** `src/hooks/useReplyFlags.ts` (+test), list-row edits (Invoices/COs/Proposals/Issues/RFIs/DailyReports/Tasks sections — grep the list components), `DocumentActionsBar` chip
`useReplyFlags(itemType, ids)` batches `mailApi.replyFlags` (live on `mailThread` events, debounced). Amber "Reply" chip (reuse the RFI chip styling) on flagged rows + next to the Sent chip in the bar (title "The linked email thread has a new reply"). RFI keeps its richer pending-banner behavior — don't double-chip RFI rows (its existing chip wins; flag-chip only when no pendingReply). Tests: hook batching + rule; one list integration; bar chip.

### Task 5: Project Mail tab (Goal 5)
**Files:** `src/pages/project/ProjectMail.tsx` (+test), `src/App.tsx` route, `Sidebar.tsx` PROJECT_NAV entry
Rows from `mailApi.projectThreads(projectId)`: subject, labeled item chips, participants, last activity (formatMailDate), reply indicator; click → `openThreadLink`-equivalent (build the pseudo-link from the row). Empty state. Live on `mailThread`. Admin-gating: none (mail links are not billing data). Tests: rows render, open path called, empty state.

### Task 6: Polish + e2e + ship prep
**Files:** MailPage (reply-discard confirm on nav when the inline composer has typed content — window.confirm is fine), ThreadList windowing (render a slice around the scroll viewport, hand-rolled, threshold >150 rows, tests), README Bid-pipeline row rewrite, changelog v2.11.0 entry, e2e additions in the mail specs (link-from-thread → labeled chip; convert→RFI carries subject + auto-link; project Mail tab lists the thread; reply flag appears on a linked invoice after injectReply), `docs/mail-setup.md` §9 updated (Phase 2 shipped items removed from "what's next").
Verification: lint + full vitest + FULL e2e. Commit; the controller pushes after the whole-branch review.
