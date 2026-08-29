// src/pages/project/billing/AiaPayAppEditor.test.tsx
//
// The retainage-release box: clearing it is an explicit "release nothing", and
// the figures it shows are rounded so float residue never reaches the user.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AiaPayAppEditor } from './AiaPayAppEditor';
import { ToastProvider } from '../../../components/Toast';
import type { AiaG702, AiaG703Row, AiaPayAppDetail } from '../../../utils/store';

const getPayApp = vi.hoisted(() => vi.fn());
const setPayApp = vi.hoisted(() => vi.fn());
const savePayAppLines = vi.hoisted(() => vi.fn());
const persistGeneratedDocument = vi.hoisted(() => vi.fn());
const getDocumentBySource = vi.hoisted(() => vi.fn());
const buildAiaXlsxBlob = vi.hoisted(() => vi.fn());
const resolveAiaExportEnv = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/store')>();
  return {
    ...actual, getPayApp, setPayApp, savePayAppLines, persistGeneratedDocument, getDocumentBySource,
    getDocumentsBySource: vi.fn(async () => ({})),
    getDocumentTypes: vi.fn(async () => []),
    fetchFileBlob: vi.fn(async () => new Blob(['xlsx'])),
  };
});
vi.mock('./aiaExcel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./aiaExcel')>()),
  buildAiaXlsxBlob,
}));
vi.mock('./aiaExportShared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./aiaExportShared')>()),
  resolveAiaExportEnv,
}));
// The document bar keeps its status chip live through useLiveQuery, which
// needs the collaboration socket; a null socket is enough here.
vi.mock('../../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: null, sessions: [], mySessionId: 'me' }),
}));
vi.mock('../../documents/DocumentViewerModal', () => ({
  DocumentViewerModal: () => <div data-testid="viewer" />,
}));

const app: AiaPayAppDetail = {
  id: 'app2', projectId: 'p1', number: 2, periodTo: null, applicationDate: null,
  retainagePercent: 15, storedRetainagePercent: 15, releasedRetainagePoints: 5,
  status: 'draft', version: 4, createdAt: 0, updatedAt: 100, payments: [],
};

const g702 = (over: Partial<AiaG702['retainage']> = {}): AiaG702 => ({
  L1originalContractCents: 10000000, L2changeOrdersCents: 0, L3contractSumToDateCents: 10000000,
  L4totalCompletedStoredCents: 5000000, L5aRetainageWorkCents: 500000, L5bRetainageStoredCents: 0,
  L5retainageCents: 500000, L6earnedLessRetainageCents: 4500000, L7lessPreviousCents: 4250000,
  L8currentPaymentDueCents: 250000, L9balanceToFinishCents: 5500000,
  changeOrders: { additionsCents: 0, deductionsCents: 0, netCents: 0 },
  retainage: {
    mode: 'uniform', baseWorkPercent: 15, cumulativeReleasedPoints: 5,
    releasedThisApp: 5, remainingPoints: 15, effectiveWorkPercent: 10, ...over,
  },
});

const g703Row = (over: Partial<AiaG703Row> = {}): AiaG703Row => ({
  sovLineId: 'sov1', itemNo: '001', description: 'Mobilization', isChangeOrder: 0,
  scheduledValueCents: 100000, previousCents: 0, thisPeriodCents: 0, storedCents: 0,
  totalToDateCents: 0, percentComplete: 0, balanceToFinishCents: 100000, retainageCents: 0,
  ...over,
});

const load = (retainageOver: Partial<AiaG702['retainage']> = {}) => ({
  app, lines: [], g703: [], g702: g702(retainageOver),
});

// What the server hands back on a re-read — deliberately a different object
// (and different numbers) from the first load, so "built from saved data" is
// falsifiable.
const SAVED = {
  app: { ...app, releasedRetainagePoints: 7, version: 5, updatedAt: 200 },
  lines: [], g703: [g703Row({ percentComplete: 50, totalToDateCents: 50000 })], g702: g702(),
};

const ENV = {
  project: { id: 'p1', name: 'Test Project', contractor: 'GC Inc' },
  settings: {}, aiaSettings: {}, sovLines: [],
  company: { name: 'My Co' }, template: undefined, templateLoadFailed: false,
};

beforeEach(() => {
  getPayApp.mockReset();
  setPayApp.mockReset().mockResolvedValue({ version: 5 });
  savePayAppLines.mockReset().mockResolvedValue({ version: 5 });
  getPayApp.mockResolvedValue(load());
  persistGeneratedDocument.mockReset().mockResolvedValue({ fileId: 'file-9', versioned: true });
  getDocumentBySource.mockReset().mockResolvedValue(null);
  buildAiaXlsxBlob.mockReset().mockResolvedValue(new Blob(['xlsx']));
  resolveAiaExportEnv.mockReset().mockResolvedValue(ENV);
});

const renderEditor = () =>
  render(
    <MemoryRouter>
      <ToastProvider>
        <AiaPayAppEditor payAppId="app2" onClose={vi.fn()} onSaved={vi.fn()} />
      </ToastProvider>
    </MemoryRouter>
  );

const releaseInput = () => screen.getByLabelText(/Release retainage on this application/);

