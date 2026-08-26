import { Project, TakeoffTemplate, SmtpSettings, ProjectNote, Customer } from '../types';
import { v4 as uuidv4 } from 'uuid';
import { computeTakeoffTotals } from '../pages/project/proposal/proposalGenerator';
import { calculateTakeoffTotalCost } from './math';
import { CLIENT_SESSION_ID } from './clientSession';

export const getAuthHeaders = () => {
  const token = localStorage.getItem('token');
  return {
    'X-Session-Id': CLIENT_SESSION_ID,
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
  };
};

export const getImageUrl = (id: string) => {
  return `/api/images/${id}/raw`;
};

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// HTTP statuses that indicate the server is willing to retry the same request.
// 401/4xx (other than 408/429) are caller errors — retrying won't help.
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

// Wraps fetch with a per-attempt timeout (via AbortController) and exponential-
// backoff retries for network failures and transient server responses. Designed
// for slow/flaky connections where a single transient drop should not lose
// pages mid-PDF-upload.
const fetchWithRetry = async (
  input: RequestInfo | URL,
  init: RequestInit = {},
  opts: { timeoutMs?: number; retries?: number } = {}
): Promise<Response> => {
  // Writes are never auto-retried: a retried PUT can carry a stale body and
  // the version handshake would reject it confusingly (and POSTs aren't
  // idempotent). Reads stay retried for flaky connections.
  const method = (init.method || 'GET').toUpperCase();
  const isWrite = method !== 'GET' && method !== 'HEAD';
  const { timeoutMs = 60_000, retries: requestedRetries = 3 } = opts;
  const retries = isWrite ? 0 : requestedRetries;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(input, { ...init, signal: controller.signal });
      clearTimeout(timer);
      if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
        // Drain the body so the connection can be reused for the retry.
        try { await res.body?.cancel(); } catch { /* ignore */ }
        await sleep(Math.min(1000 * Math.pow(2, attempt), 8000));
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < retries) {
        await sleep(Math.min(1000 * Math.pow(2, attempt), 8000));
        continue;
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Network error');
};

const handleResponse = async (res: Response) => {
  if (res.status === 401) {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = '/login';
    throw new Error('Session expired. Please log in again.');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Request failed');
  }
  return res;
};

export class ConflictError extends Error {
  constructor(public projectId: string) {
    super('Project was changed elsewhere');
    this.name = 'ConflictError';
  }
}

export const getSettings = async (): Promise<Record<string, string>> => {
  const res = await fetch('/api/settings');
  await handleResponse(res);
  return await res.json();
};

export const saveSettings = async (settings: Record<string, string>): Promise<void> => {
  const res = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(settings)
  });
  await handleResponse(res);
};

export const getUserPreferences = async (): Promise<Record<string, string>> => {
  const res = await fetch('/api/user-preferences', {
    headers: { ...getAuthHeaders() },
  });
  await handleResponse(res);
  return await res.json();
};

export const saveUserPreferences = async (prefs: Record<string, string>): Promise<void> => {
  const res = await fetch('/api/user-preferences', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(prefs),
  });
  await handleResponse(res);
};

// Saves are serialized per project: a save that fires while another is in
// flight waits for it, then sends with the freshest version we know. This
// keeps rapid fire-and-forget call sites (measurement edits) from racing
// themselves into spurious 409s.
const saveQueues = new Map<string, Promise<void>>();
// Highest version this tab has confirmed with the server, per project.
// Heals call sites that pass stale/throwaway objects: a genuinely stale
// TAB still 409s (the other tab's bumps are never in this map).
const latestVersions = new Map<string, number>();

// Lets non-saveProject callers (the realtime layer) feed the same
// only-raise-ever guard: e.g. a measurement-op ack or a canvas-join backfill
// bumping the known version without going through a save.
export function noteProjectVersion(projectId: string, version: number): void {
  if (version > (latestVersions.get(projectId) ?? 0)) {
    latestVersions.set(projectId, version);
  }
}

export const saveProject = (project: Project): Promise<void> => {
  const prev = saveQueues.get(project.id) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(() => doSaveProject(project));
  saveQueues.set(project.id, run);
  return run;
};

async function doSaveProject(project: Project): Promise<void> {
  const known = latestVersions.get(project.id) ?? 0;
  const version = Math.max(project.version ?? 0, known) || undefined;
  const payload = version !== undefined && version !== project.version
    ? { ...project, version }
    : project;
  const res = await fetchWithRetry('/api/projects/' + project.id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(payload)
  });
  if (res.status === 409) {
    window.dispatchEvent(new CustomEvent('project-conflict', { detail: { projectId: project.id } }));
    throw new ConflictError(project.id);
  }
  await handleResponse(res);
  const body = await res.json().catch(() => null);
  if (body && typeof body.version === 'number') {
    project.version = body.version;
    latestVersions.set(project.id, body.version);
  }
}

export const createProject = async (project: Project): Promise<void> => {
  const res = await fetchWithRetry('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(project)
  });
  await handleResponse(res);
  const body = await res.json().catch(() => null);
  project.version = body && typeof body.version === 'number' ? body.version : 1;
  latestVersions.set(project.id, project.version);
};

export const getProject = async (id: string): Promise<Project | null> => {
  const res = await fetchWithRetry('/api/projects/' + id, { headers: getAuthHeaders() });
  if (res.status === 404) return null;
  await handleResponse(res);
  const project = await res.json();
  if (project && typeof project.version === 'number') {
    latestVersions.set(project.id, project.version);
  }
  return project;
};

export const getAllProjects = async (): Promise<Project[]> => {
  const res = await fetch('/api/projects', { headers: getAuthHeaders() });
  await handleResponse(res);
  return await res.json();
};

export const deleteProject = async (id: string): Promise<void> => {
  const res = await fetch('/api/projects/' + id, { method: 'DELETE', headers: getAuthHeaders() });
  await handleResponse(res);
};

