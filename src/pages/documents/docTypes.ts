// src/pages/documents/docTypes.ts
// kind -> {label, tone} for the Documents page's Type badge and Type filter.
// Mirrors the canonical kind vocabulary in server/documents.ts's KIND_LABELS
// (spec §Data model), but owns its own presentation (tone) since the server
// has no UI concerns. Custom admin-defined kinds are `custom:<id>` — their
// label lives in settings.documentTypes, not here.
import type { PillTone } from '../../components/ui';

export interface CustomDocType {
  id: string;
  label: string;
}

interface KindMeta { label: string; tone: PillTone; }

const KIND_META: Record<string, KindMeta> = {
  document:             { label: 'Document',          tone: 'slate' },
  spreadsheet:          { label: 'Spreadsheet',        tone: 'green' },
  photo:                { label: 'Photo',              tone: 'slate' },
  other:                { label: 'Other',              tone: 'slate' },
  proposal:             { label: 'Proposal',           tone: 'blue' },
  'proposal-photo':     { label: 'Proposal Photo',     tone: 'blue' },
  printout:             { label: 'Printout',           tone: 'slate' },
  'plan-source':        { label: 'Plan Set',           tone: 'slate' },
  invoice:              { label: 'Invoice',            tone: 'emerald' },
  'change-order':       { label: 'Change Order',       tone: 'amber' },
  'change-order-photo': { label: 'Change Order Photo', tone: 'amber' },
  'payapp-export':      { label: 'Pay App Export',     tone: 'emerald' },
  'issue-report':       { label: 'Issue',              tone: 'red' },
  'issue-photo':        { label: 'Issue Photo',        tone: 'red' },
  'punch-report':       { label: 'Punch Report',       tone: 'orange' },
  'punch-photo':        { label: 'Punch Photo',        tone: 'orange' },
  rfi:                  { label: 'RFI',                tone: 'violet' },
  'rfi-photo':           { label: 'RFI Photo',          tone: 'violet' },
  'rfi-response':        { label: 'RFI Response',       tone: 'violet' },
  'task-photo':          { label: 'Task Photo',         tone: 'blue' },
  'email-attachment':    { label: 'Email Attachment',   tone: 'slate' },
};

// Display order for the Type filter dropdown. 'plan' and 'settings-asset' are
// never returned by GET /api/documents (spec §Server "always excluded"), so
// they have no entry here.
export const KIND_OPTIONS: { id: string; label: string }[] = Object.keys(KIND_META)
  .map(id => ({ id, label: KIND_META[id].label }));

const customLabel = (kind: string, customTypes: CustomDocType[]): string | undefined => {
  if (!kind.startsWith('custom:')) return undefined;
  const id = kind.slice('custom:'.length);
  return customTypes.find(t => t.id === id)?.label;
};

export const kindLabel = (kind: string, customTypes: CustomDocType[] = []): string =>
  customLabel(kind, customTypes) ?? KIND_META[kind]?.label ?? kind;

export const kindTone = (kind: string): PillTone =>
  kind.startsWith('custom:') ? 'violet' : (KIND_META[kind]?.tone ?? 'slate');
