# Releases of Lien (Florida): Design

Date: 2026-10-15
Status: Approved by the owner in chat (T22), with the decisions in §8, which
override the draft where they differ. T23 (server and PDF) is built.
Request: `.knowledge/requests-2026-10-15.md` §11

> This is research and a software design, not legal advice. The statutory
> text below is quoted from the official 2026 Florida Statutes. The
> conditional wording in §4 is our own drafting; the owner may want a Florida
> construction attorney to read §4 before it ships.

## 1. Problem

Nathan wants to generate releases of lien that are valid in Florida:
conditional and unconditional, each for a progress payment and for the final
payment. They should work like invoices and change orders: a PDF on the
company letterhead, saved in the project's Documents, ready to email. A
release can start from a pay app or an invoice (amounts and dates filled in)
or from Documents → New (filled in by hand). Nothing for lien releases exists
in the code today.

## 2. What Florida law says (researched 2026-10-15)

### 2.1 The statute: Fla. Stat. § 713.20, "Waiver or release of liens"

Source: the 2026 Florida Statutes on the Legislature's site
(leg.state.fl.us, ch. 713, s. 713.20) and the Senate's copy
(flsenate.gov/Laws/Statutes/2026/713.20). Both were read on 2026-10-15.
History note: `s. 1, ch. 63-135; s. 35, ch. 67-254; s. 5, ch. 88-397; s. 8,
ch. 96-383; s. 1769, ch. 97-102; s. 5, ch. 97-219; s. 30, ch. 99-6`. The
section has not changed since 1999.

Subsections that matter here:

- **(2)** A right to claim a lien may not be waived in advance. It can be
  waived only to the extent of labor, services or materials already
  furnished. An advance waiver is unenforceable.
- **(3)** Any person may at any time waive, release or satisfy any part of
  their lien, "either as to the amount due for labor, services, or materials
  furnished or for labor, services, or materials furnished through a certain
  date subject to exceptions specified at the time of release, or as to any
  part or parcel of the real property."
- **(4)** When a lienor is required to sign a waiver in exchange for, or to
  induce payment of, a **progress payment**, the waiver "may be in
  substantially the following form" (the form is quoted in §4.1 below).
- **(5)** The same for the **final payment** (form in §4.2 below).
- **(6)** "A person may not require a lienor to furnish a lien waiver or
  release of lien that is different from the forms in subsection (4) or
  subsection (5)."
- **(7)** "A lienor who executes a lien waiver and release in exchange for a
  check may condition the waiver and release on payment of the check.
  However, in the absence of a payment bond protecting the owner, the owner
  may withhold from any payment to the contractor the amount of any such
  unpaid check until any such condition is satisfied."
- **(8)** "A lien waiver or lien release that is not substantially similar to
  the forms in subsections (4) and (5) is enforceable in accordance with the
  terms of the lien waiver or lien release."

### 2.2 What this means for the four variants

1. **Florida has no statutory conditional form.** The two statutory forms in
   (4) and (5) are unconditional as written: they take effect when signed and
   delivered, whether or not the money arrives. Unlike California, Texas or
   Georgia, Florida has no set of four statutory forms. The "four variants"
   are the two statutory forms, each given unconditionally or with a
   condition added.
2. **Conditional versions are lawful in two ways.**
   - *Payment by check:* (7) expressly lets the lienor condition the waiver
     on payment of the check.
   - *Any other payment (ACH, wire, card, or method not yet known):* no
     statute names this case. It rests on (3) (a waiver may be "subject to
     exceptions specified at the time of release") and (8) (a form that is
     not substantially similar is "enforceable in accordance with" its
     terms). So a waiver that says it takes effect only when the funds are
     received is enforced as a conditional waiver. See §7, uncertainty U1.
3. **Who chooses the form.** (6) stops a customer from *requiring* a form
   other than the statutory one. It does not stop the lienor from *offering*
   a conditional version. A customer may still insist on the plain statutory
   (unconditional) form before releasing payment; see U2.
