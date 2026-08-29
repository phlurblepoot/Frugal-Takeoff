import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { FilePickerModal } from './FilePickerModal';

// previewEngine (pulled in by DocumentHoverPreview) imports pdfjs at module
// load, which jsdom can't execute.
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ GlobalWorkerOptions: {}, getDocument: vi.fn() }));
vi.mock('pdfjs-dist/legacy/build/pdf.worker.mjs?url', () => ({ default: 'worker-url' }));

// The default rows live here (not inline in the factory) so beforeEach can
// restore them: one test swaps in a never-resolving implementation, and
// clearAllMocks only clears calls, not implementations.
const h = vi.hoisted(() => {
  const ROWS = [
    { id: 'a', name: 'Warranty.pdf', mime: 'application/pdf', size: 10, kind: 'company-document', createdAt: 1, versionNumber: 1, archived: false, projectId: null, projectName: null, customerId: null, customerName: null, source: null },
    { id: 'b', name: 'Spec.pdf', mime: 'application/pdf', size: 10, kind: 'document', createdAt: 2, versionNumber: 1, archived: false, projectId: 'p1', projectName: 'Job', customerId: null, customerName: null, source: null },
  ];
  return {
    docs: async (f: { q?: string }) => ({
      rows: ROWS.filter(r => !f.q || r.name.toLowerCase().includes(f.q.toLowerCase())),
      total: 2,
    }),
    up: async (_projectId: string, f: File) => ({ fileId: `up-${f.name}`, versioned: false }),
    toast: vi.fn(),
  };
});

vi.mock('../utils/store', async (orig) => ({
  ...(await orig<typeof import('../utils/store')>()),
  getDocuments: vi.fn(h.docs),
  getProjectsSummary: vi.fn(async () => []),
  getCustomers: vi.fn(async () => []),
  getDocumentTypes: vi.fn(async () => []),
  uploadProjectFile: vi.fn(h.up),
  saveBinaryFile: vi.fn(async (id: string) => ({ fileId: id, versioned: false })),
  getFileMeta: vi.fn(async (id: string) => ({
    id, projectId: 'p1', name: `${id}.png`, mime: 'image/png', size: 42,
    kind: 'photo', parentFileId: null, versionNumber: 1, createdAt: 7,
  })),
  fetchFileBlob: vi.fn(async (id: string) => new Blob([id], { type: 'application/pdf' })),
}));
vi.mock('./Toast', async (orig) => ({
  ...(await orig<typeof import('./Toast')>()),
  useToast: () => ({ toast: h.toast }),
}));
import { fetchFileBlob, getDocuments, getFileMeta, saveBinaryFile, uploadProjectFile } from '../utils/store';

