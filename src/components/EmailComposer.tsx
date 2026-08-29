// src/components/EmailComposer.tsx
// Shared email composer dialog used by every send site (invoice / change order /
// issue / proposal). Presentational + owns its own sending state; the parent
// supplies defaults and an `onSend` that builds/uploads the primary PDF and
// calls the right store helper.
import React, { useEffect, useState } from 'react';
import { Loader2, Paperclip, X } from 'lucide-react';
import { Button, Field, Input, Modal, Textarea } from './ui';
import { useToast } from './Toast';
import { AddFilesButton } from './documents/AddFilesButton';
import { useAttachFiles } from './documents/useAttachFiles';
import { isValidAddressList, parseAddressList } from '../utils/email';
import { DocumentGenerationCancelled } from './documents/errors';

interface Attachment {
  fileId: string;
  name: string;
}

export interface EmailComposerProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  title?: string;
  /** The generated document — shown as a fixed, non-removable chip. */
  primaryAttachmentName: string;
  defaultTo?: string;
  /** Pre-seed the Cc field when the composer opens (e.g. the user's always-CC list). */
  defaultCc?: string;
  /** Pre-seed the Bcc field when the composer opens; also auto-shows the Cc/Bcc row. */
  defaultBcc?: string;
  defaultSubject: string;
  defaultBody: string;
  /** When provided and non-empty, renders a "Document shows email:" select. */
  headerEmailOptions?: { label: string; value: string }[];
  /** Initial selection for the header-email dropdown. */
  defaultHeaderEmail?: string;
  onSend: (msg: {
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    body: string;
    attachmentFileIds: string[];
    /** The email address to stamp on the generated document header (from dropdown). */
    headerEmail?: string;
  }) => Promise<void>;
}

