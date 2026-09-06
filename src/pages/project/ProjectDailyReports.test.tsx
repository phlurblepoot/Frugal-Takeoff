import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor as rtlWaitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import React from 'react';

const { fakeSocket, getDailyReports, getDailyReport, getDocumentsBySource } = vi.hoisted(() => {
  const handlers: Record<string, ((...a: any[]) => void)[]> = {};
  const fakeSocket = {
    handlers,
    on: vi.fn((e: string, cb: any) => { (handlers[e] ??= []).push(cb); return fakeSocket; }),
    off: vi.fn((e: string, cb: any) => { handlers[e] = (handlers[e] ?? []).filter(h => h !== cb); return fakeSocket; }),
    emit: vi.fn(),
    fire: (e: string, ...a: any[]) => (handlers[e] ?? []).forEach(cb => cb(...a)),
  };
  return { fakeSocket, getDailyReports: vi.fn(), getDailyReport: vi.fn(), getDocumentsBySource: vi.fn() };
});
vi.mock('../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: fakeSocket, sessions: [], mySessionId: 'sock-1' }),
}));
// Not under test here — see ReplyFlagChip/useReplyFlags.test for that; a real
// fetch would otherwise fire (and outlive) this file's tests.
vi.mock('../../hooks/useReplyFlags', () => ({ useReplyFlags: () => new Set<string>() }));
vi.mock('../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDailyReports, getDailyReport, getDocumentsBySource,
  getDocumentTypes: vi.fn(async () => []),
  fetchFileBlob: vi.fn(async () => new Blob(['pdf'])),
}));
vi.mock('../documents/DocumentViewerModal', () => ({
  DocumentViewerModal: ({ row, onClose }: any) => (
    <div data-testid="viewer">
      <span>{row.name}</span>
      <button onClick={onClose}>close viewer</button>
    </div>
  ),
}));

// A stand-in editor that reports every mount: the list must not re-key it when
// the editor saves itself, or the document bar inside it would be torn down
// mid-flow.
const mounts = { count: 0 };
vi.mock('./daily/DailyReportEditor', () => ({
  DailyReportEditor: ({ onSaved }: any) => {
    React.useEffect(() => { mounts.count += 1; }, []);
    return (
      <div data-testid="editor">
        <button data-testid="save-kept" onClick={() => onSaved({ keepMounted: true })}>save kept</button>
        <button data-testid="save-plain" onClick={() => onSaved()}>save plain</button>
      </div>
    );
  },
}));
vi.mock('./ProjectLayout', () => ({
  useProjectOutlet: () => ({ summary: { name: 'P1', contractor: '' } }),
}));

import { ProjectDailyReports, manCountTotal, formatReportDate } from './ProjectDailyReports';

function mount() {
  return render(
    <MemoryRouter initialEntries={['/project/p1/daily']}>
      <Routes><Route path="/project/:projectId/daily" element={<ProjectDailyReports />} /></Routes>
    </MemoryRouter>
  );
}

describe('manCountTotal', () => {
  it('sums counts', () => { expect(manCountTotal([{ type: 'Plasterer', count: 4 }, { type: 'Supervisor', count: 1 }])).toBe(5); });
  it('ignores non-finite/negative counts and empty lists', () => {
    expect(manCountTotal([])).toBe(0);
    expect(manCountTotal([{ type: 'x', count: NaN as any }, { type: 'y', count: -2 }, { type: 'z', count: 3 }])).toBe(3);
  });
});
describe('formatReportDate', () => {
  it('renders YYYY-MM-DD as a readable local date without timezone drift', () => {
    expect(formatReportDate('2026-08-26')).toBe('Aug 26, 2026');   // must NOT show Aug 25 in negative-offset timezones
  });
  it('falls back to the raw string when malformed', () => { expect(formatReportDate('garbage')).toBe('garbage'); });
});

// ---------------------------------------------------------------------------
// Document status on rows + editor remounting (spec
// docs/superpowers/specs/2026-08-29-document-actions-rollout-design.md)

const listRow = (over: Record<string, any> = {}) => ({
  id: 'dr1', projectId: 'p1', reportDate: '2026-08-26', jobName: 'Big Job', contractorName: 'GC',
  weatherSummary: 'Sunny', temperature: '78F', manCounts: [], createdBy: null,
  createdAt: 1, updatedAt: 10, version: 1, photoCount: 0,
  ...over,
});

const FILE = { id: 'f1', name: 'DailyReport-2026-08-26.pdf', mime: 'application/pdf', size: 12, createdAt: 50, versionNumber: 1 };