export const saveImage = async (
  id: string,
  dataUrl: string,
  opts?: { kind?: string; projectId?: string },
): Promise<void> => {
  // Per-page images can be several MB, so allow a longer timeout than the
  // default for callers on slow connections.
  const qs = new URLSearchParams();
  if (opts?.kind) qs.set('kind', opts.kind);
  if (opts?.projectId) qs.set('projectId', opts.projectId);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  const res = await fetchWithRetry(`/api/images${suffix}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ id, data: dataUrl })
  }, { timeoutMs: 120_000 });
  await handleResponse(res);
};

export const getImage = async (id: string): Promise<string | null> => {
  const res = await fetchWithRetry('/api/images/' + id, { headers: getAuthHeaders() });
  if (res.status === 404) return null;
  await handleResponse(res);
  const { data } = await res.json();
  return data;
};

export const saveFile = saveImage;
export const getFile = getImage;

// Attribution carried on every upload. sourceType/sourceId name the owning
// entity; with a kind that is single-instance the server versions that
// entity's existing document instead of creating a new row, so the returned
// fileId can differ from the id that was posted.
export interface FileUploadOpts {
  projectId?: string;
  kind?: string;
  name?: string;
  customerId?: string;
  sourceType?: string;
  sourceId?: string;
}

export interface UploadResult {
  fileId: string;
  versioned: boolean;
}

const uploadQuery = (opts?: FileUploadOpts): URLSearchParams => {
  const q = new URLSearchParams();
  if (opts?.projectId) q.set('projectId', opts.projectId);
  if (opts?.kind) q.set('kind', opts.kind);
  if (opts?.name) q.set('name', opts.name);
  if (opts?.customerId) q.set('customerId', opts.customerId);
  if (opts?.sourceType) q.set('sourceType', opts.sourceType);
  if (opts?.sourceId) q.set('sourceId', opts.sourceId);
  return q;
};

// Older servers answered these uploads with a bare { success: true }; fall
// back to the posted id so a stale deployment keeps working.
const readUploadResult = async (res: Response, postedId: string): Promise<UploadResult> => {
  try {
    const body = await res.json() as { fileId?: string; versioned?: boolean };
    return { fileId: body?.fileId || postedId, versioned: !!body?.versioned };
  } catch {
    return { fileId: postedId, versioned: false };
  }
};

// Streams a Blob/File to the server without going through a base64 dataUrl,
// avoiding the ~4× in-browser memory blowup that base64 + JSON.stringify
// produce for large PDFs (which can OOM Chrome on plan-set uploads). The
// server base64-encodes once before storing so the file appears in the same
// images table and the existing /api/images/:id/raw read path works unchanged.
export const saveBinaryFile = async (
  id: string,
  blob: Blob,
  opts?: FileUploadOpts,
): Promise<UploadResult> => {
  const headers: Record<string, string> = {
    'Content-Type': blob.type || 'application/octet-stream',
    ...getAuthHeaders(),
  };
  const qs = uploadQuery(opts).toString();
  const res = await fetchWithRetry(`/api/files/${encodeURIComponent(id)}${qs ? `?${qs}` : ''}`, {
    method: 'POST',
    headers,
    body: blob,
  }, { timeoutMs: 300_000 });
  await handleResponse(res);
  return await readUploadResult(res, id);
};
// Real delete (server/documents.ts's deleteDocument guard: 409s unless the
// row is an unsourced direct upload — see documentsPolicy.ts). Superseded the
// old no-op stub once the Documents page needed an actual delete affordance.
export const deleteFile = async (id: string): Promise<void> => {
  const res = await fetchWithRetry(`/api/files/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { ...getAuthHeaders() },
  });
  await handleResponse(res);
};

// Template functions
export const saveTemplate = async (template: TakeoffTemplate): Promise<void> => {
  const res = await fetch('/api/templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(template)
  });
  await handleResponse(res);
};

export const getTemplates = async (): Promise<TakeoffTemplate[]> => {
  const res = await fetch('/api/templates', { headers: getAuthHeaders() });
  await handleResponse(res);
  return await res.json();
};

export const deleteTemplate = async (id: string): Promise<void> => {
  const res = await fetch('/api/templates/' + id, { method: 'DELETE', headers: getAuthHeaders() });
  await handleResponse(res);
};

// Email / SMTP functions
export const getSmtpSettings = async (): Promise<Partial<SmtpSettings>> => {
  const res = await fetch('/api/email/smtp', { headers: getAuthHeaders() });
  await handleResponse(res);
  // Values are stored as strings; normalize the typed fields so the form's
  // boolean toggle / numeric port round-trip correctly.
  const raw = await res.json() as Record<string, string>;
  const out: Partial<SmtpSettings> = { ...(raw as Partial<SmtpSettings>) };
  if ('secure' in raw) out.secure = raw.secure === 'true';
  if (raw.port) out.port = Number(raw.port); else delete (out as Partial<SmtpSettings>).port;
  return out;
};

export const saveSmtpSettings = async (cfg: Partial<SmtpSettings>): Promise<void> => {
  const res = await fetch('/api/email/smtp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(cfg),
  });
  await handleResponse(res);
};

export const testSmtpConnection = async (): Promise<void> => {
  const res = await fetch('/api/email/test-smtp', { method: 'POST', headers: getAuthHeaders() });
  await handleResponse(res);
};

export const sendProjectProposal = async (
  projectId: string,
  payload: { to?: string; cc?: string; bcc?: string; subject?: string; body?: string; fileId: string; attachmentFileIds?: string[] }
): Promise<Project> => {
  const res = await fetch(`/api/projects/${projectId}/send-proposal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(payload),
  });
  await handleResponse(res);
  return await res.json();
};

export const getProjectNotes = async (projectId: string): Promise<ProjectNote | null> => {
  const res = await fetch(`/api/projects/${projectId}/notes`, { headers: getAuthHeaders() });
  await handleResponse(res);
  return await res.json();
};

export const saveProjectNotes = async (projectId: string, note: ProjectNote): Promise<void> => {
  const res = await fetch(`/api/projects/${projectId}/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(note)
  });
  await handleResponse(res);
};

export const createShare = async (type: string, resourceId: string, name: string): Promise<string> => {
  const res = await fetch('/api/shares', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ type, resourceId, name }),
  });
  await handleResponse(res);
  const { id } = await res.json();
  return id;
};

export const getShareInfo = async (shareId: string): Promise<{ type: string; name: string; count?: number }> => {
  const res = await fetch(`/api/share/${shareId}/info`);
  await handleResponse(res);
  return res.json();
};

// ── Recently opened projects (client-only, newest first) ─────────────────────

export interface RecentProject { id: string; name: string; at: number; }
const RECENTS_KEY = 'recentProjects';

export const getRecentProjects = (): RecentProject[] => {
  try { return JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]'); } catch { return []; }
};

export const recordRecentProject = (id: string, name: string): void => {
  try {
    const list = getRecentProjects().filter(r => r.id !== id);
    list.unshift({ id, name, at: Date.now() });
    localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, 8)));
  } catch { /* ignore */ }
};

// ── Global search (command palette) ──────────────────────────────────────────

export interface SearchResult {
  type: 'project' | 'page' | 'takeoff';
  id: string;
  title: string;
  subtitle?: string;
  projectId?: string;
  pageId?: string;
}

export const searchAll = async (q: string): Promise<SearchResult[]> => {
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { headers: getAuthHeaders() });
  await handleResponse(res);
  const { results } = await res.json();
  return results;
};

// ── Storage usage ───────────────────────────────────────────────────────────

export interface StorageStats {
  databaseBytes: number;
  breakdown: { images: number; projects: number; templates: number; notes: number; checklists: number };
  imageCount: number;
  projectCount: number;
  projects: { id: string; name: string; totalBytes: number }[];
}

export interface ProjectStorage {
  totalBytes: number;
  dataBytes: number;
  imageBytes: number;
  noteBytes: number;
  imageCount: number;
}

export const getStorageStats = async (): Promise<StorageStats> => {
  const res = await fetch('/api/storage/stats', { headers: getAuthHeaders() });
  await handleResponse(res);
  return res.json();
};

export const getProjectStorage = async (id: string): Promise<ProjectStorage> => {
  const res = await fetch(`/api/projects/${id}/storage`, { headers: getAuthHeaders() });
  await handleResponse(res);
  return res.json();
};

