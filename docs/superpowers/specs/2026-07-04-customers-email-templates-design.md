# Customers as First-Class Entities + Email Template Routing — Design Spec

**Date:** 2026-07-04
**Status:** Approved (pending final user review of this document)

## Goal

Turn the free-text `project.contractor` field into a first-class **Customer**
entity that owns projects and carries contact info + department (role) emails.
Use those role emails to auto-fill template recipients, add a per-user always-CC
list, and let the sender choose which contact email appears on the generated
document's letterhead — all while mail continues to send through the sending
user's own SMTP account.

## Terminology

There is ONE entity type: **Customer**. It represents whoever a project is for —
a general contractor, a GC, or a direct owner; they are all "customers." There
is no separate "owner" concept (the project owner is not used).

## Decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| Entity | Single `Customer` entity; customers own projects |
| Role emails | Fixed slots: General, Accounting, Estimating, Project Management |
| Role emails location | On BOTH the Customer and the Project (project overrides customer) |
| Merge | Combine duplicate customers (move projects, fill blanks, delete source) |
| Template → role mapping | proposal → Estimating; invoice + change order → Accounting; issue + punch → Project Management; fallback → General |
| Sender | Always sends via the user's own SMTP. A send-screen dropdown only changes which contact email is printed on the document letterhead (user's address vs company default). No shared SMTP. |
| Company default email | The existing admin `companyEmail` setting |
| Always-CC | Per-user, in each user's Email settings; auto-filled into CC on template sends |
| Blank-contractor projects | Assigned to an "Unassigned" placeholder customer so they stay reachable |
| Migration | Migration 16, data-transforming, SUPERVISED, non-destructive |

---

## Phase A — Customer entity

### A1. Data model

**New `customers` table** (SQLite):
- `id` TEXT PRIMARY KEY
- `name` TEXT NOT NULL
- `phone` TEXT
- `address` TEXT
- `contactName` TEXT
- `notes` TEXT
- `generalEmail` TEXT
- `accountingEmail` TEXT
- `estimatingEmail` TEXT
- `pmEmail` TEXT
- `createdAt` INTEGER
- `updatedAt` INTEGER
- `attrs` TEXT (JSON, round-trips unknown fields — mirrors the other stores)

**`Customer` type** (`src/types.ts`):
```ts
export interface CustomerRoleEmails {
  general?: string;
  accounting?: string;
  estimating?: string;
  pm?: string;
}
export interface Customer {
  id: string;
  name: string;
  phone?: string;
  address?: string;
  contactName?: string;
  notes?: string;
  emails: CustomerRoleEmails;
  createdAt?: number;
  updatedAt?: number;
}
```

**Project link:**
- Add `projects.customerId` TEXT column (indexed).
- Keep `projects.contractor` as a denormalized display fallback (not removed).
- `Project` type gains `customerId?: string` and `contactEmails?: CustomerRoleEmails`
  (the optional project-level overrides). `contactEmails` rides in the project's
  JSON round-trip (no per-field schema column).

**Recipient resolution (pure function, `src/utils/recipients.ts`):**
```ts
export type TemplateType = 'proposal' | 'invoice' | 'changeOrder' | 'issue' | 'punch';
export function roleForTemplate(t: TemplateType): keyof CustomerRoleEmails; // mapping above
export function resolveRecipient(
  t: TemplateType,
  projectEmails: CustomerRoleEmails | undefined,
  customerEmails: CustomerRoleEmails | undefined,
): string; // project[role] || customer[role] || project.general || customer.general || ''
```

### A2. Server store + routes

- `server/customerStore.ts`: `listCustomers`, `getCustomer`, `saveCustomer`
  (create/update), `deleteCustomer`, `mergeCustomers(targetId, sourceIds[])`,
  `listProjectsForCustomer(id)`. Decompose/load mirrors `projectStore` (columns +
  `attrs` for the emails object and unknown fields).
- `mergeCustomers`: in a transaction — reassign every source customer's projects
  to the target (`UPDATE projects SET customerId = target WHERE customerId IN
  sources`), fill any blank target field/role-email from the first source that
  has it, then delete the source customers.
- Routes (`server/routes.ts`, `authenticateToken`):
  - `GET /api/customers`, `GET /api/customers/:id`, `POST /api/customers`,
    `PUT /api/customers/:id`, `DELETE /api/customers/:id`
  - `POST /api/customers/merge` `{ targetId, sourceIds }`
  - `GET /api/customers/:id/projects`
- Deleting a customer that still owns projects is blocked (409) with a message to
  reassign or merge first; the "Unassigned" customer cannot be deleted.

### A3. Migration 16 — `customers-from-contractor` (SUPERVISED)

Per database, in a transaction (after the standard pre-migration backup):
1. Create the `customers` table + `projects.customerId` column + index.
2. Ensure a single **"Unassigned"** customer (well-known id, e.g.
   `customer-unassigned`).
3. Group existing projects by normalized `contractor` (trim + lowercase):
   - Non-empty group → create one Customer (`name` = the original-cased string
     from the first project in the group; emails blank), set each project's
     `customerId`.
   - Empty/blank `contractor` → set `customerId` = the Unassigned customer.
