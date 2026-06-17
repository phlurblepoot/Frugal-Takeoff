# Proposal: Set-Price + Photos + General Email Send — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Three additions to the proposal feature: (1) a **"set price" (lump-sum) mode** — enter a fixed total instead of pricing from takeoffs (for site-visit pricing); (2) **photo attachments** appended to the proposal PDF; (3) **general email send** — send a proposal by email on ANY project (today it's gated behind an inbound bid email), using the shared EmailComposer like invoices/change orders.

**Architecture:** No DB migration. Proposal data already lives in the project JSON (`project.meta`) — printouts are stored there, so proposal photos become a `proposalPhotoIds: string[]` list on the project (uploaded via `uploadProjectFile(projectId, file, 'proposal-photo')`, mirroring how printouts are added/removed + saved). The proposal PDF is built client-side with jsPDF (`src/pages/project/proposal/proposalGenerator.ts`); add a lump-sum total path + a photo-append loop (the same 2-up `addImage` grid used by `issuePdf`/`changeOrderPdf`). General send = relax the `/api/projects/:id/send-proposal` route's `project.email` requirement (accept an explicit `to`) and un-gate the Send card in the UI. The EmailComposer is already wired into the proposal page.

**Tech Stack:** React 19, jsPDF (+ pdf-lib for the highlights merge, unchanged), the `src/components/ui` library, the existing EmailComposer + `sendProjectProposal`.

**SAFETY INVARIANT:** `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run build` green after every task. NO migration. Existing takeoff-based proposals must generate exactly as before when price mode = takeoffs and no photos are added (the new options default off). Keep the proposal's version-checked project saves working (mirror the existing printout add/remove save pattern exactly).

**Reference (current state, from the 2026-06-15 exploration):**
- `src/pages/project/ProjectProposal.tsx`: local state (selectedTakeoffIds default all, customTitle, headerColor, fontFamily, validUntil, coverNotes, terms, includeCostDetail/Highlights/Signature/TakeoffList, highlightQuality), persisted to localStorage/user-prefs. `handleGenerate()` (~146): getSettings → computeTakeoffTotals → `generateProposalPdf(...)` → base64 → `saveFile(fileId, dataUrl)` → push `Printout {id,name,fileId,createdAt,type:'pdf'}` into `project.printouts` → `saveProject(updated)`. Printout history list (view/download/share/delete) ~210-255. **Send card gated by `{project.email && (` (~389)**; uses `<EmailComposer>` with defaultTo `project.email.from`, and `onSend` → `sendProjectProposal(project.id, { to,cc,bcc,subject,body, fileId: sendFileId, attachmentFileIds })`. Generate guard requires `selectedTakeoffIds.size > 0`.
- `src/pages/project/proposal/proposalGenerator.ts`: `ProposalOptions` (~533); `generateProposalPdf(project, takeoffTotals, selectedTakeoffIds, currentPageIds, options, settings, onProgress)` (~547). Cover grand total: `grandTotal = selectedTakeoffs.reduce((s,t)=>s+calculateTakeoffTotalCost(t,t.totalRealValue),0)` (~652); rendered `formatCurrency(roundUpTo100(grandTotal))` on the cover (~699) and the takeoff-summary grand-total row (~957). Takeoff summary page gated by `includeTakeoffList`. Terms page if `terms.trim()`. Highlights merged last if `includeHighlights`. Pure helpers exported + tested in `proposalGenerator.test.ts` (hexToRgb, formatCurrency, etc.).
- Photo-append pattern (copy): `src/pages/project/issues/issuePdf.ts:68-79` / `changeOrderPdf.ts:140-153` — `photoDataUrls: string[]`, fresh `addPage()`, 2-up grid `cellH≈150`, `doc.addImage(url,'JPEG',x,y,cellW,cellH,undefined,'FAST')` in try/catch, page overflow.
- Server route `POST /api/projects/:id/send-proposal` (server/routes.ts ~1095): currently `if (!project.email) return 400`; `toAddress = body.to?.trim() || project.email.from`; subject `Re: <subject>`; `inReplyTo: project.email.messageId`; sets `proposalFileId`/`proposalSentAt`; authenticated (not admin). Test in `server/routes.test.ts` (proposal send block).
- Photo helpers: `uploadProjectFile(projectId, file, kind)`, `getFile(fileId)` (→ dataURL), `getImageUrl(fileId)` (thumbnail src), `deleteFile(fileId)`. Phase-8 touch-delete style: `opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100`, ≥40px.
- `Project` type (src/types.ts ~155): has `printouts?, email?, proposalFileId?, proposalSentAt?`. Add `proposalPhotoIds?: string[]`.