4. **The progress form never covers retention.** Its fixed sentence "This
   waiver and release does not cover any retention or labor, services, or
   materials furnished after the date specified" means retainage stays
   protected until a final release (or a separate release) covers it.
5. **No advance waivers.** A progress release must name a "through" date no
   later than the work actually done. The app does not let the through date
   be after the release date (§5.4).
6. **No notary.** Neither statutory form has a notary block or jurat, and
   713.20 does not require notarization. A customer's own form may ask for
   one; that is outside this feature (see the questions in §8).
7. **Unconditional release before payment is the main risk.** Industry
   guidance (Levelset's Florida lien waiver FAQ; McDonald Hopkins, "Understanding
   waivers and releases for Florida construction contractors", C. Distel,
   2018) is the same: sign the unconditional statutory form only once the
   money has cleared, and send a conditional version before that. The app
   warns when an unconditional release has no payment recorded against it
   (§6.3).

### 2.3 Recent bills (none became law)

- **SB 908 (2024)** would have made the statutory forms mandatory and made
  non-conforming waivers unenforceable. Died in the Judiciary committee,
  March 2024 (flsenate.gov/Session/Bill/2024/908).
- **CS/SB 658 (2025)** would have (a) changed "may be in substantially the
  following form" to "must be in the following form", (b) changed (7) to let
  a lienor paid by any means condition the waiver "on receipt of funds"
  rather than payment of a check, and (c) limited (8) to forms with no terms
  beyond the statutory ones. It passed the Senate 36-0 on 2025-04-16 and died
  in House Messages on 2025-06-16; the House companion, HB 893, died in
  committee (flsenate.gov/Session/Bill/2025/658, bill text c1).
- **2026 and 2027 sessions:** the Senate's bill search finds 0 bills citing
  713.20 for either year (checked 2026-10-15).

Why this matters to the design: if a bill like SB 658 passes, (8) would stop
protecting forms with extra terms. Our conditional wording would then need to
match whatever the statute says. Keeping all wording in one module (§5.5)
makes that a one-file change.

### 2.4 Related but out of scope

- **Contractor's Final Payment Affidavit** (Fla. Stat. § 713.06(3)(d)): a
  sworn affidavit the *contractor in privity with the owner* must give the
  owner when final payment under the direct contract becomes due. It is not
  a lien release and applies to prime contractors, not subcontractors. It
  could be a separate generator later.
- **Public projects and payment bonds:** Part I liens do not attach to public
  property; claims there go against the payment bond (s. 255.05), and on
  bonded private jobs against the s. 713.23 bond. The statutory forms release
  "its lien and right to claim a lien". Whether they also release bond rights
  is not settled by 713.20. The app generates the same forms on any project;
  see U4.
- **Who is a "lienor"** (s. 713.01): a contractor, subcontractor,
  sub-subcontractor, laborer, materialman or professional lienor. A
  plastering subcontractor is a lienor. Its "customer" on the form is
  usually the general contractor.

## 3. The four variants

| Variant | Statutory basis | When it is used | Takes effect |
|---|---|---|---|
| Conditional, progress | (4) form + condition under (7) or (3)/(8) | Sent with a pay app or invoice to get it paid | When the check is paid, or when the funds are received |
| Unconditional, progress | (4) form, statutory text only | After a progress payment has cleared | When signed and delivered |
| Conditional, final | (5) form + condition | Sent with the final pay app or invoice | When the check is paid, or when the funds are received |
| Unconditional, final | (5) form, statutory text only | After the final payment has cleared | When signed and delivered |

The unconditional variants print the statutory text and nothing else in the
body (plus an optional Exceptions paragraph under (3), off by default).

## 4. Wording (for the owner's approval)

Placeholders in `{braces}` are filled from the record (§5). Everything else
prints exactly as written. The statutory sentences are the 2026 text,
verbatim; do not paraphrase them.

