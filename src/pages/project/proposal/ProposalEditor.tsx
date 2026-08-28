// src/pages/project/proposal/ProposalEditor.tsx — /project/:projectId/proposal/:proposalId
// The full-page proposal editor. It owns the whole editable draft; every card
// below it is controlled. Only a DRAFT (and non-legacy) proposal is editable —
// once sent, a proposal is a historical record and must be revised instead.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, FileText, Save } from 'lucide-react';
import {
  ConflictError, ProposalLockedError,
  getProject, getProposal, getUserPreferences, saveProposal, saveUserPreferences,
  type PaymentScheduleRow, type Proposal, type ProposalLine,
} from '../../../utils/store';
import type { Project } from '../../../types';
import { computeRevisionModel } from '../../../utils/planSets';
import { useToast } from '../../../components/Toast';
import { useCollabEditing } from '../../../hooks/useCollabEditing';
import { EditPresenceBanner } from '../../../components/EditPresenceBanner';
import { Button, Card, CardBody, CardHeader, Skeleton, StatusPill, Textarea } from '../../../components/ui';
import { computeTakeoffTotals, formatCurrency, normalizeHighlightQuality, type HighlightQuality } from './proposalGenerator';
import { proposalTotals, rederiveLines } from './proposalMath';
import { STATUS_TONE, proposalLabel } from './proposalPresentation';
import { parseHistory, pushHistory } from './proposalTextHistory';
import { PREF_KEYS, parseLineLibrary, pushLineLibrary, type ManualLineMemory } from './proposalPrefs';
import { HistoryMenu } from './HistoryMenu';
import { PricingLinesCard } from './PricingLinesCard';
import { InclusionsExclusionsCard } from './InclusionsExclusionsCard';
import { PaymentScheduleCard } from './PaymentScheduleCard';
import { ProposalOptionsCard, type ProposalOptionsValue } from './ProposalOptionsCard';

const isAdmin = () => (JSON.parse(localStorage.getItem('user') || '{}').role) === 'admin';

// The editable shape. Nullable server columns are flattened to '' here so
// every input stays controlled; save() puts the nulls back.
interface Draft {
  title: string;
  validUntil: string;
  fontFamily: NonNullable<Proposal['fontFamily']>;
  coverNotes: string;
  terms: string;
  inclusions: string[];
  exclusions: string[];
  paymentSchedule: PaymentScheduleRow[] | null;
  showGrandTotal: boolean;
  includeCostDetail: boolean;
  includeSignature: boolean;
  highlightQuality: HighlightQuality;
  lines: ProposalLine[];
}

const draftFrom = (p: Proposal, lines: ProposalLine[]): Draft => ({
  title: p.title ?? '',
  validUntil: p.validUntil ?? '',
  fontFamily: p.fontFamily ?? 'helvetica',
  coverNotes: p.coverNotes ?? '',
  terms: p.terms ?? '',
  inclusions: p.inclusions ?? [],
  exclusions: p.exclusions ?? [],
  paymentSchedule: p.paymentSchedule,
  showGrandTotal: p.showGrandTotal,
  includeCostDetail: p.includeCostDetail,
  includeSignature: p.includeSignature,
  highlightQuality: normalizeHighlightQuality(p.highlightQuality),
  lines,
});

// A line the re-derive touched: the takeoff moved under the proposal since it
// was last saved, so the draft is dirty before the estimator types anything.
const linesDiffer = (a: ProposalLine[], b: ProposalLine[]) =>
  a.length !== b.length || a.some((l, i) =>
    l.amountCents !== b[i].amountCents ||
    l.derivedAmountCents !== b[i].derivedAmountCents ||
    l.measurementSummary !== b[i].measurementSummary);

