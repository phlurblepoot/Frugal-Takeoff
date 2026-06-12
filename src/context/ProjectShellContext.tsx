// src/context/ProjectShellContext.tsx
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

export interface ProjectShellInfo {
  id: string;
  name: string;
}

interface ProjectShellCtx {
  project: ProjectShellInfo | null;
  setProject: (p: ProjectShellInfo | null) => void;
}

// Default works without a provider (company-mode-only renders in tests).
const ProjectShellContext = createContext<ProjectShellCtx>({
  project: null,
  setProject: () => {},
});

export const useProjectShell = () => useContext(ProjectShellContext);

export const ProjectShellProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [project, setProject] = useState<ProjectShellInfo | null>(null);
  const value = useMemo(() => ({ project, setProject }), [project]);
  return <ProjectShellContext.Provider value={value}>{children}</ProjectShellContext.Provider>;
};

// Pages that load a project call this so the sidebar can show its name.
// Cleared on unmount. Safe to call with undefined while the project loads.
export function useRegisterProjectShell(id: string | undefined, name: string | undefined): void {
  const { setProject } = useProjectShell();
  // Effect order matters: the set-effect must be declared before the
  // clear-effect so StrictMode's mount/cleanup/mount cycle converges on the
  // project value instead of null. Do not reorder.
  useEffect(() => {
    if (id) setProject({ id, name: name || 'Untitled' });
  }, [id, name, setProject]);
  useEffect(() => () => setProject(null), [setProject]);
}
