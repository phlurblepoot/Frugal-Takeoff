import localforage from 'localforage';
import { Project, TakeoffTemplate } from '../types';

// Store for projects metadata
const projectsStore = localforage.createInstance({
  name: 'TakeoffPro',
  storeName: 'projects'
});

// Store for templates
const templatesStore = localforage.createInstance({
  name: 'TakeoffPro',
  storeName: 'templates'
});

// Store for large base64 images
const imagesStore = localforage.createInstance({
  name: 'TakeoffPro',
  storeName: 'images'
});

export const saveProject = async (project: Project): Promise<void> => {
  await projectsStore.setItem(project.id, project);
};

export const getProject = async (id: string): Promise<Project | null> => {
  const project = await projectsStore.getItem<any>(id);
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
  const projects: Project[] = [];
  await projectsStore.iterate((value: any) => {
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
    projects.push(value as Project);
  });
  return projects.sort((a, b) => b.createdAt - a.createdAt);
};

export const deleteProject = async (id: string): Promise<void> => {
  const project = await getProject(id);
  if (project) {
    // Delete associated images
    for (const page of project.pages) {
      await imagesStore.removeItem(page.imageId);
    }
    // Delete associated printouts
    if (project.printouts) {
      for (const printout of project.printouts) {
        await imagesStore.removeItem(printout.fileId);
      }
    }
    await projectsStore.removeItem(id);
  }
};

export const saveImage = async (id: string, dataUrl: string): Promise<void> => {
  await imagesStore.setItem(id, dataUrl);
};

export const getImage = async (id: string): Promise<string | null> => {
  return await imagesStore.getItem<string>(id);
};

export const saveFile = saveImage;
export const getFile = getImage;
export const deleteFile = async (id: string): Promise<void> => {
  await imagesStore.removeItem(id);
};

// Template functions
export const saveTemplate = async (template: TakeoffTemplate): Promise<void> => {
  await templatesStore.setItem(template.id, template);
};

export const getTemplates = async (): Promise<TakeoffTemplate[]> => {
  const templates: TakeoffTemplate[] = [];
  await templatesStore.iterate((value: TakeoffTemplate) => {
    templates.push(value);
  });
  return templates.sort((a, b) => b.createdAt - a.createdAt);
};

export const deleteTemplate = async (id: string): Promise<void> => {
  await templatesStore.removeItem(id);
};