export const ProposalEditor: React.FC = () => {
  const { projectId, proposalId } = useParams<{ projectId: string; proposalId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const admin = isAdmin();

  const [project, setProject] = useState<Project | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [missingTakeoffIds, setMissingTakeoffIds] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  // Highlighted plan pages are a generate-time choice, not a stored proposal
  // column — the same option the old page carried.
  const [includeHighlights, setIncludeHighlights] = useState(false);

  const [notesHistory, setNotesHistory] = useState<string[]>([]);
  const [termsHistory, setTermsHistory] = useState<string[]>([]);
  const [inclusionsHistory, setInclusionsHistory] = useState<string[]>([]);
  const [exclusionsHistory, setExclusionsHistory] = useState<string[]>([]);
  const [lineLibrary, setLineLibrary] = useState<ManualLineMemory[]>([]);

  // useCollabEditing reads dirtiness from a callback on every foreign event,
  // long after this render closed over it — a ref keeps it current.
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const loadRef = useRef<() => void>(() => {});
  const load = () => {
    if (!projectId || !proposalId || !admin) return;
    Promise.all([getProposal(proposalId), getProject(projectId).catch(() => null)])
      .then(([p, proj]) => {
        setProject(proj);
        setProposal(p);
        setLoadFailed(false);
        const editable = p.status === 'draft' && !p.legacy;
        if (!editable) {
          setDraft(draftFrom(p, p.lines));
          setMissingTakeoffIds([]);
          setDirty(false);
          return;
        }
        // Without the project there are no takeoffs to compare against, and a
        // re-derive would flag EVERY takeoff line as "no longer exists" —
        // offering to delete real work because one fetch failed. Leave the
        // saved lines alone and say so instead.
        if (!proj) {
          setDraft(draftFrom(p, p.lines));
          setMissingTakeoffIds([]);
          setDirty(false);
          toast("Couldn't load takeoffs — amounts not refreshed", { type: 'warning' });
          return;
        }
        // Re-derive against the CURRENT takeoffs so a draft always prices the
        // work as it stands today; overridden lines keep their hand-set
        // amount (proposalMath.rederiveLines), and takeoffs that vanished are
        // flagged rather than silently zeroed.
        const totals = computeTakeoffTotals(proj, computeRevisionModel(proj, '').currentPageIds);
        const { lines, missingTakeoffIds: missing } = rederiveLines(p.lines, totals);
        setDraft(draftFrom(p, lines));
        setMissingTakeoffIds(missing);
        setDirty(linesDiffer(lines, p.lines));
      })
      .catch(() => setLoadFailed(true));
  };
  loadRef.current = load;

  useEffect(() => { loadRef.current(); }, [projectId, proposalId]);

  useEffect(() => {
    getUserPreferences()
      .then(prefs => {
        setNotesHistory(parseHistory(prefs[PREF_KEYS.notes]));
        setTermsHistory(parseHistory(prefs[PREF_KEYS.terms]));
        setInclusionsHistory(parseHistory(prefs[PREF_KEYS.inclusions]));
        setExclusionsHistory(parseHistory(prefs[PREF_KEYS.exclusions]));
        setLineLibrary(parseLineLibrary(prefs[PREF_KEYS.lines]));
      })
      .catch(() => { /* offline — the editor just has no remembered text */ });
  }, []);

  // Presence + the "someone else saved" banner. A pristine editor silently
  // reloads; a dirty one keeps the estimator's work and offers Review & merge
  // / Keep mine rather than clobbering it.
  const collab = useCollabEditing({
    type: 'proposal',
    id: proposalId ?? '',
    isDirty: () => dirtyRef.current,
    onFresh: () => loadRef.current(),
    enabled: admin,
  });

  const takeoffTotals = useMemo(
    () => (project ? computeTakeoffTotals(project, computeRevisionModel(project, '').currentPageIds) : []),
    [project],
  );

  const readOnly = !proposal || proposal.status !== 'draft' || proposal.legacy;
  const totals = draft ? proposalTotals(draft.lines) : null;

  const patchDraft = (patch: Partial<Draft>) => {
    setDraft(d => (d ? { ...d, ...patch } : d));
    setDirty(true);
  };

  // The options card speaks the server's nullable shape; the draft keeps ''.
  const applyOptions = (patch: Partial<ProposalOptionsValue>) => {
    const next: Partial<Draft> = {};
    if (patch.title !== undefined) next.title = patch.title ?? '';
    if (patch.validUntil !== undefined) next.validUntil = patch.validUntil ?? '';
    if (patch.fontFamily !== undefined) next.fontFamily = patch.fontFamily ?? 'helvetica';
    if (patch.includeCostDetail !== undefined) next.includeCostDetail = patch.includeCostDetail;
    if (patch.includeSignature !== undefined) next.includeSignature = patch.includeSignature;
    if (patch.highlightQuality !== undefined) next.highlightQuality = patch.highlightQuality;
    patchDraft(next);
  };

  // What this user just wrote becomes their defaults next time: the four text
  // histories, the manual-line library, and the document options. Never
  // throws — a preferences hiccup must not make a successful save look failed.
  const recordMemories = async (saved: Draft) => {
    try {
      const prefs = await getUserPreferences();
      const out: Record<string, string> = {};
      const text = (key: string, value: string, setter: (h: string[]) => void) => {
        const before = parseHistory(prefs[key]);
        const after = pushHistory(before, value);
        if (after !== before) { out[key] = JSON.stringify(after); setter(after); }
      };
      text(PREF_KEYS.notes, saved.coverNotes, setNotesHistory);
      text(PREF_KEYS.terms, saved.terms, setTermsHistory);
      text(PREF_KEYS.inclusions, saved.inclusions.join('\n'), setInclusionsHistory);
      text(PREF_KEYS.exclusions, saved.exclusions.join('\n'), setExclusionsHistory);

      const before = parseLineLibrary(prefs[PREF_KEYS.lines]);
      let library = before;
      for (const l of saved.lines) {
        if (l.kind === 'manual' && l.description.trim()) {
          library = pushLineLibrary(library, { description: l.description, amountCents: l.amountCents });
        }
      }
      if (library !== before) { out[PREF_KEYS.lines] = JSON.stringify(library); setLineLibrary(library); }

      out[PREF_KEYS.font] = saved.fontFamily;
      out[PREF_KEYS.quality] = saved.highlightQuality;
      out[PREF_KEYS.costDetail] = String(saved.includeCostDetail);
      out[PREF_KEYS.signature] = String(saved.includeSignature);
      out[PREF_KEYS.grandTotal] = String(saved.showGrandTotal);
      await saveUserPreferences(out);
    } catch { /* non-fatal */ }
  };

  const save = async () => {
    if (!draft || !proposal || readOnly || saving) return;
    setSaving(true);
    try {
      const { version } = await saveProposal(proposal.id, {
        // "Keep mine" adopts the foreign version so this save overwrites it
        // deliberately instead of bouncing off a stale-version 409.
        version: collab.keepMineVersion ?? proposal.version,
        title: draft.title.trim() || null,
        validUntil: draft.validUntil || null,
        fontFamily: draft.fontFamily,
        coverNotes: draft.coverNotes,
        terms: draft.terms,
        inclusions: draft.inclusions,
        exclusions: draft.exclusions,
        paymentSchedule: draft.paymentSchedule,
        showGrandTotal: draft.showGrandTotal,
        includeCostDetail: draft.includeCostDetail,
        includeSignature: draft.includeSignature,
        highlightQuality: draft.highlightQuality,
        // Ids and sort order are the server's to assign: array order IS the
        // print order.
        lines: draft.lines.map(({ id: _id, sortOrder: _sortOrder, ...rest }) => rest),
      });
      setProposal(prev => (prev ? { ...prev, version } : prev));
      setDirty(false);
      toast('Proposal saved', { type: 'success' });
      void recordMemories(draft);
    } catch (e) {
      if (e instanceof ProposalLockedError) {
        toast('This proposal is no longer a draft — revise it to make changes', { type: 'error' });
        load();
      } else if (e instanceof ConflictError) {
        toast('Someone else saved first — reloading their version', { type: 'error' });
        load();
      } else {
        toast('Failed to save the proposal', { type: 'error' });
      }
    } finally {
      setSaving(false);
    }
  };

  // Every hook above runs unconditionally; the gate is the last thing before
  // render so a non-admin who guesses the URL lands back on the project.
  if (!admin) return <Navigate to={`/project/${projectId}`} replace />;

  const statusText = readOnly
    ? (proposal?.legacy ? 'Imported — revise to change' : 'Locked — revise to change')
    : dirty ? 'Unsaved changes' : 'Saved';

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
          {totals && <span className="mr-1 text-sm font-semibold text-ink">{formatCurrency(totals.totalCents / 100)}</span>}
          {!readOnly && (
            <Button onClick={save} disabled={saving || !dirty} data-testid="btn-save-proposal">
              <Save size={16} />{saving ? 'Saving…' : 'Save'}
            </Button>
          )}
          {proposal?.fileId && (
            <Button variant="secondary" onClick={() => navigate(`/tools/pdf?fileId=${proposal.fileId}`)}>
              <FileText size={16} />Open PDF
            </Button>
          )}
          {/* Task 13: Generate PDF + Send (email defaults resolver + EmailComposer) */}
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

          {/* Task 12: ProposalPhotosCard + ProposalAttachmentsCard */}
        </div>
      )}
    </div>
  );
};
