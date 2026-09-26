// src/pages/documents/FileThumb.test.tsx — page-one thumbnails in the
// Documents list: asked for only for editor files, waited for while being
// made (202), remembered per file version, and the type icon otherwise.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { FileThumb, resetThumbnailCache, useThumbnail } from './FileThumb';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'f1', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', name: 'Letter.docx',
  versionNumber: 2, createdAt: 100, ...over,
});

let responses: number[];
const fetchMock = vi.fn(async () => {
  const status = responses.shift() ?? 404;
  return new Response(status === 200 ? 'png' : '{}', { status });
});

beforeEach(() => {
  resetThumbnailCache();
  responses = [];
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:thumb');
});
afterEach(() => vi.unstubAllGlobals());

const Probe: React.FC<{ r: ReturnType<typeof row> }> = ({ r }) => {
  const url = useThumbnail(r, true, async () => {});
  return <span data-testid="url">{url ?? 'none'}</span>;
};

describe('FileThumb', () => {
  it('waits while it is being made, then shows page one; asks with the file version', async () => {
    responses = [202, 202, 200];
    render(<Probe r={row()} />);
    await waitFor(() => expect(screen.getByTestId('url')).toHaveTextContent('blob:thumb'));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('/api/onlyoffice/thumbnail/f1?v=2-100');
  });

  it('remembers the answer for that version', async () => {
    responses = [200];
    const first = render(<Probe r={row()} />);
    await waitFor(() => expect(screen.getByTestId('url')).toHaveTextContent('blob:thumb'));
    first.unmount();
    render(<Probe r={row()} />);
    expect(screen.getByTestId('url')).toHaveTextContent('blob:thumb');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows the icon when there is none, and never asks for images', async () => {
    responses = [404];
    render(<FileThumb row={row()} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('file-thumb')).toBeNull();

    fetchMock.mockClear();
    render(<FileThumb row={row({ id: 'p', mime: 'image/png', name: 'site.png' })} />);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the picture once it is ready', async () => {
    responses = [200];
    render(<FileThumb row={row({ id: 'f2' })} />);
    expect(await screen.findByTestId('file-thumb')).toBeInTheDocument();
  });
});
