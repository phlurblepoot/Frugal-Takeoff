import { describe, it, expect } from 'vitest';
import { locationFromPath } from './locationInfo';

describe('locationFromPath', () => {
  it('parses a project section route', () => {
    expect(locationFromPath('/project/p1/billing', '')).toEqual(
      { path: '/project/p1/billing', projectId: 'p1', section: 'billing', pageId: undefined, fileId: undefined, label: undefined });
  });
  it('parses a canvas page route', () => {
    expect(locationFromPath('/project/p1/page/pg9', '', 'Floor 6')).toEqual(
      { path: '/project/p1/page/pg9', projectId: 'p1', section: 'page', pageId: 'pg9', fileId: undefined, label: 'Floor 6' });
  });
  it('parses project root as overview', () => {
    expect(locationFromPath('/project/p1', '')).toEqual(
      { path: '/project/p1', projectId: 'p1', section: 'overview', pageId: undefined, fileId: undefined, label: undefined });
  });
  it('parses the sheets tool with fileId', () => {
    expect(locationFromPath('/tools/sheets', '?fileId=f42')).toEqual(
      { path: '/tools/sheets', projectId: undefined, section: undefined, pageId: undefined, fileId: 'f42', label: undefined });
  });
  it('parses plain routes', () => {
    expect(locationFromPath('/dashboard', '')).toEqual(
      { path: '/dashboard', projectId: undefined, section: undefined, pageId: undefined, fileId: undefined, label: undefined });
  });
});
