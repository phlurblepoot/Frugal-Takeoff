// src/pages/project/ProjectOverview.tsx
import React from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { useProjectOutlet } from './ProjectLayout';
import { Skeleton } from '../../components/ui';

export const ProjectOverview: React.FC = () => {
  const [searchParams] = useSearchParams();
  const { summary } = useProjectOutlet();

  // Pre-3b bookmarks looked like /project/:id?tab=takeoffs — forward them to
  // the takeoff section, which still owns those tabs.
  const legacyTab = searchParams.get('tab');
  if (legacyTab) return <Navigate to={`takeoff?tab=${encodeURIComponent(legacyTab)}`} replace />;

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8">
      {summary ? (
        <h1 className="text-xl font-bold text-ink">{summary.name}</h1>
      ) : (
        <Skeleton className="h-7 w-64" />
      )}
    </div>
  );
};
