import { Project, TakeoffTemplate } from '../types';

export const saveProject = async (project: Project): Promise<void> => {
  const response = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(project)
  });
  if (!response.ok) throw new Error('Failed to save project');
};

export const getProject = async (id: string): Promise<Project | null> => {
  const response = await fetch(`/api/projects/${id}`);
  if (!response.ok) return null;
  const project = await response.json();
  
  if (project) {
    if (project.groups) {
      project.takeoffs = project.groups;
      delete project.groups;
    }
    project.pages?.forEach((page: any) => {
      page.measurements?.forEach((m: any) => {
        if (m.groupId !== undefined) {
          m.takeoffId = m.groupId;
          delete m.groupId;
        }
      });
    });
  }
  return project as Project;
};

export const getAllProjects = async (): Promise<Project[]> => {
  const response = await fetch('/api/projects');
  if (!response.ok) return [];
  const projects = await response.json();
  
  projects.forEach((value: any) => {
    if (value.groups) {
      value.takeoffs = value.groups;
      delete value.groups;
    }
    value.pages?.forEach((page: any) => {
      page.measurements?.forEach((m: any) => {
        if (m.groupId !== undefined) {
          m.takeoffId = m.groupId;
          delete m.groupId;
        }
      });
    });
  });
  
  return projects.sort((a: any, b: any) => b.createdAt - a.createdAt);
};

export const deleteProject = async (id: string): Promise<void> => {
  const project = await getProject(id);
  if (project) {
    // Delete associated images
    for (const page of project.pages) {
      await deleteFile(page.imageId);
    }
    // Delete associated printouts
    if (project.printouts) {
      for (const printout of project.printouts) {
        await deleteFile(printout.fileId);
      }
    }
    const response = await fetch(`/api/projects/${id}`, { method: 'DELETE' });
    if (!response.ok) throw new Error('Failed to delete project');
  }
};

export const saveImage = async (id: string, dataUrl: string): Promise<void> => {
  const response = await fetch('/api/images', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, dataUrl })
  });
  if (!response.ok) throw new Error('Failed to save image');
};

export const getImage = async (id: string): Promise<string | null> => {
  const response = await fetch(`/api/images/${id}`);
  if (!response.ok) return null;
  const data = await response.json();
  return data.dataUrl;
};

export const saveFile = saveImage;
export const getFile = getImage;
export const deleteFile = async (id: string): Promise<void> => {
  const response = await fetch(`/api/images/${id}`, { method: 'DELETE' });
  if (!response.ok) console.error('Failed to delete image', id);
};

// Template functions
export const saveTemplate = async (template: TakeoffTemplate): Promise<void> => {
  const response = await fetch('/api/templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(template)
  });
  if (!response.ok) throw new Error('Failed to save template');
};

export const getTemplates = async (): Promise<TakeoffTemplate[]> => {
  const response = await fetch('/api/templates');
  if (!response.ok) return [];
  const templates = await response.json();
  return templates.sort((a: any, b: any) => b.createdAt - a.createdAt);
};

export const deleteTemplate = async (id: string): Promise<void> => {
  const response = await fetch(`/api/templates/${id}`, { method: 'DELETE' });
  if (!response.ok) throw new Error('Failed to delete template');
};
