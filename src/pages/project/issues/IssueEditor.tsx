// src/pages/project/issues/IssueEditor.tsx
import React, { useState } from 'react';
import { Issue, saveIssue, setIssueStatus } from '../../../utils/store';
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
      {/* photos: Task 9 (rendered below the description) */}
      {/* send: Task 10 (recipient + Send report) */}
    </Modal>
  );
};
