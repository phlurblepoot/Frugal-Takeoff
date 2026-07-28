// src/pages/CustomersPage.tsx
import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, Users, Phone, User } from 'lucide-react';
import { Customer, CustomerRoleEmails } from '../types';
import {
  getCustomers,
  saveCustomer,
} from '../utils/store';
import { useToast } from '../components/Toast';
import {
  Button, Card, EmptyState, Field, Input, Modal, Textarea,
} from '../components/ui';
import { RoleEmailsEditor } from '../components/RoleEmailsEditor';

// ── Customer form (shared between create modal and detail page) ───────────────

export interface CustomerFormState {
  name: string;
  phone: string;
  address: string;
  contactName: string;
  notes: string;
  emails: CustomerRoleEmails;
}

const EMPTY_FORM: CustomerFormState = {
  name: '',
  phone: '',
  address: '',
  contactName: '',
  notes: '',
  emails: {},
};

export const CustomerForm: React.FC<{
  value: CustomerFormState;
  onChange: (v: CustomerFormState) => void;
  nameError?: string;
}> = ({ value, onChange, nameError }) => {
  const set = (key: keyof Omit<CustomerFormState, 'emails'>) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      onChange({ ...value, [key]: e.target.value });

  return (
    <div className="space-y-4">
      <Field label="Company / Customer Name" htmlFor="cust-name" error={nameError}>
        <Input
          id="cust-name"
          value={value.name}
          onChange={set('name')}
          placeholder="e.g. Acme Construction"
          autoFocus
        />
      </Field>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Contact Name" htmlFor="cust-contact">
          <Input id="cust-contact" value={value.contactName} onChange={set('contactName')} placeholder="Primary contact" />
        </Field>
        <Field label="Phone" htmlFor="cust-phone">
          <Input id="cust-phone" value={value.phone} onChange={set('phone')} placeholder="(555) 000-0000" type="tel" />
        </Field>
      </div>
      <Field label="Address" htmlFor="cust-address">
        <Input id="cust-address" value={value.address} onChange={set('address')} placeholder="Street, City, State ZIP" />
      </Field>
      <p className="text-xs font-semibold uppercase tracking-wider text-ink-faint pt-1">Role Emails</p>
      <RoleEmailsEditor
        value={value.emails}
        onChange={next => onChange({ ...value, emails: next })}
      />
      <Field label="Notes" htmlFor="cust-notes">
        <Textarea id="cust-notes" value={value.notes} onChange={set('notes')} placeholder="Internal notes about this customer…" rows={3} />
      </Field>
    </div>
  );
};

export function formToCustomer(f: CustomerFormState): Omit<Customer, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name: f.name.trim(),
    phone: f.phone.trim() || undefined,
    address: f.address.trim() || undefined,
    contactName: f.contactName.trim() || undefined,
    notes: f.notes.trim() || undefined,
    emails: f.emails,
  };
}

export function customerToForm(c: Customer): CustomerFormState {
  return {
    name: c.name,
    phone: c.phone ?? '',
    address: c.address ?? '',
    contactName: c.contactName ?? '',
    notes: c.notes ?? '',
    emails: c.emails ?? {},
  };
}

// ── Create modal ──────────────────────────────────────────────────────────────

