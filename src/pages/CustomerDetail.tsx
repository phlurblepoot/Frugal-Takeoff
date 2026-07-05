// src/pages/CustomerDetail.tsx
import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { ArrowLeft, Trash2, GitMerge, FolderKanban, Save, Loader2 } from 'lucide-react';
import { Customer } from '../types';
import {
  getCustomer,
  getCustomerProjects,
  saveCustomer,
  deleteCustomer,
  mergeCustomers,
  getCustomers,
} from '../utils/store';
import { useToast } from '../components/Toast';
import { Button, Card, CardHeader, CardBody, Field, Modal, Select } from '../components/ui';
import { CustomerForm, customerToForm, formToCustomer } from './CustomersPage';
import type { CustomerFormState } from './CustomersPage';

// ── Project list ──────────────────────────────────────────────────────────────

interface ProjectSummaryMin {
  id: string;
  name: string;
  status?: string;
}

const ProjectLink: React.FC<{ p: ProjectSummaryMin }> = ({ p }) => (
  <Link
    to={`/project/${p.id}/takeoff`}
    className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-ink hover:bg-hover transition-colors"
  >
    <FolderKanban size={14} className="shrink-0 text-ink-faint" />
    <span className="flex-1 truncate">{p.name}</span>
    {p.status && (
      <span className="rounded-full bg-sunken px-2 py-0.5 text-[11px] text-ink-soft capitalize">
        {p.status.replace(/_/g, ' ')}
      </span>
    )}
  </Link>
);

// ── Merge modal ───────────────────────────────────────────────────────────────

