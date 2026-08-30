import { describe, it, expect } from 'vitest';
import { sanitizeEmailHtml } from './sanitize';

const opts = { attachmentUrl: (cid: string) => (cid === 'img1' ? '/api/mail/messages/m/attachments/a1?inline=1' : null), allowRemoteImages: false };

describe('sanitizeEmailHtml', () => {
  it('drops scripts, forms, iframes and event handlers', () => {
    const r = sanitizeEmailHtml('<p onclick="x()">hi</p><script>bad()</script><form><input></form><iframe src="x"></iframe>', opts);
    expect(r.html).toBe('<p>hi</p>');
  });
  it('rewrites cid: images to the attachment route and blocks remote ones', () => {
    const r = sanitizeEmailHtml('<img src="cid:img1"><img src="https://t.example/p.png"><div style="background:url(https://t.example/b.png)">x</div>', opts);
    expect(r.html).toContain('src="/api/mail/messages/m/attachments/a1?inline=1"');
    expect(r.html).toContain('data-blocked-src="https://t.example/p.png"');
    expect(r.html).not.toContain('<img src="https://t.example/p.png"');
    expect(r.html).not.toContain('url(https://t.example/b.png)');
    expect(r.blockedRemoteImages).toBe(2);
  });
  it('keeps remote images when allowed', () => {
    const r = sanitizeEmailHtml('<img src="https://t.example/p.png">', { ...opts, allowRemoteImages: true });
    expect(r.html).toContain('src="https://t.example/p.png"'); expect(r.blockedRemoteImages).toBe(0);
  });
  it('forces links to open safely', () => {
    const r = sanitizeEmailHtml('<a href="https://x.y" target="_self">l</a><a href="javascript:alert(1)">j</a>', opts);
    expect(r.html).toContain('target="_blank"'); expect(r.html).toContain('rel="noopener noreferrer"'); expect(r.html).not.toContain('javascript:');
  });
  it('drops unknown cid: images', () => {
    expect(sanitizeEmailHtml('<img src="cid:nope">', opts).html).not.toContain('<img');
  });
});
