import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { FilePickerModal } from './FilePickerModal';

vi.mock('../utils/store', async (orig) => ({
  ...(await orig<typeof import('../utils/store')>()),
  getDocuments: vi.fn(async (f: any) => ({
    rows: [
      { id: 'a', name: 'Warranty.pdf', mime: 'application/pdf', size: 10, kind: 'company-document', createdAt: 1, versionNumber: 1, archived: false, projectId: null, projectName: null, customerId: null, customerName: null, source: null },
      { id: 'b', name: 'Spec.pdf', mime: 'application/pdf', size: 10, kind: 'document', createdAt: 2, versionNumber: 1, archived: false, projectId: 'p1', projectName: 'Job', customerId: null, customerName: null, source: null },
    ].filter(r => !f.q || r.name.toLowerCase().includes(f.q.toLowerCase())),
    total: 2,
  })),
  getProjectsSummary: vi.fn(async () => []),
  getCustomers: vi.fn(async () => []),
  getDocumentTypes: vi.fn(async () => []),
}));
import { getDocuments } from '../utils/store';

beforeEach(() => { localStorage.setItem('user', JSON.stringify({ id: 'u', role: 'admin' })); vi.clearAllMocks(); });

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
