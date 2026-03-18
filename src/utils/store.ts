import { Project, TakeoffTemplate } from '../types';

export const saveProject = async (project: Project): Promise<void> => {
  const res = await fetch('/api/projects/' + project.id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(project)
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to save project');
  }
};

export const createProject = async (project: Project): Promise<void> => {
  const res = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(project)
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to create project');
  }
};

export const getProject = async (id: string): Promise<Project | null> => {
  const res = await fetch('/api/projects/' + id);
  if (!res.ok) return null;
  return await res.json();
};

export const getAllProjects = async (): Promise<Project[]> => {
  const res = await fetch('/api/projects');
  if (!res.ok) return [];
  return await res.json();
};

export const deleteProject = async (id: string): Promise<void> => {
  await fetch('/api/projects/' + id, { method: 'DELETE' });
};

export const saveImage = async (id: string, dataUrl: string): Promise<void> => {
  await fetch('/api/images', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, data: dataUrl })
  });
};

export const getImage = async (id: string): Promise<string | null> => {
  const res = await fetch('/api/images/' + id);
  if (!res.ok) return null;
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
  await fetch('/api/templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(template)
  });
};

export const getTemplates = async (): Promise<TakeoffTemplate[]> => {
  const res = await fetch('/api/templates');
  if (!res.ok) return [];
  return await res.json();
};

export const deleteTemplate = async (id: string): Promise<void> => {
  await fetch('/api/templates/' + id, { method: 'DELETE' });
};

export const getActivePages = async (): Promise<string[]> => {
  const res = await fetch('/api/pages/active');
  if (!res.ok) return [];
  return await res.json();
};
