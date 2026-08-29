// src/components/documents/VersionOrOverwriteDialog.tsx
// Regenerating a document that already exists is a fork in the road: keep the
// old bytes as history (the server's default upsert-by-source behavior) or
// replace the current version in place. Asking beats guessing — an emailed
// document the client already has shouldn't silently change under them, and a
// typo fix shouldn't pile up versions (spec
// docs/superpowers/specs/2026-08-29-document-actions-rollout).
import React, { useEffect, useRef } from 'react';
import { Button, Modal } from '../ui';

export const VersionOrOverwriteDialog: React.FC<{
  open: boolean;
  fileName: string;
  versionNumber: number;
  onChoose: (mode: 'version' | 'overwrite') => void;
  onCancel: () => void;
}> = ({ open, fileName, versionNumber, onChoose, onCancel }) => {
  // Versioning is the safe default, so it gets focus — Enter keeps history.
  const versionRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (open) versionRef.current?.focus(); }, [open]);

  if (!open) return null;

  return (
    <Modal
      open
      onClose={onCancel}
      title="Replace the existing PDF?"
      width="md"
      footer={
        <>
          <Button variant="ghost" data-testid="doc-version-cancel" onClick={onCancel}>Cancel</Button>
          <Button variant="secondary" data-testid="doc-version-overwrite" onClick={() => onChoose('overwrite')}>
            Overwrite
          </Button>
          <Button ref={versionRef} data-testid="doc-version-new" onClick={() => onChoose('version')}>
            Save as new version
          </Button>
        </>
      }
    >
      <p className="text-sm text-ink-soft">
        {fileName} already exists (version {versionNumber}). Save the new PDF as version{' '}
        {versionNumber + 1}, or overwrite it?
      </p>
    </Modal>
  );
};
