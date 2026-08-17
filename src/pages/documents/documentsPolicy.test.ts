// src/pages/documents/documentsPolicy.test.ts
import { describe, it, expect } from 'vitest';
import { selectionPolicy } from './documentsPolicy';
import { DocumentRow } from '../../utils/store';

const row = (over: Partial<DocumentRow>): DocumentRow => ({
  id: over.id ?? 'r1',
  name: 'file.pdf',
  mime: 'application/pdf',
  size: 100,
  kind: 'document',
  createdAt: 1,
  versionNumber: 1,
  archived: false,
  projectId: null,
  projectName: null,
  customerId: null,
  customerName: null,
  source: null,
  ...over,
});

describe('selectionPolicy', () => {
  it('downloadable is always every row, regardless of kind or source', () => {
    const rows = [
      row({ id: 'a', kind: 'invoice', source: { type: 'invoice', id: 'i1', label: 'Invoice #1', href: null } }),
      row({ id: 'b', kind: 'plan-source' }),
      row({ id: 'c', kind: 'document' }),
    ];
    expect(selectionPolicy(rows).downloadable).toEqual(rows);
  });

  it('archivable excludes plan-source rows only', () => {
    const rows = [
      row({ id: 'a', kind: 'plan-source' }),
      row({ id: 'b', kind: 'invoice', source: { type: 'invoice', id: 'i1', label: 'Invoice #1', href: null } }),
      row({ id: 'c', kind: 'document' }),
    ];
    const { archivable } = selectionPolicy(rows);
    expect(archivable.map(r => r.id)).toEqual(['b', 'c']);
  });

  it('deletable excludes rows with a resolved source (attached/generated)', () => {
    const rows = [
      row({ id: 'a', kind: 'document', source: null }),
      row({ id: 'b', kind: 'document', source: { type: 'invoice', id: 'i1', label: 'Invoice #1', href: null } }),
    ];
    expect(selectionPolicy(rows).deletable.map(r => r.id)).toEqual(['a']);
  });

  it('deletable excludes system-generated kinds even without a resolved source', () => {
    // e.g. a historical row whose source referent was deleted but the kind is
    // still a system kind, never a direct-upload one.
    const rows = [
      row({ id: 'a', kind: 'issue-report', source: null }),
      row({ id: 'b', kind: 'document', source: null }),
    ];
    expect(selectionPolicy(rows).deletable.map(r => r.id)).toEqual(['b']);
  });

  it('deletable includes custom:<id> kinds (treated as direct-upload)', () => {
    const rows = [row({ id: 'a', kind: 'custom:warranty', source: null })];
    expect(selectionPolicy(rows).deletable.map(r => r.id)).toEqual(['a']);
  });

  it('deletable includes every DIRECT_UPLOAD_KINDS value when unsourced', () => {
    const rows = ['document', 'spreadsheet', 'photo', 'other'].map(kind => row({ id: kind, kind, source: null }));
    expect(selectionPolicy(rows).deletable.map(r => r.id)).toEqual(['document', 'spreadsheet', 'photo', 'other']);
  });

  it('returns empty arrays for an empty selection', () => {
    expect(selectionPolicy([])).toEqual({ downloadable: [], archivable: [], deletable: [] });
  });
});
