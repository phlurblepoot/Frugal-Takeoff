// server/documents.ts — global Documents API (spec 2026-08-17-unified-documents-design.md, §Server).
// Query/aggregation for GET /api/documents plus source-label resolution, and
// the guard logic for PATCH/DELETE on /api/files/:id. Deliberately separate
// from files.ts: files.ts owns storage primitives (policy-free), this module
// owns the Documents-page-specific policy (visibility, labels, guards).
import type Database from 'better-sqlite3';
import { getMeta, setFileFlags, removeFile, listVersions, isDirectUploadKind, FileMeta } from './files';

// Always hidden regardless of role: per-page plan assets and the AIA template.
const ALWAYS_EXCLUDED_KINDS = ['plan', 'settings-asset'] as const;

// Billing-priced kinds — hidden from non-admins (spec §Decisions "Role
// visibility"). change-order-photo and printout are deliberately NOT here:
// they carry no dollar figures.
export const NON_ADMIN_EXCLUDED_KINDS = ['invoice', 'payapp-export', 'change-order', 'proposal'] as const;

// Fallback label when the referenced entity no longer exists (spec: "Missing
// referent (deleted entity) -> label from kind, href null").
const KIND_LABELS: Record<string, string> = {
  invoice: 'Invoice',
  'change-order': 'Change Order',
  'change-order-photo': 'Change Order Photo',
  'issue-report': 'Issue',
  'issue-photo': 'Issue Photo',
  'punch-report': 'Punch Report',
  'punch-photo': 'Punch Photo',
  rfi: 'RFI',
  'rfi-photo': 'RFI Photo',
  'rfi-response': 'RFI Response',
  'task-photo': 'Task Photo',
  'payapp-export': 'Pay App Export',
  proposal: 'Proposal',
  'proposal-photo': 'Proposal Photo',
  printout: 'Printout',
  'plan-source': 'Plan Set',
};
const genericLabel = (kind: string): string => KIND_LABELS[kind] ?? kind;

export interface DocumentFilters {
  projectIds?: string[];
  customerIds?: string[];
  kinds?: string[];
  q?: string;
  archived?: boolean; // true = ONLY archived rows; false/undefined = exclude archived
  limit?: number;
  offset?: number;
}

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

interface RawRow {
  id: string;
  name: string | null;
  mime: string;
  size: number;
  kind: string;
  createdAt: number;
  versionNumber: number;
  archived: number;
  projectId: string | null;
  projectName: string | null;
  customerId: string | null;
  customerName: string | null;
  sourceType: string | null;
  sourceId: string | null;
}

const inClause = (n: number) => Array(n).fill('?').join(',');

