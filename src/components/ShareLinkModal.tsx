import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Copy, Check, X, Link as LinkIcon } from 'lucide-react';
import QRCode from 'qrcode';
import { useToast } from './Toast';

interface ShareTarget {
  url: string;
  title?: string;
}

type ShareFn = (url: string, title?: string) => void;

const ShareContext = createContext<ShareFn>(() => {});

export const ShareProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [target, setTarget] = useState<ShareTarget | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();

  const share = useCallback<ShareFn>((url, title) => {
    setCopied(false);
    setQrDataUrl('');
    setTarget({ url, title });
  }, []);

  const close = useCallback(() => setTarget(null), []);

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    QRCode.toDataURL(target.url, { width: 220, margin: 1 })
      .then((d) => { if (!cancelled) setQrDataUrl(d); })
      .catch(() => { /* QR is a nice-to-have; the link still works without it */ });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => { cancelled = true; window.removeEventListener('keydown', onKey); };
  }, [target, close]);

  const handleCopy = async () => {
    if (!target) return;
    try {
      await navigator.clipboard.writeText(target.url);
      setCopied(true);
      toast('Link copied to clipboard', { type: 'success' });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast('Press Ctrl/Cmd+C to copy the selected link', { type: 'info' });
    }
  };

  return (
    <ShareContext.Provider value={share}>
      {children}
      <AnimatePresence>
        {target && (
          <motion.div
            className="fixed inset-0 z-[300] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={close}
            role="dialog"
            aria-modal="true"
            aria-label="Share link"
          >
            <motion.div
              className="w-full max-w-sm bg-white dark:bg-slate-800 rounded-2xl shadow-xl border border-slate-200 dark:border-slate-700 overflow-hidden"
              initial={{ opacity: 0, scale: 0.95, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 12 }}
              transition={{ duration: 0.18 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="p-6 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between">
                <h2 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <LinkIcon size={18} className="text-accent-600" />
                  {target.title || 'Share link'}
                </h2>
                <button onClick={close} aria-label="Close" className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-all">
                  <X size={18} />
                </button>
              </div>
              <div className="p-6 flex flex-col items-center gap-4">
                <div className="w-[180px] h-[180px] flex items-center justify-center rounded-xl bg-white p-2 border border-slate-200 dark:border-slate-600">
                  {qrDataUrl
                    ? <img src={qrDataUrl} alt="QR code linking to the shared resource" className="w-full h-full" />
                    : <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-accent-600" />}
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 text-center">Scan with a phone camera to open on another device.</p>
                <div className="w-full flex items-center gap-2">
                  <input
                    readOnly
                    value={target.url}
                    onFocus={(e) => e.currentTarget.select()}
                    aria-label="Share URL"
                    className="flex-1 min-w-0 px-3 py-2 rounded-xl border border-slate-300 dark:border-slate-600 dark:bg-slate-900/50 dark:text-white text-sm font-mono truncate"
                  />
                  <button
                    onClick={handleCopy}
                    className="shrink-0 px-3 py-2 rounded-xl bg-accent-600 text-white text-sm font-medium hover:bg-accent-700 transition-all flex items-center gap-1.5"
                  >
                    {copied ? <Check size={16} /> : <Copy size={16} />}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </ShareContext.Provider>
  );
};

// useShareLink()(url, title) pops a styled modal with a copy button and a QR code.
export const useShareLink = () => useContext(ShareContext);
