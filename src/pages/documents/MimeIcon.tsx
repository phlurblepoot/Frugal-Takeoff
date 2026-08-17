// src/pages/documents/MimeIcon.tsx
// Mime-type glyph for a document row. Lived inside DocumentsTable until the
// preview work (hover card + viewer modal) needed the same mapping at larger
// sizes — moved here so the preview components don't have to import from the
// table that renders them.
import React from 'react';
import { File, FileText, Image as ImageIcon, Sheet } from 'lucide-react';
import { openTargetFor } from './openTarget';

export const MimeIcon: React.FC<{ mime: string; size?: number; className?: string }> = ({
  mime, size = 15, className = 'shrink-0 text-ink-faint',
}) => {
  const { type } = openTargetFor({ id: '', mime });
  const props = { size, className };
  if (type === 'pdf') return <FileText {...props} />;
  if (type === 'sheet') return <Sheet {...props} />;
  if (type === 'image') return <ImageIcon {...props} />;
  return <File {...props} />;
};
