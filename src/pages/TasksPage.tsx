// src/pages/TasksPage.tsx
import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ListChecks, Plus, ImageIcon } from 'lucide-react';
import {
  Task, TaskListItem, AssignableUser,
  getTasks, getTask, createTask, setTaskStatus, getAssignableUsers,
} from '../utils/store';
import { useToast } from '../components/Toast';
import { Button, Card, CardBody, EmptyState, Field, Input, Select, Skeleton } from '../components/ui';
import { TaskStatusPill } from '../components/ui/TaskStatusPill';
import { TaskEditor } from './tasks/TaskEditor';

const UNCATEGORIZED = 'Uncategorized';

type Filter = 'all' | 'mine' | 'todo' | 'in_progress' | 'done' | 'overdue';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'mine', label: 'My tasks' },
  { key: 'todo', label: 'To do' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'done', label: 'Done' },
  { key: 'overdue', label: 'Overdue' },
];

const todayISO = new Date().toISOString().slice(0, 10);
const isOverdue = (t: TaskListItem) => !!t.dueDate && t.dueDate < todayISO && t.status !== 'done';

interface CategoryGroup { key: string; label: string; items: TaskListItem[]; }

export const TasksPage: React.FC = () => {
  const { toast } = useToast();
  const [tasks, setTasks] = useState<TaskListItem[] | null>(null);
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [editing, setEditing] = useState<Task | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [newCategory, setNewCategory] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newAssignee, setNewAssignee] = useState('');
  const [newDue, setNewDue] = useState('');

  const currentUser = useMemo(() => {
    try { return JSON.parse(localStorage.getItem('user') || '{}'); } catch { return {}; }
  }, []);

  const reload = () => { getTasks().then(setTasks).catch(() => setTasks([])); };

  useEffect(() => {
    reload();
    getAssignableUsers().then(setUsers).catch(() => setUsers([]));
  }, []);

  // Focus the create-form input when arriving via the command palette's "New task" action.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get('new') === '1') {
      const el = document.getElementById('new-task-title') as HTMLInputElement | null;
      if (el) { el.focus(); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      setSearchParams(prev => { const p = new URLSearchParams(prev); p.delete('new'); return p; }, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const list = tasks ?? [];

  // Distinct, non-empty category names for the create-form datalist.
  const categoryOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const t of list) { const c = t.category.trim(); if (c) seen.add(c); }
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  }, [list]);

  // Apply the active filter client-side.
  const filtered = useMemo(() => {
    switch (filter) {
      case 'mine': return list.filter(t => t.assigneeUserId === currentUser.id);
      case 'todo': return list.filter(t => t.status === 'todo');
      case 'in_progress': return list.filter(t => t.status === 'in_progress');
      case 'done': return list.filter(t => t.status === 'done');
      case 'overdue': return list.filter(isOverdue);
      default: return list;
    }
  }, [list, filter, currentUser.id]);

  // Group by category, preserving server order within each group; Uncategorized last.
  const groups = useMemo<CategoryGroup[]>(() => {
    const map = new Map<string, CategoryGroup>();
    for (const t of filtered) {
      const trimmed = t.category.trim();
      const key = trimmed || UNCATEGORIZED;
      let g = map.get(key);
      if (!g) { g = { key, label: trimmed || UNCATEGORIZED, items: [] }; map.set(key, g); }
      g.items.push(t);
    }
    const out = Array.from(map.values());
    out.sort((a, b) => {
      if (a.key === UNCATEGORIZED) return 1;
      if (b.key === UNCATEGORIZED) return -1;
      return 0; // otherwise keep first-seen (server) order
    });
    return out;
  }, [filtered]);

  const openTask = async (id: string) => {
    try { setEditing(await getTask(id)); } catch { toast('Failed to open task', { type: 'error' }); }
  };

  const toggleDone = async (t: TaskListItem) => {
    try { await setTaskStatus(t.id, t.status === 'done' ? 'todo' : 'done'); reload(); }
    catch { toast('Failed to update task', { type: 'error' }); }
  };

  const addTask = async () => {
    if (!newTitle.trim()) { toast('Enter a title', { type: 'warning' }); return; }
    try {
      await createTask({
        category: newCategory.trim(),
        title: newTitle.trim(),
        assigneeUserId: newAssignee || null,
        dueDate: newDue || null,
      });
      setNewCategory('');
      setNewTitle('');
      setNewAssignee('');
      setNewDue('');
      reload();
    } catch { toast('Failed to create task', { type: 'error' }); }
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8">
      <div className="mb-4 flex items-center gap-2">
        <ListChecks size={22} className="text-accent-600 dark:text-accent-400" />
        <h1 className="text-xl font-bold text-ink">Tasks</h1>
      </div>

      {/* Filter toolbar */}
      <div className="mb-5 flex flex-wrap gap-1 rounded-xl bg-sunken p-1 w-fit">
        {FILTERS.map(f => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              filter === f.key
                ? 'bg-raised text-ink shadow-sm'
                : 'text-ink-faint hover:text-ink'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Create form */}
      <Card className="mb-5">
        <CardBody>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Category" htmlFor="new-task-category">
              <Input id="new-task-category" list="task-categories" value={newCategory}
                onChange={e => setNewCategory(e.target.value)}
                placeholder="e.g. Office" className="w-40" />
              <datalist id="task-categories">
                {categoryOptions.map(c => <option key={c} value={c} />)}
              </datalist>
            </Field>
            <Field label="Task" htmlFor="new-task-title">
              <Input id="new-task-title" value={newTitle}
                onChange={e => setNewTitle(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addTask(); }}
                placeholder="What needs doing?" className="w-72" />
            </Field>
            <Field label="Assignee" htmlFor="new-task-assignee">
              <Select id="new-task-assignee" value={newAssignee}
                onChange={e => setNewAssignee(e.target.value)} className="w-40">
                <option value="">Unassigned</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.username}</option>)}
              </Select>
            </Field>
            <Field label="Due" htmlFor="new-task-due">
              <Input id="new-task-due" type="date" value={newDue}
                onChange={e => setNewDue(e.target.value)} className="w-40" />
            </Field>
            <Button onClick={addTask} disabled={!newTitle.trim()}><Plus size={15} />Add</Button>
          </div>
        </CardBody>
      </Card>

      {tasks === null ? (
        <div className="space-y-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-10" />)}</div>
      ) : filtered.length === 0 ? (
        <EmptyState icon={<ListChecks size={22} />} title="No tasks"
          description="Create a task above to start tracking work across the company." />
      ) : (
        <div className="space-y-5">
          {groups.map(g => (
            <Card key={g.key}>
              <CardBody>
                <h2 className="mb-2 text-sm font-semibold text-ink">{g.label}</h2>
                <ul className="divide-y divide-edge">
                  {g.items.map(t => {
                    const overdue = isOverdue(t);
                    const isDone = t.status === 'done';
                    return (
                      <li key={t.id} className="flex items-center gap-3 py-2">
                        <input type="checkbox" checked={isDone}
                          onChange={() => toggleDone(t)}
                          className="size-4 shrink-0 rounded border-edge-strong accent-accent-600"
                          aria-label={isDone ? 'Mark not done' : 'Mark done'} />
                        <button type="button" onClick={() => openTask(t.id)}
                          className="flex flex-1 flex-wrap items-center gap-2 text-left">
                          <span className={`flex-1 min-w-0 text-sm ${isDone ? 'text-ink-faint line-through' : 'text-ink'}`}>
                            {t.title || '(untitled)'}
                          </span>
                          <span className={`shrink-0 text-xs ${t.assigneeUsername ? 'text-ink-soft' : 'text-ink-faint'}`}>
                            {t.assigneeUsername || 'Unassigned'}
                          </span>
                          <TaskStatusPill status={t.status} />
                          {t.dueDate && (
                            <span className={`shrink-0 text-xs tabular-nums ${overdue ? 'font-semibold text-red-600 dark:text-red-400' : 'text-ink-faint'}`}>
                              {t.dueDate}
                            </span>
                          )}
                          {t.photoCount > 0 && (
                            <span className="inline-flex shrink-0 items-center gap-1 text-xs text-ink-faint">
                              <ImageIcon size={13} />{t.photoCount}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      {editing && (
        <TaskEditor
          key={`${editing.id}:${editing.version}`}
          task={editing}
          users={users}
          onClose={() => setEditing(null)}
          onSaved={async () => { try { setEditing(await getTask(editing.id)); } catch { setEditing(null); } reload(); }}
        />
      )}
    </div>
  );
};
