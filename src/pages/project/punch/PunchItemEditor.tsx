// src/pages/project/punch/PunchItemEditor.tsx
import React, { useState, useRef } from 'react';
import { Camera, Trash2 } from 'lucide-react';
import {
  PunchItem, savePunchItem, setPunchDone, addPunchPhoto, removePunchPhoto,
  uploadProjectFile, getImageUrl,
} from '../../../utils/store';
import { useToast } from '../../../components/Toast';
import { Button, Field, Input, Modal, Textarea } from '../../../components/ui';

interface Props {
  item: PunchItem;
  projectId: string;
  onClose: () => void;
  onSaved: () => void;
}

const STAGES: { stage: string; label: string }[] = [
  { stage: 'before', label: 'Before' },
  { stage: 'during', label: 'During' },
  { stage: 'after', label: 'After' },
];

export const PunchItemEditor: React.FC<Props> = ({ item, projectId, onClose, onSaved }) => {
  const { toast } = useToast();
  const [area, setArea] = useState(item.area ?? '');
  const [description, setDescription] = useState(item.description ?? '');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const dirty = area !== item.area || description !== item.description;

  const handlePhotos = async (stage: string, list: FileList | null) => {
    if (!list || !list.length) return;
    setUploading(true);
    let ok = 0;
    for (const f of Array.from(list)) {
      try {
        const fileId = await uploadProjectFile(projectId, f, 'punch');
        await addPunchPhoto(item.id, fileId, stage);
        ok++;
      } catch { /* keep going */ }
    }
    setUploading(false);
    const ref = fileRefs.current[stage];
    if (ref) ref.value = '';
    if (ok < list.length) toast(`Uploaded ${ok} of ${list.length} photos`, { type: ok ? 'warning' : 'error' });
    onSaved(); // reload the item → photos appear
  };

  const dropPhoto = async (fileId: string) => {
    try { await removePunchPhoto(item.id, fileId); onSaved(); } catch { toast('Failed to remove photo', { type: 'error' }); }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await savePunchItem(item.id, { ...item, area, description });
      toast('Punch item saved', { type: 'success' });
      onSaved();
    } catch (e) {
      toast(e instanceof Error && e.name === 'ConflictError' ? 'This item changed elsewhere — reload' : 'Save failed', { type: 'error' });
    } finally { setSaving(false); }
  };

  const toggleDone = async () => {
    if (dirty) { toast('Save your changes first', { type: 'warning' }); return; }
    try { await setPunchDone(item.id, !item.done); onSaved(); } catch { toast('Failed to update item', { type: 'error' }); }
  };

  return (
    <Modal open onClose={onClose} title="Punch item" width="lg"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        <Button onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
      </>}
    >
      <div className="mb-3 flex items-center gap-2">
        <Button variant={item.done ? 'secondary' : 'primary'} size="sm" onClick={toggleDone}>
          {item.done ? 'Done' : 'Mark done'}
        </Button>
      </div>
      <Field label="Area" htmlFor="punch-area"><Input id="punch-area" value={area} onChange={e => setArea(e.target.value)} /></Field>
      <div className="mt-3">
        <Field label="Description" htmlFor="punch-desc"><Textarea id="punch-desc" value={description} onChange={e => setDescription(e.target.value)} rows={4} /></Field>
      </div>
      {STAGES.map(({ stage, label }) => {
        const photos = item.photos.filter(p => p.stage === stage);
        return (
          <div key={stage} className="mt-4 border-t border-edge pt-3">
            <div className="mb-2 flex items-center justify-between">
              <h4 className="text-sm font-semibold text-ink">{label}</h4>
              <Button variant="secondary" size="sm" onClick={() => fileRefs.current[stage]?.click()} disabled={uploading}>
                <Camera size={14} />{uploading ? 'Uploading…' : 'Add photos'}
              </Button>
              {/* capture="environment" opens the rear camera on mobile (spec §4.3 field use) */}
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
                      className="absolute right-1 top-1 flex min-h-9 min-w-9 items-center justify-center rounded-md bg-black/50 p-1 text-white opacity-100 transition-opacity focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100">
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
