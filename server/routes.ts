// server/routes.ts
import express from 'express';
import fsSync from 'fs';
import nodemailer from 'nodemailer';
import type Database from 'better-sqlite3';
import {
  listProjects, loadProject, createProject, saveProject, deleteProject,
  listProjectSummaries, patchProject, ValidationError, ConflictError, NotFoundError,
} from './projectStore';
import { putDataUrl, putBuffer, getMeta, getDataUrlString, saveNewVersion, listVersions } from './files';
import { pathFor, statFile, deleteFileContent } from './fileStore';
import { logActivity, listActivity } from './activity';
import {
  listInvoices, getInvoice, createInvoice, saveInvoice, deleteInvoice,
  recordPayment, deletePayment, listProjectPayments, setInvoiceStatus,
  listChangeOrders, getChangeOrder, createChangeOrder, saveChangeOrder, setChangeOrderStatus, deleteChangeOrder,
  addChangeOrderPhoto, removeChangeOrderPhoto,
  billingSummary,
  ValidationError as BillingValidationError, ConflictError as BillingConflictError, NotFoundError as BillingNotFoundError,
} from './billingStore';
import {
  listIssues, getIssue, createIssue, saveIssue, setIssueStatus, deleteIssue,
  addPhoto, removePhoto, markIssueSent,
  ValidationError as IssueValidationError, ConflictError as IssueConflictError, NotFoundError as IssueNotFoundError,
} from './issueStore';
import {
  getPunchItem, listPunchItems, createPunchItem, savePunchItem,
  setPunchDone, deletePunchItem, addPunchPhoto, removePunchPhoto,
  ValidationError as PunchValidationError,
  ConflictError as PunchConflictError,
  NotFoundError as PunchNotFoundError,
} from './punchStore';
import {
  getTask, listTasks, createTask, saveTask, setTaskStatus, deleteTask, addTaskPhoto, removeTaskPhoto,
  ValidationError as TaskValidationError,
  ConflictError as TaskConflictError,
  NotFoundError as TaskNotFoundError,
} from './taskStore';
import {
  listSovLines, createSovLine, saveSovLine, deleteSovLine, seedSovLines, syncChangeOrders,
  listPayApps, createPayApp, getPayApp, savePayAppLines, setPayApp, deletePayApp,
  computeG703, computeG702,
  ValidationError as AiaValidationError,
  ConflictError as AiaConflictError,
  NotFoundError as AiaNotFoundError,
} from './aiaStore';

export interface RouteDeps {
  db: Database.Database;
  dataDir: string;
  dbFile: string;
  authenticateToken: express.RequestHandler;
  requireAdmin: express.RequestHandler;
  // Verifies a JWT from a query parameter (for streaming URLs that can't set
  // headers). Returns the decoded user or null.
  verifyToken: (token: string) => unknown | null;
}

