import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_PAGE_PNG = join(__dirname, 'assets', 'test-page.png');

export interface LoginResult {
  token: string;
  user: { id: string; username: string; role: string };
}

/**
 * Log in as the bootstrap admin/admin user and return the parsed body
 * `{ token, user: { id, username, role } }`. Throws if the response is not ok.
 */
export async function login(request: APIRequestContext): Promise<LoginResult> {
  const res = await request.post('/api/auth/login', {
    data: { username: 'admin', password: 'admin' },
  });
  if (!res.ok()) {
    throw new Error(`login failed: ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as LoginResult;
  if (!body.token || !body.user) {
    throw new Error(`login response missing token/user: ${JSON.stringify(body)}`);
  }
  return body;
}

export interface SeedResult {
  projectId: string;
  pageId: string;
  imageId: string;
  name: string;
}

/**
 * Seed a project with a single page backed by a 1000x800 PNG image, via the
 * REST API. Returns the generated ids. Throws if any request fails.
 */
export async function seedProjectWithPage(
  request: APIRequestContext,
  token: string,
  opts: { withScale?: boolean } = {},
): Promise<SeedResult> {
  const auth = { Authorization: `Bearer ${token}` };

  const projectId = randomUUID();
  const pageId = randomUUID();
  const imageId = randomUUID();
  const short = projectId.slice(0, 8);
  const name = `E2E Test Project ${short}`;

  // 1. Upload the page image as a data URL.
  const base64 = readFileSync(TEST_PAGE_PNG).toString('base64');
  const dataUrl = `data:image/png;base64,${base64}`;
  const imgRes = await request.post('/api/images', {
    headers: auth,
    data: { id: imageId, data: dataUrl },
  });
  if (!imgRes.ok()) {
    throw new Error(`image upload failed: ${imgRes.status()} ${await imgRes.text()}`);
  }

  // 2. Create the project. createProject() validates: id (string), pages (array,
  //    each with an id), takeoffs (array). version is assigned server-side (1).
  const project = {
    id: projectId,
    name,
    createdAt: Date.now(),
    takeoffs: [],
    pages: [
      {
        id: pageId,
        name: 'Sheet 1',
        imageId,
        imageWidth: 1000,
        imageHeight: 800,
        measurements: [],
        scaleConfig: opts.withScale
          ? { pixelDistance: 100, realWorldDistance: 10, unit: 'ft' }
          : null,
      },
    ],
    version: 1,
    status: 'estimating',
  };
  const projRes = await request.post('/api/projects', {
    headers: auth,
    data: project,
  });
  if (!projRes.ok()) {
    throw new Error(`project create failed: ${projRes.status()} ${await projRes.text()}`);
  }

  return { projectId, pageId, imageId, name };
}

export interface SeedWithTakeoffResult extends SeedResult {
  takeoffId: string;
  takeoffName: string;
  measurementId: string;
}

/**
 * Seed a project that already contains ONE takeoff plus ONE length measurement
 * wired to it on the single page. This is the minimum shape the Print path
 * needs: buildHighlightsPdf() returns null (and handlePrint records NO printout)
 * unless some current page carries a measurement whose takeoffId is in the
 * selected set. Seeding the link directly avoids drawing on the canvas (slow)
 * while still exercising the real Print → printout-in-Proposal flow.
 *
 * The seeded takeoff renders as a row on the Takeoffs tab, so the spec can
 * select it (its checkbox) and trigger Print/Excel with no UI takeoff creation.
 */
/**
 * Seed a project whose single page carries an AREA takeoff containing a LENGTH
 * measurement. This is the exact shape that surfaces the "Edit Heights"
 * affordance in the sidebar (MeasurementItem renders it only when
 * takeoffType==='area' AND measurement.type==='length' — i.e. a wall whose
 * surface area = length × height). The normal UI path to create this is a
 * drag-drop of a length measurement into an area takeoff card, which is flaky to
 * drive via Playwright; seeding it directly lets the Heights-modal spec stay
 * deterministic.
 */
export async function seedProjectWithAreaTakeoffLength(
  request: APIRequestContext,
  token: string,
): Promise<SeedWithTakeoffResult> {
  const auth = { Authorization: `Bearer ${token}` };

  const projectId = randomUUID();
  const pageId = randomUUID();
  const imageId = randomUUID();
  const takeoffId = randomUUID();
  const measurementId = randomUUID();
  const short = projectId.slice(0, 8);
  const name = `E2E Heights Project ${short}`;
  const takeoffName = `Wall Surface ${short}`;

  const base64 = readFileSync(TEST_PAGE_PNG).toString('base64');
  const dataUrl = `data:image/png;base64,${base64}`;
  const imgRes = await request.post('/api/images', {
    headers: auth,
    data: { id: imageId, data: dataUrl },
  });
  if (!imgRes.ok()) {
    throw new Error(`image upload failed: ${imgRes.status()} ${await imgRes.text()}`);
  }

  const project = {
    id: projectId,
    name,
    createdAt: Date.now(),
    takeoffs: [
      {
        id: takeoffId,
        name: takeoffName,
        color: '#10b981',
        type: 'area',
        unit: 'ft',
      },
    ],
    pages: [
      {
        id: pageId,
        name: 'Sheet 1',
        imageId,
        imageWidth: 1000,
        imageHeight: 800,
        measurements: [
          {
            id: measurementId,
            type: 'length',
            name: 'Wall A',
            color: '#10b981',
            takeoffId,
            points: [
              { x: 100, y: 100 },
              { x: 400, y: 100 },
            ],
          },
        ],
        scaleConfig: { pixelDistance: 100, realWorldDistance: 10, unit: 'ft' },
      },
    ],
    version: 1,
    status: 'estimating',
  };
  const projRes = await request.post('/api/projects', {
    headers: auth,
    data: project,
  });
  if (!projRes.ok()) {
    throw new Error(`project create failed: ${projRes.status()} ${await projRes.text()}`);
  }

  return { projectId, pageId, imageId, name, takeoffId, takeoffName, measurementId };
}

export async function seedProjectWithTakeoffMeasurement(
  request: APIRequestContext,
  token: string,
): Promise<SeedWithTakeoffResult> {
  const auth = { Authorization: `Bearer ${token}` };

  const projectId = randomUUID();
  const pageId = randomUUID();
  const imageId = randomUUID();
  const takeoffId = randomUUID();
  const measurementId = randomUUID();
  const short = projectId.slice(0, 8);
  const name = `E2E Export Project ${short}`;
  const takeoffName = `Wall Length ${short}`;

  const base64 = readFileSync(TEST_PAGE_PNG).toString('base64');
  const dataUrl = `data:image/png;base64,${base64}`;
  const imgRes = await request.post('/api/images', {
    headers: auth,
    data: { id: imageId, data: dataUrl },
  });
  if (!imgRes.ok()) {
    throw new Error(`image upload failed: ${imgRes.status()} ${await imgRes.text()}`);
  }

  const project = {
    id: projectId,
    name,
    createdAt: Date.now(),
    takeoffs: [
      {
        id: takeoffId,
        name: takeoffName,
        color: '#3b82f6',
        type: 'length',
        unit: 'ft',
        costPerUnit: 5,
      },
    ],
    pages: [
      {
        id: pageId,
        name: 'Sheet 1',
        imageId,
        imageWidth: 1000,
        imageHeight: 800,
        // A 2-point length measurement bound to the seeded takeoff. This is what
        // makes the page eligible for the highlights PDF.
        measurements: [
          {
            id: measurementId,
            type: 'length',
            name: 'Wall A',
            color: '#3b82f6',
            takeoffId,
            points: [
              { x: 100, y: 100 },
              { x: 400, y: 100 },
            ],
          },
        ],
        // A scale so the measurement formats to a real value; not strictly
        // required for Print to produce a printout, but keeps totals sane.
        scaleConfig: { pixelDistance: 100, realWorldDistance: 10, unit: 'ft' },
      },
    ],
    version: 1,
    status: 'estimating',
  };
  const projRes = await request.post('/api/projects', {
    headers: auth,
    data: project,
  });
  if (!projRes.ok()) {
    throw new Error(`project create failed: ${projRes.status()} ${await projRes.text()}`);
  }

  return { projectId, pageId, imageId, name, takeoffId, takeoffName, measurementId };
}
