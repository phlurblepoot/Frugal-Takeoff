// src/pages/project/proposal/ProposalAttachmentsCard.tsx
// PDF attachments appended to the end of the generated proposal, in list
// order. Fully controlled and mutated straight through the API (no dirty
// state) — every action calls onChanged() so the editor reloads the proposal.
// Draft-only: the server rejects attachment edits on a locked proposal and
// requires the file to be a PDF.
import React, { useRef, useState } from 'react';
import { ArrowDown, ArrowUp, FileText, FolderOpen, Upload, X } from 'lucide-react';
import {
  type Proposal, type ProposalAttachment, type DocumentRow,
  addProposalAttachment, updateProposalAttachment, removeProposalAttachment,
  uploadProjectFile,
} from '../../../utils/store';
import { Button, Card, CardBody, CardHeader } from '../../../components/ui';
import { FilePickerModal } from '../../../components/FilePickerModal';
import { useToast } from '../../../components/Toast';
import { handleProposalCardError, toastProposalCardError } from './proposalCardErrors';

const fmtSize = (n: number | null) => {
  if (n == null) return null;
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
};

export const ProposalAttachmentsCard: React.FC<{
  proposal: Proposal;
  projectId: string;
  readOnly: boolean;
  onChanged: () => void;
}> = ({ proposal, projectId, readOnly, onChanged }) => {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [picking, setPicking] = useState(false);

  const attachments = [...proposal.attachments].sort((a, b) => a.sortOrder - b.sortOrder);

  const handleUpload = async (list: FileList | null) => {
    if (!list || !list.length) return;
    setUploading(true);
    let ok = 0;
    for (const f of Array.from(list)) {
      try {
        const { fileId } = await uploadProjectFile(projectId, f, 'document');
        await addProposalAttachment(proposal.id, fileId);
        ok++;
      } catch { /* keep going */ }
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = '';
    if (ok < list.length) toast(`Uploaded ${ok} of ${list.length} files`, { type: ok ? 'warning' : 'error' });
    onChanged();
  };

  // Mirrors handleUpload's count-and-summarize: a per-row failure (a stale
  // fileId, or the proposal locking mid-pick) must not be swallowed silently
  // — the picker can select many rows in one go.
  const handlePick = async (rows: DocumentRow[]) => {
    let ok = 0;
    for (const row of rows) {
      try { await addProposalAttachment(proposal.id, row.id); ok++; } catch { /* keep going */ }
    }
    if (ok < rows.length) toast(`Added ${ok} of ${rows.length} files`, { type: ok ? 'warning' : 'error' });
    if (ok > 0) onChanged();
  };

  // The two PATCHes are sequential rather than Promise.all'd: if the second
  // one fails, the server is left with one attachment's sortOrder already
  // moved — onChanged() always runs (via finally) so the card resyncs to
  // whatever sortOrder the server actually ended up with, instead of showing
  // a stale (and now duplicate) local order.
  const handleMove = async (index: number, dir: -1 | 1) => {
    const cur = attachments[index];
    const other = attachments[index + dir];
    if (!other) return;
    try {
      await updateProposalAttachment(proposal.id, cur.fileId, { sortOrder: other.sortOrder });
      await updateProposalAttachment(proposal.id, other.fileId, { sortOrder: cur.sortOrder });
    } catch (e) {
      toastProposalCardError(e, toast, 'Failed to reorder attachments');
    } finally {
      onChanged();
    }
  };

  const handleRemove = async (attachment: ProposalAttachment) => {
    try {
      await removeProposalAttachment(proposal.id, attachment.fileId);
      onChanged();
    } catch (e) { handleProposalCardError(e, toast, onChanged, 'Failed to remove attachment'); }
  };

  return (
    <Card data-testid="proposal-attachments">
      <CardHeader
        title="Attachments"
        actions={!readOnly && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
              <Upload size={14} />{uploading ? 'Uploading…' : 'Upload PDF'}
            </Button>
            <input ref={fileRef} type="file" accept="application/pdf" multiple className="hidden" onChange={e => handleUpload(e.target.files)} />
            <Button variant="secondary" size="sm" onClick={() => setPicking(true)}>
              <FolderOpen size={14} />Choose existing
            </Button>
          </div>
        )}
      />
      <CardBody className="space-y-2">
        <p className="text-xs text-ink-faint">Attached PDFs are appended to the end of the generated proposal, in this order.</p>
        {attachments.length === 0 ? (
          <p className="text-sm text-ink-faint">No attachments.</p>
        ) : (
          <ul className="divide-y divide-edge">
            {attachments.map((attachment, i) => (
              <li key={attachment.id} className="flex items-center gap-3 py-2" data-testid={`proposal-attachment-${attachment.id}`}>
                <FileText size={16} className="shrink-0 text-ink-faint" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">{attachment.name ?? attachment.fileId}</p>
                  {fmtSize(attachment.size) && <p className="text-xs text-ink-faint">{fmtSize(attachment.size)}</p>}
                </div>
                {!readOnly && (
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="sm" aria-label="Move up" title="Move up" disabled={i === 0} onClick={() => handleMove(i, -1)}><ArrowUp size={14} /></Button>
                    <Button variant="ghost" size="sm" aria-label="Move down" title="Move down" disabled={i === attachments.length - 1} onClick={() => handleMove(i, 1)}><ArrowDown size={14} /></Button>
                    <Button variant="ghost" size="sm" aria-label="Remove attachment" title="Remove" onClick={() => handleRemove(attachment)}><X size={14} /></Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
      <FilePickerModal
        open={picking}
        onClose={() => setPicking(false)}
        onPick={handlePick}
        accept="pdf"
        excludeFileIds={proposal.attachments.map(a => a.fileId)}
        initialProjectIds={[]}
        title="Choose PDFs"
      />
    </Card>
  );
};
