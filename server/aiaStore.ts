// server/aiaStore.ts
//
// AIA progress billing (G702/G703) — Schedule of Values.
// All money is INTEGER CENTS (scheduledValueCents is an INTEGER column).
// Every numeric input is guarded with Number.isFinite / Number.isInteger
// because Phase 4a had float-corruption bugs from missing guards.
import type Database from 'better-sqlite3';
import crypto from 'crypto';

export class ValidationError extends Error {}
export class ConflictError extends Error {}
export class NotFoundError extends Error {}

export function requireProject(db: Database.Database, projectId: string): void {
  if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) throw new NotFoundError('Project not found');
}

interface SovLineInput {
  itemNo?: string | null;
  description?: string;
  scheduledValueCents?: number;
  retainagePercent?: number | null;
  isChangeOrder?: boolean | number;
  changeOrderId?: string | null;
}

// Validate the money + retainage fields shared by create/save. Returns the
// normalised retainagePercent (null when absent).
function validateScheduledValueCents(cents: any): number {
  if (!Number.isInteger(cents) || !Number.isFinite(cents) || cents < 0) {
    throw new ValidationError('scheduledValueCents must be a non-negative integer (cents)');
  }
  return cents;
}

function validateRetainagePercent(pct: any): number | null {
  if (pct === undefined || pct === null) return null;
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new ValidationError('retainagePercent must be a number between 0 and 100');
  }
  return pct;
}

export function getSovLine(db: Database.Database, id: string): any | null {
  const row = db.prepare('SELECT * FROM aia_sov_lines WHERE id = ?').get(id) as any;
  return row ?? null;
}

export function listSovLines(db: Database.Database, projectId: string): any[] {
  return db.prepare(
    'SELECT * FROM aia_sov_lines WHERE projectId = ? ORDER BY sortOrder ASC, createdAt ASC, rowid ASC'
  ).all(projectId) as any[];
}

export function createSovLine(db: Database.Database, projectId: string, input: SovLineInput): { id: string } {
  requireProject(db, projectId);
  if (typeof input.description !== 'string') throw new ValidationError('description is required');
  const cents = validateScheduledValueCents(input.scheduledValueCents);
  const retainage = validateRetainagePercent(input.retainagePercent);
  const isCO = input.isChangeOrder ? 1 : 0;
  const id = crypto.randomUUID();
  const tx = db.transaction(() => {
    const max = (db.prepare('SELECT COALESCE(MAX(sortOrder), -1) m FROM aia_sov_lines WHERE projectId = ?').get(projectId) as any).m;
    db.prepare(
      'INSERT INTO aia_sov_lines (id, projectId, itemNo, description, scheduledValueCents, retainagePercent, isChangeOrder, changeOrderId, sortOrder, version, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)'
    ).run(id, projectId, input.itemNo ?? null, input.description, cents, retainage, isCO, input.changeOrderId ?? null, max + 1, Date.now());
  });
  tx();
  return { id };
}

export function saveSovLine(db: Database.Database, id: string, input: SovLineInput & { version?: number }): { version: number } {
  if (typeof input.description !== 'string') throw new ValidationError('description is required');
  const cents = validateScheduledValueCents(input.scheduledValueCents);
  const retainage = validateRetainagePercent(input.retainagePercent);
  if (!Number.isInteger(input.version) || (input.version as number) < 1) {
    throw new ValidationError('Missing or invalid version — reload the line');
  }
  let newVersion = 0;
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT version FROM aia_sov_lines WHERE id = ?').get(id) as { version: number } | undefined;
    if (!row) throw new NotFoundError('SOV line not found');
    if (row.version !== input.version) throw new ConflictError(`SOV line changed since it was loaded (server v${row.version}, payload v${input.version})`);
    newVersion = row.version + 1;
    db.prepare('UPDATE aia_sov_lines SET itemNo = ?, description = ?, scheduledValueCents = ?, retainagePercent = ?, version = ? WHERE id = ?')
      .run(input.itemNo ?? null, input.description, cents, retainage, newVersion, id);
  });
  tx();
  return { version: newVersion };
}

export function deleteSovLine(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM aia_sov_lines WHERE id = ?').run(id);
}

interface SeedLine { description?: string; scheduledValueCents?: number; itemNo?: string | null; }

