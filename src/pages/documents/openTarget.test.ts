// src/pages/documents/openTarget.test.ts
import { describe, it, expect } from 'vitest';
import { kindFromMime, openTargetFor } from './openTarget';

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
    expect(openTargetFor({ mime: 'application/pdf', id: 'a' })).toEqual({ type: 'pdf', url: '/tools/pdf?fileId=a' });
    expect(openTargetFor({ mime: 'application/vnd.ms-excel', id: 'b' })).toEqual({ type: 'sheet', url: '/tools/sheets?fileId=b' });
    expect(openTargetFor({ mime: 'image/jpeg', id: 'c' })).toEqual({ type: 'image', url: '/api/images/c/raw' });
    expect(openTargetFor({ mime: 'application/zip', id: 'd' })).toEqual({ type: 'download', url: null });
  });
});
