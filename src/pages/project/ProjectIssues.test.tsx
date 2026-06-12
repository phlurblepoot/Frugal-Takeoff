// src/pages/project/ProjectIssues.test.tsx
import { describe, it, expect } from 'vitest';
import { issueNo } from './ProjectIssues';

describe('issueNo', () => {
  it('zero-pads to ISS-NNN', () => {
    expect(issueNo(1)).toBe('ISS-001');
    expect(issueNo(42)).toBe('ISS-042');
    expect(issueNo(123)).toBe('ISS-123');
  });
});