export const EmailComposer: React.FC<EmailComposerProps> = ({
  open,
  onClose,
  projectId,
  title = 'Send email',
  primaryAttachmentName,
  defaultTo,
  defaultCc,
  defaultBcc,
  defaultSubject,
  defaultBody,
  headerEmailOptions,
  defaultHeaderEmail,
  onSend,
}) => {
  const { toast } = useToast();
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [showCcBcc, setShowCcBcc] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [headerEmail, setHeaderEmail] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const [touched, setTouched] = useState(false);

  // Extra attachments come from the shared picker: an email is as likely to
  // need a document already filed in the app as a fresh upload, and a file
  // dragged onto the dialog takes the same path.
  const { dragActive, dropProps, busy: uploading, attachRows } = useAttachFiles({
    upload: { kind: 'email-attachment', projectId },
    accept: 'any',
    link: (fileId, meta) => setAttachments(prev => (
      prev.some(a => a.fileId === fileId) ? prev : [...prev, { fileId, name: meta.name ?? 'attachment' }]
    )),
    onDone: () => { /* the chips are local state — nothing to reload */ },
    noun: 'files',
  });

  // Re-seed every time the dialog opens so each open starts from fresh defaults.
  useEffect(() => {
    if (!open) return;
    setTo(defaultTo ?? '');
    // Seed CC/BCC from defaults; auto-show the Cc/Bcc fields if either is present.
    const seedCc = defaultCc?.trim() ?? '';
    const seedBcc = defaultBcc?.trim() ?? '';
    setCc(seedCc);
    setBcc(seedBcc);
    setShowCcBcc(!!(seedCc || seedBcc));
    setSubject(defaultSubject);
    setBody(defaultBody);
    setHeaderEmail(defaultHeaderEmail ?? '');
    setAttachments([]);
    setSending(false);
    setTouched(false);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const toTrimmed = to.trim();
  const toValid = parseAddressList(toTrimmed).length > 0 && isValidAddressList(toTrimmed);
  const canSend = toValid && !uploading && !sending;

  const removeAttachment = (fileId: string) =>
    setAttachments(prev => prev.filter(a => a.fileId !== fileId));

  const handleSend = async () => {
    setTouched(true);
    if (!toValid) {
      toast('Enter at least one valid email address', { type: 'warning' });
      return;
    }
    if (cc.trim() && !isValidAddressList(cc.trim())) {
      toast('Cc contains an invalid address', { type: 'warning' });
      return;
    }
    if (bcc.trim() && !isValidAddressList(bcc.trim())) {
      toast('Bcc contains an invalid address', { type: 'warning' });
      return;
    }
    setSending(true);
    try {
      await onSend({
        to: toTrimmed,
        cc: cc.trim() || undefined,
        bcc: bcc.trim() || undefined,
        subject,
        body,
        attachmentFileIds: attachments.map(a => a.fileId),
        headerEmail: headerEmail || undefined,
      });
      onClose();
    } catch (e) {
      // Backing out of the "version or overwrite?" prompt that onSend may put
      // up isn't a failure: stay open with the message intact and say nothing.
      if (!(e instanceof DocumentGenerationCancelled)) toast('Failed to send', { type: 'error' });
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={sending}>Cancel</Button>
          <Button onClick={handleSend} disabled={!canSend}>{sending ? 'Sending…' : 'Send'}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field
          label="To"
          htmlFor="ec-to"
          error={touched && !toValid ? 'Enter at least one valid email address' : undefined}
        >
          <Input
            id="ec-to"
            type="email"
            required
            multiple
            value={to}
            onChange={e => setTo(e.target.value)}
            placeholder="name@example.com"
          />
        </Field>

        {!showCcBcc ? (
          <button
            type="button"
            onClick={() => setShowCcBcc(true)}
            className="text-xs font-medium text-accent-600 hover:underline"
          >
            Add Cc/Bcc
          </button>
        ) : (
          <>
            <Field label="Cc" htmlFor="ec-cc" hint="Separate multiple addresses with a comma or semicolon.">
              <Input id="ec-cc" value={cc} onChange={e => setCc(e.target.value)} placeholder="name@example.com" />
            </Field>
            <Field label="Bcc" htmlFor="ec-bcc">
              <Input id="ec-bcc" value={bcc} onChange={e => setBcc(e.target.value)} placeholder="name@example.com" />
            </Field>
          </>
        )}

        {headerEmailOptions && headerEmailOptions.length > 0 && (
          <Field label="Document shows email:" htmlFor="ec-header-email">
            <select
              id="ec-header-email"
              value={headerEmail}
              onChange={e => setHeaderEmail(e.target.value)}
              className="w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-500"
            >
              {headerEmailOptions.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </Field>
        )}

        <Field label="Subject" htmlFor="ec-subject">
          <Input id="ec-subject" value={subject} onChange={e => setSubject(e.target.value)} />
        </Field>

        <Field label="Message" htmlFor="ec-body">
          <Textarea id="ec-body" rows={6} value={body} onChange={e => setBody(e.target.value)} />
        </Field>

        <div
          {...dropProps}
          data-testid="email-attachment-dropzone"
          className={`rounded-lg transition-shadow ${dragActive ? 'ring-2 ring-accent-500' : ''}`}
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="block text-sm font-medium text-ink">Attachments</span>
            <AddFilesButton
              label="Attach files"
              accept="any"
              size="sm"
              // Existing first: most extra attachments are documents the app
              // already holds. No project pre-filter — an email can carry
              // anything.
              defaultTab="existing"
              upload={{ kind: 'email-attachment', projectId }}
              excludeFileIds={attachments.map(a => a.fileId)}
              disabled={uploading}
              onPick={attachRows}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {/* Generated document — always attached, not removable. */}
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-edge bg-hover px-2.5 py-1.5 text-xs text-ink">
              <Paperclip size={12} className="shrink-0 text-ink-faint" />
              <span className="max-w-[16rem] truncate">{primaryAttachmentName}</span>
              <span className="text-ink-faint">(generated)</span>
            </span>
            {attachments.map(a => (
              <span
                key={a.fileId}
                className="group relative inline-flex items-center gap-1.5 rounded-lg border border-edge bg-raised px-2.5 py-1.5 pr-9 text-xs text-ink"
              >
                <Paperclip size={12} className="shrink-0 text-ink-faint" />
                <span className="max-w-[16rem] truncate">{a.name}</span>
                <button
                  type="button"
                  onClick={() => removeAttachment(a.fileId)}
                  aria-label={`Remove ${a.name}`}
                  title="Remove"
                  className="absolute right-0.5 top-1/2 flex min-h-9 min-w-9 -translate-y-1/2 items-center justify-center rounded-md text-ink-faint opacity-100 transition-opacity hover:bg-hover hover:text-ink focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                >
                  <X size={14} />
                </button>
              </span>
            ))}
            {uploading && (
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-edge bg-raised px-2.5 py-1.5 text-xs text-ink-faint">
                <Loader2 size={12} className="animate-spin" />Uploading…
              </span>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
};