### 4.1 Progress payment (statutory, s. 713.20(4))

```
WAIVER AND RELEASE OF LIEN
UPON PROGRESS PAYMENT

The undersigned lienor, in consideration of the sum of ${amount}, hereby
waives and releases its lien and right to claim a lien for labor, services,
or materials furnished through {throughDate} to {customerName} on the job of
{ownerName} to the following property:

{propertyDescription}

This waiver and release does not cover any retention or labor, services, or
materials furnished after the date specified.

DATED on {releaseDate}.

{lienorName}
By: ______________________________
{signerName}, {signerTitle}
```

### 4.2 Final payment (statutory, s. 713.20(5))

```
WAIVER AND RELEASE OF LIEN
UPON FINAL PAYMENT

The undersigned lienor, in consideration of the final payment in the amount
of ${amount}, hereby waives and releases its lien and right to claim a lien
for labor, services, or materials furnished to {customerName} on the job of
{ownerName} to the following described property:

{propertyDescription}

DATED on {releaseDate}.

{lienorName}
By: ______________________________
{signerName}, {signerTitle}
```

Fill-in formats: `{amount}` as `12,345.67` (the `$` is part of the text);
dates as `October 15, 2026` (en-US long form, built from the stored
`YYYY-MM-DD` day, never through a `Date` in local time; see the 4.1.8 fix in
`src/utils/billingDates.ts`). "DATED on {releaseDate}" fills the statute's
"DATED on ____, ____ (year)" in one go. The statute shows "By:" with a blank;
the printed name and title under the line are ours and add no terms.

### 4.3 Conditional versions

The title gets the word CONDITIONAL in front:
`CONDITIONAL WAIVER AND RELEASE OF LIEN` / `UPON PROGRESS PAYMENT` (or
`UPON FINAL PAYMENT`). The statutory body follows unchanged, then one
condition paragraph, printed in bold, before the DATED line.

**Paid by check** (when a check number is entered; relies on s. 713.20(7)):

```
CONDITION: This waiver and release is conditioned on payment of the check
described below, as permitted by section 713.20(7), Florida Statutes. It
takes effect only when that check has been paid by the bank on which it is
drawn. If the check is not paid, this waiver and release is void.

Check No. {checkNumber}, drawn by {checkMaker} on {checkBank}, in the amount
of ${amount}.
```

`{checkBank}` is optional; when blank, the words "on {checkBank}" drop out.

**Any other payment or method not known** (relies on s. 713.20(3) and (8)):

```
CONDITION: This waiver and release is conditioned on the undersigned's
receipt of the sum stated above in good and collected funds. It takes effect
only upon that receipt. If the payment is not received, or is returned,
reversed or charged back, this waiver and release is void.
```

### 4.4 Optional exceptions (any variant, off by default)

When the Exceptions field is not empty, print before the DATED line:

```
EXCEPTIONS: This waiver and release does not cover the following:
{exceptions}
```

Use: carving out unpaid change orders or disputed claims, as s. 713.20(3)
allows ("subject to exceptions specified at the time of release"). An
exception makes the release "not substantially similar", so (8) applies and
the customer may refuse it. The editor says so under the field.

### 4.5 Around the form

- Company letterhead header and footer, as on change orders
  (`drawLetterheadHeader` / `drawLetterheadFooter`,
  `src/utils/documentLetterhead.ts`).
- One grey reference line under the header, outside the form body:
  `Release LR-{number} · {projectName}`, plus `· Pay App #{n}` or
  `· Invoice {number}` when linked. Reference text only, no legal terms.
- No notary block and no statute citation in the footer (a citation would be
  wrong on a conditional or excepted version).
- With "Sign with my signature" on (§6.2), the user's saved signature image
  is drawn on the By: line. Otherwise the line is blank for a wet or
  electronic signature.
- One page, Letter portrait. A long property description or exceptions text
  wraps and may continue on page 2 with the letterhead repeated.

## 5. Data

