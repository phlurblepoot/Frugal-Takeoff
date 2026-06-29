import { describe, it, expect } from 'vitest';
import { findDuplicatePageNumbers, suffixPageNumber } from './sheetNaming';

it('flags duplicate non-blank page numbers within one set (case-insensitive)', () => {
  const rows = [
    { id: '1', planSetId: 's1', pageNumber: 'A-101' },
    { id: '2', planSetId: 's1', pageNumber: 'a-101' },  // dup of #1
    { id: '3', planSetId: 's1', pageNumber: 'A-102' },
    { id: '4', planSetId: 's2', pageNumber: 'A-101' },  // different set → ok
    { id: '5', planSetId: 's1', pageNumber: '' },        // blank → exempt
    { id: '6', planSetId: 's1', pageNumber: '' },        // blank → exempt
  ];
  const dups = findDuplicatePageNumbers(rows);
  expect(new Set(dups)).toEqual(new Set(['1', '2']));
});

it('suffixes to the next free " (n)" within the set', () => {
  const taken = new Set(['a-101', 'a-101 (2)']);
  expect(suffixPageNumber('A-101', taken)).toBe('A-101 (3)');
  expect(suffixPageNumber('A-102', taken)).toBe('A-102 (2)');
});
