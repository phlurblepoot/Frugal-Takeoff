// src/pages/project/proposal/proposalTextHistory.test.ts
import { describe, it, expect } from 'vitest';
import { PROPOSAL_TEXT_HISTORY_MAX, pushHistory, parseHistory, resolveInitialProposalText } from './proposalTextHistory';

describe('pushHistory', () => {
  it('pushes a new entry to the front', () => {
    const result = pushHistory(['a', 'b'], 'c');
    expect(result).toEqual(['c', 'a', 'b']);
  });

  it('trims whitespace before pushing', () => {
    const result = pushHistory([], '  hello  ');
    expect(result).toEqual(['hello']);
  });

  it('skips an empty entry and returns the SAME reference', () => {
    const history = ['a', 'b'];
    const result = pushHistory(history, '   ');
    expect(result).toBe(history);
  });

  it('dedups by exact trimmed match, moving the dup to the front', () => {
    const result = pushHistory(['a', 'b', 'c'], 'b');
    expect(result).toEqual(['b', 'a', 'c']);
  });

  it('dedup matches after trimming the incoming entry', () => {
    const result = pushHistory(['a', 'b', 'c'], '  b  ');
    expect(result).toEqual(['b', 'a', 'c']);
  });

  it('is a no-op returning the SAME reference when entry is already at front', () => {
    const history = ['a', 'b', 'c'];
    const result = pushHistory(history, 'a');
    expect(result).toBe(history);
  });

  it('caps at PROPOSAL_TEXT_HISTORY_MAX, dropping the oldest', () => {
    const history = ['1', '2', '3', '4', '5'];
    expect(history.length).toBe(PROPOSAL_TEXT_HISTORY_MAX);
    const result = pushHistory(history, '6');
    expect(result).toEqual(['6', '1', '2', '3', '4']);
    expect(result.length).toBe(PROPOSAL_TEXT_HISTORY_MAX);
  });

  it('honours an explicit cap', () => {
    const history = ['1', '2', '3'];
    expect(pushHistory(history, '4', 2)).toEqual(['4', '1']);
  });

  it('returns a NEW array (not mutating the input) on a normal push', () => {
    const history = ['a', 'b'];
    const result = pushHistory(history, 'c');
    expect(result).not.toBe(history);
    expect(history).toEqual(['a', 'b']);
  });
});

describe('parseHistory', () => {
  it('parses a valid JSON string array', () => {
    expect(parseHistory('["a","b","c"]')).toEqual(['a', 'b', 'c']);
  });

  it('undefined input → []', () => {
    expect(parseHistory(undefined)).toEqual([]);
  });

  it('malformed JSON → []', () => {
    expect(parseHistory('not-json{{{')).toEqual([]);
  });

  it('valid JSON that is not an array → []', () => {
    expect(parseHistory('{"a":1}')).toEqual([]);
  });

  it('array containing non-string junk → junk filtered out', () => {
    expect(parseHistory('["a", 1, null, "b", {}, "c"]')).toEqual(['a', 'b', 'c']);
  });

  it('empty string → []', () => {
    expect(parseHistory('')).toEqual([]);
  });
});

// ── resolveInitialProposalText ───────────────────────────────────────────────
// Decides what a cover-notes/terms field should show right after a project's
// data (and this user's history) resolve. `current` is whatever the field
// holds AT THAT MOMENT — after the caller has already reset it to '' on
// project switch, so a non-empty `current` here means the user typed
// something during the fetch (or a same-project reload landed) and must win.
describe('resolveInitialProposalText', () => {
  it('an explicitly stored value (even reached via undefined-check) always wins over history', () => {
    expect(resolveInitialProposalText('stored text', 'history text', '')).toBe('stored text');
  });

  it('a stored value wins even over text the user is mid-typing', () => {
    // Same-project reload landing while the user is typing: the freshly
    // saved value IS what they just typed, so this is a no-op in practice —
    // but the precedence itself must still favor "stored".
    expect(resolveInitialProposalText('stored text', 'history text', 'typed text')).toBe('stored text');
  });

  it('an explicitly stored EMPTY STRING wins over history (undefined-check, not truthiness)', () => {
    expect(resolveInitialProposalText('', 'history text', '')).toBe('');
  });

  it('no stored value, field still empty → falls back to history', () => {
    expect(resolveInitialProposalText(undefined, 'history text', '')).toBe('history text');
  });

  it('no stored value, no history → empty string', () => {
    expect(resolveInitialProposalText(undefined, undefined, '')).toBe('');
  });

  it('no stored value, but field is no longer empty → keeps current (never clobbers typed text)', () => {
    expect(resolveInitialProposalText(undefined, 'history text', 'typed text')).toBe('typed text');
  });
});
