// src/hooks/useDropZone.ts
// The drag-and-drop half of every "add files" surface (FilePickerModal's
// Upload tab, and anything else that wants a drop target). Kept as a hook
// rather than a wrapper component so the caller keeps full control of the
// zone's markup — the hook only owns the highlight state and the accept
// filter.
import { useCallback, useRef, useState } from 'react';

// Same vocabulary as FilePickerModalProps['accept'] — the picker passes its
// own `accept` straight through, so if the two unions ever drift the call
// site fails to compile rather than silently letting the wrong files in.
export type DropAccept = 'pdf' | 'image' | 'spreadsheet' | 'any';

const SHEET_MIMES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
];

// Extension fallback: browsers hand over an empty `type` for some files
// (notably .csv and .xls from certain OS/browser pairs), and the MIME test
// alone would drop a file the user plainly meant to add.
export const matchesAccept = (file: File, accept: DropAccept = 'any'): boolean => {
  const name = file.name.toLowerCase();
  switch (accept) {
    case 'pdf': return file.type === 'application/pdf' || name.endsWith('.pdf');
    case 'image': return file.type.startsWith('image/');
    case 'spreadsheet': return SHEET_MIMES.includes(file.type) || /\.(xlsx|xls|csv)$/.test(name);
    default: return true;
  }
};

export interface DropZoneProps {
  onDragEnter: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}

export function useDropZone(
  onFiles: (files: File[]) => void,
  opts: { accept?: DropAccept; disabled?: boolean } = {},
): { dragActive: boolean; dropProps: DropZoneProps } {
  const { accept = 'any', disabled = false } = opts;
  const [dragActive, setDragActive] = useState(false);
  // Depth counter, not a boolean: dragging across a child element fires
  // dragleave on the parent, which would otherwise drop the highlight while
  // the pointer is still inside the zone.
  const depth = useRef(0);

  const block = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); };

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (disabled) return;
    block(e);
    depth.current += 1;
    setDragActive(true);
  }, [disabled]);

  // preventDefault here is what makes the element a legal drop target at all.
  const onDragOver = useCallback((e: React.DragEvent) => {
    if (disabled) return;
    block(e);
    setDragActive(true);
  }, [disabled]);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (disabled) return;
    block(e);
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragActive(false);
  }, [disabled]);

  const onDrop = useCallback((e: React.DragEvent) => {
    if (disabled) return;
    block(e);
    depth.current = 0;
    setDragActive(false);
    const files = Array.from(e.dataTransfer?.files ?? []).filter(f => matchesAccept(f, accept));
    // A drop of only rejected files is a no-op — callers shouldn't have to
    // guard against an empty batch.
    if (files.length) onFiles(files);
  }, [disabled, accept, onFiles]);

  return { dragActive, dropProps: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}