beforeEach(() => {
  localStorage.setItem('user', JSON.stringify({ id: 'u', role: 'admin' }));
  vi.clearAllMocks();
  (getDocuments as unknown as ReturnType<typeof vi.fn>).mockImplementation(h.docs);
  (uploadProjectFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(h.up);
});

const png = (name: string) => new File(['x'], name, { type: 'image/png' });
const uploadCfg = { kind: 'photo', projectId: 'p1', sourceType: 'issue', sourceId: 'i1' };

describe('FilePickerModal', () => {
  it('lists documents, requests the pdf mime filter, hides excluded ids, and returns picked rows', async () => {
    const onPick = vi.fn();
    render(<FilePickerModal open onClose={() => {}} onPick={onPick} accept="pdf" excludeFileIds={['b']} />);
    await screen.findByText('Warranty.pdf');
    expect(screen.queryByText('Spec.pdf')).toBeNull();
    expect((getDocuments as any).mock.calls[0][0].mimes).toEqual(['application/pdf']);
    fireEvent.click(screen.getByRole('checkbox', { name: /Warranty\.pdf/ }));
    fireEvent.click(screen.getByRole('button', { name: /Add 1 file/ }));
    await waitFor(() => expect(onPick).toHaveBeenCalledWith([expect.objectContaining({ id: 'a' })]));
  });

  it('single-select mode replaces the selection', async () => {
    const onPick = vi.fn();
    render(<FilePickerModal open onClose={() => {}} onPick={onPick} multi={false} />);
    await screen.findByText('Spec.pdf');
    fireEvent.click(screen.getByRole('checkbox', { name: /Warranty\.pdf/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Spec\.pdf/ }));
    fireEvent.click(screen.getByRole('button', { name: /Add 1 file/ }));
    await waitFor(() => expect(onPick).toHaveBeenCalledWith([expect.objectContaining({ id: 'b' })]));
  });

  it('search re-queries', async () => {
    render(<FilePickerModal open onClose={() => {}} onPick={() => {}} />);
    await screen.findByText('Spec.pdf');
    fireEvent.change(screen.getByLabelText('Search documents'), { target: { value: 'warr' } });
    await waitFor(() => expect((getDocuments as any).mock.calls.at(-1)[0].q).toBe('warr'), { timeout: 2000 });
  });

  it('asks the server for spreadsheet mimes on accept="spreadsheet"', async () => {
    render(<FilePickerModal open onClose={() => {}} onPick={() => {}} accept="spreadsheet" />);
    await waitFor(() => expect((getDocuments as any).mock.calls[0][0].mimes).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ));
  });

  // The hover card is portalled to document.body as `fixed z-[240]` by
  // default, which is BEHIND the Modal overlay's z-[250] — inside the picker
  // it must be raised or it renders behind the dialog it belongs to.
  it('renders the hover preview above the modal overlay', async () => {
    // jsdom's matchMedia has no implementation; the picker only mounts the
    // preview when '(hover: hover)' matches.
    window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as never;

    render(<FilePickerModal open onClose={() => {}} onPick={() => {}} />);
    const row = (await screen.findByText('Spec.pdf')).closest('li')!;
    fireEvent.mouseEnter(row, { clientX: 10, clientY: 10 });

    const card = await screen.findByTestId('doc-hover-preview', undefined, { timeout: 2000 });
    expect(card).toHaveClass('z-[260]');
    expect(card).not.toHaveClass('z-[240]');
    expect(Number(screen.getByTestId('modal-overlay').className.match(/z-\[(\d+)\]/)![1])).toBeLessThan(260);
  });

  it('drops a stale response when the filters change again before it resolves', async () => {
    // Two in-flight requests (the initial fetch, then a filter change) that
    // resolve OUT OF ORDER — the older (first) request's response must be
    // dropped so it can't clobber the newer (second) request's rows.
    const resolvers: ((v: unknown) => void)[] = [];
    (getDocuments as any).mockImplementation(
      () => new Promise(resolve => { resolvers.push(resolve); })
    );

    render(<FilePickerModal open onClose={() => {}} onPick={() => {}} />);
    await waitFor(() => expect(resolvers.length).toBe(1));

    fireEvent.click(screen.getByTestId('doc-filter-archived'));
    await waitFor(() => expect(resolvers.length).toBe(2));

    // Resolve the NEWER (second) request first.
    await act(async () => {
      resolvers[1]({
        rows: [{ id: 'b', name: 'Spec.pdf', mime: 'application/pdf', size: 10, kind: 'document', createdAt: 2, versionNumber: 1, archived: true, projectId: 'p1', projectName: 'Job', customerId: null, customerName: null, source: null }],
        total: 1,
      });
    });
    expect(screen.getByText('Spec.pdf')).toBeInTheDocument();

    // Now let the STALE (first) request resolve — it must not overwrite.
    await act(async () => {
      resolvers[0]({
        rows: [{ id: 'a', name: 'Warranty.pdf', mime: 'application/pdf', size: 10, kind: 'company-document', createdAt: 1, versionNumber: 1, archived: false, projectId: null, projectName: null, customerId: null, customerName: null, source: null }],
        total: 1,
      });
    });
    expect(screen.queryByText('Warranty.pdf')).toBeNull();
    expect(screen.getByText('Spec.pdf')).toBeInTheDocument();
  });
});

