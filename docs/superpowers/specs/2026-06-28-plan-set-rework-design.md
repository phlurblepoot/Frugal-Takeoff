# Plan Set Rework — Design Spec

**Date:** 2026-06-28
**Status:** Approved (brainstorm) — ready for implementation planning

## Problem

The plan-set / revision feature does not behave correctly:

1. **Duplicated measurements.** Adding a new set carries measurements forward by *copying* them onto the new revision's page while leaving editable copies on the old page — two editable copies of the same takeoff.
2. **Totals/printouts only see the latest revision.** Takeoff totals, printouts, and the proposal filter to the "current" revision's page, so measurements on other revisions are invisible/uncounted. (A consequence of #1's model.)
3. **Duplicate page numbers allowed within a set.** Nothing prevents two pages in the same plan set from sharing a page number; identity is now meant to be the page number, so this corrupts revision matching.
4. **Unreliable Extract.** The "extract page number/description" feature reads only the raw PDF text layer and falls back to OCR only when the layer is empty; the raw read is often wrong or grabs the wrong item.
5. **Plan-set UX is thin** both under the hood and in the UI relative to how estimating tools (Bluebeam, PlanSwift, STACK) handle plan sets and revisions.

## Goals

- One **living, editable measurement set per logical sheet**, shared conceptually across revisions; superseded revisions are **read-only history**.
- Totals, printouts, and the proposal all consume the **same** current set, consistently.
- A durable **sheet identity** that survives page-number renames and powers reliable revision matching.
- **Block duplicate page numbers within a set**, with a suffix escape hatch and migration.
- A **hybrid Extract** (raw text + OCR fuzzy match) used by both the manual tool and import auto-detection.
- Industry-standard plan-set UX: add-set revision review, current/superseded treatment, per-sheet revision switcher, deliberate read-only history, read-only canvas for old revisions, and an enlarged compare.

## Non-goals

- A full per-keystroke audit log of measurement edits (history is **per-revision snapshots**, not edit history).
- Storing measurements in a brand-new normalized "sheets" table (rejected Approach B — too large/risky a data move). We keep measurements on pages (Approach C).
- Changing the AIA / billing / letterhead systems.

## Chosen approach — C: pages keep measurements + a durable sheet identity

### Sheet identity
- Add a durable **`sheetId`** to every page (`ProjectPage`). All revisions of one sheet share a `sheetId`.
- A **logical sheet** = the set of pages sharing a `sheetId`, ordered oldest→newest by plan-set order. The newest is the **current revision**.
- `sheetId` is assigned/confirmed in the add-set review step (below) — not inferred from the page-number string at query time. Renaming a page number therefore never loses measurements or breaks matching.

### Where measurements live
- The **current revision's page holds the one living, editable measurement set + scale** for the sheet.
- **Superseded revisions** (older pages of the sheet) keep their measurements, but those are **frozen: read-only and never counted** toward totals/printouts/proposal. They are the history.

### Revision lifecycle (the core fix)
- When an incoming page is declared a **revision of an existing sheet** (reusing its `sheetId`):
  - The sheet's current living measurements **+ scale are automatically copied onto the new revision's page**, which becomes the current/living set. **The new revision is never empty.**
  - The previously-current page becomes **superseded/frozen (read-only)**.
  - There is never more than one editable copy; older copies are frozen history.
  - The user adjusts the copied measurements on the new revision only if the drawing changed.
- When an incoming page is a **new sheet**, it gets a fresh `sheetId` and starts empty.

### One consistent consumer model
- `computeRevisionModel` keys off `sheetId`. For each sheet it selects the current revision (newest, honoring the as-of selector) and exposes `currentPageIds`.
- **Totals (Pages/Takeoffs tab), printouts, and the Proposal all use the same `currentPageIds`** — fixing today's Pages-tab-vs-Proposal-tab inconsistency.
- **As-of selector:** default = latest = the living set. Selecting an older plan set shows that revision's **frozen snapshot** (read-only) with matching historical totals — the same mechanism powers both the current view and read-only history.

## Duplicate page numbers (#3)
- Uniqueness enforced **within a single plan set**. The same page number **across** sets is a revision (allowed). Blank/absent page numbers are exempt (multiple unnumbered sheets allowed).
- Enforced in two places: the **add-set review** and **manual rename**. A collision blocks save with an inline error and a one-click **Suffix** action (`A-101` → `A-101 (2)`, then `(3)`…).
- The suffix scheme is also the **automatic migration fix** for pre-existing within-set duplicates.