export function registerDataRoutes(app: express.Express, deps: RouteDeps): void {
  const { db, dataDir, dbFile, authenticateToken, requireAdmin, verifyToken } = deps;

  // ── Projects ──────────────────────────────────────────────────────────────

  app.get('/api/projects', authenticateToken, (_req, res) => {
    try {
      res.json(listProjects(db));
    } catch (e) {
      console.error('Error fetching projects:', e);
      res.status(500).json({ error: 'Failed to fetch projects' });
    }
  });

  // NOTE: must be registered before '/api/projects/:id' or Express matches
  // 'summary' as a project id.
  app.get('/api/projects/summary', authenticateToken, (req, res) => {
    try {
      const isAdmin = (req as any).user?.role === 'admin';
      res.json(listProjectSummaries(db, undefined, isAdmin));
    } catch (e) {
      console.error('Error fetching project summaries:', e);
      res.status(500).json({ error: 'Failed to fetch project summaries' });
    }
  });

  app.get('/api/projects/:id/summary', authenticateToken, (req, res) => {
    try {
      const isAdmin = (req as any).user?.role === 'admin';
      const row = listProjectSummaries(db, req.params.id, isAdmin)[0];
      if (!row) return res.status(404).json({ error: 'Project not found' });
      res.json(row);
    } catch (e) {
      console.error('Error fetching project summary:', e);
      res.status(500).json({ error: 'Failed to fetch project summary' });
    }
  });

  app.get('/api/projects/:id', authenticateToken, (req, res) => {
    try {
      const project = loadProject(db, req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      res.json(project);
    } catch (e) {
      console.error('Error fetching project:', e);
      res.status(500).json({ error: 'Failed to fetch project' });
    }
  });

  app.post('/api/projects', authenticateToken, (req, res) => {
    try {
      const result = createProject(db, req.body);
      logActivity(db, {
        projectId: req.body?.id, userId: (req as any).user?.id,
        type: 'project_created', message: `Project "${req.body?.name ?? 'Untitled'}" created`,
      });
      res.json({ success: true, version: result.version });
    } catch (e) {
      if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
      console.error('Error creating project:', e);
      res.status(500).json({ error: 'Failed to create project' });
    }
  });

  app.put('/api/projects/:id', authenticateToken, (req, res) => {
    try {
      const result = saveProject(db, req.params.id, req.body);
      res.json({ success: true, version: result.version });
    } catch (e) {
      if (e instanceof ConflictError) return res.status(409).json({ error: e.message, code: 'version_conflict' });
      if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
      console.error('Error updating project:', e);
      res.status(500).json({ error: 'Failed to update project' });
    }
  });

  app.patch('/api/projects/:id', authenticateToken, (req, res) => {
    try {
      const result = patchProject(db, req.params.id, req.body);
      if (req.body?.status !== undefined) {
        logActivity(db, {
          projectId: req.params.id, userId: (req as any).user?.id,
          type: 'status_changed', message: `Stage changed to ${req.body.status}`,
        });
      }
      res.json({ success: true, ...result });
    } catch (e) {
      if (e instanceof NotFoundError) return res.status(404).json({ error: e.message });
      if (e instanceof ConflictError) return res.status(409).json({ error: e.message, code: 'version_conflict' });
      if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
      console.error('Error patching project:', e);
      res.status(500).json({ error: 'Failed to update project' });
    }
  });

  app.delete('/api/projects/:id', authenticateToken, (req, res) => {
    try {
      const name = (db.prepare('SELECT name FROM projects WHERE id = ?').get(req.params.id) as any)?.name;
      deleteProject(db, dataDir, req.params.id);
      logActivity(db, {
        userId: (req as any).user?.id,
        type: 'project_deleted', message: `Project "${name ?? 'Untitled'}" deleted`,
      });
      res.json({ success: true });
    } catch (e) {
      console.error('Error deleting project:', e);
      res.status(500).json({ error: 'Failed to delete project' });
    }
  });

  app.get('/api/activity', authenticateToken, (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' && req.query.projectId ? req.query.projectId : undefined;
      res.json({ items: listActivity(db, Number(req.query.limit) || 30, projectId) });
    } catch (e) {
      console.error('Error fetching activity:', e);
      res.status(500).json({ error: 'Failed to fetch activity' });
    }
  });

  app.get('/api/projects/:id/storage', authenticateToken, (req, res) => {
    try {
      const project = loadProject(db, req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const { version, status, ...legacyShape } = project;
      const dataBytes = Buffer.byteLength(JSON.stringify(legacyShape), 'utf8');
      const img = db.prepare(
        'SELECT COUNT(*) as count, COALESCE(SUM(size), 0) as bytes FROM files WHERE projectId = ?'
      ).get(req.params.id) as { count: number; bytes: number };
      const noteRow = db.prepare(
        'SELECT COALESCE(SUM(length(CAST(data AS BLOB))), 0) as bytes FROM notes WHERE projectId = ?'
      ).get(req.params.id) as { bytes: number };
      res.json({
        totalBytes: dataBytes + img.bytes + noteRow.bytes,
        dataBytes,
        imageBytes: img.bytes,
        noteBytes: noteRow.bytes,
        imageCount: img.count,
      });
    } catch (e) {
      console.error('Error computing project storage:', e);
      res.status(500).json({ error: 'Failed to compute project storage' });
    }
  });

  // ── Billing (admin only, spec §4.1/§4.3) ──────────────────────────────────
  const billingErr = (e: unknown, res: express.Response) => {
    if (e instanceof BillingNotFoundError) return res.status(404).json({ error: e.message });
    if (e instanceof BillingConflictError) return res.status(409).json({ error: e.message, code: 'version_conflict' });
    if (e instanceof BillingValidationError) return res.status(400).json({ error: e.message });
    console.error('Billing error:', e);
    return res.status(500).json({ error: 'Billing operation failed' });
  };

  app.get('/api/projects/:id/invoices', authenticateToken, requireAdmin, (req, res) => {
    try { res.json(listInvoices(db, req.params.id)); } catch (e) { billingErr(e, res); }
  });
  app.post('/api/projects/:id/invoices', authenticateToken, requireAdmin, (req, res) => {
    try {
      const r = createInvoice(db, req.params.id, req.body);
      logActivity(db, { projectId: req.params.id, userId: (req as any).user?.id, type: 'invoice_created', message: `Invoice ${req.body?.number ?? ''} created` });
      res.json(r);
    } catch (e) { billingErr(e, res); }
  });
  app.get('/api/invoices/:id', authenticateToken, requireAdmin, (req, res) => {
    try { const inv = getInvoice(db, req.params.id); if (!inv) return res.status(404).json({ error: 'Invoice not found' }); res.json(inv); } catch (e) { billingErr(e, res); }
  });
  app.put('/api/invoices/:id', authenticateToken, requireAdmin, (req, res) => {
    try { res.json({ success: true, ...saveInvoice(db, req.params.id, req.body) }); } catch (e) { billingErr(e, res); }
  });
  app.patch('/api/invoices/:id', authenticateToken, requireAdmin, (req, res) => {
    try {
      if (typeof req.body?.status !== 'string') return res.status(400).json({ error: 'status is required' });
      const r = setInvoiceStatus(db, req.params.id, req.body.status);
      res.json({ success: true, ...r });
    } catch (e) { billingErr(e, res); }
  });
  app.delete('/api/invoices/:id', authenticateToken, requireAdmin, (req, res) => {
    try { deleteInvoice(db, req.params.id); res.json({ success: true }); } catch (e) { billingErr(e, res); }
  });

  app.get('/api/projects/:id/payments', authenticateToken, requireAdmin, (req, res) => {
    try { res.json(listProjectPayments(db, req.params.id)); } catch (e) { billingErr(e, res); }
  });
  app.post('/api/projects/:id/payments', authenticateToken, requireAdmin, (req, res) => {
    try {
      const r = recordPayment(db, req.body?.targetType, req.body?.targetId, req.body);
      logActivity(db, { projectId: req.params.id, userId: (req as any).user?.id, type: 'payment_recorded', message: `Payment of $${Number(req.body?.amount ?? 0).toFixed(2)} recorded` });
      res.json(r);
    } catch (e) { billingErr(e, res); }
  });
  app.delete('/api/payments/:id', authenticateToken, requireAdmin, (req, res) => {
    try { deletePayment(db, req.params.id); res.json({ success: true }); } catch (e) { billingErr(e, res); }
  });

  app.get('/api/projects/:id/change-orders', authenticateToken, requireAdmin, (req, res) => {
    try { res.json(listChangeOrders(db, req.params.id)); } catch (e) { billingErr(e, res); }
  });
  app.post('/api/projects/:id/change-orders', authenticateToken, requireAdmin, (req, res) => {
    try {
      const r = createChangeOrder(db, req.params.id, req.body);
      logActivity(db, { projectId: req.params.id, userId: (req as any).user?.id, type: 'change_order_created', message: `Change order ${req.body?.number ?? ''} created` });
      res.json(r);
    } catch (e) { billingErr(e, res); }
  });
  app.patch('/api/change-orders/:id', authenticateToken, requireAdmin, (req, res) => {
    try {
      if (typeof req.body?.status !== 'string') return res.status(400).json({ error: 'status is required' });
      const r = setChangeOrderStatus(db, req.params.id, req.body.status);
      if (req.body.status === 'approved') logActivity(db, { userId: (req as any).user?.id, type: 'change_order_approved', message: 'Change order approved' });
      res.json({ success: true, ...r });
    } catch (e) { billingErr(e, res); }
  });
  app.get('/api/change-orders/:id', authenticateToken, requireAdmin, (req, res) => {
    try { const co = getChangeOrder(db, req.params.id); if (!co) return res.status(404).json({ error: 'Change order not found' }); res.json(co); } catch (e) { billingErr(e, res); }
  });
  app.put('/api/change-orders/:id', authenticateToken, requireAdmin, (req, res) => {
    try { res.json({ success: true, ...saveChangeOrder(db, req.params.id, req.body) }); } catch (e) { billingErr(e, res); }
  });
  app.delete('/api/change-orders/:id', authenticateToken, requireAdmin, (req, res) => {
    try { deleteChangeOrder(db, req.params.id); res.json({ success: true }); } catch (e) { billingErr(e, res); }
  });
  app.post('/api/change-orders/:id/photos', authenticateToken, requireAdmin, (req, res) => {
    try {
      if (typeof req.body?.fileId !== 'string' || !req.body.fileId) return res.status(400).json({ error: 'fileId is required' });
      addChangeOrderPhoto(db, req.params.id, req.body.fileId);
      res.json({ success: true });
    } catch (e) { billingErr(e, res); }
  });
  app.delete('/api/change-orders/:id/photos/:fileId', authenticateToken, requireAdmin, (req, res) => {
    try { removeChangeOrderPhoto(db, req.params.id, req.params.fileId); res.json({ success: true }); } catch (e) { billingErr(e, res); }
  });

  app.get('/api/projects/:id/billing-summary', authenticateToken, requireAdmin, (req, res) => {
    try { res.json(billingSummary(db, req.params.id)); } catch (e) { billingErr(e, res); }
  });

  // ── AIA progress billing — G702/G703 (admin-only, like billing) ───────────
  const aiaErr = (e: unknown, res: express.Response) => {
    if (e instanceof AiaNotFoundError) return res.status(404).json({ error: e.message });
    if (e instanceof AiaConflictError) return res.status(409).json({ error: e.message, code: 'version_conflict' });
    if (e instanceof AiaValidationError) return res.status(400).json({ error: e.message });
    console.error('AIA route error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  };

  // Schedule of Values
  app.get('/api/projects/:id/aia/sov', authenticateToken, requireAdmin, (req, res) => {
    try { res.json(listSovLines(db, req.params.id)); } catch (e) { aiaErr(e, res); }
  });
  app.post('/api/projects/:id/aia/sov', authenticateToken, requireAdmin, (req, res) => {
    try { res.json(createSovLine(db, req.params.id, req.body)); } catch (e) { aiaErr(e, res); }
  });
  app.put('/api/aia/sov/:lineId', authenticateToken, requireAdmin, (req, res) => {
    try { res.json({ success: true, ...saveSovLine(db, req.params.lineId, req.body) }); } catch (e) { aiaErr(e, res); }
  });
  app.delete('/api/aia/sov/:lineId', authenticateToken, requireAdmin, (req, res) => {
    try { deleteSovLine(db, req.params.lineId); res.json({ success: true }); } catch (e) { aiaErr(e, res); }
  });
  app.post('/api/projects/:id/aia/sov/seed', authenticateToken, requireAdmin, (req, res) => {
    try { res.json(seedSovLines(db, req.params.id, req.body?.lines)); } catch (e) { aiaErr(e, res); }
  });
  app.post('/api/projects/:id/aia/sov/sync-change-orders', authenticateToken, requireAdmin, (req, res) => {
    try { res.json(syncChangeOrders(db, req.params.id)); } catch (e) { aiaErr(e, res); }
  });

  // Pay applications (G702/G703)
  app.get('/api/projects/:id/aia/pay-apps', authenticateToken, requireAdmin, (req, res) => {
    try { res.json(listPayApps(db, req.params.id)); } catch (e) { aiaErr(e, res); }
  });
  app.post('/api/projects/:id/aia/pay-apps', authenticateToken, requireAdmin, (req, res) => {
    try {
      // A new pay app inherits the project's retainage defaults from aiaSettings.
      // Explicit values in the request body take precedence over the settings.
      const project = loadProject(db, req.params.id);
      const settings = (project && project.aiaSettings) || {};
      const input = { ...settings, ...req.body };
      res.json(createPayApp(db, req.params.id, input));
    } catch (e) { aiaErr(e, res); }
  });
  app.get('/api/aia/pay-apps/:id', authenticateToken, requireAdmin, (req, res) => {
    try {
      const result = getPayApp(db, req.params.id);
      if (!result) return res.status(404).json({ error: 'Pay application not found' });
      const { lines, ...app } = result;
      res.json({
        app,
        lines,
        g703: computeG703(db, req.params.id),
        g702: computeG702(db, req.params.id),
      });
    } catch (e) { aiaErr(e, res); }
  });
  app.put('/api/aia/pay-apps/:id/lines', authenticateToken, requireAdmin, (req, res) => {
    try { res.json({ success: true, ...savePayAppLines(db, req.params.id, req.body?.lines, req.body?.version) }); } catch (e) { aiaErr(e, res); }
  });
  app.patch('/api/aia/pay-apps/:id', authenticateToken, requireAdmin, (req, res) => {
    try { res.json({ success: true, ...setPayApp(db, req.params.id, req.body) }); } catch (e) { aiaErr(e, res); }
  });
  app.delete('/api/aia/pay-apps/:id', authenticateToken, requireAdmin, (req, res) => {
    try { deletePayApp(db, req.params.id); res.json({ success: true }); } catch (e) { aiaErr(e, res); }
  });

  // AIA project settings (retainage defaults, architect, etc.) — stored in
  // project meta.aiaSettings via the standard project load/save path.
  app.get('/api/projects/:id/aia/settings', authenticateToken, requireAdmin, (req, res) => {
    try {
      const project = loadProject(db, req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      res.json(project.aiaSettings ?? {});
    } catch (e) { aiaErr(e, res); }
  });
  app.put('/api/projects/:id/aia/settings', authenticateToken, requireAdmin, (req, res) => {
    try {
      const project = loadProject(db, req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      project.aiaSettings = { ...(project.aiaSettings ?? {}), ...req.body };
      saveProject(db, req.params.id, project);
      res.json(project.aiaSettings);
    } catch (e) {
      if (e instanceof ConflictError) return res.status(409).json({ error: e.message, code: 'version_conflict' });
      if (e instanceof ValidationError) return res.status(400).json({ error: e.message });
      aiaErr(e, res);
    }
  });

  // ── Issues (any authenticated user — field-created, spec §4.3) ────────────
  const issueErr = (e: unknown, res: express.Response) => {
    if (e instanceof IssueNotFoundError) return res.status(404).json({ error: e.message });
    if (e instanceof IssueConflictError) return res.status(409).json({ error: e.message, code: 'version_conflict' });
    if (e instanceof IssueValidationError) return res.status(400).json({ error: e.message });
    console.error('Issue error:', e);
    return res.status(500).json({ error: 'Issue operation failed' });
  };

  app.get('/api/projects/:id/issues', authenticateToken, (req, res) => {
    try { res.json(listIssues(db, req.params.id)); } catch (e) { issueErr(e, res); }
  });
  app.post('/api/projects/:id/issues', authenticateToken, (req, res) => {
    try {
      const r = createIssue(db, req.params.id, req.body);
      logActivity(db, { projectId: req.params.id, userId: (req as any).user?.id, type: 'issue_created', message: `Issue ISS-${String(r.number).padStart(3, '0')} opened: ${req.body?.title ?? ''}` });
      res.json(r);
    } catch (e) { issueErr(e, res); }
  });
  app.get('/api/issues/:id', authenticateToken, (req, res) => {
    try { const iss = getIssue(db, req.params.id); if (!iss) return res.status(404).json({ error: 'Issue not found' }); res.json(iss); } catch (e) { issueErr(e, res); }
  });
  app.put('/api/issues/:id', authenticateToken, (req, res) => {
    try { res.json({ success: true, ...saveIssue(db, req.params.id, req.body) }); } catch (e) { issueErr(e, res); }
  });
  app.patch('/api/issues/:id', authenticateToken, (req, res) => {
    try {
      if (typeof req.body?.status !== 'string') return res.status(400).json({ error: 'status is required' });
      const before = getIssue(db, req.params.id); // read once, before the change
      const r = setIssueStatus(db, req.params.id, req.body.status);
      if (req.body.status === 'resolved' && before) {
        logActivity(db, { projectId: before.projectId, userId: (req as any).user?.id, type: 'issue_resolved', message: `Issue ISS-${String(before.number).padStart(3, '0')} resolved` });
      }
      res.json({ success: true, ...r });
    } catch (e) { issueErr(e, res); }
  });
  app.delete('/api/issues/:id', authenticateToken, (req, res) => {
    try { deleteIssue(db, req.params.id); res.json({ success: true }); } catch (e) { issueErr(e, res); }
  });
  app.post('/api/issues/:id/photos', authenticateToken, (req, res) => {
    try {
      if (typeof req.body?.fileId !== 'string' || !req.body.fileId) return res.status(400).json({ error: 'fileId is required' });
      addPhoto(db, req.params.id, req.body.fileId);
      res.json({ success: true });
    } catch (e) { issueErr(e, res); }
  });
  app.delete('/api/issues/:id/photos/:fileId', authenticateToken, (req, res) => {
    try { removePhoto(db, req.params.id, req.params.fileId); res.json({ success: true }); } catch (e) { issueErr(e, res); }
  });

  // ── Punch & Checklists (any authenticated user — field-created, spec §4.2) ──
  const punchErr = (e: unknown, res: express.Response) => {
    if (e instanceof PunchNotFoundError) return res.status(404).json({ error: e.message });
    if (e instanceof PunchConflictError) return res.status(409).json({ error: e.message, code: 'version_conflict' });
    if (e instanceof PunchValidationError) return res.status(400).json({ error: e.message });
    console.error('Punch error:', e);
    return res.status(500).json({ error: 'Punch operation failed' });
  };

  app.get('/api/projects/:id/punch', authenticateToken, (req, res) => {
    try { res.json(listPunchItems(db, req.params.id)); } catch (e) { punchErr(e, res); }
  });
  app.post('/api/projects/:id/punch', authenticateToken, (req, res) => {
    try {
      const r = createPunchItem(db, req.params.id, req.body);
      logActivity(db, { projectId: req.params.id, userId: (req as any).user?.id, type: 'punch_created', message: `Punch item added${req.body?.area ? ` (${req.body.area})` : ''}: ${req.body?.description ?? ''}` });
      res.json(r);
    } catch (e) { punchErr(e, res); }
  });
  app.get('/api/punch/:id', authenticateToken, (req, res) => {
    try { const it = getPunchItem(db, req.params.id); if (!it) return res.status(404).json({ error: 'Punch item not found' }); res.json(it); } catch (e) { punchErr(e, res); }
  });
  app.put('/api/punch/:id', authenticateToken, (req, res) => {
    try { res.json({ success: true, ...savePunchItem(db, req.params.id, req.body) }); } catch (e) { punchErr(e, res); }
  });
  app.patch('/api/punch/:id', authenticateToken, (req, res) => {
    try {
      if (typeof req.body?.done !== 'boolean') return res.status(400).json({ error: 'done (boolean) is required' });
      const before = getPunchItem(db, req.params.id);
      const r = setPunchDone(db, req.params.id, req.body.done);
      if (req.body.done && before) {
        logActivity(db, { projectId: before.projectId, userId: (req as any).user?.id, type: 'punch_done', message: `Punch item done${before.area ? ` (${before.area})` : ''}: ${before.description ?? ''}` });
      }
      res.json({ success: true, ...r });
    } catch (e) { punchErr(e, res); }
  });
  app.delete('/api/punch/:id', authenticateToken, (req, res) => {
    try { deletePunchItem(db, req.params.id); res.json({ success: true }); } catch (e) { punchErr(e, res); }
  });
  app.post('/api/punch/:id/photos', authenticateToken, (req, res) => {
    try {
      if (typeof req.body?.fileId !== 'string' || !req.body.fileId) return res.status(400).json({ error: 'fileId is required' });
      addPunchPhoto(db, req.params.id, req.body.fileId, req.body?.stage ?? 'before');
      res.json({ success: true });
    } catch (e) { punchErr(e, res); }
  });
  app.delete('/api/punch/:id/photos/:fileId', authenticateToken, (req, res) => {
    try { removePunchPhoto(db, req.params.id, req.params.fileId); res.json({ success: true }); } catch (e) { punchErr(e, res); }
  });

  // ── Users roster (any authenticated user — for assignee pickers) ───────────
  app.get('/api/users/list', authenticateToken, (req, res) => {
    try { res.json(db.prepare('SELECT id, username, role FROM users ORDER BY username').all()); }
    catch (e) { console.error('Users list error:', e); res.status(500).json({ error: 'Failed to list users' }); }
  });

  // ── Tasks (collaborative task list — any authenticated user, Phase 4c-2) ───
  const taskErr = (e: unknown, res: express.Response) => {
    if (e instanceof TaskNotFoundError) return res.status(404).json({ error: e.message });
    if (e instanceof TaskConflictError) return res.status(409).json({ error: e.message, code: 'version_conflict' });
    if (e instanceof TaskValidationError) return res.status(400).json({ error: e.message });
    console.error('Task error:', e);
    return res.status(500).json({ error: 'Task operation failed' });
  };

  app.get('/api/tasks', authenticateToken, (req, res) => {
    try { res.json(listTasks(db)); } catch (e) { taskErr(e, res); }
  });
  app.post('/api/tasks', authenticateToken, (req, res) => {
    try { res.json(createTask(db, { ...req.body, createdBy: (req as any).user?.id ?? null })); } catch (e) { taskErr(e, res); }
  });
  app.get('/api/tasks/:id', authenticateToken, (req, res) => {
    try { const t = getTask(db, req.params.id); if (!t) return res.status(404).json({ error: 'Task not found' }); res.json(t); } catch (e) { taskErr(e, res); }
  });
  app.put('/api/tasks/:id', authenticateToken, (req, res) => {
    try { res.json({ success: true, ...saveTask(db, req.params.id, req.body) }); } catch (e) { taskErr(e, res); }
  });
  app.patch('/api/tasks/:id', authenticateToken, (req, res) => {
    try {
      if (typeof req.body?.status !== 'string') return res.status(400).json({ error: 'status is required' });
      res.json({ success: true, ...setTaskStatus(db, req.params.id, req.body.status) });
    } catch (e) { taskErr(e, res); }
  });
  app.delete('/api/tasks/:id', authenticateToken, (req, res) => {
    try { deleteTask(db, req.params.id); res.json({ success: true }); } catch (e) { taskErr(e, res); }
  });
  app.post('/api/tasks/:id/photos', authenticateToken, (req, res) => {
    try {
      if (typeof req.body?.fileId !== 'string' || !req.body.fileId) return res.status(400).json({ error: 'fileId is required' });
      addTaskPhoto(db, req.params.id, req.body.fileId, req.body?.stage ?? 'before');
      res.json({ success: true });
    } catch (e) { taskErr(e, res); }
  });
  app.delete('/api/tasks/:id/photos/:fileId', authenticateToken, (req, res) => {
    try { removeTaskPhoto(db, req.params.id, req.params.fileId); res.json({ success: true }); } catch (e) { taskErr(e, res); }
  });

  // ── Images (legacy compat) + files ────────────────────────────────────────

  app.get('/api/images/:id', authenticateToken, (req, res) => {
    try {
      const data = getDataUrlString(db, dataDir, req.params.id);
      if (data == null) return res.status(404).json({ error: 'Image not found' });
      res.json({ data });
    } catch (e) {
      res.status(500).json({ error: 'Failed to fetch image' });
    }
  });

  // Public (used in <img src> / pdf.js URLs) — kept public deliberately.
  app.get('/api/images/:id/raw', (req, res) => {
    try {
      const meta = getMeta(db, req.params.id);
      const st = statFile(dataDir, req.params.id);
      if (!meta || !st) return res.status(404).send('Image not found');
      res.set('Content-Type', meta.mime);
      res.set('Content-Length', String(st.size));
      res.set('Cache-Control', 'public, max-age=31536000');
      fsSync.createReadStream(pathFor(dataDir, req.params.id)).pipe(res);
    } catch (e) {
      res.status(500).send('Failed to fetch image');
    }
  });

  app.post('/api/images', authenticateToken, (req, res) => {
    try {
      const { id, data } = req.body;
      if (typeof id !== 'string' || !id || typeof data !== 'string' || !data) {
        return res.status(400).json({ error: 'id and data are required' });
      }
      putDataUrl(db, dataDir, id, data);
      res.json({ success: true });
    } catch (e) {
      console.error('Error saving image:', e);
      res.status(500).json({ error: 'Failed to save image' });
    }
  });

  app.post(
    '/api/files/:id',
    express.raw({ limit: '100mb', type: () => true }),
    authenticateToken,
    (req, res) => {
      try {
        const body = req.body as Buffer;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          return res.status(400).json({ error: 'Empty body' });
        }
        const mime = (req.get('Content-Type') || 'application/octet-stream').split(';')[0].trim();
        // Optional labeling so project-context uploads land attributed
        // (Phase 1 left projectId NULL on this legacy-compat endpoint).
        // Known limitation (internal single-tenant): re-POSTing an existing
        // file id with a different ?projectId relabels it. Real uploads use
        // fresh UUIDs so this only triggers on deliberate re-posts.
        const q = req.query;
        putBuffer(db, dataDir, req.params.id, body, mime, {
          projectId: typeof q.projectId === 'string' && q.projectId ? q.projectId : undefined,
          kind: typeof q.kind === 'string' && q.kind ? q.kind : undefined,
          name: typeof q.name === 'string' && q.name ? q.name : undefined,
        });
        res.json({ success: true });
      } catch (e) {
        console.error('Error saving file:', e);
        res.status(500).json({ error: 'Failed to save file' });
      }
    }
  );

  // Streaming read with HTTP Range support. Auth via Authorization header or
  // ?token= (media elements and pdf.js can't always set headers).
  app.get('/api/files/:id/content', (req, res) => {
    try {
      const header = req.headers['authorization'];
      const bearer = header && header.split(' ')[1];
      const token = bearer || String(req.query.token || '');
      if (!token || !verifyToken(token)) return res.status(401).json({ error: 'Authentication required' });

      const meta = getMeta(db, req.params.id);
      const st = statFile(dataDir, req.params.id);
      if (!meta || !st) return res.status(404).json({ error: 'File not found' });

      const filePath = pathFor(dataDir, req.params.id);
      res.set('Accept-Ranges', 'bytes');
      res.set('Content-Type', meta.mime);

      const range = req.headers.range;
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!m) return res.status(416).set('Content-Range', `bytes */${st.size}`).end();
        let start = m[1] === '' ? NaN : parseInt(m[1], 10);
        let end = m[2] === '' ? NaN : parseInt(m[2], 10);
        if (Number.isNaN(start)) { start = st.size - end; end = st.size - 1; } // suffix range
        if (Number.isNaN(end) || end >= st.size) end = st.size - 1;
        if (Number.isNaN(start) || start < 0 || start > end) {
          return res.status(416).set('Content-Range', `bytes */${st.size}`).end();
        }
        res.status(206);
        res.set('Content-Range', `bytes ${start}-${end}/${st.size}`);
        res.set('Content-Length', String(end - start + 1));
        fsSync.createReadStream(filePath, { start, end }).pipe(res);
      } else {
        res.set('Content-Length', String(st.size));
        fsSync.createReadStream(filePath).pipe(res);
      }
    } catch (e) {
      console.error('Error streaming file:', e);
      res.status(500).json({ error: 'Failed to stream file' });
    }
  });

  // Save-as-version: archive current content, overwrite live id in place.
  app.post(
    '/api/files/:id/versions',
    express.raw({ limit: '100mb', type: () => true }),
    authenticateToken,
    (req, res) => {
      try {
        const body = req.body as Buffer;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          return res.status(400).json({ error: 'Empty body' });
        }
        const target = getMeta(db, req.params.id);
        if (!target) return res.status(404).json({ error: 'File not found' });
        if (target.parentFileId) return res.status(400).json({ error: 'Cannot version a historical file row' });
        const mime = (req.get('Content-Type') || 'application/octet-stream').split(';')[0].trim();
        const result = saveNewVersion(db, dataDir, req.params.id, body, mime);
        res.json({ success: true, ...result });
      } catch (e) {
        console.error('Error saving file version:', e);
        res.status(500).json({ error: 'Failed to save file version' });
      }
    }
  );

  app.get('/api/files/:id/versions', authenticateToken, (req, res) => {
    try {
      const versions = listVersions(db, req.params.id).map(({ sha256, legacyFormat, ...slim }: any) => slim);
      if (versions.length === 0) return res.status(404).json({ error: 'File not found' });
      res.json(versions);
    } catch (e) {
      res.status(500).json({ error: 'Failed to list file versions' });
    }
  });

  app.get('/api/files/:id/meta', authenticateToken, (req, res) => {
    try {
      const meta = getMeta(db, req.params.id);
      if (!meta) return res.status(404).json({ error: 'File not found' });
      const { sha256, legacyFormat, ...slim } = meta as any;
      res.json(slim);
    } catch (e) {
      res.status(500).json({ error: 'Failed to fetch file metadata' });
    }
  });

  app.get('/api/projects/:id/files', authenticateToken, (req, res) => {
    try {
      res.json(db.prepare(`
        SELECT id, projectId, name, mime, size, kind, parentFileId, versionNumber, createdAt
        FROM files WHERE projectId = ? AND parentFileId IS NULL
        ORDER BY createdAt DESC
      `).all(req.params.id));
    } catch (e) {
      console.error('Error listing project files:', e);
      res.status(500).json({ error: 'Failed to list project files' });
    }
  });

  // ── Storage admin ─────────────────────────────────────────────────────────

  // Conservative reference walk: serialize every project aggregate plus every
  // remaining JSON blob (checklists, notes) and shares, collect every
  // string and every /api/images|files/<id> URL. A file is an orphan only if
  // its id appears nowhere.
  const collectReferencedFileIds = (): Set<string> => {
    const referenced = new Set<string>();
    const urlRe = /\/api\/(?:images|files)\/([^/"'?\s]+)/g;
    const addString = (s: string) => {
      referenced.add(s);
      let m: RegExpExecArray | null;
      urlRe.lastIndex = 0;
      while ((m = urlRe.exec(s)) !== null) {
        try { referenced.add(decodeURIComponent(m[1])); } catch { referenced.add(m[1]); }
      }
    };
    const walk = (v: any) => {
      if (v == null) return;
      if (typeof v === 'string') { addString(v); return; }
      if (Array.isArray(v)) { for (const x of v) walk(x); return; }
      if (typeof v === 'object') { for (const k in v) walk(v[k]); return; }
    };
    for (const p of listProjects(db)) walk(p);
    for (const table of ['checklists', 'notes']) {
      let rows: { data: string }[] = [];
      try { rows = db.prepare(`SELECT data FROM ${table}`).all() as { data: string }[]; } catch { continue; }
      for (const r of rows) {
        if (!r.data) continue;
        try { walk(JSON.parse(r.data)); } catch { addString(r.data); }
      }
    }
    // shares reference files directly (single-file shares) or via JSON page lists
    const shareRows = db.prepare('SELECT resourceId FROM shares').all() as { resourceId: string }[];
    for (const r of shareRows) {
      addString(r.resourceId);
      try { walk(JSON.parse(r.resourceId)); } catch { /* plain id */ }
    }
    // Files attributed to a live project are referenced by definition (e.g.
    // standalone Documents uploads whose id never appears in project JSON).
    const projectFileRows = db.prepare(
      'SELECT id FROM files WHERE projectId IS NOT NULL AND projectId IN (SELECT id FROM projects)'
    ).all() as { id: string }[];
    for (const r of projectFileRows) referenced.add(r.id);
    return referenced;
  };

  app.get('/api/storage/stats', authenticateToken, requireAdmin, (_req, res) => {
    try {
      let databaseBytes = 0;
      try { databaseBytes = fsSync.statSync(dbFile).size; } catch { /* ignore */ }
      const sumLen = (sql: string): number => {
        try { return (db.prepare(sql).get() as { bytes: number }).bytes; } catch { return 0; }
      };
      const breakdown = {
        images: sumLen('SELECT COALESCE(SUM(size), 0) as bytes FROM files'),
        projects: sumLen(`SELECT COALESCE(SUM(length(CAST(coalesce(meta,'') AS BLOB))), 0) as bytes FROM projects`)
          + sumLen(`SELECT COALESCE(SUM(length(CAST(coalesce(attrs,'') AS BLOB))), 0) as bytes FROM pages`)
          + sumLen(`SELECT COALESCE(SUM(length(CAST(points AS BLOB)) + length(CAST(coalesce(attrs,'') AS BLOB))), 0) as bytes FROM measurements`)
          + sumLen(`SELECT COALESCE(SUM(length(CAST(coalesce(attrs,'') AS BLOB))), 0) as bytes FROM takeoffs`),
        templates: sumLen('SELECT COALESCE(SUM(length(CAST(data AS BLOB))), 0) as bytes FROM templates'),
        notes: sumLen('SELECT COALESCE(SUM(length(CAST(data AS BLOB))), 0) as bytes FROM notes'),
        checklists: sumLen('SELECT COALESCE(SUM(length(CAST(data AS BLOB))), 0) as bytes FROM checklists'),
      };
      const imageCount = (db.prepare('SELECT COUNT(*) as c FROM files').get() as { c: number }).c;
      const fileBytesByProject = new Map<string, number>(
        (db.prepare('SELECT projectId, SUM(size) as bytes FROM files WHERE projectId IS NOT NULL GROUP BY projectId').all() as any[])
          .map(r => [r.projectId, r.bytes])
      );
      const projects = (db.prepare('SELECT id, name FROM projects').all() as { id: string; name: string | null }[])
        .map(r => ({ id: r.id, name: r.name || 'Untitled', totalBytes: fileBytesByProject.get(r.id) ?? 0 }))
        .sort((a, b) => b.totalBytes - a.totalBytes);
      res.json({ databaseBytes, breakdown, imageCount, projectCount: projects.length, projects });
    } catch (e) {
      console.error('Error computing storage stats:', e);
      res.status(500).json({ error: 'Failed to compute storage stats' });
    }
  });

  // Version-history rows are referenced via their parent: keep them as
  // long as the live file is referenced. Defined once and used by both
  // the GET and POST orphan handlers below.
  const isOrphan = (
    r: { id: string; parentFileId: string | null },
    referenced: Set<string>
  ) => !referenced.has(r.id) && !(r.parentFileId && referenced.has(r.parentFileId));

  app.get('/api/storage/orphans', authenticateToken, requireAdmin, (_req, res) => {
    try {
      const referenced = collectReferencedFileIds();
      const rows = db.prepare('SELECT id, size, parentFileId FROM files').all() as
        { id: string; size: number; parentFileId: string | null }[];
      let count = 0, bytes = 0;
      for (const r of rows) if (isOrphan(r, referenced)) { count++; bytes += r.size; }
      res.json({ count, bytes });
    } catch (e) {
      console.error('Error finding orphaned files:', e);
      res.status(500).json({ error: 'Failed to find orphaned files' });
    }
  });

  app.post('/api/storage/orphans/cleanup', authenticateToken, requireAdmin, (_req, res) => {
    try {
      const referenced = collectReferencedFileIds();
      const rows = db.prepare('SELECT id, size, parentFileId FROM files').all() as
        { id: string; size: number; parentFileId: string | null }[];
      const orphans = rows.filter(r => isOrphan(r, referenced));
      const bytesFreed = orphans.reduce((a, r) => a + r.size, 0);
      const tx = db.transaction(() => {
        const stmt = db.prepare('DELETE FROM files WHERE id = ?');
        for (const o of orphans) stmt.run(o.id);
      });
      tx();
      for (const o of orphans) deleteFileContent(dataDir, o.id);
      res.json({ deleted: orphans.length, bytesFreed });
    } catch (e) {
      console.error('Error cleaning up orphaned files:', e);
      res.status(500).json({ error: 'Failed to clean up orphaned files' });
    }
  });

  // ── Search (normalized) ───────────────────────────────────────────────────

  app.get('/api/search', authenticateToken, (req, res) => {
    try {
      const q = String(req.query.q || '').trim().toLowerCase();
      if (q.length < 2) return res.json({ results: [] });
      const like = `%${q}%`;
      const results: any[] = [];

      const projRows = db.prepare(`
        SELECT id, name, contractor, address FROM projects
        WHERE lower(coalesce(name,'') || ' ' || coalesce(contractor,'') || ' ' || coalesce(address,'')) LIKE ?
        LIMIT 6
      `).all(like) as any[];
      for (const p of projRows) {
        results.push({ type: 'project', id: `project:${p.id}`, title: p.name || 'Untitled', subtitle: p.contractor || p.address || '', projectId: p.id });
      }

      const pageRows = db.prepare(`
        SELECT pg.id, pg.projectId, pg.name, pg.pageNumber, pr.name as projectName
        FROM pages pg JOIN projects pr ON pr.id = pg.projectId
        WHERE lower(coalesce(pg.pageNumber,'') || ' ' || coalesce(pg.name,'') || ' ' || coalesce(pg.attrs,'')) LIKE ?
        LIMIT 12
      `).all(like) as any[];
      for (const pg of pageRows) {
        results.push({
          type: 'page',
          id: `page:${pg.projectId}:${pg.id}`,
          title: [pg.pageNumber, pg.name].filter(Boolean).join(' — ') || 'Page',
          subtitle: pg.projectName || 'Untitled',
          projectId: pg.projectId,
          pageId: pg.id,
        });
      }

      const takeoffRows = db.prepare(`
        SELECT t.id, t.projectId, t.name, pr.name as projectName
        FROM takeoffs t JOIN projects pr ON pr.id = t.projectId
        WHERE lower(coalesce(t.name,'')) LIKE ?
        LIMIT 6
      `).all(like) as any[];
      for (const t of takeoffRows) {
        results.push({ type: 'takeoff', id: `takeoff:${t.projectId}:${t.id}`, title: t.name, subtitle: t.projectName || 'Untitled', projectId: t.projectId });
      }

      res.json({ results });
    } catch (e) {
      console.error('Error running search:', e);
      res.status(500).json({ error: 'Search failed' });
    }
  });

  // ── Public share file serving (metadata share routes stay in server.ts) ──

  const sendFileById = (res: express.Response, id: string, cacheSeconds: number) => {
    const meta = getMeta(db, id);
    const st = statFile(dataDir, id);
    if (!meta || !st) return res.status(404).send('File not found');
    res.set('Content-Type', meta.mime);
    res.set('Content-Length', String(st.size));
    res.set('Cache-Control', `public, max-age=${cacheSeconds}`);
    fsSync.createReadStream(pathFor(dataDir, id)).pipe(res);
  };

  app.get('/api/share/:shareId/image/:index', (req, res) => {
    try {
      const share = db.prepare('SELECT type, resourceId FROM shares WHERE id = ?').get(req.params.shareId) as { type: string; resourceId: string } | undefined;
      if (!share || share.type !== 'pages') return res.status(404).send('Share not found');
      const pages = JSON.parse(share.resourceId) as { imageId: string }[];
      const idx = parseInt(req.params.index, 10);
      if (isNaN(idx) || idx < 0 || idx >= pages.length) return res.status(404).send('Page not found');
      sendFileById(res, pages[idx].imageId, 3600);
    } catch {
      res.status(500).send('Server error');
    }
  });

  app.get('/api/share/:shareId', (req, res) => {
    try {
      const share = db.prepare('SELECT resourceId FROM shares WHERE id = ?').get(req.params.shareId) as { resourceId: string } | undefined;
      if (!share) return res.status(404).send('Share not found');
      sendFileById(res, share.resourceId, 3600);
    } catch {
      res.status(500).send('Server error');
    }
  });

  // ── Editor drafts (per user, per file) ────────────────────────────────────

  const DRAFT_KINDS = ['pdf', 'sheet'];
  const MAX_DRAFT_BYTES = 20 * 1024 * 1024; // generous cap for big workbooks

  app.get('/api/drafts/:fileId', authenticateToken, (req, res) => {
    try {
      const row = db.prepare('SELECT kind, data, updatedAt FROM drafts WHERE userId = ? AND fileId = ?')
        .get((req as any).user.id, req.params.fileId);
      if (!row) return res.status(404).json({ error: 'No draft' });
      res.json(row);
    } catch (e) {
      res.status(500).json({ error: 'Failed to fetch draft' });
    }
  });

  app.put('/api/drafts/:fileId', authenticateToken, (req, res) => {
    try {
      const { kind, data } = req.body ?? {};
      if (!DRAFT_KINDS.includes(kind)) return res.status(400).json({ error: 'kind must be pdf or sheet' });
      if (typeof data !== 'string' || !data) return res.status(400).json({ error: 'data must be a non-empty string' });
      if (Buffer.byteLength(data, 'utf8') > MAX_DRAFT_BYTES) {
        return res.status(413).json({ error: 'Draft too large' });
      }
      db.prepare('INSERT OR REPLACE INTO drafts (userId, fileId, kind, data, updatedAt) VALUES (?, ?, ?, ?, ?)')
        .run((req as any).user.id, req.params.fileId, kind, data, Date.now());
      res.json({ success: true });
    } catch (e) {
      console.error('Error saving draft:', e);
      res.status(500).json({ error: 'Failed to save draft' });
    }
  });

  app.delete('/api/drafts/:fileId', authenticateToken, (req, res) => {
    try {
      db.prepare('DELETE FROM drafts WHERE userId = ? AND fileId = ?')
        .run((req as any).user.id, req.params.fileId);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to delete draft' });
    }
  });
}

// ── Email send routes ────────────────────────────────────────────────────────
// Extracted from server.ts so the four send routes (invoice/change-order/issue/
// proposal) and the shared sendProjectEmail helper can be exercised by tests with
// a stubbed transporter. The transporter itself is built from settings (SMTP-
// absent → null → sends become no-ops), exactly as before.

export interface EmailRouteDeps {
  db: Database.Database;
  dataDir: string;
  authenticateToken: express.RequestHandler;
  requireAdmin: express.RequestHandler;
  // Returns a ready-to-use transporter, or null when SMTP isn't configured.
  // Injectable so tests can stub the transport and inspect mailOptions.
  buildTransporter: () => nodemailer.Transporter | null;
}

// Sends one or more stored files as attachments via SMTP. Throws on
// misconfiguration/failure. cc/bcc are added only when non-blank (trimmed).
// Unreadable attachment ids are skipped silently.
export async function sendProjectEmail(
  db: Database.Database,
  dataDir: string,
  buildTransporter: () => nodemailer.Transporter | null,
  opts: {
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    text: string;
    attachments: Array<{ fileId: string; attachmentName: string }>;
    inReplyTo?: string;
  },
): Promise<void> {
  const transport = buildTransporter();
  if (!transport) throw new Error('SMTP not configured');
  const smtpRows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'smtp.%'").all() as { key: string; value: string }[];
  const smtpCfg: Record<string, string> = {};
  smtpRows.forEach(r => { smtpCfg[r.key.replace('smtp.', '')] = r.value; });
  // Build the attachment list: read each fileId's bytes; skip any that fail.
  const builtAttachments: NonNullable<nodemailer.SendMailOptions['attachments']> = [];
  for (const att of opts.attachments) {
    const dataUrl = getDataUrlString(db, dataDir, att.fileId);
    if (!dataUrl) continue; // skip unreadable attachments silently
    const base64Data = dataUrl.split(',')[1];
    const mimeType = dataUrl.split(';')[0].replace('data:', '');
    const fileBuffer = Buffer.from(base64Data, 'base64');
    builtAttachments.push({ filename: att.attachmentName, content: fileBuffer, contentType: mimeType });
  }
  const mailOptions: nodemailer.SendMailOptions = {
    from: smtpCfg.fromAddress ? `"${smtpCfg.fromName || ''}" <${smtpCfg.fromAddress}>` : undefined,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    attachments: builtAttachments,
  };
  const cc = opts.cc?.trim();
  if (cc) mailOptions.cc = cc;
  const bcc = opts.bcc?.trim();
  if (bcc) mailOptions.bcc = bcc;
  if (opts.inReplyTo) { mailOptions.inReplyTo = opts.inReplyTo; mailOptions.references = opts.inReplyTo; }
  await transport.sendMail(mailOptions);
}

// Builds the attachment list for a send route: the primary generated PDF followed
// by any caller-supplied extra files. Unresolved extra ids are skipped silently;
// each resolved id is named from its file metadata.
export function buildSendAttachments(
  db: Database.Database,
  primary: { fileId: string; attachmentName: string },
  attachmentFileIds: unknown,
): Array<{ fileId: string; attachmentName: string }> {
  const list = [primary];
  if (Array.isArray(attachmentFileIds)) {
    for (const id of attachmentFileIds) {
      if (typeof id !== 'string' || !id) continue;
      const meta = getMeta(db, id);
      if (!meta) continue; // skip unresolved ids silently
      list.push({ fileId: id, attachmentName: meta.name || 'attachment' });
    }
  }
  return list;
}

interface SendBody {
  to?: string;
  fileId: string;
  message?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  attachmentFileIds?: string[];
}

export function registerEmailRoutes(app: express.Express, deps: EmailRouteDeps): void {
  const { db, dataDir, authenticateToken, requireAdmin, buildTransporter } = deps;
  const send = (opts: Parameters<typeof sendProjectEmail>[3]) =>
    sendProjectEmail(db, dataDir, buildTransporter, opts);

  // SMTP settings (stored in settings table under smtp.* keys)
  app.get('/api/email/smtp', authenticateToken, requireAdmin, (req, res) => {
    try {
      const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'smtp.%'").all() as { key: string; value: string }[];
      const cfg: Record<string, string> = {};
      rows.forEach(r => { cfg[r.key.replace('smtp.', '')] = r.value; });
      res.json(cfg);
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch SMTP settings' });
    }
  });

  app.post('/api/email/smtp', authenticateToken, requireAdmin, (req, res) => {
    try {
      const cfg = req.body as Record<string, string>;
      const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
      Object.entries(cfg).forEach(([k, v]) => stmt.run(`smtp.${k}`, v));
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: 'Failed to save SMTP settings' });
    }
  });

  app.post('/api/email/test-smtp', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const transport = buildTransporter();
      if (!transport) return res.status(400).json({ error: 'SMTP not configured' });
      await transport.verify();
      res.json({ success: true });
    } catch (error: any) {
      res.status(400).json({ error: error.message || 'SMTP connection failed' });
    }
  });

  // Send a proposal as a reply to the email stored on a project
  app.post('/api/projects/:id/send-proposal', authenticateToken, async (req, res) => {
    try {
      const project = loadProject(db, req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      if (!project.email) return res.status(400).json({ error: 'Project has no associated email to reply to' });

      const { fileId, message, to, cc, bcc, subject: subjectIn, body, attachmentFileIds } = req.body as SendBody;
      const toAddress = (typeof to === 'string' && to.trim()) ? to.trim() : (project.email.from || '');
      if (!toAddress) return res.status(400).json({ error: "No recipient address on this project's email" });

      const subject = subjectIn?.trim() || (project.email.subject ? `Re: ${project.email.subject}` : 'Proposal');

      await send({
        to: toAddress,
        cc,
        bcc,
        subject,
        text: body ?? message ?? 'Please find the attached proposal.',
        attachments: buildSendAttachments(db, { fileId, attachmentName: 'Proposal.pdf' }, attachmentFileIds),
        inReplyTo: project.email.messageId || undefined,
      });

      logActivity(db, {
        projectId: req.params.id, userId: (req as any).user?.id,
        type: 'proposal_sent', message: `Proposal emailed for "${project.name ?? 'Untitled'}"`,
      });

      // Reload after the SMTP await so a concurrent edit during the send can't
      // make the version-checked save fail and strand a sent proposal. With no
      // await between this load and the save, nothing can interleave.
      const fresh = loadProject(db, req.params.id) ?? project;
      const updatedProject = { ...fresh, proposalFileId: fileId, proposalSentAt: Date.now() };
      saveProject(db, req.params.id, updatedProject);
      res.json(loadProject(db, req.params.id));
    } catch (error: any) {
      console.error('Error sending project proposal:', error);
      res.status(500).json({ error: error.message || 'Failed to send proposal' });
    }
  });

  // Send an invoice PDF via SMTP (admin only)
  app.post('/api/invoices/:id/send', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const inv = getInvoice(db, req.params.id);
      if (!inv) return res.status(404).json({ error: 'Invoice not found' });
      const { to, fileId, message, cc, bcc, subject, body, attachmentFileIds } = req.body as SendBody;
      if (!to || !fileId) return res.status(400).json({ error: 'to and fileId are required' });
      await send({
        to,
        cc,
        bcc,
        subject: subject?.trim() || `Invoice ${inv.number ?? ''}`.trim(),
        text: body ?? message ?? 'Please find the attached invoice.',
        attachments: buildSendAttachments(db, { fileId, attachmentName: `${inv.number || 'invoice'}.pdf` }, attachmentFileIds),
      });
      // mark sent (best effort) + log
      try { db.prepare("UPDATE invoices SET status = 'sent', version = version + 1 WHERE id = ?").run(req.params.id); } catch { /* ignore */ }
      logActivity(db, { projectId: inv.projectId, userId: (req as any).user?.id, type: 'invoice_sent', message: `Invoice ${inv.number ?? ''} emailed to ${to}` });
      res.json({ success: true });
    } catch (e: any) {
      console.error('Error sending invoice:', e);
      res.status(500).json({ error: e.message || 'Failed to send invoice' });
    }
  });

  // Send a change order request PDF via SMTP (admin only)
  app.post('/api/change-orders/:id/send', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const co = getChangeOrder(db, req.params.id);
      if (!co) return res.status(404).json({ error: 'Change order not found' });
      const { to, fileId, message, cc, bcc, subject, body, attachmentFileIds } = req.body as SendBody;
      if (!to || !fileId) return res.status(400).json({ error: 'to and fileId are required' });
      const number = co.number ?? '';
      await send({
        to,
        cc,
        bcc,
        subject: subject?.trim() || `Change Order Request ${number}`.trim(),
        text: body ?? message ?? 'Please find the attached change order request.',
        attachments: buildSendAttachments(db, { fileId, attachmentName: `CO-${number || 'change-order'}.pdf` }, attachmentFileIds),
      });
      // Mark sent (best effort) — but never override an already approved/rejected CO.
      try {
        if (co.status !== 'approved' && co.status !== 'rejected') setChangeOrderStatus(db, req.params.id, 'sent');
      } catch { /* best effort */ }
      logActivity(db, { projectId: co.projectId, userId: (req as any).user?.id, type: 'change_order_sent', message: `Change Order ${number} emailed to ${to}` });
      res.json({ success: true });
    } catch (e: any) {
      console.error('Error sending change order:', e);
      res.status(500).json({ error: e.message || 'Failed to send change order' });
    }
  });

  // Send an issue report PDF via SMTP (any authenticated user — field members send issue reports)
  app.post('/api/issues/:id/send', authenticateToken, async (req, res) => {
    try {
      const iss = getIssue(db, req.params.id);
      if (!iss) return res.status(404).json({ error: 'Issue not found' });
      const { to, fileId, message, cc, bcc, subject, body, attachmentFileIds } = req.body as SendBody;
      if (!to || !fileId) return res.status(400).json({ error: 'to and fileId are required' });
      const padded = String(iss.number).padStart(3, '0');
      await send({
        to,
        cc,
        bcc,
        subject: subject?.trim() || `Issue ISS-${padded}${iss.title ? ` — ${iss.title}` : ''}`,
        text: body ?? message ?? 'Please find the attached issue report.',
        attachments: buildSendAttachments(db, { fileId, attachmentName: `ISS-${padded}.pdf` }, attachmentFileIds),
      });
      try { markIssueSent(db, req.params.id); } catch { /* best effort */ }
      logActivity(db, { projectId: iss.projectId, userId: (req as any).user?.id, type: 'issue_sent', message: `Issue ISS-${padded} emailed to ${to}` });
      res.json({ success: true });
    } catch (e: any) {
      console.error('Error sending issue:', e);
      res.status(500).json({ error: e.message || 'Failed to send issue' });
    }
  });
}
