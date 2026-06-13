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
