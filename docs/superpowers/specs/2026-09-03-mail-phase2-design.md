# Mail Phase 2 — Links, Conversion, Indicators, Project Mail

**Date:** 2026-09-03 · **Status:** design approved in chat (Nathan), spec transcribed
**Depends on:** Phase 1 (spec 2026-08-29), live on `testing` at 74c9d41+. No new migrations expected (all tables exist: `mail_thread_links`, `mail_thread_reply_state`).

## Goals
1. **Link from a thread (#2):** "+ Link" in the thread link strip → modal picking Customer / Project / Item (item drills project → type → item). Multiple links, cross-project. Unlink own links (admin: any). Chips and all link displays show **resolved labels** ("RFI-012", "INV-104", project/customer names).
2. **Convert a thread (#4):** thread toolbar "Create ▾" → Task / RFI / Issue. Prefill title/question = thread subject; description = latest inbound message's stripped text. RFI/Issue require a project — prefilled from the thread's project link, else picked in the form. On create: item created → thread linked to it → editor opens. Attachments are NOT auto-copied.
3. **Cross-user opening (#5):** opening any link: exact threadKey in one of the viewer's mailboxes → open; else subject+date-window (±3 days vs `firstDate`/`subjectSnapshot`) with ≥1 shared participant → open that thread; else a read-only **reference card** (subject, participants, date, linked items, who linked).
4. **Reply indicators (#6):** linked items (all types with a Sent chip) show a "Reply" chip on list rows + editors when `lastInboundDate > max(lastOutboundDate, link.createdAt)` — "they answered, you haven't." Display-only.
5. **Project Mail tab:** `/project/:id/mail` in PROJECT_NAV — one row per distinct threadKey linked to the project or its items: subject, item chips, participants, last activity, reply indicator; opens per #3.
6. **Polish batch:** (a) RULED: `setPendingReply`/`dismissPendingReply` bump `version` only, never `updatedAt` (reply arrival must not flip the PDF freshness chip); (b) confirm before discarding a typed inline reply on thread navigation; (c) thread-list virtualization; (d) IMAP account Edit pre-fills host/port/username (accounts GET returns non-secret auth fields for imap accounts); (e) `useThread` double-fetch on thread switch; (f) README "Bid pipeline" row refresh.

## Non-goals
Auto-linking by sender address; capture of replies onto non-RFI items (indicators only); attachment auto-copy on conversion; repairing attachments already stacked as versions before the save fix (bytes retained as version rows; manual cleanup if wanted).

## Server changes (no migration)
- `GET /api/mail/links?itemType&itemId` and thread/link payloads gain `label` per link (resolved: item number/title, project name, customer name; same tables as `resolveChain`; missing rows → generic label). Applies to `linksFor` in the threads list and thread detail too.
- `GET /api/mail/project-threads?projectId=` — distinct threadKeys from `mail_thread_links WHERE projectId=?`, each with subjectSnapshot/participants/firstDate, aggregated link labels, and the viewer-independent reply-state row. Owner-independent (links are app data); ordered by latest of (reply-state dates, link createdAt).
- `GET /api/mail/resolve-thread?threadKey=&subject=&firstDate=&participants=` — implements #5's matching for the CURRENT user's mailboxes; returns `{accountId, threadKey} | null`. (Exact match first; fallback uses normalized subject + ±3d + shared participant.)
- Reply indicators: item list/detail responses do NOT change; a new `GET /api/mail/reply-flags?itemType=&itemIds=` (batch, ≤100) returns the item ids whose newest link satisfies the indicator rule. Client hooks fetch per list.
- Conversion uses EXISTING create routes (tasks/rfis/issues) + `POST /api/mail/links`; no new mutation route.
- Polish (a): rfiStore capture/dismiss stop bumping `updatedAt`; (d): accounts GET includes `imapHost/imapPort/imapSecure/smtpHost/smtpPort/smtpSecure/username` for provider `imap` (never password), used by the Edit form.

## Client
- `LinkPickerModal` (customer/project/item drill-down; reuses project/customer/list fetchers); wired to "+ Link" in ThreadView's link strip; unlink ×.
- `CreateFromThreadMenu` in ThreadView toolbar → prefilled create forms (task via TaskEditor path; RFI/Issue via their `?new=1` flows extended to accept prefill + auto-link callback, or a light modal that posts then navigates — implementer's choice per existing patterns).
- `ThreadReferenceCard` component; `openThreadLink(link)` helper implementing #5 via `resolve-thread` (used by SentThreadChip too, replacing its exact-only logic; the ±3d fallback goes live everywhere).
- Reply chips: `useReplyFlags(itemType, ids)` + chip on list rows (invoices, COs, proposals, issues, RFIs, daily reports, punch?, tasks) and in `DocumentActionsBar` next to the Sent chip.
- `ProjectMail.tsx` section + PROJECT_NAV entry (Mail icon), rows per Goal 5.
- Polish (b) confirm dialog, (c) virtualization (react-window NOT added — hand-rolled windowing or overscan slice per repo minimalism; implementer judgment), (e) fix the duplicate fetch.

## Testing
Unit/route tests per change (labels, project-threads, resolve-thread incl. fallback+negative, reply-flags rule); UI tests per component; e2e additions: link-from-thread → chip label; convert→RFI carries subject + auto-link; project Mail tab lists the linked thread; reply indicator appears after an injected inbound reply on a linked invoice.

## Delivery
Plan 1 (server + polish a/d/e) → Plan 2 (client UI + e2e + polish b/c/f). Same subagent loop; push to `testing` when Plan 2 lands.
