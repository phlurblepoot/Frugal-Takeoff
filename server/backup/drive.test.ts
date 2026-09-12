import { describe, it, expect, beforeEach } from 'vitest';
import { Readable } from 'stream';
import { DriveStore, ensureDriveFolders, driveAuthUrl, signDriveState, verifyDriveState, DRIVE_SCOPE } from './drive';
import type { Manifest } from './types';

// Minimal Drive v3 fake: folders + files with parents, list with q, media
// download, resumable upload (initiate → PUT chunks), delete. Pages at 2.
// Like the real API, a resumable session only materialises a file once the
// final chunk lands, so an abandoned (retried) upload leaves nothing behind.
class FakeDrive {
  files = new Map<string, { name: string; parents: string[]; mime: string; data?: Buffer }>();
  sessions = new Map<string, { name: string; parents: string[]; data: Buffer }>();
  next = 1; failNextUploadWith: number | null = null; calls: string[] = []; puts: string[] = [];
  fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url); this.calls.push(`${init.method ?? 'GET'} ${u.pathname}`);
    if (u.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'AT', expires_in: 3600 });
    if (u.pathname === '/drive/v3/files' && (init.method ?? 'GET') === 'GET') {
      const q = u.searchParams.get('q') ?? ''; const parent = /'([^']+)' in parents/.exec(q)?.[1]; const name = /name = '([^']+)'/.exec(q)?.[1];
      const isMime = /mimeType = '([^']+)'/.exec(q)?.[1]; const notMime = /mimeType != '([^']+)'/.exec(q)?.[1];
      const all = [...this.files].filter(([, f]) => (!parent || f.parents.includes(parent)) && (!name || f.name === name)
        && (!isMime || f.mime === isMime) && (!notMime || f.mime !== notMime)).map(([id, f]) => ({ id, name: f.name, mimeType: f.mime }));
      const start = Number(u.searchParams.get('pageToken') ?? 0); const page = all.slice(start, start + 2);
      return Response.json({ files: page, nextPageToken: start + 2 < all.length ? String(start + 2) : undefined });
    }
    if (u.pathname === '/drive/v3/files' && init.method === 'POST') {
      const body = JSON.parse(String(init.body)); const id = `id${this.next++}`;
      this.files.set(id, { name: body.name, parents: body.parents ?? [], mime: body.mimeType ?? 'application/octet-stream' });
      return Response.json({ id });
    }
    if (u.pathname === '/upload/drive/v3/files' && init.method === 'POST') {
      const body = JSON.parse(String(init.body)); const sid = `s${this.next++}`;
      this.sessions.set(sid, { name: body.name, parents: body.parents ?? [], data: Buffer.alloc(0) });
      return new Response(null, { status: 200, headers: { Location: `https://www.googleapis.com/upload/session/${sid}` } });
    }
    if (u.pathname.startsWith('/upload/session/') && init.method === 'PUT') {
      const cr = String((init.headers as any)['Content-Range']); this.puts.push(cr);
      if (this.failNextUploadWith) { const s = this.failNextUploadWith; this.failNextUploadWith = null; return new Response('busy', { status: s }); }
      const sid = u.pathname.split('/').pop()!; const s = this.sessions.get(sid)!;
      const body = Buffer.from((init.body ?? Buffer.alloc(0)) as ArrayBuffer);
      // `bytes a-b/total`, or `bytes */total` for the zero-length finalise.
      const range = /bytes (?:(\d+)-(\d+)|\*)\/(\d+)/.exec(cr)!;
      const total = Number(range[3]);
      // Google refuses a chunk that does not reach the end unless its length is
      // a multiple of 256 KiB.
      if (range[2] !== undefined && Number(range[2]) + 1 < total && body.length % (256 * 1024) !== 0) return new Response('bad chunk', { status: 400 });
      s.data = Buffer.concat([s.data, body]);
      if (s.data.length !== total) return new Response(null, { status: 308 });
      const id = `id${this.next++}`;
      this.files.set(id, { name: s.name, parents: s.parents, mime: 'application/octet-stream', data: s.data });
      this.sessions.delete(sid);
      return Response.json({ id });
    }
    const m = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
    if (m && init.method === 'DELETE') { this.files.delete(m[1]); return new Response(null, { status: 204 }); }
    if (m && u.searchParams.get('alt') === 'media') return new Response(this.files.get(m[1])!.data);
    return new Response('nope', { status: 404 });
  };
}

