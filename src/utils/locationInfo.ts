// Parses the router pathname into the structured location the realtime
// server keys presence and rooms on. Kept dependency-free for testability.
export interface ClientLocationInfo {
  path: string;
  projectId?: string;
  section?: string;
  pageId?: string;
  fileId?: string;
  label?: string;
}

export function locationFromPath(pathname: string, search: string, label?: string): ClientLocationInfo {
  let projectId: string | undefined;
  let section: string | undefined;
  let pageId: string | undefined;
  let fileId: string | undefined;

  const projectMatch = pathname.match(/^\/project\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?/);
  if (projectMatch) {
    projectId = projectMatch[1];
    section = projectMatch[2] || 'overview';
    if (projectMatch[2] === 'page' && projectMatch[3]) pageId = projectMatch[3];
  }
  if (pathname === '/tools/sheets') {
    fileId = new URLSearchParams(search).get('fileId') || undefined;
  }
  return { path: pathname, projectId, section, pageId, fileId, label };
}
