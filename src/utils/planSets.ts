import { Project, ProjectPage, PlanSet } from '../types';

// Normalized sheet identity. Pages with the same (trimmed, lower-cased) page
// number across different plan sets are treated as revisions of one sheet.
export const sheetKey = (page: ProjectPage): string | null => {
  const n = page.pageNumber?.trim().toLowerCase();
  return n ? n : null;
};

// Plan sets ordered oldest -> newest. Dates (ISO yyyy-mm-dd) sort
// lexicographically; createdAt breaks ties or fills in for undated sets.
export const comparePlanSets = (a: PlanSet, b: PlanSet): number => {
  if (a.date && b.date && a.date !== b.date) return a.date < b.date ? -1 : 1;
  return a.createdAt - b.createdAt;
};

export const orderedPlanSets = (project: Project | null): PlanSet[] =>
  [...(project?.planSets || [])].sort(comparePlanSets);

// The sets visible "as of" a selection: the chosen set plus every older one.
// With no selection, every set is allowed.
export const allowedPlanSets = (project: Project | null, selectedPlanSetId: string): PlanSet[] => {
  const all = project?.planSets || [];
  if (!selectedPlanSetId) return all;
  const selected = all.find(ps => ps.id === selectedPlanSetId);
  if (!selected) return all;
  return all.filter(ps => comparePlanSets(ps, selected) <= 0);
};

export type RevisionStatus = 'unique' | 'current' | 'superseded';

export interface RevisionModel {
  // Pages to show after as-of filtering + revision dedup (newest sheet wins).
  visiblePages: ProjectPage[];
  // Ids of the pages in visiblePages (the current revision for the selection).
  currentPageIds: Set<string>;
  // Every revision of each sheet across ALL sets, oldest -> newest.
  revisionsBySheet: Map<string, ProjectPage[]>;
  // 1-based revision number of a page within its sheet's full history.
  revisionNumberByPageId: Map<string, number>;
  // Globally newest page id for each sheet (ignores the as-of selection).
  latestPageIdBySheet: Map<string, string>;
  status: (pageId: string) => RevisionStatus;
}

const planSetIndex = (project: Project | null): Map<string, number> => {
  const idx = new Map<string, number>();
  orderedPlanSets(project).forEach((ps, i) => idx.set(ps.id, i));
  return idx;
};

// Single source of truth for plan-set revision behavior, shared by the pages
// grid, takeoff totals, the revision strip, and the compare view.
export const computeRevisionModel = (project: Project | null, selectedPlanSetId: string): RevisionModel => {
  const empty: RevisionModel = {
    visiblePages: [],
    currentPageIds: new Set(),
    revisionsBySheet: new Map(),
    revisionNumberByPageId: new Map(),
    latestPageIdBySheet: new Map(),
    status: () => 'unique',
  };
  if (!project) return empty;

  const order = planSetIndex(project);
  const setOrder = (page: ProjectPage) => (page.planSetId ? order.get(page.planSetId) ?? -1 : -1);

  // Full revision history per sheet (across all sets), oldest -> newest.
  const revisionsBySheet = new Map<string, ProjectPage[]>();
  for (const page of project.pages) {
    const key = sheetKey(page);
    if (!key) continue;
    const list = revisionsBySheet.get(key) || [];
    list.push(page);
    revisionsBySheet.set(key, list);
  }
  const revisionNumberByPageId = new Map<string, number>();
  const latestPageIdBySheet = new Map<string, string>();
  for (const [key, pages] of revisionsBySheet) {
    pages.sort((a, b) => setOrder(a) - setOrder(b));
    pages.forEach((p, i) => revisionNumberByPageId.set(p.id, i + 1));
    latestPageIdBySheet.set(key, pages[pages.length - 1].id);
  }

  // As-of filtering: only pages in allowed sets (plus legacy un-tagged pages).
  const allowedIds = new Set(allowedPlanSets(project, selectedPlanSetId).map(ps => ps.id));
  const candidates = project.pages.filter(p => !p.planSetId || allowedIds.has(p.planSetId));

  // Revision dedup: for each sheet, keep only the pages from the newest allowed
  // set. Multiple pages sharing a number *within* one set are all kept (they're
  // distinct sheets that auto-numbering happened to collide, not revisions).
  const newestSetForSheet = new Map<string, number>();
  for (const page of candidates) {
    const key = sheetKey(page);
    if (!key) continue;
    const o = setOrder(page);
    if (!newestSetForSheet.has(key) || o > (newestSetForSheet.get(key) as number)) {
      newestSetForSheet.set(key, o);
    }
  }
  const visiblePages = candidates.filter(page => {
    const key = sheetKey(page);
    if (!key) return true;
    return setOrder(page) === newestSetForSheet.get(key);
  });
  const currentPageIds = new Set(visiblePages.map(p => p.id));

  const status = (pageId: string): RevisionStatus => {
    const page = project.pages.find(p => p.id === pageId);
    if (!page) return 'unique';
    const key = sheetKey(page);
    if (!key) return 'unique';
    const revs = revisionsBySheet.get(key) || [];
    if (revs.length <= 1) return 'unique';
    return latestPageIdBySheet.get(key) === pageId ? 'current' : 'superseded';
  };

  return { visiblePages, currentPageIds, revisionsBySheet, revisionNumberByPageId, latestPageIdBySheet, status };
};

// Summary of what a plan set introduced relative to earlier sets: how many
// sheet numbers are brand new vs. revisions of an existing sheet.
export const summarizePlanSet = (project: Project | null, setId: string): { newCount: number; revisedCount: number; total: number } => {
  if (!project) return { newCount: 0, revisedCount: 0, total: 0 };
  const order = planSetIndex(project);
  const thisOrder = order.get(setId) ?? -1;
  const earlierSheets = new Set<string>();
  for (const page of project.pages) {
    const key = sheetKey(page);
    if (!key || !page.planSetId) continue;
    if ((order.get(page.planSetId) ?? -1) < thisOrder) earlierSheets.add(key);
  }
  let newCount = 0;
  let revisedCount = 0;
  const seen = new Set<string>();
  for (const page of project.pages) {
    if (page.planSetId !== setId) continue;
    const key = sheetKey(page);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (earlierSheets.has(key)) revisedCount++; else newCount++;
  }
  return { newCount, revisedCount, total: seen.size };
};
