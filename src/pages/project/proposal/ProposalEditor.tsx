// src/pages/project/proposal/ProposalEditor.tsx — /project/:projectId/proposal/:proposalId
// The full-page proposal editor. It owns the whole editable draft (via
// useProposalDraft); every card below it is controlled. Only a DRAFT (and
// non-legacy) proposal is editable — once sent, a proposal is a historical
// record and must be revised instead.
import React, { useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, FileText, Save, Send } from 'lucide-react';
import {
  ProposalLockedError, persistGeneratedDocument, sendProposal, setProposalFile,
  type Proposal,
} from '../../../utils/store';
import { useToast } from '../../../components/Toast';
import { EditPresenceBanner } from '../../../components/EditPresenceBanner';
import { EmailComposer } from '../../../components/EmailComposer';
import { Button, Card, CardBody, CardHeader, Skeleton, StatusPill, Textarea } from '../../../components/ui';
import { formatCurrency, proposalFileName } from './proposalGenerator';
import { STATUS_TONE, proposalLabel } from './proposalPresentation';
import { buildProposalPdf } from './buildProposalPdf';
import { isAdmin, useProposalDraft } from './useProposalDraft';
import { useProposalEmailDefaults } from './useProposalEmailDefaults';
import { HistoryMenu } from './HistoryMenu';
import { PricingLinesCard } from './PricingLinesCard';
import { InclusionsExclusionsCard } from './InclusionsExclusionsCard';
import { PaymentScheduleCard } from './PaymentScheduleCard';
import { ProposalOptionsCard } from './ProposalOptionsCard';
import { ProposalPhotosCard } from './ProposalPhotosCard';
import { ProposalAttachmentsCard } from './ProposalAttachmentsCard';

