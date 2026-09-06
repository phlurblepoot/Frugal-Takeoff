# Mail Client — Plan 4 of 4: RFI Reply Capture, E2E Suite, Rollout

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the first inbound-reply consumer (RFI pending response: capture → review → accept/dismiss), the Playwright suite that proves the whole mail feature end to end against the fake provider, and the rollout/runbook pieces (E2E injection route, backup notes, memory).

**Architecture:** `server/mail/inboundHooks.ts` registers with the Plan 1 engine's `registerInboundHook`; the RFI hook writes `rfis.pendingReplyJson`. Two RFI routes accept/dismiss. Client: banner in `RfiEditor`, chip in the RFI list. E2E uses `MAIL_FAKE_PROVIDER=1` plus a test-only route `POST /api/mail/_test/inject` (registered only under that flag) to seed threads and inject replies.

**Tech Stack:** as Plans 1–3; Playwright 1.60 (`npm run test:e2e`, serial, chromium, prod build, `STORAGE_PATH=.e2e-data`).

**Spec:** `docs/superpowers/specs/2026-08-29-mail-client-design.md` §3 (`rfis` columns), §4.7, §9 (E2E + manual rows), §11.

## Global Constraints

- Plans 1–3 contracts fixed. The hook signature is `(ctx: MailContext, ev: { threadKey; messageId; account }) => void` (Plan 1 Task 7).
- RFI status is **never** changed by the hook; only the accept route flips it via `setRfiResponse`.
- `POST /api/mail/_test/*` routes exist **only** when `process.env.MAIL_FAKE_PROVIDER === '1'`; they must not be registered otherwise (test asserts 404).
- E2E runs must stay serial and use the existing fixtures (`e2e/fixtures/test.ts`, `seed.ts`).

## File map

| File | Responsibility |
|---|---|
| `server/mail/inboundHooks.ts` (+test) | hook registry bootstrap + RFI pending-reply hook |
| `server/rfiStore.ts` | `setPendingReply`, `acceptPendingReply`, `dismissPendingReply`; `getRfi` returns the new columns parsed |
| `server/routes.ts` | `POST /api/rfis/:id/pending-reply/accept`, `…/dismiss` |
| `server/mail/routes.ts` | `_test/inject`, `_test/seed` under the flag |
| `src/utils/store.ts` | `Rfi` type + `acceptRfiPendingReply`, `dismissRfiPendingReply` |
| `src/pages/project/rfi/PendingReplyBanner.tsx` (+test) | banner |
| `src/pages/project/rfi/RfiEditor.tsx`, `src/pages/project/ProjectRfis.tsx` | mount banner; list chip |
| `e2e/fixtures/mail.ts` | seed helpers (`connectFakeAccount`, `injectInbound`) |
| `e2e/mail.spec.ts`, `e2e/mail-rfi-reply.spec.ts`, `e2e/mail-item-send.spec.ts` | scenarios |
| `docs/mail-setup.md`, `docs/MIGRATION-CUTOVER.md` | rollout notes |

---

### Task 1: RFI store — pending reply fields

**Files:**
- Modify: `server/rfiStore.ts` (`getRfi`/`listRfis` include `pendingReply` parsed from `pendingReplyJson`, plus `responseSource`, `responseMessageIdHeader`), `server/rfiStore.test.ts`

**Interfaces (produces):**
```ts
export interface RfiPendingReply { threadKey: string; accountId: string; mailMessageId: string; messageIdHeader: string | null; from: { addr: string; name?: string }; date: string; text: string; attachments: Array<{ attId: string; name: string; mime: string; size: number }>; receivedAt: string }
export function setPendingReply(db, rfiId, reply: RfiPendingReply): void            // only when status === 'sent'; else no-op returning false
export function acceptPendingReply(db, rfiId, input: { text?: string; fileId?: string }): { status: string }   // setRfiResponse semantics + responseSource='email' + responseMessageIdHeader + clears pending
export function dismissPendingReply(db, rfiId): void
```

- [ ] **Step 1: Tests** (append to `server/rfiStore.test.ts`)

