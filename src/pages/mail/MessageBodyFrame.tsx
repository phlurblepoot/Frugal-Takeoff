// src/pages/mail/MessageBodyFrame.tsx — one message's HTML body, rendered
// inside a sandboxed iframe (spec §5.2 / §7).
//
// The body has already been sanitized on the server (DOMPurify on jsdom); the
// iframe is the second wall. `allow-same-origin` is deliberately NOT granted,
// so the frame is an opaque origin: it cannot read the app's DOM, cookies or
// localStorage. `allow-scripts` is granted for exactly one script — the
// height reporter injected below, allowed by a per-render nonce in the CSP,
// which is why 'unsafe-inline' never appears there. `allow-popups(-to-escape-
// sandbox)` is what lets `<base target="_blank">` links actually open.
//
// Email bodies stay on a light background in dark mode: every mail client does
// this, and re-theming sender HTML wrecks it.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { Skeleton } from '../../components/ui';
import { mailApi } from '../../utils/mailApi';
import type { BodyPayload } from './types';

/** Tallest frame we will grow to; past this the body scrolls inside itself. */
const MAX_HEIGHT = 20000;
const MIN_HEIGHT = 80;

// A just-sent message whose provider copy has not been filed yet answers 202.
// The thread's live refresh does not remount this component (same message id),
// so the placeholder has to come back for its own answer.
const PENDING_RETRY_MS = 15000;
const PENDING_RETRIES = 8;

/** Runs inside the opaque-origin frame — its only job is to report height. */
const heightScript = `
(function () {
  var last = 0;
  function report() {
    var h = Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0
    );
    if (h === last) return;
    last = h;
    parent.postMessage({ type: 'mail-frame-height', height: h }, '*');
  }
  window.addEventListener('load', report);
  window.addEventListener('resize', report);
  document.addEventListener('load', report, true);
  setTimeout(report, 0);
  setTimeout(report, 300);
  setTimeout(report, 1500);
})();
`.trim();

export function buildFrameDoc(html: string, nonce: string, origin: string): string {
  const csp = `default-src 'none'; img-src ${origin} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'`;
  return [
    '<!doctype html><html><head>',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<base target="_blank">',
    '<style>',
    'html,body{margin:0}',
    'body{font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#111;background:#fff;',
    'word-break:break-word;overflow-wrap:anywhere;padding:12px}',
    'img{max-width:100%;height:auto}',
    'table{max-width:100%}',
    'blockquote{margin:0 0 0 .75rem;padding-left:.75rem;border-left:2px solid #ddd;color:#555}',
    'a{color:#0b57d0}',
    '</style></head><body>',
    html,
    `<script nonce="${nonce}">${heightScript}</` + 'script>',
    '</body></html>',
  ].join('');
}

export const MessageBodyFrame: React.FC<{ messageId: string }> = ({ messageId }) => {
  const [payload, setPayload] = useState<BodyPayload | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showImages, setShowImages] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [height, setHeight] = useState(MIN_HEIGHT);
  const frameRef = useRef<HTMLIFrameElement>(null);

  // Remote images are a per-message opt-in, so a new message re-blocks them.
  useEffect(() => {
    setShowImages(false);
    setAttempt(0);
  }, [messageId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    mailApi
      .body(messageId, { images: showImages })
      .then(res => {
        if (cancelled) return;
        if (res && (res as { pending?: boolean }).pending) {
          setPending(true);
          setPayload(null);
        } else {
          setPending(false);
          setPayload(res as BodyPayload);
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Failed to load message');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [messageId, showImages, attempt]);

  useEffect(() => {
    if (!pending || attempt >= PENDING_RETRIES) return;
    const t = setTimeout(() => setAttempt(a => a + 1), PENDING_RETRY_MS);
    return () => clearTimeout(t);
  }, [pending, attempt]);

  // A fresh nonce per document: a nonce that repeats across renders would let
  // any inline script that ever slipped past the sanitizer keep running.
  const doc = useMemo(
    () => (payload ? buildFrameDoc(payload.html, uuidv4(), window.location.origin) : null),
    [payload],
  );

  // Reset the height with the document so a short message after a long one
  // does not keep the tall frame.
  useEffect(() => {
    setHeight(MIN_HEIGHT);
  }, [doc]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // Only our own frame is believed — any other window (including a nested
      // frame the body tried to open) is ignored.
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const data = e.data as { type?: string; height?: unknown } | null;
      if (!data || typeof data !== 'object' || data.type !== 'mail-frame-height') return;
      const h = Number(data.height);
      if (!Number.isFinite(h) || h <= 0) return;
      setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(h))));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const loadImages = useCallback(() => setShowImages(true), []);

  if (loading && !payload && !pending && !error) {
    return (
      <div data-testid="mail-body-loading" className="space-y-2 py-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }

  if (pending) {
    return (
      <p data-testid="mail-body-pending" className="rounded-lg border border-edge bg-sunken px-3 py-2 text-sm text-ink-faint">
        Sending… this message is still being filed by the mail server. It will appear here in a minute.
      </p>
    );
  }

  if (error) {
    return (
      <p data-testid="mail-body-error" className="rounded-lg border border-edge bg-sunken px-3 py-2 text-sm text-ink-faint">
        {error}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {!!payload && payload.blockedRemoteImages > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
          <ImageOff size={14} className="shrink-0" />
          <span>Remote images blocked</span>
          <button
            type="button"
            onClick={loadImages}
            className="rounded px-1.5 py-0.5 font-medium underline underline-offset-2 hover:bg-amber-100 dark:hover:bg-amber-500/20"
          >
            Load images
          </button>
        </div>
      )}

      {doc !== null && (
        <iframe
          ref={frameRef}
          data-testid="mail-body-frame"
          title="Message"
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
          srcDoc={doc}
          style={{ height: `${height}px` }}
          className="w-full rounded-lg border border-edge bg-white"
        />
      )}
    </div>
  );
};