### 5.1 Stored records: yes

Releases are stored records, like change orders, not one-off PDFs. Reasons:

1. **Proof of what was waived.** A release gives up lien rights. The company
   needs to see later which releases went out, for how much and through what
   date. One row per release keeps that history.
2. **It fits the document machinery.** `DocumentActionsBar`
   (`src/components/documents/DocumentActionsBar.tsx:94-120`) keeps one
   living document per `(sourceType, sourceId)` record, with regenerations
   saved as versions, the up-to-date chip and the item Send flow. That needs a
   record id.
3. **Mail thread links.** Item sends link the email thread to the item
   (`server/mail/links.ts:6-9`, `ItemType` and `ITEM_TABLE`). That also needs
   a record.

**Snapshot, not live link.** A release stores every value printed on it. If
the pay app changes later, the release does not change. `sourceType` and
`sourceId` only record where it was started from.

### 5.2 Table `lien_releases` (new migration, the next free number in `server/migrationList.ts`, additive)

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | uuid |
| projectId | TEXT NOT NULL | indexed |
| number | TEXT | per project: 1, 2, 3, … printed `LR-1`; same rule as `nextChangeOrderNumber` (`server/billingStore.ts:607-617`) |
| paymentType | TEXT NOT NULL | `progress` or `final` |
| conditional | INTEGER NOT NULL | 1 or 0 |
| sourceType | TEXT | `payapp`, `invoice` or NULL (started by hand) |
| sourceId | TEXT | pay app or invoice id, or NULL |
| supersedesId | TEXT | set on an unconditional release made from a conditional one (§6.4) |
| lienorName | TEXT NOT NULL | |
| customerName | TEXT NOT NULL | |
| ownerName | TEXT NOT NULL | |
| propertyDescription | TEXT NOT NULL | |
| amountCents | INTEGER NOT NULL | ≥ 0 |
| throughDate | TEXT | `YYYY-MM-DD`; required for progress, NULL for final |
| releaseDate | TEXT NOT NULL | `YYYY-MM-DD` |
| signerName | TEXT NOT NULL | |
| signerTitle | TEXT | |
| conditionKind | TEXT | `check` or `funds`; NULL when unconditional |
| checkNumber, checkMaker, checkBank | TEXT | check condition only |
| exceptions | TEXT | NULL or empty = none |
| signatureFileId | TEXT | the signature image used, or NULL |
| status | TEXT NOT NULL DEFAULT 'draft' | `draft`, `sent`, `void` |
| createdByUserId | TEXT | |
| version | INTEGER NOT NULL DEFAULT 1 | optimistic concurrency, like change orders |
| createdAt, updatedAt | INTEGER NOT NULL | `updatedAt` drives the up-to-date chip |

Money is integer cents, as in `aiaStore`. Days are `YYYY-MM-DD` text, as pay
apps store `periodTo`, so no time zone can move a date.

### 5.3 Fields and where their defaults come from

Defaults are filled once, when the release is created. After that every field
is the user's to edit. One server call computes them:
`GET /api/projects/:id/lien-releases/prefill?sourceType=&sourceId=&paymentType=&conditional=`.

