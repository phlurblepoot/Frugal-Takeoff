# Mail — Server Setup Runbook

The in-app mail client connects each user's own mailbox: **Google Workspace**,
**Microsoft 365**, or any **IMAP/SMTP** host. Google and Microsoft use OAuth,
which needs a one-time app registration by an admin (you). Generic IMAP needs
nothing on the server.

The same steps are shown inside the app at **Settings → Mail → Server setup
guide** (admin only) with the exact redirect URIs for this deployment and
copy buttons. The server also answers `GET /api/mail/setup-info` (admin) with
the same values, which is the quickest way to confirm what a deployment
actually resolved.

> **Where this stands (2026-08-30):** the server side is complete — accounts,
> OAuth, sync, push, sending. The **Settings → Mail** screens referenced below
> ship with the mail client UI; until then the same information is available
> from `GET /api/mail/setup-info` and `GET /api/mail/providers`. Delete this
> note once the UI has landed.

---

## 1. Environment variables

| Variable | Required for | Notes |
|---|---|---|
| `APP_PUBLIC_URL` | OAuth, Microsoft push | The HTTPS origin users reach the app on, e.g. `https://takeoff.example.com`. No trailing slash (a trailing one is trimmed). Redirect URIs and the Graph webhook URL are built from it. Unset, the Connect buttons answer **503** naming this variable, and Microsoft accounts poll instead of receiving push. |
| `MAIL_SECRET_KEY` | optional | 32 bytes as hex (64 chars) or base64. Encrypts stored refresh tokens / IMAP passwords (AES‑256‑GCM). **If unset, the server generates `data/mail.key` (mode 0600) on first use** — back that file up with the data directory. Losing the key only forces users to reconnect their accounts. |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | Google | From the Google Cloud OAuth client (§2). |
| `MS_OAUTH_CLIENT_ID` / `MS_OAUTH_CLIENT_SECRET` | Microsoft | From the Entra app registration (§3). |
| `MS_OAUTH_TENANT` | Microsoft (optional) | Your tenant id, or `common` (default). Use the tenant id for a single-tenant registration. |
| `MAIL_FAKE_PROVIDER=1` | dev / E2E only | Every account uses an in-memory fake provider. Never set in production. |

Testing and production each need their **own** OAuth clients (the redirect URI
is host-specific).

---

## 2. Google Workspace

1. Google Cloud Console → create/select a project → **APIs & Services → Library → enable "Gmail API"**.
2. **OAuth consent screen** → User type **Internal** (Workspace only). Internal skips Google's restricted-scope verification. *Personal @gmail.com users cannot use an Internal app; supporting them requires External + verification and is not supported by default.*
3. **Credentials → Create credentials → OAuth client ID → Web application**.
   - Authorized redirect URI: `${APP_PUBLIC_URL}/api/mail/oauth/google/callback`
   - One client per environment (testing, production).
4. Copy the client id/secret into `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`.
5. Scopes requested by the app (nothing to configure, listed for the consent screen):
   `https://www.googleapis.com/auth/gmail.modify`, `https://www.googleapis.com/auth/gmail.send`, `openid`, `email`.

Sync: Gmail history polling (every 30 s while a user has the Mail tab open, otherwise every 5 min). Pub/Sub push is not required.

---

## 3. Microsoft 365

1. Entra admin center → **App registrations → New registration**.
   - Supported account types: *Accounts in this organizational directory only* (single tenant) unless users on other tenants/personal accounts must connect.
   - Redirect URI (Web): `${APP_PUBLIC_URL}/api/mail/oauth/microsoft/callback`
2. **API permissions → Add → Microsoft Graph → Delegated**: `Mail.ReadWrite`, `Mail.Send`, `User.Read`, `offline_access`. Click **Grant admin consent** so users are not prompted.
3. **Certificates & secrets → New client secret** → copy the value (shown once).
4. Set `MS_OAUTH_CLIENT_ID` (Application (client) ID), `MS_OAUTH_CLIENT_SECRET`, and `MS_OAUTH_TENANT` (Directory (tenant) ID, or `common`).

Push: the server subscribes to Graph change notifications at
`${APP_PUBLIC_URL}/api/mail/ms/webhook` (must be reachable from the internet
over HTTPS). Microsoft validates the URL with a plain-text handshake when the
subscription is created; the subscription itself lasts two days and every sync
tick renews it once less than 12 hours are left. If `APP_PUBLIC_URL` is unset,
Microsoft accounts fall back to delta polling every 5 min.

That webhook is the only route in the app that accepts an unauthenticated POST
body. It has to be (Microsoft has no token of ours to send), so
it is narrow by construction: a notification is believed only far enough to say
"re-sync account X" — the `clientState` secret must match, the subscription id
must already belong to an account, and nothing from the payload is stored. The
route also caps the body at **256 KB** and rate-limits itself to **120
requests/min per IP**. If a reverse proxy sits in front, let this path through
unbuffered and do not strip the query string (the validation handshake arrives
as `?validationToken=…`).

---

## 4. Generic IMAP / SMTP

Nothing to configure on the server. Users add these themselves in
**Settings → Mail → Add IMAP account**: IMAP
host/port/SSL, SMTP host/port (STARTTLS or SSL), username, password (an *app
password* for providers that require one). "Test & save" verifies both.

Accounts migrated from the old per-user SMTP settings appear in status
**Needs review** with the IMAP host pre-filled from the SMTP host — open
them, correct the IMAP host if needed, and press **Test & activate**.

Push: a persistent IMAP IDLE connection on INBOX; other folders every 5 min.

---

## 5. Backups and the key file

`npm run backup` copies the whole data directory verbatim, so `app.db`,
`files/` and `mail.key` all travel together. A restore must bring `mail.key` along — without it,
stored mail credentials are unreadable and every user must reconnect (no
other data is lost).

---

## 6. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Connect Google / Microsoft buttons disabled | The provider's env vars are not set on this server (see §1). `GET /api/mail/providers` shows which are configured. |
| Connect returns to Settings with an error | `APP_PUBLIC_URL` missing or not matching the registered redirect URI; or the OAuth client id/secret is wrong. The error text names the OAuth error code. |
| "No refresh token returned" (Google) | The user had previously consented without offline access. Remove the app under Google Account → Security → Third‑party access, then connect again. |
| Account shows **Reconnect needed** (`auth_error`) | The refresh token/password was revoked or rotated. Press Reconnect (OAuth) or Edit → re-enter password (IMAP). |
| Microsoft push never arrives | `APP_PUBLIC_URL` not reachable from the internet, or a proxy strips the validation handshake / the `?validationToken=` query. The server logs subscription failures; polling still works, so the only symptom is latency. |
| Webhook returns 413 or 429 | The body cap (256 KB) or the per-IP rate limit (120/min) fired. Real Graph batches are far under both — check what else is POSTing to that path. |
| Gmail "history expired" in the log | Normal after long downtime; Gmail drops history ids it no longer holds and the account re-backfills automatically. |
| Sync stuck for one folder (IMAP) | A folder that LISTs but refuses SELECT is skipped with a warning; others continue. |
| A message's body says "still being filed" (Microsoft) | Sent copy not yet in Sent Items; it appears within the next sync. |

---

## 7. What is stored on the server

- Envelope index only (from/to/subject/date/flags/attachment names) for the
  last 180 days (extendable per account with "Load older").
- No message bodies, no attachment bytes — fetched from the provider on open.
  An attachment is stored only when a user explicitly saves it to Documents.
- Credentials sealed with the key above; never returned by any API.
