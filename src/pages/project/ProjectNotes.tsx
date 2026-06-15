// src/pages/project/ProjectNotes.tsx
import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { NotesBoard } from '../../components/NotesBoard';
import { getProjectNotes, saveProjectNotes } from '../../utils/store';
import { ProjectNote } from '../../types';
import { useToast } from '../../components/Toast';
import { Skeleton } from '../../components/ui';

// Full-page notes section. The same NotesBoard still powers the canvas
// overlay (NotesOverlay) — this page just gives it a permanent home.
export const ProjectNotes: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const { toast } = useToast();
  const [note, setNote] = useState<ProjectNote | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    setLoaded(false);
    getProjectNotes(projectId)
      .then(setNote)
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [projectId]);

  const handleSave = async (n: ProjectNote) => {
    if (!projectId) return;
    try {
      await saveProjectNotes(projectId, n);
      setNote(n);
    } catch {
      toast('Failed to save notes', { type: 'error' });
    }
  };

  if (!projectId) return null;
  return (
    <div className="flex h-screen flex-col">
      {!loaded ? (
        <div className="p-6"><Skeleton className="h-64" /></div>
      ) : (
        <div className="min-h-0 flex-1">
          <NotesBoard projectId={projectId} initialNote={note} onSave={handleSave} />
        </div>
      )}
    </div>
  );
};
