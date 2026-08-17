// src/pages/documents/openTarget.ts
// Extracted from the retired ProjectDocuments.tsx (spec §Client) — shared
// logic for turning a stored file into either an in-app editor route, a raw
// image view, or a plain download, based on its mime type.

const SHEET_MIMES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
];

// Generic direct-upload kind inferred from a file's mime type. Only relevant
// for direct uploads — program-generated files carry their own canonical
// kind (invoice, issue-report, etc.) instead of this.
export const kindFromMime = (mime: string): string => {
  if (mime === 'application/pdf') return 'document';
  if (SHEET_MIMES.includes(mime)) return 'spreadsheet';
  if (mime.startsWith('image/')) return 'photo';
  return 'other';
};

export type OpenTargetType = 'pdf' | 'sheet' | 'image' | 'download';

export const openTargetFor = (f: { id: string; mime: string }): { type: OpenTargetType; url: string | null } => {
  if (f.mime === 'application/pdf') return { type: 'pdf', url: `/tools/pdf?fileId=${f.id}` };
  if (SHEET_MIMES.includes(f.mime)) return { type: 'sheet', url: `/tools/sheets?fileId=${f.id}` };
  if (f.mime.startsWith('image/')) return { type: 'image', url: `/api/images/${f.id}/raw` };
  return { type: 'download', url: null };
};
