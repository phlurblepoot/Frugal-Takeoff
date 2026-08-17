// src/pages/project/proposal/proposalTextHistory.ts
// Pure helpers for the cover-notes/terms "last-used" history feature. Storage
// (user-preference keys) and wiring live in ProjectProposal.tsx; this module
// only manipulates the in-memory string[].

export const PROPOSAL_TEXT_HISTORY_MAX = 5;

// Push `entry` onto `history` (newest first): trim, skip empty, dedup by
// exact trimmed match (moving the dup to the front), cap at
// PROPOSAL_TEXT_HISTORY_MAX. Returns a NEW array; returns `history` unchanged
// (same reference) when entry is empty or already at front — so callers can
// skip a save with a reference check.
export function pushHistory(history: string[], entry: string): string[] {
  const trimmed = entry.trim();
  if (!trimmed) return history;
  if (history[0] === trimmed) return history;
  const deduped = history.filter(h => h !== trimmed);
  return [trimmed, ...deduped].slice(0, PROPOSAL_TEXT_HISTORY_MAX);
}

// Parse a prefs JSON value into a safe string[]. Bad JSON, a non-array
// result, or non-string items all degrade to [] / filtered out rather than
// throwing.
export function parseHistory(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}