// Replace the project's estimate-derived (non-change-order) SOV lines with a
// fresh set from the client estimate computation. Existing change-order lines
// (isChangeOrder=1) are KEPT and re-sorted to follow the new estimate lines.
export function seedSovLines(db: Database.Database, projectId: string, lines: SeedLine[]): { count: number } {
  requireProject(db, projectId);
  if (!Array.isArray(lines)) throw new ValidationError('lines must be an array');
  // Validate up front so a bad line aborts before any write.
  const prepared = lines.map((l, i) => {
    const cents = validateScheduledValueCents(l.scheduledValueCents);
    return {
      itemNo: l.itemNo ?? String(i + 1),
      description: typeof l.description === 'string' ? l.description : '',
      scheduledValueCents: cents,
      sortOrder: i,
    };
  });
  const now = Date.now();
  const tx = db.transaction(() => {
    // Drop old estimate lines; keep change-order lines.
    db.prepare('DELETE FROM aia_sov_lines WHERE projectId = ? AND isChangeOrder = 0').run(projectId);
    const ins = db.prepare(
      'INSERT INTO aia_sov_lines (id, projectId, itemNo, description, scheduledValueCents, retainagePercent, isChangeOrder, changeOrderId, sortOrder, version, createdAt) VALUES (?, ?, ?, ?, ?, NULL, 0, NULL, ?, 1, ?)'
    );
    for (const p of prepared) {
      ins.run(crypto.randomUUID(), projectId, p.itemNo, p.description, p.scheduledValueCents, p.sortOrder, now);
    }
    // Re-sort the kept change-order lines to follow the new estimate block.
    let next = prepared.length;
    const cos = db.prepare('SELECT id FROM aia_sov_lines WHERE projectId = ? AND isChangeOrder = 1 ORDER BY sortOrder ASC, createdAt ASC, rowid ASC').all(projectId) as { id: string }[];
    const upd = db.prepare('UPDATE aia_sov_lines SET sortOrder = ? WHERE id = ?');
    for (const co of cos) upd.run(next++, co.id);
  });
  tx();
  return { count: prepared.length };
}

// Append a SOV line for every approved change_order that isn't already mirrored
// in the schedule of values. Idempotent — re-running adds 0.
export function syncChangeOrders(db: Database.Database, projectId: string): { added: number } {
  requireProject(db, projectId);
  let added = 0;
  const now = Date.now();
  const tx = db.transaction(() => {
    const cos = db.prepare(
      `SELECT id, number, description, amount FROM change_orders WHERE projectId = ? AND status = 'approved'`
    ).all(projectId) as { id: string; number: string | null; description: string | null; amount: number | null }[];
    const ins = db.prepare(
      'INSERT INTO aia_sov_lines (id, projectId, itemNo, description, scheduledValueCents, retainagePercent, isChangeOrder, changeOrderId, sortOrder, version, createdAt) VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?, 1, ?)'
    );
    for (const co of cos) {
      const exists = db.prepare('SELECT id FROM aia_sov_lines WHERE projectId = ? AND changeOrderId = ?').get(projectId, co.id);
      if (exists) continue;
      const amount = Number.isFinite(co.amount) ? (co.amount as number) : 0;
      const cents = Math.round(amount * 100);
      const max = (db.prepare('SELECT COALESCE(MAX(sortOrder), -1) m FROM aia_sov_lines WHERE projectId = ?').get(projectId) as any).m;
      ins.run(
        crypto.randomUUID(),
        projectId,
        'CO-' + (co.number ?? ''),
        co.description ?? '',
        cents,
        co.id,
        max + 1,
        now,
      );
      added++;
    }
  });
  tx();
  return { added };
}

// ---------------------------------------------------------------------------
// Pay applications (G702/G703)
// ---------------------------------------------------------------------------

interface PayAppInput {
  periodTo?: string | null;
  applicationDate?: string | null;
  retainagePercent?: number;
  storedRetainagePercent?: number;
}

interface PayAppPatch {
  status?: string;
  periodTo?: string | null;
  applicationDate?: string | null;
  retainagePercent?: number;
  storedRetainagePercent?: number;
  releasedRetainagePoints?: number;
}

interface PayAppLineInput {
  sovLineId: string;
  percentComplete: number;
  storedMaterialsCents: number;
}

