import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { LocalStore } from './store';
import { streamSnapshotZip, unpackSnapshotZip } from './zip';
import type { Manifest } from './types';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ft-zip-'));

describe('snapshot zip', () => {
  it('round-trips a snapshot (db, key, manifest, referenced objects only)', async () => {
    const a = new LocalStore(tmp());
    await a.putObject('a'.repeat(64), () => Readable.from([Buffer.from('one')]), 3);
    await a.putObject('b'.repeat(64), () => Readable.from([Buffer.from('unreferenced')]), 12);
    const dbPath = path.join(a.root, 'db'); fs.writeFileSync(dbPath, 'DB');
    const keyPath = path.join(a.root, 'k'); fs.writeFileSync(keyPath, 'KEY');
    const manifest: Manifest = { format: 1, createdAt: 1, appVersion: '3.2.0', schemaVersion: 36, db: { size: 2, sha256: 'x' }, mailKey: { sha256: 'y' },
      files: [{ id: 'f1', sha256: 'a'.repeat(64), size: 3 }], counts: { files: 1, bytes: 3 }, warnings: [] };
    await a.writeSnapshot('20260912-000000', { dbPath, mailKeyPath: keyPath, manifest });

    const zipPath = path.join(tmp(), 's.zip');
    await streamSnapshotZip(a, '20260912-000000', fs.createWriteStream(zipPath));

    const bRoot = tmp();
    const { snapshotId } = await unpackSnapshotZip(zipPath, bRoot);
    const b = new LocalStore(bRoot);
    expect(snapshotId).toBe('20260912-000000');
    expect((await b.readManifest(snapshotId)).files[0].id).toBe('f1');
    expect(fs.readFileSync(b.objectPath('a'.repeat(64)), 'utf8')).toBe('one');
    expect(fs.existsSync(b.objectPath('b'.repeat(64)))).toBe(false);
    expect(fs.readFileSync(path.join(b.snapshotDir(snapshotId), 'app.db'), 'utf8')).toBe('DB');
    expect(fs.readFileSync(path.join(b.snapshotDir(snapshotId), 'mail.key'), 'utf8')).toBe('KEY');
  });

  it('rejects a zip without a manifest', async () => {
    const zipPath = path.join(tmp(), 'bad.zip');
    const archiver = (await import('archiver')).default;
    const out = fs.createWriteStream(zipPath);
    const ar = archiver('zip'); ar.pipe(out); ar.append('x', { name: 'objects/' + 'c'.repeat(64) }); await ar.finalize();
    await new Promise<void>(r => out.on('close', r));
    await expect(unpackSnapshotZip(zipPath, tmp())).rejects.toThrow(/manifest/);
  });
});
