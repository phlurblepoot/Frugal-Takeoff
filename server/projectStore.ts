import type Database from 'better-sqlite3';
import { deleteFileContent } from './fileStore';

export class ValidationError extends Error {}
export class ConflictError extends Error {}
export class NotFoundError extends Error {}

// Project lifecycle stages (spec §2). 'archived' is reachable via the
// archived flag rather than the stage dropdown, but remains a valid value.
export const PROJECT_STATUSES = [
  'estimating', 'proposal_sent', 'awarded', 'in_progress',
  'punch_list', 'complete', 'archived', 'lost',
] as const;

const parse = (s: string | null): any => (s == null ? undefined : JSON.parse(s));

// Adds key: value only when value is not null/undefined — assembly must omit
// keys the legacy JSON never had, but keep '' and 0 and false.
const put = (obj: any, key: string, value: any) => {
  if (value !== null && value !== undefined) obj[key] = value;
};

export function loadProject(db: Database.Database, id: string): any | null {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any;
  if (!row) return null;
  // Pre-normalization fallback (should not occur after migration 5, but a
  // legacy-dir import racing ahead of a re-run must not crash the API).
  if (row.data) {
    try { return { ...JSON.parse(row.data), version: row.version ?? 1, status: row.status ?? 'estimating' }; }
    catch {
      console.warn(`[projectStore] project ${id} has an unparseable legacy blob`);
      return null;
    }
  }

  const meta = parse(row.meta) ?? {};
  const project: any = { id: row.id };
  put(project, 'name', row.name);
  put(project, 'createdAt', row.createdAt);
  put(project, 'contractor', row.contractor);
  put(project, 'address', row.address);
  put(project, 'bidDueDate', row.bidDueDate);
  Object.assign(project, meta);

  const planSetRows = db.prepare('SELECT * FROM plan_sets WHERE projectId = ? ORDER BY sortOrder').all(id) as any[];
  if (planSetRows.length > 0) {
    project.planSets = planSetRows.map(ps => {
      const obj: any = { id: ps.id };
      put(obj, 'name', ps.name);
      Object.assign(obj, parse(ps.attrs) ?? {});
      return obj;
    });
  }

  const measByPage = new Map<string, any[]>();
  const measRows = db.prepare('SELECT * FROM measurements WHERE projectId = ? ORDER BY sortOrder').all(id) as any[];
  for (const m of measRows) {
    const obj: any = { id: m.id };
    put(obj, 'takeoffId', m.takeoffId);
    put(obj, 'type', m.type);
    put(obj, 'name', m.name);
    put(obj, 'color', m.color);
    obj.points = parse(m.points) ?? [];
    Object.assign(obj, parse(m.attrs) ?? {});
    if (!measByPage.has(m.pageId)) measByPage.set(m.pageId, []);
    measByPage.get(m.pageId)!.push(obj);
  }

  const pageRows = db.prepare('SELECT * FROM pages WHERE projectId = ? ORDER BY sortOrder').all(id) as any[];
  project.pages = pageRows.map(pg => {
    const obj: any = { id: pg.id };
    put(obj, 'name', pg.name);
    put(obj, 'pageNumber', pg.pageNumber);
    put(obj, 'planSetId', pg.planSetId);
    put(obj, 'imageId', pg.imageId);
    put(obj, 'thumbnailId', pg.thumbnailId);
    put(obj, 'sourcePdfFileId', pg.sourcePdfFileId);
    put(obj, 'sourcePdfPageNum', pg.sourcePdfPageNum);
    Object.assign(obj, parse(pg.attrs) ?? {});
    obj.measurements = measByPage.get(pg.id) ?? [];
    return obj;
  });

  const takeoffRows = db.prepare('SELECT * FROM takeoffs WHERE projectId = ? ORDER BY sortOrder').all(id) as any[];
  project.takeoffs = takeoffRows.map(t => {
    const obj: any = { id: t.id };
    put(obj, 'name', t.name);
    put(obj, 'color', t.color);
    put(obj, 'type', t.type);
    Object.assign(obj, parse(t.attrs) ?? {});
    return obj;
  });

  project.version = row.version;
  project.status = row.status;
  return project;
}