export function listDocuments(
  db: Database.Database,
  filters: DocumentFilters,
  isAdmin: boolean
): { rows: DocumentRow[]; total: number } {
  const excluded: string[] = [...ALWAYS_EXCLUDED_KINDS, ...(isAdmin ? [] : NON_ADMIN_EXCLUDED_KINDS)];
  const where: string[] = [
    'f.parentFileId IS NULL',
    `f.kind NOT IN (${inClause(excluded.length)})`,
  ];
  const params: unknown[] = [...excluded];

  where.push(filters.archived ? 'f.archived = 1' : 'f.archived = 0');

  if (filters.projectIds?.length) {
    where.push(`f.projectId IN (${inClause(filters.projectIds.length)})`);
    params.push(...filters.projectIds);
  }
  if (filters.customerIds?.length) {
    const ph = inClause(filters.customerIds.length);
    // Matches either a directly customer-scoped upload OR a file attributed
    // to a project that belongs to the customer (spec §Server).
    where.push(`(f.customerId IN (${ph}) OR p.customerId IN (${ph}))`);
    params.push(...filters.customerIds, ...filters.customerIds);
  }
  if (filters.kinds?.length) {
    where.push(`f.kind IN (${inClause(filters.kinds.length)})`);
    params.push(...filters.kinds);
  }
  if (filters.q) {
    where.push('LOWER(f.name) LIKE ?');
    params.push(`%${filters.q.toLowerCase()}%`);
  }

  const whereSql = where.join(' AND ');
  // customers joined via COALESCE so a customer-only upload (no project) and
  // a project-attributed file both resolve a customerName the same way.
  const fromSql = `
    FROM files f
    LEFT JOIN projects p ON f.projectId = p.id
    LEFT JOIN customers c ON COALESCE(f.customerId, p.customerId) = c.id
  `;

  const total = (
    db.prepare(`SELECT COUNT(*) as c ${fromSql} WHERE ${whereSql}`).get(...params) as { c: number }
  ).c;

  const limit = filters.limit ?? 100;
  const offset = filters.offset ?? 0;
  const rawRows = db.prepare(`
    SELECT f.id, f.name, f.mime, f.size, f.kind, f.createdAt, f.versionNumber, f.archived,
           f.projectId, p.name as projectName,
           COALESCE(f.customerId, p.customerId) as customerId, c.name as customerName,
           f.sourceType, f.sourceId
    ${fromSql}
    WHERE ${whereSql}
    ORDER BY f.createdAt DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as RawRow[];

  const sources = resolveSources(db, rawRows);

  const rows: DocumentRow[] = rawRows.map(r => ({
    id: r.id,
    name: r.name,
    mime: r.mime,
    size: r.size,
    kind: r.kind,
    createdAt: r.createdAt,
    versionNumber: r.versionNumber,
    archived: !!r.archived,
    projectId: r.projectId,
    projectName: r.projectName,
    customerId: r.customerId,
    customerName: r.customerName,
    source: sources.get(r.id) ?? null,
  }));

  return { rows, total };
}

// Source types resolvable by a plain "SELECT ... WHERE id IN (...)" against a
// single table, with a fixed href template keyed off the file's own
// projectId. `proposal` and `printout` don't fit this shape (see below) and
// are resolved separately.
interface SimpleResolver {
  sql: (placeholders: string) => string;
  label: (row: any) => string;
  href: (projectId: string | null) => string | null;
}
const SIMPLE_RESOLVERS: Record<string, SimpleResolver> = {
  invoice: {
    sql: ph => `SELECT id, number FROM invoices WHERE id IN (${ph})`,
    label: row => `Invoice #${row.number ?? '?'}`,
    href: pid => pid ? `/project/${pid}/billing?tab=invoices` : null,
  },
  payapp: {
    sql: ph => `SELECT id, number FROM aia_pay_apps WHERE id IN (${ph})`,
    label: row => `Pay App #${row.number ?? '?'}`,
    href: pid => pid ? `/project/${pid}/billing?tab=pay-apps` : null,
  },
  'change-order': {
    sql: ph => `SELECT id, number FROM change_orders WHERE id IN (${ph})`,
    label: row => `CO #${row.number ?? '?'}`,
    href: pid => pid ? `/project/${pid}/billing?tab=change-orders` : null,
  },
  issue: {
    sql: ph => `SELECT id, number FROM issues WHERE id IN (${ph})`,
    label: row => `Issue #${row.number ?? '?'}`,
    href: pid => pid ? `/project/${pid}/issues` : null,
  },
  punch: {
    sql: ph => `SELECT id, description FROM punch_items WHERE id IN (${ph})`,
    label: row => (typeof row.description === 'string' && row.description.trim()) ? row.description.trim() : 'Punch item',
    href: pid => pid ? `/project/${pid}/punch` : null,
  },
  rfi: {
    sql: ph => `SELECT id, number FROM rfis WHERE id IN (${ph})`,
    label: row => `RFI #${row.number ?? '?'}`,
    href: pid => pid ? `/project/${pid}/rfis` : null,
  },
  task: {
    sql: ph => `SELECT id, title FROM tasks WHERE id IN (${ph})`,
    label: row => (typeof row.title === 'string' && row.title.trim()) ? row.title.trim() : 'Task',
    href: pid => pid ? `/tasks?projectId=${pid}` : '/tasks',
  },
  'plan-set': {
    sql: ph => `SELECT id, name FROM plan_sets WHERE id IN (${ph})`,
    label: row => (typeof row.name === 'string' && row.name.trim()) ? row.name.trim() : 'Plan set',
    href: pid => pid ? `/project/${pid}/takeoff` : null,
  },
  // sourceId is the owning project's id (spec: "One proposal per project, so
  // the project id is its source id"); existence is all that's checked, the
  // label is fixed.
  proposal: {
    sql: ph => `SELECT id FROM projects WHERE id IN (${ph})`,
    label: () => 'Proposal',
    href: pid => pid ? `/project/${pid}/proposal` : null,
  },
};

// printout sourceId is the printout entry's OWN id inside project.printouts[]
// (JSON), not a row in any table — resolved by loading the owning project's
// meta and matching by id.
function resolvePrintouts(db: Database.Database, rows: RawRow[], out: Map<string, DocumentSource>): void {
  const list = rows.filter(r => r.sourceType === 'printout' && r.sourceId);
  if (!list.length) return;
  const projectIds = [...new Set(list.map(r => r.projectId).filter((x): x is string => !!x))];
  const projRows = projectIds.length
    ? (db.prepare(`SELECT id, meta, data FROM projects WHERE id IN (${inClause(projectIds.length)})`)
        .all(...projectIds) as { id: string; meta: string | null; data: string | null }[])
    : [];
  const printoutsByProject = new Map<string, Map<string, { name: string | null }>>();
  for (const pr of projRows) {
    let p: any = null;
    try { p = pr.meta ? JSON.parse(pr.meta) : null; } catch { /* left unparsed below */ }
    if (!p && pr.data) { try { p = JSON.parse(pr.data); } catch { /* legacy blob unreadable */ } }
    const m = new Map<string, { name: string | null }>();
    if (p && Array.isArray(p.printouts)) {
      for (const po of p.printouts) {
        if (po && typeof po === 'object' && typeof po.id === 'string' && po.id) m.set(po.id, { name: po.name ?? null });
      }
    }
    printoutsByProject.set(pr.id, m);
  }
  for (const r of list) {
    const po = r.projectId ? printoutsByProject.get(r.projectId)?.get(r.sourceId!) : undefined;
    out.set(r.id, po
      ? { type: 'printout', id: r.sourceId!, label: (po.name && po.name.trim()) || 'Printout', href: r.projectId ? `/project/${r.projectId}/proposal` : null }
      : { type: 'printout', id: r.sourceId!, label: genericLabel(r.kind), href: null });
  }
}

