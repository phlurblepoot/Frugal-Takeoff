// src/pages/project/ProjectLayout.tsx
import React, { useEffect, useState } from 'react';
import { Outlet, useOutletContext, useParams } from 'react-router-dom';
import { ProjectSummary, getProjectSummary } from '../../utils/store';
import { useRegisterProjectShell } from '../../context/ProjectShellContext';

export interface ProjectOutletCtx {
  summary: ProjectSummary | null;
  refreshSummary: () => void;
}

// Convenience for section pages.
export const useProjectOutlet = () => useOutletContext<ProjectOutletCtx>();

// Thin frame for all project sections: registers the sidebar context once and
// shares a lightweight summary via outlet context. Sections that need full
// project data (ProjectView, CanvasView) keep loading it themselves.
export const ProjectLayout: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const [summary, setSummary] = useState<ProjectSummary | null>(null);

  const refreshSummary = () => {
    if (!projectId) return;
    getProjectSummary(projectId).then(setSummary).catch(() => {});
  };

  useEffect(() => {
    setSummary(null);
    refreshSummary();
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Register only once the name is known — the sidebar shows 'Project' until then.
  useRegisterProjectShell(summary?.id, summary?.name);

  return <Outlet context={{ summary, refreshSummary } satisfies ProjectOutletCtx} />;
};