export function listProjects(db: Database.Database): any[] {
  const ids = db.prepare('SELECT id FROM projects ORDER BY createdAt DESC').all() as { id: string }[];
  return ids.map(r => loadProject(db, r.id)).filter(Boolean);
}

function validate(payload: any, id?: string): void {
  if (!payload || typeof payload !== 'object') throw new ValidationError('Payload must be an object');
  if (typeof payload.id !== 'string' || !payload.id) throw new ValidationError('Missing project id');
  if (id !== undefined && payload.id !== id) throw new ValidationError('Project id mismatch');
  if (payload.name !== undefined && typeof payload.name !== 'string') throw new ValidationError('name must be a string');
  if (!Array.isArray(payload.pages)) throw new ValidationError('pages must be an array');
  if (!Array.isArray(payload.takeoffs)) throw new ValidationError('takeoffs must be an array');
  if (payload.planSets !== undefined && !Array.isArray(payload.planSets)) throw new ValidationError('planSets must be an array');
  for (const pg of payload.pages) {
    if (!pg || typeof pg.id !== 'string' || !pg.id) throw new ValidationError('Every page needs an id');
    if (pg.measurements !== undefined && !Array.isArray(pg.measurements)) throw new ValidationError('measurements must be an array');
    for (const m of pg.measurements ?? []) {
      if (!m || typeof m.id !== 'string' || !m.id) throw new ValidationError('Every measurement needs an id');
      if (!Array.isArray(m.points)) throw new ValidationError('measurement points must be an array');
    }
  }
  for (const t of payload.takeoffs) {
    if (!t || typeof t.id !== 'string' || !t.id) throw new ValidationError('Every takeoff needs an id');
  }
}

// Status is intentionally sticky: once a project leaves 'estimating', legacy
// flags (submitted/accepted/archived) no longer drive it.
export function deriveStatus(meta: any, existing?: string): string {
  if (existing && existing !== 'estimating') return existing;
  if (meta.archived) return 'archived';
  if (meta.accepted) return 'awarded';
  if (meta.submitted) return 'proposal_sent';
  return 'estimating';
}

