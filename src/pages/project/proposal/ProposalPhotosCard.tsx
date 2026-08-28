// src/pages/project/proposal/ProposalPhotosCard.tsx
// Photos appended to the end of the generated proposal. Fully controlled and
// mutated straight through the API (no dirty state) — every action calls
// onChanged() so the editor reloads the proposal with the fresh photo list.
// Draft-only: the server rejects photo edits on a locked (non-draft) proposal.
import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Camera, FolderOpen, X } from 'lucide-react';
import {
  type Proposal, type ProposalPhoto, type DocumentRow,
  addProposalPhoto, updateProposalPhoto, removeProposalPhoto,
  uploadProjectFile, getImageUrl,
} from '../../../utils/store';
import { Button, Card, CardBody, CardHeader, Input } from '../../../components/ui';
import { FilePickerModal } from '../../../components/FilePickerModal';
import { useToast } from '../../../components/Toast';
import { handleProposalCardError, toastProposalCardError } from './proposalCardErrors';

// Caption text stays local while typing (like PricingLinesCard's amount
// field) and only commits to the API on blur when it actually changed —
// otherwise every keystroke would fire a PATCH.
const PhotoTile: React.FC<{
  photo: ProposalPhoto;
  readOnly: boolean;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  onCaptionCommit: (caption: string) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}> = ({ photo, readOnly, canMoveLeft, canMoveRight, onCaptionCommit, onMove, onRemove }) => {
  const [caption, setCaption] = useState(photo.caption ?? '');
  useEffect(() => { setCaption(photo.caption ?? ''); }, [photo.caption]);

  return (
    <div className="group relative rounded-lg border border-edge bg-sunken p-2" data-testid={`proposal-photo-${photo.id}`}>
      <div className="relative">
        <img src={getImageUrl(photo.fileId)} alt="" className="h-28 w-full rounded-md object-cover" />
        {!readOnly && (
          <button
            type="button"
            onClick={onRemove}
            aria-label="Remove photo"
            title="Remove"
            className="absolute right-1 top-1 flex min-h-9 min-w-9 items-center justify-center rounded-md bg-black/50 p-1 text-white opacity-100 transition-opacity focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
          >
            <X size={14} />
          </button>
        )}
      </div>
      <Input
        className="mt-2"
        aria-label="Caption"
        placeholder="Caption (optional)"
        value={caption}
        disabled={readOnly}
        onChange={e => setCaption(e.target.value)}
        onBlur={() => { if (caption !== (photo.caption ?? '')) onCaptionCommit(caption); }}
      />
      {!readOnly && (
        <div className="mt-1 flex items-center justify-end">
          <Button variant="ghost" size="sm" aria-label="Move left" title="Move left" disabled={!canMoveLeft} onClick={() => onMove(-1)}><ArrowLeft size={14} /></Button>
          <Button variant="ghost" size="sm" aria-label="Move right" title="Move right" disabled={!canMoveRight} onClick={() => onMove(1)}><ArrowRight size={14} /></Button>
        </div>
      )}
    </div>
  );
};

export const ProposalPhotosCard: React.FC<{
  proposal: Proposal;
  projectId: string;
  readOnly: boolean;
  onChanged: () => void;
}> = ({ proposal, projectId, readOnly, onChanged }) => {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [picking, setPicking] = useState(false);

  const photos = [...proposal.photos].sort((a, b) => a.sortOrder - b.sortOrder);

  const handleUpload = async (list: FileList | null) => {
    if (!list || !list.length) return;
    setUploading(true);
    let ok = 0;
    for (const f of Array.from(list)) {
      try {
        const { fileId } = await uploadProjectFile(projectId, f, 'proposal-photo', { sourceType: 'proposal', sourceId: proposal.id });
        await addProposalPhoto(proposal.id, fileId);
        ok++;
      } catch { /* keep going */ }
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = '';
    if (ok < list.length) toast(`Uploaded ${ok} of ${list.length} photos`, { type: ok ? 'warning' : 'error' });
    onChanged();
  };

  // Mirrors handleUpload's count-and-summarize: a per-row failure (a stale
  // fileId, or the proposal locking mid-pick) must not be swallowed silently
  // — the picker can select many rows in one go.
  const handlePick = async (rows: DocumentRow[]) => {
    let ok = 0;
    for (const row of rows) {
      try { await addProposalPhoto(proposal.id, row.id); ok++; } catch { /* keep going */ }
    }
    if (ok < rows.length) toast(`Added ${ok} of ${rows.length} photos`, { type: ok ? 'warning' : 'error' });
    if (ok > 0) onChanged();
  };

  const handleCaption = async (photo: ProposalPhoto, caption: string) => {
    try {
      await updateProposalPhoto(photo.id, photo.fileId, { caption: caption.trim() || null });
      onChanged();
    } catch (e) { handleProposalCardError(e, toast, onChanged, 'Failed to update caption'); }
  };

  // The two PATCHes are sequential rather than Promise.all'd: if the second
  // one fails, the server is left with one photo's sortOrder already moved —
  // onChanged() always runs (via finally) so the card resyncs to whatever
  // sortOrder the server actually ended up with, instead of showing a stale
  // (and now duplicate) local order.
  const handleMove = async (index: number, dir: -1 | 1) => {
    const cur = photos[index];
    const other = photos[index + dir];
    if (!other) return;
    try {
      await updateProposalPhoto(cur.id, cur.fileId, { sortOrder: other.sortOrder });
      await updateProposalPhoto(other.id, other.fileId, { sortOrder: cur.sortOrder });
    } catch (e) {
      toastProposalCardError(e, toast, 'Failed to reorder photos');
    } finally {
      onChanged();
    }
  };

  const handleRemove = async (photo: ProposalPhoto) => {
    try {
      await removeProposalPhoto(proposal.id, photo.fileId);
      onChanged();
    } catch (e) { handleProposalCardError(e, toast, onChanged, 'Failed to remove photo'); }
  };

  return (
    <Card data-testid="proposal-photos">
      <CardHeader
        title="Photos"
        actions={!readOnly && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
              <Camera size={14} />{uploading ? 'Uploading…' : 'Upload photos'}
            </Button>
            <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={e => handleUpload(e.target.files)} />
            <Button variant="secondary" size="sm" onClick={() => setPicking(true)}>
              <FolderOpen size={14} />Choose existing
            </Button>
          </div>
        )}
      />
      <CardBody>
        {photos.length === 0 ? (
          <p className="text-sm text-ink-faint">No photos. Appended to the end of the generated proposal.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {photos.map((photo, i) => (
              <PhotoTile
                key={photo.id}
                photo={photo}
                readOnly={readOnly}
                canMoveLeft={i > 0}
                canMoveRight={i < photos.length - 1}
                onCaptionCommit={caption => handleCaption(photo, caption)}
                onMove={dir => handleMove(i, dir)}
                onRemove={() => handleRemove(photo)}
              />
            ))}
          </div>
        )}
      </CardBody>
      <FilePickerModal
        open={picking}
        onClose={() => setPicking(false)}
        onPick={handlePick}
        accept="image"
        excludeFileIds={proposal.photos.map(p => p.fileId)}
        initialProjectIds={[projectId]}
        title="Choose photos"
      />
    </Card>
  );
};
