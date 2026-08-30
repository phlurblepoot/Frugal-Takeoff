// server/mail/providers/google.test.ts
// Every Gmail call goes through an injected `fetch`, so the whole provider is
// exercised against recorded API shapes without a network or a real account.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { GmailProvider, googleRefresh } from './google';
import { TokenSource } from './tokenSource';
import { AuthExpiredError, RateLimitedError, ProviderNotFoundError } from './types';
import type { OutgoingMessage } from './types';

const fx = (n: string): any => JSON.parse(fs.readFileSync(fileURLToPath(new URL(`./__fixtures__/${n}`, import.meta.url)), 'utf8'));

type Route = [RegExp, (url: string, init: any) => unknown];
type FakeFetch = typeof fetch & { calls: Array<{ url: string; init: any }> };

function fakeFetch(routes: Route[]): FakeFetch {
  const calls: Array<{ url: string; init: any }> = [];
  const f = async (url: string, init: any = {}): Promise<Response> => {
    calls.push({ url, init });
    for (const [re, h] of routes) {
      if (!re.test(url)) continue;
      const r = h(url, init);
      return r instanceof Response ? r : new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{"error":{"message":"not found"}}', { status: 404 });
  };
  return Object.assign(f as unknown as typeof fetch, { calls });
}

const tokens = (): TokenSource => new TokenSource({ refreshToken: 'r', refresh: async () => ({ accessToken: 'AT', expiresInSec: 3600 }) });
const provider = (f: typeof fetch): GmailProvider => new GmailProvider(tokens(), { fetch: f, emailAddress: 'me@x' });

const outgoing = (): OutgoingMessage => ({
  from: { addr: 'me@x' }, to: [{ addr: 'y@z' }], cc: [], bcc: [],
  subject: 's', html: '<p>h</p>', text: 'h', attachments: [], messageIdHeader: 'mid@x',
});

describe('GmailProvider', () => {
  it('lists labels as folders with roles, hiding system categories', async () => {
    const f = fakeFetch([[/\/labels$/, () => fx('gmail-labels.json')]]);
    const folders = await provider(f).listFolders();

    expect(folders.find(x => x.providerId === 'INBOX')).toMatchObject({ name: 'Inbox', role: 'inbox', unreadCount: 7, totalCount: 4210 });
    expect(folders.find(x => x.providerId === 'SENT')!.role).toBe('sent');
    expect(folders.find(x => x.providerId === 'DRAFT')!.role).toBe('drafts');
    expect(folders.find(x => x.providerId === 'Label_12')!.name).toBe('Bids');
    expect(folders.find(x => x.providerId === 'Label_12')!.role).toBeNull();
    expect(folders.some(x => x.providerId.startsWith('CATEGORY_'))).toBe(false);
    expect(folders.some(x => x.providerId === 'UNREAD')).toBe(false);
    expect(folders.some(x => x.providerId === 'IMPORTANT' || x.providerId === 'CHAT')).toBe(false);
    // Inbox first regardless of the order the API listed the labels in.
    expect(folders[0].providerId).toBe('INBOX');
    expect(f.calls[0].init.headers.Authorization).toBe('Bearer AT');
  });

  it('backfill lists after the since date and maps full messages to envelopes', async () => {
    const f = fakeFetch([
      [/\/messages\?/, url => { expect(url).toMatch(/q=after%3A\d+/); return fx('gmail-list.json'); }],
      [/\/messages\/m1\?/, url => { expect(url).toMatch(/format=full/); return fx('gmail-message-full.json'); }],
      [/\/profile$/, () => fx('gmail-profile.json')],
    ]);
    const r = await provider(f).backfill({ since: new Date('2026-03-01T00:00:00.000Z') });

    expect(r.done).toBe(true);
    expect(r.cursor).toBeUndefined();
    const m = r.messages[0];
    expect(m).toMatchObject({
      providerMessageId: 'm1', providerThreadId: 't1',
      subject: 'Re: COR-4 Level 6 revisions',
      isRead: false, isStarred: true, isDraft: false,
      sizeBytes: 194823,
      folderProviderIds: expect.arrayContaining(['INBOX', 'STARRED']),
    });
    expect(m.messageIdHeader).toBe('cab9xyz.4.qm@mail.gmail.com');
    expect(m.inReplyTo).toBe('reply-2@teg.com');
    expect(m.references).toEqual(['root-1@bigbearplaster.com', 'reply-2@teg.com']);
    expect(m.from).toEqual({ addr: 'mike@teg.com', name: 'Mike Ross' });
    expect(m.to.map(a => a.addr)).toEqual(['me@x']);
    expect(m.cc.map(a => a.addr)).toEqual(['ap@teg.com', 'pm@teg.com']);
    expect(m.date).toBe(new Date(Number(fx('gmail-message-full.json').internalDate)).toISOString());
    expect(m.snippet).toContain('COR-4');
    expect(m.attachments.map(a => a.name)).toContain('COR-4.pdf');
    expect(m.attachments.find(a => a.contentId)).toMatchObject({ name: 'signature.png', contentId: 'ii_sig_001', mime: 'image/png' });
  });

  it('backfill pages through nextPageToken and reports done only on the last page', async () => {
    let page = 0;
    const f = fakeFetch([
      [/\/messages\?/, () => (page++ === 0 ? { ...fx('gmail-list.json'), nextPageToken: 'PT2' } : fx('gmail-list.json'))],
      [/\/messages\/m1\?/, () => fx('gmail-message-full.json')],
      [/\/profile$/, () => fx('gmail-profile.json')],
    ]);
    const p = provider(f);
    const first = await p.backfill({ since: new Date('2026-03-01T00:00:00.000Z') });
    expect(first).toMatchObject({ done: false, cursor: 'PT2' });
    const second = await p.backfill({ since: new Date('2026-03-01T00:00:00.000Z'), cursor: 'PT2' });
    expect(second.done).toBe(true);
    expect(f.calls.some(c => /pageToken=PT2/.test(c.url))).toBe(true);
  });

  it('incremental applies history, drops deleted ids from the refetch set, and advances historyId', async () => {
    const f = fakeFetch([
      [/\/history\?/, url => { expect(url).toMatch(/startHistoryId=1000/); return fx('gmail-history.json'); }],
      [/\/messages\/m2\?/, () => ({ ...fx('gmail-message-full.json'), id: 'm2', threadId: 't2' })],
    ]);
    const r = await provider(f).incremental({ historyId: '1000' });

    expect(r.upserts.map(u => u.providerMessageId)).toEqual(['m2']);
    expect(r.deletes).toEqual(['m0']);
    expect(r.state).toEqual({ historyId: '9999' });
    expect(r.reset).toBeFalsy();
    // m0 was deleted — it must never be refetched (that would 404 on a real account).
    expect(f.calls.some(c => /\/messages\/m0/.test(c.url))).toBe(false);
  });

  it('incremental with no stored historyId adopts the profile watermark without refetching', async () => {
    const f = fakeFetch([[/\/profile$/, () => fx('gmail-profile.json')]]);
    const r = await provider(f).incremental({});
    expect(r).toMatchObject({ upserts: [], deletes: [], state: { historyId: '1000' } });
  });

  it('incremental returns reset when Gmail has expired the history window', async () => {
    const f = fakeFetch([[/\/history\?/, () => new Response('{}', { status: 404 })]]);
    const r = await provider(f).incremental({ historyId: '1' });
    expect(r.reset).toBe(true);
    expect(r.state).toEqual({ historyId: null });
    expect(r.upserts).toEqual([]);
  });

  it('getBody decodes html/text; getAttachment streams decoded bytes', async () => {
    const f = fakeFetch([
      [/\/messages\/m1\?/, () => fx('gmail-message-full.json')],
      [/\/attachments\//, () => fx('gmail-attachment.json')],
    ]);
    const p = provider(f);
    const b = await p.getBody('m1');
    expect(b.html).toContain('<b>COR-4</b>');
    expect(b.text).toContain('Mike here');
    expect(b.attachments.map(a => a.name).sort()).toEqual(['COR-4.pdf', 'signature.png']);

    const pdf = b.attachments.find(a => a.name === 'COR-4.pdf')!;
    const a = await p.getAttachment('m1', pdf.attId);
    const chunks: Buffer[] = [];
    for await (const c of a.stream as AsyncIterable<Buffer>) chunks.push(c);
    expect(Buffer.concat(chunks).toString()).toBe('%PDF');
    expect(a.mime).toBe('application/pdf');
    expect(a.name).toBe('COR-4.pdf');
    expect(a.size).toBe(4);
  });

  it('getAttachment fetches the part list itself when getBody was never called', async () => {
    const f = fakeFetch([
      [/\/messages\/m1\?/, () => fx('gmail-message-full.json')],
      [/\/attachments\//, () => fx('gmail-attachment.json')],
    ]);
    const a = await provider(f).getAttachment('m1', 'ANGjdJ9x7QdVpk');
    expect(a.name).toBe('COR-4.pdf');
    await expect(provider(f).getAttachment('m1', 'nope')).rejects.toBeInstanceOf(ProviderNotFoundError);
  });

  it('flags/archive/trash/move use batchModify and the trash endpoint', async () => {
    const f = fakeFetch([[/batchModify$/, () => ({})], [/\/trash$/, () => ({})]]);
    const p = provider(f);
    await p.setFlags(['m1'], { read: true, starred: true });
    expect(await p.archive(['m1'])).toEqual([{ from: 'm1', to: 'm1' }]);
    expect(await p.trash(['m1'])).toEqual([{ from: 'm1', to: 'm1' }]);
    expect(await p.move(['m1'], 'Label_12')).toEqual([{ from: 'm1', to: 'm1' }]);

    const bodies = f.calls.filter(c => /batchModify/.test(c.url)).map(c => JSON.parse(c.init.body));
    expect(bodies[0]).toMatchObject({ ids: ['m1'], removeLabelIds: ['UNREAD'], addLabelIds: ['STARRED'] });
    expect(bodies[1]).toMatchObject({ ids: ['m1'], removeLabelIds: ['INBOX'], addLabelIds: [] });
    expect(bodies[2]).toMatchObject({ ids: ['m1'], addLabelIds: ['Label_12'], removeLabelIds: ['INBOX'] });
    expect(f.calls.some(c => /\/m1\/trash$/.test(c.url))).toBe(true);
  });

  it('unsetting flags inverts the label edits, and moving to TRASH uses the trash endpoint', async () => {
    const f = fakeFetch([[/batchModify$/, () => ({})], [/\/trash$/, () => ({})]]);
    const p = provider(f);
    await p.setFlags(['m1', 'm2'], { read: false, starred: false });
    expect(JSON.parse(f.calls[0].init.body)).toMatchObject({ ids: ['m1', 'm2'], addLabelIds: ['UNREAD'], removeLabelIds: ['STARRED'] });
    await p.setFlags(['m1'], {});
    expect(f.calls.length).toBe(1);                       // nothing to change → no request
    await p.move(['m1'], 'TRASH');
    expect(f.calls.some(c => /\/m1\/trash$/.test(c.url))).toBe(true);
    // Moving INTO the inbox must not strip the label it just added.
    await p.move(['m1'], 'INBOX');
    const last = JSON.parse(f.calls[f.calls.length - 1].init.body);
    expect(last).toMatchObject({ addLabelIds: ['INBOX'], removeLabelIds: [] });
  });

  it('send posts base64url raw, reads back the Message-ID Gmail assigned, and drafts round-trip', async () => {
    const f = fakeFetch([
      [/\/messages\/send$/, () => ({ id: 's1', threadId: 't9' })],
      [/\/messages\/s1\?/, () => ({ id: 's1', threadId: 't9', payload: { headers: [{ name: 'Message-ID', value: '<CAGmail.rewritten@mail.gmail.com>' }] } })],
      [/\/drafts$/, () => ({ id: 'd1', message: { id: 'dm1', threadId: 't5' } })],
      [/\/drafts\/d1$/, (_u, init) => (init.method === 'DELETE' ? new Response(null, { status: 204 }) : { id: 'd1', message: { id: 'dm2' } })],
    ]);
    const p = provider(f);
    const msg = outgoing();

    expect(await p.send(msg)).toEqual({ providerMessageId: 's1', providerThreadId: 't9', messageIdHeader: 'cagmail.rewritten@mail.gmail.com' });
    const sendBody = JSON.parse(f.calls[0].init.body);
    expect(sendBody.raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(sendBody.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()).toContain('Message-ID: <mid@x>');

    const d = await p.saveDraft(msg);
    expect(d.providerMessageId).toBe('draft:d1');
    expect(JSON.parse(f.calls[f.calls.length - 1].init.body).message.raw).toMatch(/^[A-Za-z0-9_-]+$/);

    expect(await p.saveDraft(msg, 'draft:d1')).toEqual({ providerMessageId: 'draft:d1' });
    expect(f.calls[f.calls.length - 1].init.method).toBe('PUT');

    await p.deleteDraft('draft:d1');
    expect(f.calls[f.calls.length - 1]).toMatchObject({ init: { method: 'DELETE' } });
  });

  it('send still succeeds when the Message-ID read-back fails', async () => {
    const f = fakeFetch([[/\/messages\/send$/, () => ({ id: 's1', threadId: 't9' })]]);   // the read-back 404s
    expect(await provider(f).send(outgoing())).toEqual({ providerMessageId: 's1', providerThreadId: 't9' });
  });

  it('saveDraft/deleteDraft resolve a synced draft by its message id', async () => {
    const f = fakeFetch([
      [/\/drafts\?/, () => ({ drafts: [{ id: 'd7', message: { id: 'dm7', threadId: 't7' } }] })],
      [/\/drafts\/d7$/, () => new Response(null, { status: 204 })],
      [/\/drafts$/, () => ({ id: 'd9', message: { id: 'dm9' } })],
    ]);
    const p = provider(f);
    await p.deleteDraft('dm7');
    expect(f.calls.some(c => /\/drafts\/d7$/.test(c.url) && c.init.method === 'DELETE')).toBe(true);
    // An id that is not a draft at all is already gone — no throw, no stray call.
    const before = f.calls.length;
    await p.deleteDraft('dm-unknown');
    expect(f.calls.slice(before).every(c => /\/drafts\?/.test(c.url))).toBe(true);
  });

  it('search appends a before: filter and maps the hits', async () => {
    const f = fakeFetch([
      [/\/messages\?/, url => { expect(url).toMatch(/q=cor-4\+before%3A2026%2F03%2F10/); return fx('gmail-list.json'); }],
      [/\/messages\/m1\?/, () => fx('gmail-message-full.json')],
    ]);
    const hits = await provider(f).search('cor-4', { before: new Date('2026-03-10T00:00:00.000Z'), limit: 25 });
    expect(hits.map(h => h.providerMessageId)).toEqual(['m1']);
    expect(f.calls[0].url).toMatch(/maxResults=25/);
  });

  it('401 → invalidate + retry once, then AuthExpiredError; 429 → RateLimitedError', async () => {
    let n = 0;
    const f = fakeFetch([[/\/labels$/, () => new Response('{}', { status: n++ < 5 ? 401 : 200 })]]);
    await expect(provider(f).listFolders()).rejects.toBeInstanceOf(AuthExpiredError);
    expect(n).toBe(2);

    let m = 0;
    const once = fakeFetch([[/\/labels$/, () => (m++ === 0 ? new Response('{}', { status: 401 }) : fx('gmail-labels.json'))]]);
    expect((await provider(once).listFolders()).length).toBeGreaterThan(0);
    expect(m).toBe(2);

    const limited = fakeFetch([[/\/labels$/, () => new Response('{}', { status: 429, headers: { 'retry-after': '30' } })]]);
    await expect(provider(limited).listFolders()).rejects.toBeInstanceOf(RateLimitedError);
    const unavailable = fakeFetch([[/\/labels$/, () => new Response('{}', { status: 503 })]]);
    await expect(provider(unavailable).listFolders()).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('never puts the access token in an error message', async () => {
    const f = fakeFetch([[/\/labels$/, () => new Response('{"error":{"message":"boom"}}', { status: 500 })]]);
    await expect(provider(f).listFolders()).rejects.toThrow(/Gmail 500/);
    await expect(provider(f).listFolders()).rejects.not.toThrow(/AT/);
  });

  it('googleRefresh posts the form and surfaces invalid_grant', async () => {
    const ok = fakeFetch([[/oauth2\.googleapis\.com\/token/, () => ({ access_token: 'A', expires_in: 3599 })]]);
    expect(await googleRefresh({ GOOGLE_OAUTH_CLIENT_ID: 'i', GOOGLE_OAUTH_CLIENT_SECRET: 's' } as NodeJS.ProcessEnv, 'rt', ok))
      .toEqual({ accessToken: 'A', expiresInSec: 3599, refreshToken: undefined });
    expect(ok.calls[0].init.body).toContain('grant_type=refresh_token');
    expect(ok.calls[0].init.body).toContain('refresh_token=rt');

    const bad = fakeFetch([[/token/, () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'expired' }), { status: 400 })]]);
    await expect(googleRefresh({ GOOGLE_OAUTH_CLIENT_ID: 'i', GOOGLE_OAUTH_CLIENT_SECRET: 's' } as NodeJS.ProcessEnv, 'rt', bad)).rejects.toThrow(/invalid_grant/);
  });
});
