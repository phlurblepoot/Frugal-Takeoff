// server/onlyoffice/editorRoutes.ts — opening files in ONLYOFFICE and saving
// them back (ONLYOFFICE Phase 1, docs/superpowers/specs/2026-09-25-onlyoffice-checklist.md).
//
//   POST /api/onlyoffice/config/:fileId    signed-in user → signed editor config
//   GET  /api/onlyoffice/file/:fileId?t=   ONLYOFFICE downloads the file (link token)
//   POST /api/onlyoffice/callback/:fileId  ONLYOFFICE reports status and sends saves
//
// Saving follows the one-version-per-session rule (decision 2026-09-25): the
// first save of an editing session keeps the pre-session bytes as a version;
// later saves in the same session overwrite in place, but only while the live
// file is still exactly what this session last wrote. If anything else changed
// it meanwhile (a regenerate, an upload, a restore), the save becomes a new
// version on top, so nothing is ever overwritten.
import crypto from 'crypto';
import fsSync from 'fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import type Database from 'better-sqlite3';
import { getMeta, replaceLiveContent, saveNewVersion, type FileMeta } from '../files';
import { pathFor, statFile } from '../fileStore';
import { NON_ADMIN_EXCLUDED_KINDS } from '../documents';
import type { BroadcastChange } from '../realtime/changeFeed';
import { extensionOf, officeFormatByExt, officeFormatOf } from '../../src/utils/officeFormats';
import { readOnlyofficeConfig, type OnlyofficeConfig } from './config';
import { LinkTokens } from './tokens';
import { EditorSessions } from './sessions';
import { buildEditorConfig, documentKeyFor, documentKeyPrefix } from './editorConfig';
import { OnlyofficeError, downloadFromOnlyoffice, isSessionOpen } from './client';

export interface OnlyofficeEditorDeps {
  env: NodeJS.ProcessEnv;
  db: Database.Database;
  dataDir: string;
  tokens: LinkTokens;
  authenticateToken: express.RequestHandler;
  broadcastChange: BroadcastChange;
  fetch: typeof fetch;
}

// How long ONLYOFFICE may use a file link. It downloads when the first person
// opens the file; the margin covers an editor tab left open all day that has
// to reconnect. The link opens that one file, read-only, and the person it was
// issued to could already read the file anyway.
const FILE_LINK_TTL_SECONDS = 8 * 3600;
const fileSubject = (fileId: string) => `file:${fileId}`;

// Callback bodies carry change history for long sessions; a generous cap, but
// nothing like the app's 50 MB JSON limit, since this route needs no login.
export const CALLBACK_PATH_PREFIX = '/api/onlyoffice/callback/';
const callbackParser = express.json({ limit: '10mb' });

const NOT_CONFIGURED = "The document editor isn't set up yet. An admin can check Settings → Document Editor.";

const isAdminOnlyKind = (kind: string) => (NON_ADMIN_EXCLUDED_KINDS as readonly string[]).includes(kind);

/** The callback's parameters, from whichever signed form ONLYOFFICE used: the
 *  body's `token` (when set to sign in the body) or a Bearer header whose
 *  payload wraps them (the default). Unsigned fields are never trusted. */
function verifiedCallback(req: express.Request, secret: string): Record<string, any> | null {
  const verify = (token: string) => {
    try { return jwt.verify(token, secret, { algorithms: ['HS256'] }) as Record<string, any>; } catch { return null; }
  };
  const bodyToken = typeof req.body?.token === 'string' ? req.body.token : '';
  if (bodyToken) {
    const p = verify(bodyToken);
    if (p) return p;
  }
  const header = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (m) {
    const p = verify(m[1]);
    if (p && typeof p.payload === 'object' && p.payload) return p.payload;
  }
  return null;
}

