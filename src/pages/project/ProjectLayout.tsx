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

  // Manual refresh (e.g. after a stage change) — refetches the current
  // project, so a late resolution can't be stale.
  const refreshSummary = () => {
    if (!projectId) return;
    getProjectSummary(projectId).then(setSummary).catch(() => {});
  };

  // On project switch, guard against an out-of-order resolution: if A→B
  // happens fast and A's request resolves after B's, the stale flag drops it.
  useEffect(() => {
    setSummary(null);
    if (!projectId) return;
    let stale = false;
    getProjectSummary(projectId).then(s => { if (!stale) setSummary(s); }).catch(() => {});
    return () => { stale = true; };
  }, [projectId]);

  // Register only once the name is known — the sidebar shows 'Project' until then.
  useRegisterProjectShell(summary?.id, summary?.name);

  return <Outlet context={{ summary, refreshSummary } satisfies ProjectOutletCtx} />;
};