export const ProposalEditor: React.FC = () => {
  const { projectId, proposalId } = useParams<{ projectId: string; proposalId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const admin = isAdmin();

  const {
    project, proposal, draft, missingTakeoffIds, dirty, saving, loadFailed, readOnly,
    takeoffTotals, totals, notesHistory, termsHistory, inclusionsHistory, exclusionsHistory,
    lineLibrary, collab, patchDraft, applyOptions, save, reload,
  } = useProposalDraft(projectId, proposalId);

  // Highlighted plan pages are a generate-time choice, not a stored proposal
  // column — the same option the old page carried.
  const [includeHighlights, setIncludeHighlights] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [composing, setComposing] = useState(false);
  const emailDefaults = useProposalEmailDefaults(projectId);

  // The PDF renders the draft as it stands on screen — Generate saves first, so
  // what the client receives is exactly what was just stored.
  const renderPdf = (headerEmail?: string) => buildProposalPdf({
    proposal: { ...(proposal as Proposal), ...draft },
    project: project!,
    takeoffTotals,
    includeHighlights,
    headerEmail,
    onProgress: setProgress,
    onSkippedAttachment: name => toast(`Skipped unreadable attachment ${name}`, { type: 'warning' }),
  });

  /** Renders, stores as the proposal's document, and returns the new file id. */
  const renderAndStore = async (headerEmail?: string): Promise<string> => {
    const { pdfBytes, suggestedName, overBudget } = await renderPdf(headerEmail);
    const { fileId } = await persistGeneratedDocument(
      new Blob([pdfBytes], { type: 'application/pdf' }),
      { projectId: proposal!.projectId, kind: 'proposal', name: suggestedName, sourceType: 'proposal', sourceId: proposal!.id },
    );
    await setProposalFile(proposal!.id, fileId);
    if (overBudget) {
      toast(`Proposal is ${(pdfBytes.byteLength / 1048576).toFixed(1)}MB — above the 18MB email target`, { type: 'warning' });
    }
    return fileId;
  };

  const handleGenerate = async () => {
    if (!draft || !proposal || !project) return;
    if (draft.lines.length === 0) { toast('Add at least one price line', { type: 'warning' }); return; }
    if (dirty && saving) { toast('Save in progress — try again in a moment', { type: 'warning' }); return; }
    setBusy(true);
    try {
      // Generate always saves first; a save that bounced (lock/conflict) has
      // already reloaded someone else's version, so there is nothing to render.
      if (dirty && !(await save())) return;
      await renderAndStore();
      toast('Proposal PDF generated', { type: 'success' });
      reload();
    } catch (e) {
      console.error(e);
      toast('Failed to generate proposal PDF', { type: 'error' });
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  const handleSend = async (m: {
    to: string; cc?: string; bcc?: string; subject: string; body: string;
    attachmentFileIds: string[]; headerEmail?: string;
  }) => {
    if (!proposal || !project) return;
    // ALWAYS render at send time. A stored fileId goes stale the moment anything
    // is saved or a photo/attachment changes, and emailing last week's price is
    // the one failure this section cannot have. Generate is the preview path;
    // this is the one that goes to the client, stamped with their chosen
    // from-address. A render that fails aborts the send rather than falling
    // back to the old document.
    let fileId: string;
    try {
      fileId = await renderAndStore(m.headerEmail);
    } catch (e) {
      console.error(e);
      // The composer reports the failed send itself; this says which step broke.
      toast('Could not generate the proposal PDF — nothing was sent', { type: 'error' });
      throw e;
    } finally {
      setProgress('');
    }
    try {
      await sendProposal(proposal.id, {
        to: m.to, cc: m.cc, bcc: m.bcc, subject: m.subject, body: m.body,
        fileId, attachmentFileIds: m.attachmentFileIds,
      });
      toast('Proposal sent', { type: 'success' });
    } catch (e) {
      if (!(e instanceof ProposalLockedError)) throw e;
      toast('This proposal was already sent — revise it to send again', { type: 'error' });
    }
    reload();
  };

  // Every hook above runs unconditionally; the gate is the last thing before
  // render so a non-admin who guesses the URL lands back on the project.
  if (!admin) return <Navigate to={`/project/${projectId}`} replace />;

  const statusText = readOnly
    ? (proposal?.legacy ? 'Imported — revise to change' : 'Locked — revise to change')
    : dirty ? 'Unsaved changes' : 'Saved';
  // No project means no takeoffs to price and nothing to address the email to —
  // the render would be wrong rather than merely incomplete, so both actions
  // are blocked with a reason rather than silently doing nothing.
  const noProject = !project ? "Couldn't load the project — reload the page" : undefined;
  const generateBlockedReason = noProject;
  // Send renders its own PDF, so it needs no prior Generate — only a draft that
  // is actually on the server.
  const sendBlockedReason = noProject ?? (dirty ? 'Save first' : undefined);

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" aria-label="Back to proposals" onClick={() => navigate(`/project/${projectId}/proposal`)}>
            <ArrowLeft size={16} />Proposals
          </Button>
          {proposal && (
            <>
              <h1 className="text-xl font-bold text-ink">{proposalLabel(proposal)}</h1>
              <StatusPill tone={STATUS_TONE[proposal.status]}>{proposal.status}</StatusPill>
              <span className="text-sm text-ink-faint" data-testid="proposal-state">{statusText}</span>
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {progress && <span className="text-sm text-ink-faint" data-testid="proposal-progress">{progress}</span>}
          {totals && <span className="mr-1 text-sm font-semibold text-ink">{formatCurrency(totals.totalCents / 100)}</span>}
          {!readOnly && (
            <>
              <Button onClick={save} disabled={saving || !dirty} data-testid="btn-save-proposal">
                <Save size={16} />{saving ? 'Saving…' : 'Save'}
              </Button>
              <Button
                variant="secondary"
                onClick={handleGenerate}
                disabled={busy || !draft || !!generateBlockedReason}
                title={generateBlockedReason}
                data-testid="btn-generate-proposal"
              >
                <FileText size={16} />{busy ? 'Generating…' : 'Generate PDF'}
              </Button>
            </>
          )}
          {proposal?.fileId && (
            <Button variant="secondary" onClick={() => navigate(`/tools/pdf?fileId=${proposal.fileId}`)}>
              <FileText size={16} />Open PDF
            </Button>
          )}
          {!readOnly && (
            <Button
              onClick={() => setComposing(true)}
              disabled={busy || !!sendBlockedReason}
              title={sendBlockedReason}
              data-testid="btn-send-proposal"
            >
              <Send size={16} />Send
            </Button>
          )}
        </div>
      </div>

      <EditPresenceBanner state={collab} />

      {loadFailed ? (
        <Card><CardBody><p className="text-sm text-ink-faint">This proposal could not be loaded.</p></CardBody></Card>
      ) : !draft || !proposal ? (
        <div className="space-y-3">{[0, 1, 2].map(i => <Skeleton key={i} className="h-32" />)}</div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="lg:col-span-2">
            <PricingLinesCard
              lines={draft.lines}
              onChange={lines => patchDraft({ lines })}
              readOnly={readOnly}
              takeoffTotals={takeoffTotals}
              missingTakeoffIds={missingTakeoffIds}
              showGrandTotal={draft.showGrandTotal}
              onShowGrandTotalChange={showGrandTotal => patchDraft({ showGrandTotal })}
              lineLibrary={lineLibrary}
            />
          </div>

          <div className="lg:col-span-2">
            <InclusionsExclusionsCard
              inclusions={draft.inclusions}
              exclusions={draft.exclusions}
              inclusionsHistory={inclusionsHistory}
              exclusionsHistory={exclusionsHistory}
              readOnly={readOnly}
              onChange={(inclusions, exclusions) => patchDraft({ inclusions, exclusions })}
            />
          </div>

          <Card data-testid="proposal-notes">
            <CardHeader
              title="Cover notes"
              actions={!readOnly && <HistoryMenu history={notesHistory} testId="notes-history" onSelect={coverNotes => patchDraft({ coverNotes })} />}
            />
            <CardBody>
              <Textarea
                aria-label="Cover notes"
                rows={8}
                value={draft.coverNotes}
                placeholder="The paragraph above the price."
                disabled={readOnly}
                onChange={e => patchDraft({ coverNotes: e.target.value })}
              />
            </CardBody>
          </Card>

          <Card data-testid="proposal-terms">
            <CardHeader
              title="Terms"
              actions={!readOnly && <HistoryMenu history={termsHistory} testId="terms-history" onSelect={terms => patchDraft({ terms })} />}
            />
            <CardBody>
              <Textarea
                aria-label="Terms"
                rows={8}
                value={draft.terms}
                placeholder="Payment terms, warranty, conditions."
                disabled={readOnly}
                onChange={e => patchDraft({ terms: e.target.value })}
              />
            </CardBody>
          </Card>

          <PaymentScheduleCard
            schedule={draft.paymentSchedule}
            totalCents={totals?.totalCents ?? 0}
            readOnly={readOnly}
            onChange={paymentSchedule => patchDraft({ paymentSchedule })}
          />

          <ProposalOptionsCard
            value={{
              title: draft.title,
              validUntil: draft.validUntil || null,
              fontFamily: draft.fontFamily,
              includeCostDetail: draft.includeCostDetail,
              includeSignature: draft.includeSignature,
              highlightQuality: draft.highlightQuality,
            }}
            includeHighlights={includeHighlights}
            canIncludeHighlights={draft.lines.some(l => l.kind === 'takeoff')}
            readOnly={readOnly}
            onChange={applyOptions}
            onIncludeHighlightsChange={setIncludeHighlights}
          />

          <ProposalPhotosCard
            proposal={proposal}
            projectId={projectId!}
            readOnly={readOnly}
            onChanged={reload}
          />

          <ProposalAttachmentsCard
            proposal={proposal}
            projectId={projectId!}
            readOnly={readOnly}
            onChanged={reload}
          />
        </div>
      )}

      {proposal && project && (
        <EmailComposer
          open={composing}
          onClose={() => setComposing(false)}
          projectId={project.id}
          title="Send proposal"
          primaryAttachmentName={`${proposalFileName(project)}.pdf`}
          defaultTo={emailDefaults.defaultTo || project.email?.from || ''}
          defaultCc={emailDefaults.defaultCc || undefined}
          defaultBcc={emailDefaults.defaultBcc || undefined}
          defaultSubject={project.email?.subject ? `Re: ${project.email.subject}` : `Proposal — ${project.name}`}
          defaultBody={"Please find our proposal attached. Don't hesitate to reach out with any questions."}
          headerEmailOptions={emailDefaults.headerEmailOptions.length ? emailDefaults.headerEmailOptions : undefined}
          defaultHeaderEmail={emailDefaults.companyEmail || undefined}
          onSend={handleSend}
        />
      )}
    </div>
  );
};
