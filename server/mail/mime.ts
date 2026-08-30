import { v4 as uuidv4 } from 'uuid';
import type { Addr } from './providers/types';

const ADDR_RE = /^\s*(?:"?([^"<]*)"?\s*)?<([^>]+)>\s*$|^\s*([^\s<>@]+@[^\s<>]+)\s*$/;
export function parseAddress(s: string): Addr | null {
  const m = ADDR_RE.exec(s || '');
  if (!m) return null;
  if (m[2]) { const name = (m[1] || '').trim(); return name ? { addr: m[2].trim().toLowerCase(), name } : { addr: m[2].trim().toLowerCase() }; }
  return { addr: m[3].trim().toLowerCase() };
}
export function parseAddressList(s: string): Addr[] {
  return (s || '').split(/[,;]/).map(parseAddress).filter((a): a is Addr => !!a);
}
export function formatAddress(a: Addr): string {
  return a.name ? `"${a.name.replace(/"/g, '')}" <${a.addr}>` : a.addr;
}
export function htmlToText(html: string): string {
  return (html || '')
    .replace(/<\s*(br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .split('\n').map(l => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
export function newMessageIdHeader(domain: string): string {
  return `${uuidv4()}@${(domain || 'localhost').toLowerCase()}`;
}
// Keeps only the author's own words: cuts at "On … wrote:", an Outlook
// "From:" header block, or the first run of '>'-quoted lines. Never returns
// an empty string — a reply that is ALL quote comes back untouched.
export function stripQuotedReply(text: string): string {
  const lines = (text || '').replace(/\r\n/g, '\n').split('\n');
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (/^on .+wrote:$/i.test(l) || /^-{2,}\s*original message\s*-{2,}$/i.test(l) || /^from:\s.+/i.test(l) || l.startsWith('>')) { cut = i; break; }
  }
  const out = lines.slice(0, cut).join('\n').trim();
  return out || (text || '').trim();
}
export function snippetOf(text: string): string {
  return (text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}
