// src/pages/mail/MailPage.tsx — the mail client shell: folder rail, thread
// list, and the reading pane. All of the page's state lives in the URL
// (`/mail/:accountId/:folderId/:threadKey` + `?q=` + `?compose=1`) so a thread
// can be linked to from anywhere in the app.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Mail, MailOpen } from 'lucide-react';
import { Button, EmptyState, Skeleton } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { mailApi } from '../../utils/mailApi';
import { MailComposer } from './compose/MailComposer';
import { FolderRail, orderFolders } from './FolderRail';
import type { ReplyMode } from './MessageCard';
import { SaveAttachmentsModal } from './SaveAttachmentsModal';
import { ThreadList } from './ThreadList';
import { useMailAccounts } from './useMailAccounts';
import { useMailFolders } from './useMailFolders';
import { useMailHeartbeat } from './useMailHeartbeat';
import { ThreadView } from './ThreadView';
import { NO_FOLDER, useThreadList } from './useThreadList';
import type { MessageRow, ThreadListRow } from './types';

/** The data a reply/forward composer needs — everything but where it renders
 *  (modal vs. inline), which is tracked separately so promoting one to the
 *  other never re-seeds it (see `replyVariant` below). */
interface ReplyComposerState {
  mode: ReplyMode;
  message: MessageRow;
  bodyHtml: string;
}

