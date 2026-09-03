// src/pages/mail/CreateFromThreadMenu.tsx — ThreadView toolbar's "Create ▾":
// converts the current conversation into a Task, RFI, or Issue. Prefills
// title/question from the thread subject and description/question from the
// latest INBOUND message's body text (falling back to the thread snippet on
// any failure), creates the item through the existing store functions, links
// the thread to it (mailApi.createLink — same route the "+ Link" strip
// uses), then navigates to the new item's editor.
//
// TRUST BOUNDARY: the email-derived text below only ever lands in create
// payload VALUES (createTask/createRfi/createIssue string fields) — it is
// never rendered as HTML anywhere in this component.
import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ListPlus } from 'lucide-react';
import { useToast } from '../../components/Toast';
import { mailApi } from '../../utils/mailApi';
import {
  ProjectSummary, createIssue, createRfi, createTask, getProjectsSummary,
} from '../../utils/store';
import { Button, Field, Select } from '../../components/ui';
import type { MessageRow, ThreadLink } from './types';

/** How much of the inbound message's body text to carry into the prefill. */
const MAX_DESCRIPTION_CHARS = 2000;

type CreateType = 'task' | 'rfi' | 'issue';

const TOOL =
  'inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-ink-soft transition-colors ' +
  'hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-accent-500/40';

const MENU_ITEM =
  'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-ink transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50';

/** Newest-first scan for the latest message NOT from one of the viewer's own
 *  mail accounts — same "own vs. other" address comparison MessageCard/
 *  mailFormat use for participant labels. */
function latestInboundMessage(messages: MessageRow[], ownAddresses: string[]): MessageRow | null {
  const mine = new Set(ownAddresses.map(a => a.trim().toLowerCase()));
  for (let i = messages.length - 1; i >= 0; i--) {
    const from = (messages[i].from?.addr ?? '').trim().toLowerCase();
    if (from && !mine.has(from)) return messages[i];
  }
  return null;
}

/** The prefill description/question text: the latest inbound message's body
 *  text as-is (trimmed to MAX_DESCRIPTION_CHARS), or the thread snippet when
 *  there is no inbound message, the body fetch fails, or it comes back
 *  pending (a just-sent message's provider copy still being filed — that
 *  case doesn't apply to inbound mail in practice, but is handled the same
 *  way regardless). */
async function buildDescription(messages: MessageRow[], ownAddresses: string[], snippet: string): Promise<string> {
  const fallback = (snippet || '').trim();
  const inbound = latestInboundMessage(messages, ownAddresses);
  if (!inbound) return fallback;
  try {
    const body = await mailApi.body(inbound.id);
    if ('pending' in body) return fallback;
    const text = (body.text ?? '').trim();
    return text ? text.slice(0, MAX_DESCRIPTION_CHARS) : fallback;
  } catch {
    return fallback;
  }
}

