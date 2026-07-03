import type { AiRunner, ExistingSheetRef, SheetRead } from './types';

export interface HandlerResult { status: number; body: unknown; }

/** Loader maps an image id to its bytes on disk (null if missing). */
export type ImageLoader = (id: string) => Buffer | null;

export async function handleStatus(runner: AiRunner): Promise<HandlerResult> {
  const available = await runner.available().catch(() => false);
  const info = runner.info();
  return { status: 200, body: { available, model: info.model, device: info.device } };
}

function decodeBase64Image(input: string): Buffer | null {
  const comma = input.indexOf(',');
  const b64 = input.startsWith('data:') && comma >= 0 ? input.slice(comma + 1) : input;
  try { const buf = Buffer.from(b64, 'base64'); return buf.length ? buf : null; } catch { return null; }
}

export async function handleReadSheet(
  runner: AiRunner,
  loadImage: ImageLoader,
  body: { imageId?: string; imageBase64?: string; embeddedText?: string },
): Promise<HandlerResult> {
  if (!(await runner.available().catch(() => false))) return { status: 503, body: { error: 'ai unavailable' } };

  let image: Buffer | null = null;
  if (body.imageId) {
    image = loadImage(body.imageId);
    if (!image) return { status: 404, body: { error: 'image not found' } };
  } else if (body.imageBase64) {
    image = decodeBase64Image(body.imageBase64);
    if (!image) return { status: 400, body: { error: 'bad imageBase64' } };
  } else {
    return { status: 400, body: { error: 'imageId or imageBase64 required' } };
  }

  try {
    const read = await runner.readSheet({ image, embeddedText: body.embeddedText });
    return { status: 200, body: read };
  } catch (e: any) {
    return { status: 502, body: { error: String(e?.message ?? e) } };
  }
}

export async function handleMatchSheet(
  runner: AiRunner,
  body: { page?: SheetRead; existingSheets?: ExistingSheetRef[] },
): Promise<HandlerResult> {
  if (!(await runner.available().catch(() => false))) return { status: 503, body: { error: 'ai unavailable' } };
  if (!body.page) return { status: 400, body: { error: 'page required' } };
  const existing = Array.isArray(body.existingSheets) ? body.existingSheets : [];
  try {
    const match = await runner.matchSheet({ page: body.page, existing });
    return { status: 200, body: match };
  } catch (e: any) {
    return { status: 502, body: { error: String(e?.message ?? e) } };
  }
}
