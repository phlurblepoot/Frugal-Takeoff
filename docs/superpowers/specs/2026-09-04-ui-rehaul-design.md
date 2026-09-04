# UI Rehaul — Design Spec

**Date:** 2026-09-04
**Status:** Approved by Nathan (interactive design review via visual companion, sections 1–5)
**Scope:** Full visual/interaction rehaul of Takeoff Pro. Screen-only — no data migrations, no PDF/letterhead changes, no canvas-drawing-internal changes.

---

## 1. Direction

**Glassy ambient depth** (Apple-like): accent-derived gradient scenes, frosted-glass surfaces, layered depth, springy motion. Premium = polish you can feel.

- Full ambient treatment in **both** light and dark modes (explicitly chosen over "dark-signature" and "dark-first" alternatives).
- Landing pages (dashboard / project overview / customer pane) become **informative command centers** built from a user-customizable card system.
- Rejected directions (for the record): Linear-style restraint, Stripe-style light data dashboard, bold-branded construction look.

## 2. Visual foundation

### 2.1 Tokens & materials
- Existing semantic tokens (`surface / raised / sunken / hover / edge / ink…`) **remain the API**. Their resolved values change; components keep using the same utilities.
- New **ambient scene** layer: the page background is a fixed accent-derived gradient scene — a diagonal base gradient plus 2–3 radial glow blobs, all computed in OKLCH from the user's accent hue `--h` (e.g. base `oklch(0.24 0.05 h)` → blobs at `h`, `h±25–70`). The existing accent picker (preset + custom hue) therefore restyles the whole atmosphere with zero extra UI.
- **Glass** is promoted from modal-only to the standard `raised` material: translucent fill, `backdrop-filter: blur(16px)`, 1px light border, inner top highlight, soft drop shadow. Light mode uses white-glass (`rgba(255,255,255,.6–.8)`), dark mode white-on-dark (`rgba(255,255,255,.09–.14)`).
- Typography: Inter Variable stays. Headings get tighter letter-spacing (−0.02…−0.03em) and heavier weights (650–700). Body unchanged.

### 2.2 Foundation rules (approved list)
1. One accent hue drives the entire scene; picker works app-wide.
2. Full ambient in both light and dark.
3. **Time-of-day ambience** (morning-warm / midday / dusk-cool) modulates only lightness/warmth **within the user's accent family** — never overrides the hue. Per-user preference in Settings → Preferences, **on by default, can be turned off**.
4. **Glow is rationed**: primary buttons, active nav item, progress bars. Nothing else — cards and rows never glow (continues the existing Phase-2 discipline).
5. **Glass on containers, not rows**: lists/tables put `backdrop-filter` on the wrapper; rows are plain. Budget ≈ 10–15 blurred surfaces per screen.
6. **Low-power fallback**: `prefers-reduced-transparency`, missing `backdrop-filter` support, or an explicit setting swaps glass for solid `raised` colors and flattens the scene to a subtle two-stop gradient.
7. **Chrome is still**: the sidebar and top bars never animate/react as a whole; only the controls inside them do.
8. **Uniform size-aware hover zoom (standing law):** every interactive surface soft-zooms on hover with a **pixel-constant** amount: `scale = 1 + growthPx / renderedWidth`, `growthPx ≈ 6`, always below the grid gap (11px). Small cards and full-width containers grow the same physical amount, so the material feels uniform and **overlap with neighbors is mathematically impossible**. Large surfaces add a shadow-deepen for perceptible feedback. Recomputed on resize (measure hook / ResizeObserver). *The earlier "zoom small / lift large" split was explicitly rejected.*

## 3. Motion system

Personality: **springy & alive** (chosen over "calm & seamless" and "cinematic layers").

- Library: `motion` (already a dependency; currently used in ~12 components).
- Spring character: overshoot easing (`cubic-bezier(.34,1.56,.64,1)` equivalent springs) for entrances and hover/press; press = squish (`scale ~0.97`).
- **Two-tier transitions:**
  - **Page enter** (route change): springy staggered entrance — elements rise + fade + slight scale, ~450ms total, 60–80ms stagger. Implemented with `AnimatePresence` keyed by route at the layout level.
  - **Tab / sub-view switch** (project tabs, billing tabs, etc.): light 180ms slide/fade. Feels like glancing, not arriving.
- Hover zoom per foundation rule 8; icons wiggle on hover; number tickers/chart draws per §7.
- The existing reduced-motion preference disables all entrances, wipes, tickers, and reveals.

## 4. Navigation shell