export const getStorageOrphans = async (): Promise<{ count: number; bytes: number }> => {
  const res = await fetch('/api/storage/orphans', { headers: getAuthHeaders() });
  await handleResponse(res);
  return res.json();
};

export const cleanupStorageOrphans = async (): Promise<{ deleted: number; bytesFreed: number }> => {
  const res = await fetch('/api/storage/orphans/cleanup', { method: 'POST', headers: getAuthHeaders() });
  await handleResponse(res);
  return res.json();
};

// Human-readable byte size, e.g. 1536 -> "1.5 KB".
export const formatBytes = (bytes: number): string => {
  if (!bytes || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

// ── Phase 3a: summaries, granular patches, activity, time ────────────────────

export interface ProjectSummary {
  id: string;
  name: string;
  status: string;
  contractor: string | null;
  customerId: string | null;
  address: string | null;
  bidDueDate: number | null;
  version: number;
  createdAt: number;
  updatedAt: number | null;
  archived: boolean;
  // Set only on archived projects whose bid was lost — drives the Archive
  // tab's "Lost" badge.
  lostBid?: boolean;
  pageCount: number;
  takeoffCount: number;
  pageIds: string[];
  openIssueCount: number;
  punchDone: number;
  punchTotal: number;
  contractValueCents?: number;
  invoiceCount?: number;
  // Admin-only (billing is gated server-side) — absent for non-admins.
  outstandingCents?: number;
}

export interface ProjectPatch {
  version: number;
  name?: string;
  status?: string;
  archived?: boolean;
  lostBid?: boolean;
  contractor?: string | null;
  address?: string | null;
  bidDueDate?: number | null;
}

export interface ActivityItem {
  id: string;
  projectId: string | null;
  userId: string | null;
  type: string;
  message: string;
  createdAt: number;
  projectName: string | null;
  username: string | null;
}

export interface TimeEntryLite {
  id: string;
  projectId: string | null;
  clockIn: number;
  clockOut: number | null;
  description: string;
}

export const getProjectsSummary = async (): Promise<ProjectSummary[]> => {
  const res = await fetchWithRetry('/api/projects/summary', { headers: { ...getAuthHeaders() } });
  await handleResponse(res);
  return await res.json();
};

// Granular field update with optimistic concurrency. Unlike saveProject, a
// 409 here does NOT dispatch the global project-conflict event — callers
// decide (list views refetch; ProjectView dispatches it themselves).
export const patchProject = async (
  id: string,
  patch: ProjectPatch
): Promise<{ version: number; status: string }> => {
  const res = await fetchWithRetry(`/api/projects/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(patch),
  });
  if (res.status === 409) throw new ConflictError(id);
  await handleResponse(res);
  return await res.json();
};

export const getActivity = async (limit = 20, projectId?: string): Promise<ActivityItem[]> => {
  const qs = `limit=${limit}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`;
  const res = await fetchWithRetry(`/api/activity?${qs}`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res);
  return (await res.json()).items;
};

export const getMyTimeEntries = async (projectId?: string): Promise<TimeEntryLite[]> => {
  const url = projectId ? `/api/time-entries?projectId=${encodeURIComponent(projectId)}` : '/api/time-entries';
  const res = await fetchWithRetry(url, { headers: { ...getAuthHeaders() } });
  await handleResponse(res);
  return await res.json();
};

export const clockIn = async (projectId?: string): Promise<void> => {
  const res = await fetchWithRetry('/api/time-entries/clock-in', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ projectId: projectId ?? null }),
  });
  await handleResponse(res);
};

export const clockOut = async (): Promise<void> => {
  const res = await fetchWithRetry('/api/time-entries/clock-out', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({}),
  });
  await handleResponse(res);
};

// ── Phase 3b: project files, versions, drafts ────────────────────────────────

export interface ProjectFile {
  id: string;
  projectId: string | null;
  name: string | null;
  mime: string;
  size: number;
  kind: string;
  parentFileId: string | null;
  versionNumber: number;
  createdAt: number;
}

export interface EditorDraft {
  kind: 'pdf' | 'sheet';
  data: string;
  updatedAt: number;
}

export const getProjectSummary = async (id: string): Promise<ProjectSummary | null> => {
  const res = await fetchWithRetry(`/api/projects/${encodeURIComponent(id)}/summary`, {
    headers: { ...getAuthHeaders() },
  });
  if (res.status === 404) return null;
  await handleResponse(res);
  return await res.json();
};

export const getFileMeta = async (id: string): Promise<ProjectFile | null> => {
  const res = await fetchWithRetry(`/api/files/${encodeURIComponent(id)}/meta`, {
    headers: { ...getAuthHeaders() },
  });
  if (res.status === 404) return null;
  await handleResponse(res);
  return await res.json();
};

export const listFileVersions = async (id: string): Promise<ProjectFile[]> => {
  const res = await fetchWithRetry(`/api/files/${encodeURIComponent(id)}/versions`, {
    headers: { ...getAuthHeaders() },
  });
  await handleResponse(res);
  return await res.json();
};

// Upload a project document. Callers must record the RETURNED fileId, not the
// id this mints: for single-instance kinds the server may version the document
// the given source already owns and return that row's id instead.
export const uploadProjectFile = async (
  projectId: string,
  file: File,
  kind: string,
  opts?: Omit<FileUploadOpts, 'projectId' | 'kind' | 'name'>,
): Promise<UploadResult> => {
  const id = uuidv4();
  const qs = uploadQuery({ ...opts, projectId, kind, name: file.name }).toString();
  const res = await fetchWithRetry(`/api/files/${id}?${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream', ...getAuthHeaders() },
    body: file,
  }, { timeoutMs: 300_000 });
  await handleResponse(res);
  return await readUploadResult(res, id);
};

// Store a freshly generated document (PDF/XLSX) so Generate, Download and Send
// of the same entity converge on ONE living document: the source triple makes
// the server version the existing row rather than pile up duplicates.
export const persistGeneratedDocument = async (
  blob: Blob,
  opts: FileUploadOpts & { kind: string; name: string },
): Promise<UploadResult> => saveBinaryFile(uuidv4(), blob, opts);

// Save-as-version: live content keeps its id; old bytes become history.
export const saveFileVersion = async (id: string, blob: Blob): Promise<{ versionNumber: number }> => {
  const res = await fetchWithRetry(`/api/files/${encodeURIComponent(id)}/versions`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream', ...getAuthHeaders() },
    body: blob,
  }, { timeoutMs: 300_000 });
  await handleResponse(res);
  return await res.json();
};

// Authenticated binary fetch of a file's live content.
export const fetchFileBlob = async (id: string): Promise<Blob> => {
  const res = await fetchWithRetry(`/api/files/${encodeURIComponent(id)}/content`, {
    headers: { ...getAuthHeaders() },
  }, { timeoutMs: 300_000 });
  await handleResponse(res);
  return await res.blob();
};

export const getDraft = async (fileId: string): Promise<EditorDraft | null> => {
  const res = await fetchWithRetry(`/api/drafts/${encodeURIComponent(fileId)}`, {
    headers: { ...getAuthHeaders() },
  });
  if (res.status === 404) return null;
  await handleResponse(res);
  return await res.json();
};

export const putDraft = async (fileId: string, kind: 'pdf' | 'sheet', data: string): Promise<void> => {
  const res = await fetchWithRetry(`/api/drafts/${encodeURIComponent(fileId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ kind, data }),
  });
  await handleResponse(res);
};

export const deleteDraft = async (fileId: string): Promise<void> => {
  const res = await fetchWithRetry(`/api/drafts/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: { ...getAuthHeaders() },
  });
  await handleResponse(res);
};

