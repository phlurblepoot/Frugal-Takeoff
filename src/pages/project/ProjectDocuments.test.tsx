// src/pages/project/ProjectDocuments.test.tsx
import { describe, it, expect } from 'vitest';
import { kindFromMime, openTargetFor } from './ProjectDocuments';

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