const DEFAULT_RETAINAGE = 10;

// Validate a retainage percent that is REQUIRED (defaults applied by caller).
function requireRetainagePercent(pct: any, field: string): number {
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new ValidationError(`${field} must be a finite number between 0 and 100`);
  }
  return pct;
}

function validatePercentComplete(pct: any): number {
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new ValidationError('percentComplete must be a finite number between 0 and 100');
  }
  return pct;
}

function validateStoredMaterialsCents(cents: any): number {
  if (!Number.isInteger(cents) || !Number.isFinite(cents) || cents < 0) {
    throw new ValidationError('storedMaterialsCents must be a non-negative integer (cents)');
  }
  return cents;
}

// Create a pay application. number = MAX(number)+1 for the project (1 if none).
// Seeds a pay_app_line for every current SOV line, carrying forward the prior
// app's percentComplete + storedMaterialsCents (0/0 if no prior app / new line).
export function createPayApp(db: Database.Database, projectId: string, input: PayAppInput): { id: string; number: number } {
  requireProject(db, projectId);
  const retainagePercent = requireRetainagePercent(
    input.retainagePercent ?? DEFAULT_RETAINAGE, 'retainagePercent');
  // Single-rate world: one base rate covers work AND stored materials. The
  // stored rate is still snapshotted per app so legacy readers (and the G702's
  // separate 5a/5b lines) stay coherent, and so a caller that genuinely wants
  // a distinct historical stored rate can still send one.
  const storedRetainagePercent = requireRetainagePercent(
    input.storedRetainagePercent ?? retainagePercent, 'storedRetainagePercent');
  const id = crypto.randomUUID();
  let number = 0;
  const now = Date.now();
  const tx = db.transaction(() => {
    number = (db.prepare('SELECT COALESCE(MAX(number), 0) m FROM aia_pay_apps WHERE projectId = ?').get(projectId) as any).m + 1;
    db.prepare(
      'INSERT INTO aia_pay_apps (id, projectId, number, periodTo, applicationDate, retainagePercent, storedRetainagePercent, status, version, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)'
    ).run(id, projectId, number, input.periodTo ?? null, input.applicationDate ?? null, retainagePercent, storedRetainagePercent, 'draft', now);

    // Prior app (number-1) lines indexed by sovLineId for carry-forward.
    const prior = db.prepare('SELECT id FROM aia_pay_apps WHERE projectId = ? AND number = ?').get(projectId, number - 1) as { id: string } | undefined;
    const priorLines = new Map<string, { percentComplete: number; storedMaterialsCents: number }>();
    if (prior) {
      const rows = db.prepare('SELECT sovLineId, percentComplete, storedMaterialsCents FROM aia_pay_app_lines WHERE payAppId = ?').all(prior.id) as any[];
      for (const r of rows) priorLines.set(r.sovLineId, { percentComplete: r.percentComplete, storedMaterialsCents: r.storedMaterialsCents });
    }

    const sovLines = db.prepare('SELECT id FROM aia_sov_lines WHERE projectId = ? ORDER BY sortOrder ASC, createdAt ASC, rowid ASC').all(projectId) as { id: string }[];
    const ins = db.prepare('INSERT INTO aia_pay_app_lines (id, payAppId, sovLineId, percentComplete, storedMaterialsCents, createdAt) VALUES (?, ?, ?, ?, ?, ?)');
    for (const sov of sovLines) {
      const carry = priorLines.get(sov.id) ?? { percentComplete: 0, storedMaterialsCents: 0 };
      ins.run(crypto.randomUUID(), id, sov.id, carry.percentComplete, carry.storedMaterialsCents, now);
    }
  });
  tx();
  return { id, number };
}

export function listPayApps(db: Database.Database, projectId: string): any[] {
  return db.prepare('SELECT * FROM aia_pay_apps WHERE projectId = ? ORDER BY number ASC').all(projectId) as any[];
}

export function getPayApp(db: Database.Database, id: string): any | null {
  const app = db.prepare('SELECT * FROM aia_pay_apps WHERE id = ?').get(id) as any;
  if (!app) return null;
  const lines = db.prepare('SELECT * FROM aia_pay_app_lines WHERE payAppId = ?').all(id) as any[];
  return { ...app, lines };
}

