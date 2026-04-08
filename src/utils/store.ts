import { Project, TakeoffTemplate, Bid, ProjectNote } from '../types';

export const getAuthHeaders = () => {
  const token = localStorage.getItem('token');
  return token ? { 'Authorization': `Bearer ${token}` } : {};
};

export const getImageUrl = (id: string) => {
  return `/api/images/${id}/raw`;
};

const handleResponse = async (res: Response) => {
  if (res.status === 401) {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = '/login';
    throw new Error('Session expired. Please log in again.');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Request failed');
  }
  return res;
};

export const getSettings = async (): Promise<Record<string, string>> => {
  const res = await fetch('/api/settings');
  await handleResponse(res);
  return await res.json();
};

export const saveSettings = async (settings: Record<string, string>): Promise<void> => {
  const res = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(settings)
  });
  await handleResponse(res);
};

export const getUserPreferences = async (): Promise<Record<string, string>> => {
  const res = await fetch('/api/user-preferences', {
    headers: { ...getAuthHeaders() },
  });
  await handleResponse(res);
  return await res.json();
};

export const saveUserPreferences = async (prefs: Record<string, string>): Promise<void> => {
  const res = await fetch('/api/user-preferences', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(prefs),
  });
  await handleResponse(res);
};

export const saveProject = async (project: Project): Promise<void> => {
  const res = await fetch('/api/projects/' + project.id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(project)
  });
  await handleResponse(res);
};

export const createProject = async (project: Project): Promise<void> => {
  const res = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(project)
  });
  await handleResponse(res);
};

export const getProject = async (id: string): Promise<Project | null> => {
  const res = await fetch('/api/projects/' + id, { headers: getAuthHeaders() });
  if (res.status === 404) return null;
  await handleResponse(res);
  return await res.json();
};

export const getAllProjects = async (): Promise<Project[]> => {
  const res = await fetch('/api/projects', { headers: getAuthHeaders() });
  await handleResponse(res);
  return await res.json();
};

export const deleteProject = async (id: string): Promise<void> => {
  const res = await fetch('/api/projects/' + id, { method: 'DELETE', headers: getAuthHeaders() });
  await handleResponse(res);
};

export const saveImage = async (id: string, dataUrl: string): Promise<void> => {
  const res = await fetch('/api/images', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ id, data: dataUrl })
  });
  await handleResponse(res);
};

export const getImage = async (id: string): Promise<string | null> => {
  const res = await fetch('/api/images/' + id, { headers: getAuthHeaders() });
  if (res.status === 404) return null;
  await handleResponse(res);
  const { data } = await res.json();
  return data;
};

export const saveFile = saveImage;
export const getFile = getImage;
export const deleteFile = async (id: string): Promise<void> => {
  // Image deletion is handled by project deletion in this simple version
};

// Template functions
export const saveTemplate = async (template: TakeoffTemplate): Promise<void> => {
  const res = await fetch('/api/templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(template)
  });
  await handleResponse(res);
};

export const getTemplates = async (): Promise<TakeoffTemplate[]> => {
  const res = await fetch('/api/templates', { headers: getAuthHeaders() });
  await handleResponse(res);
  return await res.json();
};

export const deleteTemplate = async (id: string): Promise<void> => {
  const res = await fetch('/api/templates/' + id, { method: 'DELETE', headers: getAuthHeaders() });
  await handleResponse(res);
};

export const getActivePages = async (): Promise<string[]> => {
  try {
    const res = await fetch('/api/pages/active', { headers: getAuthHeaders() });
    if (!res.ok) {
      console.error(`Active pages fetch failed with status: ${res.status}`);
      const text = await res.text();
      console.error('Response body:', text.substring(0, 100));
      throw new Error(`Request failed with status ${res.status}`);
    }
    return await res.json();
  } catch (error) {
    console.error('Network error or server crash in getActivePages:', error);
    throw error;
  }
};

// Bid functions
export const getBids = async (): Promise<Bid[]> => {
  const res = await fetch('/api/bids', { headers: getAuthHeaders() });
  await handleResponse(res);
  return await res.json();
};

export const saveBid = async (bid: Bid): Promise<void> => {
  const res = await fetch('/api/bids', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(bid)
  });
  await handleResponse(res);
};

export const deleteBid = async (id: string): Promise<void> => {
  const res = await fetch('/api/bids/' + id, { method: 'DELETE', headers: getAuthHeaders() });
  await handleResponse(res);
};

export const getProjectNotes = async (projectId: string): Promise<ProjectNote | null> => {
  const res = await fetch(`/api/projects/${projectId}/notes`, { headers: getAuthHeaders() });
  await handleResponse(res);
  return await res.json();
};

export const saveProjectNotes = async (projectId: string, note: ProjectNote): Promise<void> => {
  const res = await fetch(`/api/projects/${projectId}/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(note)
  });
  await handleResponse(res);
};
