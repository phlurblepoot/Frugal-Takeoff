// src/pages/project/ProjectNotes.tsx
import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import { NotesBoard } from '../../components/NotesBoard';
import { getProjectNotes, saveProjectNotes } from '../../utils/store';
import { ProjectNote } from '../../types';
import { useToast } from '../../components/Toast';
import { Skeleton } from '../../components/ui';
import { useLiveQuery } from '../../hooks/useLiveQuery';
import { useCollabEditing } from '../../hooks/useCollabEditing';
import { EditPresenceBanner } from '../../components/EditPresenceBanner';

// Full-page notes section. The same NotesBoard still powers the canvas
// overlay (NotesOverlay) — this page just gives it a permanent home.
export const ProjectNotes: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const { toast } = useToast();
  const [note, setNote] = useState<ProjectNote | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = () => {
    if (!projectId) return;
    setLoaded(false);
    getProjectNotes(projectId)
      .then(setNote)
      .catch(() => {})
      .finally(() => setLoaded(true));
  };
  useLiveQuery(load, { types: ['note'], projectId });

  // Presence + silent live refresh only — the notes board autosaves its own
  // drafts, so there's no single dirty flag to protect with a merge banner.
  const collab = useCollabEditing({
    type: 'note',
    id: projectId ?? '',
    isDirty: () => false,
    onFresh: load,
  });

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
        <div className="flex min-h-0 flex-1 flex-col">
          {collab.othersEditing.length > 0 && (
            <div className="px-4 pt-3"><EditPresenceBanner state={collab} /></div>
          )}
          <div className="min-h-0 flex-1">
            <NotesBoard projectId={projectId} initialNote={note} onSave={handleSave} />
          </div>
        </div>
      )}
    </div>
  );
};