// ── Global Documents page (spec docs/superpowers/specs/2026-08-17-unified-documents-design.md) ──

export interface DocumentSource {
  type: string;
  id: string;
  label: string;
  href: string | null;
}

export interface DocumentRow {
  id: string;
  name: string | null;
  mime: string;
  size: number;
  kind: string;
  createdAt: number;
  versionNumber: number;
  archived: boolean;
  projectId: string | null;
  projectName: string | null;
  customerId: string | null;
  customerName: string | null;
  source: DocumentSource | null;
}

export interface DocumentFilters {
  projectIds?: string[];
  customerIds?: string[];
  kinds?: string[];
  q?: string;
  archived?: boolean;
  // Admin-only exclusive view — ignored by the server for non-admins. See
  // server/documents.ts DocumentFilters for the full semantics.
  unassigned?: boolean;
  limit?: number;
  offset?: number;
}

export const getDocuments = async (
  filters: DocumentFilters = {}
): Promise<{ rows: DocumentRow[]; total: number }> => {
  const p = new URLSearchParams();
  if (filters.projectIds?.length) p.set('projectIds', filters.projectIds.join(','));
  if (filters.customerIds?.length) p.set('customerIds', filters.customerIds.join(','));
  if (filters.kinds?.length) p.set('kinds', filters.kinds.join(','));
  if (filters.q) p.set('q', filters.q);
  if (filters.archived) p.set('archived', '1');
  if (filters.unassigned) p.set('unassigned', '1');
  if (filters.limit != null) p.set('limit', String(filters.limit));
  if (filters.offset != null) p.set('offset', String(filters.offset));
  const res = await fetchWithRetry(`/api/documents?${p.toString()}`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res);
  return await res.json();
};