4. Leave `projects.contractor` untouched (non-destructive).

`verify-migration` LATEST_SCHEMA_VERSION auto-tracks (Math.max). Fixtures assert:
dedup by normalized name, every project linked (no null `customerId`), blanks →
Unassigned, `contractor` preserved. ⚠️ SUPERVISED — safe on testing (auto-backup),
flag before any production pull.

### A4. Customer management UI

- **New "Customers" section** (nav + route): searchable list (name, contact,
  project count), create/edit form (all fields + 4 role emails), and per-customer
  view listing its projects (link through to each project).
- **Merge:** from the customer list/detail, "Merge into…" picks a target;
  confirm dialog shows which projects move and which fields fill. Calls
  `/api/customers/merge`.
- **Project create (`NewProject`) + Project Settings:** replace the contractor
  text input with a **Customer picker** (typeahead over existing customers +
  "＋ New customer" inline create). Add an optional "Project-specific contacts"
  panel exposing the 4 role-email overrides (`project.contactEmails`).
- Project displays that showed `contractor` now show the linked customer's name
  (falling back to the stored string if somehow unlinked).

---

## Phase B — Email integration (depends on Phase A)

### B1. Per-user Always-CC

- Stored in user preferences (`emailAlwaysCc` string; comma/semicolon list),
  alongside the existing per-user SMTP keys. Excluded from the general prefs blob
  the same way `smtp.*` is, or namespaced consistently.
- Email settings tab gains an **"Always CC"** field with help text
  ("these addresses are added to CC on every template you send").

### B2. Recipient + CC auto-fill

Each of the five send sites (invoice, change order, issue, punch, proposal),
when opening the `EmailComposer`:
- `defaultTo` = `resolveRecipient(templateType, project.contactEmails, customer.emails)`.
- `defaultCc` = the user's `emailAlwaysCc` (merged with any existing
  template-specific CC, de-duplicated).

### B3. Header-email "From" dropdown

- `EmailComposer` gains a **From / header email** selector with two options:
  - **My email** — the user's SMTP `fromAddress` (from their SMTP settings).
  - **Company default** — the admin `companyEmail` setting.
- The selection sets which contact email is printed in the generated document's
  **letterhead** (`LetterheadContext.company.email`). Default = company email
  (current behavior).
- **Mail always sends via the user's own SMTP** (`sendProjectEmail` unchanged on
  the envelope side). The dropdown does NOT change the SMTP From/auth.

### B4. Generator + send wiring

- The five generators already accept a `LetterheadContext` whose `company.email`
  comes from `settings.companyEmail`. Add an optional `headerEmail` override
  passed through when generating; when the user picks "My email", the send flow
  **regenerates the PDF** with `company.email = user.fromAddress` before
  attaching, then sends.
- `EmailComposer` `onSend` payload already carries `to/cc/bcc/subject/body/
  attachmentFileIds`; add the header-email choice so the caller regenerates the
  primary attachment accordingly.

---

## Data Flow

```
Project ──customerId──▶ Customer{ emails: {general,accounting,estimating,pm} }
   │  contactEmails? (project-level overrides)
   ▼
Send a template (type)
   defaultTo = resolveRecipient(type, project.contactEmails, customer.emails)
   defaultCc = user.emailAlwaysCc
   headerEmail = dropdown(My=user.fromAddress | Company=companyEmail)
   ▼
regenerate PDF with letterhead company.email = headerEmail
   ▼
sendProjectEmail(user's SMTP)  → from = user's SMTP address (always)
```

## Error Handling

- Deleting a customer with projects → 409 (reassign/merge first); Unassigned is
  undeletable.
- Merge is transactional; a failure rolls back (no half-moved projects).
- Missing role email → resolution falls back through project→customer→general;
  if all blank, `defaultTo` is empty and the user types it (no send blocked).
- Header-email regeneration failure → fall back to the already-generated PDF and
  surface a non-blocking warning.

## Testing

- **Customer store:** CRUD, `mergeCustomers` (projects reassigned, blanks filled,
  sources deleted, transactional), delete-blocked-with-projects.
- **Migration 16:** dedup by normalized name; all projects linked; blanks →
  Unassigned; `contractor` preserved; idempotent re-run safe.
- **`resolveRecipient` / `roleForTemplate`:** pure unit tests for the mapping and
  the project→customer→general fallback order.
- **Always-CC merge:** de-dup + merge with template CC.
- **Header-email override:** the generator receives the chosen email in
  `company.email`.
- Client: customer picker create/select, merge dialog, composer `defaultTo`/
  `defaultCc`/From-dropdown behavior.

## Phasing

- **Phase A — Customer entity:** model + migration 16 + store/routes + CRUD/merge
  UI + project↔customer linking. Ships independently (projects gain customers;
  email still uses today's defaults).
- **Phase B — Email integration:** role-based To, per-user always-CC, header-email
  From dropdown, wired into all five send sites + generators. Depends on A.

## Out of Scope

- Shared/company SMTP sending (explicitly rejected — mail always sends as the
  user).
- A separate project "owner" concept (folded into Customer).
- Bulk customer import.