- **Global sidebar is permanent.** Opening a project no longer swaps sidebar content — the current `ProjectShellContext` register-project-into-sidebar behavior is removed.
- **Project sections move to a horizontal tab bar** under the project header (Overview · Pages · Takeoffs · Proposal · Billing · Issues · Punch · Tasks · Mail · RFIs · Daily · Time · Notes · Settings as applicable). Scrollable with hidden scrollbar on mobile. Existing nested routes and `?tab=` URL persistence preserved.
- **Unified presence in the sidebar** (new home for realtime presence):
  - Avatar stack + "N online" pill with live dot at the bottom of the sidebar.
  - Popover on click: each online user, where they are (section/page context), and a **Follow** action (existing Follow feature).
  - **Removes** the floating active-users bubble (`UserPresenceOverlay` placement) and the presence copy in the canvas right tool pane — one feature, one home. On mobile it lives in the drawer.
- Mobile shell: Phase-8 drawer + top bar pattern kept, restyled to glass/ambient.
- Login page: full ambient scene + floating glass card + springy entrance (the "wow moment").

## 5. Card system (landing pages)

### 5.1 Architecture
- **Card registry**: each card is a self-contained component declaring `{ id, title, icon, category, pageTypes: (dashboard|project|customer)[], widths: 1|2|3[], defaultWidth, dataSource }`. Cards render **adaptively per width** (e.g. 1-wide Money Pulse = number + sparkline; 3-wide = full chart).
- **Per-user layouts** stored in the existing `user_preferences` system (like `projectsSort`), one layout per **page type** — all projects share one project-overview layout; all customers share one customer layout. Synced across devices via the existing prefs sync. Schema: `{ version, cards: [{ id, width }] }` in display order.
- **Defaults** = the approved arrangements (§6). "Reset to default" always available.
- **Customize mode**: a `⚙ Customize` button on each landing page enters edit mode — cards wiggle (iOS-style), each shows: `×` remove (top corner), a **Width [1][2][3]** segmented control in a card footer bar, drag-to-reorder; desktop also gets right-edge drag-resize. An **add tray** lists library cards not on the page, grouped by category. `Done` saves; layout persists immediately.
- **Responsive grid**: column count from viewport — ≥1600px → 4 · ≥1024 → 3 · ≥640 → 2 · below → 1. **Actual span = min(user-chosen width, available columns)** — wide cards clamp automatically; no overflow, ever. Mobile renders one column in layout order; reorder via long-press.
- **Independent loading**: every card fetches its own data behind a glass skeleton; one slow card never blocks the page. Empty cards show illustrated empty states.

### 5.2 Card library (all built — "more options shouldn't hurt")
★ = in a default layout.

**Dashboard (12):** ★Needs-attention feed · ★Money pulse · ★On deck · ★Team activity · Project health cards · Mail inbox peek · Outstanding proposals · My hours this week · Payments received · Receivables aging · Quick actions · Recent documents.

**Project overview (16):** ★Financial progress bar · ★Open-items tiles · ★Recent happenings · Billed-% ring · Pay-app nudge · Current plan set · Takeoff totals · Punch progress · Photo strip · Change orders · Latest daily report · Mail threads · Key dates · Contacts · Proposal status · Documents shortcuts.

**Customer pane (8):** ★Financial rollup · ★Their projects · ★Billing aging · ★Correspondence · Payment history · Open items across projects · Related tasks · Notes.

Not selected (excluded): per-project color identity.

## 6. Landing page defaults

### 6.1 Dashboard — "Command Center"
- Greeting header ("Good morning, Nathan" + counts) + primary `+ New` action.
- Left ⅔: **⚡ Needs-attention feed** (top, prime position) — stale pay-app drafts, bids nearing due with unsent proposals, RFIs unanswered N days, overdue tasks, invoices past terms; severity dots; each row deep-links to the exact object (pay-app editor, RFI, task…). Below it: **Money pulse** — outstanding total, trend chart, billed-vs-contract %, recent payments, pay apps awaiting certification.
- Right ⅓: **📅 On deck** (tasks due + bid deadlines, nearest first) above **Team activity**.

### 6.2 Project overview — "Progress Story"
- Project header: emoji/avatar, name, stage pill, customer + location, quick actions (Email, + Action) — above the horizontal tab bar.
- **Financial progress band** (full width): contract total (incl. COs) → segmented glowing bar (paid / billed-awaiting / retainage / remaining) with legend, next-pay-app callout ("Pay app #4 in draft · $32,400").
- Below, two columns: **Open-items tiles** (issues / RFIs / punch / tasks with ages and week-trend) and **Recent happenings** (unified project timeline: mail replies, daily reports, CO approvals, photos, plan revisions, payments).

### 6.3 Customer pane
- Customers split view keeps the left list; **left list and right pane get independent scroll containers** (fixes the current linked-scroll problem).
- Pane: header (avatar, contact info, Email / + Project) → **financial rollup band** (outstanding + oldest age, lifetime billed/paid, retainage, avg days-to-pay, 0–30/31–60/60+ aging buckets) → **Their projects** (billed-% bars, open-item hints, closed projects dimmed) → **Correspondence** (recent threads with reply-state chips).