export function registerOnlyofficeEditorRoutes(app: express.Express, deps: OnlyofficeEditorDeps): void {
  const { db, dataDir, tokens, authenticateToken } = deps;
  const sessions = new EditorSessions(db);

  // Saves for one file are applied one at a time: a forcesave and the final
  // close-save can arrive back to back, and each decides "overwrite or new
  // version" from what the previous one wrote.
  const queues = new Map<string, Promise<unknown>>();
  const serialized = <T>(fileId: string, fn: () => Promise<T>): Promise<T> => {
    const run = (queues.get(fileId) ?? Promise.resolve()).then(fn, fn);
    const settled = run.catch(() => undefined);
    queues.set(fileId, settled);
    void settled.then(() => { if (queues.get(fileId) === settled) queues.delete(fileId); });
    return run;
  };

  app.post('/api/onlyoffice/config/:fileId', authenticateToken, async (req: any, res) => {
    const { config: cfg } = readOnlyofficeConfig(deps.env);
    if (!cfg) return res.status(503).json({ error: NOT_CONFIGURED, code: 'not-configured' });
    const meta = getMeta(db, req.params.fileId);
    const isAdmin = req.user?.role === 'admin';
    if (!meta || (!isAdmin && isAdminOnlyKind(meta.kind))) return res.status(404).json({ error: 'File not found' });
    const format = officeFormatOf(meta);
    if (!format) return res.status(415).json({ error: "This kind of file can't be opened in the editor.", code: 'unsupported' });

    const device = req.body?.device === 'phone' ? 'phone' : 'desktop';
    const theme = req.body?.theme === 'dark' ? 'dark' : 'light';
    // Phones get the viewer: ONLYOFFICE Community Edition doesn't edit in
    // mobile browsers (decision 2026-09-25). A historical version is read-only.
    const mode: 'edit' | 'view' = format.editable && device === 'desktop' && !meta.parentFileId ? 'edit' : 'view';

    let docKey = documentKeyFor(meta);
    if (!meta.parentFileId) {
      try {
        docKey = await sessionKeyFor(cfg, meta, docKey, mode);
      } catch (e) {
        const message = e instanceof OnlyofficeError ? e.message : 'Unexpected error talking to ONLYOFFICE.';
        return res.status(503).json({ error: message, code: 'onlyoffice-unreachable' });
      }
    }

    const token = tokens.sign(fileSubject(meta.id), FILE_LINK_TTL_SECONDS);
    const id = encodeURIComponent(meta.id);
    const config = buildEditorConfig({
      cfg,
      file: meta,
      format,
      docKey,
      fileUrl: `${cfg.appInternalUrl}/api/onlyoffice/file/${id}?t=${encodeURIComponent(token)}`,
      callbackUrl: mode === 'edit' ? `${cfg.appInternalUrl}${CALLBACK_PATH_PREFIX}${id}` : null,
      mode,
      device,
      theme,
      user: { id: String(req.user.id), name: String(req.user.username || req.user.id) },
    });
    res.json({
      publicUrl: cfg.publicUrl,
      config,
      file: { id: meta.id, name: meta.name, projectId: meta.projectId, kind: meta.kind, ext: format.ext, mode, editable: format.editable },
    });
  });

  /** The document key this open should use: the open session's, so everyone
   *  lands in the same session; otherwise the key for the current bytes,
   *  starting a session when the file is opened for editing. */
  async function sessionKeyFor(cfg: OnlyofficeConfig, meta: FileMeta, currentKey: string, mode: 'edit' | 'view'): Promise<string> {
    let session = sessions.get(meta.id);
    // A session pinned to another key (it has saved since it began) must still
    // exist in ONLYOFFICE; one that vanished without a closing callback (a
    // restart, a crash) would otherwise strand everyone on a dead key.
    if (session && session.docKey !== currentKey && !(await isSessionOpen(cfg, deps.fetch, session.docKey))) {
      sessions.end(meta.id, session.docKey);
      session = null;
    }
    if (session) return session.docKey;
    if (mode === 'edit') return sessions.start(meta.id, currentKey, meta.versionNumber).docKey;
    return currentKey;
  }

  // For ONLYOFFICE only (it has no user session): the link token opens this
  // one file, read-only, for a few hours.
  app.get('/api/onlyoffice/file/:fileId', (req, res) => {
    const fileId = req.params.fileId;
    if (!tokens.verify(String(req.query.t || ''), fileSubject(fileId))) {
      return res.status(403).json({ error: 'Invalid or expired link' });
    }
    const meta = getMeta(db, fileId);
    const st = statFile(dataDir, fileId);
    if (!meta || !st) return res.status(404).json({ error: 'File not found' });
    res.set('Content-Type', meta.mime);
    res.set('Content-Length', String(st.size));
    res.set('Cache-Control', 'no-store');
    fsSync.createReadStream(pathFor(dataDir, fileId)).pipe(res);
  });

  app.post(`${CALLBACK_PATH_PREFIX}:fileId`, callbackParser, async (req, res) => {
    const { config: cfg } = readOnlyofficeConfig(deps.env);
    if (!cfg) return res.status(503).json({ error: 1 });
    const payload = verifiedCallback(req, cfg.jwtSecret);
    if (!payload) return res.status(403).json({ error: 1 });
    const fileId = req.params.fileId;
    const key = typeof payload.key === 'string' ? payload.key : '';
    if (!key.startsWith(documentKeyPrefix(fileId))) return res.status(400).json({ error: 1 });

    const status = Number(payload.status);
    try {
      await serialized(fileId, async () => {
        // 2 = closed with changes, 3 = closed but assembling failed, 6/7 = a
        // save while still open. ONLYOFFICE's own reference handler saves the
        // link it sends with 3 and 7 too: it is the best state it has.
        if ([2, 3, 6, 7].includes(status) && typeof payload.url === 'string' && payload.url) {
          if (status === 3 || status === 7) console.warn(`[onlyoffice] ${fileId}: status ${status}, saving the state ONLYOFFICE could recover`);
          await saveFromCallback(cfg, fileId, key, payload);
        }
        // 2, 3 and 4 mean everyone has closed the file: the session is over.
        if ([2, 3, 4].includes(status)) sessions.end(fileId, key);
      });
      res.json({ error: 0 });
    } catch (e) {
      // ONLYOFFICE keeps the edits and reports the failure to the people
      // editing when it doesn't get {"error":0}.
      console.error(`[onlyoffice] saving ${fileId} failed:`, e instanceof Error ? e.message : e);
      res.json({ error: 1 });
    }
  });

  async function saveFromCallback(cfg: OnlyofficeConfig, fileId: string, key: string, payload: Record<string, any>): Promise<void> {
    const live = getMeta(db, fileId);
    if (!live || live.parentFileId) {
      console.warn(`[onlyoffice] ${fileId} no longer exists; dropping a save for it`);
      return;
    }
    const bytes = await downloadFromOnlyoffice(cfg, deps.fetch, payload.url);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (sha256 === live.sha256) return; // e.g. Save pressed with nothing changed

    const format = officeFormatByExt(typeof payload.filetype === 'string' ? payload.filetype : '') ?? officeFormatOf(live);
    const mime = format?.mime ?? live.mime;
    const users: unknown[] = Array.isArray(payload.users) ? payload.users : [];
    const by = typeof users[0] === 'string' && users[0].length <= 128 ? (users[0] as string) : null;

    const session = sessions.get(fileId);
    const ours = !!session && session.docKey === key;
    const untouchedSinceOurSave = ours && session!.savedVersionNumber === live.versionNumber && session!.savedSha256 === live.sha256;
    if (untouchedSinceOurSave) replaceLiveContent(db, dataDir, fileId, bytes, mime, by);
    else saveNewVersion(db, dataDir, fileId, bytes, mime, by);

    // ONLYOFFICE may hand back another format than was opened (it saves a
    // legacy file as its modern equivalent); keep the name's extension honest.
    const currentExt = extensionOf(live.name);
    if (format && currentExt && currentExt !== format.ext) {
      db.prepare('UPDATE files SET name = ? WHERE id = ?').run(`${live.name!.slice(0, -currentExt.length)}${format.ext}`, fileId);
    }

    const after = getMeta(db, fileId)!;
    if (ours) sessions.recordSave(fileId, key, { versionNumber: after.versionNumber, sha256: after.sha256, by });
    deps.broadcastChange({ type: 'file', id: fileId, projectId: after.projectId ?? undefined, action: 'updated', byUserId: by ?? undefined });
  }
}