function resolveSources(db: Database.Database, rows: RawRow[]): Map<string, DocumentSource> {
  const out = new Map<string, DocumentSource>();
  for (const [type, resolver] of Object.entries(SIMPLE_RESOLVERS)) {
    const list = rows.filter(r => r.sourceType === type && r.sourceId);
    if (!list.length) continue;
    const ids = [...new Set(list.map(r => r.sourceId as string))];
    const found = new Map(
      (db.prepare(resolver.sql(inClause(ids.length))).all(...ids) as any[]).map((x: any) => [x.id, x])
    );
    for (const r of list) {
      const match = found.get(r.sourceId as string);
      out.set(r.id, match
        ? { type, id: r.sourceId as string, label: resolver.label(match), href: resolver.href(r.projectId) }
        : { type, id: r.sourceId as string, label: genericLabel(r.kind), href: null });
    }
  }
  resolvePrintouts(db, rows, out);
  return out;
}

// ── PATCH /api/files/:id guard ──────────────────────────────────────────────

export type GuardResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

function isValidCustomKind(db: Database.Database, kind: string): boolean {
  const id = kind.slice('custom:'.length);
  if (!id) return false;
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'documentTypes'`).get() as { value: string } | undefined;
  if (!row) return false;
  try {
    const list = JSON.parse(row.value);
    return Array.isArray(list) && list.some((t: any) => t && typeof t === 'object' && t.id === id);
  } catch {
    return false;
  }
}

// archived may be toggled on any row; kind may only move between
// direct-upload kinds (never onto/off a system-generated kind), and a
// custom:<id> target must be a live entry in settings.documentTypes.
// A non-admin gets 404 (not 409) for a billing-kind row — same set the
// listing hides for them — so a PATCH can't be used to confirm a row
// exists, or read back its metadata, when they couldn't see it via GET.
export function patchDocument(
  db: Database.Database,
  id: string,
  patch: { archived?: boolean; kind?: string },
  isAdmin: boolean
): GuardResult<FileMeta> {
  const current = getMeta(db, id);
  if (!current) return { ok: false, status: 404, error: 'File not found' };
  if (!isAdmin && (NON_ADMIN_EXCLUDED_KINDS as readonly string[]).includes(current.kind)) {
    return { ok: false, status: 404, error: 'File not found' };
  }
  if (patch.kind !== undefined && patch.kind !== current.kind) {
    if (!isDirectUploadKind(current.kind) || !isDirectUploadKind(patch.kind)) {
      return { ok: false, status: 409, error: 'kind can only be changed between direct-upload types' };
    }
    if (patch.kind.startsWith('custom:') && !isValidCustomKind(db, patch.kind)) {
      return { ok: false, status: 400, error: 'Unknown custom document type' };
    }
  }
  const meta = setFileFlags(db, id, patch);
  return { ok: true, value: meta as FileMeta };
}

// ── DELETE /api/files/:id guard ─────────────────────────────────────────────

// Only loose, never-sourced direct uploads are really deletable (spec §Safe
// deletion tiers): generated/attached files are archived here and deleted at
// their source entity instead. Wipes the live row AND every version row's
// bytes (listVersions returns [live, ...history]). Deletable rows are always
// direct-upload kinds (never a billing kind), so the role gate below is
// vacuously true today — kept for uniformity with patchDocument and as a
// guard against a future kind ever landing in both sets.
export function deleteDocument(
  db: Database.Database,
  dataDir: string,
  id: string,
  isAdmin: boolean
): GuardResult<null> {
  const current = getMeta(db, id);
  if (!current) return { ok: false, status: 404, error: 'File not found' };
  if (!isAdmin && (NON_ADMIN_EXCLUDED_KINDS as readonly string[]).includes(current.kind)) {
    return { ok: false, status: 404, error: 'File not found' };
  }
  if (current.parentFileId) return { ok: false, status: 409, error: 'Cannot delete a historical file version directly' };
  if (current.sourceType) {
    return { ok: false, status: 409, error: 'This file is generated from another record — archive it here, or delete it at the source' };
  }
  if (!isDirectUploadKind(current.kind)) {
    return { ok: false, status: 409, error: 'This file type cannot be deleted directly' };
  }
  for (const v of listVersions(db, id)) removeFile(db, dataDir, v.id);
  return { ok: true, value: null };
}
