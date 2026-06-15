# Email Composer (app-wide) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Every place the app sends an email gets a real composer: To plus a CC/BCC reveal, an editable (prefilled) subject, an editable (prefilled) body, and the ability to attach extra files alongside the generated PDF.

**Scope (the only 4 send sites):** `InvoiceEditor`, `ChangeOrderEditor`, `IssueEditor`, `ProjectProposal`. All route through the server helper `sendProjectEmail` (server.ts ~480) + 4 routes (`POST /api/invoices/:id/send`, `/api/change-orders/:id/send`, `/api/issues/:id/send`, `/api/projects/:id/send-proposal`). No other feature sends email.

**Architecture:** One shared **`EmailComposer`** modal (client) collects To/CC/BCC/subject/body + extra attachments (uploaded via the existing `uploadProjectFile`). Each site opens it prefilled with sensible defaults and, on send, builds its primary PDF as it does today, uploads it, and calls its store helper with the composed fields + the primary fileId + the extra attachment fileIds. The server `sendProjectEmail` is extended to accept `cc`, `bcc`, and an **array** of attachments; each of the 4 routes accepts `to/cc/bcc/subject/body/attachmentFileIds` (with server-side fallbacks preserved).

**Tech Stack:** Express + nodemailer (SMTP from `settings` table), React 19, the `src/components/ui` library (Modal/Field/Input/Textarea/Button already exist).

**Reference (current state, from the 2026-06-15 exploration):**
- `sendProjectEmail(opts: { to, subject, text, fileId, attachmentName, inReplyTo? })` — server.ts ~480; single attachment, `mailOptions` = {from, to, subject, text, attachments:[one], inReplyTo?, references?}. `buildTransporter()` ~465 reads `smtp.*` settings. Attachment bytes via `getDataUrlString(db, DATA_DIR, fileId)` (server/files.ts ~109) → base64 → Buffer; `getMeta(db,id)` gives `.name`/`.mime`.
- Routes: invoice/CO/issue send accept `{ to, fileId, message? }` (message currently hardcoded/ignored on the client); subjects are server-built. Proposal send accepts `{ fileId, message? }`, derives `to` from `project.email.from`, subject `Re: <project.email.subject>`, sets `inReplyTo` from `project.email.messageId`. Invoice/CO admin-gated; issue/proposal authenticated (not admin).
- Client send helpers (src/utils/store.ts): `sendInvoice(id,{to,fileId,message?})` ~838, `sendChangeOrder(id,{to,fileId,message?})` ~831, `sendIssue(id,{to,fileId,message?})` ~900, `sendProjectProposal(projectId, fileId, message?)` ~288 (positional, returns Project).
- Build blocks: `uploadProjectFile(projectId, file, kind)` ~578 (→ fileId), `fetchFileBlob(id)` ~606. Email regex used in all 3 editors: `/\S+@\S+\.\S+/`.
- Site context: Invoice has `invoice.number, projectName, contractor, address`; CO has `co.number, co.description, projectName`; Issue has `issue.number, issue.title, projectName`; Proposal has `project.name, project.email.{from,fromName,subject,messageId}` + a printout dropdown (`sendFileId`).

**SAFETY INVARIANT:** `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run build` green after every task. Sends still degrade gracefully when SMTP isn't configured (buildTransporter returns null → no-op, as today). Don't change auth gating on any route. Keep the existing status side-effects (invoice/issue/CO → 'sent', proposal → proposalSentAt).

---

## Task 1: Server — cc/bcc/subject/body + multiple attachments

**Files:** `server.ts`, plus `server/routes.ts` if the send routes live there (the exploration put them in server.ts — confirm). Tests: the existing route/integration test file if one covers sends.

