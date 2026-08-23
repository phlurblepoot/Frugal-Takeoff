// src/pages/project/ProjectSettings.tsx
//
// Admin-only Project Settings section (Phase 5c). Surfaces the project metadata
// editors that previously lived inline in ProjectView (name, contractor,
// address, due date, stage) plus a Danger Zone for archive/delete. Metadata
// edits reuse the optimistic saveProject + rollback pattern ported from
// ProjectView; stage reuses ProjectStageControl; archive matches ProjectsPage's
// patchProject({ archived }) toggle; delete matches deleteProject + confirm.
import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Settings as SettingsIcon, ShieldAlert, ThumbsDown, Trash2, Archive, ArchiveRestore } from 'lucide-react';
import { Project, Customer, CustomerRoleEmails } from '../../types';
import { getProject, saveProject, deleteProject, patchProject, ConflictError, getCustomers } from '../../utils/store';
import { AddressAutocomplete } from '../../components/AddressAutocomplete';
import { ProjectStageControl } from '../../components/ProjectStageControl';
import { RoleEmailsEditor } from '../../components/RoleEmailsEditor';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';
import {
  Button, Card, CardBody, CardHeader, EmptyState, Field, Input, Select, Skeleton,
  normalizeProjectStatus,
} from '../../components/ui';
import { useCollabEditing } from '../../hooks/useCollabEditing';
import { EditPresenceBanner } from '../../components/EditPresenceBanner';

const isAdmin = () => (JSON.parse(localStorage.getItem('user') || '{}').role) === 'admin';