// Version-checked (on the pay app) upsert of pay_app_lines. Validates each line,
// upserts by payAppId+sovLineId, bumps the app version.
export function savePayAppLines(db: Database.Database, payAppId: string, lines: PayAppLineInput[], version: number): { version: number } {
  if (!Array.isArray(lines)) throw new ValidationError('lines must be an array');
  if (!Number.isInteger(version) || version < 1) {
    throw new ValidationError('Missing or invalid version — reload the pay application');
  }
  // Validate every line up front so a bad line aborts before any write.
  const prepared = lines.map((l) => {
    if (typeof l.sovLineId !== 'string' || !l.sovLineId) throw new ValidationError('sovLineId is required');
    return {
      sovLineId: l.sovLineId,
      percentComplete: validatePercentComplete(l.percentComplete),
      storedMaterialsCents: validateStoredMaterialsCents(l.storedMaterialsCents),
    };
  });
  let newVersion = 0;
  const now = Date.now();
  const tx = db.transaction(() => {
    const app = db.prepare('SELECT version FROM aia_pay_apps WHERE id = ?').get(payAppId) as { version: number } | undefined;
    if (!app) throw new NotFoundError('Pay application not found');
    if (app.version !== version) throw new ConflictError(`Pay application changed since it was loaded (server v${app.version}, payload v${version})`);
    const upd = db.prepare('UPDATE aia_pay_app_lines SET percentComplete = ?, storedMaterialsCents = ? WHERE payAppId = ? AND sovLineId = ?');
    const ins = db.prepare('INSERT INTO aia_pay_app_lines (id, payAppId, sovLineId, percentComplete, storedMaterialsCents, createdAt) VALUES (?, ?, ?, ?, ?, ?)');
    for (const p of prepared) {
      const r = upd.run(p.percentComplete, p.storedMaterialsCents, payAppId, p.sovLineId);
      if (r.changes === 0) {
        ins.run(crypto.randomUUID(), payAppId, p.sovLineId, p.percentComplete, p.storedMaterialsCents, now);
      }
    }
    newVersion = app.version + 1;
    db.prepare('UPDATE aia_pay_apps SET version = ? WHERE id = ?').run(newVersion, payAppId);
  });
  tx();
  return { version: newVersion };
}

// Patch pay-app header fields; bump version. Validates retainage when supplied.
export function setPayApp(db: Database.Database, id: string, patch: PayAppPatch): { version: number } {
  if (patch.retainagePercent !== undefined) requireRetainagePercent(patch.retainagePercent, 'retainagePercent');
  if (patch.storedRetainagePercent !== undefined) requireRetainagePercent(patch.storedRetainagePercent, 'storedRetainagePercent');
  let newVersion = 0;
  const tx = db.transaction(() => {
    const app = db.prepare('SELECT * FROM aia_pay_apps WHERE id = ?').get(id) as any;
    if (!app) throw new NotFoundError('Pay application not found');
    // Released points are bounded by what earlier apps have not already
    // released — the check reads the current chain, so it runs in the tx.
    if (patch.releasedRetainagePoints !== undefined) {
      const pts = patch.releasedRetainagePoints as any;
      if (!Number.isFinite(pts) || pts < 0) {
        throw new ValidationError('releasedRetainagePoints must be a finite number of percentage points ≥ 0');
      }
      const remaining = remainingReleasablePoints(db, id);
      if (pts > remaining) {
        throw new ValidationError(`Cannot release ${pts} points — only ${remaining} remain on this application`);
      }
    }
    const status = patch.status !== undefined ? patch.status : app.status;
    const periodTo = patch.periodTo !== undefined ? patch.periodTo : app.periodTo;
    const applicationDate = patch.applicationDate !== undefined ? patch.applicationDate : app.applicationDate;
    const retainagePercent = patch.retainagePercent !== undefined ? patch.retainagePercent : app.retainagePercent;
    const storedRetainagePercent = patch.storedRetainagePercent !== undefined ? patch.storedRetainagePercent : app.storedRetainagePercent;
    const releasedRetainagePoints = patch.releasedRetainagePoints !== undefined
      ? patch.releasedRetainagePoints : app.releasedRetainagePoints;
    newVersion = app.version + 1;
    db.prepare('UPDATE aia_pay_apps SET status = ?, periodTo = ?, applicationDate = ?, retainagePercent = ?, storedRetainagePercent = ?, releasedRetainagePoints = ?, version = ? WHERE id = ?')
      .run(status, periodTo, applicationDate, retainagePercent, storedRetainagePercent, releasedRetainagePoints, newVersion, id);
  });
  tx();
  return { version: newVersion };
}

