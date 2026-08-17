# Documents Row Context Menu — Design

Date: 2026-08-17
Status: Approved by Nathan (conversation)

## Problem

The Documents table's per-row action buttons (archive/delete/change-type) sit
where they're too easy to hit accidentally.

## Decisions (agreed with Nathan)

- The row actions column keeps ONLY the version-history toggle, and only for
  rows with `versionNumber > 1`.
- Right-click on a row opens a context menu with the policy-gated actions
  formerly in the column: Open in editor, Download, Archive (Restore in the archived
  view), Change type (direct-upload kinds only, submenu or nested list),
  Delete (deletable rows only, same confirm). Unqualified items are absent,
  not disabled.
- Touch: long-press on the row opens the same menu (app's established mobile
  idiom); the browser's native context menu is suppressed on rows.
- Bulk bar unchanged; the context menu acts only on the right-clicked row.
- Left-click still opens the file.

## Implementation notes

- Menu: small fixed-position popover at the pointer (clamped to viewport),
  closes on click-outside/Escape/scroll/action; one open menu at a time.
  Reuse an existing menu idiom if one fits (check the app's dropdown/menu
  components); otherwise a small local component in
  `src/pages/documents/`.
- selectionPolicy/documentsPolicy stays the single source of the gating.
- E2E: extend `e2e/documents.spec.ts` — context menu shows delete for a
  direct upload and NOT for a sourced row; delete-via-menu works; version
  button hidden on single-version rows (all seeded rows are v1 → assert
  absence; if cheap, create a v2 via re-generate to assert presence).

## Out of scope

- Multi-row context actions (bulk bar covers it).
