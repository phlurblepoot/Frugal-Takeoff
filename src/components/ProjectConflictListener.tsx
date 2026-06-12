import { useEffect, useRef } from 'react';
import { useToast } from './Toast';

// One global handler for project version conflicts (48 saveProject call
// sites — centralizing beats wiring every one). A conflict means this tab's
// copy is stale: tell the user, then reload so they continue from fresh data.
export default function ProjectConflictListener() {
  const { toast } = useToast();
  const reloading = useRef(false);

  useEffect(() => {
    const onConflict = () => {
      if (reloading.current) return;
      reloading.current = true;
      toast('This project was changed elsewhere — reloading to get the latest…', { type: 'error' });
      setTimeout(() => window.location.reload(), 2000);
    };
    window.addEventListener('project-conflict', onConflict);
    return () => window.removeEventListener('project-conflict', onConflict);
  }, [toast]);

  return null;
}