const MergeModal: React.FC<{
  open: boolean;
  currentId: string;
  onClose: () => void;
  onMerged: (targetId: string) => void;
}> = ({ open, currentId, onClose, onMerged }) => {
  const { toast } = useToast();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [targetId, setTargetId] = useState('');
  const [merging, setMerging] = useState(false);

  useEffect(() => {
    if (!open) return;
    getCustomers()
      .then((list: Customer[]) => {
        // Exclude self and the unassigned placeholder as merge targets
        const eligible = (Array.isArray(list) ? list : []).filter(
          c => c.id !== currentId && c.id !== 'customer-unassigned',
        );
        setCustomers(eligible);
        setTargetId(eligible[0]?.id ?? '');
      })
      .catch(() => {});
  }, [open, currentId]);

  const handleMerge = async () => {
    if (!targetId) return;
    setMerging(true);
    try {
      await mergeCustomers(targetId, [currentId]);
      toast('Customers merged.', { type: 'success' });
      onMerged(targetId);
    } catch (err: any) {
      toast(err?.message ?? 'Merge failed.', { type: 'error' });
    } finally {
      setMerging(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Merge into Another Customer"
      width="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={merging}>Cancel</Button>
          <Button onClick={handleMerge} disabled={merging || !targetId}>
            {merging ? 'Merging…' : 'Merge'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-ink-soft">
          All projects assigned to this customer will be reassigned to the target, and this customer record will be deleted.
        </p>
        {customers.length === 0 ? (
          <p className="text-sm text-ink-faint">No other customers available to merge into.</p>
        ) : (
          <Field label="Merge into" htmlFor="merge-target">
            <Select
              id="merge-target"
              value={targetId}
              onChange={e => setTargetId(e.target.value)}
            >
              {customers.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
          </Field>
        )}
      </div>
    </Modal>
  );
};

// ── Delete confirmation modal ─────────────────────────────────────────────────

const DeleteModal: React.FC<{
  open: boolean;
  customerName: string;
  onClose: () => void;
  onConfirm: () => void;
  deleting: boolean;
}> = ({ open, customerName, onClose, onConfirm, deleting }) => (
  <Modal
    open={open}
    onClose={onClose}
    title="Delete Customer"
    width="sm"
    footer={
      <>
        <Button variant="secondary" onClick={onClose} disabled={deleting}>Cancel</Button>
        <Button variant="danger" onClick={onConfirm} disabled={deleting}>
          {deleting ? 'Deleting…' : 'Delete'}
        </Button>
      </>
    }
  >
    <p className="text-sm text-ink-soft">
      Are you sure you want to delete <strong className="text-ink">{customerName}</strong>? This action cannot be undone.
      Projects assigned to this customer will be moved to the unassigned customer.
    </p>
  </Modal>
);

// ── Page ──────────────────────────────────────────────────────────────────────

export const CustomerDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [customer, setCustomer] = useState<Customer | null>(null);
  const [projects, setProjects] = useState<ProjectSummaryMin[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<CustomerFormState | null>(null);
  const [nameError, setNameError] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const [showDelete, setShowDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showMerge, setShowMerge] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const [cust, projs] = await Promise.all([
        getCustomer(id),
        getCustomerProjects(id),
      ]);
      setCustomer(cust);
      setForm(customerToForm(cust));
      setProjects(Array.isArray(projs) ? projs : []);
      setDirty(false);
    } catch {
      toast('Failed to load customer.', { type: 'error' });
    } finally {
      setLoading(false);
    }
  }, [id, toast]);

  useEffect(() => { load(); }, [load]);

  const handleFormChange = (v: CustomerFormState) => {
    setForm(v);
    setDirty(true);
  };

  const handleSave = async () => {
    if (!form || !customer) return;
    if (!form.name.trim()) {
      setNameError('Name is required.');
      return;
    }
    setNameError('');
    setSaving(true);
    try {
      const updated = await saveCustomer({ id: customer.id, ...formToCustomer(form) });
      setCustomer(updated);
      setForm(customerToForm(updated));
      setDirty(false);
      toast('Customer saved.', { type: 'success' });
    } catch (err: any) {
      toast(err?.message ?? 'Failed to save customer.', { type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!id) return;
    setDeleting(true);
    try {
      await deleteCustomer(id);
      toast('Customer deleted.', { type: 'success' });
      navigate('/customers');
    } catch (err: any) {
      toast(err?.message ?? 'Failed to delete customer.', { type: 'error' });
    } finally {
      setDeleting(false);
      setShowDelete(false);
    }
  };

  const handleMerged = (targetId: string) => {
    navigate(`/customers/${targetId}`);
  };

  const isUnassigned = id === 'customer-unassigned';

  if (loading) {
    return (
      <div className="flex min-h-full items-center justify-center bg-surface">
        <Loader2 size={24} className="animate-spin text-ink-faint" />
      </div>
    );
  }

  if (!customer || !form) {
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-4 bg-surface">
        <p className="text-sm text-ink-soft">Customer not found.</p>
        <Button variant="secondary" onClick={() => navigate('/customers')}>
          <ArrowLeft size={14} />
          Back to Customers
        </Button>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-surface">
      {/* Header */}
      <div className="sticky top-0 z-10 border-b border-edge bg-surface px-4 py-4 sm:px-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => navigate('/customers')}
              className="flex items-center justify-center rounded-lg p-1.5 text-ink-faint transition-colors hover:bg-hover hover:text-ink"
              aria-label="Back to Customers"
            >
              <ArrowLeft size={18} />
            </button>
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold text-ink" title={customer.name}>
                {customer.name}
              </h1>
              {customer.contactName && (
                <p className="text-sm text-ink-soft truncate">{customer.contactName}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {!isUnassigned && (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setShowMerge(true)}
                  title="Merge this customer into another"
                >
                  <GitMerge size={14} />
                  <span>Merge</span>
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setShowDelete(true)}
                  className="text-red-600 dark:text-red-400 hover:border-red-300 dark:hover:border-red-700 hover:bg-red-50 dark:hover:bg-red-900/20"
                >
                  <Trash2 size={14} />
                  <span>Delete</span>
                </Button>
              </>
            )}
            <Button size="sm" onClick={handleSave} disabled={saving || !dirty}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              <span>{saving ? 'Saving…' : 'Save'}</span>
            </Button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="px-4 py-6 sm:px-6">
        <div className="mx-auto max-w-3xl space-y-6">
          {/* Edit form */}
          <Card>
            <CardHeader title="Customer Details" />
            <CardBody>
              <CustomerForm value={form} onChange={handleFormChange} nameError={nameError} />
            </CardBody>
          </Card>

          {/* Projects */}
          <Card>
            <CardHeader
              title={`Projects (${projects.length})`}
              actions={
                <span className="text-xs text-ink-faint">{projects.length === 0 ? 'None assigned' : ''}</span>
              }
            />
            {projects.length === 0 ? (
              <CardBody>
                <p className="text-sm text-ink-faint">No projects assigned to this customer.</p>
              </CardBody>
            ) : (
              <CardBody className="px-2 py-2">
                <div className="space-y-0.5">
                  {projects.map(p => (
                    <ProjectLink key={p.id} p={p} />
                  ))}
                </div>
              </CardBody>
            )}
          </Card>
        </div>
      </div>

      {/* Modals */}
      {!isUnassigned && (
        <>
          <DeleteModal
            open={showDelete}
            customerName={customer.name}
            onClose={() => setShowDelete(false)}
            onConfirm={handleDelete}
            deleting={deleting}
          />
          <MergeModal
            open={showMerge}
            currentId={id!}
            onClose={() => setShowMerge(false)}
            onMerged={handleMerged}
          />
        </>
      )}
    </div>
  );
};