```ts
describe('pending reply', () => {
  const reply = { threadKey: 'k', accountId: 'a', mailMessageId: 'm', messageIdHeader: 'x@y', from: { addr: 'gc@teg.com', name: 'Mike' }, date: '2026-08-29T10:00:00.000Z', text: 'Corridor 9ft', attachments: [], receivedAt: '2026-08-29T10:00:01.000Z' };
  it('only a sent RFI accepts a pending reply; status unchanged', () => {
    const { id } = createRfi(db, 'p1', { title: 't' });
    expect(setPendingReply(db, id, reply)).toBe(false); expect(getRfi(db, id).pendingReply).toBeNull();
    markRfiSent(db, id);
    expect(setPendingReply(db, id, reply)).toBe(true);
    const r = getRfi(db, id); expect(r.status).toBe('sent'); expect(r.pendingReply).toMatchObject({ text: 'Corridor 9ft', from: { addr: 'gc@teg.com' } }); expect(r.answeredAt).toBeNull();
  });
  it('a newer reply replaces the pending one', () => {
    const { id } = createRfi(db, 'p1', { title: 't' }); markRfiSent(db, id);
    setPendingReply(db, id, reply); setPendingReply(db, id, { ...reply, text: 'Updated', mailMessageId: 'm2' });
    expect(getRfi(db, id).pendingReply.text).toBe('Updated');
  });
  it('accept sets the response, answered, source fields, clears pending; dismiss only clears', () => {
    const { id } = createRfi(db, 'p1', { title: 't' }); markRfiSent(db, id); setPendingReply(db, id, reply);
    expect(acceptPendingReply(db, id, { text: 'Corridor 9ft (edited)' })).toEqual({ status: 'answered' });
    const r = getRfi(db, id); expect(r.responseText).toBe('Corridor 9ft (edited)'); expect(r.responseSource).toBe('email'); expect(r.responseMessageIdHeader).toBe('x@y'); expect(r.pendingReply).toBeNull(); expect(r.answeredAt).toBeTruthy();
    const { id: id2 } = createRfi(db, 'p1', { title: 't2' }); markRfiSent(db, id2); setPendingReply(db, id2, reply); dismissPendingReply(db, id2);
    expect(getRfi(db, id2)).toMatchObject({ status: 'sent', pendingReply: null });
  });
  it('accept without text/file uses the pending text', () => {
    const { id } = createRfi(db, 'p1', { title: 't' }); markRfiSent(db, id); setPendingReply(db, id, reply);
    acceptPendingReply(db, id, {}); expect(getRfi(db, id).responseText).toBe('Corridor 9ft');
  });
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** in `rfiStore.ts` (bump `version`/`updatedAt` on set/dismiss so live clients refetch; `getRfi` maps `pendingReplyJson` → `pendingReply` object or `null`). **Step 4: Run** → pass. **Step 5: Commit** `feat(rfi): pending email reply fields`.

---

### Task 2: Inbound hook + accept/dismiss routes

**Files:**
- Create: `server/mail/inboundHooks.ts` (+test)
- Modify: `server/routes.ts` (two routes near `POST /api/rfis/:id/response`, line ~688), `server/routes.test.ts`, `server.ts` (call `installInboundHooks()` before `mailScheduler.start()`)

**Interfaces:**
- `installInboundHooks(): void` — idempotent (guards with a module flag); registers `rfiPendingReplyHook`.
- `rfiPendingReplyHook(ctx, ev)`: for each `mail_thread_links` row with `itemType='rfi'` on `ev.threadKey` → RFI in status `sent` → load the message row (`mail_messages` by `ev.messageId`) → text: `provider.getBody` is a network call; avoid it in the hook — use the indexed `snippet`? Too short. Do the fetch but bounded: `ctx.scheduler?.getProvider(account.id).getBody(providerMessageId)` inside a `try` with a 20 s `Promise.race` timeout; on failure fall back to `snippet`. Since hooks are sync in the engine, make the hook kick off `void (async () => {...})()` and do the DB write when the body arrives. `text = stripQuotedReply(rawText ?? htmlToText(html))`. Then `setPendingReply(db, rfiId, {...})` and `ctx.broadcastChange({ type: 'rfi', id: rfiId, projectId, action: 'updated' })`.
- Routes (`authenticateToken`, RFI is non-admin): `POST /api/rfis/:id/pending-reply/accept { text?, fileId? }` → `acceptPendingReply` → `logActivity` `rfi_answered` (message "RFI RFI-00N answered via email") → broadcast → `{ success, status }`. `POST /api/rfis/:id/pending-reply/dismiss` → `dismissPendingReply` → broadcast → `{ success }`. 404 when the RFI is missing, 409 when no pending reply.

- [ ] **Step 1: Tests**
  - `inboundHooks.test.ts`: build ctx with the fake provider (message html `<p>Corridor 9'-0"</p><blockquote>On … wrote: …</blockquote>` — quote stripping is on the text; give the fake `text: 'Corridor 9ft\n\nOn Aug 26 Nathan wrote:\n> RFI attached'`); create RFI, mark sent, `createLink` for it, `installInboundHooks()`, `upsertEnvelopes` an inbound message on the key → `await` a short tick → `getRfi(...).pendingReply.text === 'Corridor 9ft'`, status still `sent`, broadcast called with `type: 'rfi'`. Also: outbound message → nothing; RFI in `answered` → nothing; provider body failure → falls back to snippet.
  - `routes.test.ts`: accept → `answered`, activity row, pending cleared; dismiss → cleared; 409 without pending.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → pass. **Step 5: Commit** `feat(mail): RFI pending-reply inbound hook and accept/dismiss routes`.

