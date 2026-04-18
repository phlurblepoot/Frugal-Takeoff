import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getShareInfo } from '../utils/store';

export const ShareView: React.FC = () => {
  const { shareId } = useParams<{ shareId: string }>();
  const [info, setInfo] = useState<{ type: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!shareId) return;
    getShareInfo(shareId)
      .then(setInfo)
      .catch(() => setError('This share link is invalid or has expired.'));
  }, [shareId]);

  const fileUrl = `/api/share/${shareId}`;

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