### 6.4 Aggregate endpoints (read-only; no migrations)
- `GET /api/dashboard/attention` — stale pay apps, unanswered RFIs, overdue tasks, bids closing, aging invoices (with ages + deep-link targets).
- `GET /api/dashboard/money` — outstanding, trend series, recent payments, pay apps awaiting certification.
- `GET /api/projects/:id/happenings` — unified recent-events timeline for one project.
- `GET /api/customers/:id/rollup` — customer financials + aging buckets + per-project billed %.
All computed server-side over existing tables; other cards reuse existing endpoints.

## 7. Graphics & polish pack

### 7.1 Graphics (all four approved)
- **Login wow moment** — ambient scene, floating glass card, springy entrance.
- **Illustrated empty states** — custom SVG illustrations in accent hues (blueprint/construction motifs) replacing gray placeholder text; rolled out starting with cards, then app-wide.
- **Animated numbers & charts** — money figures count up on first paint and roll on change; progress bars fill with glow; chart lines draw in.
- **Ambient depth details** — subtle scroll parallax on scene glows, soft light reflections on glass edges, faint blueprint-grid texture in page backgrounds.

### 7.2 Polish pack (14 selected)
⌘K command-palette glow-up (glass sheet, cascading results, recents) · glass skeleton shimmer → springy content replace · number tickers (incl. sidebar badges) · breathing progress (slow glow-pulse on "live" bars/rings, e.g. draft pay app) · presence personality (springy collab cursors, name tags, per-user colors; glass Follow pill) · celebration moments (bid won → confetti burst; payment received / pay app certified → green glow pulse; rare and earned) · scroll-linked reveals (once per visit) · reactive icons (hover wiggle) · time-of-day ambience (per-user pref; accent-following per rule 3) · cinematic theme wipe (radial sweep from the toggle) · springy photo lightbox (zoom-from-thumbnail, swipe, pinch) · peek hover cards (glass preview on project/customer/document links app-wide) · glass scrollbars + scroll-edge fade rails · shortcut-hints overlay (hold `?`).

## 8. Explicitly untouched

- **Canvas drawing surface**: Konva stage, measurement tools, server-op collab — zero internal changes. Only surrounding chrome (toolbars, side panels, modals) is restyled. Phone read-only / tablet drawable behavior unchanged.
- **Generated documents / PDFs**: letterhead and layouts stay as-is. Screen-only rehaul.
- **Data models & existing routes**: no migrations; new endpoints are read-only aggregates.
- **Fortune Sheet spreadsheet internals**: only the surrounding frame is restyled.

## 9. Rollout waves

Ship to `testing` per wave; app fully usable between waves; old and new styles may briefly coexist.

- **Wave 1 — Foundation & shell:** ambient scene + glass tokens + motion system + uniform hover-zoom utility + global-sidebar/project-tab-bar restructure + unified sidebar presence + login + time-of-day pref + glass scrollbars + reactive icons + theme wipe + low-power fallback.
- **Wave 2 — Card system & landing pages:** card registry (all ~30 cards) + customize mode (drag/remove/add/width/reset) + responsive clamping grid + the three default layouts + four aggregate endpoints + skeletons/tickers/animated charts + first illustrated empty states + customers independent-scroll fix.
- **Wave 3 — Propagate & delight:** restyle every remaining section (Billing, Mail, Tasks, Documents, Issues, Punch, RFIs, Daily reports, Settings, Users, Time, Templates, Share view) onto the new system + remaining polish pack (⌘K, peek cards, lightbox, celebrations, scroll reveals, breathing progress, presence cursors, shortcut overlay, empty states everywhere).

## 10. Testing & verification

- All existing unit tests (714+) and the Playwright e2e suite stay green after each wave — canvas drawing specs especially.
- Canvas-adjacent changes are verified with real Playwright click-drag + screenshots (standing project rule), never by code-reading alone.
- New e2e: customize → reload → layout persists; width clamping at three viewports; project tab-bar navigation; presence popover; **hover-zoom bounding-box assertion** (zoomed element never intersects a neighbor, checked at three element sizes).
- Reduced-motion disables all animation; reduced-transparency/low-power swaps glass for solid.
- **No secure-context APIs** (plain-HTTP LAN rule): standard DOM APIs only; ids via the `uuid` package.
- Each wave ends with a manual smoke checklist for Nathan (desktop + tablet + phone).

## 11. Design-review artifacts

Interactive mockups from the design sessions are preserved under `.superpowers/brainstorm/*/content/` (direction, theme modes, motion, dashboard/project/customer layouts, card library, polish demos, sections 1–5). They are reference material, not build targets — this spec is the source of truth.