const CreateCustomerModal: React.FC<{
  open: boolean;
  onClose: () => void;
  onCreated: (c: Customer) => void;
}> = ({ open, onClose, onCreated }) => {
  const [form, setForm] = useState<CustomerFormState>(EMPTY_FORM);
  const [nameError, setNameError] = useState('');
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const handleClose = useCallback(() => {
    setForm(EMPTY_FORM);
    setNameError('');
    onClose();
  }, [onClose]);

  const handleSave = async () => {
    if (!form.name.trim()) {
      setNameError('Name is required.');
      return;
    }
    setNameError('');
    setSaving(true);
    try {
      const created = await saveCustomer(formToCustomer(form));
      toast('Customer created.', { type: 'success' });
      setForm(EMPTY_FORM);
      onCreated(created);
    } catch (err: any) {
      toast(err?.message ?? 'Failed to create customer.', { type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="New Customer"
      width="lg"
      footer={
        <>
          <Button variant="secondary" onClick={handleClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Create Customer'}</Button>
        </>
      }
    >
      <CustomerForm value={form} onChange={setForm} nameError={nameError} />
    </Modal>
  );
};

// ── Customer row ──────────────────────────────────────────────────────────────

const CustomerRow: React.FC<{ customer: Customer; onClick: () => void }> = ({ customer, onClick }) => (
  <Card
    className="cursor-pointer p-4 transition-colors hover:border-edge-strong"
    onClick={onClick}
  >
    <div className="flex items-start justify-between gap-2">
      <h3 className="flex-1 truncate text-sm font-semibold text-ink" title={customer.name}>
        {customer.name}
      </h3>
    </div>
    <div className="mt-2 space-y-1 text-xs text-ink-soft">
      {customer.contactName && (
        <p className="flex items-center gap-1.5 truncate">
          <User size={12} className="shrink-0 text-ink-faint" />
          {customer.contactName}
        </p>
      )}
      {customer.phone && (
        <p className="flex items-center gap-1.5 truncate">
          <Phone size={12} className="shrink-0 text-ink-faint" />
          {customer.phone}
        </p>
      )}
    </div>
  </Card>
);

// ── Page ──────────────────────────────────────────────────────────────────────

export const CustomersPage: React.FC = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    setLoading(true);
    getCustomers()
      .then((data: Customer[]) => setCustomers(Array.isArray(data) ? data : []))
      .catch(() => toast('Failed to load customers.', { type: 'error' }))
      .finally(() => setLoading(false));
  }, [toast]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return customers;
    return customers.filter(
      c =>
        c.name.toLowerCase().includes(q) ||
        (c.contactName ?? '').toLowerCase().includes(q),
    );
  }, [customers, query]);

  const handleCreated = (c: Customer) => {
    setCustomers(prev => [c, ...prev]);
    setShowCreate(false);
    navigate(`/customers/${c.id}`);
  };

  return (
    <div className="min-h-full bg-surface">
      {/* Header */}
      <div className="sticky top-0 z-10 border-b border-edge bg-surface px-4 py-4 sm:px-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-lg font-semibold text-ink">Customers</h1>
            <p className="text-sm text-ink-soft">{customers.length} customer{customers.length !== 1 ? 's' : ''}</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative flex-1 sm:w-56 sm:flex-none">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
              <input
                type="search"
                placeholder="Search customers…"
                value={query}
                onChange={e => setQuery(e.target.value)}
                className="w-full rounded-lg border border-edge bg-raised py-2 pl-8 pr-3 text-sm text-ink placeholder:text-ink-faint focus:border-accent-400 focus:ring-2 focus:ring-accent-500/25 focus-visible:outline-none"
              />
            </div>
            <Button onClick={() => setShowCreate(true)}>
              <Plus size={16} />
              <span>New Customer</span>
            </Button>
          </div>
        </div>
      </div>

      {/* List */}
      <div className="px-4 py-6 sm:px-6">
        {loading ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-24 animate-pulse rounded-xl bg-raised" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<Users size={22} />}
            title={query ? 'No customers match your search' : 'No customers yet'}
            description={query ? 'Try a different name or contact.' : 'Add your first customer to get started.'}
            action={
              !query ? (
                <Button onClick={() => setShowCreate(true)}>
                  <Plus size={16} />
                  <span>New Customer</span>
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map(c => (
              <CustomerRow
                key={c.id}
                customer={c}
                onClick={() => navigate(`/customers/${c.id}`)}
              />
            ))}
          </div>
        )}
      </div>

      <CreateCustomerModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={handleCreated}
      />
    </div>
  );
};
