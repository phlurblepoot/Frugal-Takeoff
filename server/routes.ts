// server/routes.ts
import express from 'express';
import fsSync from 'fs';
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
  addPhoto, removePhoto,
  ValidationError as IssueValidationError, ConflictError as IssueConflictError, NotFoundError as IssueNotFoundError,
} from './issueStore';
import {
  listRfis, getRfi, createRfi, saveRfi, setRfiStatus, deleteRfi,
  addPhoto as addRfiPhoto, removePhoto as removeRfiPhoto, setRfiResponse,
  ValidationError as RfiValidationError, ConflictError as RfiConflictError, NotFoundError as RfiNotFoundError,
} from './rfiStore';
import {
  getDailyReport, listDailyReports, createDailyReport, saveDailyReport, deleteDailyReport,
  addPhoto as addDailyPhoto, removePhoto as removeDailyPhoto,
  ValidationError as DailyValidationError, ConflictError as DailyConflictError,
  NotFoundError as DailyNotFoundError, DateTakenError as DailyDateTakenError,
} from './dailyReportStore';
import { geocodeAddress, fetchDailyWeather } from './weather';
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
  listSovLines, getSovLine, createSovLine, saveSovLine, deleteSovLine, seedSovLines, syncChangeOrders,
  listPayApps, createPayApp, getPayApp, savePayAppLines, setPayApp, deletePayApp,
  computeG703, computeG702,
  ValidationError as AiaValidationError,
  ConflictError as AiaConflictError,
  NotFoundError as AiaNotFoundError,
} from './aiaStore';
import {
  listCustomers, getCustomer, saveCustomer, deleteCustomer, mergeCustomers, listProjectsForCustomer,
  customerSummaries, customerOverview,
} from './customerStore';
import { listDocuments, patchDocument, deleteDocument, DocumentFilters, findDocumentBySource, findDocumentsBySource } from './documents';
import { requestMeta, type BroadcastChange } from './realtime/changeFeed';
import type { SheetSessionStore } from './realtime/sheetSessions';
import { registerProposalRoutes, proposalErr } from './proposalRoutes';
import { getProposal, LockedError as ProposalLockedError } from './proposalStore';
import { send as mailSend, MailSendError, type SendResult } from './mail/sendService';
import { AuthExpiredError } from './mail/providers/types';
import type { MailContext } from './mail/context';
import type { ItemType } from './mail/links';
import { parseAddressList } from './mail/mime';

