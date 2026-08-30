# Mail Client — Plan Index

Spec: `docs/superpowers/specs/2026-08-29-mail-client-design.md`

Execute in order; each plan leaves the suite green and is committed/pushed to `testing`:

1. `2026-08-29-mail-client-1-server-foundation.md` — crypto, migration 31, account store, thread keys, provider contract + fake, sync engine/scheduler, sanitizer, `/api/mail/*`, sendService + links + item send effects, item routes rewired. **After this plan real sends only work with `MAIL_FAKE_PROVIDER=1`** — ship 1 + 2 together.
2. `2026-08-29-mail-client-2-providers-oauth.md` — IMAP/SMTP, Gmail API, Microsoft Graph providers; OAuth connect; Graph webhook + IMAP IDLE push; `docs/mail-setup.md`.
3. `2026-08-29-mail-client-3-client-ui.md` — Mail tab (three-pane inbox, thread view, composer), Settings → Mail + setup guide, item editors on the new composer + "Sent · Open thread" chip.
4. `2026-08-29-mail-client-4-rfi-reply-e2e-rollout.md` — RFI pending-reply capture (review → accept), fake-provider E2E suite, rollout docs + memory.

Shared interface contract: Plan 1 header ("Shared interface contract"). Plan 2 adds optional `startPush/stopPush` and an optional `messageIdHeader` on `send()`'s result; Plan 3 adds `GET /api/mail/providers`; Plan 4 adds `/api/mail/_test/*` under the fake flag.

Migration 31 is SUPERVISED (transforms `smtp.*` prefs into a `needs_review` mail account) — follow `migration-testing-protocol` before pulling on real data.