| Field | Default | Source in the code |
|---|---|---|
| lienorName | Company name | settings `companyName`, else `appName` (as `ChangeOrderEditor.tsx:170-176` builds the letterhead) |
| customerName | The project's customer | `project.contractor`, else the linked customer's `name` (`src/types.ts:161-178`) |
| ownerName | Property owner | AIA settings `ownerName` (`AiaSettings`, `src/utils/store.ts:2383-2390`), else the project's last release, else blank (required) |
| propertyDescription | Job and address | the project's last release; else `{project name}` + new line + `project.address` |
| amount: conditional, from pay app | Amount still due | G702 line 8 `L8currentPaymentDueCents` (`server/aiaStore.ts:902-913`) less payments recorded against the pay app (the list's `balanceCents`, `aiaStore.ts:491-494`) |
| amount: unconditional, from pay app | Amount received | sum of payments with `targetType='payapp'` for that pay app; if none, line 8 and a warning (§6.3) |
| amount: conditional, from invoice | Amount still due | invoice total less payments (`billingStore` totals and `paidCentsFor`, `server/billingStore.ts:76-88`) |
| amount: unconditional, from invoice | Amount received | sum of the invoice's payments; if none, the total and a warning |
| amount: started by hand | 0 | must be entered (> 0) |
| throughDate (progress) | End of the billed period | pay app `periodTo`; invoice `date`; by hand: release date |
| releaseDate | Today | `todayDay()` (`src/utils/billingDates.ts:27`) |
| signerName | Current user's name | the signed-in user |
| signerTitle | Last title this user typed | the user's most recent release, else blank |
| conditionKind | `funds` | becomes `check` when a check number is entered |
| checkMaker | The customer | `customerName` |
| exceptions | Empty | |

For a **final** release the amount is the final payment. The defaults above
use the source's due or received amount; on a final pay app that already
includes released retainage. The editor shows the source's numbers next to
the field (contract sum to date, paid to date, balance) so the user can check
it.

### 5.4 Validation (server, store layer)

- `paymentType` in {progress, final}; `conditional` boolean.
- `amountCents` an integer ≥ 1.
- Progress: `throughDate` required and not after `releaseDate`. This guards
  against advance waivers under s. 713.20(2).
- Final: `throughDate` is stored as NULL.
- Required: lienorName, customerName, ownerName, propertyDescription,
  releaseDate, signerName.
- `conditionKind='check'` needs `checkNumber` and `checkMaker`.
- Unconditional: the condition and check fields are cleared.
- `status='sent'` or `'void'`: delete is refused (409); see §6.5.

### 5.5 Where the wording lives

One client module, `src/pages/project/billing/lienReleaseWording.ts`:

- exported constants holding the statutory sentences verbatim;
- `lienReleaseTitle(release)` and `lienReleaseParagraphs(release)`, pure
  functions returning the title lines and the body paragraphs (with which
  fill-ins to underline);
- used by the PDF builder and by the editor's live preview, so the preview
  always matches the PDF.

The test pins the statutory text word for word against §4.1 and §4.2, so an
accidental edit fails CI.

## 6. Behaviour and UI

### 6.1 Entry points

1. **Pay app editor** (`AiaPayAppEditor.tsx`): a "Release of lien" button
   next to the document bar opens a small menu with the four variants.
   Choosing one creates the release from that pay app and opens it.
2. **Invoice editor** (`InvoiceEditor.tsx`): the same button and menu.
3. **Billing → Lien Releases tab**: a new tab in `BILLING_TABS`
   (`src/pages/project/ProjectBilling.tsx:25-32`) between Invoices and
   Payments. It lists the project's releases (number, variant, amount,
   through date, release date, status, linked pay app or invoice, document
   link) and has "New release", which opens the variant menu with no source
   (filled in by hand).
4. **Documents → New** (`DocumentsPage.tsx:369`): the "New document" button
   becomes a small menu: "Document, spreadsheet or PDF form" (today's
   `NewDocumentModal`) and "Release of lien". The second asks for the project
   (preselected inside a project, including the §12 project Documents tab)
   and the variant, then creates the release by hand and opens its editor.
   Admin only, like all billing.
5. **Conditional release → "Make unconditional"** (§6.4).

### 6.2 Editor (`LienReleaseEditor.tsx`, a `Modal` like `ChangeOrderEditor`)

- Two segmented switches at the top: Progress / Final and Conditional /
  Unconditional. Switching recomputes nothing already typed. Switching
  between conditional and unconditional only shows or hides the condition
  fields; a changed variant marks the PDF out of date.
- Fields from §5.3, in the order they appear on the form. Hints in plain
  words:
  - Through date: "Work up to this date. Retainage is never covered by a
    progress release."
  - Exceptions: "Optional. Adding exceptions changes the statutory form; your
    customer may ask for the standard form."