## Extract — raw-text + OCR hybrid (#4)
A pure function over a selected region:
1. Collect the **raw PDF text-layer items** overlapping the region (accurate characters; may grab the wrong/extra item or miss vector-drawn text).
2. **OCR the rendered region image** (approximate but reads what's visible).
3. If raw candidates exist, return the candidate **most similar to the OCR string** (normalized edit-distance / closest match) — clean characters, disambiguated by OCR.
4. If no raw candidate (or none is a decent match), fall back to the **cleaned OCR result** — so image-only/vector-label sheets still work.
- A **confidence signal** derives from this: high when raw↔OCR agree strongly; "needs review" when OCR-only, weak match, or nothing found.
- Applied to **both** the manual Extract tool **and** import auto-detection.

## UI

### Add-set "Revision Review" step
- After dropping PDFs into a new set, each incoming page is auto-matched by page number and shown in a review list before anything commits.
- Per row: **editable page number + description** (with the hybrid **Extract** available per row) and a **match dropdown** — *Revision of {sheet}*, *New sheet*, or *Unchanged / skip*. Editing a page number re-runs the duplicate check and the match.
- Auto-detected names are **suggestions, never truth**: low-confidence rows are **amber-flagged "needs review."** The **Commit** button surfaces how many rows still need review and is a **soft nudge** (you may still commit) — it never silently trusts a bad auto-name. Within-set duplicates **hard-block** Commit until resolved.

### Sheets grid
- Each sheet shows a **Current · Rev N** badge. Sheets with one revision show "No revisions."
- **Superseded revisions are hidden by default**; a **"Show superseded"** toggle reveals them dimmed with a read-only badge.
- A per-sheet **`Rev N ▾`** control opens the sheet's **revision list**: current highlighted with its measurement count; older revisions offer **"View (read-only)"** and a **Compare** action.

### Read-only canvas + history
- Opening an older revision shows a **read-only banner** ("Viewing Rev 1 — read-only history") with a "Go to current" button; the frozen measurements cannot be edited.
- History is **deliberately accessed** (via the revision list) and never gets in the way of normal editing.

### Compare (#5 enhancement)
- The existing overlay/compare moves from a small modal to an **enlarged full canvas** with pan/zoom and an opacity control between two revisions.

### Terminology
- Present these consistently as **Sheets** with **Revisions** (industry-standard language).

## Migration (versioned, supervised)
A new versioned migration — **non-destructive** (no measurements deleted), flagged to the owner before running on real data:
1. Add a durable **`sheetId`** to every page; **backfill** by grouping pages across plan sets by page number into logical sheets. Unnumbered pages each become their own sheet.
2. **Suffix** any within-set duplicate page numbers so they become distinct, valid sheets (with distinct `sheetId`s).
3. Per sheet, establish the invariant **current = newest revision = the living set**: take the measurements from the **newest revision that has measurements** and ensure they live on the **current (newest) revision** — i.e. if the newest revision is empty (from today's skip-carry-forward bug), copy the most-recent non-empty set forward onto it. All other revisions' measurements are retained but become **read-only history**.
4. Result: every project satisfies the new model — one living set on the current revision of each sheet, the rest read-only history, totals reconcile.

## Testing
- **Unit:** `sheetId`-based `computeRevisionModel` (current selection + as-of); revision add (auto copy-forward, single living set, prior frozen); duplicate validation + suffixing; the Extract fuzzy-matcher (pure function); migration backfill against fixtures carrying today's duplicated-measurements bug → one living set + frozen rest, totals reconcile; the proposal/totals/printout consumers all read the same current set.
- **E2E:** add-set review flow (match/confirm/duplicate-block/commit); opening a superseded revision is read-only; totals update correctly after adding a revision.

## Data-model summary
- `ProjectPage` gains a durable **`sheetId`** (the only new stored field; backfilled by migration). **Current vs superseded is derived**, not stored: the newest revision of a sheet (by plan-set order, honoring the as-of selector) is current/living; all older revisions are read-only history. No separate frozen flag.
- Measurements remain on pages (no mass move). `Measurement.planSetId` stays as informational metadata.
- `PlanSet` unchanged.

## Decided defaults
- Migration: newest revision with measurements becomes the living set.
- Duplicates: block within a set; suffix as the manual escape hatch and the migration fix.
- Extract hybrid applies to both the manual tool and import auto-detection.
- Add-set Commit: soft nudge on "needs review" rows; hard block only on unresolved duplicates.
- History granularity: per-revision read-only snapshots (no edit-level audit log).
