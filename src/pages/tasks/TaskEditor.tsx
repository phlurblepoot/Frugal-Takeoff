// src/pages/tasks/TaskEditor.tsx
import React, { useState, useRef } from 'react';
import { Camera, Trash2 } from 'lucide-react';
import {
  Task, AssignableUser, saveTask, setTaskStatus, addTaskPhoto, removeTaskPhoto,
  saveFile, getImageUrl,
} from '../../utils/store';
import { useToast } from '../../components/Toast';
import { Button, Field, Input, Modal, Select, Textarea } from '../../components/ui';

interface Props {
  task: Task;
  users: AssignableUser[];
  onClose: () => void;
  onSaved: () => void;
}

const STATUSES: { value: string; label: string }[] = [
  { value: 'todo', label: 'To do' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'done', label: 'Done' },
];

const STAGES: { stage: string; label: string }[] = [
  { stage: 'before', label: 'Before' },
  { stage: 'in_progress', label: 'In progress' },
  { stage: 'after', label: 'After' },
];

// Tasks are not project-scoped, so there is no projectId to upload against.
// Mirror the legacy ChecklistEditor path: FileReader → dataUrl → saveFile(id, …)
// (POST /api/images), then getImageUrl(id) (= /api/images/:id/raw) for display.
const readDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });

export const TaskEditor: React.FC<Props> = ({ task, users, onClose, onSaved }) => {
  const { toast } = useToast();
  const [category, setCategory] = useState(task.category ?? '');
  const [title, setTitle] = useState(task.title ?? '');
  const [notes, setNotes] = useState(task.notes ?? '');
  const [assigneeUserId, setAssigneeUserId] = useState<string | null>(task.assigneeUserId ?? null);
  const [dueDate, setDueDate] = useState(task.dueDate ?? '');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const dirty =
    category !== (task.category ?? '') ||
    title !== (task.title ?? '') ||
    notes !== (task.notes ?? '') ||
    assigneeUserId !== (task.assigneeUserId ?? null) ||
    dueDate !== (task.dueDate ?? '');

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveTask(task.id, { ...task, category, title, notes, assigneeUserId, dueDate: dueDate || null });
      toast('Task saved', { type: 'success' });
      onSaved();
    } catch (e) {
      toast(e instanceof Error && e.name === 'ConflictError' ? 'This task changed elsewhere — reload' : 'Save failed', { type: 'error' });
    } finally { setSaving(false); }
  };

  const changeStatus = async (next: string) => {
    if (next === task.status) return;
    if (dirty) { toast('Save your changes first', { type: 'warning' }); return; }
    try { await setTaskStatus(task.id, next); onSaved(); } catch { toast('Failed to update status', { type: 'error' }); }
  };

  const handlePhotos = async (stage: string, list: FileList | null) => {
    if (!list || !list.length) return;
    setUploading(true);
    let ok = 0;
    for (const f of Array.from(list)) {
      try {
        const dataUrl = await readDataUrl(f);
        const fileId = `task-photo-${crypto.randomUUID()}`;
        await saveFile(fileId, dataUrl);
        await addTaskPhoto(task.id, fileId, stage);
        ok++;
      } catch { /* keep going */ }
    }
    setUploading(false);
    const ref = fileRefs.current[stage];
    if (ref) ref.value = '';
    if (ok < list.length) toast(`Uploaded ${ok} of ${list.length} photos`, { type: ok ? 'warning' : 'error' });
    onSaved(); // reload the task → photos appear
  };

  const dropPhoto = async (fileId: string) => {
    try { await removeTaskPhoto(task.id, fileId); onSaved(); } catch { toast('Failed to remove photo', { type: 'error' }); }
  };

  return (
    <Modal open onClose={onClose} title="Task" width="lg"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        <Button onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
      </>}
    >
      <div className="mb-3">
        <Field label="Status" htmlFor="task-status">
          <Select id="task-status" value={task.status} onChange={e => changeStatus(e.target.value)}>
            {STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </Select>
        </Field>
      </div>
      <Field label="Title" htmlFor="task-title"><Input id="task-title" value={title} onChange={e => setTitle(e.target.value)} /></Field>
      <div className="mt-3">
        <Field label="Category" htmlFor="task-category"><Input id="task-category" value={category} onChange={e => setCategory(e.target.value)} /></Field>
      </div>
      <div className="mt-3">
        <Field label="Assignee" htmlFor="task-assignee">
          <Select id="task-assignee" value={assigneeUserId ?? ''} onChange={e => setAssigneeUserId(e.target.value || null)}>
            <option value="">Unassigned</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.username}</option>)}
          </Select>
        </Field>
      </div>
      <div className="mt-3">
        <Field label="Due date" htmlFor="task-due"><Input id="task-due" type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} /></Field>
      </div>
      <div className="mt-3">
        <Field label="Notes" htmlFor="task-notes"><Textarea id="task-notes" value={notes} onChange={e => setNotes(e.target.value)} rows={4} /></Field>
      </div>
      {STAGES.map(({ stage, label }) => {
        const photos = task.photos.filter(p => p.stage === stage);
        return (
          <div key={stage} className="mt-4 border-t border-edge pt-3">
            <div className="mb-2 flex items-center justify-between">
              <h4 className="text-sm font-semibold text-ink">{label}</h4>
              <Button variant="secondary" size="sm" onClick={() => fileRefs.current[stage]?.click()} disabled={uploading}>
                <Camera size={14} />{uploading ? 'Uploading…' : 'Add photos'}
              </Button>
              {/* capture="environment" opens the rear camera on mobile for field use */}
              <input ref={el => { fileRefs.current[stage] = el; }} type="file" accept="image/*" capture="environment" multiple className="hidden"
                onChange={e => handlePhotos(stage, e.target.files)} />
            </div>
            {photos.length === 0 ? (
              <p className="text-xs text-ink-faint">No {label.toLowerCase()} photos.</p>
            ) : (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {photos.map(p => (
                  <div key={p.id} className="group relative">
                    <img src={getImageUrl(p.fileId)} alt="" className="h-24 w-full rounded-lg border border-edge object-cover" />
                    <button onClick={() => dropPhoto(p.fileId)} title="Remove"
                      className="absolute right-1 top-1 rounded-md bg-black/50 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100">
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </Modal>
  );
};
