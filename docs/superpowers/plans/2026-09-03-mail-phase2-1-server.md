# Mail Phase 2 — Plan 1 of 2: Server + Polish

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Land every server-side capability Phase 2's UI needs — link labels, project-thread listing, cross-user thread resolution, reply flags, IMAP edit prefill — plus the ruled freshness fix and the `useThread` double-fetch fix. No migrations.

**Spec:** `docs/superpowers/specs/2026-09-03-mail-phase2-design.md` (authority). Phase 1 spec for background. All Phase 1 global constraints hold (uuid not crypto.randomUUID; deps-injected routes; ownership scoping; tests per change; `npm run lint` + full vitest green per task; commit per task, no push).

## Global Constraints
- No new migrations; no changes to sync/send paths beyond what a task names.
- Labels/read routes never leak secrets; accounts GET must NEVER include `password` (test it).
- Every route addition lives in `server/mail/routes.ts` via the existing deps pattern; link-label resolution in `server/mail/links.ts` beside `resolveChain`.

### Task 1: Link labels
**Files:** `server/mail/links.ts` (+test), `server/mail/routes.ts` (+test)
`resolveLinkLabel(db, itemType, itemId): string` — proposal→`Proposal #N`, invoice→number, changeOrder→`CO-N`+title, payApp→`Pay App #N`, issue→`ISS-00N`+title, rfi→`RFI-00N`+title, dailyReport→`Daily Report <date>`, punch/project→project name, task→title, customer→name; missing row → capitalized type name. Read each store/table for the real columns first. Wire into: `GET /api/mail/links` rows, `linksFor` (threads list chips), thread detail links. Tests: one per type incl. missing-row fallback; snapshot the threads-list chip payload gains `label`.

### Task 2: Project threads + resolve-thread
**Files:** `server/mail/routes.ts` (+tests)
- `GET /api/mail/project-threads?projectId=` (authenticateToken): distinct threadKey rows from `mail_thread_links WHERE projectId=?` joined with `mail_thread_reply_state`; each `{threadKey, subjectSnapshot, participantsJson, firstDate, links:[{itemType,itemId,label}], lastInboundDate, lastOutboundDate, lastActivity}` ordered by lastActivity desc. Viewer-independent (links are app data). 404 unknown project? — no: empty list is fine; validate projectId present.
- `GET /api/mail/resolve-thread?threadKey=&subject=&firstDate=&participants=` (authenticateToken): exact `threadKey` in any of the CALLER's accounts → `{accountId, threadKey}`; else fallback per spec #5 (normalizeSubject match + `date` within ±3 days of firstDate + ≥1 shared participant addr, over the caller's accounts) → that thread; else `null`-bodied `{match:null}`. Tests: exact; fallback positive; fallback rejects wrong subject / out-of-window / no shared participant; other-user's mailbox never matched.

### Task 3: Reply flags
**Files:** `server/mail/routes.ts` (+test)
`GET /api/mail/reply-flags?itemType=&itemIds=a,b,c` (≤100 ids, validate itemType via isItemType): for each item's NEWEST link (by createdAt), flag when `lastInboundDate > max(lastOutboundDate ?? '', link.createdAt)`. Return `{flagged: string[]}`. Tests: rule true/false branches, cap, bad type 400.

### Task 4: Polish — freshness ruling + IMAP prefill + useThread double-fetch
**Files:** `server/rfiStore.ts` (+test), `server/mail/routes.ts` accounts GET (+test), `src/pages/mail/useThread.ts` (+test)
(a) `setPendingReply`/`dismissPendingReply` bump `version` only — `updatedAt` unchanged (acceptPendingReply keeps bumping via setRfiResponse). Update tests asserting the old behavior; add one proving updatedAt stable on capture.
(b) accounts GET rows for `provider==='imap'` gain `imapAuth: {imapHost,imapPort,imapSecure,smtpHost,smtpPort,smtpSecure,username}` from `readAuth` — NEVER password (explicit test asserting absence). Client `ImapAccountForm` prefills from it when editing (small edit + test — this half may ride in Plan 2 if cleaner; implementer's choice, note it).
(c) `useThread`: eliminate the duplicate fetch on thread switch (the `[filterKey]` + `[load]` effects both firing) — single load per key change, live reload preserved; test counts fetches across a switch.

Each task: TDD, self-review, commit, report — same loop as Phase 1.
