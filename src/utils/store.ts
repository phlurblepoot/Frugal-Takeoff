import { Project, TakeoffTemplate, SmtpSettings, ProjectNote } from '../types';

export const getAuthHeaders = () => {
  const token = localStorage.getItem('token');
  return token ? { 'Authorization': `Bearer ${token}` } : {};
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
  return await res.json();
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

export const saveImage = async (id: string, dataUrl: string): Promise<void> => {
  // Per-page images can be several MB, so allow a longer timeout than the
  // default for callers on slow connections.
  const res = await fetchWithRetry('/api/images', {
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

// Streams a Blob/File to the server without going through a base64 dataUrl,
// avoiding the ~4× in-browser memory blowup that base64 + JSON.stringify
// produce for large PDFs (which can OOM Chrome on plan-set uploads). The
// server base64-encodes once before storing so the file appears in the same
// images table and the existing /api/images/:id/raw read path works unchanged.
export const saveBinaryFile = async (id: string, blob: Blob): Promise<void> => {
  const headers: Record<string, string> = {
    'Content-Type': blob.type || 'application/octet-stream',
    ...getAuthHeaders(),
  };
  const res = await fetchWithRetry(`/api/files/${encodeURIComponent(id)}`, {
    method: 'POST',
    headers,
    body: blob,
  }, { timeoutMs: 300_000 });
  await handleResponse(res);
};
export const deleteFile = async (id: string): Promise<void> => {
  // Image deletion is handled by project deletion in this simple version
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

export const getActivePages = async (): Promise<string[]> => {
  try {
    const res = await fetch('/api/pages/active', { headers: getAuthHeaders() });
    if (!res.ok) {
      console.error(`Active pages fetch failed with status: ${res.status}`);
      const text = await res.text();
      console.error('Response body:', text.substring(0, 100));
      throw new Error(`Request failed with status ${res.status}`);
    }
    return await res.json();
  } catch (error) {
    console.error('Network error or server crash in getActivePages:', error);
    throw error;
  }
};

// Email / SMTP functions
export const getSmtpSettings = async (): Promise<Partial<SmtpSettings>> => {
  const res = await fetch('/api/email/smtp', { headers: getAuthHeaders() });
  await handleResponse(res);
  return await res.json();
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

export const sendProjectProposal = async (projectId: string, fileId: string, message?: string): Promise<Project> => {
  const res = await fetch(`/api/projects/${projectId}/send-proposal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ fileId, message }),
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

export const getChecklists = async (): Promise<any[]> => {
  const res = await fetch('/api/checklists', { headers: getAuthHeaders() });
  await handleResponse(res);
  return res.json();
};

export const saveChecklist = async (checklist: any): Promise<void> => {
  const res = await fetch(`/api/checklists/${checklist.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(checklist),
  });
  await handleResponse(res);
};

export const deleteChecklist = async (id: string): Promise<void> => {
  const res = await fetch(`/api/checklists/${id}`, {
    method: 'DELETE',
    headers: getAuthHeaders(),
  });
  await handleResponse(res);
};

// ── Phase 3a: summaries, granular patches, activity, time ────────────────────

export interface ProjectSummary {
  id: string;
  name: string;
  status: string;
  contractor: string | null;
  address: string | null;
  bidDueDate: number | null;
  version: number;
  createdAt: number;
  updatedAt: number | null;
  archived: boolean;
  pageCount: number;
  takeoffCount: number;
  pageIds: string[];
  contractValueCents: number;
  invoiceCount: number;
}

export interface ProjectPatch {
  version: number;
  name?: string;
  status?: string;
  archived?: boolean;
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

export const getProjectFiles = async (projectId: string): Promise<ProjectFile[]> => {
  const res = await fetchWithRetry(`/api/projects/${encodeURIComponent(projectId)}/files`, {
    headers: { ...getAuthHeaders() },
  });
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

// Upload a new project document. Returns the generated file id.
export const uploadProjectFile = async (
  projectId: string,
  file: File,
  kind: string
): Promise<string> => {
  const id = crypto.randomUUID();
  const qs = `projectId=${encodeURIComponent(projectId)}&kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(file.name)}`;
  const res = await fetchWithRetry(`/api/files/${id}?${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream', ...getAuthHeaders() },
    body: file,
  }, { timeoutMs: 300_000 });
  await handleResponse(res);
  return id;
};

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

// ── Phase 4a: billing ────────────────────────────────────────────────────────

export interface InvoiceLine {
  id?: string;
  description: string;
  qty: number;
  unitPrice: number;
}
export interface Payment {
  id: string;
  date: number | null;
  amount: number;
  method: string | null;
  note: string | null;
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
export interface ChangeOrder {
  id: string; projectId: string; number: string | null; description: string | null;
  amount: number; status: string; createdAt: number; // pending | approved | rejected
}
export interface BillingSummary {
  baseContractCents: number; approvedChangeCents: number; contractValueCents: number;
  invoicedCents: number; paidCents: number; outstandingCents: number;
  invoiceCount: number; changeOrderCount: number;
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
export const recordPayment = async (invoiceId: string, p: { amount: number; date?: number; method?: string; note?: string }): Promise<{ id: string }> => {
  const res = await billingJson('POST', `/api/invoices/${invoiceId}/payments`, p);
  await handleResponse(res); return res.json();
};
export const deletePayment = async (id: string): Promise<void> => {
  const res = await billingJson('DELETE', `/api/payments/${id}`); await handleResponse(res);
};
export const getChangeOrders = async (projectId: string): Promise<ChangeOrder[]> => {
  const res = await fetchWithRetry(`/api/projects/${projectId}/change-orders`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
export const createChangeOrder = async (projectId: string, co: { number?: string; description?: string; amount: number }): Promise<{ id: string }> => {
  const res = await billingJson('POST', `/api/projects/${projectId}/change-orders`, co);
  await handleResponse(res); return res.json();
};
export const setChangeOrderStatus = async (id: string, status: string): Promise<void> => {
  const res = await billingJson('PATCH', `/api/change-orders/${id}`, { status }); await handleResponse(res);
};
export const deleteChangeOrder = async (id: string): Promise<void> => {
  const res = await billingJson('DELETE', `/api/change-orders/${id}`); await handleResponse(res);
};
export const getBillingSummary = async (projectId: string): Promise<BillingSummary> => {
  const res = await fetchWithRetry(`/api/projects/${projectId}/billing-summary`, { headers: { ...getAuthHeaders() } });
  await handleResponse(res); return res.json();
};