export const MailPage: React.FC = () => {
  const { accountId = null, folderId = null, threadKey = null } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { toast } = useToast();

  const q = searchParams.get('q') ?? '';
  const { accounts, loading: accountsLoading } = useMailAccounts();
  const { folders, loading: foldersLoading } = useMailFolders(accountId);
  const list = useThreadList(accountId, folderId, q);
  const { reload: reloadList } = list;
  useMailHeartbeat(accountId);

  const ownAddresses = useMemo(() => accounts.map(a => a.emailAddress), [accounts]);
  const railFolders = useMemo(() => {
    const { roleFolders, labelFolders } = orderFolders(folders);
    return [...roleFolders, ...labelFolders];
  }, [folders]);
  // Search survives folder/thread navigation; ?compose=1 does not.
  const search = q ? `?q=${encodeURIComponent(q)}` : '';

  // Land on the default mailbox…
  useEffect(() => {
    if (accountsLoading || accountId || accounts.length === 0) return;
    const target = accounts.find(a => a.isDefault) ?? accounts[0];
    navigate(`/mail/${target.id}${search}`, { replace: true });
  }, [accountsLoading, accountId, accounts, navigate, search]);

  // …then on its inbox, or on the unfiltered view when it has no inbox folder.
  useEffect(() => {
    if (!accountId || folderId || foldersLoading) return;
    const inbox = folders.find(f => f.role === 'inbox');
    navigate(`/mail/${accountId}/${inbox?.id ?? NO_FOLDER}${search}`, { replace: true });
  }, [accountId, folderId, folders, foldersLoading, navigate, search]);

  // Task 5: "Save to Documents…" on a message's attachments — set by
  // ThreadView's onSaveAttachments, read by SaveAttachmentsModal below.
  const [saveAttachmentsMessage, setSaveAttachmentsMessage] = useState<MessageRow | null>(null);

  // Task 7: the reply/forward composer ThreadView renders inline under the
  // thread. `replyVariant` is separate from `replyComposer` itself so
  // "Open in composer" only swaps which surface the SAME MailComposer
  // instance renders as (Modal vs. the inline block) — switching a prop, not
  // remounting, is what keeps whatever the user has already typed.
  const [replyComposer, setReplyComposer] = useState<ReplyComposerState | null>(null);
  const [replyVariant, setReplyVariant] = useState<'modal' | 'inline'>('inline');

  // Defensive reset: navigating to a different account/thread (back/forward,
  // another thread click) must not leave the modal open against a message
  // from whatever thread was previously showing, nor a reply composer open
  // against a thread that is no longer on screen.
  useEffect(() => {
    setSaveAttachmentsMessage(null);
    setReplyComposer(null);
    setReplyVariant('inline');
  }, [accountId, threadKey]);

  const listPath = accountId ? `/mail/${accountId}/${folderId ?? NO_FOLDER}` : '/mail';

  const openThread = useCallback(
    (row: ThreadListRow) => navigate(`${listPath}/${encodeURIComponent(row.threadKey)}${search}`),
    [navigate, listPath, search],
  );

  const toggleStar = useCallback(
    async (row: ThreadListRow) => {
      if (!accountId) return;
      try {
        await mailApi.threadActions(accountId, [row.threadKey], row.isStarred > 0 ? 'unstar' : 'star');
        reloadList();
      } catch {
        toast('Could not update the star.', { type: 'error' });
      }
    },
    [accountId, reloadList, toast],
  );

  const loadOlder = useCallback(async () => {
    if (!accountId) return;
    toast('Loading older mail…');
    try {
      await mailApi.loadOlder(accountId, 6);
      reloadList();
    } catch {
      toast('Could not load older mail.', { type: 'error' });
    }
  }, [accountId, reloadList, toast]);

  const setQuery = useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams);
      if (next) params.set('q', next);
      else params.delete('q');
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  // A blank composer's openness lives in the URL (not local state) so the
  // command palette — and the two Compose buttons below — can deep-link to
  // it. It's read directly off `searchParams` each render rather than mirrored
  // into state, so there is nothing to keep in sync.
  const composeOpen = searchParams.get('compose') === '1';
  const openCompose = useCallback(() => {
    const params = new URLSearchParams(searchParams);
    params.set('compose', '1');
    setSearchParams(params);
  }, [searchParams, setSearchParams]);
  const closeCompose = useCallback(() => {
    const params = new URLSearchParams(searchParams);
    params.delete('compose');
    setSearchParams(params, { replace: true });
  }, [searchParams, setSearchParams]);

  const backToList = useCallback(() => navigate(`${listPath}${search}`), [navigate, listPath, search]);

  // ThreadView's reply/reply-all/forward — from the toolbar (newest message)
  // or a specific message's own buttons — fetches that message's rendered
  // body, then opens the inline composer under the thread with it quoted.
  // A message whose provider copy is still being filed answers `{pending}`;
  // there is nothing to quote yet, so this stays put rather than opening a
  // composer with an empty quote.
  const onReply = useCallback(
    async (mode: ReplyMode, message: MessageRow) => {
      try {
        const res = await mailApi.body(message.id);
        if ('pending' in res) {
          toast('Message still syncing — try again shortly.');
          return;
        }
        setReplyComposer({ mode, message, bodyHtml: res.html });
        setReplyVariant('inline');
      } catch {
        toast('Could not load this message.', { type: 'error' });
      }
    },
    [toast],
  );
  const closeReplyComposer = useCallback(() => {
    setReplyComposer(null);
    setReplyVariant('inline');
  }, []);
  const promoteReplyComposer = useCallback(() => setReplyVariant('modal'), []);

  if (accountsLoading) {
    return (
      <div className="space-y-2 p-6">
        {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-10" />)}
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-6">
        <EmptyState
          icon={<Mail size={22} />}
          title="Connect a mail account"
          description="Link Google, Microsoft, or any IMAP mailbox to read and send mail from inside Takeoff Pro."
          action={<Button onClick={() => navigate('/settings?tab=mail')}>Open mail settings</Button>}
        />
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] flex-col bg-surface md:h-dvh">
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[13rem_minmax(0,1fr)] lg:grid-cols-[13rem_20rem_minmax(0,1fr)]">
        <aside className="hidden min-h-0 border-r border-edge md:block">
          <FolderRail
            accounts={accounts}
            accountId={accountId}
            folders={folders}
            folderId={folderId}
            onSelectAccount={id => navigate(`/mail/${id}`)}
            onSelectFolder={id => navigate(`/mail/${accountId}/${id}${search}`)}
            onCompose={openCompose}
          />
        </aside>

        {/* List: the only pane on a phone until a thread is opened, and one of
            two on a tablet; at lg it sits permanently beside the reading pane. */}
        <section className={`min-h-0 flex-col border-edge lg:border-r ${threadKey ? 'hidden lg:flex' : 'flex'}`}>
          <div className="flex items-center gap-2 border-b border-edge px-3 py-2 md:hidden">
            <select
              aria-label="Folder"
              value={folderId ?? NO_FOLDER}
              onChange={e => navigate(`/mail/${accountId}/${e.target.value}${search}`)}
              className="min-w-0 flex-1 rounded-lg border border-edge bg-raised px-2 py-1.5 text-sm text-ink focus-visible:outline-none"
            >
              {railFolders.map(({ folder, label }) => (
                <option key={folder.id} value={folder.id}>
                  {label}
                  {folder.unreadCount > 0 ? ` (${folder.unreadCount})` : ''}
                </option>
              ))}
            </select>
            <Button size="sm" onClick={openCompose}>Compose</Button>
          </div>

          <div className="min-h-0 flex-1">
            <ThreadList
              accountId={accountId}
              threads={list.threads}
              loading={list.loading}
              hasMore={list.hasMore}
              onLoadMore={list.loadMore}
              indexedSince={list.indexedSince}
              onLoadOlder={loadOlder}
              q={q}
              onQueryChange={setQuery}
              selectedKey={threadKey}
              ownAddresses={ownAddresses}
              onOpen={openThread}
              onToggleStar={toggleStar}
              onReload={reloadList}
            />
          </div>
        </section>

        <section className={`min-h-0 flex-col ${threadKey ? 'flex' : 'hidden lg:flex'}`}>
          {threadKey ? (
            <>
              <div className="flex items-center gap-2 border-b border-edge px-3 py-2 lg:hidden">
                <Button variant="ghost" size="sm" onClick={backToList}>
                  <ArrowLeft size={14} />
                  <span>Back</span>
                </Button>
              </div>
              <div
                data-testid="mail-thread-slot"
                data-account-id={accountId ?? ''}
                data-thread-key={threadKey}
                className="min-h-0 flex-1"
              >
                {accountId && (
                  <ThreadView
                    key={`${accountId} ${threadKey}`}
                    accountId={accountId}
                    threadKey={threadKey}
                    ownAddresses={ownAddresses}
                    accounts={accounts}
                    onBack={backToList}
                    onReply={onReply}
                    onOpenInComposer={openCompose}
                    onSaveAttachments={message => setSaveAttachmentsMessage(message)}
                    replyComposer={replyComposer}
                    replyVariant={replyVariant}
                    onReplyClose={closeReplyComposer}
                    onReplyPromote={promoteReplyComposer}
                  />
                )}
              </div>
            </>
          ) : (
            <div className="flex h-full items-center justify-center p-8">
              <EmptyState
                icon={<MailOpen size={22} />}
                title="Select a conversation"
                description="Pick a thread from the list to read it here."
              />
            </div>
          )}
        </section>
      </div>

      {saveAttachmentsMessage && (
        <SaveAttachmentsModal
          open
          onClose={() => setSaveAttachmentsMessage(null)}
          messageId={saveAttachmentsMessage.id}
          attachments={saveAttachmentsMessage.attachments}
        />
      )}

      {composeOpen && (
        <MailComposer
          key="new"
          open
          variant="modal"
          onClose={closeCompose}
          accounts={accounts}
          defaultAccountId={accountId ?? undefined}
          mode="new"
          onSent={reloadList}
        />
      )}
    </div>
  );
};