- Condition box (conditional only): "Paid by check?" with check number,
  drawn by, bank. Empty check number means the funds wording.
- "Sign with my signature" checkbox. Shown only when the user has a saved
  signature (`listSignatures`, `src/utils/store.ts:986-992`); off by default
  on every new release. When on, the default signature is used and its file
  id is stored in `signatureFileId`.
- Live preview of the wording (from `lienReleaseParagraphs`) under the fields.
- Footer: `DocumentActionsBar` with `source={{ sourceType: 'lien-release',
  sourceId }}`, `kind="lien-release"`, `format="pdf"`; Close; Save. The send
  composer prefill uses the same billing email defaults as invoices.
- Status pill: Draft, Sent, Void. "Void" and "Make unconditional" sit next to
  it.

### 6.3 Unconditional safety warning

An unconditional release gives up lien rights the moment it is delivered.

- Always shown on unconditional releases: "An unconditional release takes
  effect when you sign and deliver it, paid or not. Send it only after the
  payment has cleared."
- When the release is linked to a pay app or invoice and the payments
  recorded there total less than the release amount, or when it is started by
  hand, Generate and Send first show a confirm dialog (the existing
  `useConfirm`): "No payment covering $X is recorded for Pay App #N. Send an
  unconditional release anyway?" Cancel stops; nothing is generated.

### 6.4 Make unconditional

On a conditional release, "Make unconditional" creates a new release with
the same values, `conditional=0`, `supersedesId` = the conditional one, a new
number and today's release date. When the conditional one is linked to a pay
app or invoice, the amount is refreshed to the payments received. The new
release opens in the editor. The conditional one is left as it is.

### 6.5 Status, send, delete

- Created as `draft`. Sending through the item send route sets `sent`.
- Editing a sent release is allowed. Every regeneration is a new version of
  the same document, so the version that was sent stays in its history.
- Deleting is allowed only for drafts. A sent release can be marked `void`
  (kept, greyed in the list, its document kept), so the record of what was
  waived survives.
- Permissions: admin only, like change orders and invoices
  (`server/routes.ts:323-345`).

### 6.6 Documents and email

- New document kind `lien-release`, label "Lien Release", tone `emerald`, in
  `src/pages/documents/docTypes.ts` and the server's kind list
  (`server/documents.ts`). It is a generated kind owned by its record, so it
  cannot be deleted from Documents directly (like `change-order`).
- File name: `LR-{n} {Conditional|Unconditional} {Progress|Final} Release.pdf`.
- Mail: new `ItemType` `lienRelease` in `server/mail/links.ts` (`ITEM_TABLE`
  → `lien_releases`, plus its type fallback label) and
  `src/pages/mail/types.ts`; `itemTypeFromSource('lien-release')` returns
  `lienRelease` (`MailComposer.tsx:77-94`).
- Send route `POST /api/lien-releases/:id/send`, built like the change
  order's (`server/routes.ts:2204-2216`). Default subject
  `{Conditional }Waiver and Release of Lien upon {Progress|Final} Payment —
  {projectName}`, default body: "Please find attached our {conditional }
  waiver and release of lien for {projectName}." The route marks the release
  `sent` once the provider accepts the message.
- The project data guard (4.1.10) counts `lien_releases` like change orders
  (`server/projectStore.ts:362`), and `deleteProject` deletes them
  (`:430-431`). Storage cleanup's `FILE_ID_COLUMNS` (`server/routes.ts`)
  lists `lien_releases.signatureFileId`.
- Realtime: create, save, status and delete broadcast on the project feed
  like change orders.

### 6.7 Server API

