// src/pages/project/billing/AiaSettingsForm.tsx
import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { AiaSettings, saveAiaSettings } from '../../../utils/store';
import { useToast } from '../../../components/Toast';
import { Button, Card, CardBody, Field, Input, Textarea } from '../../../components/ui';

const numOrUndefined = (v: string): number | undefined => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
};

export const AiaSettingsForm: React.FC<{
  projectId: string;
  settings: AiaSettings;
  onSaved: (s: AiaSettings) => void;
  defaultOpen?: boolean;
}> = ({ projectId, settings, onSaved, defaultOpen = false }) => {
  const { toast } = useToast();
  const [retainagePercent, setRetainagePercent] = useState(
    settings.retainagePercent != null ? String(settings.retainagePercent) : '10');
  const [storedRetainagePercent, setStoredRetainagePercent] = useState(
    settings.storedRetainagePercent != null ? String(settings.storedRetainagePercent) : '10');
  const [ownerName, setOwnerName] = useState(settings.ownerName ?? '');
  const [ownerAddress, setOwnerAddress] = useState(settings.ownerAddress ?? '');
  const [architectName, setArchitectName] = useState(settings.architectName ?? '');
  const [architectAddress, setArchitectAddress] = useState(settings.architectAddress ?? '');
  const [contractDate, setContractDate] = useState(settings.contractDate ?? '');
  const [ownerProjectNumber, setOwnerProjectNumber] = useState(settings.ownerProjectNumber ?? '');
  const [architectProjectNumber, setArchitectProjectNumber] = useState(settings.architectProjectNumber ?? '');
  const [contractFor, setContractFor] = useState(settings.contractFor ?? '');
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(defaultOpen);

  const handleSave = async () => {
    setSaving(true);
    const next: AiaSettings = {
      ...settings,
      retainagePercent: numOrUndefined(retainagePercent) ?? 10,
      storedRetainagePercent: numOrUndefined(storedRetainagePercent) ?? 10,
      ownerName: ownerName || undefined,
      ownerAddress: ownerAddress || undefined,
      architectName: architectName || undefined,
      architectAddress: architectAddress || undefined,
      contractDate: contractDate || undefined,
      ownerProjectNumber: ownerProjectNumber || undefined,
      architectProjectNumber: architectProjectNumber || undefined,
      contractFor: contractFor || undefined,
    };
    try {
      await saveAiaSettings(projectId, next);
      toast('AIA settings saved', { type: 'success' });
      onSaved(next);
    } catch {
      toast('Failed to save AIA settings', { type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="mb-5">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-controls="aia-settings-body"
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
      >
        <div className="flex items-center gap-2">
          {open ? (
            <ChevronDown className="h-4 w-4 text-ink-soft" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-4 w-4 text-ink-soft" aria-hidden="true" />
          )}
          <div>
            <h3 className="text-sm font-semibold text-ink">AIA settings</h3>
            <p className="text-xs text-ink-soft">Owner, architect &amp; retainage — set once</p>
          </div>
        </div>
      </button>
      {open && (
      <CardBody id="aia-settings-body" className="border-t border-edge">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Retainage % (work)" htmlFor="aia-ret">
            <Input id="aia-ret" type="number" value={retainagePercent} onChange={e => setRetainagePercent(e.target.value)} placeholder="10" />
          </Field>
          <Field label="Retainage % (stored materials)" htmlFor="aia-ret-stored">
            <Input id="aia-ret-stored" type="number" value={storedRetainagePercent} onChange={e => setStoredRetainagePercent(e.target.value)} placeholder="10" />
          </Field>
          <Field label="Owner name" htmlFor="aia-owner">
            <Input id="aia-owner" value={ownerName} onChange={e => setOwnerName(e.target.value)} />
          </Field>
          <Field label="Owner address" htmlFor="aia-owner-addr">
            <Input id="aia-owner-addr" value={ownerAddress} onChange={e => setOwnerAddress(e.target.value)} />
          </Field>
          <Field label="Architect name" htmlFor="aia-arch">
            <Input id="aia-arch" value={architectName} onChange={e => setArchitectName(e.target.value)} />
          </Field>
          <Field label="Architect address" htmlFor="aia-arch-addr">
            <Input id="aia-arch-addr" value={architectAddress} onChange={e => setArchitectAddress(e.target.value)} />
          </Field>
          <Field label="Contract date" htmlFor="aia-contract-date">
            <Input id="aia-contract-date" type="date" value={contractDate} onChange={e => setContractDate(e.target.value)} />
          </Field>
          <Field label="Owner project number" htmlFor="aia-owner-pn">
            <Input id="aia-owner-pn" value={ownerProjectNumber} onChange={e => setOwnerProjectNumber(e.target.value)} />
          </Field>
          <Field label="Architect project number" htmlFor="aia-arch-pn">
            <Input id="aia-arch-pn" value={architectProjectNumber} onChange={e => setArchitectProjectNumber(e.target.value)} />
          </Field>
        </div>
        <div className="mt-3">
          <Field label="Contract for" htmlFor="aia-contract-for">
            <Textarea id="aia-contract-for" rows={2} value={contractFor} onChange={e => setContractFor(e.target.value)}
              placeholder="Description of the work covered by this contract" />
          </Field>
        </div>
        <div className="mt-4 flex justify-end">
          <Button size="sm" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</Button>
        </div>
      </CardBody>
      )}
    </Card>
  );
};
