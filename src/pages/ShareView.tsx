import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getShareInfo } from '../utils/store';

export const ShareView: React.FC = () => {
  const { shareId } = useParams<{ shareId: string }>();
  const [info, setInfo] = useState<{ type: string; name: string; count?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!shareId) return;
    getShareInfo(shareId)
      .then(setInfo)
      .catch(() => setError('This share link is invalid or has expired.'));
  }, [shareId]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-100 dark:bg-slate-950">
        <div className="text-center space-y-3">
          <p className="text-lg font-semibold text-slate-700 dark:text-slate-300">{error}</p>
        </div>
      </div>
    );
  }

  if (!info) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-100 dark:bg-slate-950">
        <div className="w-8 h-8 border-4 border-accent-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // ── Multi-page share ──────────────────────────────────────────────────────
  if (info.type === 'pages' && info.count) {
    const pages = Array.from({ length: info.count }, (_, i) => i);
    return (
      <div className="min-h-screen flex flex-col bg-slate-100 dark:bg-slate-950">
        <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-3 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 shadow-sm">
          <div>
            <h1 className="font-semibold text-slate-800 dark:text-slate-200 truncate">{info.name}</h1>
            <p className="text-xs text-slate-500 dark:text-slate-400">{info.count} page{info.count !== 1 ? 's' : ''}</p>
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
  return (
    <div className="min-h-screen flex flex-col bg-slate-100 dark:bg-slate-950">
      <div className="flex items-center justify-between px-6 py-3 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 shadow-sm">
        <h1 className="font-semibold text-slate-800 dark:text-slate-200 truncate">{info.name}</h1>
        <a
          href={fileUrl}
          download={info.name}
          className="flex items-center gap-2 px-4 py-2 bg-accent-600 hover:bg-accent-700 text-white text-sm font-medium rounded-xl transition-colors"
        >
          Download
        </a>
      </div>
      <div className="flex-1">
        {info.type === 'printout' ? (
          <iframe
            src={fileUrl}
            className="w-full h-full border-0"
            style={{ minHeight: 'calc(100vh - 57px)' }}
            title={info.name}
          />
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
    <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-lg overflow-hidden border border-slate-200 dark:border-slate-700">
      <div className="px-5 py-3 border-b border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
        <span className="text-sm font-semibold text-slate-700 dark:text-slate-300">{label}</span>
      </div>
      <div className="flex items-center justify-center bg-slate-50 dark:bg-slate-800/30 p-2">
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