| Method and path | Purpose |
|---|---|
| GET `/api/projects/:id/lien-releases` | list |
| GET `/api/projects/:id/lien-releases/prefill` | defaults (§5.3) |
| POST `/api/projects/:id/lien-releases` | create (body: the fields; number assigned) |
| GET `/api/lien-releases/:id` | one release |
| PUT `/api/lien-releases/:id` | save with `version` (409 on conflict) |
| PATCH `/api/lien-releases/:id/status` | `void` (or back to `draft` from void) |
| POST `/api/lien-releases/:id/unconditional` | make unconditional (§6.4) |
| DELETE `/api/lien-releases/:id` | drafts only |
| POST `/api/lien-releases/:id/send` | item send |

Store: `server/lienReleaseStore.ts` (with `ValidationError`, `ConflictError`,
`NotFoundError`); routes: `server/lienReleaseRoutes.ts`, registered in
`server.ts`. Client helpers in `src/utils/store.ts`.

## 7. Uncertainties (for the owner, and the attorney if asked)

- **U1. Conditioning on electronic payment.** 713.20(7) speaks only of
  checks. The funds wording (§4.3) relies on (3) and (8). It is enforced as
  written, but no statute or case we found says so for ACH or wire. SB 658
  (2025) would have made it explicit and died.
- **U2. Can the customer refuse a conditional version?** (6) bars requiring a
  *different* form. Nothing bars a customer from asking for the statutory
  (unconditional) form before paying. In practice many general contractors
  do. The app supports both; the choice is the company's on each job.
- **U3. "Substantially similar."** Adding a condition or exceptions probably
  makes a release "not substantially similar". Under (8) it is then enforced
  by its own terms, which is the intent. A customer may still reject it.
- **U4. Bond rights.** On public or bonded jobs the statutory form releases
  "its lien and right to claim a lien". Whether that also releases payment
  bond claims is not addressed in 713.20. Out of scope; an attorney question.
- **U5. Lienor's legal name.** The release should name the legal entity that
  holds the lien rights. The company name setting may be a trade name. The
  editor lets the user change it per release.
- **U6. Final release amount.** "The final payment in the amount of" is the
  last payment, not the contract sum. The defaults (§5.3) use the source's
  due or received amount; the user confirms it.
- **U7. Future law.** No 2026 or 2027 bills cite 713.20 today. The wording is
  in one module (§5.5) so a change is quick.

## 8. Choices made in this design (owner decisions of T22 override the draft)

Approved by the owner in chat (T22), 2026-10-15:

- Wording (§4.1-4.4) approved as written, conditional paragraphs included. It
  prints exactly as in §4.
- **Notary: always printed.** Every release ends with a notary acknowledgment
  block, because all of the owner's customers expect notarized releases. This
  replaces the draft's "no notary block" (and §2.2 point 6 and §4.5's last
  bullet no longer apply to what ships). The block is Florida's Statutory Short
  Form of Acknowledgment, Fla. Stat. 695.25, for a person signing for a company
  (forms (2) and (3)), with the "physical presence or online notarization"
  choice. The signer's name and title and the company name are filled in. The
  notary's fields stay blank: state, county, date, identification, the
  company's state and entity type, and the signature, name, title or rank and
  serial number lines. The text lives in `lienReleaseWording.ts`
  (`lienReleaseNotary`). If it pushes the form past one page, page 2 repeats
  the letterhead; the block is never split across pages.
- Entry points: pay app editor, invoice editor, Billing -> Lien Releases tab and
  Documents -> New (§6.1), **plus** "Unconditional release for this payment" on a
  recorded payment in Billing -> Payments. It is prefilled from that payment:
  amount = the payment amount; through date = the linked pay app's period end or
  invoice date, else the payment date; linked to the payment's pay app or
  invoice when it has one. The unconditional safety warning (§6.3) does not
  fire there, since the payment is recorded. Server:
  `GET /api/projects/:id/lien-releases/prefill?paymentId=`.
  This replaces the draft's "Payments get no direct entry point".
- After sending, a release stays editable and every regeneration is a new
  version of the same document (§6.5); a sent release can be voided, never
  deleted.