// Splits a validated legacy-shaped payload into rows. Caller wraps in a
// transaction. Never touches the files table (spec §3.3 rule 4).
export function decomposeProject(db: Database.Database, payload: any, version: number): void {
  const {
    id, name, createdAt, contractor, address, bidDueDate,
    planSets, pages, takeoffs, version: _v, status: _s, ...meta
  } = payload;

  db.prepare(`
    UPDATE projects SET name = ?, status = ?, contractor = ?, address = ?, bidDueDate = ?,
                        version = ?, updatedAt = ?, meta = ?, data = NULL
    WHERE id = ?
  `).run(
    name ?? 'Untitled',
    deriveStatus(meta, _s),
    contractor ?? null,
    address ?? null,
    typeof bidDueDate === 'number' ? bidDueDate : null,
    version,
    Date.now(),
    JSON.stringify(meta),
    id
  );

  for (const t of ['measurements', 'pages', 'takeoffs', 'plan_sets']) {
    db.prepare(`DELETE FROM ${t} WHERE projectId = ?`).run(id);
  }

  const insPlanSet = db.prepare('INSERT INTO plan_sets (id, projectId, name, sortOrder, attrs) VALUES (?, ?, ?, ?, ?)');
  (planSets ?? []).forEach((ps: any, i: number) => {
    const { id: psId, name: psName, ...rest } = ps;
    insPlanSet.run(psId, id, psName ?? null, i, JSON.stringify(rest));
  });

  const insTakeoff = db.prepare('INSERT INTO takeoffs (id, projectId, name, type, color, sortOrder, attrs) VALUES (?, ?, ?, ?, ?, ?, ?)');
  (takeoffs ?? []).forEach((t: any, i: number) => {
    const { id: tId, name: tName, type, color, ...rest } = t;
    insTakeoff.run(tId, id, tName ?? null, type ?? null, color ?? null, i, JSON.stringify(rest));
  });

  const insPage = db.prepare(`
    INSERT INTO pages (id, projectId, planSetId, name, pageNumber, sortOrder, imageId, thumbnailId, sourcePdfFileId, sourcePdfPageNum, attrs)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insMeas = db.prepare(`
    INSERT INTO measurements (id, pageId, projectId, takeoffId, type, name, color, points, sortOrder, attrs)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  (pages ?? []).forEach((pg: any, i: number) => {
    const {
      id: pgId, planSetId, name: pgName, pageNumber,
      imageId, thumbnailId, sourcePdfFileId, sourcePdfPageNum,
      measurements, ...rest
    } = pg;
    insPage.run(
      pgId, id, planSetId ?? null, pgName ?? null, pageNumber ?? null, i,
      imageId ?? null, thumbnailId ?? null, sourcePdfFileId ?? null, sourcePdfPageNum ?? null,
      JSON.stringify(rest)
    );
    (measurements ?? []).forEach((m: any, j: number) => {
      const { id: mId, takeoffId, type, name: mName, color, points, ...mrest } = m;
      insMeas.run(mId, pgId, id, takeoffId ?? null, type ?? null, mName ?? null, color ?? null,
        JSON.stringify(points ?? []), j, JSON.stringify(mrest));
    });
  });
}

export function createProject(db: Database.Database, payload: any): { version: number } {
  validate(payload);
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO projects (id, createdAt) VALUES (?, ?)')
      .run(payload.id, payload.createdAt ?? Date.now());
    decomposeProject(db, payload, 1);
  });
  tx();
  return { version: 1 };
}

export function saveProject(db: Database.Database, id: string, payload: any): { version: number } {
  validate(payload, id);
  if (!Number.isInteger(payload.version) || payload.version < 1) {
    throw new ValidationError('Missing or invalid version — reload the project and try again');
  }
  let newVersion = 0;
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT version FROM projects WHERE id = ?').get(id) as { version: number } | undefined;
    if (!row) throw new ValidationError('Project not found');
    if (row.version !== payload.version) {
      throw new ConflictError(`Project changed since it was loaded (server v${row.version}, payload v${payload.version})`);
    }
    newVersion = row.version + 1;
    decomposeProject(db, payload, newVersion);
  });
  tx();
  return { version: newVersion };
}

// Slim project rows for list/dashboard views — no page/measurement payloads.
// pageIds are included so the client can keep its "page is being edited"
// deletion guard without loading full aggregates.
export function listProjectSummaries(db: Database.Database): any[] {
  const rows = db.prepare(`
    SELECT id, name, status, contractor, address, bidDueDate, version, createdAt, updatedAt,
           COALESCE(json_extract(meta, '$.archived'), 0) AS archived
    FROM projects ORDER BY createdAt DESC
  `).all() as any[];

  const countBy = (table: string): Map<string, number> =>
    new Map(
      (db.prepare(`SELECT projectId, COUNT(*) AS c FROM ${table} GROUP BY projectId`).all() as any[])
        .map(r => [r.projectId, r.c])
    );
  const takeoffCounts = countBy('takeoffs');

  const pageIdsByProject = new Map<string, string[]>();
  for (const r of db.prepare('SELECT id, projectId FROM pages ORDER BY sortOrder').all() as any[]) {
    if (!pageIdsByProject.has(r.projectId)) pageIdsByProject.set(r.projectId, []);
    pageIdsByProject.get(r.projectId)!.push(r.id);
  }

  return rows.map(r => ({
    id: r.id,
    name: r.name ?? 'Untitled',
    status: r.status ?? 'estimating',
    contractor: r.contractor ?? null,
    address: r.address ?? null,
    bidDueDate: r.bidDueDate ?? null,
    version: r.version ?? 1,
    createdAt: r.createdAt ?? 0,
    updatedAt: r.updatedAt ?? null,
    archived: !!r.archived,
    pageCount: pageIdsByProject.get(r.id)?.length ?? 0,
    takeoffCount: takeoffCounts.get(r.id) ?? 0,
    pageIds: pageIdsByProject.get(r.id) ?? [],
  }));
}