---

### Task 3: Client — banner, list chip, store functions

**Files:**
- Modify: `src/utils/store.ts` (`Rfi`/`RfiListItem` gain `pendingReply: RfiPendingReply | null`, `responseSource`, `responseMessageIdHeader`; add `acceptRfiPendingReply(id, { text?, fileId? })`, `dismissRfiPendingReply(id)`), `src/pages/project/rfi/RfiEditor.tsx` (mount banner above the Response section; `useLiveQuery` on `{ types: ['rfi'], id: rfi.id }` → `onSaved({ keepMounted: true })` — check whether the editor already subscribes; ProjectRfis may), `src/pages/project/ProjectRfis.tsx:118-125` (chip), `src/pages/project/rfi/RfiEditor.test.tsx`, `src/pages/project/ProjectRfis.test.tsx`
- Create: `src/pages/project/rfi/PendingReplyBanner.tsx` (+test)

**Interfaces:**
- `PendingReplyBanner` props: `{ rfi: Rfi; projectId: string; onUseAsResponse(text: string): void; onDismissed(): void; onOpenThread(): void; canOpenThread: boolean }` — amber card: "Reply received from **{name or addr}** · {date}", read-only preview of `text` (collapsed to 6 lines with "Show more"), attachment names if any, buttons **Use as response** (calls `onUseAsResponse(text)`; if `attachments.length` → also opens `SaveAttachmentsModal` (Plan 3) with `defaultProjectId` and kind default `rfi-response`? The upload modal's type list only includes `DIRECT_UPLOAD_KINDS` + custom — `rfi-response` is a system kind. Decision: the modal saves as `document` by default; after save the editor offers the saved file as the response file via the existing "Attach response" path — implement: `SaveAttachmentsModal` gets `onSaved(fileIds)`; banner passes `onSaved` → `setRfiResponse(rfi.id, { fileId: fileIds[0] })` prompt "Use {name} as the response document?" (confirm) ), **Dismiss** (`dismissRfiPendingReply` → `onDismissed`), **Open thread** (enabled when `canOpenThread`).
- `RfiEditor`: `onUseAsResponse(text)` sets `responseDraft` to the text and marks a flag `acceptFromEmail = true`; the existing **Save response text** button, when the flag is set, calls `acceptRfiPendingReply(rfi.id, { text: responseDraft.trim() })` instead of `setRfiResponse` (so accept and text edit are one action). `canOpenThread` via `useItemThreadLinks('rfi', rfi.id).myThread(...)` (Plan 3); `onOpenThread` navigates to `/mail/${accountId}/_/${threadKey}`.
- `ProjectRfis` row: after the status pill, a small amber `Reply` chip when `rfi.pendingReply` (`title="Email reply waiting for review"`).

- [ ] **Step 1: Tests** — `PendingReplyBanner.test.tsx`: renders sender/date/text; Use as response calls back with the text; Dismiss calls `dismissRfiPendingReply` then `onDismissed`; Open thread disabled when `!canOpenThread`. `RfiEditor.test.tsx`: with `pendingReply` the banner shows; clicking Use as response fills the textarea; Save response text then calls `acceptRfiPendingReply` (mocked) not `setRfiResponse`. `ProjectRfis.test.tsx`: chip appears for a row with `pendingReply`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → pass; `npm run lint`. **Step 5: Commit** `feat(rfi-ui): pending email reply banner, accept/dismiss, list chip`.

---

### Task 4: Test-only injection routes + E2E fixtures

**Files:**
- Modify: `server/mail/routes.ts` (guarded block at the end of `registerMailRoutes`), `server/mail/routes.test.ts`
- Create: `e2e/fixtures/mail.ts`

**Interfaces:**
- When `deps.env.MAIL_FAKE_PROVIDER === '1'`:
  - `POST /api/mail/_test/seed` (auth) `{ emailAddress?: string; threads?: Array<{ subject; from: Addr; messages: Array<{ text; html?; date?; attachments?: [{ name; mime; bytesBase64 }] }> }> }` → creates (or reuses) a `fake` account for the caller (`createAccount` with `provider: 'fake'`), seeds the fake provider (`getFakeProvider(id).seed(...)` building envelopes with proper `messageIdHeader`/`references` chains per thread), runs `runBackfill`, starts the worker; returns `{ accountId, threadKeys: string[] }`.
  - `POST /api/mail/_test/inject` (auth) `{ accountId; threadKey?: string; inReplyToMessageId?: string; from: Addr; subject?; text; html?; attachments? }` → `injectInbound` on the fake with `references` = the thread's known ids (so it lands on `threadKey`), then `scheduler.pokeAccount(accountId)`; returns `{ ok: true }`.
  - `routes.test.ts`: both routes 404 when the flag is unset; with the flag, seed creates an account and threads appear in `GET /api/mail/threads`; inject lands a message on the given thread.
- `e2e/fixtures/mail.ts`: `connectFakeAccount(request, token, opts?)` → `POST /api/mail/_test/seed`; `injectReply(request, token, { accountId, threadKey, text, from })`; `sendRfiFromEditor(page, …)` helper is spec-local, not shared.
- `playwright.config.ts` webServer `env`: add `MAIL_FAKE_PROVIDER: '1'` and `APP_PUBLIC_URL: 'http://localhost:<port>'`.

- [ ] **Step 1: Tests** (routes) → **Step 2: FAIL → Step 3: Implement → Step 4: pass → Step 5: Commit** `test(mail): fake-provider seed/inject routes for E2E`.

---

### Task 5: E2E scenarios

**Files:**
- Create: `e2e/mail.spec.ts`, `e2e/mail-item-send.spec.ts`, `e2e/mail-rfi-reply.spec.ts`
- Modify: `e2e/README.md` (list the new specs and the `MAIL_FAKE_PROVIDER` requirement)

Each spec uses `authedPage`, `apiToken`, `request` from `e2e/fixtures/test.ts`. Add `data-testid`s where the specs need them (`mail-thread-row`, `mail-thread-view`, `mail-message-card`, `mail-body-frame`, `mail-images-bar`, `mail-attachment-chip`, `mail-save-attachments`, `mail-compose-open`, `mail-composer`, `mail-composer-send`, `mail-reply-inline`, `sidebar-mail-badge`, `sent-thread-chip`, `rfi-pending-banner`, `rfi-pending-use`, `rfi-pending-dismiss`).

- [ ] **`e2e/mail.spec.ts`**
  1. `connectFakeAccount` with two threads (one with a PDF attachment + remote image html). Visit `/mail` → redirected to the inbox; both rows visible; sidebar badge shows `2`.
  2. Open the attachment thread → `mail-thread-view` shows the subject; body iframe present; `mail-images-bar` visible; click "Load images" → bar gone.
  3. Click `mail-save-attachments` → upload modal lists the PDF → pick project (seed a project first with `seedProjectWithPage`) → Save → toast; `GET /api/documents?projectIds=` (or the store function the Documents page uses) contains the file with `sourceType: 'mailMessage'`.
  4. Reply inline: type text, Send → the thread shows a new card from "me"; `GET /api/mail/threads/...` has `messageCount` +1; row moved to the top with "me" in participants.
  5. Archive from the toolbar → row disappears from Inbox; visible under Archive.
  6. Compose new (`mail-compose-open`): To autocomplete from a seeded customer email (create a customer via API with `emails.general.to`), subject, body, Send → Sent folder has it.
  7. Phone viewport (`page.setViewportSize({ width: 390, height: 800 })`): `/mail` shows only the list; open a thread → only the thread; Back → list.

- [ ] **`e2e/mail-item-send.spec.ts`**
  1. `connectFakeAccount`; seed a project; create an RFI via API; open `/project/:id/rfis`, open the RFI, click Send in the document bar → `mail-composer` opens with To prefilled from the project's contact email (seed `contactEmails` on the project) → Send.
  2. Assert: RFI status pill reads Sent; `sent-thread-chip` visible with "Open thread"; click → lands on `/mail/<acct>/_/<key>` showing the sent message with the RFI PDF chip; `GET /api/mail/links?itemType=rfi&itemId=` has one row.
  3. Send again → composer shows "Reply in existing thread" selected → Send → thread has 2 messages; still one link row.
  4. Remove the mail account via Settings → RFI editor's Send is blocked with "Connect a mail account in Settings → Mail".

- [ ] **`e2e/mail-rfi-reply.spec.ts`**
  1. As above through the first send.
  2. `injectReply(request, token, { accountId, threadKey, from: { addr: 'gc@teg.com', name: 'Mike' }, text: 'Corridor is 9ft\n\nOn … wrote:\n> RFI attached' })`.
  3. Reopen the RFI editor (or keep it open — live update): `rfi-pending-banner` shows "Mike" and "Corridor is 9ft" (not the quoted part); RFI list row shows the `Reply` chip; status still Sent.
  4. Click `rfi-pending-use` → textarea contains the text → Save response text → status Answered; banner gone; `GET /api/rfis/:id` has `responseSource: 'email'`.
  5. New RFI, send, inject, click `rfi-pending-dismiss` → banner gone, status Sent.

- [ ] Run: `npm run test:e2e -- e2e/mail.spec.ts e2e/mail-item-send.spec.ts e2e/mail-rfi-reply.spec.ts` → all pass; then the **full** `npm run test:e2e` to confirm nothing else regressed (24 existing specs + 3).
- [ ] Commit `test(e2e): mail inbox, item send, RFI reply scenarios`.

---

### Task 6: Rollout docs, memory, final push

- [ ] `docs/MIGRATION-CUTOVER.md`: add a "Mail (migration 31)" section — supervised pull; backup auto-taken; `data/mail.key` is generated on first start and must be included in any manual copy (the `npm run backup` script copies the entire data dir, so it is covered); after pull each user with a migrated SMTP account opens Settings → Mail, checks the IMAP host, presses Test & activate; OAuth users press Connect.
- [ ] `docs/mail-setup.md`: add the E2E/dev note (`MAIL_FAKE_PROVIDER=1`) and the Phase 2 pointer (link UI, thread→task, reply indicators on other items).
- [ ] Update `README.md` feature list with one line for Mail (screenshots optional).
- [ ] `npm run lint && npm test && npm run test:e2e` → all green. `git add -A && git commit -m "docs(mail): rollout notes" && git push origin testing`.
- [ ] Write the memory file `mail-client-phase1-complete.md` (type: project) per the memory instructions: shipped date, migration 31 SUPERVISED + smtp transform, env vars needed on Unraid (`APP_PUBLIC_URL`, OAuth vars, optional `MAIL_SECRET_KEY`), manual smoke pending items, Phase 2 backlog (#2 link UI, #4 thread→task/RFI/issue, #5 cross-user open with subject fallback, #6 reply indicators for other items, Gmail Pub/Sub, Graph >3 MB reply attachments via upload session), and add the index line to `MEMORY.md`.

## Plan 4 self-review notes
- §4.7 ✔ Tasks 1–3 (hook, routes, banner/chip, accept semantics, Open thread via Plan 3's `useItemThreadLinks`); §9 E2E rows ✔ Task 5 (seeded threads, body/iframe/images, reply, invoice→RFI item send with chip, attachment save, RFI reply banner → answered); manual smoke list lives in Plan 3 Task 10 + Plan 2 Task 7; §11 rollout ✔ Task 6.
- Decision recorded: the upload modal saves reply attachments as `document` (system kind `rfi-response` isn't user-pickable); the banner then offers the saved file as the RFI response document through the existing `setRfiResponse({ fileId })` path.