describe('FilePickerModal — returnBlobs on the Existing tab', () => {
  it('fetches the bytes of every picked row before handing them over', async () => {
    const onPickBlobs = vi.fn();
    const onClose = vi.fn();
    render(<FilePickerModal open onClose={onClose} onPickBlobs={onPickBlobs} returnBlobs />);
    await screen.findByText('Spec.pdf');

    fireEvent.click(screen.getByRole('checkbox', { name: /Warranty\.pdf/ }));
    fireEvent.click(screen.getByRole('button', { name: /Add 1 file/ }));

    await waitFor(() => expect(onPickBlobs).toHaveBeenCalled());
    expect(fetchFileBlob).toHaveBeenCalledWith('a');
    const picked = onPickBlobs.mock.calls[0][0];
    expect(picked).toHaveLength(1);
    expect(picked[0].row.id).toBe('a');
    expect(picked[0].blob).toBeInstanceOf(Blob);
    expect(onClose).toHaveBeenCalled();
  });
});

describe('FilePickerModal — Upload tab', () => {
  it('has no tabs at all without an upload config', async () => {
    render(<FilePickerModal open onClose={() => {}} onPick={() => {}} />);
    await screen.findByText('Spec.pdf');
    expect(screen.queryByRole('tab', { name: 'Upload' })).toBeNull();
    expect(screen.queryByTestId('picker-upload-panel')).toBeNull();
  });

  it('shows the tabs when given an upload config and opens on Existing by default', async () => {
    render(<FilePickerModal open onClose={() => {}} onPick={() => {}} upload={uploadCfg} />);
    await screen.findByText('Spec.pdf');
    expect(screen.getByRole('tab', { name: 'Upload' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: 'Existing' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('picker-upload-panel')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Upload' }));
    expect(screen.getByTestId('picker-upload-panel')).toBeInTheDocument();
  });

  it('starts on the Upload tab with defaultTab="upload"', async () => {
    render(<FilePickerModal open onClose={() => {}} onPick={() => {}} upload={uploadCfg} defaultTab="upload" />);
    expect(screen.getByTestId('picker-upload-panel')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Upload' })).toHaveAttribute('aria-selected', 'true');
  });

  it('uploads every chosen file, hands back rows built from the stored meta, and closes', async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(
      <FilePickerModal open onClose={onClose} onPick={onPick} accept="image"
        upload={uploadCfg} defaultTab="upload" />
    );
    const a = png('a.png');
    const b = png('b.png');
    fireEvent.change(screen.getByTestId('picker-upload-input'), { target: { files: [a, b] } });

    await waitFor(() => expect(onPick).toHaveBeenCalled());
    expect(uploadProjectFile).toHaveBeenCalledTimes(2);
    expect(uploadProjectFile).toHaveBeenNthCalledWith(1, 'p1', a, 'photo', { sourceType: 'issue', sourceId: 'i1' });
    expect(getFileMeta).toHaveBeenCalledWith('up-a.png');
    expect(onPick.mock.calls[0][0]).toEqual([
      expect.objectContaining({ id: 'up-a.png', name: 'up-a.png.png', kind: 'photo', projectId: 'p1' }),
      expect.objectContaining({ id: 'up-b.png' }),
    ]);
    expect(h.toast).not.toHaveBeenCalledWith(expect.stringContaining('of'), expect.anything());
    expect(onClose).toHaveBeenCalled();
  });

  it('uploads through saveBinaryFile when the config has no project', async () => {
    const onPick = vi.fn();
    render(
      <FilePickerModal open onClose={() => {}} onPick={onPick} accept="image" defaultTab="upload"
        upload={{ kind: 'photo', customerId: 'c1' }} />
    );
    const a = png('a.png');
    fireEvent.change(screen.getByTestId('picker-upload-input'), { target: { files: [a] } });

    await waitFor(() => expect(onPick).toHaveBeenCalled());
    expect(uploadProjectFile).not.toHaveBeenCalled();
    expect(saveBinaryFile).toHaveBeenCalledWith(expect.any(String), a, expect.objectContaining({
      kind: 'photo', name: 'a.png', customerId: 'c1',
    }));
  });

  it('reports a partial failure and still returns what made it', async () => {
    (uploadProjectFile as any).mockRejectedValueOnce(new Error('boom'));
    const onPick = vi.fn();
    render(
      <FilePickerModal open onClose={() => {}} onPick={onPick} accept="image"
        upload={uploadCfg} defaultTab="upload" />
    );
    fireEvent.change(screen.getByTestId('picker-upload-input'), { target: { files: [png('a.png'), png('b.png')] } });

    await waitFor(() => expect(onPick).toHaveBeenCalled());
    expect(h.toast).toHaveBeenCalledWith('Uploaded 1 of 2 files', expect.objectContaining({ type: 'warning' }));
    expect(onPick.mock.calls[0][0]).toEqual([expect.objectContaining({ id: 'up-b.png' })]);
  });

  it('keeps the picker open when every upload fails', async () => {
    (uploadProjectFile as any).mockRejectedValue(new Error('boom'));
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(
      <FilePickerModal open onClose={onClose} onPick={onPick} accept="image"
        upload={uploadCfg} defaultTab="upload" />
    );
    fireEvent.change(screen.getByTestId('picker-upload-input'), { target: { files: [png('a.png')] } });

    await waitFor(() => expect(h.toast).toHaveBeenCalledWith('Uploaded 0 of 1 files', expect.objectContaining({ type: 'error' })));
    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('hands back the original File as the blob when returnBlobs is set', async () => {
    const onPickBlobs = vi.fn();
    render(
      <FilePickerModal open onClose={() => {}} onPickBlobs={onPickBlobs} returnBlobs accept="image"
        upload={uploadCfg} defaultTab="upload" />
    );
    const a = png('a.png');
    fireEvent.change(screen.getByTestId('picker-upload-input'), { target: { files: [a] } });

    await waitFor(() => expect(onPickBlobs).toHaveBeenCalled());
    expect(onPickBlobs.mock.calls[0][0][0].blob).toBe(a);
    expect(onPickBlobs.mock.calls[0][0][0].row.id).toBe('up-a.png');
  });

  it('drops files the accept filter rejects on a drag-drop', async () => {
    const onPick = vi.fn();
    render(
      <FilePickerModal open onClose={() => {}} onPick={onPick} accept="image"
        upload={uploadCfg} defaultTab="upload" />
    );
    const good = png('a.png');
    fireEvent.drop(screen.getByTestId('picker-dropzone'), {
      dataTransfer: { files: [good, new File(['x'], 'plan.pdf', { type: 'application/pdf' })] },
    });

    await waitFor(() => expect(onPick).toHaveBeenCalled());
    expect(uploadProjectFile).toHaveBeenCalledTimes(1);
    expect(uploadProjectFile).toHaveBeenCalledWith('p1', good, 'photo', expect.anything());
  });
});

describe('FilePickerModal — query cost', () => {
  it('does not query documents while it is showing the Upload tab', async () => {
    render(
      <FilePickerModal open onClose={() => {}} onPick={() => {}} upload={uploadCfg} defaultTab="upload" />
    );
    expect(screen.getByTestId('picker-upload-panel')).toBeInTheDocument();
    expect(getDocuments).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('tab', { name: 'Existing' }));
    await screen.findByText('Spec.pdf');
    expect(getDocuments).toHaveBeenCalledTimes(1);
  });
});
