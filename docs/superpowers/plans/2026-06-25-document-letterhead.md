# Branded Document Letterhead Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give every generated document (except AIA pay applications) a branded header + footer matching Nathan's letterhead (`docs/Template.pdf`): angled **black** banners top & bottom with a **brand‑green** accent, the **company contact block** + **logo** in the top band, and a thin green rule under the header. Document **bodies stay as-is** (dynamic per type). Driven by two new app settings: a **company brand colour** and an **"invert logo on documents"** option.

**Reference template:** black `#000000`, brand green `#99CB38` (lime), logo = white bear/skyline (white-on-dark). Header: black angled band across the top with the company block (name / phone / address / email, white) and the logo at top-right, a green angled accent at top-left, and a thin green horizontal rule below the band. Footer: mirrored angled green+black banners at the bottom (decorative, no text). The body shows the document title + dynamic content.

**Scope (apply to):** Invoice (`invoicePdf.ts`), Change Order Request (`changeOrderPdf.ts`), Issue report (`issuePdf.ts`), Punch report (`punchPdf.ts`), Proposal (`proposalGenerator.ts`). **NOT** the AIA G702/G703 Excel (`aiaExcel.ts`).

**Architecture:** One shared `src/utils/documentLetterhead.ts` exposing `drawLetterheadHeader(doc, ctx)` and `drawLetterheadFooter(doc, ctx)` (jsPDF) plus helpers (`hexToRgb`, `invertImageDataUrl`). Each generator (a) resolves a `LetterheadContext` once (brand rgb, company block, logo data URL — inverted if the setting is on), (b) draws the header+footer **on every page**, and (c) lays its body within reserved top/bottom margins. The **brand colour replaces the per-user UI accent** in these documents (client PDFs shouldn't leak a personal UI preference), so generators pass `brandRgb` where they currently call `resolveAccentRgb()`.

**Tech Stack:** jsPDF (vector draw: `rect`, `triangle`, `lines`/`path`, `addImage`, `text`), the settings store (`getSettings`/`saveSettings`, generic key/value in the `settings` table), a canvas for logo inversion.

**SAFETY INVARIANT:** `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run build` green after every task. No DB migration (settings are generic key/value). AIA export untouched. Document bodies/data unchanged — only the surrounding header/footer + the accent colour source change. Multi-page documents must draw the header/footer on **every** page and never overlap body content.

**Current-state notes (from exploration):**
- General Settings tab (`src/pages/Settings.tsx`, admin, `activeTab === 'general'`): a `serverSettings` object with defaults at ~1301 (`logoUrl, companyName, companyPhone, companyEmail, companyAddress`); a logo upload/preview (~1451) and a `fields` array (~1484) of text inputs; saved via the existing settings save. Generic keys persist through `saveSettings`.
- Generators read `getSettings()` → `{ companyName, companyPhone, companyEmail, companyAddress, logoUrl, appName, ... }`. `invoicePdf.ts`: `resolveAccentRgb()` (~24), `InvoicePdfContext.company {name,address,phone,email,logoDataUrl}` (~43), header draws logo `addImage(...,'PNG',M,leftY,110,44)` (~57) + company text + "INVOICE" title in accent. `changeOrderPdf.ts`/`issuePdf.ts`/`punchPdf.ts` mirror this. `proposalGenerator.ts` cover (~590-740) draws a colored header band + logo (~611) + company line (~628-630) + title + total box; also a takeoff-summary page + terms page (+ optional highlights merge); page numbers stamped at the end (~1006).
- `src/utils/color.ts` exists (hexToOklch); add/centralize `hexToRgb` there or in the letterhead module.

---

## Task 1: Settings — company brand colour + "invert logo on documents"

**Files:** `src/pages/Settings.tsx` (General Settings tab). No server change (generic settings keys persist already — verify).

- [ ] **Step 1:** Add to the `serverSettings` defaults (~1301): `companyBrandColor: '#99CB38'` and `invertLogoOnDocuments: 'false'`.
- [ ] **Step 2:** In the General Settings tab UI (near the company fields / logo), add: a **Brand colour** control — a native `<input type="color">` bound to `serverSettings.companyBrandColor` (with the hex shown), labelled "Document brand colour" + a hint "Used for the header/footer accents on generated documents (proposals, invoices, etc.)." And an **"Invert logo on documents"** toggle (checkbox/switch) bound to `serverSettings.invertLogoOnDocuments` ('true'/'false'), hint: "Turn on if your logo is dark — it will be shown in white on the dark document header." Match the tab's existing styling.
- [ ] **Step 3:** Ensure both keys are included in the settings save payload (they will be if they're part of `serverSettings` and the save posts the whole object — verify the save handler sends all keys; if it whitelists keys, add these two).
- [ ] **Step 4:** gates green. Commit `feat(settings): document brand colour + invert-logo-on-documents options`.

---

## Task 2: Shared letterhead module

**Files:** `src/utils/documentLetterhead.ts` (new), `src/utils/documentLetterhead.test.ts` (new, pure helpers only).

- [ ] **Step 1 — Helpers.** `hexToRgb(hex): [number,number,number]` (reuse/centralize; handle #rgb/#rrggbb, fallback). `invertImageDataUrl(dataUrl: string): Promise<string>` — draw the image to a canvas, apply `ctx.filter = 'invert(1)'` (or per-pixel invert), return a PNG data URL; on any failure return the original. (Used so a dark company logo shows white on the black banner.)
- [ ] **Step 2 — Types.** `LetterheadContext = { brandRgb: [number,number,number]; company: { name?: string; phone?: string; email?: string; address?: string }; logoDataUrl?: string }`. (The caller pre-inverts the logo if the setting is on, so the module just draws what it's given.)
- [ ] **Step 3 — `drawLetterheadHeader(doc, ctx): number`.** Draw on the current page, returning the `contentTop` Y where the body may start. Compose with jsPDF vector ops (pt units, letter 612×792):
  - A black header band across the top (full width). Give it an **angled lower edge** on the left (a downward diagonal / chevron) using `doc.triangle`/`doc.lines` filled black, plus a small **brand-green angled accent** at the top-left — approximating the template. (Exact geometry can be iterated; aim to clearly evoke the template.)
  - The **company block** (name bold, then phone, address, email) in white, right-aligned-ish within the band (matching the template's right-of-centre placement). Use `ctx.company.*`; skip blank lines.
  - The **logo** at the top-right via `addImage(ctx.logoDataUrl, 'PNG', x, y, w, h)` (preserve aspect ~609×456 → fit a ~64–80pt box); wrap in try/catch.
  - A thin **brand-green horizontal rule** spanning the full width just below the black band.
  - Return `contentTop` (below the rule).
- [ ] **Step 4 — `drawLetterheadFooter(doc, ctx): number`.** Draw mirrored angled **green + black** banners at the bottom (decorative). Return the `contentBottom` Y (top of the footer) so callers keep body content above it.
- [ ] **Step 5 — Tests.** `documentLetterhead.test.ts`: `hexToRgb` cases (valid, short, invalid→fallback). (Don't instantiate jsPDF/canvas in tests — pure helpers only, matching the repo's pdf-test style.)
- [ ] **Step 6 — Self-QA render (geometry).** Write a throwaway node script (or reuse the build) to emit a sample letterhead PDF and visually compare to `docs/Template.pdf`; tweak coordinates until the header/footer clearly match the template's look. (Logo inversion uses canvas → verify in-app; geometry can be checked headless.) Remove the throwaway script before committing.
- [ ] **Step 7:** gates green. Commit `feat(docs): shared branded letterhead (header/footer) for generated documents`.

---

## Task 3: Apply the letterhead to all non-AIA documents

**Files:** `src/pages/project/billing/invoicePdf.ts`, `src/pages/project/billing/changeOrderPdf.ts`, `src/pages/project/issues/issuePdf.ts`, `src/pages/project/punch/punchPdf.ts`, `src/pages/project/proposal/proposalGenerator.ts`, plus the callers that assemble each context (where `getSettings()` is read + `resolveAccentRgb()` is called — `InvoiceEditor`, `ChangeOrderEditor`, `IssueEditor`, the punch report trigger, `ProjectProposal`). Use an **opus** implementer; render-verify.

- [ ] **Step 1 — Context plumbing.** Each generator's context gains the brand colour + logo handling. At the caller (where `getSettings()` is already fetched to build `company`/`accentRgb`): compute `brandRgb = hexToRgb(settings.companyBrandColor || '#99CB38')`; resolve `logoDataUrl` from `settings.logoUrl` and, when `settings.invertLogoOnDocuments === 'true'`, `logoDataUrl = await invertImageDataUrl(logoDataUrl)`. Pass these in. Replace `resolveAccentRgb()` usage in these documents with `brandRgb` so body accents match the brand (the per-user UI accent no longer appears in client PDFs).
- [ ] **Step 2 — Header/footer per page.** In each generator, replace the existing bespoke header with `drawLetterheadHeader(doc, lc)` and call `drawLetterheadFooter(doc, lc)` — on the first page AND every `addPage()`. Set the body's top margin to the returned `contentTop` and keep content above `contentBottom`. Verify pagination: any page-break logic must re-draw the letterhead and respect the reserved margins (no body text under the footer / over the header). For proposalGenerator, apply to the cover, takeoff-summary, and terms pages (and any appended photo pages); leave the merged highlights PDF pages as-is (they're copied vector plan pages). Keep the document title (e.g. "Proposal", "INVOICE", "Change Order Request") in the body area below the header.
- [ ] **Step 3 — Self-QA render.** Generate a sample of each document (or at least invoice + proposal) and visually confirm the letterhead renders correctly and body content doesn't collide with header/footer. Adjust margins as needed.
- [ ] **Step 4:** gates green (tsc/lint/test/build). Commit `feat(docs): brand letterhead on invoice/change-order/issue/punch/proposal PDFs`.

---

## Task 4: Verify + push + memory

- [ ] **Step 1:** Full gates `npx tsc --noEmit && npm run lint && npm test && npm run build`.
- [ ] **Step 2:** Review (opus): letterhead matches the template intent; applied to all 5 non-AIA docs on every page; bodies/data unchanged; brand colour + invert-logo settings drive it; AIA export untouched; no body/header/footer overlap; logo inversion degrades gracefully. Fix issues.
- [ ] **Step 3:** Push to `testing`. (No migration.)
- [ ] **Step 4:** Memory — branded letterhead shipped (settings: companyBrandColor + invertLogoOnDocuments; shared documentLetterhead module; applied to invoice/CO/issue/punch/proposal, not AIA) + manual-smoke + note that geometry is meant to be iterated with Nathan.

---

## Self-Review Notes (author)

- **One helper, all docs:** geometry lives in `documentLetterhead.ts`, so iterating the banner look later updates every document at once — low risk to ship a first pass and refine with Nathan.
- **Settings-driven, not hardcoded:** brand colour + logo come from app settings (Nathan's logo + green), with logo inversion for dark logos on the black band — so it generalizes beyond Big Bear.
- **Brand colour replaces UI accent in client PDFs:** documents sent to clients should reflect the company brand, not a per-user UI preference.
- **AIA excluded** per Nathan (it's a fixed AIA form).
- **Pagination is the main risk:** the header/footer must redraw on every page with body content kept inside the reserved margins — call out in the implementer prompt and render-verify.