describe('ProjectDailyReports — report status on rows', () => {
  beforeEach(() => {
    // These tests exercise the table, so force the List view — calendar is
    // the default but the table's row-level behavior is what's under test here.
    localStorage.setItem('dailyReports:view', 'list');
    getDailyReports.mockReset();
    getDailyReport.mockReset();
    getDocumentsBySource.mockReset();
    for (const k of Object.keys(fakeSocket.handlers)) delete fakeSocket.handlers[k];
    getDailyReports.mockResolvedValue([listRow(), listRow({ id: 'dr2', reportDate: '2026-08-27' })]);
    getDocumentsBySource.mockResolvedValue({ dr1: FILE, dr2: null });
    getDailyReport.mockResolvedValue(null);
  });

  it('shows a chip and an Open button only for the report that has a PDF', async () => {
    mount();
    await screen.findByText('Aug 26, 2026');
    await rtlWaitFor(() => expect(getDocumentsBySource).toHaveBeenCalled());
    expect(getDocumentsBySource.mock.calls[0][0]).toMatchObject({
      sourceType: 'dailyReport', kind: 'daily-report', sourceIds: ['dr1', 'dr2'],
    });

    await rtlWaitFor(() => expect(screen.getByText('PDF up to date')).toBeInTheDocument());
    expect(screen.queryByText('No PDF yet')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Open PDF' })).toHaveLength(1);
  });

  it('marks the chip out of date when the report changed after the PDF was made', async () => {
    getDocumentsBySource.mockResolvedValue({ dr1: { ...FILE, createdAt: 5 }, dr2: null });
    mount();
    await rtlWaitFor(() => expect(screen.getByText('PDF out of date')).toBeInTheDocument());
  });

  it('opens the viewer instead of the editor when Open is clicked', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Open PDF' }));

    expect(await screen.findByTestId('viewer')).toBeInTheDocument();
    expect(screen.getByText('DailyReport-2026-08-26.pdf')).toBeInTheDocument();
    expect(getDailyReport).not.toHaveBeenCalled();
  });

  it('keeps the editor mounted for its own saves and re-keys it for outside refreshes', async () => {
    getDailyReport.mockResolvedValue({ ...listRow(), photos: [] });
    mounts.count = 0;
    mount();

    fireEvent.click(await screen.findByText('Aug 26, 2026'));
    await screen.findByTestId('editor');
    await rtlWaitFor(() => expect(mounts.count).toBe(1));

    // act() flushes the reload's promises and the resulting render, so a
    // remount would already have happened by the time we count.
    await act(async () => { fireEvent.click(screen.getByTestId('save-kept')); });
    expect(getDailyReport).toHaveBeenCalledTimes(2); // open + reload
    expect(mounts.count).toBe(1);

    // A refresh that found nothing new must not throw away a typed draft.
    await act(async () => { fireEvent.click(screen.getByTestId('save-plain')); });
    expect(mounts.count).toBe(1);

    // A record that actually moved on does re-key the editor.
    getDailyReport.mockResolvedValue({ ...listRow({ version: 2 }), photos: [] });
    await act(async () => { fireEvent.click(screen.getByTestId('save-plain')); });
    expect(mounts.count).toBe(2);
  });
});

describe('ProjectDailyReports — calendar/list view toggle', () => {
  beforeEach(() => {
    getDailyReports.mockReset();
    getDailyReport.mockReset();
    getDocumentsBySource.mockReset();
    for (const k of Object.keys(fakeSocket.handlers)) delete fakeSocket.handlers[k];
    getDailyReports.mockResolvedValue([listRow()]);
    getDocumentsBySource.mockResolvedValue({ dr1: null });
    getDailyReport.mockResolvedValue(null);
    localStorage.clear();
  });

  it('defaults to the calendar view', async () => {
    mount();
    expect(await screen.findByTestId('daily-calendar')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('toggling to List shows the table and persists the choice', async () => {
    mount();
    await screen.findByTestId('daily-calendar');

    fireEvent.click(screen.getByRole('tab', { name: 'List' }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.queryByTestId('daily-calendar')).not.toBeInTheDocument();
    expect(localStorage.getItem('dailyReports:view')).toBe('list');
  });

  it('a new mount respects a previously stored List preference', async () => {
    localStorage.setItem('dailyReports:view', 'list');
    mount();
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.queryByTestId('daily-calendar')).not.toBeInTheDocument();
  });
});