// Archive/restore or re-type a file (server/documents.ts's patchDocument
// guard: kind may only move between direct-upload kinds; archived toggles
// freely). Returns the updated row's slim metadata.
export const patchFile = async (
  id: string,
  patch: { archived?: boolean; kind?: string },
): Promise<{ id: string; kind: string; archived: boolean }> => {
  const res = await fetchWithRetry(`/api/files/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(patch),
  });
  await handleResponse(res);
  return await res.json();
};

// Admin-managed custom document types (spec §Data model: settings.documentTypes
// JSON [{id,label}], files store the id). Saved through the general settings
// PUT path like every other admin setting — see Settings.tsx's other cards.
export interface CustomDocType {
  id: string;
  label: string;
}

export const getDocumentTypes = async (): Promise<CustomDocType[]> => {
  const s = await getSettings();
  try {
    const parsed = s.documentTypes ? JSON.parse(s.documentTypes) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const saveDocumentTypes = async (types: CustomDocType[]): Promise<void> => {
  await saveSettings({ documentTypes: JSON.stringify(types) });
};

// ── Phase 4a: billing ────────────────────────────────────────────────────────

export interface InvoiceLine {
  id?: string;
  description: string;
  qty: number;
  unitPrice: number;
}
export interface Payment {
  id: string;
  targetType: string;
  targetId: string;
  date: number | null;
  amount: number;
  method: string | null;
  note: string | null;
  createdAt: number;
  targetLabel?: string;
}
export interface Invoice {
  id: string;
  projectId: string;
  number: string | null;
  date: number | null;
  status: string; // draft | sent | paid
  terms: string | null;
  version: number;
  createdAt: number;
  lines: InvoiceLine[];
  payments: Payment[];
  totalCents: number;
  paidCents: number;
  balanceCents: number;
}
export interface InvoiceListItem {
  id: string; projectId: string; number: string | null; date: number | null;
  status: string; terms: string | null; version: number; createdAt: number;
  totalCents: number; paidCents: number; balanceCents: number;
}
export interface ChangeOrderLine {
  id?: string;
  description: string;
  qty: number;
  unitPrice: number;
}
export interface COPhoto {
  id: string;
  fileId: string;
  sortOrder: number;
}
export interface ChangeOrder {
  id: string;
  projectId: string;
  number: string | null;
  date: number | null;
  title: string | null;
  description: string | null;
  lumpSumAmount: number;
  scheduleImpactDays: number | null;
  status: string; // draft | sent | approved | rejected (legacy: pending)
  version: number;
  createdAt: number;
  amount: number; // canonical rolled-up dollar total (= (Σ line cents + lump-sum cents)/100)
  lines: ChangeOrderLine[];
  photos: COPhoto[];
  totalCents: number;
  lumpSumCents: number;
}
export interface ChangeOrderListItem {
  id: string;
  projectId: string;
  number: string | null;
  date: number | null;
  title: string | null;
  description: string | null;
  lumpSumAmount: number;
  scheduleImpactDays: number | null;
  status: string;
  version: number;
  createdAt: number;
  amount: number;
  totalCents: number;
}
export interface ChangeOrderInput {
  number?: string;
  date?: number | null;
  title?: string | null;
  description?: string;
  lumpSumAmount?: number;
  scheduleImpactDays?: number | null;
  lines?: { description: string; qty: number; unitPrice: number }[];
}
export interface BillingSummary {
  sovOriginalCents: number;
  hasSov: boolean;
  baseContractCents: number;
  approvedChangeCents: number;
  contractTotalCents: number;
  contractValueCents: number;
  invoiceTotalCents: number;
  invoicedCents: number;
  paid: { invoicesCents: number; payAppsCents: number };
  paidCents: number;
  invoiceOutstandingCents: number;
  outstandingCents: number;
  invoiceCount: number;
  changeOrderCount: number;
  payAppBilledCents: number;
  payAppOutstandingCents: number;
  payAppPaidCents: number;
  invoiceBilledCents: number;
  invoicePaidCents: number;
  invoiceOutstandingBilledCents: number;
}
export interface InvoiceInput {
  number?: string; date?: number | null; terms?: string; status?: string;
  lines: { description: string; qty: number; unitPrice: number }[];
}

const billingJson = (method: string, url: string, body?: unknown) =>
  fetchWithRetry(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

export const getInvoices = async (projectId: string): Promise<InvoiceListItem[]> => {
  const res = await fetchWithRetry(`/api/projects/${projectId}/invoices`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const getInvoice = async (id: string): Promise<Invoice> => {
  const res = await fetchWithRetry(`/api/invoices/${id}`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const createInvoice = async (projectId: string, input: InvoiceInput): Promise<{ id: string; version: number }> => {
  const res = await billingJson('POST', `/api/projects/${projectId}/invoices`, input);
  await handleResponse(res); return res.json();
};
export const saveInvoice = async (id: string, invoice: Invoice): Promise<{ version: number }> => {
  const res = await billingJson('PUT', `/api/invoices/${id}`, invoice);
  if (res.status === 409) throw new ConflictError(id);
  await handleResponse(res); return res.json();
};
export const setInvoiceStatus = async (id: string, status: string): Promise<{ version: number }> => {
  const res = await billingJson('PATCH', `/api/invoices/${id}`, { status });
  await handleResponse(res); return res.json();
};
export const deleteInvoice = async (id: string): Promise<void> => {
  const res = await billingJson('DELETE', `/api/invoices/${id}`); await handleResponse(res);
};
export const getProjectPayments = async (projectId: string): Promise<Payment[]> => {
  const res = await fetchWithRetry(`/api/projects/${projectId}/payments`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const recordPayment = async (
  projectId: string,
  targetType: 'invoice' | 'payapp',
  targetId: string,
  input: { amount: number; date?: number | null; method?: string; note?: string }
): Promise<void> => {
  const res = await billingJson('POST', `/api/projects/${projectId}/payments`, { targetType, targetId, ...input });
  await handleResponse(res);
};
export const deletePayment = async (id: string): Promise<void> => {
  const res = await billingJson('DELETE', `/api/payments/${id}`); await handleResponse(res);
};
export const getChangeOrders = async (projectId: string): Promise<ChangeOrderListItem[]> => {
  const res = await fetchWithRetry(`/api/projects/${projectId}/change-orders`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const getChangeOrder = async (id: string): Promise<ChangeOrder> => {
  const res = await fetchWithRetry(`/api/change-orders/${id}`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
// The server ignores any passed `amount` — the total is rolled up server-side
// from lumpSumAmount + lines. (Legacy callers may still pass `amount`; harmless.)
export const createChangeOrder = async (
  projectId: string,
  input?: ChangeOrderInput & { amount?: number }
): Promise<{ id: string; version: number }> => {
  const res = await billingJson('POST', `/api/projects/${projectId}/change-orders`, input ?? {});
  await handleResponse(res); return res.json();
};
export const saveChangeOrder = async (id: string, changeOrder: ChangeOrder): Promise<{ version: number }> => {
  const res = await billingJson('PUT', `/api/change-orders/${id}`, changeOrder);
  if (res.status === 409) throw new ConflictError(id);
  await handleResponse(res); return res.json();
};
export const setChangeOrderStatus = async (id: string, status: string): Promise<void> => {
  const res = await billingJson('PATCH', `/api/change-orders/${id}`, { status }); await handleResponse(res);
};
export const deleteChangeOrder = async (id: string): Promise<void> => {
  const res = await billingJson('DELETE', `/api/change-orders/${id}`); await handleResponse(res);
};
export const addCOPhoto = async (coId: string, fileId: string): Promise<void> => {
  const res = await billingJson('POST', `/api/change-orders/${coId}/photos`, { fileId }); await handleResponse(res);
};
export const removeCOPhoto = async (coId: string, fileId: string): Promise<void> => {
  const res = await billingJson('DELETE', `/api/change-orders/${coId}/photos/${encodeURIComponent(fileId)}`); await handleResponse(res);
};
export const sendChangeOrder = async (id: string, payload: { to: string; cc?: string; bcc?: string; subject?: string; body?: string; fileId: string; attachmentFileIds?: string[]; message?: string }): Promise<void> => {
  const res = await billingJson('POST', `/api/change-orders/${id}/send`, payload); await handleResponse(res);
};
export const getBillingSummary = async (projectId: string): Promise<BillingSummary> => {
  const res = await fetchWithRetry(`/api/projects/${projectId}/billing-summary`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const sendInvoice = async (id: string, payload: { to: string; cc?: string; bcc?: string; subject?: string; body?: string; fileId: string; attachmentFileIds?: string[]; message?: string }): Promise<void> => {
  const res = await billingJson('POST', `/api/invoices/${id}/send`, payload);
  await handleResponse(res);
};

// ── Phase 4b: issues ─────────────────────────────────────────────────────────

export interface IssuePhoto { id: string; fileId: string; sortOrder: number; }
export interface Issue {
  id: string;
  projectId: string;
  number: number;
  title: string | null;
  description: string | null;
  status: string; // open | sent | resolved
  version: number;
  sentAt: number | null;
  createdAt: number;
  photos: IssuePhoto[];
}
export interface IssueListItem {
  id: string; projectId: string; number: number; title: string | null;
  description: string | null; status: string; version: number; sentAt: number | null;
  createdAt: number; photoCount: number;
}

const issueJson = (method: string, url: string, body?: unknown) =>
  fetchWithRetry(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

export const getIssues = async (projectId: string): Promise<IssueListItem[]> => {
  const res = await fetchWithRetry(`/api/projects/${projectId}/issues`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const getIssue = async (id: string): Promise<Issue> => {
  const res = await fetchWithRetry(`/api/issues/${id}`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const createIssue = async (projectId: string, input: { title: string; description?: string }): Promise<{ id: string; number: number }> => {
  const res = await issueJson('POST', `/api/projects/${projectId}/issues`, input);
  await handleResponse(res); return res.json();
};
export const saveIssue = async (id: string, issue: Issue): Promise<{ version: number }> => {
  const res = await issueJson('PUT', `/api/issues/${id}`, issue);
  if (res.status === 409) throw new ConflictError(id);
  await handleResponse(res); return res.json();
};
export const setIssueStatus = async (id: string, status: string): Promise<void> => {
  const res = await issueJson('PATCH', `/api/issues/${id}`, { status }); await handleResponse(res);
};
export const deleteIssue = async (id: string): Promise<void> => {
  const res = await issueJson('DELETE', `/api/issues/${id}`); await handleResponse(res);
};
export const addIssuePhoto = async (issueId: string, fileId: string): Promise<void> => {
  const res = await issueJson('POST', `/api/issues/${issueId}/photos`, { fileId }); await handleResponse(res);
};
export const removeIssuePhoto = async (issueId: string, fileId: string): Promise<void> => {
  const res = await issueJson('DELETE', `/api/issues/${issueId}/photos/${encodeURIComponent(fileId)}`); await handleResponse(res);
};
export const sendIssue = async (id: string, payload: { to: string; cc?: string; bcc?: string; subject?: string; body?: string; fileId: string; attachmentFileIds?: string[]; message?: string }): Promise<void> => {
  const res = await issueJson('POST', `/api/issues/${id}/send`, payload); await handleResponse(res);
};

// ── RFIs ─────────────────────────────────────────────────────────────────────

export interface RfiPhoto { id: string; fileId: string; sortOrder: number; }
export interface Rfi {
  id: string;
  projectId: string;
  number: number;
  title: string | null;
  question: string | null;
  specRef: string | null;
  drawingRef: string | null;
  attention: string | null;
  responseNeededBy: string | null; // ISO date (yyyy-mm-dd)
  responseText: string | null;
  responseFileId: string | null;
  status: string; // open | sent | answered | closed
  version: number;
  sentAt: number | null;
  answeredAt: number | null;
  createdAt: number;
  photos: RfiPhoto[];
}
export interface RfiListItem {
  id: string; projectId: string; number: number; title: string | null;
  question: string | null; specRef: string | null; drawingRef: string | null;
  attention: string | null; responseNeededBy: string | null;
  responseText: string | null; responseFileId: string | null;
  status: string; version: number; sentAt: number | null; answeredAt: number | null;
  createdAt: number; photoCount: number;
}

const rfiJson = (method: string, url: string, body?: unknown) =>
  fetchWithRetry(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

export const getRfis = async (projectId: string): Promise<RfiListItem[]> => {
  const res = await fetchWithRetry(`/api/projects/${projectId}/rfis`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const getRfi = async (id: string): Promise<Rfi> => {
  const res = await fetchWithRetry(`/api/rfis/${id}`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const createRfi = async (projectId: string, input: { title: string; question?: string }): Promise<{ id: string; number: number }> => {
  const res = await rfiJson('POST', `/api/projects/${projectId}/rfis`, input);
  await handleResponse(res); return res.json();
};
export const saveRfi = async (id: string, rfi: Rfi): Promise<{ version: number }> => {
  const res = await rfiJson('PUT', `/api/rfis/${id}`, rfi);
  if (res.status === 409) throw new ConflictError(id);
  await handleResponse(res); return res.json();
};
export const setRfiStatus = async (id: string, status: string): Promise<void> => {
  const res = await rfiJson('PATCH', `/api/rfis/${id}`, { status }); await handleResponse(res);
};
export const deleteRfi = async (id: string): Promise<void> => {
  const res = await rfiJson('DELETE', `/api/rfis/${id}`); await handleResponse(res);
};
export const addRfiPhoto = async (rfiId: string, fileId: string): Promise<void> => {
  const res = await rfiJson('POST', `/api/rfis/${rfiId}/photos`, { fileId }); await handleResponse(res);
};
export const removeRfiPhoto = async (rfiId: string, fileId: string): Promise<void> => {
  const res = await rfiJson('DELETE', `/api/rfis/${rfiId}/photos/${encodeURIComponent(fileId)}`); await handleResponse(res);
};
export const setRfiResponse = async (id: string, input: { fileId?: string; text?: string }): Promise<void> => {
  const res = await rfiJson('POST', `/api/rfis/${id}/response`, input); await handleResponse(res);
};
export const sendRfi = async (id: string, payload: { to: string; cc?: string; bcc?: string; subject?: string; body?: string; fileId: string; attachmentFileIds?: string[]; message?: string }): Promise<void> => {
  const res = await rfiJson('POST', `/api/rfis/${id}/send`, payload); await handleResponse(res);
};

export const sendPunchReport = async (projectId: string, payload: { to: string; cc?: string; bcc?: string; subject?: string; body?: string; fileId: string; attachmentFileIds?: string[] }): Promise<void> => {
  const res = await punchJson('POST', `/api/projects/${projectId}/send-punch`, payload); await handleResponse(res);
};

// ── Phase 4c: punch list ──────────────────────────────────────────────────────

export interface PunchPhoto { id: string; fileId: string; stage: string; sortOrder: number; }
export interface PunchItem {
  id: string; projectId: string; area: string; description: string;
  done: number; sortOrder: number; version: number; createdAt: number;
  photos: PunchPhoto[];
}
export interface PunchListItem {
  id: string; projectId: string; area: string; description: string;
  done: number; sortOrder: number; version: number; createdAt: number;
  photoCount: number;
}

const punchJson = (method: string, url: string, body?: unknown) =>
  fetchWithRetry(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

export const getPunchItems = async (projectId: string): Promise<PunchListItem[]> => {
  const res = await fetchWithRetry(`/api/projects/${projectId}/punch`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const getPunchItem = async (id: string): Promise<PunchItem> => {
  const res = await fetchWithRetry(`/api/punch/${id}`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const createPunchItem = async (projectId: string, input: { area: string; description: string }): Promise<{ id: string }> => {
  const res = await punchJson('POST', `/api/projects/${projectId}/punch`, input);
  await handleResponse(res); return res.json();
};
export const savePunchItem = async (id: string, item: PunchItem): Promise<{ version: number }> => {
  const res = await punchJson('PUT', `/api/punch/${id}`, { area: item.area, description: item.description, version: item.version });
  if (res.status === 409) throw new ConflictError(id);
  await handleResponse(res); return res.json();
};
export const setPunchDone = async (id: string, done: boolean): Promise<void> => {
  const res = await punchJson('PATCH', `/api/punch/${id}`, { done }); await handleResponse(res);
};
export const deletePunchItem = async (id: string): Promise<void> => {
  const res = await punchJson('DELETE', `/api/punch/${id}`); await handleResponse(res);
};
export const addPunchPhoto = async (itemId: string, fileId: string, stage: string): Promise<void> => {
  const res = await punchJson('POST', `/api/punch/${itemId}/photos`, { fileId, stage }); await handleResponse(res);
};
export const removePunchPhoto = async (itemId: string, fileId: string): Promise<void> => {
  const res = await punchJson('DELETE', `/api/punch/${itemId}/photos/${encodeURIComponent(fileId)}`); await handleResponse(res);
};

// ── Phase 4c-2: task list ─────────────────────────────────────────────────────

export interface TaskPhoto { id: string; fileId: string; stage: string; sortOrder: number; }
export interface AssignableUser { id: string; username: string; role: string; }
export interface Task {
  id: string; category: string; title: string; notes: string;
  assigneeUserId: string | null; assigneeUsername: string | null;
  status: string; dueDate: string | null; sortOrder: number;
  projectId: string | null; customerId: string | null;
  projectName: string | null; customerName: string | null;
  version: number; createdAt: number; createdBy: string | null;
  photos: TaskPhoto[];
}
export interface TaskListItem {
  id: string; category: string; title: string; notes: string;
  assigneeUserId: string | null; assigneeUsername: string | null;
  status: string; dueDate: string | null; sortOrder: number;
  projectId: string | null; customerId: string | null;
  projectName: string | null; customerName: string | null;
  version: number; createdAt: number; createdBy: string | null;
  photoCount: number;
}

const taskJson = (method: string, url: string, body?: unknown) =>
  fetchWithRetry(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

export const getAssignableUsers = async (): Promise<AssignableUser[]> => {
  const res = await fetchWithRetry('/api/users/list', { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const getTasks = async (params?: { projectId?: string; customerId?: string; assigneeUserId?: string }): Promise<TaskListItem[]> => {
  const qs = new URLSearchParams();
  if (params?.projectId) qs.set('projectId', params.projectId);
  if (params?.customerId) qs.set('customerId', params.customerId);
  if (params?.assigneeUserId) qs.set('assigneeUserId', params.assigneeUserId);
  const url = qs.toString() ? `/api/tasks?${qs.toString()}` : '/api/tasks';
  const res = await fetchWithRetry(url, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const getTask = async (id: string): Promise<Task> => {
  const res = await fetchWithRetry(`/api/tasks/${id}`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const createTask = async (input: { category?: string; title: string; assigneeUserId?: string | null; dueDate?: string | null; notes?: string; projectId?: string | null; customerId?: string | null }): Promise<{ id: string }> => {
  const res = await taskJson('POST', '/api/tasks', input);
  await handleResponse(res); return res.json();
};
export const saveTask = async (id: string, task: Task): Promise<{ version: number }> => {
  const res = await taskJson('PUT', `/api/tasks/${id}`, {
    category: task.category,
    title: task.title,
    notes: task.notes,
    assigneeUserId: task.assigneeUserId,
    dueDate: task.dueDate,
    projectId: task.projectId,
    customerId: task.customerId,
    version: task.version,
  });
  if (res.status === 409) throw new ConflictError(id);
  await handleResponse(res); return res.json();
};
export const setTaskStatus = async (id: string, status: string): Promise<void> => {
  const res = await taskJson('PATCH', `/api/tasks/${id}`, { status }); await handleResponse(res);
};
export const deleteTask = async (id: string): Promise<void> => {
  const res = await taskJson('DELETE', `/api/tasks/${id}`); await handleResponse(res);
};
export const addTaskPhoto = async (taskId: string, fileId: string, stage: string): Promise<void> => {
  const res = await taskJson('POST', `/api/tasks/${taskId}/photos`, { fileId, stage }); await handleResponse(res);
};
export const removeTaskPhoto = async (taskId: string, fileId: string): Promise<void> => {
  const res = await taskJson('DELETE', `/api/tasks/${taskId}/photos/${encodeURIComponent(fileId)}`); await handleResponse(res);
};

// ── Phase 7: AIA progress billing (G702/G703 — Schedule of Values) ─────────────
// Money is INTEGER CENTS end-to-end; formatting/division happens in the UI.

export interface AiaSovLine {
  id: string; projectId: string; itemNo: string | null; description: string;
  scheduledValueCents: number; retainagePercent: number | null;
  isChangeOrder: number; changeOrderId: string | null;
  sortOrder: number; version: number; createdAt: number;
}
export interface AiaPayApp {
  id: string; projectId: string; number: number;
  periodTo: string | null; applicationDate: string | null;
  retainagePercent: number; storedRetainagePercent: number;
  releasedRetainagePoints: number;
  status: string; version: number; createdAt: number;
}
// getPayApps list row: adds Amount = G702 L8 (live for drafts, as-billed for
// finalized apps); Balance = Amount − payments, null for drafts (not yet
// billed — the UI renders "—"). Mirrors the Invoice/InvoiceListItem split.
export interface AiaPayAppListItem extends AiaPayApp {
  totalCents: number; paidCents: number; balanceCents: number | null;
}
// getPayApp's `app` — carries the payments recorded against this app. Same
// row shape as Invoice['payments'] (id/date/amount/method/note).
export type AiaPayAppDetail = AiaPayApp & { payments: Payment[] };
export interface AiaPayAppLine {
  id: string; payAppId: string; sovLineId: string;
  percentComplete: number; storedMaterialsCents: number; createdAt: number;
}
// Mirrors server/aiaStore.ts G703Row.
export interface AiaG703Row {
  sovLineId: string; itemNo: string | null; description: string;
  isChangeOrder: number; scheduledValueCents: number;
  previousCents: number; thisPeriodCents: number; storedCents: number;
  totalToDateCents: number; percentComplete: number;
  balanceToFinishCents: number; retainageCents: number;
}
// Mirrors server/aiaStore.ts G702.
export interface AiaG702 {
  L1originalContractCents: number;
  L2changeOrdersCents: number;
  L3contractSumToDateCents: number;
  L4totalCompletedStoredCents: number;
  L5aRetainageWorkCents: number;
  L5bRetainageStoredCents: number;
  L5retainageCents: number;
  L6earnedLessRetainageCents: number;
  L7lessPreviousCents: number;
  L8currentPaymentDueCents: number;
  L9balanceToFinishCents: number;
  changeOrders: { additionsCents: number; deductionsCents: number; netCents: number };
  // Mirrors server/aiaStore.ts G702['retainage'] — the effective-rate release
  // summary (Task 1). effectiveWorkPercent is null in perLine mode because a
  // single number can't represent per-line rates.
  retainage: {
    mode: 'uniform' | 'perLine';
    baseWorkPercent: number;
    cumulativeReleasedPoints: number;
    releasedThisApp: number;
    remainingPoints: number;
    effectiveWorkPercent: number | null;
  };
}
export interface AiaSettings {
  billingMode?: string; retainagePercent?: number; storedRetainagePercent?: number;
  retainageMode?: 'uniform' | 'perLine';
  ownerName?: string; ownerAddress?: string;
  architectName?: string; architectAddress?: string;
  contractDate?: string; ownerProjectNumber?: string; architectProjectNumber?: string;
  contractFor?: string;
}

// Legacy projects never wrote `retainageMode`. Mirrors the server-side
// inference: an explicit mode always wins; when absent, a stored per-line
// rate on any SOV line means the project was already using per-line
// retainage, so keep showing it that way until someone touches settings.
export const resolveRetainageMode = (
  mode: AiaSettings['retainageMode'] | undefined,
  lines: Pick<AiaSovLine, 'retainagePercent'>[],
): 'uniform' | 'perLine' =>
  mode ?? (lines.some(l => l.retainagePercent != null) ? 'perLine' : 'uniform');

const aiaJson = (method: string, url: string, body?: unknown) =>
  fetchWithRetry(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

// Schedule of Values
export const getSov = async (projectId: string): Promise<AiaSovLine[]> => {
  const res = await fetchWithRetry(`/api/projects/${projectId}/aia/sov`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const createSovLine = async (projectId: string, input: { itemNo?: string | null; description: string; scheduledValueCents: number; retainagePercent?: number | null }): Promise<{ id: string }> => {
  const res = await aiaJson('POST', `/api/projects/${projectId}/aia/sov`, input);
  await handleResponse(res); return res.json();
};
export const saveSovLine = async (id: string, line: AiaSovLine): Promise<{ version: number }> => {
  const res = await aiaJson('PUT', `/api/aia/sov/${id}`, {
    itemNo: line.itemNo, description: line.description,
    scheduledValueCents: line.scheduledValueCents, retainagePercent: line.retainagePercent,
    version: line.version,
  });
  if (res.status === 409) throw new ConflictError(id);
  await handleResponse(res); return res.json();
};
export const deleteSovLine = async (id: string): Promise<void> => {
  const res = await aiaJson('DELETE', `/api/aia/sov/${id}`); await handleResponse(res);
};
export const seedSov = async (projectId: string, lines: { description: string; scheduledValueCents: number; itemNo?: string }[]): Promise<{ count: number }> => {
  const res = await aiaJson('POST', `/api/projects/${projectId}/aia/sov/seed`, { lines });
  await handleResponse(res); return res.json();
};
export const syncChangeOrders = async (projectId: string): Promise<{ added: number }> => {
  const res = await aiaJson('POST', `/api/projects/${projectId}/aia/sov/sync-change-orders`);
  await handleResponse(res); return res.json();
};

// Pay applications
export const getPayApps = async (projectId: string): Promise<AiaPayAppListItem[]> => {
  const res = await fetchWithRetry(`/api/projects/${projectId}/aia/pay-apps`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const createPayApp = async (projectId: string, input: { periodTo?: string; applicationDate?: string; retainagePercent?: number; storedRetainagePercent?: number }): Promise<{ id: string; number: number }> => {
  const res = await aiaJson('POST', `/api/projects/${projectId}/aia/pay-apps`, input);
  await handleResponse(res); return res.json();
};
export const getPayApp = async (id: string): Promise<{ app: AiaPayAppDetail; lines: AiaPayAppLine[]; g703: AiaG703Row[]; g702: AiaG702 }> => {
  const res = await fetchWithRetry(`/api/aia/pay-apps/${id}`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const savePayAppLines = async (payAppId: string, lines: { sovLineId: string; percentComplete: number; storedMaterialsCents: number }[], version: number): Promise<{ version: number }> => {
  const res = await aiaJson('PUT', `/api/aia/pay-apps/${payAppId}/lines`, { lines, version });
  if (res.status === 409) throw new ConflictError(payAppId);
  await handleResponse(res); return res.json();
};
export const setPayApp = async (id: string, patch: Partial<{ periodTo: string | null; applicationDate: string | null; status: string; retainagePercent: number; storedRetainagePercent: number; releasedRetainagePoints: number }>): Promise<{ version: number }> => {
  const res = await aiaJson('PATCH', `/api/aia/pay-apps/${id}`, patch);
  await handleResponse(res); return res.json();
};
export const deletePayApp = async (id: string): Promise<void> => {
  const res = await aiaJson('DELETE', `/api/aia/pay-apps/${id}`); await handleResponse(res);
};

// Settings
export const getAiaSettings = async (projectId: string): Promise<AiaSettings> => {
  const res = await fetchWithRetry(`/api/projects/${projectId}/aia/settings`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const saveAiaSettings = async (projectId: string, settings: AiaSettings): Promise<void> => {
  const res = await aiaJson('PUT', `/api/projects/${projectId}/aia/settings`, settings);
  await handleResponse(res);
};

// ── Per-user always-CC helper ─────────────────────────────────────────────────
// Reads the `emailAlwaysCc` pref (a plain string, comma/semicolon-separated).
// Async because getUserPreferences() fetches from the server; there is no
// synchronous pref cache in this module.
export const getAlwaysCc = async (): Promise<string> => {
  try {
    const prefs = await getUserPreferences();
    return prefs['emailAlwaysCc'] ?? '';
  } catch {
    return '';
  }
};

// ── Customers ────────────────────────────────────────────────────────────────

export interface CustomerProjectCounts {
  bidding: number;
  inProgress: number;
  archived: number;
}

// Sidebar row shape for the customers split view. Server-derived (see
// server/customerStore.ts customerSummaries).
export interface CustomerSummary {
  id: string;
  name: string;
  contactName: string | null;
  phone: string | null;
  projectCounts: CustomerProjectCounts;
  openTaskCount: number;
  overdueTaskCount: number;
  // Admin-only (billing is gated server-side) — absent (not zero/null) for
  // non-admins.
  outstandingCents?: number;
}

export interface CustomerOverviewProject {
  id: string;
  name: string;
  status: string; // already normalizeProjectStatus()'d server-side
  archived: boolean;
  lostBid: boolean;
  bidDueDate: number | null;
  updatedAt: number | null;
  // Admin-only — absent for non-admins.
  outstandingCents?: number;
}

export interface CustomerBillingLedgerEntry {
  projectId: string;
  projectName: string;
  kind: 'invoice' | 'payapp';
  number: string | number;
  date: string | number | null;
  status: string;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
}

export interface CustomerBilling {
  contractTotalCents: number;
  invoicedCents: number;
  paidCents: number;
  outstandingCents: number;
  ledger: CustomerBillingLedgerEntry[];
  contract: { billedCents: number; paidCents: number; outstandingCents: number };
  invoices: { invoicedCents: number; paidCents: number; outstandingCents: number };
}

export type CustomerAttentionItem =
  | { type: 'overdue_task'; label: string; projectId?: string; taskId: string; date: string }
  | { type: 'bid_due'; label: string; projectId: string; date: number; overdue?: true }
  | { type: 'outstanding_invoice'; label: string; projectId: string; date?: string | number; ageDays?: number; balanceCents: number };

export interface CustomerOverview {
  customer: Customer;
  projects: CustomerOverviewProject[];
  // Admin-only — key is entirely absent (not null) for non-admins.
  billing?: CustomerBilling;
  attention: CustomerAttentionItem[];
  taskCounts: { open: number; overdue: number };
}

export const getCustomersSummary = async (): Promise<CustomerSummary[]> => {
  const res = await fetchWithRetry('/api/customers/summary', { headers: { ...getAuthHeaders() } });
  await handleResponse(res);
  return await res.json();
};

export const getCustomerOverview = async (id: string): Promise<CustomerOverview> => {
  const res = await fetchWithRetry(`/api/customers/${id}/overview`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res);
  return await res.json();
};

export const getCustomers = async (): Promise<Customer[]> => (await fetch('/api/customers', { headers: getAuthHeaders() })).json();
export const getCustomer = async (id: string): Promise<Customer> => (await fetch('/api/customers/' + id, { headers: getAuthHeaders() })).json();
export const saveCustomer = async (c: any) => {
  const res = await fetch(c.id ? '/api/customers/' + c.id : '/api/customers', {
    method: c.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }, body: JSON.stringify(c),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'save failed');
  return res.json();
};
export const deleteCustomer = async (id: string) => {
  const res = await fetch('/api/customers/' + id, { method: 'DELETE', headers: getAuthHeaders() });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'delete failed');
};
export const mergeCustomers = async (targetId: string, sourceIds: string[]) => {
  const res = await fetch('/api/customers/merge', { method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }, body: JSON.stringify({ targetId, sourceIds }) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'merge failed');
};

// Derive a Schedule of Values seed from the project's estimate (takeoffs grouped
// by price package). Cost is in DOLLARS from calculateTakeoffTotalCost; converted
// to integer cents here. Groups with zero total cost are skipped.
export const computeSovSeedFromEstimate = (project: Project): { description: string; scheduledValueCents: number }[] => {
  const currentPageIds = new Set(project.pages.map(p => p.id));
  const totals = computeTakeoffTotals(project, currentPageIds);

  const groups = new Map<string, number>(); // package -> dollars
  for (const takeoff of totals) {
    const pkg = takeoff.pricePackage && takeoff.pricePackage.trim() ? takeoff.pricePackage : 'Uncategorized';
    const cost = calculateTakeoffTotalCost(takeoff, takeoff.totalRealValue);
    groups.set(pkg, (groups.get(pkg) ?? 0) + cost);
  }

  return Array.from(groups.entries())
    .map(([description, dollars]) => ({ description, scheduledValueCents: Math.round(dollars * 100) }))
    .filter(g => g.scheduledValueCents > 0)
    .sort((a, b) => a.description.localeCompare(b.description));
};
