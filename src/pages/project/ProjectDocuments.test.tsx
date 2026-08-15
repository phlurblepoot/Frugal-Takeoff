// src/pages/project/ProjectDocuments.test.tsx
import { describe, it, expect } from 'vitest';
import { kindFromMime, openTargetFor, visibleFiles } from './ProjectDocuments';
import { ProjectFile } from '../../utils/store';

const file = (kind: string, id = kind): ProjectFile => ({
  id, projectId: 'p1', kind, name: id, mime: 'application/pdf', size: 1,
  parentFileId: null, versionNumber: 1, createdAt: 0,
});

describe('kindFromMime', () => {
  it('classifies uploads', () => {
    expect(kindFromMime('application/pdf')).toBe('document');
    expect(kindFromMime('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('spreadsheet');
    expect(kindFromMime('application/vnd.ms-excel')).toBe('spreadsheet');
    expect(kindFromMime('image/png')).toBe('photo');
    expect(kindFromMime('text/plain')).toBe('other');
  });
});

describe('openTargetFor', () => {
  it('routes pdfs and sheets to their editors, images to raw view', () => {
    expect(openTargetFor({ mime: 'application/pdf', id: 'a' } as any)).toEqual({ type: 'pdf', url: '/tools/pdf?fileId=a' });
    expect(openTargetFor({ mime: 'application/vnd.ms-excel', id: 'b' } as any)).toEqual({ type: 'sheet', url: '/tools/sheets?fileId=b' });
    expect(openTargetFor({ mime: 'image/jpeg', id: 'c' } as any)).toEqual({ type: 'image', url: '/api/images/c/raw' });
    expect(openTargetFor({ mime: 'application/zip', id: 'd' } as any)).toEqual({ type: 'download', url: null });
  });
});

describe('visibleFiles', () => {
  const files = [file('document'), file('plan'), file('printout'), file('photo')];

  it('excludes plan and printout kinds from the unfiltered "all" view', () => {
    const kinds = visibleFiles(files, 'all').map(f => f.kind);
    expect(kinds).toEqual(['document', 'photo']);
  });

  it('an explicit "plan" filter still shows plan-kind files (regression: was always empty)', () => {
    expect(visibleFiles(files, 'plan')).toEqual([file('plan')]);
  });

  it('an explicit "printout" filter still shows printout-kind files, even though it has no chip', () => {
    expect(visibleFiles(files, 'printout')).toEqual([file('printout')]);
  });

  it('a normal kind filter is unaffected', () => {
    expect(visibleFiles(files, 'document')).toEqual([file('document')]);
  });
});