export function deletePayApp(db: Database.Database, id: string): void {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM payments WHERE targetType = 'payapp' AND targetId = ?").run(id);
    db.prepare('DELETE FROM aia_pay_app_lines WHERE payAppId = ?').run(id);
    db.prepare('DELETE FROM aia_pay_apps WHERE id = ?').run(id);
  });
  tx();
}

// ---------------------------------------------------------------------------
// G703 (continuation sheet) / G702 (application summary) computation.
// ALL money returned as INTEGER CENTS. Rounding happens PER LINE with
// Math.round — never sum-then-round in a way that drifts.
// ---------------------------------------------------------------------------

export interface G703Row {
  sovLineId: string;
  itemNo: string | null;
  description: string;
  isChangeOrder: number;
  scheduledValueCents: number;     // C
  previousCents: number;           // D
  thisPeriodCents: number;         // E
  storedCents: number;             // F
  totalToDateCents: number;        // G
  percentComplete: number;
  balanceToFinishCents: number;
  retainageCents: number;
}

// ---------------------------------------------------------------------------
// Retainage mode + releases.
//
// A release is recorded as percentage POINTS on the app that releases them.
// The effective rate on app N is base − Σ points over apps with number ≤ N,
// floored at 0, so released dollars fall out of L5, lift L6 and get paid via
// L8 — the L6/L7 chaining itself never had to change.
// ---------------------------------------------------------------------------

export type RetainageMode = 'uniform' | 'perLine';

// Read project.meta.aiaSettings.retainageMode.
//   'perLine' → per-line rates, base as the fallback for blank lines
//   'uniform' → base rate only; stray values left in the per-line column are
//               ignored, because the toggle is authoritative, not the data
//   absent    → LEGACY. Keeps today's `line ?? base` math so no historical pay
//               app silently recomputes on projects that used the per-line
//               column (it was the primary input before this rework). The
//               reported mode then follows the data: 'perLine' if any line
//               carries a rate, else 'uniform'. Saving AIA settings once
//               writes an explicit mode and pins the behavior.
function resolveRetainageMode(
  db: Database.Database, projectId: string, sovLines: any[]
): { mode: RetainageMode; legacyFallback: boolean } {
  const row = db.prepare('SELECT meta FROM projects WHERE id = ?').get(projectId) as { meta: string | null } | undefined;
  let stored: unknown;
  try { stored = row?.meta ? JSON.parse(row.meta)?.aiaSettings?.retainageMode : undefined; }
  catch { stored = undefined; } // unparseable meta must not break billing math
  if (stored === 'perLine') return { mode: 'perLine', legacyFallback: false };
  if (stored === 'uniform') return { mode: 'uniform', legacyFallback: false };
  const hasLineRates = sovLines.some(l => l.retainagePercent !== null && l.retainagePercent !== undefined);
  return { mode: hasLineRates ? 'perLine' : 'uniform', legacyFallback: true };
}

type ComputeContext = ReturnType<typeof loadComputeContext>;

// Effective retainage rate for one SOV line after cumulative releases. Uniform
// mode ignores any stray per-line value so the SOV toggle is authoritative.
function effectiveWorkPct(ctx: ComputeContext, sovLine: any): number {
  const usePerLine = ctx.mode === 'perLine' || ctx.legacyFallback;
  const base = usePerLine ? (sovLine.retainagePercent ?? ctx.app.retainagePercent) : ctx.app.retainagePercent;
  return Math.max(0, base - ctx.cumulativeReleasedPoints);
}

// New apps write storedRetainagePercent = retainagePercent, so this one rule
// covers both worlds: legacy two-rate apps (cumulative 0) compute exactly as
// before, and new apps release stored retainage at the same single rate.
function effectiveStoredPct(ctx: ComputeContext): number {
  return Math.max(0, ctx.app.storedRetainagePercent - ctx.cumulativeReleasedPoints);
}

