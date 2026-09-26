// server/onlyoffice/thumbnails.ts — first-page pictures of documents for the
// Documents list (ONLYOFFICE Phase 4). The Document Server's conversion
// service renders page one as a PNG (`thumbnail.first`).
//
// Cached on disk by content hash (<dataDir>/thumbnails/<sha256>.png), so a
// file's thumbnail follows its current version automatically and identical
// files share one. Made in the background, one at a time: after an upload or
// an editor save, and whenever the list asks for one that isn't there yet.
// They are only a picture of the file, rebuilt on demand, so backups skip them.
import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { getMeta } from '../files';
import { officeFormatOf } from '../../src/utils/officeFormats';
import { readOnlyofficeConfig } from './config';
import type { LinkTokens } from './tokens';
import { fileLink } from './links';
import { OnlyofficeError, convert, downloadFromOnlyoffice } from './client';

/** The longest side of a thumbnail, in pixels. */
export const THUMBNAIL_SIZE = 320;
/** After a failure, how long before the same bytes are tried again. */
const RETRY_AFTER_MS = 60 * 60_000;

export interface ThumbnailDeps {
  env: NodeJS.ProcessEnv;
  db: Database.Database;
  dataDir: string;
  tokens: LinkTokens;
  fetch: typeof fetch;
  now?: () => number;
}

export type ThumbnailState = 'ready' | 'pending' | 'none';

export class Thumbnails {
  private readonly dir: string;
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private readonly failedAt = new Map<string, number>();
  private running: Promise<void> | null = null;

  constructor(private readonly deps: ThumbnailDeps) {
    this.dir = path.join(deps.dataDir, 'thumbnails');
  }

  private now = () => (this.deps.now ?? Date.now)();
  pathFor = (sha256: string) => path.join(this.dir, `${sha256}.png`);

  /** Whether a file can have a thumbnail at all: something ONLYOFFICE opens. */
  eligible(meta: { mime: string; name: string | null; parentFileId?: string | null }): boolean {
    return !!officeFormatOf(meta);
  }

  /** Where a file's thumbnail stands, queueing it when it's missing. */
  state(fileId: string): { state: ThumbnailState; path?: string } {
    const meta = getMeta(this.deps.db, fileId);
    if (!meta || !this.eligible(meta) || !meta.sha256) return { state: 'none' };
    const p = this.pathFor(meta.sha256);
    if (fs.existsSync(p)) return { state: 'ready', path: p };
    if (!readOnlyofficeConfig(this.deps.env).config) return { state: 'none' };
    const failed = this.failedAt.get(meta.sha256);
    if (failed && this.now() - failed < RETRY_AFTER_MS) return { state: 'none' };
    this.enqueue(fileId);
    return { state: 'pending' };
  }

  /** Queues a file (by id: the bytes are whatever it holds when its turn comes). */
  enqueue(fileId: string): void {
    if (this.queued.has(fileId)) return;
    this.queued.add(fileId);
    this.queue.push(fileId);
    if (!this.running) this.running = this.drain().finally(() => { this.running = null; });
  }

  /** Resolves once everything queued so far is done (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private async drain(): Promise<void> {
    for (let id = this.queue.shift(); id !== undefined; id = this.queue.shift()) {
      this.queued.delete(id);
      try { await this.make(id); } catch (e) {
        console.warn(`[onlyoffice] thumbnail for ${id} failed:`, e instanceof Error ? e.message : e);
      }
    }
  }

  private async make(fileId: string): Promise<void> {
    const { config: cfg } = readOnlyofficeConfig(this.deps.env);
    const meta = getMeta(this.deps.db, fileId);
    const format = meta ? officeFormatOf(meta) : null;
    if (!cfg || !meta || !format || !meta.sha256) return;
    const out = this.pathFor(meta.sha256);
    if (fs.existsSync(out)) return;
    try {
      const result = await convert(cfg, this.deps.fetch, {
        filetype: format.ext, outputtype: 'png',
        key: `thumb-${meta.sha256.slice(0, 40)}-${THUMBNAIL_SIZE}`,
        title: meta.name ?? `file.${format.ext}`,
        url: fileLink(cfg, this.deps.tokens, meta.id),
        thumbnail: { aspect: 1, first: true, width: THUMBNAIL_SIZE, height: THUMBNAIL_SIZE },
      }, 60_000);
      const png = await downloadFromOnlyoffice(cfg, this.deps.fetch, result.fileUrl, 60_000);
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${out}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, png);
      fs.renameSync(tmp, out);
      this.failedAt.delete(meta.sha256);
    } catch (e) {
      this.failedAt.set(meta.sha256, this.now());
      throw e instanceof OnlyofficeError ? e : new Error(String(e));
    }
  }

  /** Deletes thumbnails no stored file has the bytes of any more (deleted
   *  files, replaced versions). Returns how many went. */
  sweep(): number {
    let names: string[];
    try { names = fs.readdirSync(this.dir); } catch { return 0; }
    // Only live files are ever shown; an archived version's picture is waste.
    const live = new Set((this.deps.db.prepare('SELECT DISTINCT sha256 FROM files WHERE parentFileId IS NULL').all() as { sha256: string }[]).map(r => r.sha256));
    let removed = 0;
    for (const n of names) {
      const sha = n.replace(/\.png$/, '');
      if (n.endsWith('.png') && live.has(sha)) continue;
      try { fs.unlinkSync(path.join(this.dir, n)); removed++; } catch { /* already gone */ }
    }
    return removed;
  }
}
