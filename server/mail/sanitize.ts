// server/mail/sanitize.ts (spec §4.3, §7)
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';

const window = new JSDOM('').window as unknown as Window & typeof globalThis;
const purify = createDOMPurify(window);

// NOTE: dompurify's persisted `setConfig()` does not merge correctly with a
// per-call `RETURN_DOM: true` option (the sanitize() call falls back to
// returning a string instead of a DOM node). Pass the full config on every
// call instead of pre-setting it via setConfig().
const SANITIZE_CONFIG = {
  RETURN_DOM: true as const,
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'link', 'meta', 'base', 'svg', 'math'],
  FORBID_ATTR: ['srcset', 'ping', 'formaction', 'xlink:href'],
  ALLOW_DATA_ATTR: false,
  ADD_ATTR: ['target'],
};

const REMOTE = /^(https?:)?\/\//i;

export function sanitizeEmailHtml(
  html: string,
  opts: { attachmentUrl: (contentId: string) => string | null; allowRemoteImages: boolean }
): { html: string; blockedRemoteImages: number } {
  let blocked = 0;
  const clean = purify.sanitize(html || '', SANITIZE_CONFIG) as unknown as HTMLElement;
  const doc = clean.ownerDocument!;
  clean.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (src.toLowerCase().startsWith('cid:')) {
      const url = opts.attachmentUrl(src.slice(4).replace(/^<|>$/g, ''));
      if (url) img.setAttribute('src', url);
      else img.remove();
    } else if (REMOTE.test(src)) {
      if (!opts.allowRemoteImages) {
        img.removeAttribute('src');
        img.setAttribute('data-blocked-src', src);
        blocked++;
      }
    } else if (!src.startsWith('data:image/')) {
      img.remove();
    }
  });
  clean.querySelectorAll<HTMLElement>('[style]').forEach((el) => {
    const style = el.getAttribute('style') || '';
    if (/url\s*\(/i.test(style)) {
      if (!opts.allowRemoteImages && REMOTE.test(style.replace(/.*url\s*\(\s*['"]?/i, ''))) blocked++;
      el.setAttribute('style', style.replace(/[a-z-]*\s*:\s*[^;]*url\s*\([^)]*\)[^;]*;?/gi, ''));
    }
  });
  clean.querySelectorAll('a').forEach((a) => {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });
  const wrapper = doc.createElement('div');
  wrapper.append(...Array.from(clean.childNodes));
  return { html: wrapper.innerHTML, blockedRemoteImages: blocked };
}
