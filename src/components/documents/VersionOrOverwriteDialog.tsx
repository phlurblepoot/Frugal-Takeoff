// src/components/documents/VersionOrOverwriteDialog.tsx
// Regenerating a document that already exists is a fork in the road: keep the
// old bytes as history (the server's default upsert-by-source behavior) or
// replace the current version in place. Asking beats guessing — an emailed
// document the client already has shouldn't silently change under them, and a
// typo fix shouldn't pile up versions (spec
// docs/superpowers/specs/2026-08-29-document-actions-rollout).
import React, { useEffect, useRef } from 'react';
import { Button, Modal } from '../ui';
import { DocFormat, FORMAT_WORD } from './DocumentStatusChip';

// The chip says "Excel"; a full sentence reads better with the noun spelled
// out, so the dialog widens the shared word rather than keeping a second map.
const noun = (format: DocFormat) => (format === 'xlsx' ? `${FORMAT_WORD[format]} file` : FORMAT_WORD[format]);

export const VersionOrOverwriteDialog: React.FC<{
  open: boolean;
  fileName: string;
  versionNumber: number;
  onChoose: (mode: 'version' | 'overwrite') => void;
  onCancel: () => void;
  format?: DocFormat;
  /** Matches the host bar's testIdPrefix so an editor with two bars stays addressable. */
  testIdPrefix?: string;
}> = ({ open, fileName, versionNumber, onChoose, onCancel, format = 'pdf', testIdPrefix = 'doc' }) => {
  // Versioning is the safe default, so it gets focus — Enter keeps history.
  const versionRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (open) versionRef.current?.focus(); }, [open]);

  if (!open) return null;

  const word = noun(format);
  const p = testIdPrefix;

  return (
    <Modal
      open
      onClose={onCancel}
      title={`Replace the existing ${word}?`}
      width="md"
      footer={
        <>
          <Button variant="ghost" data-testid={`${p}-version-cancel`} onClick={onCancel}>Cancel</Button>
          <Button variant="secondary" data-testid={`${p}-version-overwrite`} onClick={() => onChoose('overwrite')}>
            Overwrite
          </Button>
          <Button ref={versionRef} data-testid={`${p}-version-new`} onClick={() => onChoose('version')}>
            Save as new version
          </Button>
        </>
      }
    >
      <p className="text-sm text-ink-soft">
        {fileName} already exists (version {versionNumber}). Save the new {word} as version{' '}
        {versionNumber + 1}, or overwrite it?
      </p>
    </Modal>
  );
};
