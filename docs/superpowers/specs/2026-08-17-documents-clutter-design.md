# Documents Clutter Exclusions + Admin Unassigned View — Design

Date: 2026-08-17
Status: Approved by Nathan (conversation)

## Problem

The Documents page shows page-asset thumbnails (uploaded after migration 23,
or stale rasters with no page reference for the migration to find) and
legacy "unassigned" rows (no project, no name — system leftovers).

## Decisions (agreed with Nathan)

1. **Page assets can never appear:** (a) new page raster/thumbnail uploads
   are attributed `kind='plan'` at upload time; (b) `GET /api/documents`
   additionally excludes any file referenced by `pages.imageId` or
   `pages.thumbnailId` (live NOT-EXISTS check — label-independent,
   self-healing).
2. **Unassigned rows hidden by default:** rows with `projectId IS NULL AND
   name IS NULL` are excluded from all normal views.
3. **Admin-only "Unassigned" view:** a filter-bar toggle (visible to admins
   only, like the Billing-kind gating) that shows ONLY those hidden
   unassigned rows (exclusive view, same semantics as the Archived toggle).
   Non-admin requests with the param get the normal view (param ignored).
4. Plan-set source PDFs stay visible as today (incl. superseded revisions).
5. Suggest Nathan run the admin Storage orphan cleanup once after this lands
   to reclaim true orphans.

## Implementation

- Server (`server/documents.ts` + routes): `unassigned=1` param (admin
  only); default WHERE gains `NOT (projectId IS NULL AND name IS NULL)` and
  `NOT EXISTS (SELECT 1 FROM pages WHERE imageId = f.id OR thumbnailId =
  f.id)`; unassigned view inverts the first exclusion and shows only those
  rows (page-asset exclusion still applies).
- Upload path: `POST /api/images` accepts optional `kind` + `projectId`
  query params → threaded to `putDataUrl`; client `saveImage(id, dataUrl,
  opts?)` passes `{ kind: 'plan', projectId }` at the page-asset call sites
  (ProjectView + NewProject rasters/thumbnails). Other saveImage callers
  unchanged.
- Client: "Unassigned" toggle in DocumentsFilterBar next to Archived,
  rendered only for admins (same isAdmin() check as elsewhere); exclusive
  with Archived (checking one unchecks the other); URL param `unassigned=1`.
- Tests: server filter matrix additions (default excludes both classes;
  unassigned view shows only unassigned; non-admin param ignored;
  page-referenced file hidden regardless of kind); e2e: toggle
  admin-visible/non-admin-absent; a seeded page-asset image absent by
  default.
