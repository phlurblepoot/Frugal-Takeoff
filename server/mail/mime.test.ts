import { describe, it, expect } from 'vitest';
import { parseAddressList, formatAddress, htmlToText, stripQuotedReply, snippetOf, newMessageIdHeader } from './mime';

describe('mime helpers', () => {
  it('parses display-name and bare addresses', () => {
    expect(parseAddressList('"Mike T" <m@x.com>, a@y.org; bad')).toEqual([{ addr: 'm@x.com', name: 'Mike T' }, { addr: 'a@y.org' }]);
  });
  it('formats with quotes only when a name exists', () => {
    expect(formatAddress({ addr: 'm@x.com', name: 'Mike' })).toBe('"Mike" <m@x.com>');
    expect(formatAddress({ addr: 'm@x.com' })).toBe('m@x.com');
  });
  it('htmlToText keeps line breaks for block elements and drops tags', () => {
    expect(htmlToText('<p>Hi<br>there</p><div>ok &amp; done</div>')).toBe('Hi\nthere\nok & done');
  });
  it('stripQuotedReply removes On … wrote:, > blocks and From: headers', () => {
    const t = 'Approved.\n\nOn Aug 25, 2026, Nathan wrote:\n> COR attached\n> thanks';
    expect(stripQuotedReply(t)).toBe('Approved.');
    expect(stripQuotedReply('Yes\n\nFrom: Nathan\nSent: x\n\noriginal')).toBe('Yes');
    expect(stripQuotedReply('> only quoted')).toBe('> only quoted');   // never returns empty
  });
  it('snippetOf collapses whitespace and caps at 200', () => {
    expect(snippetOf('a\n\n  b'.padEnd(500, 'x')).length).toBe(200);
  });
  it('newMessageIdHeader is bracket-free and lowercase', () => {
    expect(newMessageIdHeader('Bigbear.com')).toMatch(/^[0-9a-f-]{36}@bigbear\.com$/);
  });
});
