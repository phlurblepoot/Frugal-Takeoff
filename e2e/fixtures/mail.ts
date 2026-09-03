import type { APIRequestContext } from '@playwright/test';

// Talks to the test-only fixture routes in server/mail/routes.ts
// (`POST /api/mail/_test/seed` / `.../inject`), which only exist when the
// server is started with MAIL_FAKE_PROVIDER=1 — see playwright.config.ts's
// webServer env. Specs that need a mail account with real threads (not a
// live IMAP/OAuth mailbox) use these instead of talking to a provider.

export interface FakeAddr { addr: string; name?: string }
export interface FakeAttachment { name: string; mime: string; bytesBase64: string }
export interface FakeThreadMessage { text: string; html?: string; date?: string; attachments?: FakeAttachment[] }
export interface FakeThreadSpec { subject: string; from: FakeAddr; messages: FakeThreadMessage[] }

export interface ConnectFakeAccountResult {
  accountId: string;
  /** One threadKey per seeded thread, in the same order as `opts.threads`. */
  threadKeys: string[];
}

/**
 * Create-or-reuse a `fake`-provider mail account for the given token and seed
 * it with `opts.threads` via `POST /api/mail/_test/seed`. Threads are proper
 * References/In-Reply-To chains, so they thread the same way real mail does.
 * Throws if the request fails (including a 404 — the flag was not set).
 */
export async function connectFakeAccount(
  request: APIRequestContext,
  token: string,
  opts: { emailAddress?: string; threads?: FakeThreadSpec[] } = {},
): Promise<ConnectFakeAccountResult> {
  const res = await request.post('/api/mail/_test/seed', {
    headers: { Authorization: `Bearer ${token}` },
    data: { emailAddress: opts.emailAddress, threads: opts.threads ?? [] },
  });
  if (!res.ok()) {
    throw new Error(`connectFakeAccount failed: ${res.status()} ${await res.text()}`);
  }
  return (await res.json()) as ConnectFakeAccountResult;
}

/**
 * Inject an inbound message onto an existing thread (or chain it off a
 * specific message via `inReplyToMessageId`) of a fake account, via
 * `POST /api/mail/_test/inject`. Fire-and-forget on the server side — the
 * app learns about it through the same `mailThread` broadcast a real inbound
 * message would produce, so a spec should assert via the UI (auto-retrying),
 * not assume the reply has landed the instant this resolves.
 * Throws if the request fails.
 */
export async function injectReply(
  request: APIRequestContext,
  token: string,
  opts: {
    accountId: string;
    threadKey?: string;
    inReplyToMessageId?: string;
    from: FakeAddr;
    subject?: string;
    text: string;
    html?: string;
    attachments?: FakeAttachment[];
  },
): Promise<void> {
  const res = await request.post('/api/mail/_test/inject', {
    headers: { Authorization: `Bearer ${token}` },
    data: opts,
  });
  if (!res.ok()) {
    throw new Error(`injectReply failed: ${res.status()} ${await res.text()}`);
  }
}
