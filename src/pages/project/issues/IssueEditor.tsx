// src/pages/project/issues/IssueEditor.tsx
import React, { useState, useRef } from 'react';
import { Camera, Trash2 } from 'lucide-react';
import { Issue, saveIssue, setIssueStatus, addIssuePhoto, removeIssuePhoto, uploadProjectFile, getImageUrl } from '../../../utils/store';
import { useToast } from '../../../components/Toast';
import { Button, Field, Input, Modal, Textarea } from '../../../components/ui';
import { IssueStatusPill, ISSUE_STATUS_META } from '../../../components/ui/IssueStatusPill';

export const IssueEditor: React.FC<{
  issue: Issue;
  projectId: string;
  projectName: string;
  contractor?: string | null;
  onClose: () => void;
  onSaved: () => void;
}> = ({ issue, projectId, onClose, onSaved }) => {
  const { toast } = useToast();
  const [title, setTitle] = useState(issue.title ?? '');
  const [description, setDescription] = useState(issue.description ?? '');
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const handlePhotos = async (list: FileList | null) => {
    if (!list || !list.length) return;
    setUploading(true);
    let ok = 0;
    for (const f of Array.from(list)) {
      try {
        const fileId = await uploadProjectFile(projectId, f, 'photo');
        await addIssuePhoto(issue.id, fileId);
        ok++;
      } catch { /* keep going */ }
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = '';
    if (ok < list.length) toast(`Uploaded ${ok} of ${list.length} photos`, { type: ok ? 'warning' : 'error' });
    onSaved(); // reload the issue → photos appear
  };

  const dropPhoto = async (fileId: string) => {
    try { await removeIssuePhoto(issue.id, fileId); onSaved(); } catch { toast('Failed to remove photo', { type: 'error' }); }
  };

  const handleSave = async () => {
    if (!title.trim()) { toast('A title is required', { type: 'warning' }); return; }
    setSaving(true);
    try {
      await saveIssue(issue.id, { ...issue, title: title.trim(), description: description || null });
      toast('Issue saved', { type: 'success' });
      onSaved();
    } catch (e) {
      toast(e instanceof Error && e.name === 'ConflictError' ? 'Issue changed elsewhere — reopen it' : 'Save failed', { type: 'error' });
    } finally { setSaving(false); }
  };

  const cycleStatus = async () => {
    if (title.trim() !== (issue.title ?? '') || description !== (issue.description ?? '')) {
      toast('Save your changes before changing status', { type: 'warning' });
      return;
    }
    const next = issue.status === 'open' ? 'sent' : issue.status === 'sent' ? 'resolved' : 'open';
    try { await setIssueStatus(issue.id, next); onSaved(); } catch { toast('Status update failed', { type: 'error' }); }
  };

  return (
    <Modal open onClose={onClose} title={`ISS-${String(issue.number).padStart(3, '0')}`} width="lg"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        <Button onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
      </>}
    >
      <div className="mb-3 flex items-center gap-2">
        <button onClick={cycleStatus} title="Click to advance status"><IssueStatusPill status={issue.status} /></button>
        <span className="text-xs text-ink-faint">{Object.values(ISSUE_STATUS_META).map(m => m.label).join(' → ')}</span>
      </div>
      <Field label="Title" htmlFor="iss-title"><Input id="iss-title" value={title} onChange={e => setTitle(e.target.value)} /></Field>
      <div className="mt-3">
        <Field label="Description" htmlFor="iss-desc"><Textarea id="iss-desc" value={description} onChange={e => setDescription(e.target.value)} rows={4} /></Field>
      </div>
      <div className="mt-4 border-t border-edge pt-3">
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-sm font-semibold text-ink">Photos</h4>
          <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
            <Camera size={14} />{uploading ? 'Uploading…' : 'Add photos'}
          </Button>
          {/* capture="environment" opens the rear camera on mobile (spec §4.3 field use) */}
          <input ref={fileRef} type="file" accept="image/*" capture="environment" multiple className="hidden"
            onChange={e => handlePhotos(e.target.files)} />
        </div>
        {issue.photos.length === 0 ? (
          <p className="text-xs text-ink-faint">No photos. Add before/during/after shots from the field.</p>
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {issue.photos.map(p => (
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
      {/* send: Task 10 (recipient + Send report) */}
    </Modal>
  );
};
