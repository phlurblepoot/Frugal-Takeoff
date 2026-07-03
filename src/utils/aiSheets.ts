import { getAuthHeaders } from './store';

export interface SheetRead { sheetNumber: string; sheetTitle: string; discipline?: string; confidence: number; }
export interface SheetMatch { matchSheetId: string | null; confidence: number; reason?: string; }
export interface AiStatus { available: boolean; model: string; device: string; state?: 'off' | 'loading' | 'ready'; }
export interface ExistingSheetRef { sheetId: string; number: string; title: string; }

/** Minimal shape of a review page the apply helpers touch. */
export interface AiPage {
  id: string;
  name: string;
  pageNumber?: string;
  description?: string;
  detectionConfidence?: 'high' | 'low';
  matchSheetId?: string;
  aiConfidence?: number;
}

let statusCache: AiStatus | null = null;

export async function getAiStatus(force = false): Promise<AiStatus> {
  if (statusCache && !force) return statusCache;
  try {
    const res = await fetch('/api/ai/status', { headers: getAuthHeaders() });
    statusCache = res.ok ? await res.json() : { available: false, model: 'n/a', device: 'none' };
  } catch {
    statusCache = { available: false, model: 'n/a', device: 'none' };
  }
  return statusCache!;
}

export async function readSheet(input: { imageId?: string; imageBase64?: string; embeddedText?: string }): Promise<SheetRead | null> {
  try {
    const res = await fetch('/api/ai/read-sheet', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }, body: JSON.stringify(input),
    });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

export async function matchSheet(input: { page: SheetRead; existingSheets: ExistingSheetRef[] }): Promise<SheetMatch | null> {
  try {
    const res = await fetch('/api/ai/match-sheet', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }, body: JSON.stringify(input),
    });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

/** Run thunks with a bounded concurrency, preserving result order. */
export async function runWithConcurrency<T>(thunks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results = new Array<T>(thunks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, thunks.length) }, async () => {
    while (next < thunks.length) {
      const i = next++;
      results[i] = await thunks[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

/** Local per-user toggle (server AI_ENABLED is the master switch). */
export function aiAutoNameEnabled(): boolean {
  return localStorage.getItem('aiAutoName') !== 'false';
}
export function setAiAutoNameEnabled(on: boolean): void {
  localStorage.setItem('aiAutoName', on ? 'true' : 'false');
}

/** Apply a read to a page (pure). Empty reads leave the page untouched. */
export function applyReadToPage<T extends AiPage>(page: T, read: SheetRead): T {
  if (!read.sheetNumber && !read.sheetTitle) return page;
  const pageNumber = read.sheetNumber || page.pageNumber || '';
  const description = read.sheetTitle || page.description || '';
  const name = pageNumber && description ? `${pageNumber} - ${description}` : pageNumber || description || page.name;
  return {
    ...page,
    pageNumber,
    description,
    name,
    aiConfidence: read.confidence,
    detectionConfidence: read.confidence >= 0.5 && !!read.sheetNumber ? 'high' : 'low',
  };
}

/** Apply a match to a page (pure). Below 0.5 confidence leaves matchSheetId as-is. */
export function applyMatchToPage<T extends AiPage>(page: T, match: SheetMatch): T {
  if (match.confidence < 0.5) return page;
  return { ...page, matchSheetId: match.matchSheetId ?? '' };
}