export const CreateFromThreadMenu: React.FC<{
  threadKey: string;
  subject: string;
  /** ThreadListRow.snippet — the fallback prefill source. */
  snippet: string;
  messages: MessageRow[];
  ownAddresses: string[];
  /** The thread's current links (ThreadView's `links`) — used to find a
   *  project to prefill/require for Task/RFI/Issue without asking again. */
  links: ThreadLink[];
  navigate: (path: string) => void;
}> = ({ threadKey, subject, snippet, messages, ownAddresses, links, navigate }) => {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  // Set once RFI/Issue is chosen and the thread has no project link yet —
  // renders the project-select step in place of the type list.
  const [pendingType, setPendingType] = useState<Extract<CreateType, 'rfi' | 'issue'> | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const reset = () => {
    setOpen(false);
    setPendingType(null);
    setSelectedProjectId('');
  };

  // Outside click / Escape closes the popover, same as ThreadView's own menus.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) reset();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') reset(); };
    document.addEventListener('mousedown', onDocClick);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // The thread's project link, if it has one — any link row carries a
  // denormalized projectId/customerId (server/mail/links.ts resolveChain),
  // regardless of what item it actually points at.
  const projectLink = links.find(l => l.projectId);

  const title = (subject || '').trim() || '(no subject)';

  /** What a create-item step hands back to `runCreate`: enough to link the
   *  thread and navigate, without runCreate needing to know per-type shape. */
  type CreatedItem = { itemType: CreateType; id: string; path: string };

  const createTaskItem = async (projectId: string | null, customerId: string | null): Promise<CreatedItem> => {
    const description = await buildDescription(messages, ownAddresses, snippet);
    const { id } = await createTask({ title, notes: description, projectId, customerId });
    return { itemType: 'task', id, path: `/tasks?open=${id}` };
  };

  const createRfiItem = async (projectId: string): Promise<CreatedItem> => {
    const description = await buildDescription(messages, ownAddresses, snippet);
    const { id } = await createRfi(projectId, { title, question: description });
    return { itemType: 'rfi', id, path: `/project/${projectId}/rfis?open=${id}` };
  };

  const createIssueItem = async (projectId: string): Promise<CreatedItem> => {
    const description = await buildDescription(messages, ownAddresses, snippet);
    const { id } = await createIssue(projectId, { title, description });
    return { itemType: 'issue', id, path: `/project/${projectId}/issues?open=${id}` };
  };

  /** Runs one create step, then links the thread to what it made, and
   *  navigates — the two failure points are handled differently on purpose:
   *  if `create` itself throws, nothing was made, so the item never existed
   *  and the user is told creation failed. If `create` SUCCEEDS but the
   *  follow-up createLink call throws, the item DOES exist — telling the
   *  user "could not create" here would be false and risks them retrying
   *  into a duplicate, so that case still navigates to the real new item and
   *  shows a distinct toast instead. Either way the popover resets, so a
   *  retry (on true creation failure) starts from a clean menu rather than a
   *  stale project-select step. */
  const runCreate = async (create: () => Promise<CreatedItem>, failureLabel: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const created = await create();
      try {
        await mailApi.createLink({ threadKey, itemType: created.itemType, itemId: created.id });
      } catch {
        toast(`Created that ${failureLabel}, but linking this email thread to it failed — link it from the thread later.`, { type: 'warning' });
      }
      navigate(created.path);
    } catch {
      toast(`Could not create that ${failureLabel}.`, { type: 'error' });
    } finally {
      reset();
      setBusy(false);
    }
  };

  const chooseType = (type: CreateType) => {
    if (busy) return;
    if (type === 'task') {
      // A task without a project carries the project link's customer
      // instead — a task WITH a project derives its customer server-side,
      // same convention TasksPage's own create form follows.
      const projectId = projectLink?.projectId ?? null;
      const customerId = projectId ? null : (projectLink?.customerId ?? null);
      void runCreate(() => createTaskItem(projectId, customerId), 'task');
      return;
    }

    // RFI/Issue require a project — the thread's own link if it has one,
    // else a project must be picked before anything is created.
    const linkedProjectId = projectLink?.projectId;
    if (linkedProjectId) {
      void runCreate(
        () => (type === 'rfi' ? createRfiItem(linkedProjectId) : createIssueItem(linkedProjectId)),
        type === 'rfi' ? 'RFI' : 'issue',
      );
      return;
    }

    setPendingType(type);
    if (projects === null) {
      getProjectsSummary().then(ps => setProjects(ps.filter(p => !p.archived))).catch(() => setProjects([]));
    }
  };

  const confirmProjectPick = () => {
    if (!pendingType || !selectedProjectId || busy) return;
    const type = pendingType;
    const projectId = selectedProjectId;
    void runCreate(
      () => (type === 'rfi' ? createRfiItem(projectId) : createIssueItem(projectId)),
      type === 'rfi' ? 'RFI' : 'issue',
    );
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        className={TOOL}
        aria-label="Create"
        aria-expanded={open}
        disabled={busy}
        onClick={() => (open ? reset() : setOpen(true))}
      >
        <ListPlus size={15} />
        <span>Create</span>
        <ChevronDown size={13} />
      </button>

      {open && (
        <div
          data-testid="create-from-thread-menu"
          className="absolute left-0 top-full z-20 mt-1 w-64 rounded-xl border border-edge bg-raised p-1 shadow-lg"
        >
          {pendingType === null ? (
            <>
              <button type="button" role="menuitem" className={MENU_ITEM} disabled={busy} onClick={() => chooseType('task')}>Task</button>
              <button type="button" role="menuitem" className={MENU_ITEM} disabled={busy} onClick={() => chooseType('rfi')}>RFI</button>
              <button type="button" role="menuitem" className={MENU_ITEM} disabled={busy} onClick={() => chooseType('issue')}>Issue</button>
            </>
          ) : (
            <div className="space-y-3 p-2">
              <p className="text-xs text-ink-faint">
                {pendingType === 'rfi' ? 'An RFI needs a project.' : 'An issue needs a project.'}
              </p>
              <Field label="Project" htmlFor="create-from-thread-project">
                <Select
                  id="create-from-thread-project"
                  value={selectedProjectId}
                  onChange={e => setSelectedProjectId(e.target.value)}
                >
                  <option value="">— select a project —</option>
                  {(projects ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
              </Field>
              <div className="flex justify-end gap-2">
                <Button variant="secondary" size="sm" onClick={reset} disabled={busy}>Cancel</Button>
                <Button size="sm" onClick={confirmProjectPick} disabled={!selectedProjectId || busy}>
                  {busy ? 'Creating…' : `Create ${pendingType === 'rfi' ? 'RFI' : 'issue'}`}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