---

## Task 1: Proposal generator — lump-sum total + photo append

**Files:** `src/pages/project/proposal/proposalGenerator.ts`, `src/pages/project/proposal/proposalGenerator.test.ts`, `src/types.ts`.

- [ ] **Step 1 — Types.** In `src/types.ts` add `proposalPhotoIds?: string[]` to the `Project` interface (stored in project meta, like `printouts`).
- [ ] **Step 2 — Extend `ProposalOptions`** with: `priceMode?: 'takeoffs' | 'fixed'` (default `'takeoffs'`), `fixedPriceTotal?: number` (dollars, used when fixed), `photoDataUrls?: string[]` (pre-fetched data URLs for appended photos).
- [ ] **Step 3 — `resolveGrandTotal` pure helper.** Add + export `resolveGrandTotal(options: ProposalOptions, selectedTakeoffs: TakeoffTotals[]): number` → `options.priceMode === 'fixed' ? (options.fixedPriceTotal || 0) : selectedTakeoffs.reduce((s,t)=>s+calculateTakeoffTotalCost(t,t.totalRealValue),0)`. Use it at BOTH render sites (cover total ~699, summary grand-total row ~957) replacing the inline `grandTotal`.
- [ ] **Step 4 — Fixed mode rendering.** In `generateProposalPdf`: when `options.priceMode === 'fixed'`, SKIP the takeoff summary page entirely (treat `includeTakeoffList` as false) and skip cost-detail — the cover shows the fixed total + the cover notes (scope) + (optional) terms/signature. The cover "TOTAL PROPOSAL VALUE" box shows `resolveGrandTotal(...)`. Takeoff mode is unchanged.
- [ ] **Step 5 — Photo append.** After the Terms page and BEFORE the `includeHighlights` merge, if `options.photoDataUrls?.length`, append photos: a fresh `doc.addPage()` with a "Photos" heading, then the 2-up `addImage` grid loop copied verbatim from `changeOrderPdf.ts` (cellH≈150, try/catch per image, page overflow). Works in both price modes.
- [ ] **Step 6 — Tests.** In `proposalGenerator.test.ts` add tests for `resolveGrandTotal`: fixed mode returns `fixedPriceTotal` (and 0 when undefined); takeoffs mode sums `calculateTakeoffTotalCost` across the list. (Pure helper only — don't instantiate jsPDF, matching the file's test style.)
- [ ] **Step 7:** gates green. Commit `feat(proposal): lump-sum price mode + photo append in the PDF engine`.

---

## Task 2: Server — general proposal send (drop the bid-email requirement)

**Files:** `server/routes.ts`, `server/routes.test.ts`.

- [ ] **Step 1 — Relax the route.** In `POST /api/projects/:id/send-proposal`: remove the `if (!project.email) return 400` guard. Compute `toAddress = (typeof to === 'string' && to.trim()) ? to.trim() : (project.email?.from || '')`; if `!toAddress` → 400 `{ error: 'No recipient address' }`. Subject default = `subjectIn?.trim() || (project.email?.subject ? 'Re: ' + project.email.subject : `Proposal — ${project.name ?? 'Untitled'}`)`. `inReplyTo: project.email?.messageId || undefined` (threads only when a bid email exists). Keep the attachments build (primary `fileId` + `attachmentFileIds`), the `proposalFileId`/`proposalSentAt` save (with the reload-after-await safety), and the `proposal_sent` activity log. Auth unchanged (authenticateToken).
- [ ] **Step 2 — Tests.** Update/extend the proposal-send tests in `server/routes.test.ts`: (a) a project WITH `email` still threads (inReplyTo set) and sends; (b) a project WITHOUT `email` now sends successfully when an explicit `to` is provided (no 400), with cc/bcc/subject/body forwarded and `proposalSentAt` persisted; (c) no `to` and no project email → 400. Run the FULL `npm test`.
- [ ] **Step 3:** gates green. Commit `feat(proposal): allow sending a proposal by email on any project (explicit recipient)`.

---

## Task 3: UI — set-price mode, photos, and always-available send

**Files:** `src/pages/project/ProjectProposal.tsx` (+ small helpers if needed).

