// src/pages/project/ProjectProposal.tsx
//
// Standalone /proposal project section. Reuses the extracted proposal generator
// (proposalGenerator.ts) end-to-end — no PDF logic is forked here. The legacy
// proposal UI inside ProjectView still coexists during Phase 5b; it'll be
// removed in Task 4. Both call the same computeTakeoffTotals + generateProposalPdf.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { v4 as uuidv4 } from 'uuid';
import { FileText, RefreshCw, Eye, Download, Share2, Trash2, Send, Camera } from 'lucide-react';
import { Project, Printout, Customer } from '../../types';
import {
  getProject, saveProject, saveFile, getFile, deleteFile, getSettings,
  getSmtpSettings, getAlwaysCc, getCustomer,
  getUserPreferences, saveUserPreferences, createShare, sendProjectProposal,
  uploadProjectFile, getImageUrl,
} from '../../utils/store';
import { resolveRecipient } from '../../utils/recipients';
import { computeRevisionModel } from '../../utils/planSets';
import {
  computeTakeoffTotals,
  generateProposalPdf,
  getProposalPrefsKey,
  HIGHLIGHT_QUALITY_PRESETS,
  HighlightQuality,
  ProposalOptions,
} from './proposal/proposalGenerator';
import { hexToRgb, invertImageDataUrl } from '../../utils/documentLetterhead';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';
import { useShareLink } from '../../components/ShareLinkModal';
import {
  Button, Card, CardBody, CardHeader, EmptyState, Field, Input, Textarea, Select, Checkbox, Skeleton,
} from '../../components/ui';
import { EmailComposer } from '../../components/EmailComposer';