- [ ] **Step 1 — Extend `sendProjectEmail`.** New opts: `{ to: string; cc?: string; bcc?: string; subject: string; text: string; attachments: Array<{ fileId: string; attachmentName: string }>; inReplyTo?: string }`. Build the nodemailer `attachments` by mapping the array (each: read bytes via getDataUrlString → Buffer, contentType from the data URL/mime, filename = attachmentName). Add `cc` and `bcc` to `mailOptions` only when non-empty (trim; omit if blank). Keep `from`, `inReplyTo`/`references`, and the SMTP-null no-op behavior. (Nodemailer accepts comma-separated address strings in to/cc/bcc — pass through as-is.)
- [ ] **Step 2 — Update the 4 send routes** to read `cc, bcc, subject, body, attachmentFileIds` from `req.body` (all optional) and build the attachments array = the primary `{ fileId: body.fileId, attachmentName: <entity default name> }` followed by each extra `attachmentFileIds[i]` mapped to `{ fileId, attachmentName: getMeta(db, id)?.name || 'attachment' }` (skip ids that don't resolve). Pass `cc`, `bcc`. Subject = `body.subject?.trim() || <existing server default>`; text = `body.body ?? body.message ?? <existing default text>`. Preserve each route's auth + status side-effect + activity log. Specifics:
  - Invoice (`POST /api/invoices/:id/send`): default subject `Invoice <number>`, primary attachmentName `<number>.pdf`.
  - Change order (`/api/change-orders/:id/send`): default subject `Change Order Request <number>`, primary `CO-<number>.pdf`.
  - Issue (`/api/issues/:id/send`): default subject `Issue ISS-<padded>[ — title]`, primary `ISS-<padded>.pdf`.
  - Proposal (`/api/projects/:id/send-proposal`): accept an optional `to` override (fallback to `project.email?.from`); keep `inReplyTo` from `project.email?.messageId`; default subject = existing (`Re: <subject>` / `Proposal`); primary attachmentName e.g. `Proposal.pdf` (or keep current). Still set `proposalFileId`/`proposalSentAt`.
- [ ] **Step 3 — Validate/normalize lightly:** treat empty-string cc/bcc/subject/body as absent (fall back to defaults). Don't hard-fail on a malformed address (let SMTP handle it) — but trim. Skip unresolved attachment ids silently.
- [ ] **Step 4 — Tests:** if the repo has route tests that exercise sends (search for `/send` in server tests), extend them to assert the new fields are accepted and that `attachmentFileIds` produces multiple attachments / cc+bcc are forwarded (mock or assert on the options passed to a stubbed transporter if the test harness allows; otherwise assert the route returns 200 and the side-effect fires). Run the FULL `npm test` (the Phase 7b lesson: schema/route changes can break sibling tests like verify-migration). Keep all green.
- [ ] **Step 5:** gates green. Commit `feat(email): server send accepts cc/bcc/subject/body + multiple attachments`.

---

## Task 2: Client — EmailComposer component + store helper signatures

**Files:** `src/components/EmailComposer.tsx` (new), `src/utils/store.ts`, `src/utils/email.ts` (new, tiny validation util) + `src/utils/email.test.ts`.

- [ ] **Step 1 — Email util** `src/utils/email.ts`: `isValidEmail(s): boolean` (the existing `/\S+@\S+\.\S+/` rule) and `parseAddressList(s): string[]` (split on comma/semicolon, trim, drop empties) + `isValidAddressList(s): boolean` (every parsed entry valid; empty list allowed for cc/bcc, not for to). Unit-test these.
- [ ] **Step 2 — `EmailComposer.tsx`** (a `Modal`-based dialog). Props:
  ```
  {
    open: boolean;
    onClose: () => void;
    projectId: string;                 // for uploading extra attachments
    title?: string;                    // e.g. "Send invoice"
    primaryAttachmentName: string;     // the generated doc, shown as a fixed chip (always attached)
    defaultTo?: string;
    defaultSubject: string;
    defaultBody: string;
    onSend: (msg: { to: string; cc?: string; bcc?: string; subject: string; body: string; attachmentFileIds: string[] }) => Promise<void>;
  }
  ```
  Behavior:
  - State seeded from defaults each time it opens (re-seed on `open` going true, e.g. keyed mount or a useEffect).
  - **To** = `Input type="email"` (required). A small **"Add Cc/Bcc"** toggle (text button) reveals **CC** and **BCC** inputs (hidden by default; per the request — a dropdown/disclosure). All three accept comma-separated addresses (`parseAddressList`).
  - **Subject** = `Input` (prefilled, editable).
  - **Body** = `Textarea` (prefilled, editable, ~6 rows).
  - **Attachments:** show the `primaryAttachmentName` as a non-removable chip (label it "generated"); an **"Add attachment"** button (hidden `<input type="file" multiple>`) uploads each file via `uploadProjectFile(projectId, file, 'email-attachment')`, tracking `{ fileId, name }` with a remove (X) button and an uploading spinner. Touch-friendly controls.
  - Footer: Cancel + **Send** (disabled until To is a valid address list; shows "Sending…"). On Send: validate To (and cc/bcc if present) → `setSending(true)` → `await onSend({ to, cc: cc||undefined, bcc: bcc||undefined, subject, body, attachmentFileIds })`; on success `onClose()`; on throw, toast the error and stay open. The composer owns `sending`.
  - Mobile-friendly (uses the Phase 8 Modal which already scrolls + safe-area).
- [ ] **Step 3 — Store helpers** (src/utils/store.ts): widen the payloads to `{ to?, cc?, bcc?, subject?, body?, fileId, attachmentFileIds?, message? }`:
  - `sendInvoice(id, payload)`, `sendChangeOrder(id, payload)`, `sendIssue(id, payload)` — add cc/bcc/subject/body/attachmentFileIds (keep `to`, `fileId`).
  - `sendProjectProposal` — change to `sendProjectProposal(projectId, payload: { to?, cc?, bcc?, subject?, body?, fileId, attachmentFileIds? }): Promise<Project>` (object form). Update its single caller in Task 3.
- [ ] **Step 4:** gates green. Commit `feat(email): shared EmailComposer (cc/bcc, subject, body, attachments) + email util`.

---

## Task 3: Wire all 4 send sites to EmailComposer

**Files:** `src/pages/project/billing/InvoiceEditor.tsx`, `src/pages/project/billing/ChangeOrderEditor.tsx`, `src/pages/project/issues/IssueEditor.tsx`, `src/pages/project/ProjectProposal.tsx`.

For each site: remove the inline single "to" input; replace the Send button with one that opens `<EmailComposer>` prefilled. The site's `onSend` does its existing build → upload → store-call, now passing the composed fields + `attachmentFileIds`.

- [ ] **Step 1 — InvoiceEditor:** "Send invoice" button opens the composer. defaults: `defaultSubject = `Invoice ${invoice.number} — ${projectName}``; `defaultBody = `Hello,\n\nPlease find attached Invoice ${invoice.number} for ${projectName}.\n\nThank you.``; `primaryAttachmentName = `${invoice.number||'invoice'}.pdf``. onSend: `buildBytes()` → `uploadProjectFile(projectId, file, 'invoice')` → `sendInvoice(invoice.id, { to, cc, bcc, subject, body, fileId, attachmentFileIds })` → `onSaved()`. Keep the dirty/save guard if present.
- [ ] **Step 2 — ChangeOrderEditor:** "Send request" opens composer. `defaultSubject = `Change Order Request CO-${co.number} — ${projectName}``; `defaultBody = `Hello,\n\nPlease find attached Change Order Request CO-${co.number} for ${projectName}${co.description ? ', covering: ' + co.description : ''}.\n\nPlease review and approve at your convenience.\n\nThank you.``; `primaryAttachmentName = `CO-${co.number||'change-order'}.pdf``. onSend mirrors today (build CO PDF w/ photos → upload 'change-order' → `sendChangeOrder(co.id, {...})`).
- [ ] **Step 3 — IssueEditor:** "Send report" opens composer (keep the save-first guard). `defaultSubject = `Issue Report ISS-${padded} — ${projectName}``; `defaultBody = `Hello,\n\nPlease find attached Issue Report ISS-${padded}${issue.title ? ' — ' + issue.title : ''} for ${projectName}.\n\nThank you.``; `primaryAttachmentName = `ISS-${padded}.pdf``. onSend: build issue PDF → upload 'issue' → `sendIssue(issue.id, {...})`.
- [ ] **Step 4 — ProjectProposal:** keep the printout **Attach** dropdown (chooses which saved printout is the primary attachment → `sendFileId`). The "Send proposal" button opens the composer with `defaultTo = project.email?.from || ''`, `defaultSubject = project.email?.subject ? `Re: ${project.email.subject}` : `Proposal — ${project.name}``, `defaultBody = `Please find our proposal attached. Don't hesitate to reach out with any questions.``, `primaryAttachmentName` = the selected printout's name. onSend: `sendProjectProposal(project.id, { to, cc, bcc, subject, body, fileId: sendFileId, attachmentFileIds })` → set project state. (Composer only opens once a printout is selected; if none, keep the existing disabled/guard.)
- [ ] **Step 5:** gates green. (Manual: at each site, Send opens the composer with prefilled subject/body; Add Cc/Bcc reveals fields; add an attachment; send goes through with the generated PDF + extras.) Commit `feat(email): wire invoice/change-order/issue/proposal sends to the EmailComposer`.

---

## Task 4: Verify + push + memory

- [ ] **Step 1:** Full gates `npx tsc --noEmit && npm run lint && npm test && npm run build`.
- [ ] **Step 2:** Final review (sonnet): all 4 sites use the shared composer; cc/bcc optional + hidden behind the toggle; subject/body prefilled + editable + actually sent (not the old hardcoded message); extra attachments upload + send alongside the primary PDF; primary PDF still attached; auth gating + status side-effects unchanged; SMTP-absent still no-ops; no duplicated email validation (all use email.ts). Fix any issue.
- [ ] **Step 3:** Push to `testing`. (No migration; no data risk.)
- [ ] **Step 4:** Memory — email composer shipped app-wide (the 4 sites, server cc/bcc/multi-attachment, defaults per type) + a manual-smoke checklist.

---

## Self-Review Notes (author)

- **One composer, four sites:** the composer is presentational + collects fields and extra attachments; each site keeps ownership of building/uploading its primary PDF and calling its store helper, so the per-document logic (photos in CO/issue, printout selection in proposal) stays where it belongs.
- **Backwards-safe server:** every new field is optional with the existing server default as fallback, so a missing subject/body behaves exactly as today; `message` is still accepted as a body alias. SMTP-null still no-ops.
- **DRY:** shared `email.ts` validation (replaces the 3 copies of the regex); shared composer; reuse `uploadProjectFile`/`fetchFileBlob`.
- **Defaults:** professional prefilled subject/body computed client-side from each editor's in-scope context; user edits before sending.
- **Proposal nuance:** To is prefilled from the reply address but now editable, and CC/BCC are available there too (previously reply-only); threading (`inReplyTo`) preserved.