- Releases are stored records with per-project numbers `LR-n` (§5.1).
- Unconditional variants print the statutory text verbatim; conditional ones add
  a CONDITIONAL title prefix and one condition paragraph (§4.3).
- "Sign with my signature" exists but is off by default on every release, and
  "Make unconditional" never copies the stamp over.
- The optional Exceptions field ships, empty by default, with the hint that the
  customer may reject a non-standard form.
- The company name setting is the default lienor name, editable on each release.

Built in T23 (server and PDF): migration 49 `lien_releases`,
`server/lienReleaseStore.ts` and `server/lienReleaseRoutes.ts` (registered from
`registerDataRoutes`, next to the proposal routes), `POST
/api/lien-releases/:id/send` in `registerEmailRoutes`, and
`src/pages/project/billing/lienReleaseWording.ts` and `lienReleasePdf.ts`. T24
builds the client.

## 9. Build split and tests

**T23, server:** migration; `lienReleaseStore.ts` (CRUD, numbering,
validation §5.4, prefill §5.3, make-unconditional, void); `lienReleaseRoutes.ts`;
send route; `ItemType` `lienRelease`; document kind; project delete and
archive guard; storage cleanup columns; realtime. Tests: store
(numbering, validation incl. through date after release date, prefill from a
pay app with and without payments and from an invoice, make-unconditional,
delete refused when sent), routes (admin only, 409 on stale version), links
(`resolveChain` for `lienRelease`).

**T24, client:** `lienReleaseWording.ts` (+ test pinning §4.1 and §4.2
verbatim and the condition paragraphs for check and funds);
`lienReleasePdf.ts` (`buildLienReleasePdf`, letterhead, signature image,
wrapping; smoke test like `changeOrderPdf.test.ts`); `LienReleaseEditor.tsx`
(variant switches, fields, preview, warning and confirm §6.3, document bar);
`LienReleasesSection.tsx` (Billing tab); entry buttons in
`AiaPayAppEditor.tsx` and `InvoiceEditor.tsx`; Documents → New menu; doc
type and `itemTypeFromSource`; store helpers. Tests: editor (switching
variants shows/hides condition fields, confirm on unconditional without
payment, validation messages), section list, entry menus.

Verify: `npx vitest run server/lienReleaseStore.test.ts
src/pages/project/billing/lienReleaseWording.test.ts
src/pages/project/billing/lienReleasePdf.test.ts
src/pages/project/billing/LienReleaseEditor.test.tsx` and `npm run lint`.

## 10. Sources

- Fla. Stat. § 713.20 (2026), Florida Legislature:
  http://www.leg.state.fl.us/statutes/index.cfm?App_mode=Display_Statute&URL=0700-0799/0713/Sections/0713.20.html
- Fla. Stat. § 713.20 (2026), Florida Senate:
  https://www.flsenate.gov/Laws/Statutes/2026/713.20
- Fla. Stat. § 713.01 (definition of "lienor") and § 713.06(3)(d)
  (contractor's final payment affidavit), 2026, leg.state.fl.us, ch. 713.
- CS/SB 658 (2025), Waiver or Release of Liens, history and text c1:
  https://www.flsenate.gov/Session/Bill/2025/658
- SB 908 (2024): https://www.flsenate.gov/Session/Bill/2024/908
- Bills citing 713.20, 2026 and 2027 sessions (0 found):
  https://www.flsenate.gov/Session/Bills?sessionYear=2026&citation=713.20&citationType=FL+Statutes
- Levelset, "Florida Lien Waiver FAQs" (no notary requirement; statutory forms
  are unconditional; conditioning on a check under (7)):
  https://levelset.com/lien-waivers/florida-lien-waiver-faqs
- C. Distel, McDonald Hopkins, "Understanding waivers and releases for
  Florida construction contractors", 2018-12-20:
  https://www.mcdonaldhopkins.com/insights/news/Understanding-waivers-and-releases-for-Florida-con