export const ProjectProposal: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const confirm = useConfirm();
  const shareLink = useShareLink();

  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');

  // Takeoff selection — defaults to ALL takeoffs checked.
  const [selectedTakeoffIds, setSelectedTakeoffIds] = useState<Set<string>>(new Set());

  // Price mode — 'takeoffs' prices from selected takeoffs (default, unchanged
  // behavior); 'fixed' is a lump-sum total entered by hand (site-visit pricing).
  const [priceMode, setPriceMode] = useState<'takeoffs' | 'fixed'>('takeoffs');
  const [fixedPrice, setFixedPrice] = useState('');

  // Photo upload state.
  const photoRef = useRef<HTMLInputElement>(null);
  const [uploadingPhotos, setUploadingPhotos] = useState(false);

  // Proposal options (ported from ProjectView's proposal state).
  const [customTitle, setCustomTitle] = useState('');
  const [headerColor, setHeaderColor] = useState('#1e293b');
  const [fontFamily, setFontFamily] = useState<'helvetica' | 'times' | 'courier'>('helvetica');
  const [validUntil, setValidUntil] = useState('');
  const [coverNotes, setCoverNotes] = useState('');
  const [terms, setTerms] = useState('');
  const [includeCostDetail, setIncludeCostDetail] = useState(false);
  const [includeHighlights, setIncludeHighlights] = useState(false);
  const [includeSignature, setIncludeSignature] = useState(false);
  const [includeTakeoffList, setIncludeTakeoffList] = useState(true);
  const [highlightQuality, setHighlightQuality] = useState<HighlightQuality>('standard');

  // Send-proposal controls.
  const [sendFileId, setSendFileId] = useState('');
  const [composing, setComposing] = useState(false);

  // Email defaults: resolved recipient, always-CC, header-email options.
  const [emailDefaults, setEmailDefaults] = useState<{
    defaultTo: string;
    defaultCc: string;
    defaultBcc: string;
    companyEmail: string;
    headerEmailOptions: { label: string; value: string }[];
  }>({ defaultTo: '', defaultCc: '', defaultBcc: '', companyEmail: '', headerEmailOptions: [] });

  // Load email defaults (once per project mount).
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    (async () => {
      try {
        const [settings, smtp, alwaysCc, proj] = await Promise.all([
          getSettings(),
          getSmtpSettings().catch(() => ({})),
          getAlwaysCc(),
          getProject(projectId).catch(() => null),
        ]);
        if (cancelled) return;
        let customer: Customer | undefined;
        if (proj?.customerId) {
          customer = await getCustomer(proj.customerId).catch(() => undefined);
        }
        const resolved = resolveRecipient('proposal', proj?.contactEmails, customer?.emails);
        const mergeCsv = (...lists: string[]) => Array.from(new Set(lists.flatMap(s => (s || '').split(',').map(x => x.trim()).filter(Boolean)))).join(', ');
        const companyEmail = settings.companyEmail ?? '';
        const fromAddress = (smtp as { fromAddress?: string }).fromAddress ?? '';
        const opts = [
          companyEmail ? { label: 'Company default', value: companyEmail } : null,
          fromAddress && fromAddress !== companyEmail ? { label: 'My email', value: fromAddress } : null,
        ].filter(Boolean) as { label: string; value: string }[];
        if (!cancelled) {
          setEmailDefaults({ defaultTo: resolved.to, defaultCc: mergeCsv(resolved.cc, alwaysCc), defaultBcc: resolved.bcc, companyEmail, headerEmailOptions: opts });
        }
      } catch { /* non-fatal */ }
    })();
    return () => { cancelled = true; };
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const reload = () => {
    if (!projectId) return;
    setLoading(true);
    getProject(projectId)
      .then(p => {
        setProject(p);
        if (p) setSelectedTakeoffIds(new Set(p.takeoffs.map(t => t.id)));
      })
      .catch(() => setProject(null))
      .finally(() => setLoading(false));
  };
  useEffect(reload, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Current-revision page ids — same model ProjectView uses (all plan sets, the
  // '' selection), so the proposal totals match the Takeoff tab exactly.
  const currentPageIds = useMemo(
    () => computeRevisionModel(project, '').currentPageIds,
    [project],
  );

  // ── Load saved prefs: localStorage first (instant), then server override ────
  // Ported verbatim from ProjectView's proposal-pref load effect.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(getProposalPrefsKey());
      if (raw) {
        const p = JSON.parse(raw);
        if (p.headerColor)                setHeaderColor(p.headerColor);
        if (p.fontFamily)                 setFontFamily(p.fontFamily);
        if (p.includeCostDetail != null)  setIncludeCostDetail(p.includeCostDetail);
        if (p.includeHighlights != null)  setIncludeHighlights(p.includeHighlights);
        if (p.includeSignature  != null)  setIncludeSignature(p.includeSignature);
        if (p.includeTakeoffList != null) setIncludeTakeoffList(p.includeTakeoffList);
        if (p.highlightQuality)           setHighlightQuality(p.highlightQuality);
        if (p.priceMode === 'fixed' || p.priceMode === 'takeoffs') setPriceMode(p.priceMode);
        if (typeof p.fixedPrice === 'string') setFixedPrice(p.fixedPrice);
      }
    } catch { /* ignore corrupt data */ }

    getUserPreferences().then(prefs => {
      if (prefs['proposal-headerColor'])                setHeaderColor(prefs['proposal-headerColor']);
      if (prefs['proposal-fontFamily'])                 setFontFamily(prefs['proposal-fontFamily'] as 'helvetica' | 'times' | 'courier');
      if (prefs['proposal-includeCostDetail'] != null)  setIncludeCostDetail(prefs['proposal-includeCostDetail'] === 'true');
      if (prefs['proposal-includeHighlights'] != null)  setIncludeHighlights(prefs['proposal-includeHighlights'] === 'true');
      if (prefs['proposal-includeSignature']  != null)  setIncludeSignature(prefs['proposal-includeSignature'] === 'true');
      if (prefs['proposal-includeTakeoffList'] != null) setIncludeTakeoffList(prefs['proposal-includeTakeoffList'] === 'true');
      if (prefs['proposal-highlightQuality'])           setHighlightQuality(prefs['proposal-highlightQuality'] as HighlightQuality);
      if (prefs['proposal-priceMode'] === 'fixed' || prefs['proposal-priceMode'] === 'takeoffs') setPriceMode(prefs['proposal-priceMode'] as 'takeoffs' | 'fixed');
      if (prefs['proposal-fixedPrice'] != null)         setFixedPrice(prefs['proposal-fixedPrice']);
    }).catch(() => { /* offline — localStorage values already applied */ });
  }, []);

  // ── Persist prefs on change (localStorage + server) ─────────────────────────
  useEffect(() => {
    try {
      localStorage.setItem(getProposalPrefsKey(), JSON.stringify({
        headerColor,
        fontFamily,
        includeCostDetail,
        includeHighlights,
        includeSignature,
        includeTakeoffList,
        highlightQuality,
        priceMode,
        fixedPrice,
      }));
    } catch { /* ignore quota errors */ }
    saveUserPreferences({
      'proposal-headerColor':       headerColor,
      'proposal-fontFamily':        fontFamily,
      'proposal-includeCostDetail': String(includeCostDetail),
      'proposal-includeHighlights': String(includeHighlights),
      'proposal-includeSignature':  String(includeSignature),
      'proposal-includeTakeoffList': String(includeTakeoffList),
      'proposal-highlightQuality':  highlightQuality,
      'proposal-priceMode':         priceMode,
      'proposal-fixedPrice':        fixedPrice,
    }).catch(() => {});
  }, [headerColor, fontFamily, includeCostDetail, includeHighlights, includeSignature, includeTakeoffList, highlightQuality, priceMode, fixedPrice]);

  const toggleTakeoff = (id: string) => {
    setSelectedTakeoffIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // ── Generate ────────────────────────────────────────────────────────────────
  const handleGenerate = async () => {
    if (!project) return;
    if (priceMode === 'fixed') {
      const n = Number(fixedPrice);
      // Require a positive price — an empty field parses to 0, which would
      // silently produce a $0 proposal.
      if (fixedPrice.trim() === '' || !Number.isFinite(n) || n <= 0) {
        toast('Enter a proposal price', { type: 'warning' });
        return;
      }
    } else if (selectedTakeoffIds.size === 0) {
      toast('Select at least one takeoff', { type: 'warning' });
      return;
    }
    setBusy(true);
    setProgress('Building cover page…');
    try {
      const settings = await getSettings();
      // Resolve persisted proposal photos to data URLs (skip any that fail).
      const photoDataUrls: string[] = [];
      for (const id of project.proposalPhotoIds || []) {
        try {
          const url = await getFile(id);
          if (url) photoDataUrls.push(url);
        } catch { /* skip unreadable photo */ }
      }
      // Resolve the company logo to a data URL (inverted when configured) for
      // the shared branded letterhead.
      let logoDataUrl: string | undefined = settings.logoUrl || undefined;
      if (logoDataUrl && !logoDataUrl.startsWith('data:')) {
        try {
          const blob = await (await fetch(logoDataUrl)).blob();
          logoDataUrl = await new Promise<string>(r => { const fr = new FileReader(); fr.onload = () => r(fr.result as string); fr.readAsDataURL(blob); });
        } catch { logoDataUrl = undefined; }
      }
      if (logoDataUrl && settings.invertLogoOnDocuments === 'true') {
        logoDataUrl = await invertImageDataUrl(logoDataUrl);
      }
      const options: ProposalOptions = {
        includeCostDetail,
        includeHighlights,
        headerColor,
        coverNotes,
        fontFamily,
        validUntil,
        terms,
        includeSignature,
        includeTakeoffList,
        customTitle,
        highlightQuality,
        priceMode,
        fixedPriceTotal: Number(fixedPrice) || 0,
        photoDataUrls,
        letterhead: {
          brandRgb: hexToRgb(settings.companyBrandColor || '#99CB38'),
          company: {
            name: settings.companyName || settings.appName,
            phone: settings.companyPhone,
            email: settings.companyEmail,
            address: settings.companyAddress,
          },
          logoDataUrl,
        },
      };
      const totals = computeTakeoffTotals(project, currentPageIds);
      const { pdfBytes, suggestedName } = await generateProposalPdf(
        project,
        totals,
        selectedTakeoffIds,
        currentPageIds,
        options,
        settings,
        msg => setProgress(msg),
      );

      setProgress('Saving…');
      const pdfBlob = new Blob([pdfBytes], { type: 'application/pdf' });
      const base64data: string = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(pdfBlob);
      });
      const fileId = uuidv4();
      await saveFile(fileId, base64data);
      const newPrintout: Printout = {
        id: uuidv4(),
        name: suggestedName,
        fileId,
        createdAt: Date.now(),
        type: 'pdf',
      };
      const updated = { ...project, printouts: [...(project.printouts || []), newPrintout] };
      await saveProject(updated);
      toast('Proposal generated', { type: 'success' });
      reload();
    } catch (error) {
      console.error('Error generating proposal:', error);
      toast('Failed to generate proposal PDF.', { type: 'error' });
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  // ── Printout history handlers (ported from ProjectView) ─────────────────────
  const handleView = (printout: Printout) => {
    const isExcel = printout.type === 'excel' || printout.name.toLowerCase().endsWith('.xlsx');
    navigate(isExcel ? `/tools/sheets?fileId=${printout.fileId}` : `/tools/pdf?fileId=${printout.fileId}`);
  };

  const handleDownload = async (printout: Printout) => {
    const dataUrl = await getFile(printout.fileId);
    if (!dataUrl) return;
    const link = document.createElement('a');
    link.href = dataUrl;
    const isExcel = printout.type === 'excel' || dataUrl.startsWith('data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const extension = isExcel ? '.xlsx' : '.pdf';
    link.download = printout.name.endsWith(extension) ? printout.name : `${printout.name}${extension}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleShare = async (printout: Printout) => {
    try {
      const id = await createShare('printout', printout.fileId, printout.name);
      const settings = await getSettings();
      const host = (settings.publicHost || window.location.origin).replace(/\/$/, '');
      shareLink(`${host}/share/${id}`, printout.name);
    } catch {
      toast('Failed to create share link', { type: 'error' });
    }
  };

  const handleDelete = async (printout: Printout) => {
    if (!project) return;
    if (!await confirm({
      title: 'Delete printout',
      message: `Delete "${printout.name}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    })) return;
    const updated = { ...project, printouts: (project.printouts || []).filter(p => p.id !== printout.id) };
    try {
      await saveProject(updated);
      await deleteFile(printout.fileId);
      reload();
    } catch {
      toast('Failed to delete printout', { type: 'error' });
    }
  };

  // ── Proposal photos (mirror the printout add/delete save+reload pattern) ─────
  // Uploads happen one at a time, accumulating ids into the latest project
  // snapshot, then a single version-checked saveProject + reload (re-fetches the
  // canonical version, so the next save won't 409).
  const handleAddPhotos = async (list: FileList | null) => {
    if (!project || !list || !list.length) return;
    setUploadingPhotos(true);
    const newIds: string[] = [];
    let ok = 0;
    for (const f of Array.from(list)) {
      try {
        const fileId = await uploadProjectFile(project.id, f, 'proposal-photo');
        newIds.push(fileId);
        ok++;
      } catch { /* keep going */ }
    }
    if (photoRef.current) photoRef.current.value = '';
    try {
      if (newIds.length) {
        const updated = { ...project, proposalPhotoIds: [...(project.proposalPhotoIds || []), ...newIds] };
        await saveProject(updated);
        reload();
      }
      if (ok < list.length) toast(`Uploaded ${ok} of ${list.length} photos`, { type: ok ? 'warning' : 'error' });
    } catch {
      toast('Failed to save photos', { type: 'error' });
    } finally {
      setUploadingPhotos(false);
    }
  };

  const handleRemovePhoto = async (fileId: string) => {
    if (!project) return;
    const updated = { ...project, proposalPhotoIds: (project.proposalPhotoIds || []).filter(id => id !== fileId) };
    try {
      await saveProject(updated);
      try { await deleteFile(fileId); } catch { /* best effort */ }
      reload();
    } catch {
      toast('Failed to remove photo', { type: 'error' });
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-6 md:px-8 space-y-4">
        <Skeleton className="h-8 w-48" />
        {[0, 1, 2].map(i => <Skeleton key={i} className="h-24" />)}
      </div>
    );
  }

  if (!project) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-6 md:px-8">
        <EmptyState icon={<FileText size={22} />} title="Project not found"
          description="This project could not be loaded." />
      </div>
    );
  }

  const pdfPrintouts = (project.printouts || []).filter(pr => pr.type === 'pdf');
  const sortedPrintouts = [...(project.printouts || [])].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8 space-y-6">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-bold text-ink">Proposal</h1>
        <Button onClick={handleGenerate} disabled={busy || (priceMode === 'takeoffs' && selectedTakeoffIds.size === 0)}>
          {busy ? <><RefreshCw size={15} className="animate-spin" />{progress || 'Generating…'}</> : <><FileText size={15} />Generate proposal</>}
        </Button>
      </div>

      {/* Pricing */}
      <Card>
        <CardHeader title="Pricing" />
        <CardBody>
          <div className="inline-flex rounded-lg border border-edge p-0.5">
            <button
              type="button"
              onClick={() => setPriceMode('takeoffs')}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${priceMode === 'takeoffs' ? 'bg-accent-600 text-white' : 'text-ink-faint hover:text-ink'}`}
              aria-pressed={priceMode === 'takeoffs'}
            >
              Price from takeoffs
            </button>
            <button
              type="button"
              onClick={() => setPriceMode('fixed')}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${priceMode === 'fixed' ? 'bg-accent-600 text-white' : 'text-ink-faint hover:text-ink'}`}
              aria-pressed={priceMode === 'fixed'}
            >
              Set price
            </button>
          </div>

          {priceMode === 'fixed' && (
            <div className="mt-4 max-w-xs">
              <Field label="Proposal price" htmlFor="prop-fixed" hint="Lump-sum total shown on the cover">
                <Input
                  id="prop-fixed"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  value={fixedPrice}
                  onChange={e => setFixedPrice(e.target.value)}
                  placeholder="0.00"
                />
              </Field>
            </div>
          )}
        </CardBody>
      </Card>

      {/* Takeoff selection */}
      {priceMode === 'takeoffs' && (
        <Card>
          <CardHeader title="Takeoffs to include" />
          <CardBody>
            {project.takeoffs.length === 0 ? (
              <p className="text-sm text-ink-faint">No takeoffs on this project yet.</p>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {project.takeoffs.map(t => (
                  <Checkbox
                    key={t.id}
                    label={t.name}
                    checked={selectedTakeoffIds.has(t.id)}
                    onChange={() => toggleTakeoff(t.id)}
                  />
                ))}
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {/* Proposal options */}
      <Card>
        <CardHeader title="Proposal options" />
        <CardBody>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Custom title" htmlFor="prop-title" hint="Defaults to the project name">
              <Input id="prop-title" value={customTitle} onChange={e => setCustomTitle(e.target.value)}
                placeholder={project.name} />
            </Field>
            <Field label="Header color" htmlFor="prop-color">
              <Input id="prop-color" type="color" value={headerColor} onChange={e => setHeaderColor(e.target.value)}
                className="h-10 w-20 p-1" />
            </Field>
            <Field label="Font" htmlFor="prop-font">
              <Select id="prop-font" value={fontFamily} onChange={e => setFontFamily(e.target.value as 'helvetica' | 'times' | 'courier')}>
                <option value="helvetica">Helvetica</option>
                <option value="times">Times</option>
                <option value="courier">Courier</option>
              </Select>
            </Field>
            <Field label="Valid until" htmlFor="prop-valid">
              <Input id="prop-valid" type="date" value={validUntil} onChange={e => setValidUntil(e.target.value)} />
            </Field>
            <Field label="Highlight quality" htmlFor="prop-quality">
              <Select id="prop-quality" value={highlightQuality} onChange={e => setHighlightQuality(e.target.value as HighlightQuality)}>
                {Object.entries(HIGHLIGHT_QUALITY_PRESETS).map(([key, preset]) => (
                  <option key={key} value={key}>{preset.label}</option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4">
            <Field label="Cover notes" htmlFor="prop-notes">
              <Textarea id="prop-notes" rows={3} value={coverNotes} onChange={e => setCoverNotes(e.target.value)}
                placeholder="Optional intro shown on the cover page" />
            </Field>
            <Field label="Terms & conditions" htmlFor="prop-terms">
              <Textarea id="prop-terms" rows={4} value={terms} onChange={e => setTerms(e.target.value)}
                placeholder="Optional terms appended as a final page" />
            </Field>
          </div>

          <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2">
            {priceMode === 'takeoffs' && (
              <>
                <Checkbox label="Include takeoff list" checked={includeTakeoffList} onChange={e => setIncludeTakeoffList(e.target.checked)} />
                <Checkbox label="Include cost detail" checked={includeCostDetail} onChange={e => setIncludeCostDetail(e.target.checked)} />
              </>
            )}
            <Checkbox label="Include highlighted plans" checked={includeHighlights} onChange={e => setIncludeHighlights(e.target.checked)} />
            <Checkbox label="Include signature block" checked={includeSignature} onChange={e => setIncludeSignature(e.target.checked)} />
          </div>
        </CardBody>
      </Card>

      {/* Photos — appended as pages to every generated proposal PDF */}
      <Card>
        <CardHeader title="Photos" />
        <CardBody>
          <p className="mb-3 text-sm text-ink-faint">
            Photos are appended as pages to every generated proposal PDF.
          </p>
          <input
            ref={photoRef}
            type="file"
            accept="image/*"
            multiple
            capture="environment"
            className="hidden"
            onChange={e => handleAddPhotos(e.target.files)}
          />
          <Button variant="secondary" onClick={() => photoRef.current?.click()} disabled={uploadingPhotos}>
            {uploadingPhotos ? <><RefreshCw size={15} className="animate-spin" />Uploading…</> : <><Camera size={15} />Add photos</>}
          </Button>

          {(project.proposalPhotoIds || []).length > 0 && (
            <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-4">
              {(project.proposalPhotoIds || []).map(fileId => (
                <div key={fileId} className="group relative">
                  <img src={getImageUrl(fileId)} alt="" className="h-24 w-full rounded-lg border border-edge object-cover" />
                  <button
                    onClick={() => handleRemovePhoto(fileId)}
                    title="Remove"
                    className="absolute right-1 top-1 flex min-h-9 min-w-9 items-center justify-center rounded-md bg-black/50 p-1 text-white opacity-100 transition-opacity focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Printout history */}
      <Card>
        <CardHeader title="Printout history" />
        <CardBody>
          {sortedPrintouts.length === 0 ? (
            <p className="text-sm text-ink-faint">No printouts yet. Generate a proposal to see it here.</p>
          ) : (
            <ul className="divide-y divide-edge">
              {sortedPrintouts.map(printout => (
                <li key={printout.id} className="flex items-center gap-3 py-2.5">
                  <FileText size={16} className="shrink-0 text-ink-faint" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink">{printout.name}</p>
                    <p className="text-xs text-ink-faint">{new Date(printout.createdAt).toLocaleString()}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button variant="ghost" onClick={() => handleView(printout)} title="View"><Eye size={15} /></Button>
                    <Button variant="ghost" onClick={() => handleDownload(printout)} title="Download"><Download size={15} /></Button>
                    <Button variant="ghost" onClick={() => handleShare(printout)} title="Share"><Share2 size={15} /></Button>
                    <Button variant="ghost" onClick={() => handleDelete(printout)} title="Delete"><Trash2 size={15} /></Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {/* Send proposal — available on every project (explicit recipient when
          there's no inbound bid email to reply to). */}
      <Card>
        <CardHeader title="Send proposal" />
        <CardBody>
          {project.proposalSentAt && (
            <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-800/40 dark:bg-emerald-900/20 dark:text-emerald-300">
              Proposal sent {new Date(project.proposalSentAt).toLocaleString()}
            </div>
          )}
          {project.email && (
            <p className="mb-3 text-xs text-ink-faint">
              Replying to {project.email.fromName || project.email.from} · Re: {project.email.subject}
            </p>
          )}
          <div className="grid grid-cols-1 gap-4">
            <Field label="Attach proposal" htmlFor="send-file">
              <Select id="send-file" value={sendFileId} onChange={e => setSendFileId(e.target.value)}>
                <option value="">— Select a printout —</option>
                {pdfPrintouts.map(pr => (
                  <option key={pr.fileId} value={pr.fileId}>{pr.name}</option>
                ))}
              </Select>
            </Field>
            {pdfPrintouts.length === 0 && (
              <p className="text-xs text-ink-faint">No PDF printouts yet. Generate one above first.</p>
            )}
            <div>
              <Button onClick={() => setComposing(true)} disabled={!sendFileId}>
                <Send size={15} />Send proposal
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>

      <EmailComposer
        open={composing}
        onClose={() => setComposing(false)}
        projectId={project.id}
        title="Send proposal"
        primaryAttachmentName={pdfPrintouts.find(pr => pr.fileId === sendFileId)?.name || 'Proposal.pdf'}
        defaultTo={emailDefaults.defaultTo || project.email?.from || ''}
        defaultCc={emailDefaults.defaultCc || undefined}
        defaultBcc={emailDefaults.defaultBcc || undefined}
        defaultSubject={project.email?.subject ? `Re: ${project.email.subject}` : `Proposal — ${project.name}`}
        defaultBody={`Please find our proposal attached. Don't hesitate to reach out with any questions.`}
        headerEmailOptions={emailDefaults.headerEmailOptions.length ? emailDefaults.headerEmailOptions : undefined}
        defaultHeaderEmail={emailDefaults.companyEmail || undefined}
        onSend={async (m) => {
          let fileIdToSend = sendFileId;
          // If the user chose a non-default header email, regenerate the proposal PDF
          // with the chosen email stamped in the letterhead.
          const effectiveHeaderEmail = m.headerEmail || emailDefaults.companyEmail || undefined;
          if (effectiveHeaderEmail && project) {
            try {
              const settings = await getSettings();
              const photoDataUrls: string[] = [];
              for (const id of project.proposalPhotoIds || []) {
                try { const url = await getFile(id); if (url) photoDataUrls.push(url); } catch { /* skip */ }
              }
              let logoDataUrl: string | undefined = settings.logoUrl || undefined;
              if (logoDataUrl && !logoDataUrl.startsWith('data:')) {
                try {
                  const blob = await (await fetch(logoDataUrl)).blob();
                  logoDataUrl = await new Promise<string>(r => { const fr = new FileReader(); fr.onload = () => r(fr.result as string); fr.readAsDataURL(blob); });
                } catch { logoDataUrl = undefined; }
              }
              if (logoDataUrl && settings.invertLogoOnDocuments === 'true') {
                logoDataUrl = await invertImageDataUrl(logoDataUrl);
              }
              const options: ProposalOptions = {
                includeCostDetail,
                includeHighlights,
                headerColor,
                coverNotes,
                fontFamily,
                validUntil,
                terms,
                includeSignature,
                includeTakeoffList,
                customTitle,
                highlightQuality,
                priceMode,
                fixedPriceTotal: Number(fixedPrice) || 0,
                photoDataUrls,
                headerEmail: effectiveHeaderEmail,
                letterhead: {
                  brandRgb: hexToRgb(settings.companyBrandColor || '#99CB38'),
                  company: {
                    name: settings.companyName || settings.appName,
                    phone: settings.companyPhone,
                    email: settings.companyEmail,
                    address: settings.companyAddress,
                  },
                  logoDataUrl,
                },
              };
              const totals = computeTakeoffTotals(project, currentPageIds);
              const { pdfBytes } = await generateProposalPdf(
                project, totals, selectedTakeoffIds, currentPageIds, options, settings, () => {},
              );
              const pdfBlob = new Blob([pdfBytes], { type: 'application/pdf' });
              const base64data: string = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result as string);
                reader.onerror = () => reject(reader.error);
                reader.readAsDataURL(pdfBlob);
              });
              const tempFileId = uuidv4();
              await saveFile(tempFileId, base64data);
              fileIdToSend = tempFileId;
            } catch { /* fall back to the pre-generated printout */ }
          }
          const updated = await sendProjectProposal(project.id, {
            to: m.to, cc: m.cc, bcc: m.bcc, subject: m.subject, body: m.body,
            fileId: fileIdToSend, attachmentFileIds: m.attachmentFileIds,
          });
          setProject(updated);
          setSendFileId('');
          toast('Proposal sent', { type: 'success' });
        }}
      />
    </div>
  );
};
