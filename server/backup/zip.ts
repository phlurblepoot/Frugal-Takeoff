// server/backup/zip.ts — a snapshot as one portable archive (spec §Storage layout).
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import yauzl from 'yauzl';
import { pipeline } from 'stream/promises';
import type { Readable } from 'stream';
import type { BackupSource } from './types';
import { isSnapshotId } from './types';

export async function streamSnapshotZip(source: BackupSource, snapshotId: string, out: NodeJS.WritableStream): Promise<void> {
  const manifest = await source.readManifest(snapshotId);
  const ar = archiver('zip', { zlib: { level: 1 } }); // blobs are mostly already-compressed; favor speed
  const done = new Promise<void>((resolve, reject) => { out.on('finish', () => resolve()); out.on('close', () => resolve()); ar.on('error', reject); out.on('error', reject); });
  ar.pipe(out);
  ar.append(JSON.stringify(manifest, null, 2), { name: `snapshots/${snapshotId}/manifest.json` });
  ar.append(await source.openSnapshotFile(snapshotId, 'app.db') as Readable, { name: `snapshots/${snapshotId}/app.db` });
  if ('sha256' in manifest.mailKey) ar.append(await source.openSnapshotFile(snapshotId, 'mail.key') as Readable, { name: `snapshots/${snapshotId}/mail.key` });
  for (const f of manifest.files) ar.append(await source.openObject(f.sha256) as Readable, { name: `objects/${f.sha256}` });
  await ar.finalize();
  await done;
}

const ENTRY = /^(objects\/[0-9a-f]{64}|snapshots\/(\d{8}-\d{6})\/(app\.db|mail\.key|manifest\.json))$/;

/** Unpacks a snapshot zip into a LocalStore rooted at `intoRoot`; returns the snapshot id found. Rejects a zip with no manifest or with entries outside objects/ + snapshots/<id>/. */
export function unpackSnapshotZip(zipPath: string, intoRoot: string): Promise<{ snapshotId: string }> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('cannot open zip'));
      let snapshotId: string | null = null; let sawManifest = false;
      zip.on('error', reject);
      zip.on('entry', entry => {
        if (entry.fileName.endsWith('/')) return zip.readEntry();
        const m = ENTRY.exec(entry.fileName);
        if (!m) return reject(new Error(`unexpected entry in snapshot zip: ${entry.fileName}`));
        if (m[2]) { if (snapshotId && snapshotId !== m[2]) return reject(new Error('zip holds more than one snapshot')); snapshotId = m[2]; }
        if (m[3] === 'manifest.json') sawManifest = true;
        const dest = path.join(intoRoot, entry.fileName);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        zip.openReadStream(entry, (e, rs) => {
          if (e || !rs) return reject(e ?? new Error('bad entry'));
          pipeline(rs, fs.createWriteStream(dest)).then(() => zip.readEntry(), reject);
        });
      });
      zip.on('end', () => {
        if (!snapshotId || !sawManifest || !isSnapshotId(snapshotId)) return reject(new Error('zip is missing snapshots/<id>/manifest.json'));
        resolve({ snapshotId });
      });
      zip.readEntry();
    });
  });
}
