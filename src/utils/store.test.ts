import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  resolveRetainageMode, AiaSovLine,
  saveBinaryFile, uploadProjectFile, persistGeneratedDocument,
} from './store';

const line = (retainagePercent: number | null): Pick<AiaSovLine, 'retainagePercent'> => ({ retainagePercent });

describe('resolveRetainageMode', () => {
  it('returns the explicit mode when set, regardless of SOV data', () => {
    expect(resolveRetainageMode('uniform', [line(12)])).toBe('uniform');
    expect(resolveRetainageMode('perLine', [])).toBe('perLine');
  });

  it('infers perLine when the mode is absent but a line carries a per-line rate', () => {
    expect(resolveRetainageMode(undefined, [line(null), line(8)])).toBe('perLine');
  });

  it('infers uniform when the mode is absent and no line carries a per-line rate', () => {
    expect(resolveRetainageMode(undefined, [line(null), line(null)])).toBe('uniform');
  });

  it('infers uniform when the mode is absent and there are no SOV lines at all', () => {
    expect(resolveRetainageMode(undefined, [])).toBe('uniform');
  });
});

// Upload attribution (spec 2026-08-17 §Data model). The server may answer an
// upload with a DIFFERENT id than the one posted: a full sourceType+sourceId+kind
// triple on a single-instance kind versions the document that source already
// owns. Callers record references, so the returned id is the only safe one.
describe('upload helpers', () => {
  const okJson = (body: unknown) => ({
    ok: true,
    status: 200,
    json: async () => body,
  }) as unknown as Response;

  const stubFetch = (impl: (url: string, init: RequestInit) => Promise<Response>) => {
    const spy = vi.fn(impl);
    vi.stubGlobal('fetch', spy);
    return spy;
  };

  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns the server fileId, not the posted id, when the upload was versioned', async () => {
    stubFetch(async () => okJson({ success: true, fileId: 'canonical-id', versioned: true }));

    const result = await saveBinaryFile('posted-id', new Blob(['x'], { type: 'application/pdf' }), {
      projectId: 'p1', kind: 'invoice', name: 'inv.pdf',
      sourceType: 'invoice', sourceId: 'i1',
    });

    expect(result).toEqual({ fileId: 'canonical-id', versioned: true });
  });

  it('posts the attribution as query params', async () => {
    const spy = stubFetch(async () => okJson({ success: true, fileId: 'f1', versioned: false }));

    await saveBinaryFile('posted-id', new Blob(['x']), {
      projectId: 'p1', kind: 'invoice', name: 'inv.pdf',
      customerId: 'c1', sourceType: 'invoice', sourceId: 'i1',
    });

    const url = new URL(spy.mock.calls[0][0] as string, 'http://localhost');
    expect(url.pathname).toBe('/api/files/posted-id');
    expect(url.searchParams.get('projectId')).toBe('p1');
    expect(url.searchParams.get('kind')).toBe('invoice');
    expect(url.searchParams.get('name')).toBe('inv.pdf');
    expect(url.searchParams.get('customerId')).toBe('c1');
    expect(url.searchParams.get('sourceType')).toBe('invoice');
    expect(url.searchParams.get('sourceId')).toBe('i1');
  });

  it('uploadProjectFile also reports the server id over the one it minted', async () => {
    stubFetch(async () => okJson({ success: true, fileId: 'server-owned', versioned: true }));

    const file = new File(['x'], 'photo.jpg', { type: 'image/jpeg' });
    const result = await uploadProjectFile('p1', file, 'issue-report', {
      sourceType: 'issue', sourceId: 'iss1',
    });

    expect(result.fileId).toBe('server-owned');
    expect(result.versioned).toBe(true);
  });

  it('falls back to the posted id when an older server omits fileId', async () => {
    stubFetch(async () => okJson({ success: true }));

    const result = await saveBinaryFile('posted-id', new Blob(['x']), { kind: 'settings-asset' });

    expect(result).toEqual({ fileId: 'posted-id', versioned: false });
  });

  // Download handlers wrap this call in their own try/catch so a failed persist
  // only warns and the download still proceeds. That only works if the helper
  // reports the failure instead of swallowing it.
  it('persistGeneratedDocument rethrows a rejected upload rather than swallowing it', async () => {
    stubFetch(async () => { throw new Error('network down'); });

    await expect(persistGeneratedDocument(new Blob(['x']), {
      projectId: 'p1', kind: 'invoice', name: 'inv.pdf',
      sourceType: 'invoice', sourceId: 'i1',
    })).rejects.toThrow('network down');
  });

  it('persistGeneratedDocument rethrows when the server rejects the upload', async () => {
    stubFetch(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Failed to save file' }),
    }) as unknown as Response);

    await expect(persistGeneratedDocument(new Blob(['x']), {
      projectId: 'p1', kind: 'invoice', name: 'inv.pdf',
    })).rejects.toThrow('Failed to save file');
  });
});
