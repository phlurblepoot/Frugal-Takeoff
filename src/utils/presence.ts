// Pure presence helpers shared by the online list, canvas sidebar, follow
// pill, and page-viewer dots. Render-free by design.
import type { SessionView } from '../context/CollaborationContext';

export interface UserGroup {
  userId: string;
  name: string;
  color: string;
  isMe: boolean;
  sessions: SessionView[];
}

export function groupSessionsByUser(sessions: SessionView[], mySessionId: string | null): UserGroup[] {
  const byUser = new Map<string, SessionView[]>();
  let myUserId: string | null = null;
  for (const s of sessions) {
    if (s.sessionId === mySessionId) { myUserId = s.userId; continue; }
    const list = byUser.get(s.userId) ?? [];
    list.push(s);
    byUser.set(s.userId, list);
  }
  const groups: UserGroup[] = [];
  for (const [userId, list] of byUser) {
    groups.push({
      userId,
      name: list[0].name,
      color: list[0].color,
      isMe: userId === myUserId,
      sessions: list,
    });
  }
  groups.sort((a, b) => (a.isMe === b.isMe ? a.name.localeCompare(b.name) : a.isMe ? 1 : -1));
  return groups;
}

const SECTION_LABELS: Record<string, string> = {
  overview: 'Overview', takeoff: 'Takeoff', page: 'Canvas', billing: 'Billing',
  issues: 'Issues', rfis: 'RFIs', punch: 'Punch List', notes: 'Notes',
  time: 'Time', proposal: 'Proposal', settings: 'Settings', documents: 'Documents',
};

export function humanizeSection(section: string | undefined): string {
  if (!section) return 'Overview';
  return SECTION_LABELS[section] ?? section.charAt(0).toUpperCase() + section.slice(1);
}

const PATH_LABELS: [RegExp, string][] = [
  [/^\/dashboard$/, 'Dashboard'], [/^\/projects$/, 'Projects'], [/^\/tasks$/, 'Tasks'],
  [/^\/documents$/, 'Documents'], [/^\/customers(\/|$)/, 'Customers'], [/^\/time$/, 'Time'],
  [/^\/settings$/, 'Settings'], [/^\/tools\/pdf$/, 'PDF editor'], [/^\/tools\/sheets$/, 'Spreadsheet editor'],
];

export function describeLocation(
  location: SessionView['location'],
  projectNames: Record<string, string>,
): string {
  if (!location) return 'Online';
  if (location.projectId) {
    const project = projectNames[location.projectId] ?? 'A project';
    if (location.pageId) return `${project} · ${location.label || 'Canvas'}`;
    return `${project} · ${humanizeSection(location.section)}`;
  }
  for (const [re, label] of PATH_LABELS) if (re.test(location.path)) return label;
  return 'Online';
}
