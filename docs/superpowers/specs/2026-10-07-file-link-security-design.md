# File Link Security — Design

Date: 2026-10-07
Status: Approved by Nathan (conversation)

## Problem

`GET /api/images/:id/raw` and `GET /api/images/:id/thumb` needed no login at
all ("kept public deliberately": a plain `<img src>` or a pdf.js URL can't send
the `Authorization` header). Anyone who had or guessed a file id could download
any photo or PDF, admin-only files included — invoices, payment check images
(`payment-attachment`), generated billing documents. Only signatures were
refused. Both were sent `Cache-Control: public, max-age=31536000`, so
Cloudflare or any other shared cache was allowed to keep them and serve them to
anyone.

`GET /api/files/:id/content` did ask for a login (header or `?token=`), but only
checked that someone was signed in (and that a signature was theirs), not
whether a non-admin may see that file's kind. Everywhere else the app hides the
admin-only kinds from non-admins (`NON_ADMIN_EXCLUDED_KINDS` in
`server/documents.ts`, `isAdminOnlyKind` in `server/onlyoffice/editorRoutes.ts`).
`GET /api/images/:id` (the JSON data-URL read some editors use) had the same
gap.

## Decisions (agreed with Nathan)

- **A media cookie** authenticates `<img>` and pdf.js requests, so no URL needs
  a token in it: an HttpOnly cookie holding the session's JWT, `SameSite=Lax`,
  `Secure` when the request came over HTTPS (`req.secure`, with `trust proxy`
  = Cloudflare's one hop), `Path=/api`, expiring with the JWT (24 h).
  - Set on login; cleared on logout (a new `POST /api/auth/logout`).
  - Someone signed in before this update has only the token in localStorage:
    the app trades it for the cookie as it starts
    (`POST /api/auth/media-session`, Bearer token) and holds its first render
    until that's done (3 s at most), so nobody sees broken images after
    upgrading.
  - **Only the read-only GET media routes accept it.** `authenticateToken`
    (every other route, every state-changing route) still reads the
    `Authorization` header only, so the cookie adds no CSRF exposure.
    `media-session` itself takes the header's token only, never the cookie.
  - The cookie's token is verified on every request with the same verifier as
    the realtime, mail and data routes (`verifyToken`: signature, expiry, and
    a well-formed id/username/role payload).
  - *Lax, not Strict:* Lax already keeps every other site's `<img>`, fetch and
    form from carrying it. Strict would additionally refuse a file link opened
    from an email or a text message (a top-level navigation from another
    site), which only ever shows the person a file they may see anyway.
- **One viewer check, one per-file rule** for `/api/images/:id/raw`,
  `/api/images/:id/thumb` and `/api/files/:id/content`:
  - Viewer: the first token that verifies among the `Authorization` header,
    `?token=` (kept for pdf.js/media already using it) and the media cookie.
    None → 401.
  - File: a signature only for its owner (`mayReadLibraryFile`), admin-only
    kinds only for admins (`isAdminOnlyKind`: billing kinds and document
    templates) → otherwise **404**, like the rest of the app's hidden files.
  - The same file rule now also guards `GET /api/images/:id` (header-only,
    unchanged otherwise).
- **No public exception is needed.** The login page shows the app name, and the
  company logo is stored by Settings → General as a `data:` URL inside the
  public `GET /api/settings` response — it is never a `/api/images` link. The
  PWA icons are static files in `public/icons`. No outgoing email embeds an
  `/api/images` link (letterheads are drawn into the PDFs). So every file link
  requires a sign-in; nothing is carved out.
- **Caching:** authenticated media is `Cache-Control: private` —
  `private, max-age=31536000` for `/raw` and `/thumb` (the `?v=` cache-busting
  on thumbs is unchanged), `private, no-cache` for `/content` (a new version
  replaces content under the same id). Cloudflare and shared caches never keep
  or serve them.
- **Unchanged:** share links (`/api/share/:shareId/...`, ShareView never uses
  `/api/images`), ONLYOFFICE (downloads through its own signed
  `/api/onlyoffice/file/:id?t=` links), mail attachments (`/api/mail/...?token=`).

## Design

**`server/auth.ts` (new).** `tokenAuth(secret)` returns `verifyToken` and
`authenticateToken` (moved verbatim from `server.ts`, so tests can run the real
ones). Media cookie helpers: `MEDIA_COOKIE = 'ft_media'`, `setMediaCookie`
(expiry from the token's `exp`), `clearMediaCookie`, `readMediaCookie` (no
cookie-parser dependency), `mediaViewer(req, verifyToken)`.
`registerAuthRoutes(app, { db, jwtSecret, verifyToken, loginLimiter })`:
`POST /api/auth/login` (moved from `server.ts`; now also sets the cookie),
`POST /api/auth/media-session` (Bearer → cookie; a bad token → 401 and clears
the cookie), `POST /api/auth/logout` (clears it; tokens are stateless, so
there is nothing else to revoke).

**`server/routes.ts`.** `mayViewFile(meta, viewer)` = `mayReadLibraryFile` and
(admin or not `isAdminOnlyKind`). `/raw`, `/thumb`, `/content` call
`mediaViewer` then `mayViewFile`. The thumb's fallback redirect to `/raw`
passes a `?token=` along (the cookie and a header follow a same-origin redirect
by themselves).

**Client.** `startMediaSession()` / `endMediaSession()` in
`src/utils/store.ts`. `src/main.tsx` renders the app once `startMediaSession`
settles. The sidebar's Logout and the restore screen's sign-out call
`endMediaSession` (a keepalive POST, so it survives the navigation). Logging in
needs nothing: the login response sets the cookie.

**Self-hosting.** No settings change. Behind Cloudflare the cookie is `Secure`
automatically. A different proxy must send `X-Forwarded-Proto` along with the
`X-Forwarded-For` the rate limiter already relies on. Anyone who set a Cloudflare "Cache
Everything" rule over `/api/*` should purge the cache once after updating,
since copies cached under the old `public` header could otherwise still be
served.

## Untrusted content (added in review)

The session token lives in localStorage on the app's origin, so a stored
file that could run script there could read it. Anyone can upload an SVG or
an HTML file, and anyone can email one. Every response that sends stored
bytes — `/api/images/:id/raw`, `/api/files/:id/content`, share links
(`server/shareRoutes.ts`) and mail attachments (`server/mail/routes.ts`) —
now goes through `setUntrustedContentHeaders` (`server/untrustedContent.ts`):

- `X-Content-Type-Options: nosniff` always;
- `Content-Security-Policy: sandbox; default-src 'none'; …` for anything
  that is not a passive type (image/* except SVG, application/pdf, audio/*,
  video/*). An SVG or HTML file opened from its link renders without script
  in an opaque origin; `<img>` of an SVG is unaffected, and fetch(), pdf.js
  and ONLYOFFICE read bytes, not pages. PDFs are not sandboxed: the browser's
  PDF viewer refuses to open in a sandbox and isolates a PDF's own script.

## Tests

- `server/routes.test.ts` (*file links*): no credentials or a bad token → 401
  on all three links; the header, `?token=` and the cookie each work; a
  non-admin gets 404 for `invoice` and `payment-attachment` on all three (and
  on `GET /api/images/:id`), 200 for a photo and a document; an admin gets
  both; a signature only for its owner; `Cache-Control` private; the thumb's
  redirect works with the cookie and passes a `?token=` on.
- `server/auth.test.ts` (real tokens, real `authenticateToken`): login sets the
  cookie (HttpOnly, SameSite=Lax, Path=/api, Expires = token `exp`, Secure only
  over HTTPS through the proxy), a wrong password sets none; logout clears it
  and photos stop loading; media-session sets it and refuses a missing,
  forged or expired token (clearing any old cookie) or a cookie-only request;
  the cookie is refused by state-changing routes (and by non-file GETs); an
  expired, forged or malformed cookie token is refused by the media routes; a
  non-admin's cookie gets no billing documents.
- Updated: `server/documentLibrary.test.ts` (a signature's owner can now load
  it by its image link; nobody else can), `server/onlyoffice/conversions.test.ts`
  (thumbs signed in; `private` cache header).
- Client: `src/utils/store.test.ts` (*media session*: trades the token, skips
  when signed out, never blocks start-up past the wait, logout POST is
  keepalive), `src/components/shell/Sidebar.test.tsx` (Logout clears the
  cookie and the token).
- e2e `e2e/auth.spec.ts`: links are refused signed out, work after a real
  sign-in (cookie HttpOnly/Lax//api), stop after Logout; a token-only session
  (as after upgrading) gets its photos with no 401; the name and logo stay
  readable signed out. `e2e/documents.spec.ts` and
  `e2e/printout-email-large.spec.ts` now send the header when they fetch a file
  link directly.
