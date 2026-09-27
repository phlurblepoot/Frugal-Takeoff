// src/pages/ShareView.tsx — /share/:shareId, the public page behind a share
// link. A shared file ONLYOFFICE can read (PDFs, Word, Excel…) shows in its
// embedded viewer, which works on phones too (ONLYOFFICE Phase 6); images,
// page sets, and anything when the viewer isn't set up keep the page's own
// preview. The Download button is always there.
import React, { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getShareInfo, openShareViewer } from '../utils/store';
import { OnlyofficeViewer } from '../components/OnlyofficeViewer';

export const ShareView: React.FC = () => {
  const { shareId } = useParams<{ shareId: string }>();
  const [info, setInfo] = useState<{ type: string; name: string; count?: number; viewer?: boolean } | null>(null);
  // The viewer said no after all (e.g. ONLYOFFICE unreachable): the page's own preview.
  const [viewerFailed, setViewerFailed] = useState(false);
  const loadViewer = useCallback(() => openShareViewer(shareId!, {
    device: window.matchMedia('(max-width: 767px)').matches ? 'phone' : 'desktop',
    theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
  }), [shareId]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!shareId) return;
    getShareInfo(shareId)
      .then(setInfo)
      .catch(() => setError('This share link is invalid or has expired.'));
  }, [shareId]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center space-y-3">
          <p className="text-lg font-semibold text-ink-soft">{error}</p>
        </div>
      </div>
    );
  }

  if (!info) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-accent-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // ── Multi-page share ──────────────────────────────────────────────────────
  if (info.type === 'pages' && info.count) {
    const pages = Array.from({ length: info.count }, (_, i) => i);
    return (
      <div className="min-h-screen flex flex-col">
        <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-3 glass-panel border-b border-edge">
          <div>
            <h1 className="font-semibold text-ink truncate">{info.name}</h1>
            <p className="text-xs text-ink-soft">{info.count} page{info.count !== 1 ? 's' : ''}</p>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto py-6 px-4 space-y-8 max-w-5xl mx-auto w-full">
          {pages.map((i) => (
            <PageCard key={i} shareId={shareId!} index={i} />
          ))}
        </div>
      </div>
    );
  }

  // ── Single file / printout share ─────────────────────────────────────────
  const fileUrl = `/api/share/${shareId}`;
  const downloadName = info.type === 'printout' && !info.name.toLowerCase().endsWith('.pdf')
    ? `${info.name}.pdf`
    : info.name;
  return (
    <div className="min-h-screen flex flex-col">
      <div className="flex items-center justify-between px-6 py-3 glass-panel border-b border-edge">
        <h1 className="font-semibold text-ink truncate">{info.name}</h1>
        <a
          href={fileUrl}
          download={downloadName}
          className="flex items-center gap-2 px-4 py-2 bg-accent-600 hover:bg-accent-700 text-white text-sm font-medium rounded-xl transition-colors"
        >
          Download
        </a>
      </div>
      <div className="flex-1">
        {info.viewer && !viewerFailed ? (
          <OnlyofficeViewer
            load={loadViewer}
            testId="share-viewer"
            className="h-[calc(100dvh-57px)] w-full"
            renderError={() => <ViewerFallback onShow={() => setViewerFailed(true)} />}
          />
        ) : info.type === 'printout' ? (
          <object
            data={fileUrl}
            type="application/pdf"
            className="w-full h-full border-0"
            style={{ minHeight: 'calc(100vh - 57px)' }}
            aria-label={info.name}
          >
            <div
              className="flex flex-col items-center justify-center gap-4 p-8 text-center"
              style={{ minHeight: 'calc(100vh - 57px)' }}
            >
              <p className="text-ink-soft">
                Your browser can't preview this PDF inline.
              </p>
              <a
                href={fileUrl}
                download={downloadName}
                className="px-5 py-2.5 bg-accent-600 hover:bg-accent-700 text-white rounded-xl font-medium text-sm transition-colors"
              >
                Download {downloadName}
              </a>
            </div>
          </object>
        ) : (
          <div className="flex items-center justify-center p-6 h-full">
            <img src={fileUrl} alt={info.name} className="max-w-full max-h-full rounded-xl shadow-xl" />
          </div>
        )}
      </div>
    </div>
  );
};

interface PageCardProps {
  shareId: string;
  index: number;
}

const PageCard: React.FC<PageCardProps> = ({ shareId, index }) => {
  const [meta, setMeta] = useState<{ name: string; pageNumber?: string } | null>(null);

  useEffect(() => {
    // Fetch the page list once from info — but we only get count there, not per-page names.
    // Instead we expose names via a separate lightweight endpoint by passing index.
    fetch(`/api/share/${shareId}/page-info/${index}`)
      .then(r => r.ok ? r.json() : null)
      .then(setMeta)
      .catch(() => setMeta({ name: `Page ${index + 1}` }));
  }, [shareId, index]);

  const imgUrl = `/api/share/${shareId}/image/${index}`;
  const label = meta?.pageNumber
    ? `${meta.pageNumber}${meta.name && meta.name !== meta.pageNumber ? ' — ' + meta.name : ''}`
    : meta?.name ?? `Page ${index + 1}`;

  return (
    <div className="rounded-2xl shadow-lg overflow-hidden border border-edge bg-raised">
      <div className="px-5 py-3 border-b border-edge bg-sunken">
        <span className="text-sm font-semibold text-ink-soft">{label}</span>
      </div>
      <div className="flex items-center justify-center bg-sunken p-2">
        <img
          src={imgUrl}
          alt={label}
          className="w-full rounded-xl"
          loading={index < 2 ? 'eager' : 'lazy'}
        />
      </div>
    </div>
  );
};

/** The viewer couldn't open: switch to the page's own preview straight away. */
const ViewerFallback: React.FC<{ onShow: () => void }> = ({ onShow }) => {
  useEffect(() => { onShow(); }, [onShow]);
  return null;
};