// Points still releasable on this app BEFORE its own release — i.e. the base
// (the largest relevant base in perLine mode) less everything released on
// STRICTLY PRIOR apps. Floored at 0. "Release all remaining" sends this value.
export function remainingReleasablePoints(db: Database.Database, payAppId: string): number {
  const app = db.prepare('SELECT * FROM aia_pay_apps WHERE id = ?').get(payAppId) as any;
  if (!app) throw new NotFoundError('Pay application not found');
  const before = (db.prepare(
    'SELECT COALESCE(SUM(releasedRetainagePoints), 0) s FROM aia_pay_apps WHERE projectId = ? AND number < ?'
  ).get(app.projectId, app.number) as any).s as number;

  const sovLines = db.prepare('SELECT * FROM aia_sov_lines WHERE projectId = ?').all(app.projectId) as any[];
  const { mode, legacyFallback } = resolveRetainageMode(db, app.projectId, sovLines);
  let base = app.retainagePercent;
  if (mode === 'perLine' || legacyFallback) {
    for (const l of sovLines) {
      const rate = l.retainagePercent ?? app.retainagePercent;
      if (rate > base) base = rate;
    }
  }
  return Math.max(0, base - before);
}

// Internal: load an app + its SOV lines (in SOV sort order) joined to this app's
// pay_app_lines and the prior app's pay_app_lines, ready for column math.
function loadComputeContext(db: Database.Database, payAppId: string) {
  const app = db.prepare('SELECT * FROM aia_pay_apps WHERE id = ?').get(payAppId) as any;
  if (!app) throw new NotFoundError('Pay application not found');

  const sovLines = db.prepare('SELECT * FROM aia_sov_lines WHERE projectId = ? ORDER BY sortOrder ASC, createdAt ASC, rowid ASC').all(app.projectId) as any[];

  const thisLines = new Map<string, any>();
  for (const l of db.prepare('SELECT * FROM aia_pay_app_lines WHERE payAppId = ?').all(payAppId) as any[]) {
    thisLines.set(l.sovLineId, l);
  }

  // Prior app (number-1) — for column D (previous) per line.
  const prior = db.prepare('SELECT id FROM aia_pay_apps WHERE projectId = ? AND number = ?').get(app.projectId, app.number - 1) as { id: string } | undefined;
  const priorLines = new Map<string, any>();
  if (prior) {
    for (const l of db.prepare('SELECT * FROM aia_pay_app_lines WHERE payAppId = ?').all(prior.id) as any[]) {
      priorLines.set(l.sovLineId, l);
    }
  }

  // Retainage releases: everything released on apps up to AND INCLUDING this
  // one is already off this app's rate (same number-chaining population the
  // L6/L7 recursion walks; draft vs finalized does not affect the sum).
  const cumulativeReleasedPoints = (db.prepare(
    'SELECT COALESCE(SUM(releasedRetainagePoints), 0) s FROM aia_pay_apps WHERE projectId = ? AND number <= ?'
  ).get(app.projectId, app.number) as any).s as number;
  const { mode, legacyFallback } = resolveRetainageMode(db, app.projectId, sovLines);

  return {
    app, sovLines, thisLines, priorLines, priorId: prior?.id ?? null,
    mode, legacyFallback,
    cumulativeReleasedPoints,
    releasedThisApp: app.releasedRetainagePoints ?? 0,
  };
}

export function computeG703(db: Database.Database, payAppId: string): G703Row[] {
  const ctx = loadComputeContext(db, payAppId);
  const { sovLines, thisLines, priorLines } = ctx;
  const storedPct = effectiveStoredPct(ctx);
  const rows: G703Row[] = [];
  for (const sov of sovLines) {
    const scheduledValueCents = sov.scheduledValueCents;
    const thisLine = thisLines.get(sov.id);
    const percentComplete = thisLine ? thisLine.percentComplete : 0;
    const storedCents = thisLine ? thisLine.storedMaterialsCents : 0;

    const completedToDateCents = Math.round(scheduledValueCents * percentComplete / 100);

    const priorLine = priorLines.get(sov.id);
    const priorPercent = priorLine ? priorLine.percentComplete : 0;
    // AIA G703 col D = prior application's (D+E) = work completed only; stored materials (col F) are 'presently stored', NOT included in D. Intentional.
    const previousCents = priorLine ? Math.round(scheduledValueCents * priorPercent / 100) : 0;

    const thisPeriodCents = completedToDateCents - previousCents;
    const totalToDateCents = completedToDateCents + storedCents;
    const balanceToFinishCents = scheduledValueCents - totalToDateCents;

    const retainageCents =
      Math.round(completedToDateCents * effectiveWorkPct(ctx, sov) / 100) +
      Math.round(storedCents * storedPct / 100);

    rows.push({
      sovLineId: sov.id,
      itemNo: sov.itemNo,
      description: sov.description,
      isChangeOrder: sov.isChangeOrder,
      scheduledValueCents,
      previousCents,
      thisPeriodCents,
      storedCents,
      totalToDateCents,
      percentComplete,
      balanceToFinishCents,
      retainageCents,
    });
  }
  return rows;
}