export interface RouteDeps {
  db: Database.Database;
  dataDir: string;
  dbFile: string;
  authenticateToken: express.RequestHandler;
  requireAdmin: express.RequestHandler;
  // Verifies a JWT from a query parameter (for streaming URLs that can't set
  // headers). Returns the decoded user or null.
  verifyToken: (token: string) => unknown | null;
  broadcastChange: BroadcastChange;
  // I6: optional so existing tests that construct RouteDeps by hand (no
  // sheet-collab wiring) keep working untouched. When present, a version-
  // replace or a file delete invalidates that fileId's persisted collab
  // session (see the call sites below) — without it, a replaced file's next
  // sheet-join would hydrate the OLD working copy over the new bytes, or a
  // deleted file's dirty row would error-loop the flush engine forever.
  sheetStore?: SheetSessionStore;
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
      deps.broadcastChange({
        type: 'project', id: req.body?.id, projectId: req.body?.id,
        version: result.version, action: 'created', ...requestMeta(req),
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
      const result = saveProject(db, req.params.id, req.body, dataDir);
      deps.broadcastChange({
        type: 'project', id: req.params.id, projectId: req.params.id,
        version: result.version, action: 'updated', ...requestMeta(req),
      });
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
      deps.broadcastChange({
        type: 'project', id: req.params.id, projectId: req.params.id,
        version: result.version, action: 'updated', ...requestMeta(req),
      });
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
      deps.broadcastChange({
        type: 'project', id: req.params.id, projectId: req.params.id,
        action: 'deleted', ...requestMeta(req),
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
      deps.broadcastChange({ type: 'invoice', id: r.id, projectId: req.params.id, version: r.version, action: 'created', ...requestMeta(req) });
      res.json(r);
    } catch (e) { billingErr(e, res); }
  });
  app.get('/api/invoices/:id', authenticateToken, requireAdmin, (req, res) => {
    try { const inv = getInvoice(db, req.params.id); if (!inv) return res.status(404).json({ error: 'Invoice not found' }); res.json(inv); } catch (e) { billingErr(e, res); }
  });
  app.put('/api/invoices/:id', authenticateToken, requireAdmin, (req, res) => {
    try {
      const result = saveInvoice(db, req.params.id, req.body);
      const row = getInvoice(db, req.params.id);
      if (row) deps.broadcastChange({ type: 'invoice', id: req.params.id, projectId: row.projectId, version: result.version, action: 'updated', ...requestMeta(req) });
      res.json({ success: true, ...result });
    } catch (e) { billingErr(e, res); }
  });
  app.patch('/api/invoices/:id', authenticateToken, requireAdmin, (req, res) => {
    try {
      if (typeof req.body?.status !== 'string') return res.status(400).json({ error: 'status is required' });
      const r = setInvoiceStatus(db, req.params.id, req.body.status);
      const row = getInvoice(db, req.params.id);
      if (row) deps.broadcastChange({ type: 'invoice', id: req.params.id, projectId: row.projectId, version: r.version, action: 'updated', ...requestMeta(req) });
      res.json({ success: true, ...r });
    } catch (e) { billingErr(e, res); }
  });
  app.delete('/api/invoices/:id', authenticateToken, requireAdmin, (req, res) => {
    try {
      const before = getInvoice(db, req.params.id);
      deleteInvoice(db, req.params.id);
      if (before) deps.broadcastChange({ type: 'invoice', id: req.params.id, projectId: before.projectId, action: 'deleted', ...requestMeta(req) });
      res.json({ success: true });
    } catch (e) { billingErr(e, res); }
  });

  app.get('/api/projects/:id/payments', authenticateToken, requireAdmin, (req, res) => {
    try { res.json(listProjectPayments(db, req.params.id)); } catch (e) { billingErr(e, res); }
  });
  app.post('/api/projects/:id/payments', authenticateToken, requireAdmin, (req, res) => {
    try {
      const r = recordPayment(db, req.body?.targetType, req.body?.targetId, req.body);
      logActivity(db, { projectId: req.params.id, userId: (req as any).user?.id, type: 'payment_recorded', message: `Payment of $${Number(req.body?.amount ?? 0).toFixed(2)} recorded` });
      deps.broadcastChange({ type: 'payment', id: r.id, projectId: req.params.id, action: 'created', ...requestMeta(req) });
      res.json(r);
    } catch (e) { billingErr(e, res); }
  });
  app.delete('/api/payments/:id', authenticateToken, requireAdmin, (req, res) => {
    try {
      // payments are polymorphic (invoice|payapp) and carry no projectId column
      // of their own; resolve it via whichever target table the payment points at.
      const before = db.prepare('SELECT targetType, targetId FROM payments WHERE id = ?').get(req.params.id) as
        { targetType: string; targetId: string } | undefined;
      deletePayment(db, req.params.id);
      if (before) {
        const table = before.targetType === 'invoice' ? 'invoices' : 'aia_pay_apps';
        const target = db.prepare(`SELECT projectId FROM ${table} WHERE id = ?`).get(before.targetId) as { projectId: string } | undefined;
        if (target) deps.broadcastChange({ type: 'payment', id: req.params.id, projectId: target.projectId, action: 'deleted', ...requestMeta(req) });
      }
      res.json({ success: true });
    } catch (e) { billingErr(e, res); }
  });

  app.get('/api/projects/:id/change-orders', authenticateToken, requireAdmin, (req, res) => {
    try { res.json(listChangeOrders(db, req.params.id)); } catch (e) { billingErr(e, res); }
  });
  app.post('/api/projects/:id/change-orders', authenticateToken, requireAdmin, (req, res) => {
    try {
      const r = createChangeOrder(db, req.params.id, req.body);
      logActivity(db, { projectId: req.params.id, userId: (req as any).user?.id, type: 'change_order_created', message: `Change order ${req.body?.number ?? ''} created` });
      deps.broadcastChange({ type: 'changeOrder', id: r.id, projectId: req.params.id, version: r.version, action: 'created', ...requestMeta(req) });
      res.json(r);
    } catch (e) { billingErr(e, res); }
  });
  app.patch('/api/change-orders/:id', authenticateToken, requireAdmin, (req, res) => {
    try {
      if (typeof req.body?.status !== 'string') return res.status(400).json({ error: 'status is required' });
      const r = setChangeOrderStatus(db, req.params.id, req.body.status);
      if (req.body.status === 'approved') logActivity(db, { userId: (req as any).user?.id, type: 'change_order_approved', message: 'Change order approved' });
      const row = getChangeOrder(db, req.params.id);
      if (row) deps.broadcastChange({ type: 'changeOrder', id: req.params.id, projectId: row.projectId, version: r.version, action: 'updated', ...requestMeta(req) });
      res.json({ success: true, ...r });
    } catch (e) { billingErr(e, res); }
  });
  app.get('/api/change-orders/:id', authenticateToken, requireAdmin, (req, res) => {
    try { const co = getChangeOrder(db, req.params.id); if (!co) return res.status(404).json({ error: 'Change order not found' }); res.json(co); } catch (e) { billingErr(e, res); }
  });
  app.put('/api/change-orders/:id', authenticateToken, requireAdmin, (req, res) => {
    try {
      const result = saveChangeOrder(db, req.params.id, req.body);
      const row = getChangeOrder(db, req.params.id);
      if (row) deps.broadcastChange({ type: 'changeOrder', id: req.params.id, projectId: row.projectId, version: result.version, action: 'updated', ...requestMeta(req) });
      res.json({ success: true, ...result });
    } catch (e) { billingErr(e, res); }
  });
  app.delete('/api/change-orders/:id', authenticateToken, requireAdmin, (req, res) => {
    try {
      const before = getChangeOrder(db, req.params.id);
      deleteChangeOrder(db, req.params.id);
      if (before) deps.broadcastChange({ type: 'changeOrder', id: req.params.id, projectId: before.projectId, action: 'deleted', ...requestMeta(req) });
      res.json({ success: true });
    } catch (e) { billingErr(e, res); }
  });
  app.post('/api/change-orders/:id/photos', authenticateToken, requireAdmin, (req, res) => {
    try {
      if (typeof req.body?.fileId !== 'string' || !req.body.fileId) return res.status(400).json({ error: 'fileId is required' });
      addChangeOrderPhoto(db, req.params.id, req.body.fileId);
      const row = getChangeOrder(db, req.params.id);
      if (row) deps.broadcastChange({ type: 'changeOrder', id: req.params.id, projectId: row.projectId, version: row.version, action: 'updated', ...requestMeta(req) });
      res.json({ success: true });
    } catch (e) { billingErr(e, res); }
  });
  app.delete('/api/change-orders/:id/photos/:fileId', authenticateToken, requireAdmin, (req, res) => {
    try {
      removeChangeOrderPhoto(db, req.params.id, req.params.fileId);
      const row = getChangeOrder(db, req.params.id);
      if (row) deps.broadcastChange({ type: 'changeOrder', id: req.params.id, projectId: row.projectId, version: row.version, action: 'updated', ...requestMeta(req) });
      res.json({ success: true });
    } catch (e) { billingErr(e, res); }
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
    try {
      const r = createSovLine(db, req.params.id, req.body);
      const row = getSovLine(db, r.id);
      deps.broadcastChange({ type: 'aiaSov', id: r.id, projectId: req.params.id, version: row?.version, action: 'created', ...requestMeta(req) });
      res.json(r);
    } catch (e) { aiaErr(e, res); }
  });
  app.put('/api/aia/sov/:lineId', authenticateToken, requireAdmin, (req, res) => {
    try {
      const result = saveSovLine(db, req.params.lineId, req.body);
      const row = getSovLine(db, req.params.lineId);
      if (row) deps.broadcastChange({ type: 'aiaSov', id: req.params.lineId, projectId: row.projectId, version: result.version, action: 'updated', ...requestMeta(req) });
      res.json({ success: true, ...result });
    } catch (e) { aiaErr(e, res); }
  });
  app.delete('/api/aia/sov/:lineId', authenticateToken, requireAdmin, (req, res) => {
    try {
      const before = getSovLine(db, req.params.lineId);
      deleteSovLine(db, req.params.lineId);
      if (before) deps.broadcastChange({ type: 'aiaSov', id: req.params.lineId, projectId: before.projectId, action: 'deleted', ...requestMeta(req) });
      res.json({ success: true });
    } catch (e) { aiaErr(e, res); }
  });
  app.post('/api/projects/:id/aia/sov/seed', authenticateToken, requireAdmin, (req, res) => {
    try {
      const r = seedSovLines(db, req.params.id, req.body?.lines);
      // Bulk replace of the estimate-derived lines — no single line id to key
      // on, so the project id itself is the broadcast subject (spec §Task2).
      deps.broadcastChange({ type: 'aiaSov', id: req.params.id, projectId: req.params.id, action: 'updated', ...requestMeta(req) });
      res.json(r);
    } catch (e) { aiaErr(e, res); }
  });
  app.post('/api/projects/:id/aia/sov/sync-change-orders', authenticateToken, requireAdmin, (req, res) => {
    try {
      const r = syncChangeOrders(db, req.params.id);
      deps.broadcastChange({ type: 'aiaSov', id: req.params.id, projectId: req.params.id, action: 'updated', ...requestMeta(req) });
      res.json(r);
    } catch (e) { aiaErr(e, res); }
  });

  // Pay applications (G702/G703)
  app.get('/api/projects/:id/aia/pay-apps', authenticateToken, requireAdmin, (req, res) => {
    try { res.json(listPayApps(db, req.params.id)); } catch (e) { aiaErr(e, res); }
  });
  app.post('/api/projects/:id/aia/pay-apps', authenticateToken, requireAdmin, (req, res) => {
    try {
      // A new pay app inherits the project's retainage defaults from aiaSettings.
      // Explicit values in the request body take precedence over the settings.
      // storedRetainagePercent is dropped from the settings-derived defaults:
      // legacy projects still carry a two-rate storedRetainagePercent, but the
      // single-rate world wants new apps to default it to retainagePercent
      // (createPayApp's own `?? retainagePercent` fallback) unless the caller
      // explicitly requests a distinct value via the request body.
      const project = loadProject(db, req.params.id);
      const { storedRetainagePercent: _legacyStoredRetainagePercent, ...settingsDefaults } = (project && project.aiaSettings) || {};
      const input = { ...settingsDefaults, ...req.body };
      const r = createPayApp(db, req.params.id, input);
      const row = getPayApp(db, r.id);
      deps.broadcastChange({ type: 'aiaPayApp', id: r.id, projectId: req.params.id, version: row?.version, action: 'created', ...requestMeta(req) });
      res.json(r);
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
    try {
      const result = savePayAppLines(db, req.params.id, req.body?.lines, req.body?.version);
      const row = getPayApp(db, req.params.id);
      if (row) deps.broadcastChange({ type: 'aiaPayApp', id: req.params.id, projectId: row.projectId, version: result.version, action: 'updated', ...requestMeta(req) });
      res.json({ success: true, ...result });
    } catch (e) { aiaErr(e, res); }
  });
  app.patch('/api/aia/pay-apps/:id', authenticateToken, requireAdmin, (req, res) => {
    try {
      const result = setPayApp(db, req.params.id, req.body);
      const row = getPayApp(db, req.params.id);
      if (row) deps.broadcastChange({ type: 'aiaPayApp', id: req.params.id, projectId: row.projectId, version: result.version, action: 'updated', ...requestMeta(req) });
      res.json({ success: true, ...result });
    } catch (e) { aiaErr(e, res); }
  });
  app.delete('/api/aia/pay-apps/:id', authenticateToken, requireAdmin, (req, res) => {
    try {
      const before = getPayApp(db, req.params.id);
      deletePayApp(db, req.params.id);
      if (before) deps.broadcastChange({ type: 'aiaPayApp', id: req.params.id, projectId: before.projectId, action: 'deleted', ...requestMeta(req) });
      res.json({ success: true });
    } catch (e) { aiaErr(e, res); }
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
      saveProject(db, req.params.id, project, dataDir);
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
      const row = getIssue(db, r.id);
      deps.broadcastChange({ type: 'issue', id: r.id, projectId: req.params.id, version: row?.version, action: 'created', ...requestMeta(req) });
      res.json(r);
    } catch (e) { issueErr(e, res); }
  });
  app.get('/api/issues/:id', authenticateToken, (req, res) => {
    try { const iss = getIssue(db, req.params.id); if (!iss) return res.status(404).json({ error: 'Issue not found' }); res.json(iss); } catch (e) { issueErr(e, res); }
  });
  app.put('/api/issues/:id', authenticateToken, (req, res) => {
    try {
      const result = saveIssue(db, req.params.id, req.body);
      const row = getIssue(db, req.params.id);
      if (row) deps.broadcastChange({
        type: 'issue', id: req.params.id, projectId: row.projectId,
        version: row.version, action: 'updated', ...requestMeta(req),
      });
      res.json({ success: true, ...result });
    } catch (e) { issueErr(e, res); }
  });
  app.patch('/api/issues/:id', authenticateToken, (req, res) => {
    try {
      if (typeof req.body?.status !== 'string') return res.status(400).json({ error: 'status is required' });
      const before = getIssue(db, req.params.id); // read once, before the change
      const r = setIssueStatus(db, req.params.id, req.body.status);
      if (req.body.status === 'resolved' && before) {
        logActivity(db, { projectId: before.projectId, userId: (req as any).user?.id, type: 'issue_resolved', message: `Issue ISS-${String(before.number).padStart(3, '0')} resolved` });
      }
      // Re-read after the mutation: setIssueStatus bumps the version, and
      // broadcasting the pre-mutation `before` row would omit it — a dirty
      // editor's Keep-mine would then adopt `null` and bounce off the 409
      // backstop on its next save.
      const after = getIssue(db, req.params.id);
      if (after) deps.broadcastChange({ type: 'issue', id: req.params.id, projectId: after.projectId, version: after.version, action: 'updated', ...requestMeta(req) });
      res.json({ success: true, ...r });
    } catch (e) { issueErr(e, res); }
  });
  app.delete('/api/issues/:id', authenticateToken, (req, res) => {
    try {
      const before = getIssue(db, req.params.id);
      deleteIssue(db, req.params.id);
      if (before) deps.broadcastChange({ type: 'issue', id: req.params.id, projectId: before.projectId, action: 'deleted', ...requestMeta(req) });
      res.json({ success: true });
    } catch (e) { issueErr(e, res); }
  });
  app.post('/api/issues/:id/photos', authenticateToken, (req, res) => {
    try {
      if (typeof req.body?.fileId !== 'string' || !req.body.fileId) return res.status(400).json({ error: 'fileId is required' });
      addPhoto(db, req.params.id, req.body.fileId);
      const row = getIssue(db, req.params.id);
      // addPhoto/removePhoto don't bump the issue's version — attaching the
      // unchanged version would let a client's version-dedupe skip this event.
      if (row) deps.broadcastChange({ type: 'issue', id: req.params.id, projectId: row.projectId, action: 'updated', ...requestMeta(req) });
      res.json({ success: true });
    } catch (e) { issueErr(e, res); }
  });
  app.delete('/api/issues/:id/photos/:fileId', authenticateToken, (req, res) => {
    try {
      removePhoto(db, req.params.id, req.params.fileId);
      const row = getIssue(db, req.params.id);
      // addPhoto/removePhoto don't bump the issue's version — attaching the
      // unchanged version would let a client's version-dedupe skip this event.
      if (row) deps.broadcastChange({ type: 'issue', id: req.params.id, projectId: row.projectId, action: 'updated', ...requestMeta(req) });
      res.json({ success: true });
    } catch (e) { issueErr(e, res); }
  });

  // ── RFIs (any authenticated user — field-created, like issues) ─────────────
  const rfiErr = (e: unknown, res: express.Response) => {
    if (e instanceof RfiNotFoundError) return res.status(404).json({ error: e.message });
    if (e instanceof RfiConflictError) return res.status(409).json({ error: e.message, code: 'version_conflict' });
    if (e instanceof RfiValidationError) return res.status(400).json({ error: e.message });
    console.error('RFI error:', e);
    return res.status(500).json({ error: 'RFI operation failed' });
  };
  const rfiNo = (n: number) => `RFI-${String(n).padStart(3, '0')}`;

  app.get('/api/projects/:id/rfis', authenticateToken, (req, res) => {
    try { res.json(listRfis(db, req.params.id)); } catch (e) { rfiErr(e, res); }
  });
  app.post('/api/projects/:id/rfis', authenticateToken, (req, res) => {
    try {
      const r = createRfi(db, req.params.id, req.body);
      logActivity(db, { projectId: req.params.id, userId: (req as any).user?.id, type: 'rfi_created', message: `RFI ${rfiNo(r.number)} opened: ${req.body?.title ?? ''}` });
      const row = getRfi(db, r.id);
      deps.broadcastChange({ type: 'rfi', id: r.id, projectId: req.params.id, version: row?.version, action: 'created', ...requestMeta(req) });
      res.json(r);
    } catch (e) { rfiErr(e, res); }
  });
  app.get('/api/rfis/:id', authenticateToken, (req, res) => {
    try { const rfi = getRfi(db, req.params.id); if (!rfi) return res.status(404).json({ error: 'RFI not found' }); res.json(rfi); } catch (e) { rfiErr(e, res); }
  });
  app.put('/api/rfis/:id', authenticateToken, (req, res) => {
    try {
      const result = saveRfi(db, req.params.id, req.body);
      const row = getRfi(db, req.params.id);
      if (row) deps.broadcastChange({
        type: 'rfi', id: req.params.id, projectId: row.projectId,
        version: row.version, action: 'updated', ...requestMeta(req),
      });
      res.json({ success: true, ...result });
    } catch (e) { rfiErr(e, res); }
  });
  app.patch('/api/rfis/:id', authenticateToken, (req, res) => {
    try {
      if (typeof req.body?.status !== 'string') return res.status(400).json({ error: 'status is required' });
      const before = getRfi(db, req.params.id); // read once, before the change
      const r = setRfiStatus(db, req.params.id, req.body.status);
      if (req.body.status === 'closed' && before) {
        logActivity(db, { projectId: before.projectId, userId: (req as any).user?.id, type: 'rfi_closed', message: `RFI ${rfiNo(before.number)} closed` });
      }
      // Re-read after the mutation: setRfiStatus bumps the version, and
      // broadcasting the pre-mutation `before` row would omit it — see the
      // matching comment on the issue PATCH route above.
      const after = getRfi(db, req.params.id);
      if (after) deps.broadcastChange({ type: 'rfi', id: req.params.id, projectId: after.projectId, version: after.version, action: 'updated', ...requestMeta(req) });
      res.json({ success: true, ...r });
    } catch (e) { rfiErr(e, res); }
  });
  app.delete('/api/rfis/:id', authenticateToken, (req, res) => {
    try {
      const before = getRfi(db, req.params.id);
      deleteRfi(db, req.params.id);
      if (before) deps.broadcastChange({ type: 'rfi', id: req.params.id, projectId: before.projectId, action: 'deleted', ...requestMeta(req) });
      res.json({ success: true });
    } catch (e) { rfiErr(e, res); }
  });
  app.post('/api/rfis/:id/photos', authenticateToken, (req, res) => {
    try {
      if (typeof req.body?.fileId !== 'string' || !req.body.fileId) return res.status(400).json({ error: 'fileId is required' });
      addRfiPhoto(db, req.params.id, req.body.fileId);
      const row = getRfi(db, req.params.id);
      // addPhoto/removePhoto don't bump the RFI's version — attaching the
      // unchanged version would let a client's version-dedupe skip this event.
      if (row) deps.broadcastChange({ type: 'rfi', id: req.params.id, projectId: row.projectId, action: 'updated', ...requestMeta(req) });
      res.json({ success: true });
    } catch (e) { rfiErr(e, res); }
  });
  app.delete('/api/rfis/:id/photos/:fileId', authenticateToken, (req, res) => {
    try {
      removeRfiPhoto(db, req.params.id, req.params.fileId);
      const row = getRfi(db, req.params.id);
      // addPhoto/removePhoto don't bump the RFI's version — attaching the
      // unchanged version would let a client's version-dedupe skip this event.
      if (row) deps.broadcastChange({ type: 'rfi', id: req.params.id, projectId: row.projectId, action: 'updated', ...requestMeta(req) });
      res.json({ success: true });
    } catch (e) { rfiErr(e, res); }
  });
  // Record the answer — usually an uploaded response PDF, optionally text.
  app.post('/api/rfis/:id/response', authenticateToken, (req, res) => {
    try {
      const before = getRfi(db, req.params.id);
      const r = setRfiResponse(db, req.params.id, { fileId: req.body?.fileId, text: req.body?.text });
      if (before) {
        logActivity(db, { projectId: before.projectId, userId: (req as any).user?.id, type: 'rfi_answered', message: `RFI ${rfiNo(before.number)} answered` });
        // Re-read after the mutation: setRfiResponse bumps the version.
        const after = getRfi(db, req.params.id);
        deps.broadcastChange({ type: 'rfi', id: req.params.id, projectId: before.projectId, version: after?.version, action: 'updated', ...requestMeta(req) });
      }
      res.json({ success: true, ...r });
    } catch (e) { rfiErr(e, res); }
  });

  // ── Daily Reports (any authenticated user — field-created, like RFIs) ──────
  const dailyErr = (e: unknown, res: express.Response) => {
    if (e instanceof DailyDateTakenError) return res.status(409).json({ error: 'date_taken', existingId: e.existingId });
    if (e instanceof DailyNotFoundError) return res.status(404).json({ error: e.message });
    if (e instanceof DailyConflictError) return res.status(409).json({ error: e.message, code: 'version_conflict' });
    if (e instanceof DailyValidationError) return res.status(400).json({ error: e.message });
    console.error('Daily report error:', e);
    return res.status(500).json({ error: 'Daily report operation failed' });
  };

  app.get('/api/projects/:id/daily-reports', authenticateToken, (req, res) => {
    try { res.json(listDailyReports(db, req.params.id)); } catch (e) { dailyErr(e, res); }
  });
  app.post('/api/projects/:id/daily-reports', authenticateToken, (req, res) => {
    try {
      const r = createDailyReport(db, req.params.id, req.body, (req as any).user?.username);
      logActivity(db, { projectId: req.params.id, userId: (req as any).user?.id, type: 'daily_report_created', message: `Daily report ${req.body?.reportDate ?? ''} created` });
      deps.broadcastChange({ type: 'dailyReport', id: r.id, projectId: req.params.id, version: 1, action: 'created', ...requestMeta(req) });
      res.json(r);
    } catch (e) { dailyErr(e, res); }
  });
  app.get('/api/daily-reports/:id', authenticateToken, (req, res) => {
    try {
      const report = getDailyReport(db, req.params.id);
      if (!report) { res.status(404).json({ error: 'Daily report not found' }); return; }
      res.json(report);
    } catch (e) { dailyErr(e, res); }
  });
  app.put('/api/daily-reports/:id', authenticateToken, (req, res) => {
    try {
      const before = getDailyReport(db, req.params.id);
      const result = saveDailyReport(db, req.params.id, req.body);
      if (before) deps.broadcastChange({ type: 'dailyReport', id: req.params.id, projectId: before.projectId, version: result.version, action: 'updated', ...requestMeta(req) });
      res.json(result);
    } catch (e) { dailyErr(e, res); }
  });
  app.delete('/api/daily-reports/:id', authenticateToken, (req, res) => {
    try {
      const before = getDailyReport(db, req.params.id);
      deleteDailyReport(db, req.params.id);
      if (before) deps.broadcastChange({ type: 'dailyReport', id: req.params.id, projectId: before.projectId, action: 'deleted', ...requestMeta(req) });
      res.json({ success: true });
    } catch (e) { dailyErr(e, res); }
  });
  app.post('/api/daily-reports/:id/photos', authenticateToken, (req, res) => {
    try {
      addDailyPhoto(db, req.params.id, req.body.fileId);
      const row = getDailyReport(db, req.params.id);
      // addPhoto/removePhoto don't bump the daily report's version — attaching
      // an unbumped version would poison the client's version-dedupe — but
      // they do stamp updatedAt, so the returned row (and the broadcast
      // below) still lets the document-actions freshness chip notice a photo
      // change without a version bump confusing the collab merge logic.
      if (row) deps.broadcastChange({ type: 'dailyReport', id: req.params.id, projectId: row.projectId, action: 'updated', ...requestMeta(req) });
      res.json({ success: true });
    } catch (e) { dailyErr(e, res); }
  });
  app.delete('/api/daily-reports/:id/photos/:fileId', authenticateToken, (req, res) => {
    try {
      removeDailyPhoto(db, req.params.id, req.params.fileId);
      const row = getDailyReport(db, req.params.id);
      if (row) deps.broadcastChange({ type: 'dailyReport', id: req.params.id, projectId: row.projectId, action: 'updated', ...requestMeta(req) });
      res.json({ success: true });
    } catch (e) { dailyErr(e, res); }
  });
  app.get('/api/projects/:id/daily-weather', authenticateToken, async (req, res) => {
    const date = String(req.query.date ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'bad_date' });
    const row = db.prepare('SELECT address FROM projects WHERE id = ?').get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'Project not found' });
    if (!row.address) return res.status(400).json({ error: 'no_address' });
    try {
      const geo = await geocodeAddress(row.address);
      if (!geo) return res.status(502).json({ error: 'weather_unavailable' });
      res.json(await fetchDailyWeather(geo.lat, geo.lon, date));
    } catch (e) {
      console.error('Daily weather fetch failed:', e);
      res.status(502).json({ error: 'weather_unavailable' });
    }
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
      const row = getPunchItem(db, r.id);
      deps.broadcastChange({ type: 'punch', id: r.id, projectId: req.params.id, version: row?.version, action: 'created', ...requestMeta(req) });
      res.json(r);
    } catch (e) { punchErr(e, res); }
  });
  app.get('/api/punch/:id', authenticateToken, (req, res) => {
    try { const it = getPunchItem(db, req.params.id); if (!it) return res.status(404).json({ error: 'Punch item not found' }); res.json(it); } catch (e) { punchErr(e, res); }
  });
  app.put('/api/punch/:id', authenticateToken, (req, res) => {
    try {
      const result = savePunchItem(db, req.params.id, req.body);
      const row = getPunchItem(db, req.params.id);
      if (row) deps.broadcastChange({
        type: 'punch', id: req.params.id, projectId: row.projectId,
        version: row.version, action: 'updated', ...requestMeta(req),
      });
      res.json({ success: true, ...result });
    } catch (e) { punchErr(e, res); }
  });
  app.patch('/api/punch/:id', authenticateToken, (req, res) => {
    try {
      if (typeof req.body?.done !== 'boolean') return res.status(400).json({ error: 'done (boolean) is required' });
      const before = getPunchItem(db, req.params.id);
      const r = setPunchDone(db, req.params.id, req.body.done);
      if (req.body.done && before) {
        logActivity(db, { projectId: before.projectId, userId: (req as any).user?.id, type: 'punch_done', message: `Punch item done${before.area ? ` (${before.area})` : ''}: ${before.description ?? ''}` });
      }
      // Re-read after the mutation: setPunchDone bumps the version, and
      // broadcasting the pre-mutation `before` row would omit it — see the
      // matching comment on the issue PATCH route above.
      const after = getPunchItem(db, req.params.id);
      if (after) deps.broadcastChange({ type: 'punch', id: req.params.id, projectId: after.projectId, version: after.version, action: 'updated', ...requestMeta(req) });
      res.json({ success: true, ...r });
    } catch (e) { punchErr(e, res); }
  });
  app.delete('/api/punch/:id', authenticateToken, (req, res) => {
    try {
      const before = getPunchItem(db, req.params.id);
      deletePunchItem(db, req.params.id);
      if (before) deps.broadcastChange({ type: 'punch', id: req.params.id, projectId: before.projectId, action: 'deleted', ...requestMeta(req) });
      res.json({ success: true });
    } catch (e) { punchErr(e, res); }
  });
  app.post('/api/punch/:id/photos', authenticateToken, (req, res) => {
    try {
      if (typeof req.body?.fileId !== 'string' || !req.body.fileId) return res.status(400).json({ error: 'fileId is required' });
      addPunchPhoto(db, req.params.id, req.body.fileId, req.body?.stage ?? 'before');
      const row = getPunchItem(db, req.params.id);
      // addPunchPhoto/removePunchPhoto don't bump the item's version —
      // attaching the unchanged version would let a client's version-dedupe
      // skip this event.
      if (row) deps.broadcastChange({ type: 'punch', id: req.params.id, projectId: row.projectId, action: 'updated', ...requestMeta(req) });
      res.json({ success: true });
    } catch (e) { punchErr(e, res); }
  });
  app.delete('/api/punch/:id/photos/:fileId', authenticateToken, (req, res) => {
    try {
      removePunchPhoto(db, req.params.id, req.params.fileId);
      const row = getPunchItem(db, req.params.id);
      // addPunchPhoto/removePunchPhoto don't bump the item's version —
      // attaching the unchanged version would let a client's version-dedupe
      // skip this event.
      if (row) deps.broadcastChange({ type: 'punch', id: req.params.id, projectId: row.projectId, action: 'updated', ...requestMeta(req) });
      res.json({ success: true });
    } catch (e) { punchErr(e, res); }
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
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      const customerId = typeof req.query.customerId === 'string' ? req.query.customerId : undefined;
      const assigneeUserId = typeof req.query.assigneeUserId === 'string' ? req.query.assigneeUserId : undefined;
      res.json(listTasks(db, {
        ...(projectId ? { projectId } : {}),
        ...(customerId ? { customerId } : {}),
        ...(assigneeUserId ? { assigneeUserId } : {}),
      }));
    } catch (e) { taskErr(e, res); }
  });
  app.post('/api/tasks', authenticateToken, (req, res) => {
    try {
      const r = createTask(db, { ...req.body, createdBy: (req as any).user?.id ?? null });
      const projectId = typeof req.body?.projectId === 'string' && req.body.projectId ? req.body.projectId : undefined;
      deps.broadcastChange({ type: 'task', id: r.id, projectId, action: 'created', ...requestMeta(req) });
      res.json(r);
    } catch (e) { taskErr(e, res); }
  });
  app.get('/api/tasks/:id', authenticateToken, (req, res) => {
    try { const t = getTask(db, req.params.id); if (!t) return res.status(404).json({ error: 'Task not found' }); res.json(t); } catch (e) { taskErr(e, res); }
  });
  app.put('/api/tasks/:id', authenticateToken, (req, res) => {
    try {
      const r = saveTask(db, req.params.id, req.body);
      const row = getTask(db, req.params.id);
      deps.broadcastChange({ type: 'task', id: req.params.id, projectId: row?.projectId ?? undefined, version: r.version, action: 'updated', ...requestMeta(req) });
      res.json({ success: true, ...r });
    } catch (e) { taskErr(e, res); }
  });
  app.patch('/api/tasks/:id', authenticateToken, (req, res) => {
    try {
      if (typeof req.body?.status !== 'string') return res.status(400).json({ error: 'status is required' });
      const r = setTaskStatus(db, req.params.id, req.body.status);
      const row = getTask(db, req.params.id);
      deps.broadcastChange({ type: 'task', id: req.params.id, projectId: row?.projectId ?? undefined, version: row?.version, action: 'updated', ...requestMeta(req) });
      res.json({ success: true, ...r });
    } catch (e) { taskErr(e, res); }
  });
  app.delete('/api/tasks/:id', authenticateToken, (req, res) => {
    try {
      const before = getTask(db, req.params.id);
      deleteTask(db, req.params.id);
      if (before) deps.broadcastChange({ type: 'task', id: req.params.id, projectId: before.projectId ?? undefined, action: 'deleted', ...requestMeta(req) });
      res.json({ success: true });
    } catch (e) { taskErr(e, res); }
  });
  app.post('/api/tasks/:id/photos', authenticateToken, (req, res) => {
    try {
      if (typeof req.body?.fileId !== 'string' || !req.body.fileId) return res.status(400).json({ error: 'fileId is required' });
      addTaskPhoto(db, req.params.id, req.body.fileId, req.body?.stage ?? 'before');
      const row = getTask(db, req.params.id);
      if (row) deps.broadcastChange({ type: 'task', id: req.params.id, projectId: row.projectId ?? undefined, action: 'updated', ...requestMeta(req) });
      res.json({ success: true });
    } catch (e) { taskErr(e, res); }
  });
  app.delete('/api/tasks/:id/photos/:fileId', authenticateToken, (req, res) => {
    try {
      removeTaskPhoto(db, req.params.id, req.params.fileId);
      const row = getTask(db, req.params.id);
      if (row) deps.broadcastChange({ type: 'task', id: req.params.id, projectId: row.projectId ?? undefined, action: 'updated', ...requestMeta(req) });
      res.json({ success: true });
    } catch (e) { taskErr(e, res); }
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
      // Optional attribution (spec docs/superpowers/specs/2026-08-17-documents-clutter-design.md
      // §Implementation): page-asset callers pass kind=plan so ALWAYS_EXCLUDED_KINDS
      // hides them at upload time too, not just via the NOT-EXISTS fallback.
      const q = req.query;
      const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
      const result = putDataUrl(db, dataDir, id, data, { kind: str(q.kind), projectId: str(q.projectId) });
      deps.broadcastChange({
        type: 'file', id: result.id, projectId: result.projectId ?? undefined,
        action: result.versioned ? 'updated' : 'created', ...requestMeta(req),
      });
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
        const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
        // With a full sourceType+sourceId+kind triple this versions the
        // document that source already owns, so fileId can differ from the id
        // in the URL — callers must store the returned fileId.
        const result = putBuffer(db, dataDir, req.params.id, body, mime, {
          projectId: str(q.projectId),
          kind: str(q.kind),
          name: str(q.name),
          customerId: str(q.customerId),
          sourceType: str(q.sourceType),
          sourceId: str(q.sourceId),
          mode: str(q.mode) === 'overwrite' ? 'overwrite' : undefined,
        });
        deps.broadcastChange({
          type: 'file', id: result.id, projectId: result.projectId ?? undefined,
          action: result.versioned ? 'updated' : 'created', ...requestMeta(req),
        });
        // A regenerate (versioned or overwritten in place) replaces the bytes
        // an open spreadsheet-editor session might still be flushing dirty
        // edits onto — same reasoning as the delete-route clearSession below.
        if (result.versioned) deps.sheetStore?.clearSession(result.id);
        res.json({ success: true, fileId: result.id, versioned: result.versioned });
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
        // I6: this route replaces the LIVE bytes out from under any sheet
        // session the flush engine doesn't know about — clear it so the next
        // sheet-join re-imports the new bytes instead of hydrating the stale
        // working copy over them.
        deps.sheetStore?.clearSession(req.params.id);
        deps.broadcastChange({ type: 'file', id: req.params.id, projectId: target.projectId ?? undefined, action: 'updated', ...requestMeta(req) });
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

  // ── Global Documents page ─────────────────────────────────────────────────
  // GET /api/projects/:id/files is gone with ProjectDocuments: it had no role
  // gate, so it leaked billing-kind rows (invoice/pay-app/CO/proposal) to
  // non-admins. /api/documents below is the one listing endpoint, and it
  // applies that exclusion.
  // spec docs/superpowers/specs/2026-08-17-unified-documents-design.md §Server

  // Single-entity lookup ("does this invoice already have a generated PDF?")
  // — either one sourceId (200 SourceDoc | 404) or a batch via sourceIds
  // (always 200, a map of id -> SourceDoc | null). Placed ahead of
  // /api/documents purely to keep the two document-query routes adjacent —
  // the paths never collide, so registration order doesn't matter here.
  app.get('/api/documents/by-source', authenticateToken, (req, res) => {
    try {
      const isAdmin = (req as any).user?.role === 'admin';
      const { sourceType, kind, sourceId, sourceIds } = req.query as Record<string, string | undefined>;
      if (!sourceType || !kind) return res.status(400).json({ error: 'sourceType and kind are required' });
      if (typeof sourceIds === 'string') {
        return res.json(findDocumentsBySource(db, { sourceType, kind, sourceIds: sourceIds.split(',').map(s => s.trim()).filter(Boolean) }, isAdmin));
      }
      if (!sourceId) return res.status(400).json({ error: 'sourceId or sourceIds is required' });
      const doc = findDocumentBySource(db, { sourceType, sourceId, kind }, isAdmin);
      if (!doc) return res.status(404).json({ error: 'No document for this source' });
      res.json(doc);
    } catch (e) {
      console.error('Error looking up document by source:', e);
      res.status(500).json({ error: 'Failed to look up document' });
    }
  });

  app.get('/api/documents', authenticateToken, (req, res) => {
    try {
      const isAdmin = (req as any).user?.role === 'admin';
      const q = req.query;
      const csv = (v: unknown): string[] | undefined => {
        if (typeof v !== 'string' || !v) return undefined;
        const arr = v.split(',').map(s => s.trim()).filter(Boolean);
        return arr.length ? arr : undefined;
      };
      const int = (v: unknown): number | undefined => {
        if (typeof v !== 'string' || !v) return undefined;
        const n = parseInt(v, 10);
        return Number.isFinite(n) ? n : undefined;
      };
      const filters: DocumentFilters = {
        projectIds: csv(q.projectIds),
        customerIds: csv(q.customerIds),
        kinds: csv(q.kinds),
        q: typeof q.q === 'string' && q.q ? q.q : undefined,
        mimes: csv(q.mimes),
        archived: q.archived === '1',
        // Admin-only inside listDocuments (re-checked against isAdmin there);
        // passed through as-is here since the raw param is harmless for a
        // non-admin — it's simply ignored.
        unassigned: q.unassigned === '1',
        limit: int(q.limit),
        offset: int(q.offset),
      };
      res.json(listDocuments(db, filters, isAdmin));
    } catch (e) {
      console.error('Error listing documents:', e);
      res.status(500).json({ error: 'Failed to list documents' });
    }
  });

  app.patch('/api/files/:id', authenticateToken, (req, res) => {
    try {
      const { archived, kind } = req.body ?? {};
      if (archived !== undefined && typeof archived !== 'boolean') {
        return res.status(400).json({ error: 'archived must be a boolean' });
      }
      if (kind !== undefined && typeof kind !== 'string') {
        return res.status(400).json({ error: 'kind must be a string' });
      }
      const isAdmin = (req as any).user?.role === 'admin';
      const result = patchDocument(db, req.params.id, { archived, kind }, isAdmin);
      if (result.ok === false) return res.status(result.status).json({ error: result.error });
      deps.broadcastChange({ type: 'file', id: req.params.id, projectId: result.value.projectId ?? undefined, action: 'updated', ...requestMeta(req) });
      const { sha256, legacyFormat, ...slim } = result.value as any;
      res.json({ success: true, ...slim, archived: !!slim.archived });
    } catch (e) {
      console.error('Error updating file:', e);
      res.status(500).json({ error: 'Failed to update file' });
    }
  });

  app.delete('/api/files/:id', authenticateToken, (req, res) => {
    try {
      const isAdmin = (req as any).user?.role === 'admin';
      const before = getMeta(db, req.params.id);
      const result = deleteDocument(db, dataDir, req.params.id, isAdmin);
      if (result.ok === false) return res.status(result.status).json({ error: result.error });
      // I6: a deleted file's dirty sheet-session row would otherwise
      // error-loop the flush engine every 15s forever (durable across
      // restarts) trying to patch bytes that no longer exist.
      deps.sheetStore?.clearSession(req.params.id);
      if (before) deps.broadcastChange({ type: 'file', id: req.params.id, projectId: before.projectId ?? undefined, action: 'deleted', ...requestMeta(req) });
      res.json({ success: true });
    } catch (e) {
      console.error('Error deleting file:', e);
      res.status(500).json({ error: 'Failed to delete file' });
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
    // Photo join tables hold their file ids in a column, not in any JSON the
    // walk above reaches. Project-attributed rows are covered by the clause
    // below, but task photos are deliberately project-less (a task outlives the
    // project it merely refers to), so without this pass they read as orphans.
    for (const table of ['issue_photos', 'punch_photos', 'task_photos', 'change_order_photos', 'rfi_photos', 'daily_report_photos']) {
      let rows: { fileId: string | null }[] = [];
      try { rows = db.prepare(`SELECT fileId FROM ${table}`).all() as { fileId: string | null }[]; } catch { continue; }
      for (const r of rows) if (r.fileId) referenced.add(r.fileId);
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

  // ── Customers ────────────────────────────────────────────────────────────────

  app.get('/api/customers', authenticateToken, (_req, res) => res.json(listCustomers(db)));
  // NOTE: must be registered before '/api/customers/:id' or Express matches
  // 'summary' as a customer id (same gotcha as /api/projects/summary above).
  app.get('/api/customers/summary', authenticateToken, (req, res) => {
    try {
      const isAdmin = (req as any).user?.role === 'admin';
      res.json(customerSummaries(db, isAdmin));
    } catch (e) {
      console.error('Error fetching customer summaries:', e);
      res.status(500).json({ error: 'Failed to fetch customer summaries' });
    }
  });
  app.get('/api/customers/:id', authenticateToken, (req, res) => {
    const c = getCustomer(db, req.params.id);
    return c ? res.json(c) : res.status(404).json({ error: 'not found' });
  });
  app.get('/api/customers/:id/projects', authenticateToken, (req, res) =>
    res.json(listProjectsForCustomer(db, req.params.id)));
  app.get('/api/customers/:id/overview', authenticateToken, (req, res) => {
    try {
      const isAdmin = (req as any).user?.role === 'admin';
      const overview = customerOverview(db, req.params.id, isAdmin);
      if (!overview) return res.status(404).json({ error: 'not found' });
      res.json(overview);
    } catch (e) {
      console.error('Error fetching customer overview:', e);
      res.status(500).json({ error: 'Failed to fetch customer overview' });
    }
  });
  app.post('/api/customers', authenticateToken, (req, res) => {
    if (!req.body?.name || !String(req.body.name).trim()) return res.status(400).json({ error: 'name is required' });
    const id = req.body.id || `customer-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    const saved = saveCustomer(db, { ...req.body, id });
    deps.broadcastChange({ type: 'customer', id: saved.id, action: 'created', ...requestMeta(req) });
    res.json(saved);
  });
  app.put('/api/customers/:id', authenticateToken, (req, res) => {
    if (!req.body?.name || !String(req.body.name).trim()) return res.status(400).json({ error: 'name is required' });
    const newName = String(req.body.name).trim();
    const previousName = getCustomer(db, req.params.id)?.name;
    const saved = saveCustomer(db, { ...req.body, id: req.params.id });
    // Keep each project's legacy `contractor` string in sync with the customer
    // name it belongs to (contractor was the pre-customerId identity; several
    // reads/exports still display it directly). Only an actual RENAME may write
    // it — a phone/email edit must leave contractor alone — and never for the
    // "Unassigned" bucket, whose name is a placeholder, not a company: its
    // projects deliberately carry a blank or hand-typed contractor.
    if (req.params.id !== 'customer-unassigned' && newName !== previousName) {
      db.prepare('UPDATE projects SET contractor = ? WHERE customerId = ?').run(newName, req.params.id);
    }
    // One event, not one-per-affected-project: the contractor-string backfill
    // above is a display-string side effect, not something project screens
    // need to live-refresh on (see task-3 brief — YAGNI).
    deps.broadcastChange({ type: 'customer', id: req.params.id, action: 'updated', ...requestMeta(req) });
    res.json(saved);
  });
  app.delete('/api/customers/:id', authenticateToken, (req, res) => {
    try {
      deleteCustomer(db, req.params.id);
      deps.broadcastChange({ type: 'customer', id: req.params.id, action: 'deleted', ...requestMeta(req) });
      res.json({ success: true });
    }
    catch (e: any) { res.status(409).json({ error: String(e?.message ?? e) }); }
  });
  app.post('/api/customers/merge', authenticateToken, (req, res) => {
    try {
      const targetId = req.body.targetId;
      const sourceIds: string[] = req.body.sourceIds || [];
      // Mirror mergeCustomers' own skip rules (self-merge, unknown id) so we only
      // broadcast a 'deleted' for sources it will actually remove.
      const mergedIds = sourceIds.filter(sid => sid !== targetId && !!getCustomer(db, sid));
      mergeCustomers(db, targetId, sourceIds);
      for (const sid of mergedIds) {
        deps.broadcastChange({ type: 'customer', id: sid, action: 'deleted', ...requestMeta(req) });
      }
      deps.broadcastChange({ type: 'customer', id: targetId, action: 'updated', ...requestMeta(req) });
      res.json({ success: true });
    }
    catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
  });

  registerProposalRoutes(app, { db, dataDir, authenticateToken, requireAdmin, broadcastChange: deps.broadcastChange });
}

// ── Item send routes ─────────────────────────────────────────────────────────
// Every "email this document" button in the app lands here. The routes own the
// item: they load it, apply the pre-send validations that have always guarded it
// (404s, a proposal that is already sent), and name the attachment. Everything
// downstream — choosing the account, building the MIME message, talking to the
// provider, indexing the sent copy, linking the thread, marking the item sent,
// logging the activity and broadcasting the change — belongs to
// server/mail/sendService (spec §4.5/§4.6). There is deliberately no status,
// activity or broadcast code left in this file.

export interface EmailRouteDeps {
  db: Database.Database;
  dataDir: string;
  authenticateToken: express.RequestHandler;
  requireAdmin: express.RequestHandler;
  // Not used by the send routes themselves — applySendEffects broadcasts the
  // item's change through mailCtx.broadcastChange. Kept so callers wire every
  // route registrar the same way.
  broadcastChange: BroadcastChange;
  mailCtx: MailContext;
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

// A stored document name is display text, not a filename: proposalFileName()
// deliberately has no extension. Mail clients key their icon/open behavior off
// one, so add .pdf when there isn't already an extension.
export const withPdfExtension = (name: string | null | undefined): string | null => {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  return /\.[A-Za-z0-9]{1,8}$/.test(trimmed) ? trimmed : `${trimmed}.pdf`;
};

// The composer sends rich HTML; the older editors (and any API caller) still
// send plain text as `body`/`message`. Escape it and keep the line breaks so a
// plain-text body doesn't arrive as one run-on paragraph.
const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
export const textToHtml = (t: string): string =>
  `<p>${t.replace(/[&<>]/g, c => HTML_ESCAPES[c]).replace(/\r?\n/g, '<br>')}</p>`;

interface SendBody {
  to?: string;
  fileId: string;
  message?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  html?: string;
  attachmentFileIds?: string[];
  replyTo?: { accountId: string; threadKey: string };
  accountId?: string;
}

// What a route knows about the thing it is sending.
interface SendItemSpec {
  itemType: ItemType;
  itemId: string;
  primaryName: string;
  defaultSubject: string;
  defaultBody: string;
}

export function registerEmailRoutes(app: express.Express, deps: EmailRouteDeps): void {
  const { db, authenticateToken, requireAdmin, mailCtx } = deps;

  // Express 4 leaves a rejected async handler unanswered — the request would
  // hang. Every send route is wrapped so an unexpected throw (a store read, a
  // locked database) still gets a response.
  const sendRoute = (label: string, fn: (req: express.Request, res: express.Response) => Promise<void>): express.RequestHandler =>
    async (req, res) => {
      try { await fn(req, res); }
      catch (e: any) {
        if (e instanceof ProposalLockedError) return proposalErr(e, res);
        console.error(`Error sending ${label}:`, e);
        if (!res.headersSent) res.status(500).json({ error: e?.message || `Failed to send ${label}` });
      }
    };

  // Runs one item send. Returns the SendResult on success, or null after having
  // already written the error response — callers do `if (!r) return;`.
  const sendItem = async (
    req: express.Request,
    res: express.Response,
    item: SendItemSpec,
  ): Promise<SendResult | null> => {
    const { to, fileId, message, cc, bcc, subject, body, html, attachmentFileIds, replyTo, accountId } = req.body as SendBody;
    if (!to || !fileId) { res.status(400).json({ error: 'to and fileId are required' }); return null; }
    // The primary attachment carries the item tag: sendService links the thread
    // to it and applies the item's "sent" side effects exactly once.
    const attachments = buildSendAttachments(db, { fileId, attachmentName: item.primaryName }, attachmentFileIds)
      .map((a, i) => ({ fileId: a.fileId, name: a.attachmentName, ...(i === 0 ? { itemType: item.itemType, itemId: item.itemId } : {}) }));
    try {
      return await mailSend(mailCtx, (req as any).user, {
        accountId,
        to: parseAddressList(to),
        cc: parseAddressList(cc || ''),
        bcc: parseAddressList(bcc || ''),
        subject: subject?.trim() || item.defaultSubject,
        html: html || textToHtml(body ?? message ?? item.defaultBody),
        attachments,
        replyTo,
        links: [{ itemType: item.itemType, itemId: item.itemId }],
      });
    } catch (e: unknown) {
      if (e instanceof MailSendError) { res.status(e.status).json({ error: e.message }); return null; }
      if (e instanceof AuthExpiredError) { res.status(409).json({ error: 'Mail account needs to be reconnected', code: 'auth_error' }); return null; }
      // Spec §7: a provider's raw error can carry hosts, credentials or internal
      // detail. The client gets a fixed string; the detail stays in the log.
      console.error(`Error sending ${item.itemType}:`, e);
      res.status(502).json({ error: 'Mail provider request failed' });
      return null;
    }
  };

  // Send a proposal PDF (admin only). Marked sent inside sendService, only after
  // the provider has accepted the message.
  app.post('/api/proposals/:id/send', authenticateToken, requireAdmin, sendRoute('proposal', async (req, res) => {
    const p = getProposal(db, req.params.id);
    if (!p) { res.status(404).json({ error: 'Proposal not found' }); return; }
    if (p.legacy || p.status !== 'draft') { res.status(409).json({ error: 'Proposal already sent', code: 'locked' }); return; }
    const project = loadProject(db, p.projectId);
    // The attachment arrives named as the document is named in Documents
    // ("Proposal – Job – 2026-08-28"), not a generic Proposal.pdf — that
    // name is what the customer files. proposalFileName() carries no
    // extension, so add one when the stored name lacks it.
    const r = await sendItem(req, res, {
      itemType: 'proposal', itemId: p.id,
      primaryName: withPdfExtension(getMeta(db, (req.body as SendBody).fileId)?.name) ?? 'Proposal.pdf',
      defaultSubject: `Proposal — ${project?.name ?? 'Untitled'}`,
      defaultBody: 'Please find the attached proposal.',
    });
    if (!r) return;
    // markSent bumped the row; the client needs the new version to keep editing.
    res.json({ success: true, ...r, version: getProposal(db, p.id)?.version });
  }));

  // Send an invoice PDF (admin only)
  app.post('/api/invoices/:id/send', authenticateToken, requireAdmin, sendRoute('invoice', async (req, res) => {
    const inv = getInvoice(db, req.params.id);
    if (!inv) { res.status(404).json({ error: 'Invoice not found' }); return; }
    const r = await sendItem(req, res, {
      itemType: 'invoice', itemId: inv.id,
      primaryName: `${inv.number || 'invoice'}.pdf`,
      defaultSubject: `Invoice ${inv.number ?? ''}`.trim(),
      defaultBody: 'Please find the attached invoice.',
    });
    if (!r) return;
    res.json({ success: true, ...r });
  }));

  // Send a change order request PDF (admin only)
  app.post('/api/change-orders/:id/send', authenticateToken, requireAdmin, sendRoute('change order', async (req, res) => {
    const co = getChangeOrder(db, req.params.id);
    if (!co) { res.status(404).json({ error: 'Change order not found' }); return; }
    const number = co.number ?? '';
    const r = await sendItem(req, res, {
      itemType: 'changeOrder', itemId: co.id,
      primaryName: `CO-${number || 'change-order'}.pdf`,
      defaultSubject: `Change Order Request ${number}`.trim(),
      defaultBody: 'Please find the attached change order request.',
    });
    if (!r) return;
    res.json({ success: true, ...r });
  }));

  // Send a punch-list report PDF (any authenticated user). The "item" is the
  // project itself — a punch list has no row of its own.
  app.post('/api/projects/:id/send-punch', authenticateToken, sendRoute('punch report', async (req, res) => {
    const r = await sendItem(req, res, {
      itemType: 'punch', itemId: req.params.id,
      primaryName: 'punch-list.pdf',
      defaultSubject: 'Punch List Report',
      defaultBody: 'Please find the attached punch list report.',
    });
    if (!r) return;
    res.json({ success: true, ...r });
  }));

  // Send an issue report PDF (any authenticated user — field members send issue reports)
  app.post('/api/issues/:id/send', authenticateToken, sendRoute('issue', async (req, res) => {
    const iss = getIssue(db, req.params.id);
    if (!iss) { res.status(404).json({ error: 'Issue not found' }); return; }
    const padded = String(iss.number).padStart(3, '0');
    const r = await sendItem(req, res, {
      itemType: 'issue', itemId: iss.id,
      primaryName: `ISS-${padded}.pdf`,
      defaultSubject: `Issue ISS-${padded}${iss.title ? ` — ${iss.title}` : ''}`,
      defaultBody: 'Please find the attached issue report.',
    });
    if (!r) return;
    res.json({ success: true, ...r });
  }));

  // Send an RFI PDF (any authenticated user — field members send RFIs)
  app.post('/api/rfis/:id/send', authenticateToken, sendRoute('RFI', async (req, res) => {
    const rfi = getRfi(db, req.params.id);
    if (!rfi) { res.status(404).json({ error: 'RFI not found' }); return; }
    const padded = String(rfi.number).padStart(3, '0');
    const r = await sendItem(req, res, {
      itemType: 'rfi', itemId: rfi.id,
      primaryName: `RFI-${padded}.pdf`,
      defaultSubject: `RFI RFI-${padded}${rfi.title ? ` — ${rfi.title}` : ''}`,
      defaultBody: 'Please find the attached RFI.',
    });
    if (!r) return;
    res.json({ success: true, ...r });
  }));

  // Send a daily report PDF (any authenticated user — field members file dailies)
  app.post('/api/daily-reports/:id/send', authenticateToken, sendRoute('daily report', async (req, res) => {
    const report = getDailyReport(db, req.params.id);
    if (!report) { res.status(404).json({ error: 'Daily report not found' }); return; }
    // Mirrors dailyReportPdf.ts's sanitizeForFileName + dailyReportFileName
    // (client can't be imported server-side) — falls back to date-only when
    // jobName is blank.
    const sanitizedJobName = (report.jobName as string || '').replace(/[\\/:*?"<>|]/g, '').trim().replace(/\s+/g, '-');
    const r = await sendItem(req, res, {
      itemType: 'dailyReport', itemId: report.id,
      primaryName: sanitizedJobName ? `DailyReport-${sanitizedJobName}-${report.reportDate}.pdf` : `DailyReport-${report.reportDate}.pdf`,
      defaultSubject: `Daily Report — ${report.reportDate}${report.jobName ? ` — ${report.jobName}` : ''}`,
      defaultBody: 'Please find the attached daily report.',
    });
    if (!r) return;
    res.json({ success: true, ...r });
  }));
}
