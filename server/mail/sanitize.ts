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
  FORBID_ATTR: ['srcset', 'ping', 'formaction', 'xlink:href'],   // dynsrc/lowsrc are not on DOMPurify's allowlist at all, so they never survive
  ALLOW_DATA_ATTR: false,
  ADD_ATTR: ['target'],
};

const REMOTE = /^(https?:)?\/\//i;
// Every attribute that makes the renderer fetch a URL on its own — not just img[src].
// `background` (any element) and `video[poster]` are on DOMPurify's allowlist and would
// otherwise leak a tracking pixel's worth of "this mail was opened" to the sender;
// dynsrc/lowsrc are legacy IE aliases DOMPurify already strips, listed here so a future
// config change can't quietly re-admit them.
const REMOTE_FETCH_ATTRS = ['src', 'background', 'poster', 'dynsrc', 'lowsrc'] as const;
// `img` is in the selector on its own so a srcless <img> is still dropped, as before.
const REMOTE_ATTR_SELECTOR = ['img', ...REMOTE_FETCH_ATTRS.map(a => `[${a}]`)].join(',');

export function sanitizeEmailHtml(
  html: string,
  opts: { attachmentUrl: (contentId: string) => string | null; allowRemoteImages: boolean }
): { html: string; blockedRemoteImages: number } {
  let blocked = 0;
  const clean = purify.sanitize(html || '', SANITIZE_CONFIG) as unknown as HTMLElement;
  const doc = clean.ownerDocument!;
  clean.querySelectorAll<HTMLElement>(REMOTE_ATTR_SELECTOR).forEach((el) => {
    const isImg = el.tagName.toLowerCase() === 'img';
    // Dropping the whole element is right for <img> (an empty img is a broken-image
    // icon); for a <table background> or <video poster> only the attribute goes.
    const drop = () => { if (isImg) el.remove(); else REMOTE_FETCH_ATTRS.forEach(a => el.removeAttribute(a)); };
    if (isImg && el.getAttribute('src') == null) { el.remove(); return; }
    for (const attr of REMOTE_FETCH_ATTRS) {
      const value = el.getAttribute(attr);
      if (value == null) continue;
      if (value.toLowerCase().startsWith('cid:')) {
        const url = opts.attachmentUrl(value.slice(4).replace(/^<|>$/g, ''));
        if (url) el.setAttribute(attr, url);
        else { drop(); return; }
      } else if (REMOTE.test(value)) {
        if (!opts.allowRemoteImages) {
          el.removeAttribute(attr);
          el.setAttribute(`data-blocked-${attr}`, value);
          blocked++;
        }
      } else if (!value.startsWith('data:image/')) {
        drop(); return;
      }
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
