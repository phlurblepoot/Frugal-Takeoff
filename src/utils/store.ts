import { Project, TakeoffTemplate, Bid, EmailAccount, SmtpSettings, ProjectNote } from '../types';

export const getAuthHeaders = () => {
  const token = localStorage.getItem('token');
  return token ? { 'Authorization': `Bearer ${token}` } : {};
};

export const getImageUrl = (id: string) => {
  return `/api/images/${id}/raw`;
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

export const saveProject = async (project: Project): Promise<void> => {
  const res = await fetch('/api/projects/' + project.id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(project)
  });
  await handleResponse(res);
};

export const createProject = async (project: Project): Promise<void> => {
  const res = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(project)
  });
  await handleResponse(res);
};

export const getProject = async (id: string): Promise<Project | null> => {
  const res = await fetch('/api/projects/' + id, { headers: getAuthHeaders() });
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
  const res = await fetch('/api/images', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ id, data: dataUrl })
  });
  await handleResponse(res);
};

export const getImage = async (id: string): Promise<string | null> => {
  const res = await fetch('/api/images/' + id, { headers: getAuthHeaders() });
  if (res.status === 404) return null;
  await handleResponse(res);
  const { data } = await res.json();
  return data;
};

export const saveFile = saveImage;
export const getFile = getImage;
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

// Bid functions
export const getBids = async (): Promise<Bid[]> => {
  const res = await fetch('/api/bids', { headers: getAuthHeaders() });
  await handleResponse(res);
  return await res.json();
};

export const saveBid = async (bid: Bid): Promise<void> => {
  const res = await fetch('/api/bids', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(bid)
  });
  await handleResponse(res);
};

export const updateBid = async (bid: Bid): Promise<void> => {
  const res = await fetch('/api/bids/' + bid.id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(bid),
  });
  await handleResponse(res);
};

export const deleteBid = async (id: string): Promise<void> => {
  const res = await fetch('/api/bids/' + id, { method: 'DELETE', headers: getAuthHeaders() });
  await handleResponse(res);
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

export const getEmailAccounts = async (): Promise<EmailAccount[]> => {
  const res = await fetch('/api/email/accounts', { headers: getAuthHeaders() });
  await handleResponse(res);
  return await res.json();
};

export const createEmailAccount = async (account: Omit<EmailAccount, 'id' | 'createdAt'>): Promise<EmailAccount> => {
  const res = await fetch('/api/email/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(account),
  });
  await handleResponse(res);
  return await res.json();
};

export const updateEmailAccount = async (account: EmailAccount): Promise<EmailAccount> => {
  const res = await fetch('/api/email/accounts/' + account.id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(account),
  });
  await handleResponse(res);
  return await res.json();
};

export const deleteEmailAccount = async (id: string): Promise<void> => {
  const res = await fetch('/api/email/accounts/' + id, { method: 'DELETE', headers: getAuthHeaders() });
  await handleResponse(res);
};

export const testImapAccount = async (id: string): Promise<void> => {
  const res = await fetch('/api/email/test-imap/' + id, { method: 'POST', headers: getAuthHeaders() });
  await handleResponse(res);
};

export const pollEmailNow = async (): Promise<{ imported: number }> => {
  const res = await fetch('/api/email/poll', { method: 'POST', headers: getAuthHeaders() });
  await handleResponse(res);
  return await res.json();
};

export const importEmailAsBid = async (data: { from: string; fromName?: string; subject: string; body: string; htmlBody?: string }): Promise<Bid> => {
  const res = await fetch('/api/bids/import-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(data),
  });
  await handleResponse(res);
  return await res.json();
};

export const sendProposal = async (bidId: string, fileId: string, message?: string): Promise<Bid> => {
  const res = await fetch(`/api/bids/${bidId}/send-proposal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ fileId, message }),
  });
  await handleResponse(res);
  return await res.json();
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
