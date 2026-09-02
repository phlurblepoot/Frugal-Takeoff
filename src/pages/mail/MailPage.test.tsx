// src/pages/mail/MailPage.test.tsx
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { MailAccount, MailFolder, ThreadListRow } from './types';

const h = vi.hoisted(() => ({
  accounts: vi.fn(), folders: vi.fn(), threads: vi.fn(),
  threadActions: vi.fn(), heartbeat: vi.fn(), loadOlder: vi.fn(), toast: vi.fn(),
}));
vi.mock('../../utils/mailApi', () => ({ mailApi: h }));
vi.mock('../../context/CollaborationContext', () => ({ useCollaboration: () => ({ socket: null }) }));
vi.mock('../../components/Toast', async orig => ({
  ...(await orig<typeof import('../../components/Toast')>()),
  useToast: () => ({ toast: h.toast }),
}));

import { MailPage } from './MailPage';

const ACCOUNT: MailAccount = {
  id: 'a1', provider: 'imap', emailAddress: 'nathan@bigbearplaster.com', displayName: 'Nathan',
  signatureHtml: null, isDefault: 1, status: 'ok', lastSyncAt: null, lastError: null,
  indexedSince: '2026-02-01T00:00:00.000Z', unreadCount: 2,
};
const FOLDERS: MailFolder[] = [
  { id: 'f-inbox', accountId: 'a1', providerId: 'INBOX', name: 'INBOX', role: 'inbox', unreadCount: 2, totalCount: 9, sortOrder: 0 },
  { id: 'f-sent', accountId: 'a1', providerId: 'Sent', name: 'Sent', role: 'sent', unreadCount: 0, totalCount: 4, sortOrder: 1 },
];
const THREAD: ThreadListRow = {
  threadKey: 'tk-1', subject: 'Roof detail', firstDate: '2026-08-27T12:00:00.000Z',
  lastDate: '2026-08-27T12:00:00.000Z', messageCount: 2, unreadCount: 1, hasAttachments: 1, isStarred: 0,
  participants: [{ addr: 'bob@acme.com', name: 'Bob Smith' }], folderIds: ['f-inbox'],
  snippet: 'Please review the attached detail', links: [],
};

const Probe: React.FC = () => {
  const loc = useLocation();
  return <span data-testid="loc">{`${loc.pathname}${loc.search}`}</span>;
};

const mount = (path = '/mail') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        {['mail', 'mail/:accountId', 'mail/:accountId/:folderId', 'mail/:accountId/:folderId/:threadKey'].map(p => (
          <Route key={p} path={`/${p}`} element={<MailPage />} />
        ))}
        <Route path="/settings" element={<h1>Settings</h1>} />
      </Routes>
      <Probe />
    </MemoryRouter>,
  );

const loc = () => screen.getByTestId('loc').textContent;
const folderRow = (id: string): HTMLElement =>
  screen.getAllByTestId('mail-folder-row').find(r => r.getAttribute('data-folder-id') === id)!;

beforeEach(() => {
  vi.clearAllMocks();
  h.accounts.mockResolvedValue([ACCOUNT]);
  h.folders.mockResolvedValue(FOLDERS);
  h.threads.mockResolvedValue({ threads: [THREAD], hasMore: false, indexedSince: '2026-02-01T00:00:00.000Z' });
  h.threadActions.mockResolvedValue(undefined);
  h.heartbeat.mockResolvedValue(undefined);
  h.loadOlder.mockResolvedValue({ indexedSince: '2025-08-01T00:00:00.000Z' });
});

