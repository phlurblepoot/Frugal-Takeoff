import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_PAGE_PNG = join(__dirname, 'assets', 'test-page.png');

// Local YYYY-MM-DD offset from today — mirrors server/customerStore.ts's
// todayStr() comparison base. Using toISOString() (UTC) here would drift a
// day off local "today" depending on timezone and time of day, so a fixture
// meant to be "yesterday" could equal today's local date and never trip the
// overdue branch.
function daysFromToday(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

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
    status: 'bidding',
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
    status: 'bidding',
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

export interface SeedTwoRevisionResult {
  projectId: string;
  name: string;
  /** The OLDER page — positionally superseded → read-only history. */
  supersededPageId: string;
  /** The NEWER page — the current, fully-editable revision. */
  currentPageId: string;
  /** The measurement id living on the superseded page. */
  supersededMeasurementId: string;
  /** The measurement id living on the current page. */
  currentMeasurementId: string;
}

/**
 * Seed a project with TWO plan sets, each contributing one page that shares the
 * same durable `sheetId`. Because they group into one logical sheet with two
 * revisions, `computeRevisionModel` marks the page from the OLDER set
 * ('superseded') and the page from the NEWER set ('current'). Each page carries
 * a single 2-point length measurement so the read-only spec can attempt to drag
 * a vertex and diff the persisted points.
 *
 * Driving the real "add plan set + revision review" UI is heavy and flaky in
 * e2e, so we construct the already-revised project shape directly via the API —
 * the same end state that flow produces. The read-only gate we're testing is
 * derived purely from this structure (2 revisions of one sheet), so this seed
 * exercises the exact code path a real revision would.
 */
export async function seedProjectWithSupersededRevision(
  request: APIRequestContext,
  token: string,
): Promise<SeedTwoRevisionResult> {
  const auth = { Authorization: `Bearer ${token}` };

  const projectId = randomUUID();
  const oldSetId = randomUUID();
  const newSetId = randomUUID();
  const sheetId = randomUUID(); // shared durable identity → one logical sheet
  const supersededPageId = randomUUID();
  const currentPageId = randomUUID();
  const oldImageId = randomUUID();
  const newImageId = randomUUID();
  const supersededMeasurementId = randomUUID();
  const currentMeasurementId = randomUUID();
  const short = projectId.slice(0, 8);
  const name = `E2E PlanSet ReadOnly ${short}`;

  const base64 = readFileSync(TEST_PAGE_PNG).toString('base64');
  const dataUrl = `data:image/png;base64,${base64}`;
  for (const id of [oldImageId, newImageId]) {
    const imgRes = await request.post('/api/images', {
      headers: auth,
      data: { id, data: dataUrl },
    });
    if (!imgRes.ok()) {
      throw new Error(`image upload failed: ${imgRes.status()} ${await imgRes.text()}`);
    }
  }

  const scaleConfig = { pixelDistance: 100, realWorldDistance: 10, unit: 'ft' };
  // Identical starting geometry on both pages so the spec's drag math is the
  // same regardless of which page it targets.
  const points = () => [
    { x: 200, y: 200 },
    { x: 500, y: 200 },
  ];

  const project = {
    id: projectId,
    name,
    createdAt: Date.now(),
    takeoffs: [],
    planSets: [
      { id: oldSetId, name: 'Rev 1', date: '2026-01-01', createdAt: Date.now() - 10_000 },
      { id: newSetId, name: 'Rev 2', date: '2026-02-01', createdAt: Date.now() },
    ],
    pages: [
      {
        id: supersededPageId,
        name: 'A-101 (Rev 1)',
        pageNumber: 'A-101',
        sheetId,
        planSetId: oldSetId,
        imageId: oldImageId,
        imageWidth: 1000,
        imageHeight: 800,
        scaleConfig,
        measurements: [
          {
            id: supersededMeasurementId,
            type: 'length',
            name: 'Wall Old',
            color: '#3b82f6',
            points: points(),
          },
        ],
      },
      {
        id: currentPageId,
        name: 'A-101 (Rev 2)',
        pageNumber: 'A-101',
        sheetId,
        planSetId: newSetId,
        imageId: newImageId,
        imageWidth: 1000,
        imageHeight: 800,
        scaleConfig,
        measurements: [
          {
            id: currentMeasurementId,
            type: 'length',
            name: 'Wall New',
            color: '#3b82f6',
            points: points(),
          },
        ],
      },
    ],
    version: 1,
    status: 'bidding',
  };

  const projRes = await request.post('/api/projects', {
    headers: auth,
    data: project,
  });
  if (!projRes.ok()) {
    throw new Error(`project create failed: ${projRes.status()} ${await projRes.text()}`);
  }

  return {
    projectId,
    name,
    supersededPageId,
    currentPageId,
    supersededMeasurementId,
    currentMeasurementId,
  };
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
    status: 'bidding',
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

export interface SeedCustomerPortfolioResult {
  customerId: string;
  customerName: string;
  biddingProjectId: string;
  biddingProjectName: string;
  bidDueDate: number;
  inProgressProjectId: string;
  inProgressProjectName: string;
  taskId: string;
  taskTitle: string;
  taskDueDate: string;
  invoiceId: string;
  invoiceNumber: string;
  invoiceAmountCents: number;
}

/**
 * Seed a full customer "portfolio" via the REST API for the customers split
 * view: one customer with (1) a bidding project carrying a bidDueDate inside
 * the 14-day attention window, (2) an in_progress project carrying one SENT,
 * UNPAID invoice (so it surfaces as `outstanding_invoice` attention + a
 * Billing-tab ledger row), and (3) a customer-level (no projectId) task due
 * YESTERDAY, so it's already overdue by construction and shows up in both
 * taskCounts.overdue and the Needs-attention feed.
 *
 * This is the minimum shape customerOverview()/customerSummaries() need to
 * exercise every tile, attention-row type, and ledger row on the customer
 * pane in one seed — see server/customerStore.ts for the exact rollup rules
 * this mirrors (archived-project exclusion doesn't apply here; nothing here
 * is archived).
 */
export async function seedCustomerWithPortfolio(
  request: APIRequestContext,
  token: string,
): Promise<SeedCustomerPortfolioResult> {
  const auth = { Authorization: `Bearer ${token}` };
  const short = randomUUID().slice(0, 8);

  const customerName = `E2E Portfolio Customer ${short}`;
  const custRes = await request.post('/api/customers', { headers: auth, data: { name: customerName } });
  if (!custRes.ok()) {
    throw new Error(`customer create failed: ${custRes.status()} ${await custRes.text()}`);
  }
  const customer = await custRes.json();
  const customerId = customer.id as string;

  // Bidding project, due in 5 days — inside the 14-day attention window and
  // not overdue.
  const biddingProjectId = randomUUID();
  const biddingProjectName = `E2E Portfolio Bidding ${short}`;
  const bidDueDate = Date.now() + 5 * 86400000;
  const p1Res = await request.post('/api/projects', {
    headers: auth,
    data: {
      id: biddingProjectId,
      name: biddingProjectName,
      createdAt: Date.now(),
      customerId,
      status: 'bidding',
      bidDueDate,
      pages: [],
      takeoffs: [],
      version: 1,
    },
  });
  if (!p1Res.ok()) {
    throw new Error(`bidding project create failed: ${p1Res.status()} ${await p1Res.text()}`);
  }

  // In-progress project that will carry the sent/unpaid invoice.
  const inProgressProjectId = randomUUID();
  const inProgressProjectName = `E2E Portfolio Active ${short}`;
  const p2Res = await request.post('/api/projects', {
    headers: auth,
    data: {
      id: inProgressProjectId,
      name: inProgressProjectName,
      createdAt: Date.now(),
      customerId,
      status: 'in_progress',
      pages: [],
      takeoffs: [],
      version: 1,
    },
  });
  if (!p2Res.ok()) {
    throw new Error(`in-progress project create failed: ${p2Res.status()} ${await p2Res.text()}`);
  }

  // A SENT invoice with one line and no payments recorded → balanceCents > 0,
  // which is what makes it show up as `outstanding_invoice` attention and a
  // Billing-tab ledger row (see server/customerStore.ts customerOverview()).
  const invoiceNumber = `INV-${short}`;
  const invoiceAmountCents = 75000; // $750.00
  const invRes = await request.post(`/api/projects/${inProgressProjectId}/invoices`, {
    headers: auth,
    data: {
      number: invoiceNumber,
      date: Date.now(),
      status: 'sent',
      lines: [{ description: 'Work performed', qty: 1, unitPrice: invoiceAmountCents / 100 }],
    },
  });
  if (!invRes.ok()) {
    throw new Error(`invoice create failed: ${invRes.status()} ${await invRes.text()}`);
  }
  const invoice = await invRes.json();

  // Customer-level task (no projectId) due yesterday — already overdue.
  // customerOverview()/customerSummaries() compare dueDate against today's
  // LOCAL date string, so this must be computed in local time (not UTC) to
  // guarantee the overdue branch regardless of time-of-day/timezone.
  const taskTitle = `E2E Portfolio Overdue Task ${short}`;
  const taskDueDate = daysFromToday(-1);
  const taskRes = await request.post('/api/tasks', {
    headers: auth,
    data: { title: taskTitle, customerId, dueDate: taskDueDate, category: 'Follow-up' },
  });
  if (!taskRes.ok()) {
    throw new Error(`task create failed: ${taskRes.status()} ${await taskRes.text()}`);
  }
  const task = await taskRes.json();

  return {
    customerId,
    customerName,
    biddingProjectId,
    biddingProjectName,
    bidDueDate,
    inProgressProjectId,
    inProgressProjectName,
    taskId: task.id,
    taskTitle,
    taskDueDate,
    invoiceId: invoice.id,
    invoiceNumber,
    invoiceAmountCents,
  };
}
