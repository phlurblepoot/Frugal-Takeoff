export interface NumberedRow { id: string; planSetId?: string; pageNumber?: string | null; }
const norm = (s?: string | null) => (s ?? '').trim().toLowerCase();

/** Ids of rows whose page number collides with another row in the SAME plan set.
 *  Blank page numbers are exempt. */
export function findDuplicatePageNumbers(rows: NumberedRow[]): string[] {
  const seen = new Map<string, string[]>(); // `${set} ${num}` -> ids
  for (const r of rows) {
    const num = norm(r.pageNumber);
    if (!num) continue;
    const key = (r.planSetId ?? '') + ' ' + num;
    (seen.get(key) ?? seen.set(key, []).get(key)!).push(r.id);
  }
  const out: string[] = [];
  for (const ids of seen.values()) if (ids.length > 1) out.push(...ids);
  return out;
}

/** Next free "Base (n)" given a set of already-taken (normalized) page numbers. */
export function suffixPageNumber(base: string, takenNormalized: Set<string>): string {
  let n = 2;
  while (takenNormalized.has(norm(`${base} (${n})`))) n++;
  return `${base} (${n})`;
}

/** The one canonical display-name formula: "NUM - DESC", else whichever
 *  part exists, else the fallback. Previously duplicated at 6 call sites. */
export function composePageName(
  pageNumber?: string | null,
  description?: string | null,
  fallback = '',
): string {
  const num = (pageNumber ?? '').trim();
  const desc = (description ?? '').trim();
  return num && desc ? `${num} - ${desc}` : num || desc || fallback;
}
