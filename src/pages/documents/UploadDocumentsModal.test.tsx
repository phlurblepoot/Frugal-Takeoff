// src/pages/documents/UploadDocumentsModal.test.tsx
//
// Two invariants the labeling popup has to hold: what the Type select shows is
// what gets uploaded (including for files dropped onto the page), and a partial
// failure leaves exactly the failures behind, so pressing Upload again retries
// instead of duplicating the rows that already landed.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { UploadDocumentsModal } from './UploadDocumentsModal';
import { ToastProvider } from '../../components/Toast';

const saveBinaryFile = vi.hoisted(() => vi.fn());
vi.mock('../../utils/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/store')>();
  return { ...actual, saveBinaryFile };
});

// A .png so a MIME-based guess ('photo') would differ from the shared default.
const png = (name = 'shot.png') => new File([new Uint8Array([1])], name, { type: 'image/png' });

const project = { id: 'proj1', name: 'Test Project', customerId: 'cust1' } as any;

const renderModal = (initialFiles?: File[]) =>
  render(
    <ToastProvider>
      <UploadDocumentsModal
        open
        onClose={() => {}}
        onUploaded={() => {}}
        projects={[project]}
        customers={[]}
        customTypes={[]}
        initialFiles={initialFiles}
      />
    </ToastProvider>
  );

beforeEach(() => {
  saveBinaryFile.mockReset().mockResolvedValue({ fileId: 'f1' });
});

describe('UploadDocumentsModal', () => {
  it('uploads drag-dropped files as the shared Type the select shows, not a MIME guess', async () => {
    renderModal([png()]);
    expect((screen.getByLabelText('Type') as HTMLSelectElement).value).toBe('document');

    fireEvent.click(screen.getByRole('button', { name: /Upload \(1\)/ }));
    await waitFor(() => expect(saveBinaryFile).toHaveBeenCalledTimes(1));
    expect(saveBinaryFile.mock.calls[0][2]).toMatchObject({ kind: 'document' });
  });

  it('follows the shared Type when it changes', async () => {
    renderModal([png()]);
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'photo' } });

    fireEvent.click(screen.getByRole('button', { name: /Upload \(1\)/ }));
    await waitFor(() => expect(saveBinaryFile).toHaveBeenCalledTimes(1));
    expect(saveBinaryFile.mock.calls[0][2]).toMatchObject({ kind: 'photo' });
  });

  it('drops the succeeded chips after a partial failure so a retry cannot duplicate them', async () => {
    saveBinaryFile
      .mockResolvedValueOnce({ fileId: 'a' })
      .mockRejectedValueOnce(new Error('network'));
    renderModal([png('a.png'), png('b.png')]);

    fireEvent.click(screen.getByRole('button', { name: /Upload \(2\)/ }));
    await waitFor(() => expect(saveBinaryFile).toHaveBeenCalledTimes(2));

    // Only the failure is left on screen — and in the batch.
    await waitFor(() => expect(screen.queryByText('a.png')).not.toBeInTheDocument());
    expect(screen.getByText('b.png')).toBeInTheDocument();

    saveBinaryFile.mockResolvedValue({ fileId: 'b' });
    fireEvent.click(screen.getByRole('button', { name: /Upload \(1\)/ }));
    await waitFor(() => expect(saveBinaryFile).toHaveBeenCalledTimes(3));
    expect((saveBinaryFile.mock.calls[2][1] as File).name).toBe('b.png');
  });

  it('selecting company-document disables the Project select and uploads carry no projectId', async () => {
    renderModal([png()]);
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj1' } });
    expect((screen.getByLabelText('Project') as HTMLSelectElement).value).toBe('proj1');

    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'company-document' } });
    expect(screen.getByLabelText('Project')).toBeDisabled();
    expect((screen.getByLabelText('Project') as HTMLSelectElement).value).toBe('');
    expect(screen.getByText("Company documents aren't tied to a project.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Upload \(1\)/ }));
    await waitFor(() => expect(saveBinaryFile).toHaveBeenCalledTimes(1));
    expect(saveBinaryFile.mock.calls[0][2]).toMatchObject({ kind: 'company-document' });
    expect(saveBinaryFile.mock.calls[0][2]).not.toHaveProperty('projectId');
  });

  it('gates projectId/customerId per entry when per-file typing mixes company-document with a project-tagged file', async () => {
    renderModal([png('shared.png'), png('company.png')]);
    fireEvent.click(screen.getByLabelText('Set type per file'));
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'proj1' } });
    fireEvent.change(screen.getByLabelText('Type for company.png'), { target: { value: 'company-document' } });
    // Only one file opted into company-document — the batch isn't
    // company-document-only, so the Project select stays as the person set it.
    expect(screen.getByLabelText('Project')).toBeEnabled();
    expect((screen.getByLabelText('Project') as HTMLSelectElement).value).toBe('proj1');

    fireEvent.click(screen.getByRole('button', { name: /Upload \(2\)/ }));
    await waitFor(() => expect(saveBinaryFile).toHaveBeenCalledTimes(2));

    const shared = saveBinaryFile.mock.calls.find(c => (c[1] as File).name === 'shared.png')!;
    const company = saveBinaryFile.mock.calls.find(c => (c[1] as File).name === 'company.png')!;
    expect(shared[2]).toMatchObject({ kind: 'document', projectId: 'proj1', customerId: 'cust1' });
    expect(company[2]).toMatchObject({ kind: 'company-document' });
    expect(company[2]).not.toHaveProperty('projectId');
    expect(company[2]).not.toHaveProperty('customerId');
  });

  it('re-enables the Project select when the Type is changed away from company-document', async () => {
    renderModal([png()]);
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'company-document' } });
    expect(screen.getByLabelText('Project')).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'document' } });
    expect(screen.getByLabelText('Project')).toBeEnabled();
  });
});