- [ ] **Step 1 — Price mode toggle.** Add `priceMode: 'takeoffs' | 'fixed'` state (persisted in the proposal prefs like the other options) and `fixedPrice: string` (dollars). Add a segmented control / radio: "Price from takeoffs" vs "Set price". When **fixed**: hide the takeoff selection list, the "include cost detail" and "include takeoff list" options (not meaningful), and show a money `<Input>` for the fixed total + keep the Cover notes field (used as the scope description). When **takeoffs**: current UI unchanged.
- [ ] **Step 2 — Generate guard + options.** Relax `handleGenerate`: in fixed mode allow generating with no takeoffs (require `fixedPrice` parses to a finite number ≥ 0; toast if not). Pass into `ProposalOptions`: `priceMode`, `fixedPriceTotal: Number(fixedPrice) || 0`, and `photoDataUrls` = the proposal photos resolved to data URLs (fetch each `project.proposalPhotoIds` via `getFile(fileId)`; skip failures). In takeoffs mode keep the existing `selectedTakeoffIds.size > 0` guard.
- [ ] **Step 3 — Photos section.** Add a "Photos" card: an "Add photos" button (hidden `<input type="file" accept="image/*" multiple capture="environment">`) → for each file `uploadProjectFile(projectId, file, 'proposal-photo')` → append the fileId to `project.proposalPhotoIds` and `saveProject(updated)` **exactly mirroring the existing printout add pattern** (same local-state update + version handling the printout flow uses, so saves don't 409). A thumbnail grid (`getImageUrl(fileId)`) with a touch-friendly remove (X) button → remove the id from `proposalPhotoIds` + `saveProject` (+ best-effort `deleteFile(fileId)`), mirroring the printout delete pattern. Show an uploading spinner while in flight.
- [ ] **Step 4 — Always-available send.** Remove the `{project.email && (` gate around the Send card so it renders for every project. Set `defaultTo = project.email?.from || ''` (empty → the EmailComposer requires the user to type a recipient). Keep the printout "Attach" dropdown (the user picks a generated proposal PDF; disable Send until one is selected, with a hint to generate first if there are no PDF printouts). `defaultSubject = project.email?.subject ? `Re: ${project.email.subject}` : `Proposal — ${project.name}``. Keep the existing `onSend` → `sendProjectProposal(...)` wiring and the "Proposal sent" banner.
- [ ] **Step 5:** gates green. (Manual: fixed-price proposal generates a cover with the entered total + scope notes, no takeoff table; photos appear as appended PDF pages; a manually-created project can now email a proposal to a typed address with CC/BCC/subject/body + extra attachments.) Commit `feat(proposal): set-price mode, photo attachments, and email send on any project`.

---

## Task 4: Verify + push + memory

- [ ] **Step 1:** Full gates `npx tsc --noEmit && npm run lint && npm test && npm run build`.
- [ ] **Step 2:** Final review (sonnet): takeoff-mode proposals are byte-for-byte unchanged when no new options are set; fixed mode renders the entered total + scope, no takeoff table; photos persist on the project (proposalPhotoIds) and append to the PDF; the project-save version flow mirrors printouts (no 409s); send works on a project with NO bid email (explicit To) and still threads when one exists; no migration; auth unchanged. Fix any issue.
- [ ] **Step 3:** Push to `testing`. (No migration; no data risk.)
- [ ] **Step 4:** Memory — proposal set-price + photos + general send shipped (project-meta photos, no migration) + manual-smoke checklist.

---

## Self-Review Notes (author)

- **No migration:** proposal photos are a `proposalPhotoIds` array in the project JSON (where printouts already live), uploaded as files via the existing `uploadProjectFile`. Mirrors the printout add/remove + version-checked save flow so there are no 409s.
- **Backwards-safe:** `priceMode` defaults to `'takeoffs'`, `photoDataUrls` defaults empty → existing proposals generate identically.
- **DRY:** photo-append loop copied from `changeOrderPdf`; `resolveGrandTotal` is the single price source for both render sites (extract + test like `coTotalsBlock`); send reuses the EmailComposer + `sendProjectProposal` already wired.
- **General send:** the only blockers were the route's `project.email` 400 and the UI's `project.email` card gate — both removed; threading (`inReplyTo`) is preserved when a bid email exists.
- **Set price = price + scope:** fixed mode shows the entered total on the cover plus the cover-notes scope text (and optional terms/signature/photos); the takeoff summary/cost-detail are suppressed since there are no measurements.