// Explicit user action — the one place project-owned files are deleted.
export function deleteProject(db: Database.Database, dataDir: string, id: string): void {
  const fileIds = (db.prepare('SELECT id FROM files WHERE projectId = ?').all(id) as { id: string }[]).map(r => r.id);
  const tx = db.transaction(() => {
    for (const t of ['measurements', 'pages', 'takeoffs', 'plan_sets']) {
      db.prepare(`DELETE FROM ${t} WHERE projectId = ?`).run(id);
    }
    db.prepare('DELETE FROM files WHERE projectId = ?').run(id);
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  });
  tx();
  for (const fid of fileIds) deleteFileContent(dataDir, fid);
}

// Granular, version-checked field updates — the first of the spec §3.3
// "granular writes". Touches only columns + the meta.archived flag; never
// touches child tables or files.
export function patchProject(
  db: Database.Database,
  id: string,
  patch: any
): { version: number; status: string } {
  if (!patch || typeof patch !== 'object') throw new ValidationError('Payload must be an object');
  if (!Number.isInteger(patch.version) || patch.version < 1) {
    throw new ValidationError('Missing or invalid version — reload the project and try again');
  }
  const ALLOWED = ['version', 'name', 'status', 'archived', 'contractor', 'address', 'bidDueDate'];
  for (const k of Object.keys(patch)) {
    if (!ALLOWED.includes(k)) throw new ValidationError(`Unknown field: ${k}`);
  }
  if (patch.name !== undefined && (typeof patch.name !== 'string' || !patch.name.trim())) {
    throw new ValidationError('name must be a non-empty string');
  }
  if (patch.status !== undefined && !(PROJECT_STATUSES as readonly string[]).includes(patch.status)) {
    throw new ValidationError(`Invalid status: ${patch.status}`);
  }
  if (patch.archived !== undefined && typeof patch.archived !== 'boolean') {
    throw new ValidationError('archived must be a boolean');
  }
  for (const k of ['contractor', 'address'] as const) {
    if (patch[k] !== undefined && patch[k] !== null && typeof patch[k] !== 'string') {
      throw new ValidationError(`${k} must be a string or null`);
    }
  }
  if (patch.bidDueDate !== undefined && patch.bidDueDate !== null && typeof patch.bidDueDate !== 'number') {
    throw new ValidationError('bidDueDate must be a number or null');
  }

  let out = { version: 0, status: '' };
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT version, status, meta FROM projects WHERE id = ?').get(id) as
      | { version: number; status: string; meta: string | null }
      | undefined;
    if (!row) throw new NotFoundError('Project not found');
    if (row.version !== patch.version) {
      throw new ConflictError(`Project changed since it was loaded (server v${row.version}, payload v${patch.version})`);
    }
    const newVersion = row.version + 1;
    const sets: string[] = ['version = ?', 'updatedAt = ?'];
    const vals: any[] = [newVersion, Date.now()];
    for (const k of ['name', 'status', 'contractor', 'address', 'bidDueDate'] as const) {
      if (patch[k] !== undefined) {
        sets.push(`${k} = ?`);
        vals.push(patch[k]);
      }
    }
    if (patch.archived !== undefined) {
      let meta: any = {};
      try { meta = JSON.parse(row.meta || '{}'); } catch { /* keep {} */ }
      if (patch.archived) meta.archived = true;
      else delete meta.archived; // legacy shape omits the key when not archived
      sets.push('meta = ?');
      vals.push(JSON.stringify(meta));
    }
    db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    out = { version: newVersion, status: patch.status ?? row.status ?? 'estimating' };
  });
  tx();
  return out;
}
