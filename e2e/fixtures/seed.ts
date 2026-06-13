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