export const ProjectSettings: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const confirm = useConfirm();
  const admin = isAdmin();

  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Local editor mirrors — kept in sync with the loaded project so inputs stay
  // controlled while the optimistic saves happen against the live `project`.
  const [name, setName] = useState('');
  const [contractor, setContractor] = useState('');
  const [address, setAddress] = useState('');
  const [dueDate, setDueDate] = useState('');

  // Customer picker
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | undefined>(undefined);

  // Project-specific contact email overrides
  const [contactEmails, setContactEmails] = useState<CustomerRoleEmails>({});

  useEffect(() => {
    getCustomers()
      .then(setCustomers)
      .catch(err => console.error('Failed to load customers:', err));
  }, []);

  const reload = () => {
    if (!projectId || !admin) return;
    setLoading(true);
    getProject(projectId)
      .then(p => {
        setProject(p);
        if (p) {
          setName(p.name ?? '');
          setContractor(p.contractor ?? '');
          setAddress(p.address ?? '');
          setDueDate(p.bidDueDate ? new Date(p.bidDueDate).toISOString().split('T')[0] : '');
          setSelectedCustomerId(p.customerId ?? undefined);
          setContactEmails(p.contactEmails ?? {});
        }
      })
      .catch(() => setProject(null))
      .finally(() => setLoading(false));
  };
  useEffect(reload, [projectId, admin]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fields here auto-save individually on blur/change (no single "Save"
  // button), so dirty is a snapshot-compare against the loaded project —
  // true only in the brief window between typing and the field's own save.
  const dirty =
    !!project && (
      name !== (project.name ?? '') ||
      contractor !== (project.contractor ?? '') ||
      address !== (project.address ?? '') ||
      dueDate !== (project.bidDueDate ? new Date(project.bidDueDate).toISOString().split('T')[0] : '') ||
      selectedCustomerId !== (project.customerId ?? undefined) ||
      JSON.stringify(contactEmails) !== JSON.stringify(project.contactEmails ?? {})
    );

  const collab = useCollabEditing({
    type: 'project',
    id: projectId ?? '',
    isDirty: () => dirty,
    onFresh: reload,
  });

  // Admins only: never load or expose project data otherwise.
  if (!admin) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-12 md:px-8">
        <EmptyState icon={<ShieldAlert size={22} />} title="Project settings are admin-only"
          description="Ask an administrator for access to project settings." />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6 md:px-8 space-y-4">
        <Skeleton className="h-8 w-48" />
        {[0, 1].map(i => <Skeleton key={i} className="h-40" />)}
      </div>
    );
  }

  if (!project) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6 md:px-8">
        <EmptyState icon={<SettingsIcon size={22} />} title="Project not found"
          description="This project could not be loaded." />
      </div>
    );
  }

  // Optimistic metadata save: apply locally, persist, roll back + toast on error.
  // Ported from ProjectView's handleSave* handlers (version respected by
  // saveProject's queue + latestVersions reconciliation).
  const saveField = async (patch: Partial<Project>, label: string) => {
    if (!project) return;
    const previous = project;
    const updated = {
      ...project,
      ...(collab.keepMineVersion !== null ? { version: collab.keepMineVersion } : {}),
      ...patch,
    };
    setProject(updated);
    setBusy(true);
    try {
      await saveProject(updated);
    } catch (error) {
      setProject(previous);
      // Re-sync the local editor mirror with the rolled-back value.
      setName(previous.name ?? '');
      setContractor(previous.contractor ?? '');
      setAddress(previous.address ?? '');
      setDueDate(previous.bidDueDate ? new Date(previous.bidDueDate).toISOString().split('T')[0] : '');
      setSelectedCustomerId(previous.customerId ?? undefined);
      setContactEmails(previous.contactEmails ?? {});
      const msg = error instanceof ConflictError
        ? `Project changed elsewhere — couldn't save ${label}`
        : `Failed to save ${label}. Please try again.`;
      toast(msg, { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const saveName = () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === project.name) return;
    saveField({ name: trimmed }, 'project name');
  };
  const saveContractor = () => {
    const next = contractor.trim() || undefined;
    if (next === (project.contractor ?? undefined)) return;
    saveField({ contractor: next }, 'contractor');
  };
  const saveAddress = (value: string) => {
    setAddress(value);
    const next = value.trim() || undefined;
    if (next === (project.address ?? undefined)) return;
    saveField({ address: next }, 'address');
  };
  const saveDueDate = (value: string) => {
    setDueDate(value);
    // Match ProjectView.handleSaveDueDate: 'YYYY-MM-DD' ↔ ms epoch.
    saveField({ bidDueDate: value ? new Date(value).getTime() : undefined }, 'due date');
  };
  const saveCustomerLink = (custId: string) => {
    setSelectedCustomerId(custId || undefined);
    const found = customers.find(c => c.id === custId);
    // Keep contractor in sync with the linked customer name.
    const nextContractor = found ? found.name : contractor;
    setContractor(nextContractor);
    saveField({ customerId: custId || undefined, contractor: nextContractor || undefined }, 'customer');
  };
  const saveContactEmails = (next: CustomerRoleEmails) => {
    setContactEmails(next);
    saveField({ contactEmails: next }, 'contact emails');
  };

  const isArchived = !!project.archived;
  // Only an open bid can be lost — an in-progress job that ends badly is an
  // archive, not a lost bid.
  const isBidding = !isArchived && normalizeProjectStatus(project.status ?? '') === 'bidding';

  // Archive toggle matches ProjectsPage.applyPatch: patchProject({ archived }).
  const toggleArchive = async () => {
    if (!project) return;
    setBusy(true);
    try {
      // Restoring clears the lost-bid marker with it — see ProjectsPage.
      await patchProject(project.id, isArchived
        ? { version: project.version ?? 1, archived: false, lostBid: false }
        : { version: project.version ?? 1, archived: true });
      toast(isArchived ? 'Project restored' : 'Project archived', { type: 'success' });
      reload();
    } catch (e) {
      toast(e instanceof ConflictError ? 'Project changed elsewhere — refresh and retry' : 'Failed to update archive state', { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  // A lost bid is an archive with a reason: the project leaves the board but
  // keeps a Lost badge in the Archive tab instead of looking merely tidied away.
  const markLostBid = async () => {
    if (!project) return;
    if (!await confirm({
      title: 'Mark as lost bid',
      message: 'Archive this project and record the bid as lost? You can restore it later.',
      confirmLabel: 'Mark as lost',
    })) return;
    setBusy(true);
    try {
      await patchProject(project.id, { version: project.version ?? 1, archived: true, lostBid: true });
      toast('Marked as lost bid', { type: 'success' });
      reload();
    } catch (e) {
      toast(e instanceof ConflictError ? 'Project changed elsewhere — refresh and retry' : 'Failed to mark as lost', { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  // Delete matches ProjectsPage's deleteProject flow (confirm → delete → leave).
  const handleDelete = async () => {
    if (!project) return;
    if (!await confirm({
      title: 'Delete project',
      message: 'Delete this project and all its data? This cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'danger',
    })) return;
    setBusy(true);
    try {
      await deleteProject(project.id);
      toast('Project deleted', { type: 'success' });
      navigate('/projects');
    } catch {
      toast('Failed to delete project', { type: 'error' });
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 md:px-8 space-y-6">
      <h1 className="text-xl font-bold text-ink">Project Settings</h1>
      <EditPresenceBanner state={collab} />

      {/* Metadata */}
      <Card>
        <CardHeader title="Details" />
        <CardBody>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Project name" htmlFor="ps-name">
              <Input id="ps-name" value={name} disabled={busy}
                onChange={e => setName(e.target.value)}
                onBlur={saveName}
                onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
            </Field>
            <Field label="Customer" htmlFor="ps-customer">
              <Select id="ps-customer" value={selectedCustomerId ?? ''} disabled={busy}
                onChange={e => saveCustomerLink(e.target.value)}>
                <option value="">— None —</option>
                {customers.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </Select>
            </Field>
            <Field label="Address" htmlFor="ps-address">
              <AddressAutocomplete value={address} onChange={saveAddress} disabled={busy} />
            </Field>
            <Field label="Bid due date" htmlFor="ps-due">
              <Input id="ps-due" type="date" value={dueDate} disabled={busy}
                onChange={e => saveDueDate(e.target.value)} />
            </Field>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <span className="text-sm text-ink-soft">Stage</span>
            <ProjectStageControl
              projectId={project.id}
              version={project.version}
              status={project.status}
              onChanged={reload}
            />
          </div>

          {/* DEFERRED: contract value is a billing rollup, managed in Billing */}
        </CardBody>
      </Card>

      {/* Project-specific contact overrides */}
      <Card>
        <CardHeader title="Project contacts (override customer)" />
        <CardBody>
          <p className="text-xs text-ink-faint mb-4">
            These email addresses are used for this project only and override any emails set on the linked customer.
          </p>
          <RoleEmailsEditor
            value={contactEmails}
            onChange={next => { setContactEmails(next); saveContactEmails(next); }}
            disabled={busy}
          />
        </CardBody>
      </Card>

      {/* Danger Zone */}
      <Card className="border-rose-300 dark:border-rose-900/50">
        <CardHeader title="Danger zone" />
        <CardBody className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-ink">{isArchived ? 'Restore project' : 'Archive project'}</p>
              <p className="text-xs text-ink-faint">
                {isArchived
                  ? 'Move this project back into the active pipeline.'
                  : 'Hide this project from the active pipeline. It can be restored anytime.'}
              </p>
            </div>
            <Button variant="secondary" onClick={toggleArchive} disabled={busy}>
              {isArchived ? <><ArchiveRestore size={14} />Restore</> : <><Archive size={14} />Archive</>}
            </Button>
          </div>

          {isBidding && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-edge pt-4">
              <div>
                <p className="text-sm font-medium text-ink">Mark as lost bid</p>
                <p className="text-xs text-ink-faint">
                  Archive this project and flag the bid as lost. It keeps a "Lost" badge in the Archive tab.
                </p>
              </div>
              <Button variant="secondary" onClick={markLostBid} disabled={busy}>
                <ThumbsDown size={14} />Mark as lost
              </Button>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-edge pt-4">
            <div>
              <p className="text-sm font-medium text-ink">Delete project</p>
              <p className="text-xs text-ink-faint">Permanently remove this project and all of its data.</p>
            </div>
            <Button variant="danger" onClick={handleDelete} disabled={busy}>
              <Trash2 size={14} />Delete
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
};
