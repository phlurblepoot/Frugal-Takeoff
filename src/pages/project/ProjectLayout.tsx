// src/pages/project/ProjectLayout.tsx
import React, { useRef, useState } from 'react';
import { Outlet, useOutletContext, useParams } from 'react-router-dom';
import { ProjectSummary, getProjectSummary } from '../../utils/store';
import { useRegisterProjectShell } from '../../context/ProjectShellContext';
import { useLiveQuery } from '../../hooks/useLiveQuery';

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

  // useLiveQuery re-runs this on mount, whenever `projectId` changes (it's
  // part of the filter identity), and on foreign project-changed socket
  // events. Only reset `summary` to null on an actual project switch — not on
  // every live refresh of the SAME project, which would otherwise flash the
  // sidebar name on background sync. loadSeqRef guards the project-switch
  // case against an out-of-order resolution (A→B fast, A's request resolves
  // after B's).
  const lastProjectIdRef = useRef<string | undefined>(undefined);
  const loadSeqRef = useRef(0);
  const load = () => {
    const seq = ++loadSeqRef.current;
    if (projectId !== lastProjectIdRef.current) {
      lastProjectIdRef.current = projectId;
      setSummary(null);
    }
    if (!projectId) return;
    getProjectSummary(projectId).then(s => { if (loadSeqRef.current === seq) setSummary(s); }).catch(() => {});
  };
  useLiveQuery(load, { types: ['project'], projectId, id: projectId });

  // Register only once the name is known — the sidebar shows 'Project' until then.
  useRegisterProjectShell(summary?.id, summary?.name);

  return <Outlet context={{ summary, refreshSummary } satisfies ProjectOutletCtx} />;
};
