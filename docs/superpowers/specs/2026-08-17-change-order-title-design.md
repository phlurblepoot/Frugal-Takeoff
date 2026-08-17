# Change Order Title Field — Design

Date: 2026-08-17
Status: Approved by Nathan (conversation)

## Decisions

- `change_orders` gains `title TEXT` (migration 24, additive; PRAGMA-guarded).
- ChangeOrderEditor gains a Title input (alongside number/status; saved via
  the existing CO save path, which must accept/persist the field).
- `syncChangeOrders` (server/aiaStore.ts:136) writes the SOV line
  description as `title, falling back to description, else ''` — for NEWLY
  added lines only (existing SOV lines untouched).
- ChangeOrdersSection tab columns become Number · Title · Status · Amount ·
  Date; blank title renders "—".
- CO PDF, emails, rollups unchanged. Blank titles everywhere fall back as
  above.

## Tests

- Migration 24 presence/idempotency (file's pattern).
- syncChangeOrders: titled CO → line description = title; untitled → falls
  back to description; existing line untouched on re-sync.
- CO save round-trips title (store test per existing billingStore CO tests).
- E2E: only if an existing spec covers the CO tab (check; else unit-level
  suffices — this is a small display/data change).