describe('AiaPayAppEditor — retainage release box', () => {
  it('treats a cleared box as releasing 0, not as "leave it alone"', async () => {
    renderEditor();
    await waitFor(() => expect(releaseInput()).toHaveValue(5));

    fireEvent.change(releaseInput(), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(setPayApp).toHaveBeenCalledTimes(1));
    expect(setPayApp.mock.calls[0][1]).toEqual({ releasedRetainagePoints: 0 });
  });

  it('sends no release patch when the box is left at its loaded value', async () => {
    renderEditor();
    await waitFor(() => expect(releaseInput()).toHaveValue(5));

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(savePayAppLines).toHaveBeenCalledTimes(1));
    expect(setPayApp).not.toHaveBeenCalled(); // nothing changed → nothing patched
  });

  it('rounds the figures it displays and the value Release-all types in', async () => {
    getPayApp.mockResolvedValue(load({
      cumulativeReleasedPoints: 8.049999999999999,
      remainingPoints: 6.949999999999999,
      effectiveWorkPercent: 6.949999999999999,
    }));
    renderEditor();

    const releaseAll = await screen.findByRole('button', { name: 'Release all remaining (6.95%)' });
    expect(screen.getByText(/Base 15% · Released 8.05% · Effective 6.95%/)).toBeTruthy();

    fireEvent.click(releaseAll);
    expect(releaseInput()).toHaveValue(6.95);
  });
});

// ---------------------------------------------------------------------------
// Document actions (spec
// docs/superpowers/specs/2026-08-29-document-actions-rollout-design.md).
// The editor stopped owning Excel delivery: DocumentActionsBar does. What
// stays the editor's job is a build() that reads the SAVED pay app, so the
// stored workbook can never disagree with the record it claims to represent.

describe('AiaPayAppEditor — document actions', () => {
  it('mounts the shared bar in Excel wording and drops its own Export button', async () => {
    renderEditor();

    const generate = await screen.findByTestId('doc-generate');
    expect(generate).toHaveTextContent('Generate Excel');
    expect(await screen.findByText('No Excel yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Export AIA Excel/i })).toBeNull();
    // Email is not part of the AIA flow; Close/Finalize/Save stay the editor's.
    expect(screen.queryByTestId('doc-send')).toBeNull();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Finalize' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('saves the draft first, then builds from the pay app the server now holds', async () => {
    getPayApp.mockResolvedValueOnce(load()).mockResolvedValue(SAVED);
    renderEditor();
    await waitFor(() => expect(releaseInput()).toHaveValue(5));

    fireEvent.change(releaseInput(), { target: { value: '9' } });
    fireEvent.click(await screen.findByTestId('doc-generate'));

    await waitFor(() => expect(setPayApp).toHaveBeenCalledTimes(1));
    expect(setPayApp.mock.calls[0][1]).toEqual({ releasedRetainagePoints: 9 });

    await waitFor(() => expect(buildAiaXlsxBlob).toHaveBeenCalledTimes(1));
    const ctx = buildAiaXlsxBlob.mock.calls[0][0];
    // The re-read record — not the component's loaded copy and not the draft.
    expect(ctx.app).toBe(SAVED.app);
    expect(ctx.g702).toBe(SAVED.g702);
    expect(ctx.g703).toBe(SAVED.g703);
    expect(ctx.projectName).toBe('Test Project');
    expect(resolveAiaExportEnv).toHaveBeenCalledWith('p1');

    await waitFor(() => expect(persistGeneratedDocument).toHaveBeenCalledTimes(1));
    expect(persistGeneratedDocument.mock.calls[0][1]).toMatchObject({
      projectId: 'p1', kind: 'payapp-export', name: 'Pay App #2 — G702.xlsx',
      sourceType: 'payapp', sourceId: 'app2',
    });
  });

  it('reports a failed re-read instead of storing pre-save bytes', async () => {
    getPayApp.mockResolvedValueOnce(load()).mockRejectedValue(new Error('offline'));
    renderEditor();
    await waitFor(() => expect(releaseInput()).toHaveValue(5));

    fireEvent.click(screen.getByTestId('doc-generate'));

    expect(await screen.findByText('Failed to generate the Excel')).toBeInTheDocument();
    expect(buildAiaXlsxBlob).not.toHaveBeenCalled();
    expect(persistGeneratedDocument).not.toHaveBeenCalled();
  });

  it('still exports the built-in recreation when the admin template fails to load', async () => {
    resolveAiaExportEnv.mockResolvedValue({ ...ENV, templateLoadFailed: true });
    renderEditor();
    await waitFor(() => expect(releaseInput()).toHaveValue(5));

    fireEvent.click(screen.getByTestId('doc-generate'));

    expect(await screen.findByText(/AIA template failed to load/)).toBeInTheDocument();
    await waitFor(() => expect(persistGeneratedDocument).toHaveBeenCalledTimes(1));
    expect(buildAiaXlsxBlob.mock.calls[0][1]).toBeUndefined(); // no template → recreation
  });

  it('does not count a numerically identical retyped figure as an unsaved edit', async () => {
    // The bar saves before generating when the editor is dirty. A raw string
    // compare made "5" → "5.0" (or a re-typed percentage) look like an edit,
    // so every generate fired a pointless save — and, on a finalized app whose
    // Save is disabled, would have failed outright.
    renderEditor();
    await waitFor(() => expect(releaseInput()).toHaveValue(5));

    fireEvent.change(releaseInput(), { target: { value: '5.0' } });
    fireEvent.click(screen.getByTestId('doc-generate'));

    await waitFor(() => expect(persistGeneratedDocument).toHaveBeenCalledTimes(1));
    expect(setPayApp).not.toHaveBeenCalled();
    expect(savePayAppLines).not.toHaveBeenCalled();
  });
});
