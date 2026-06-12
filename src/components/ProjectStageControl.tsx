// src/components/ProjectStageControl.tsx
import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { patchProject, ConflictError } from '../utils/store';
import { ProjectStatusPill, PROJECT_STATUS_META } from './ui';
import { useToast } from './Toast';

// Stage options exclude 'archived' — archiving is its own explicit action.
const STAGE_OPTIONS = [
  'estimating', 'proposal_sent', 'awarded', 'in_progress',
  'punch_list', 'complete', 'lost',
];

export const ProjectStageControl: React.FC<{
  projectId: string;
  version: number | undefined;
  status: string | undefined;
  onChanged: (version: number, status: string) => void;
}> = ({ projectId, version, status, onChanged }) => {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const pick = async (next: string) => {
    setOpen(false);
    if (next === status || saving) return;
    setSaving(true);
    try {
      // version is always set after a server round-trip; ?? 1 is a conservative
      // fallback for legacy projects missing the field (server 409s if stale).
      const r = await patchProject(projectId, { version: version ?? 1, status: next });
      onChanged(r.version, r.status);
      toast(`Stage set to ${PROJECT_STATUS_META[next]?.label ?? next}`, { type: 'success' });
    } catch (e) {
      if (e instanceof ConflictError) {
        // Our copy of the project is stale — hand off to the global reload UX.
        window.dispatchEvent(new CustomEvent('project-conflict', { detail: { projectId } }));
      } else {
        toast('Failed to change stage', { type: 'error' });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div ref={ref} className="relative inline-flex">
      <button
        onClick={() => setOpen(o => !o)}
        disabled={saving}
        title="Change project stage"
        className="inline-flex items-center gap-1 disabled:opacity-50"
      >
        <ProjectStatusPill status={status} />
        <ChevronDown size={14} className="text-ink-faint" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-44 rounded-lg border border-edge bg-raised py-1 shadow-lg">
          {STAGE_OPTIONS.map(s => (
            <button
              key={s}
              onClick={() => pick(s)}
              className={`w-full px-3 py-1.5 text-left text-sm transition-colors hover:bg-hover ${
                s === status ? 'font-medium text-ink' : 'text-ink-soft'
              }`}
            >
              {PROJECT_STATUS_META[s]?.label ?? s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