describe('MailPage', () => {
  it('sends a user with no mail accounts to the mail settings tab', async () => {
    h.accounts.mockResolvedValue([]);
    mount();
    await screen.findByText('Connect a mail account');
    fireEvent.click(screen.getByRole('button', { name: /mail settings/i }));
    await waitFor(() => expect(loc()).toBe('/settings?tab=mail'));
    expect(h.threads).not.toHaveBeenCalled();
  });

  it('lands on the default account inbox and lists its threads', async () => {
    mount();
    await waitFor(() => expect(loc()).toBe('/mail/a1/f-inbox'));
    expect(await screen.findByText('Roof detail')).toBeInTheDocument();
    expect(screen.getByTestId('mail-thread-row')).toHaveAttribute('data-unread', 'true');
    expect(h.threads).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'a1', folderId: 'f-inbox' }));
  });

  it('falls back to the "_" no-folder id when the account has no inbox folder', async () => {
    h.folders.mockResolvedValue([FOLDERS[1]]);
    mount();
    await waitFor(() => expect(loc()).toBe('/mail/a1/_'));
    await waitFor(() => expect(h.threads).toHaveBeenCalledWith(expect.not.objectContaining({ folderId: expect.anything() })));
  });

  it('opens a thread by URL and keeps the selection in the list', async () => {
    mount('/mail/a1/f-inbox');
    await screen.findByText('Roof detail');
    fireEvent.click(screen.getByTestId('mail-thread-row'));
    await waitFor(() => expect(loc()).toBe('/mail/a1/f-inbox/tk-1'));
    expect(screen.getByTestId('mail-thread-row')).toHaveAttribute('data-selected', 'true');
    expect(screen.getByTestId('mail-thread-slot')).toHaveAttribute('data-thread-key', 'tk-1');
  });

  it('renders a deep-linked thread straight away', async () => {
    mount('/mail/a1/f-inbox/tk-1');
    await waitFor(() => expect(screen.getByTestId('mail-thread-slot')).toHaveAttribute('data-thread-key', 'tk-1'));
  });

  it('switches folder from the rail without leaving the account', async () => {
    mount('/mail/a1/f-inbox');
    await screen.findByText('Roof detail');
    fireEvent.click(folderRow('f-sent'));
    await waitFor(() => expect(loc()).toBe('/mail/a1/f-sent'));
  });

  it('waits for the new account\'s own folders before picking its inbox', async () => {
    const a2: MailAccount = { ...ACCOUNT, id: 'a2', emailAddress: 'office@bigbearplaster.com', isDefault: 0 };
    const a2Inbox: MailFolder = { ...FOLDERS[0], id: 'f2-inbox', accountId: 'a2' };
    h.accounts.mockResolvedValue([ACCOUNT, a2]);
    h.folders.mockImplementation(async (id: string) => (id === 'a1' ? FOLDERS : [a2Inbox]));

    mount('/mail/a1/f-inbox');
    await screen.findByText('Roof detail');
    fireEvent.change(screen.getByLabelText('Mail account'), { target: { value: 'a2' } });

    await waitFor(() => expect(loc()).toBe('/mail/a2/f2-inbox'));
  });

  it('stars a thread through the thread action route', async () => {
    mount('/mail/a1/f-inbox');
    await screen.findByText('Roof detail');
    fireEvent.click(screen.getByRole('button', { name: /^Star$/ }));
    await waitFor(() => expect(h.threadActions).toHaveBeenCalledWith('a1', ['tk-1'], 'star'));
  });

  it('debounces the search box into the ?q= query string', async () => {
    mount('/mail/a1/f-inbox');
    await screen.findByText('Roof detail');
    fireEvent.change(screen.getByPlaceholderText(/search mail/i), { target: { value: 'roof' } });
    await waitFor(() => expect(loc()).toBe('/mail/a1/f-inbox?q=roof'));
    await waitFor(() => expect(h.threads).toHaveBeenCalledWith(expect.objectContaining({ q: 'roof' })));
  });

  it('offers to backfill older mail from the end of the list', async () => {
    mount('/mail/a1/f-inbox');
    await screen.findByText('Roof detail');
    fireEvent.click(screen.getByRole('button', { name: /load older mail/i }));
    await waitFor(() => expect(h.loadOlder).toHaveBeenCalledWith('a1', 6));
    expect(h.toast).toHaveBeenCalled();
  });

  it('keeps the mailbox syncing with a heartbeat for the open account', async () => {
    mount('/mail/a1/f-inbox');
    await waitFor(() => expect(h.heartbeat).toHaveBeenCalledWith(['a1']));
  });

  it('routes Compose through the ?compose=1 URL flag', async () => {
    mount('/mail/a1/f-inbox');
    await screen.findByText('Roof detail');
    // Two entry points by design: the rail (>= md) and the mobile folder bar.
    const composeButtons = screen.getAllByRole('button', { name: /compose/i });
    expect(composeButtons).toHaveLength(2);
    fireEvent.click(composeButtons[0]);
    await waitFor(() => expect(loc()).toBe('/mail/a1/f-inbox?compose=1'));
  });
});
