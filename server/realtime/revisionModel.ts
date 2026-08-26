import type Database from 'better-sqlite3';

// Server-side port of the plan-set revision model in src/utils/planSets.ts
// (computeRevisionModel / effectiveSheetId). Lets measurement-mutating ops be
// rejected against a superseded (read-only history) page without loading the
// whole project through the client model.

// Row-level inputs deliberately mirror what a cheap query returns.
export interface PageRow {
  id: string;
  planSetId: string | null;
  pageNumber: string | null;
  attrs: string | null;
}

const normalizePageNumber = (pageNumber: string | null | undefined): string | null => {
  const n = pageNumber?.trim().toLowerCase();
  return n ? n : null;
};

// Durable logical-sheet identity, ported from planSets.ts effectiveSheetId.
// Prefers the explicit sheetId (migration 15 backfill, carried in the page's
// attrs JSON); falls back to a stable key derived from the normalized page
// number; falls back further to the page's own id. Never returns an empty
// key — every page belongs to exactly one logical sheet.
export function effectiveSheetIdFromRow(row: PageRow): string {
  if (row.attrs) {
    try {
      const parsed = JSON.parse(row.attrs);
      if (parsed && typeof parsed === 'object' && typeof parsed.sheetId === 'string' && parsed.sheetId) {
        return parsed.sheetId;
      }
    } catch {
      // malformed attrs JSON — fall through to the pageNumber/id fallback
    }
  }
  const normNum = normalizePageNumber(row.pageNumber);
  return normNum ? 'pn:' + normNum : 'id:' + row.id;
}

// A page is superseded when its logical sheet has more than one revision and
// this page is not the latest. "Latest" mirrors computeRevisionModel: pages
// are grouped by effectiveSheetId, then ordered by their plan set's rank
// (oldest -> newest; a page with no plan set, or one whose plan set can't be
// found, ranks as -1, i.e. oldest) with ties broken by the pages' own query
// order — querying with `ORDER BY sortOrder` mirrors the order the client's
// project.pages array is loaded in (see loadProject), so a stable JS sort on
// top reproduces the client's tie-break exactly. The last page in that
// ordering is the current/living revision; every earlier one is superseded.
export function isPageSuperseded(db: Database.Database, projectId: string, pageId: string): boolean {
  const planSetRows = db
    .prepare('SELECT id FROM plan_sets WHERE projectId = ? ORDER BY sortOrder')
    .all(projectId) as { id: string }[];
  const rankByPlanSetId = new Map<string, number>();
  planSetRows.forEach((ps, i) => rankByPlanSetId.set(ps.id, i));

  const pageRows = db
    .prepare('SELECT id, planSetId, pageNumber, attrs FROM pages WHERE projectId = ? ORDER BY sortOrder')
    .all(projectId) as PageRow[];

  const target = pageRows.find(r => r.id === pageId);
  if (!target) return false;

  const setOrder = (row: PageRow): number => (row.planSetId ? rankByPlanSetId.get(row.planSetId) ?? -1 : -1);

  const key = effectiveSheetIdFromRow(target);
  const revisions = pageRows.filter(r => effectiveSheetIdFromRow(r) === key);
  if (revisions.length <= 1) return false;

  const sorted = [...revisions].sort((a, b) => setOrder(a) - setOrder(b));
  const latestId = sorted[sorted.length - 1].id;
  return latestId !== pageId;
}