export interface G702 {
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
  retainage: {
    mode: RetainageMode;
    baseWorkPercent: number;
    cumulativeReleasedPoints: number;  // apps ≤ N, including this app
    releasedThisApp: number;
    remainingPoints: number;           // budget BEFORE this app's own release
    effectiveWorkPercent: number | null; // null in perLine — rates differ per line
  };
}

// Compute L6 (earned less retainage) for a given pay app — used for the recursive
// L7 (less previous certificates). Returns 0 if app is missing (guard).
function computeL6(db: Database.Database, payAppId: string | null): number {
  if (!payAppId) return 0;
  const app = db.prepare('SELECT id FROM aia_pay_apps WHERE id = ?').get(payAppId) as { id: string } | undefined;
  if (!app) return 0;
  return computeG702(db, payAppId).L6earnedLessRetainageCents;
}

export function computeG702(db: Database.Database, payAppId: string): G702 {
  const ctx = loadComputeContext(db, payAppId);
  const { app, sovLines, thisLines, priorId } = ctx;
  const storedPct = effectiveStoredPct(ctx);

  let L1 = 0, L2 = 0;
  let L4 = 0;
  let L5a = 0, L5b = 0;
  let additions = 0, deductions = 0;

  for (const sov of sovLines) {
    const scheduledValueCents = sov.scheduledValueCents;
    if (sov.isChangeOrder) {
      L2 += scheduledValueCents;
      if (scheduledValueCents > 0) additions += scheduledValueCents;
      else if (scheduledValueCents < 0) deductions += scheduledValueCents;
    } else {
      L1 += scheduledValueCents;
    }

    const thisLine = thisLines.get(sov.id);
    const percentComplete = thisLine ? thisLine.percentComplete : 0;
    const storedCents = thisLine ? thisLine.storedMaterialsCents : 0;
    const completedToDateCents = Math.round(scheduledValueCents * percentComplete / 100);
    const totalToDateCents = completedToDateCents + storedCents;
    L4 += totalToDateCents;

    L5a += Math.round(completedToDateCents * effectiveWorkPct(ctx, sov) / 100);
    L5b += Math.round(storedCents * storedPct / 100);
  }

  const L3 = L1 + L2;
  const L5 = L5a + L5b;
  const L6 = L4 - L5;
  const L7 = computeL6(db, priorId);
  const L8 = L6 - L7;
  const L9 = L3 - L6;

  return {
    L1originalContractCents: L1,
    L2changeOrdersCents: L2,
    L3contractSumToDateCents: L3,
    L4totalCompletedStoredCents: L4,
    L5aRetainageWorkCents: L5a,
    L5bRetainageStoredCents: L5b,
    L5retainageCents: L5,
    L6earnedLessRetainageCents: L6,
    L7lessPreviousCents: L7,
    L8currentPaymentDueCents: L8,
    L9balanceToFinishCents: L9,
    changeOrders: { additionsCents: additions, deductionsCents: deductions, netCents: L2 },
    retainage: {
      // Report the mode the math actually used, so a legacy project holding
      // per-line rates under an absent toggle still reveals its per-line column.
      mode: ctx.mode,
      baseWorkPercent: app.retainagePercent,
      cumulativeReleasedPoints: ctx.cumulativeReleasedPoints,
      releasedThisApp: ctx.releasedThisApp,
      remainingPoints: remainingReleasablePoints(db, payAppId),
      effectiveWorkPercent: ctx.mode === 'perLine'
        ? null
        : Math.max(0, app.retainagePercent - ctx.cumulativeReleasedPoints),
    },
  };
}
