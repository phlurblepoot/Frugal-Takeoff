// server/onlyoffice/client.ts — calls from this app to the Document Server:
// the command service (`/command`) and the conversion service (`/converter`).
//
// Every request is signed with the shared secret twice: as `token` in the body
// (ONLYOFFICE's recommended form) and as a Bearer header whose payload wraps
// the parameters (the older form). Sending both keeps working whichever form
// the server is set up to check.
import jwt from 'jsonwebtoken';
import type { OnlyofficeConfig } from './config';

export type OnlyofficeErrorCode =
  | 'unreachable'      // network error, DNS failure, refused, timed out
  | 'bad-response'     // reached something, but not a Document Server answer
  | 'secret-mismatch'  // the Document Server rejected our signature
  | 'download-failed'  // the Document Server could not fetch the file from us
  | 'failed';          // any other error code it returned

export class OnlyofficeError extends Error {
  constructor(readonly code: OnlyofficeErrorCode, message: string, readonly serverError?: number) {
    super(message);
    this.name = 'OnlyofficeError';
  }
}

type Fetch = typeof fetch;

/** Why a fetch never got an answer, in the words an admin can act on. */
function networkReason(e: unknown): string {
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'timed out';
  return err?.cause?.code || err?.cause?.message || err?.message || 'network error';
}

async function postSigned(
  cfg: OnlyofficeConfig, fetchImpl: Fetch, path: string, params: Record<string, unknown>, timeoutMs: number,
): Promise<any> {
  const url = `${cfg.internalUrl}${path}`;
  const bodyToken = jwt.sign(params, cfg.jwtSecret, { algorithm: 'HS256' });
  const headerToken = jwt.sign({ payload: params }, cfg.jwtSecret, { algorithm: 'HS256' });
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${headerToken}` },
      body: JSON.stringify({ ...params, token: bodyToken }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new OnlyofficeError('unreachable', `Couldn't reach ONLYOFFICE at ${cfg.internalUrl} (${networkReason(e)}).`);
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new OnlyofficeError('bad-response', `ONLYOFFICE at ${cfg.internalUrl} answered HTTP ${res.status} for ${path}.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new OnlyofficeError('bad-response', `${url} did not answer like an ONLYOFFICE Document Server.`);
  }
}

const SECRET_MISMATCH =
  'ONLYOFFICE rejected this app\'s signature: ONLYOFFICE_JWT_SECRET here must equal JWT_SECRET on the ONLYOFFICE container.';

/** The Document Server's version, e.g. "9.4.0.1". Proves reachability and the shared secret. */
export async function getVersion(cfg: OnlyofficeConfig, fetchImpl: Fetch, timeoutMs = 8000): Promise<string> {
  const body = await postSigned(cfg, fetchImpl, '/command', { c: 'version' }, timeoutMs);
  if (body?.error === 6) throw new OnlyofficeError('secret-mismatch', SECRET_MISMATCH, 6);
  if (body?.error !== 0 || typeof body?.version !== 'string') {
    throw new OnlyofficeError('failed', `ONLYOFFICE's command service returned error ${body?.error ?? 'unknown'}.`, body?.error);
  }
  return body.version;
}

export interface ConvertRequest {
  /** Input format, e.g. "xlsx". */
  filetype: string;
  /** Output format, e.g. "pdf". */
  outputtype: string;
  /** Unique per conversion: ONLYOFFICE caches results by key. */
  key: string;
  title: string;
  /** Where the Document Server downloads the input from; must be reachable from it. */
  url: string;
}

/** Synchronous conversion; resolves with the Document Server's link to the result. */
export async function convert(
  cfg: OnlyofficeConfig, fetchImpl: Fetch, req: ConvertRequest, timeoutMs = 60_000,
): Promise<{ fileUrl: string; fileType: string }> {
  const body = await postSigned(cfg, fetchImpl, '/converter', { async: false, ...req }, timeoutMs);
  const error = typeof body?.error === 'number' ? body.error : 0;
  if (error === -8) throw new OnlyofficeError('secret-mismatch', SECRET_MISMATCH, -8);
  if (error === -4) {
    throw new OnlyofficeError('download-failed', `ONLYOFFICE couldn't download the file from ${new URL(req.url).origin}.`, -4);
  }
  if (error !== 0) throw new OnlyofficeError('failed', `ONLYOFFICE's conversion failed with error ${error}.`, error);
  if (body?.endConvert !== true || typeof body?.fileUrl !== 'string') {
    throw new OnlyofficeError('failed', 'ONLYOFFICE did not finish the conversion.');
  }
  return { fileUrl: body.fileUrl, fileType: String(body.fileType || req.outputtype) };
}
