// src/components/documents/DocumentStatusChip.tsx
// "Does this record already have a generated document, and is it current?" —
// the one-glance half of DocumentActionsBar (spec
// docs/superpowers/specs/2026-08-29-document-actions-rollout). Pure display:
// the caller owns the useGeneratedDocument state.
import React from 'react';
import { GeneratedDoc } from '../../utils/store';
import { StatusPill } from '../ui';

export type DocFormat = 'pdf' | 'xlsx';

export const FORMAT_WORD: Record<DocFormat, string> = { pdf: 'PDF', xlsx: 'Excel' };

export const DocumentStatusChip: React.FC<{
  file: GeneratedDoc | null;
  upToDate: boolean | null;
  format?: DocFormat;
  size?: 'sm';
}> = ({ file, upToDate, format = 'pdf', size }) => {
  const word = FORMAT_WORD[format];
  // upToDate is null exactly when there is no file (see isUpToDate), but key
  // off `file` so a caller passing one without the other still reads right.
  const { tone, label } = !file
    ? { tone: 'slate' as const, label: `No ${word} yet` }
    : upToDate
      ? { tone: 'emerald' as const, label: `${word} up to date` }
      : { tone: 'amber' as const, label: `${word} out of date` };

  return <StatusPill tone={tone} className={size === 'sm' ? 'px-2 py-0' : ''}>{label}</StatusPill>;
};