let fake: FakeDrive;
beforeEach(() => { fake = new FakeDrive(); });
const env = { GOOGLE_OAUTH_CLIENT_ID: 'cid', GOOGLE_OAUTH_CLIENT_SECRET: 'sec' } as NodeJS.ProcessEnv;
const manifest = (files: Manifest['files']): Manifest => ({ format: 1, createdAt: 1, appVersion: '3.2.0', schemaVersion: 36, db: { size: 2, sha256: 'd' }, mailKey: { source: 'env' }, files, counts: { files: files.length, bytes: 0 }, warnings: [] });

describe('drive oauth helpers', () => {
  it('auth url carries only the drive.file scope and the mode-specific redirect; state round-trips and rejects a mail state', async () => {
    const url = new URL(driveAuthUrl(env, 'https://app.example', 'admin', 'S', 'C'));
    expect(url.searchParams.get('scope')).toBe(DRIVE_SCOPE);
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example/api/backup/drive/callback');
    expect(new URL(driveAuthUrl(env, 'https://app.example', 'setup', 'S', 'C')).searchParams.get('redirect_uri')).toBe('https://app.example/api/setup/restore/drive/callback');
    const s = signDriveState('secret', { mode: 'setup', verifier: 'v' });
    expect(verifyDriveState('secret', s)).toEqual({ mode: 'setup', verifier: 'v' });
    const { signState } = await import('../mail/oauth');
    expect(() => verifyDriveState('secret', signState('secret', { userId: 'u', provider: 'google', verifier: 'v' }))).toThrow();
  });
});

