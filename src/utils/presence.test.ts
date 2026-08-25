import { describe, it, expect } from 'vitest';
import { groupSessionsByUser, humanizeSection, describeLocation } from './presence';
import type { SessionView } from '../context/CollaborationContext';

const sess = (over: Partial<SessionView>): SessionView => ({
  sessionId: 's1', userId: 'u1', name: 'nathan', role: 'admin', color: '#3b82f6',
  device: 'Windows · Chrome', location: null, editing: null, cursor: null, lastActive: 1,
  ...over,
});

describe('groupSessionsByUser', () => {
  it('groups by user, excludes my own session, sorts others alphabetically with me last', () => {
    const groups = groupSessionsByUser([
      sess({ sessionId: 'me', userId: 'u1', name: 'nathan' }),
      sess({ sessionId: 'me2', userId: 'u1', name: 'nathan', device: 'iPad · Safari' }),
      sess({ sessionId: 'z1', userId: 'u3', name: 'zoe' }),
      sess({ sessionId: 'a1', userId: 'u2', name: 'amy' }),
      sess({ sessionId: 'a2', userId: 'u2', name: 'amy', device: 'Mac · Safari' }),
    ], 'me');
    expect(groups.map(g => g.name)).toEqual(['amy', 'zoe', 'nathan']);
    expect(groups[0].sessions).toHaveLength(2);
    expect(groups[2].isMe).toBe(true);
    expect(groups[2].sessions.map(s => s.sessionId)).toEqual(['me2']); // my own session excluded
  });

  it('omits the me-group when I have no other sessions', () => {
    const groups = groupSessionsByUser([
      sess({ sessionId: 'me', userId: 'u1' }),
      sess({ sessionId: 'b', userId: 'u2', name: 'amy' }),
    ], 'me');
    expect(groups.map(g => g.name)).toEqual(['amy']);
  });

  it('handles null mySessionId (socket not yet connected)', () => {
    const groups = groupSessionsByUser([sess({ sessionId: 'x', userId: 'u2', name: 'amy' })], null);
    expect(groups).toHaveLength(1);
    expect(groups[0].isMe).toBe(false);
  });
});

describe('humanizeSection', () => {
  it.each([
    ['billing', 'Billing'], ['rfis', 'RFIs'], ['punch', 'Punch List'],
    ['page', 'Canvas'], ['overview', 'Overview'], ['issues', 'Issues'],
    ['takeoff', 'Takeoff'], ['proposal', 'Proposal'], ['weird', 'Weird'], [undefined, 'Overview'],
  ])('%s -> %s', (input, expected) => expect(humanizeSection(input as any)).toBe(expected));
});

describe('describeLocation', () => {
  const names = { p1: 'Dania Beach' };
  it('null -> Online', () => expect(describeLocation(null, names)).toBe('Online'));
  it('canvas with label', () => expect(describeLocation(
    { path: '/project/p1/page/pg1', projectId: 'p1', section: 'page', pageId: 'pg1', label: 'Level 06' }, names))
    .toBe('Dania Beach · Level 06'));
  it('canvas without label', () => expect(describeLocation(
    { path: '/project/p1/page/pg1', projectId: 'p1', section: 'page', pageId: 'pg1' }, names))
    .toBe('Dania Beach · Canvas'));
  it('project section', () => expect(describeLocation(
    { path: '/project/p1/billing', projectId: 'p1', section: 'billing' }, names))
    .toBe('Dania Beach · Billing'));
  it('unknown project name degrades', () => expect(describeLocation(
    { path: '/project/pX/issues', projectId: 'pX', section: 'issues' }, names))
    .toBe('A project · Issues'));
  it.each([
    ['/dashboard', 'Dashboard'], ['/projects', 'Projects'], ['/tasks', 'Tasks'],
    ['/documents', 'Documents'], ['/customers', 'Customers'], ['/customers/c1', 'Customers'],
    ['/time', 'Time'], ['/settings', 'Settings'], ['/tools/pdf', 'PDF editor'],
    ['/tools/sheets', 'Spreadsheet editor'], ['/whatever', 'Online'],
  ])('%s -> %s', (path, expected) => expect(describeLocation({ path }, names)).toBe(expected));
});
