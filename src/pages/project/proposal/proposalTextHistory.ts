// src/pages/project/proposal/proposalTextHistory.ts
// Pure helpers for the cover-notes/terms "last-used" history feature. Storage
// (user-preference keys) and wiring live in ProjectProposal.tsx; this module
// only manipulates the in-memory string[].

export const PROPOSAL_TEXT_HISTORY_MAX = 5;

// Push `entry` onto `history` (newest first): trim, skip empty, dedup by
// exact trimmed match (moving the dup to the front), cap at `max`
// (PROPOSAL_TEXT_HISTORY_MAX by default; the manual-line library keeps a
// longer list). Returns a NEW array; returns `history` unchanged (same
// reference) when entry is empty or already at front — so callers can skip a
// save with a reference check.
export function pushHistory(history: string[], entry: string, max = PROPOSAL_TEXT_HISTORY_MAX): string[] {
  const trimmed = entry.trim();
  if (!trimmed) return history;
  if (history[0] === trimmed) return history;
  const deduped = history.filter(h => h !== trimmed);
  return [trimmed, ...deduped].slice(0, max);
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

// Decides what a cover-notes/terms field should show once a project's data
// and this user's history have both resolved. Precedence: an explicitly
// stored project value (checked with !== undefined, so an intentional empty
// string still wins) beats everything; otherwise `current` wins if the field
// is no longer empty (the caller reset it to '' on project switch, so a
// non-empty `current` here means the user typed something — or a same-project
// reload just landed with what they typed — while this was in flight); only
// then does the history fallback apply. Pure — safe to call from a functional
// setState updater.
export function resolveInitialProposalText(
  stored: string | undefined,
  historyFirst: string | undefined,
  current: string,
): string {
  if (stored !== undefined) return stored;
  if (current) return current;
  return historyFirst ?? '';
}