describe('DriveStore', () => {
  const mk = async () => {
    const folders = await ensureDriveFolders(async () => 'AT', fake.fetch as any);
    return new DriveStore({ refreshToken: 'r', email: 'a@b', ...folders }, { env, fetch: fake.fetch as any });
  };
  it('ensureDriveFolders creates root/objects/snapshots once and finds them next time', async () => {
    const a = await ensureDriveFolders(async () => 'AT', fake.fetch as any);
    const b = await ensureDriveFolders(async () => 'AT', fake.fetch as any);
    expect(a).toEqual(b); expect([...fake.files.values()].filter(f => f.name === 'Frugal Takeoff Backups').length).toBe(1);
  });
  it('listObjects pages through objects/; putObject is resumable and retries once on 503', async () => {
    const st = await mk();
    for (const n of ['a', 'b', 'c']) await st.putObject(n.repeat(64), () => Readable.from([Buffer.from(n)]), 1);
    expect(await st.listObjects()).toEqual(new Set(['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]));
    fake.failNextUploadWith = 503;
    await st.putObject('d'.repeat(64), () => Readable.from([Buffer.from('dd')]), 2);
    expect([...fake.files.values()].find(f => f.name === 'd'.repeat(64))!.data!.toString()).toBe('dd');
  });
  it('uploads a zero-byte object and one whose size is an exact multiple of the chunk size', async () => {
    const st = await mk();
    await st.putObject('0'.repeat(64), () => Readable.from([]), 0);
    expect([...fake.files.values()].find(f => f.name === '0'.repeat(64))!.data!.length).toBe(0);
    const big = Buffer.alloc(8 * 1024 * 1024, 7);
    await st.putObject('7'.repeat(64), () => Readable.from([big]), big.length);
    expect([...fake.files.values()].find(f => f.name === '7'.repeat(64))!.data!.length).toBe(big.length);
  });
  it('splits a large source into 256 KiB-aligned chunks and a final remainder', async () => {
    const st = await mk();
    const total = 8 * 1024 * 1024 + 300 * 1024;
    const source = () => Readable.from((function* () {
      for (let sent = 0; sent < total; sent += 100 * 1024) yield Buffer.alloc(Math.min(100 * 1024, total - sent), 1);
    })());
    await st.putObject('1'.repeat(64), source, total);
    expect(fake.puts).toEqual([`bytes 0-8388607/${total}`, `bytes 8388608-${total - 1}/${total}`]);
    expect([...fake.files.values()].find(f => f.name === '1'.repeat(64))!.data!.length).toBe(total);
  });
  it('a source that runs short of the declared size fails the upload instead of recording it', async () => {
    const st = await mk();
    await expect(st.putObject('2'.repeat(64), () => Readable.from([Buffer.alloc(512 * 1024)]), 1024 * 1024)).rejects.toThrow(/did not complete/);
    expect([...fake.files.values()].some(f => f.name === '2'.repeat(64))).toBe(false);
  });
  it('rejects an object id that is not a sha256 before touching the network', async () => {
    const st = await mk();
    const before = fake.calls.length;
    await expect(st.openObject('not-a-hash')).rejects.toThrow(/bad object id/);
    await expect(st.deleteObject('../../etc/passwd')).rejects.toThrow(/bad object id/);
    await expect(st.putObject("x' or '1", () => Readable.from([Buffer.from('x')]), 1)).rejects.toThrow(/bad object id/);
    expect(fake.calls.length).toBe(before);
  });
  it('listObjects ignores a folder that turns up inside objects/', async () => {
    const folders = await ensureDriveFolders(async () => 'AT', fake.fetch as any);
    const st = new DriveStore({ refreshToken: 'r', email: 'a@b', ...folders }, { env, fetch: fake.fetch as any });
    await st.putObject('a'.repeat(64), () => Readable.from([Buffer.from('a')]), 1);
    fake.files.set('stray', { name: 'a-stray-folder', parents: [folders.objectsFolderId], mime: 'application/vnd.google-apps.folder' });
    expect(await st.listObjects()).toEqual(new Set(['a'.repeat(64)]));
  });
  it('writeSnapshot uploads app.db, mail.key, then manifest last; listSnapshots/readManifest/openObject round-trip; prune deletes', async () => {
    const st = await mk();
    const fs = await import('fs'); const os = await import('os'); const path = await import('path');
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-dr-')); fs.writeFileSync(path.join(d, 'db'), 'DB'); fs.writeFileSync(path.join(d, 'k'), 'K');
    await st.putObject('e'.repeat(64), () => Readable.from([Buffer.from('E')]), 1);
    await st.writeSnapshot('20260912-000000', { dbPath: path.join(d, 'db'), mailKeyPath: path.join(d, 'k'), manifest: manifest([{ id: 'f', sha256: 'e'.repeat(64), size: 1 }]) });
    const names = fake.calls.filter(c => c.startsWith('POST /upload')).length; expect(names).toBeGreaterThanOrEqual(4);
    const uploadOrder = [...fake.files.values()].map(f => f.name);
    expect(uploadOrder.indexOf('manifest.json')).toBeGreaterThan(uploadOrder.indexOf('app.db'));
    expect((await st.listSnapshots()).map(s => s.id)).toEqual(['20260912-000000']);
    expect((await st.readManifest('20260912-000000')).files[0].id).toBe('f');
    const chunks: Buffer[] = []; for await (const c of (await st.openObject('e'.repeat(64))) as any) chunks.push(c);
    expect(Buffer.concat(chunks).toString()).toBe('E');
    await st.deleteSnapshot('20260912-000000'); await st.deleteObject('e'.repeat(64));
    expect(await st.listSnapshots()).toEqual([]); expect((await st.listObjects()).size).toBe(0);
  });
});
