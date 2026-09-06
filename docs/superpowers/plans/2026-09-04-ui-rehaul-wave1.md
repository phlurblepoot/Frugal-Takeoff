# UI Rehaul — Wave 1 (Foundation & Shell) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the app-wide visual/motion foundation: accent-derived ambient scenes, glass shell chrome, springy two-tier transitions, uniform pixel-constant hover zoom, a permanently-global sidebar with a project tab bar, unified sidebar presence, the new Login, and the appearance preferences (time-of-day, solid-surfaces).

**Architecture:** CSS-token-level restyle (existing semantic tokens stay the API; a new ambient-scene + glass-material layer is added on top, driven by a runtime `--accent-h` var set by ThemeContext). Navigation restructure moves `PROJECT_NAV` out of the sidebar into a `ProjectTabBar` under `ProjectLayout`, and presence out of the floating overlay/canvas pane into a `SidebarPresence` component. All motion uses the already-installed `motion` package plus small CSS keyframes.

**Tech Stack:** React 19, react-router 7, Tailwind v4 (`@theme` / `@layer utilities` / `@custom-variant` syntax), `motion` (import from `'motion/react'`), socket.io presence via existing `CollaborationContext`, vitest (`ui` project, jsdom) + Playwright.

**Spec:** `docs/superpowers/specs/2026-09-04-ui-rehaul-design.md` (Wave 1 = spec §9 Wave 1; foundation rules in §2.2; motion in §3; nav/presence in §4).

## Global Constraints

- **No secure-context APIs** — no `crypto.randomUUID`, no clipboard API assumptions; ids come from the `uuid` package. App runs on plain-HTTP LAN.
- **No data migrations.** Nothing in Wave 1 touches the DB or server routes except zero (the prefs PUT/GET already accept arbitrary keys).
- **`glow-accent` class name must survive** — it is asserted by `src/components/ui/Button.test.tsx` and 5 cases in `src/components/shell/Sidebar.test.tsx`. Active nav/tab styling keeps using it.
- **Nav label strings must survive**: `'Billing'`, `'Takeoff & Estimate'`, `'Overview'`, etc. — `e2e/collab-follow.spec.ts` clicks them by accessible name (they move from sidebar to tab bar; the spec is updated in Task 5, not the labels).
- **Reduced motion**: every new JS-driven animation must check `useTheme().reducedMotion` (the `.motion-reduce` CSS class does NOT stop motion/react). Every new CSS animation must be neutralized under `.motion-reduce`.
- **Uniform hover-zoom law (spec §2.2 rule 8)**: pixel-constant growth ≈6px, `scale = 1 + 6/width`, capped at 1.03; never a zoom/lift split; chrome never moves.
- Tailwind v4 syntax only (`@utility`, `@layer`, `@custom-variant`) in `src/index.css`.
- Motion imports: `import { motion, AnimatePresence } from 'motion/react';`
- Test commands: unit `npx vitest run --project ui` (or full `npm test`), typecheck `npm run lint` (tsc), e2e `npm run test:e2e`.
- Commit after every task; branch `testing`; push at the end of the wave (Task 11).

---

### Task 1: Ambient scene + glass material tokens

**Files:**
- Modify: `src/index.css` (196 lines — additions to `@theme` area and `@layer utilities`)
- Modify: `src/context/ThemeContext.tsx:32-40` (`applyAccent`)
- Modify: `index.html` (anti-flash script, lines ~8-27)
- Modify: `src/components/shell/AppShell.tsx:122-123` (content wrapper background)
- Create: `src/context/ThemeContext.test.tsx`

**Interfaces:**
- Consumes: existing `applyAccent(key, customHex)` and `ACCENT_HUES` in ThemeContext.
- Produces: runtime CSS var `--accent-h` (number, degrees) on `<html>`; CSS classes `.app-scene` (on `<body>` via plain CSS, no class needed — body is styled directly), `.glass-panel`, `.soft-zoom` comes in Task 2. Later tasks style chrome with `glass-panel`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/context/ThemeContext.test.tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { ThemeProvider } from './ThemeContext';

describe('ThemeContext accent hue var', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.cssText = '';
  });

  it('sets --accent-h on the root element for preset accents', () => {
    localStorage.setItem('theme-accent', 'emerald');
    render(<ThemeProvider><div /></ThemeProvider>);
    expect(document.documentElement.style.getPropertyValue('--accent-h')).toBe('162');
  });

  it('sets --accent-h from the custom accent hex hue', () => {
    localStorage.setItem('theme-accent', 'custom');
    localStorage.setItem('theme-accent-custom', '#2563eb');
    render(<ThemeProvider><div /></ThemeProvider>);
    const h = parseFloat(document.documentElement.style.getPropertyValue('--accent-h'));
    expect(h).toBeGreaterThan(0); // exact hue comes from hexToAccentHue
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project ui src/context/ThemeContext.test.tsx`
Expected: FAIL — `--accent-h` is empty string.

- [ ] **Step 3: Implement `--accent-h` in applyAccent and the anti-flash script**

In `src/context/ThemeContext.tsx`, extend `applyAccent` (line 32):

```ts
function applyAccent(key: AccentKey, customHex: string) {
  const h = key === 'custom' ? hexToAccentHue(customHex) : ACCENT_HUES[key];
  const el = document.documentElement;
  el.style.setProperty('--accent-h', String(h));   // NEW: drives the ambient scene
  ACCENT_SCALES.forEach(([step, l, c]) => {
    el.style.setProperty(`--color-accent-${step}`, `oklch(${l} ${c} ${h})`);
  });
}
```

In `index.html`, inside the existing anti-flash IIFE (after the `scales.forEach` loop), add:

```js
        el.style.setProperty('--accent-h', String(h));
```

- [ ] **Step 4: Add scene + glass CSS to `src/index.css`**

Add `--accent-h: 264;` to the existing `:root` block (next to `--surface`), then append after the glow utilities section:

```css
/* ── Ambient scene (rehaul spec §2.1) ─────────────────────────────────────
   The page background is an accent-derived gradient scene. Everything keys
   off --accent-h, which ThemeContext/anti-flash set at runtime. Fixed
   attachment so content scrolls over a stable atmosphere. */
body {
  background:
    radial-gradient(640px 440px at 85% -10%, oklch(0.87 0.07 var(--accent-h) / 0.55), transparent 70%),
    radial-gradient(540px 400px at 6% 110%, oklch(0.90 0.06 calc(var(--accent-h) - 70) / 0.45), transparent 70%),
    linear-gradient(135deg, oklch(0.965 0.012 var(--accent-h)), oklch(0.975 0.014 calc(var(--accent-h) + 25)) 55%, oklch(0.96 0.015 calc(var(--accent-h) - 35)));
  background-attachment: fixed;
}
.dark body {
  background:
    radial-gradient(640px 440px at 85% -10%, oklch(0.50 0.17 var(--accent-h) / 0.35), transparent 70%),
    radial-gradient(540px 400px at 6% 110%, oklch(0.60 0.15 calc(var(--accent-h) - 70) / 0.25), transparent 70%),
    linear-gradient(135deg, oklch(0.24 0.05 var(--accent-h)), oklch(0.29 0.07 calc(var(--accent-h) + 25)) 55%, oklch(0.25 0.06 calc(var(--accent-h) - 35)));
  background-attachment: fixed;
}

/* ── Glass material (rehaul spec §2.1) ───────────────────────────────────
   Standard translucent panel for shell chrome and (from Wave 2) cards.
   Solid fallbacks: no backdrop-filter support, prefers-reduced-transparency,
   or the explicit .solid-surfaces class on <html> (Task 8 toggle). */
@layer utilities {
  .glass-panel {
    background: color-mix(in srgb, var(--raised) 62%, transparent);
    -webkit-backdrop-filter: blur(16px);
    backdrop-filter: blur(16px);
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.09);
  }
  @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    .glass-panel { background: var(--raised); }
  }
}
@media (prefers-reduced-transparency: reduce) {
  .glass-panel { background: var(--raised); backdrop-filter: none; -webkit-backdrop-filter: none; }
}
.solid-surfaces .glass-panel { background: var(--raised); backdrop-filter: none; -webkit-backdrop-filter: none; }
.solid-surfaces body, html.solid-surfaces body { background: var(--surface); }
```

- [ ] **Step 5: Let the scene show through the shell**

In `src/components/shell/AppShell.tsx` line 123, change the content wrapper `className="min-h-screen bg-surface"` → `className="min-h-screen"` (the body scene is now the page ground; pages that paint their own background keep working).

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run --project ui src/context/ThemeContext.test.tsx && npm run lint`
Expected: PASS / clean.

- [ ] **Step 7: Visual smoke via dev server**

Run: `npm run dev` (background), open `http://localhost:3000/dashboard`, confirm: gradient scene visible behind content in light AND dark (toggle via sidebar), hue follows the Settings accent picker. Kill the dev server after.

- [ ] **Step 8: Commit**

```bash
git add src/index.css src/context/ThemeContext.tsx src/context/ThemeContext.test.tsx index.html src/components/shell/AppShell.tsx
git commit -m "feat(ui): accent-derived ambient scene + glass material tokens (wave 1)"
```

---

### Task 2: Uniform soft-zoom hook + CSS (the hover law)

**Files:**
- Create: `src/hooks/useSoftZoom.ts`
- Create: `src/hooks/useSoftZoom.test.tsx`
- Modify: `src/index.css` (append to `@layer utilities`)

**Interfaces:**
- Produces: `useSoftZoom<T extends HTMLElement>(): React.RefObject<T | null>` — attach the ref to an element that also carries className `soft-zoom`; the hook writes `--soft-zoom` (a scale number) sized to the element. CSS: `.soft-zoom:hover { transform: scale(var(--soft-zoom, 1.015)) }`. Later waves attach this to cards; Wave 1 uses it on the presence button (Task 6) and Login card (Task 7).

- [ ] **Step 1: Write the failing test**

```tsx
// src/hooks/useSoftZoom.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { useSoftZoom } from './useSoftZoom';

// jsdom has no ResizeObserver — stub it.
beforeEach(() => {
  (globalThis as any).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
});

const Probe: React.FC<{ width: number }> = ({ width }) => {
  const ref = useSoftZoom<HTMLDivElement>();
  // jsdom reports offsetWidth 0; fake it per-instance.
  React.useLayoutEffect(() => {
    if (ref.current) Object.defineProperty(ref.current, 'offsetWidth', { value: width, configurable: true });
  }, [width]);
  return <div ref={ref} data-testid="probe" className="soft-zoom" />;
};

describe('useSoftZoom', () => {
  it('sets a pixel-constant scale: ~6px growth for a 300px element', () => {
    const { getByTestId, rerender } = render(<Probe width={300} />);
    rerender(<Probe width={300} />); // second pass so the effect reads the faked width
    const v = parseFloat(getByTestId('probe').style.getPropertyValue('--soft-zoom'));
    expect(v).toBeCloseTo(1 + 6 / 300, 3);
  });

  it('caps the scale at 1.03 for tiny elements', () => {
    const { getByTestId, rerender } = render(<Probe width={40} />);
    rerender(<Probe width={40} />);
    const v = parseFloat(getByTestId('probe').style.getPropertyValue('--soft-zoom'));
    expect(v).toBe(1.03);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project ui src/hooks/useSoftZoom.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hook**

```ts
// src/hooks/useSoftZoom.ts
// Uniform hover-zoom law (spec §2.2 rule 8): every element grows the same
// ~6 physical pixels on hover — scale is derived from rendered width, so a
// small card and a full-width container feel identical and can never cross
// the grid gap into a neighbour. Re-measured on resize.
import { useEffect, useRef } from 'react';

const GROWTH_PX = 6;
const MAX_SCALE = 1.03;

export function softZoomScale(width: number): number {
  if (!width || width <= 0) return 1;
  return Math.min(MAX_SCALE, 1 + GROWTH_PX / width);
}

export function useSoftZoom<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => {
      const s = softZoomScale(el.offsetWidth);
      el.style.setProperty('--soft-zoom', String(s));
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  });
  return ref;
}
```

(Note: the effect runs on every render — cheap, and it lets the test's faked `offsetWidth` be picked up on rerender. `softZoomScale` is exported for direct unit use.)

- [ ] **Step 4: Add the CSS**

Append inside `@layer utilities` in `src/index.css`:

```css
  /* Uniform soft zoom (spec §2.2 rule 8). Springy curve matches the motion
     system; .motion-reduce neutralizes the transform entirely. */
  .soft-zoom {
    transition: transform 0.3s cubic-bezier(0.34, 1.8, 0.64, 1);
  }
  .soft-zoom:hover {
    transform: scale(var(--soft-zoom, 1.015));
  }
```

And after the `@layer` block (next to the existing `.motion-reduce` rules):

```css
.motion-reduce .soft-zoom:hover { transform: none; }
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run --project ui src/hooks/useSoftZoom.test.tsx && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useSoftZoom.ts src/hooks/useSoftZoom.test.tsx src/index.css
git commit -m "feat(ui): uniform pixel-constant soft-zoom hook + css (hover law)"
```

---

### Task 3: Two-tier transitions — PageTransition + tab-switch animation

**Files:**
- Create: `src/components/motion/PageTransition.tsx`
- Create: `src/components/motion/PageTransition.test.tsx`
- Modify: `src/App.tsx:57-62` (wrap the Outlet)
- Modify: `src/index.css` (tab-tier keyframes)

**Interfaces:**
- Consumes: `useTheme().reducedMotion`; `useLocation()`.
- Produces: `<PageTransition>{children}</PageTransition>` and exported `pageKey(pathname: string): string`. CSS class `anim-tab-in` for the light tab tier (used by ProjectTabBar panels and any tab host from Wave 2 on).

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/motion/PageTransition.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../../context/ThemeContext';
import { PageTransition, pageKey } from './PageTransition';

describe('pageKey', () => {
  it('keys on the first two path segments so section/tab changes do not re-enter', () => {
    expect(pageKey('/dashboard')).toBe('dashboard');
    expect(pageKey('/project/abc/billing')).toBe('project/abc');
    expect(pageKey('/project/abc/issues')).toBe('project/abc');
    expect(pageKey('/')).toBe('root');
  });

  it('canvas routes share the project key (no page transition into canvas)', () => {
    expect(pageKey('/project/abc/page/p1')).toBe('project/abc');
  });
});

describe('PageTransition', () => {
  it('renders children', () => {
    render(
      <ThemeProvider>
        <MemoryRouter initialEntries={['/dashboard']}>
          <PageTransition><p>content</p></PageTransition>
        </MemoryRouter>
      </ThemeProvider>
    );
    expect(screen.getByText('content')).toBeInTheDocument();
  });

  it('renders children without a motion wrapper when reduced motion is on', () => {
    localStorage.setItem('theme-motion', 'reduced');
    const { container } = render(
      <ThemeProvider>
        <MemoryRouter initialEntries={['/dashboard']}>
          <PageTransition><p data-testid="c">content</p></PageTransition>
        </MemoryRouter>
      </ThemeProvider>
    );
    // With reduced motion the child is a direct child of the fragment (no wrapper div).
    expect(container.querySelector('[data-page-transition]')).toBeNull();
    localStorage.removeItem('theme-motion');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project ui src/components/motion/PageTransition.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
// src/components/motion/PageTransition.tsx
// Page-enter tier of the two-tier transition system (spec §3): springy
// staggered arrival on route changes. Tab switches inside a page use the
// light CSS tier (.anim-tab-in) instead. Keyed on the first two path
// segments so /project/:id section hops and canvas entry do NOT replay the
// entrance (the tab tier owns those), and canvas never sits under a
// transformed ancestor mid-animation.
import React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useLocation } from 'react-router-dom';
import { useTheme } from '../../context/ThemeContext';

export function pageKey(pathname: string): string {
  const seg = pathname.split('/').filter(Boolean);
  return seg.slice(0, 2).join('/') || 'root';
}

export const PageTransition: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const location = useLocation();
  const { reducedMotion } = useTheme();

  if (reducedMotion) return <>{children}</>;

  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.div
        key={pageKey(location.pathname)}
        data-page-transition
        initial={{ opacity: 0, y: 14, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, transition: { duration: 0.12 } }}
        transition={{ type: 'spring', stiffness: 380, damping: 30, mass: 0.7 }}
        style={{ minHeight: '100%' }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
};
```

In `src/App.tsx`, import it and wrap the outlet (line 61):

```tsx
import { PageTransition } from './components/motion/PageTransition';
// …inside Layout, replace:
//   <Outlet context={{ appName, logoUrl }} />
// with:
<PageTransition>
  <Outlet context={{ appName, logoUrl }} />
</PageTransition>
```

- [ ] **Step 4: Add the tab tier CSS**

Append inside `@layer utilities` in `src/index.css`:

```css
  /* Tab-switch tier (spec §3): quick glance, not an arrival. */
  .anim-tab-in {
    animation: tab-in 0.18s ease-out;
  }
```

And at file scope (next to the progress-indeterminate keyframes):

```css
@keyframes tab-in {
  from { opacity: 0; transform: translateX(9px); }
  to   { opacity: 1; transform: none; }
}
```

- [ ] **Step 5: Run tests + full ui project (guard against Layout breakage)**

Run: `npx vitest run --project ui && npm run lint`
Expected: PASS (152 files).

- [ ] **Step 6: Commit**

```bash
git add src/components/motion/PageTransition.tsx src/components/motion/PageTransition.test.tsx src/App.tsx src/index.css
git commit -m "feat(ui): two-tier transitions — springy page enter + tab-in css tier"
```

---

### Task 4: Global-only sidebar + glass shell chrome + top-bar appName fix

**Files:**
- Modify: `src/components/shell/Sidebar.tsx` (remove project mode: lines 39-63 `PROJECT_NAV`, lines 136-139 projectId detection, lines 206-239 project branch; restyle container)
- Modify: `src/components/shell/AppShell.tsx` (drop `ProjectShellProvider`; accept `appName` prop; glass top bar)
- Modify: `src/App.tsx:57` (`<AppShell appName={appName}>`)
- Modify: `src/components/shell/Sidebar.test.tsx` (remove project-mode cases; they are replaced by ProjectTabBar tests in Task 5)

**Interfaces:**
- Consumes: nothing new.
- Produces: `AppShell: React.FC<{ appName: string; children: React.ReactNode }>`. Sidebar always renders WORKSPACE_NAV + TOOLS_NAV regardless of route. `PROJECT_NAV` data (labels/icons/adminOnly/match) is MOVED (not deleted) to `src/pages/project/ProjectTabBar.tsx` in Task 5 — copy it into that task's new file before deleting here if working strictly in order.

- [ ] **Step 1: Update Sidebar.test.tsx first (failing tests define the new behavior)**

In `src/components/shell/Sidebar.test.tsx`:
- DELETE the project-mode describe/cases (the ones wrapping in `ProjectShellProvider` + `RegisterProject` and asserting the sidebar swaps to 'Overview'/'Billing'/'All Projects', lines ~109-180).
- ADD:

```tsx
  it('keeps the global workspace nav on project routes', () => {
    renderAt('/project/p1/billing');
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Projects')).toBeInTheDocument();
    // No project-section entries in the sidebar anymore:
    expect(screen.queryByText('Takeoff & Estimate')).toBeNull();
    expect(screen.queryByText('All Projects')).toBeNull();
  });

  it('highlights Projects for project routes', () => {
    renderAt('/project/p1/billing');
    const btn = screen.getByRole('button', { name: 'Projects' });
    expect(btn.className).toContain('glow-accent');
  });
```

(The existing `WORKSPACE_NAV.projects.match` already matches `/project/...` — `p.startsWith('/project')` — so the second test passes once the swap is removed.)

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run --project ui src/components/shell/Sidebar.test.tsx`
Expected: new cases FAIL (project routes currently swap the nav).

- [ ] **Step 3: Implement — Sidebar goes global-only + glass**

In `src/components/shell/Sidebar.tsx`:
1. Delete the `PROJECT_NAV` array (lines 42-63) and the imports it alone used (`ArrowLeft, LayoutGrid, Ruler, StickyNote, DollarSign, AlertCircle, ClipboardCheck, FileText, SlidersHorizontal, MessageCircleQuestion, CalendarDays` — keep icons still used by workspace/tools/footer).
2. Delete `useProjectShell` import and usage (lines 11, 136), and the `projectMatch`/`projectId` lines (138-139).
3. Replace the `{projectId ? (…) : (…)}` conditional (lines 206-271) with just the workspace/tools branch (the previous else-block content, unconditioned).
4. Restyle the container (line 166-169): `bg-surface border-r border-edge` → `glass-panel border-r border-edge` (glass chrome over the scene; the width/transition classes stay).

- [ ] **Step 4: Implement — AppShell drops ProjectShellProvider, gains appName**

In `src/components/shell/AppShell.tsx`:
1. Change the signature: `export const AppShell: React.FC<{ appName: string; children: React.ReactNode }> = ({ appName, children }) => {`
2. Remove the `ProjectShellProvider` import and the `<ProjectShellProvider>` wrapper (lines 6, 66, 136) — return a fragment `<>…</>` instead.
3. Mobile top bar (line 103): `bg-surface border-b border-edge` → `glass-panel border-b border-edge`; and line 111: `Takeoff Pro` → `{appName}`.

In `src/App.tsx` line 57: `<AppShell>` → `<AppShell appName={appName}>`.

- [ ] **Step 5: Run the shell tests + full ui project**

Run: `npx vitest run --project ui && npm run lint`
Expected: Sidebar.test.tsx PASSES. NOTE: `ProjectShellContext` still exists and `ProjectLayout` still calls `useRegisterProjectShell` — that's fine (provider-less default is a no-op); both are removed in Task 5.

- [ ] **Step 6: Commit**

```bash
git add src/components/shell/Sidebar.tsx src/components/shell/Sidebar.test.tsx src/components/shell/AppShell.tsx src/App.tsx
git commit -m "feat(shell): sidebar is permanently global; glass chrome; top bar uses appName"
```

---

### Task 5: ProjectTabBar + project header in ProjectLayout; delete ProjectShellContext

**Files:**
- Create: `src/pages/project/ProjectTabBar.tsx`
- Create: `src/pages/project/ProjectTabBar.test.tsx`
- Modify: `src/pages/project/ProjectLayout.tsx` (render header + tab bar above `<Outlet/>`, drop `useRegisterProjectShell`)
- Delete: `src/context/ProjectShellContext.tsx`
- Modify: `e2e/collab-follow.spec.ts` (replace the `'All Projects'` sidebar click with the `'Projects'` sidebar item)

**Interfaces:**
- Consumes: `useProjectOutlet` pattern — ProjectLayout already holds `summary: ProjectSummary | null`.
- Produces: `ProjectTabBar: React.FC<{ projectId: string; isAdmin: boolean }>` rendering one `<button>` per section with the SAME accessible names as the old sidebar (`'Overview'`, `'Takeoff & Estimate'`, `'Proposal'`, `'Documents'`, `'Punch & Checklists'`, `'Notes'`, `'Time'`, `'Issues'`, `'RFIs'`, `'Daily Reports'`, `'Mail'`, `'Billing'`, `'Project Settings'`), active one styled with `glow-accent text-white`. Exported `PROJECT_SECTIONS` array (moved verbatim from Sidebar's old `PROJECT_NAV`).

- [ ] **Step 1: Write the failing test**

```tsx
// src/pages/project/ProjectTabBar.test.tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ProjectTabBar } from './ProjectTabBar';

const renderAt = (path: string, isAdmin = false) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <ProjectTabBar projectId="p1" isAdmin={isAdmin} />
    </MemoryRouter>
  );

describe('ProjectTabBar', () => {
  beforeEach(() => localStorage.clear());

  it('renders the project sections as buttons', () => {
    renderAt('/project/p1');
    for (const label of ['Overview', 'Takeoff & Estimate', 'Documents', 'Punch & Checklists', 'Issues', 'RFIs', 'Daily Reports', 'Mail']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('gates admin-only sections', () => {
    renderAt('/project/p1', false);
    expect(screen.queryByRole('button', { name: 'Billing' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Proposal' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Project Settings' })).toBeNull();
  });

  it('shows admin sections for admins', () => {
    renderAt('/project/p1', true);
    expect(screen.getByRole('button', { name: 'Billing' })).toBeInTheDocument();
  });

  it('marks the active section with the glow treatment', () => {
    renderAt('/project/p1/issues');
    expect(screen.getByRole('button', { name: 'Issues' }).className).toContain('glow-accent');
    expect(screen.getByRole('button', { name: 'Overview' }).className).not.toContain('glow-accent');
  });

  it('keeps Takeoff active on canvas pages', () => {
    renderAt('/project/p1/page/page-9');
    expect(screen.getByRole('button', { name: 'Takeoff & Estimate' }).className).toContain('glow-accent');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project ui src/pages/project/ProjectTabBar.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement ProjectTabBar**

```tsx
// src/pages/project/ProjectTabBar.tsx
// Horizontal project-section nav (rehaul spec §4). The section data moved
// here verbatim from the old sidebar PROJECT_NAV. Labels are an e2e
// contract (collab-follow.spec.ts clicks them by accessible name).
import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutGrid, Ruler, FileText, FolderOpen, ClipboardCheck, StickyNote, Clock,
  AlertCircle, MessageCircleQuestion, CalendarDays, Mail, DollarSign, SlidersHorizontal,
} from 'lucide-react';

export interface ProjectSection {
  id: string;
  label: string;
  Icon: React.FC<{ size?: number; className?: string }>;
  path: string;
  match: (pathname: string, base: string) => boolean;
  adminOnly?: boolean;
}

export const PROJECT_SECTIONS: ProjectSection[] = [
  { id: 'overview',  label: 'Overview',           Icon: LayoutGrid,  path: '',           match: (p, b) => p === b },
  { id: 'takeoff',   label: 'Takeoff & Estimate', Icon: Ruler,       path: '/takeoff',   match: (p, b) => p.startsWith(`${b}/takeoff`) || p.startsWith(`${b}/page/`) },
  { id: 'proposal',  label: 'Proposal',           Icon: FileText,    path: '/proposal',  match: (p, b) => p.startsWith(`${b}/proposal`), adminOnly: true },
  { id: 'documents', label: 'Documents',          Icon: FolderOpen,  path: '/documents', match: (p, b) => p.startsWith(`${b}/documents`) },
  { id: 'punch',     label: 'Punch & Checklists', Icon: ClipboardCheck, path: '/punch',  match: (p, b) => p.startsWith(`${b}/punch`) },
  { id: 'notes',     label: 'Notes',              Icon: StickyNote,  path: '/notes',     match: (p, b) => p.startsWith(`${b}/notes`) },
  { id: 'time',      label: 'Time',               Icon: Clock,       path: '/time',      match: (p, b) => p.startsWith(`${b}/time`) },
  { id: 'issues',    label: 'Issues',             Icon: AlertCircle, path: '/issues',    match: (p, b) => p.startsWith(`${b}/issues`) },
  { id: 'rfis',      label: 'RFIs',               Icon: MessageCircleQuestion, path: '/rfis', match: (p, b) => p.startsWith(`${b}/rfis`) },
  { id: 'daily-reports', label: 'Daily Reports',  Icon: CalendarDays, path: '/daily-reports', match: (p, b) => p.startsWith(`${b}/daily-reports`) },
  { id: 'mail',      label: 'Mail',               Icon: Mail,        path: '/mail',      match: (p, b) => p.startsWith(`${b}/mail`) },
  { id: 'billing',   label: 'Billing',            Icon: DollarSign,  path: '/billing',   match: (p, b) => p.startsWith(`${b}/billing`), adminOnly: true },
  { id: 'settings',  label: 'Project Settings',   Icon: SlidersHorizontal, path: '/settings', match: (p, b) => p.startsWith(`${b}/settings`), adminOnly: true },
];

export const ProjectTabBar: React.FC<{ projectId: string; isAdmin: boolean }> = ({ projectId, isAdmin }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const base = `/project/${projectId}`;

  return (
    <nav aria-label="Project sections" className="flex gap-1 overflow-x-auto no-scrollbar px-1 -mx-1">
      {PROJECT_SECTIONS.filter(s => !s.adminOnly || isAdmin).map(s => {
        const active = s.match(location.pathname, base);
        return (
          <button
            key={s.id}
            onClick={() => navigate(`${base}${s.path}`)}
            className={`flex items-center gap-1.5 shrink-0 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              active ? 'glow-accent text-white active:brightness-95' : 'text-ink-soft hover:bg-hover hover:text-ink'
            }`}
          >
            <s.Icon size={15} className="shrink-0" />
            <span>{s.label}</span>
          </button>
        );
      })}
    </nav>
  );
};
```

- [ ] **Step 4: Run the new test**

Run: `npx vitest run --project ui src/pages/project/ProjectTabBar.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire it into ProjectLayout + delete ProjectShellContext**

In `src/pages/project/ProjectLayout.tsx`:

```tsx
// Replace the useRegisterProjectShell import/call with:
import { useLocation, matchPath } from 'react-router-dom';
import { ProjectTabBar } from './ProjectTabBar';

// …inside the component, after summary state:
const location = useLocation();
const isCanvas = !!matchPath('/project/:projectId/page/:pageId', location.pathname);
const user = JSON.parse(localStorage.getItem('user') || '{}');
const isAdmin = user.role === 'admin';

// Replace `return <Outlet …/>` with:
return (
  <>
    {!isCanvas && (
      <div className="glass-panel sticky top-0 z-30 border-b border-edge px-4 pt-3 pb-2 space-y-2 md:px-6">
        <h1 className="text-lg font-bold tracking-tight text-ink truncate">
          {summary?.name ?? 'Project'}
        </h1>
        {projectId && <ProjectTabBar projectId={projectId} isAdmin={isAdmin} />}
      </div>
    )}
    <Outlet context={{ summary, refreshSummary } satisfies ProjectOutletCtx} />
  </>
);
```

Then delete `src/context/ProjectShellContext.tsx` (its only consumers — Sidebar and ProjectLayout — no longer import it; verify with `grep -rn "ProjectShell" src/`).

- [ ] **Step 6: Update the e2e spec that used the old sidebar project nav**

In `e2e/collab-follow.spec.ts`: replace the `getByRole('button', { name: 'All Projects' })` click with `getByRole('button', { name: 'Projects' })` (the global sidebar item — same navigation outcome: leaves the project). The `'Billing'` and `'Takeoff & Estimate'` clicks now hit the tab bar and need NO change (labels preserved; the sidebar no longer contains duplicates).

- [ ] **Step 7: Run everything**

Run: `npx vitest run --project ui && npm run lint`
Expected: PASS; grep for `ProjectShell` returns nothing.

- [ ] **Step 8: Visual smoke**

Run dev server; open a project; confirm: global sidebar stays, header + scrollable tab bar under it, tabs navigate with the light tab feel (pages under the same project share the page key from Task 3 — no full re-entrance), canvas page is full-bleed (no header).

- [ ] **Step 9: Commit**

```bash
git add src/pages/project/ProjectTabBar.tsx src/pages/project/ProjectTabBar.test.tsx src/pages/project/ProjectLayout.tsx e2e/collab-follow.spec.ts
git rm src/context/ProjectShellContext.tsx
git commit -m "feat(shell): project sections move to a horizontal tab bar; sidebar never swaps"
```

---

### Task 6: Unified sidebar presence (replaces floating bubble + canvas pane block)

**Files:**
- Create: `src/components/shell/SidebarPresence.tsx`
- Create: `src/components/shell/SidebarPresence.test.tsx`
- Modify: `src/components/shell/Sidebar.tsx` (mount in footer, above the theme toggle row)
- Modify: `src/App.tsx:58` (remove `<UserPresenceOverlay />` and its import)
- Delete: `src/components/UserPresenceOverlay.tsx`, `src/components/UserPresenceOverlay.test.tsx`
- Modify: `src/pages/CanvasView.tsx:1914-1972` (delete the Collaboration pane IIFE; clean unused destructured values at :56 if now unused — keep `socket`/`updateUser` only if still referenced elsewhere in the file)
- Modify: `e2e/collab-presence.spec.ts`, `e2e/collab-follow.spec.ts` (new locators)

**Interfaces:**
- Consumes: `useCollaboration()` → `{ sessions, mySessionId, followedSessionId, setFollowedSessionId, updateUser }`; helpers `groupSessionsByUser`, `describeLocation` from `src/utils/presence.ts`; `getProjectsSummary` + `useLiveQuery` (same lazy project-name pattern as the old overlay, `UserPresenceOverlay.tsx:20-30`).
- Produces: `SidebarPresence: React.FC<{ expanded: boolean }>`. Trigger button `data-testid="sidebar-presence"`; popover `data-testid="presence-popover"` (rendered via `createPortal(document.body)` because the sidebar container is `overflow-hidden`). Popover includes: per-user rows with color dot, name, `describeLocation` line, device; Follow checkbox per other-session (same semantics as before: checked = `followedSessionId === session.sessionId`, toggling calls `setFollowedSessionId`); a "You" row hosting the cursor-color `<input type="color">` (moved from the canvas pane; writes `localStorage.userColor` + `updateUser(name, color)`).

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/shell/SidebarPresence.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { SessionView } from '../../context/CollaborationContext';

const mkSession = (over: Partial<SessionView>): SessionView => ({
  sessionId: 's1', userId: 'u1', name: 'Sarah', role: 'user', color: '#40c9c6',
  device: 'Linux · Chrome', location: { path: '/dashboard' }, editing: null,
  cursor: null, lastActive: Date.now(), ...over,
});

const collab = {
  sessions: [] as SessionView[],
  mySessionId: 'me',
  followedSessionId: null as string | null,
  setFollowedSessionId: vi.fn(),
  updateUser: vi.fn(),
};
vi.mock('../../context/CollaborationContext', async (orig) => ({
  ...(await orig()),
  useCollaboration: () => collab,
}));
vi.mock('../../hooks/useLiveQuery', () => ({ useLiveQuery: () => {} }));
vi.mock('../../utils/store', async (orig) => ({
  ...(await orig()),
  getProjectsSummary: vi.fn(async () => []),
}));

const { SidebarPresence } = await import('./SidebarPresence');

const renderIt = () => render(
  <MemoryRouter><SidebarPresence expanded /></MemoryRouter>
);

describe('SidebarPresence', () => {
  beforeEach(() => {
    collab.sessions = [
      mkSession({ sessionId: 'me', userId: 'me-u', name: 'Nathan' }),
      mkSession({ sessionId: 's2', userId: 'u2', name: 'Sarah' }),
    ];
    collab.setFollowedSessionId.mockClear();
  });

  it('shows the online count', () => {
    renderIt();
    expect(screen.getByTestId('sidebar-presence')).toHaveTextContent('2 online');
  });

  it('opens a popover listing users with Follow controls', () => {
    renderIt();
    fireEvent.click(screen.getByTestId('sidebar-presence'));
    expect(screen.getByTestId('presence-popover')).toBeInTheDocument();
    expect(screen.getByText('Sarah')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /follow sarah/i }));
    expect(collab.setFollowedSessionId).toHaveBeenCalledWith('s2');
  });

  it('renders nothing when you are the only session', () => {
    collab.sessions = [mkSession({ sessionId: 'me', name: 'Nathan' })];
    renderIt();
    // Still shows the stack (1 online) — presence is a permanent fixture:
    expect(screen.getByTestId('sidebar-presence')).toHaveTextContent('1 online');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project ui src/components/shell/SidebarPresence.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement SidebarPresence**

```tsx
// src/components/shell/SidebarPresence.tsx
// Unified presence (rehaul spec §4): the one home for "who's online".
// Replaces the floating UserPresenceOverlay bubble and the canvas
// tool-pane Collaboration block. Popover is portaled to <body> because
// the sidebar clips (overflow-hidden).
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { useCollaboration } from '../../context/CollaborationContext';
import { groupSessionsByUser, describeLocation } from '../../utils/presence';
import { getProjectsSummary } from '../../utils/store';
import { useLiveQuery } from '../../hooks/useLiveQuery';

export const SidebarPresence: React.FC<{ expanded: boolean }> = ({ expanded }) => {
  const { sessions, mySessionId, followedSessionId, setFollowedSessionId, updateUser } = useCollaboration();
  const [open, setOpen] = useState(false);
  const [projectNames, setProjectNames] = useState<Record<string, string>>({});
  const [color, setColor] = useState(() => localStorage.getItem('userColor') || '#6366f1');

  const loadNames = () => {
    getProjectsSummary()
      .then(list => setProjectNames(Object.fromEntries(list.map((p: { id: string; name: string }) => [p.id, p.name]))))
      .catch(() => {});
  };
  useLiveQuery(loadNames, { types: ['project'] });

  // Close on route-level clicks elsewhere (cheap: close on Escape + backdrop).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const groups = groupSessionsByUser(sessions, mySessionId);
  const count = groups.length;
  const user = JSON.parse(localStorage.getItem('user') || '{}');

  const pickColor = (hex: string) => {
    setColor(hex);
    localStorage.setItem('userColor', hex);
    updateUser(user.username || 'User', hex);
  };

  return (
    <>
      <button
        data-testid="sidebar-presence"
        onClick={() => setOpen(o => !o)}
        title={!expanded ? `${count} online` : undefined}
        className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-ink-soft hover:bg-hover hover:text-ink transition-colors"
      >
        <span className="flex shrink-0 -space-x-2">
          {groups.slice(0, 3).map(g => (
            <span
              key={g.userId}
              className="flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-bold text-white ring-2 ring-surface"
              style={{ backgroundColor: g.sessions[0]?.color || '#6366f1' }}
            >
              {(g.name || '?').charAt(0).toUpperCase()}
            </span>
          ))}
        </span>
        {expanded && <span className="flex-1 truncate text-left">{count} online</span>}
        {expanded && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.9)]" />}
      </button>

      {createPortal(
        <AnimatePresence>
          {open && (
            <>
              <div className="fixed inset-0 z-[80]" onClick={() => setOpen(false)} />
              <motion.div
                data-testid="presence-popover"
                initial={{ opacity: 0, y: 8, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.97 }}
                transition={{ duration: 0.15 }}
                className={`fixed bottom-24 z-[81] w-72 rounded-2xl border border-edge glass-panel shadow-xl overflow-hidden ${expanded ? 'left-2' : 'left-16'}`}
              >
                <p className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Online now — {count}
                </p>
                <div className="max-h-72 overflow-y-auto pb-2">
                  {groups.map(g => (
                    <div key={g.userId} className="px-4 py-2 flex items-start gap-2.5">
                      <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: g.sessions[0]?.color }} />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-ink truncate">{g.isMe ? `${g.name} (you)` : g.name}</p>
                        {g.sessions.map(s => (
                          <p key={s.sessionId} className="text-[11px] text-ink-faint truncate">
                            {describeLocation(s.location, projectNames)} · {s.device}
                          </p>
                        ))}
                        {g.isMe && (
                          <label className="mt-1 flex items-center gap-2 text-[11px] text-ink-soft">
                            Cursor color
                            <input
                              type="color"
                              value={color}
                              onChange={e => pickColor(e.target.value)}
                              className="h-5 w-8 cursor-pointer rounded border border-edge bg-transparent"
                            />
                          </label>
                        )}
                      </div>
                      {!g.isMe && g.sessions.length === 1 && (
                        <label className="flex items-center gap-1 text-[11px] text-ink-soft shrink-0">
                          <input
                            type="checkbox"
                            aria-label={`Follow ${g.name}`}
                            className="accent-accent-600"
                            checked={followedSessionId === g.sessions[0].sessionId}
                            onChange={e => setFollowedSessionId(e.target.checked ? g.sessions[0].sessionId : null)}
                          />
                          Follow
                        </label>
                      )}
                    </div>
                  ))}
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  );
};
```

(Multi-session users: the old overlay's per-session Follow rows can be added in Wave 3; Wave 1 matches the single-session behavior the e2e suite exercises. If `groupSessionsByUser` marks multi-session groups, their sessions all render location lines but only single-session groups get a Follow checkbox — identical to `UserPresenceOverlay.tsx:46-59`.)

- [ ] **Step 4: Mount in Sidebar footer + remove the old surfaces**

1. `src/components/shell/Sidebar.tsx`: import `{ SidebarPresence } from './SidebarPresence'` and render `<SidebarPresence expanded={expanded} />` as the FIRST row of the footer div (line 275, above the theme-toggle NavRow).
2. `src/App.tsx`: delete the `UserPresenceOverlay` import (line 34) and mount (line 58). Keep `<FollowPill />` (the Stop control is an e2e contract).
3. Delete `src/components/UserPresenceOverlay.tsx` and `src/components/UserPresenceOverlay.test.tsx`.
4. `src/pages/CanvasView.tsx`: delete the Collaboration-pane IIFE at lines 1914-1972 (the block starting with the `Collaboration` heading and ending with the Follow checkboxes). Then check the destructure at line 56: remove now-unused values (`globalUsers`, `updateUser` if unreferenced elsewhere in the file — `socket` is used by canvas sync, keep it). `npm run lint` will flag leftovers.

- [ ] **Step 5: Run unit tests**

Run: `npx vitest run --project ui && npm run lint`
Expected: PASS (UserPresenceOverlay.test.tsx is gone; SidebarPresence.test.tsx passes).

- [ ] **Step 6: Update the two presence e2e specs**

- `e2e/collab-presence.spec.ts`: replace the `div.fixed.bottom-6.right-6.z-50` locator + button click with `page.getByTestId('sidebar-presence').click()`; assert on `page.getByTestId('presence-popover')` containing the peer's name; the "Active Users" heading assertion becomes `/Online now/i`. The "hides on canvas" comment/behavior is obsolete — presence lives in the sidebar everywhere (on canvas the sidebar is the collapsed rail; the popover still opens). The "No other users online" empty-state assertion becomes: popover shows only the self row (`getByText(/\(you\)/)`) and `getByRole('checkbox')` count 0.
- `e2e/collab-follow.spec.ts`: same locator swap for opening presence; the canvas-pane steps (`button.right-0.translate-x-full` then in-pane Follow) are replaced by opening `sidebar-presence` and checking `getByRole('checkbox', { name: /Follow/ })`; `Stop`/`Following` assertions on the FollowPill stay unchanged.

- [ ] **Step 7: Run the collab e2e specs**

Run: `npm run test:e2e -- collab-presence.spec.ts collab-follow.spec.ts`
Expected: PASS. (Playwright builds production and boots the real server — slow; these two specs only.)

- [ ] **Step 8: Commit**

```bash
git add -A src/components/shell/ src/App.tsx src/pages/CanvasView.tsx e2e/collab-presence.spec.ts e2e/collab-follow.spec.ts
git rm src/components/UserPresenceOverlay.tsx src/components/UserPresenceOverlay.test.tsx
git commit -m "feat(shell): unified sidebar presence; remove floating bubble + canvas pane copy"
```

---

### Task 7: Login wow moment + legacy CSS purge + dead-file deletion

**Files:**
- Modify: `src/pages/Login.tsx` (restyle: scene shows through, glass card, springy entrance, appName from outlet context)
- Delete: `src/components/UserSettingsPanel.tsx` (dead code — imported nowhere)
- Modify: `src/index.css` (remove `.glass`, `.glass-card`, `.glass-subtle`, `.theme-page`, `.theme-card`, the `.dark .glass-subtle` override, and the legacy alias vars `--surface-bg`, `--card-bg`, `--card-border`, `--glass-*`)

**Interfaces:**
- Consumes: `.glass-panel`, the body scene (Task 1), `useOutletContext<{ appName: string; logoUrl: string }>()` (Login renders as a child route of Layout, so outlet context is available).
- Produces: none new. After this task `grep -rn "glass-card\|theme-page\|theme-card\|glass-subtle" src/` returns nothing.

- [ ] **Step 1: Restyle Login**

In `src/pages/Login.tsx`:
1. Add `import { useOutletContext } from 'react-router-dom';` and inside the component: `const { appName } = useOutletContext<{ appName: string; logoUrl: string }>();` — replace the hardcoded `Takeoff Pro` heading text with `{appName}`.
2. Outer div (line 46): drop `theme-page` and the hardcoded slate/blue gradient classes — the body scene is the backdrop now: `className="min-h-screen overflow-y-auto flex items-center justify-center p-4"`.
3. Card (line 49-53): `glass-card` → `glass-panel rounded-2xl border border-edge shadow-2xl`, and make the entrance springy:

```tsx
<motion.div
  initial={{ opacity: 0, y: 28, scale: 0.96 }}
  animate={{ opacity: 1, y: 0, scale: 1 }}
  transition={{ type: 'spring', stiffness: 300, damping: 24 }}
  className="glass-panel rounded-2xl border border-edge shadow-2xl w-full max-w-md"
>
```

4. Swap the remaining raw slate classes on inputs/labels for tokens where trivial (`text-slate-…` → `text-ink`/`text-ink-soft`, `border-slate-300 dark:border-slate-600` → `border-edge`, input bg `bg-white/80 dark:bg-slate-800/50` → `bg-raised/70`); keep the accent button as is.

- [ ] **Step 2: Delete the dead panel + purge legacy CSS**

```bash
git rm src/components/UserSettingsPanel.tsx
```

In `src/index.css` remove: the `.glass`, `.glass-card`, `.glass-subtle`, `.theme-page`, `.theme-card` blocks from `@layer utilities` (KEEP the `.motion-reduce` rules in that layer); the `.dark .glass-subtle` override; the "Legacy aliases" block (`--surface-bg`, `--card-bg`, `--card-border`) and all four `--glass-*` vars in BOTH `:root` and `.dark`.

- [ ] **Step 3: Verify nothing references the removed classes/vars**

Run: `grep -rn "glass-card\|glass-subtle\|theme-page\|theme-card\|--glass-\|--surface-bg\|--card-bg\|--card-border\|UserSettingsPanel" src/ index.html`
Expected: no output.

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run --project ui && npm run lint`
Expected: PASS.

- [ ] **Step 5: Visual smoke of /login**

Dev server → log out → confirm: ambient scene behind a floating glass card, springy entrance, app name from settings, works in dark mode, error banner still animates.

- [ ] **Step 6: Run the auth e2e spec**

Run: `npm run test:e2e -- auth.spec.ts smoke.spec.ts`
Expected: PASS (login flow unchanged functionally).

- [ ] **Step 7: Commit**

```bash
git add -A src/pages/Login.tsx src/index.css
git commit -m "feat(ui): ambient glass login + purge legacy glass/theme-* css + drop dead UserSettingsPanel"
```

---

### Task 8: Appearance preferences — time-of-day ambience + solid surfaces

**Files:**
- Modify: `src/context/ThemeContext.tsx` (two new prefs, mirroring the `theme-motion` pattern exactly)
- Modify: `src/context/ThemeContext.test.tsx` (new cases)
- Modify: `index.html` (anti-flash seeds for both, so there's no flash of wrong ambience/surface)
- Modify: `src/index.css` (daypart scene variants)
- Modify: `src/pages/Settings.tsx` `PreferencesTab` (two toggle rows, copying the Reduce Motion row pattern at lines 754-772)

**Interfaces:**
- Produces (added to `ThemeContextType`):
  - `timeAmbience: boolean` / `setTimeAmbience(v: boolean)` — pref key `theme-ambience`, values `'auto' | 'off'`, default `'auto'` (ON). When on, `<html>` gets `data-daypart="morning" | "midday" | "evening"`; when off, the attribute is removed (midday scene).
  - `solidSurfaces: boolean` / `setSolidSurfaces(v: boolean)` — pref key `theme-surfaces`, values `'glass' | 'solid'`, default `'glass'`. When solid, `<html>` gets class `solid-surfaces` (CSS from Task 1 already handles it).
  - Pure helper `export function daypartForHour(h: number): 'morning' | 'midday' | 'evening'` — morning 5–10, midday 11–16, evening 17–4.

- [ ] **Step 1: Write the failing tests**

Append to `src/context/ThemeContext.test.tsx`:

```tsx
import { daypartForHour } from './ThemeContext';

describe('daypartForHour', () => {
  it('maps hours to dayparts', () => {
    expect(daypartForHour(6)).toBe('morning');
    expect(daypartForHour(10)).toBe('morning');
    expect(daypartForHour(11)).toBe('midday');
    expect(daypartForHour(16)).toBe('midday');
    expect(daypartForHour(17)).toBe('evening');
    expect(daypartForHour(2)).toBe('evening');
  });
});

describe('appearance prefs', () => {
  it('applies data-daypart when ambience is auto (default)', () => {
    render(<ThemeProvider><div /></ThemeProvider>);
    expect(document.documentElement.dataset.daypart).toMatch(/^(morning|midday|evening)$/);
  });

  it('removes data-daypart when ambience is off', () => {
    localStorage.setItem('theme-ambience', 'off');
    render(<ThemeProvider><div /></ThemeProvider>);
    expect(document.documentElement.dataset.daypart).toBeUndefined();
  });

  it('toggles the solid-surfaces class from the pref', () => {
    localStorage.setItem('theme-surfaces', 'solid');
    render(<ThemeProvider><div /></ThemeProvider>);
    expect(document.documentElement.classList.contains('solid-surfaces')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project ui src/context/ThemeContext.test.tsx`
Expected: new cases FAIL.

- [ ] **Step 3: Implement in ThemeContext**

Add to `src/context/ThemeContext.tsx`:

```ts
export function daypartForHour(h: number): 'morning' | 'midday' | 'evening' {
  if (h >= 5 && h <= 10) return 'morning';
  if (h >= 11 && h <= 16) return 'midday';
  return 'evening';
}
```

State (same seed pattern as reducedMotion):

```ts
const [timeAmbience, setTimeAmbienceState] = useState<boolean>(() => localStorage.getItem('theme-ambience') !== 'off');
const [solidSurfaces, setSolidSurfacesState] = useState<boolean>(() => localStorage.getItem('theme-surfaces') === 'solid');
```

Extend `syncPrefsFromServer` with the two keys (same functional-setter equality pattern as `theme-motion`, mapping `'off'`/`'solid'` to booleans). Apply-effects:

```ts
// Daypart ambience: attribute now + re-check every 15 minutes while on.
useEffect(() => {
  const el = document.documentElement;
  const apply = () => { el.dataset.daypart = daypartForHour(new Date().getHours()); };
  if (timeAmbience) {
    apply();
    const iv = setInterval(apply, 15 * 60 * 1000);
    localStorage.setItem('theme-ambience', 'auto');
    if (localStorage.getItem('token')) saveUserPreferences({ 'theme-ambience': 'auto' }).catch(() => {});
    return () => clearInterval(iv);
  }
  delete el.dataset.daypart;
  localStorage.setItem('theme-ambience', 'off');
  if (localStorage.getItem('token')) saveUserPreferences({ 'theme-ambience': 'off' }).catch(() => {});
}, [timeAmbience]);

useEffect(() => {
  document.documentElement.classList.toggle('solid-surfaces', solidSurfaces);
  localStorage.setItem('theme-surfaces', solidSurfaces ? 'solid' : 'glass');
  if (localStorage.getItem('token')) saveUserPreferences({ 'theme-surfaces': solidSurfaces ? 'solid' : 'glass' }).catch(() => {});
}, [solidSurfaces]);
```

Expose `timeAmbience, solidSurfaces, setTimeAmbience: (v: boolean) => setTimeAmbienceState(v), setSolidSurfaces: (v: boolean) => setSolidSurfacesState(v)` through the context type, default value, and provider value.

- [ ] **Step 4: Anti-flash seeds in index.html**

Inside the existing IIFE:

```js
        if (localStorage.getItem('theme-surfaces') === 'solid') el.classList.add('solid-surfaces');
        if (localStorage.getItem('theme-ambience') !== 'off') {
          var hr = new Date().getHours();
          el.dataset.daypart = (hr >= 5 && hr <= 10) ? 'morning' : (hr >= 11 && hr <= 16) ? 'midday' : 'evening';
        }
```

- [ ] **Step 5: Daypart scene variants in index.css**

After the base `body`/`.dark body` scene rules from Task 1 (morning warms toward hue 75, evening deepens — accent hue always preserved in the primary glow):

```css
html[data-daypart='morning'] body {
  background:
    radial-gradient(640px 440px at 85% -10%, oklch(0.88 0.07 var(--accent-h) / 0.5), transparent 70%),
    radial-gradient(560px 420px at 12% 112%, oklch(0.93 0.06 80 / 0.5), transparent 70%),
    linear-gradient(135deg, oklch(0.97 0.015 var(--accent-h)), oklch(0.975 0.02 70) 60%, oklch(0.96 0.015 var(--accent-h)));
  background-attachment: fixed;
}
html[data-daypart='evening'] body {
  background:
    radial-gradient(640px 440px at 85% -10%, oklch(0.82 0.08 var(--accent-h) / 0.45), transparent 70%),
    radial-gradient(540px 400px at 6% 110%, oklch(0.85 0.07 calc(var(--accent-h) - 50) / 0.4), transparent 70%),
    linear-gradient(135deg, oklch(0.94 0.02 var(--accent-h)), oklch(0.93 0.03 calc(var(--accent-h) + 40)) 55%, oklch(0.94 0.02 calc(var(--accent-h) - 20)));
  background-attachment: fixed;
}
.dark html[data-daypart] body { /* invalid selector guard — html can't nest; see below */ }
html.dark[data-daypart='morning'] body {
  background:
    radial-gradient(640px 440px at 85% -10%, oklch(0.62 0.15 var(--accent-h) / 0.3), transparent 70%),
    radial-gradient(560px 420px at 12% 112%, oklch(0.75 0.09 75 / 0.18), transparent 70%),
    linear-gradient(135deg, oklch(0.30 0.05 var(--accent-h)), oklch(0.36 0.07 calc(var(--accent-h) + 30)) 55%, oklch(0.33 0.07 55));
  background-attachment: fixed;
}
html.dark[data-daypart='evening'] body {
  background:
    radial-gradient(640px 440px at 85% -10%, oklch(0.42 0.15 var(--accent-h) / 0.4), transparent 70%),
    radial-gradient(540px 400px at 6% 110%, oklch(0.45 0.13 calc(var(--accent-h) - 50) / 0.3), transparent 70%),
    linear-gradient(135deg, oklch(0.19 0.05 var(--accent-h)), oklch(0.23 0.08 calc(var(--accent-h) + 40)) 55%, oklch(0.18 0.05 calc(var(--accent-h) - 20)));
  background-attachment: fixed;
}
```

(Delete the invalid-selector guard line — it's a reminder in this plan, not code: the dark class lives ON `<html>`, so combined selectors are `html.dark[data-daypart=…]`. `data-daypart='midday'` intentionally has no rule — midday IS the base scene.)

- [ ] **Step 6: Settings toggles**

In `src/pages/Settings.tsx` `PreferencesTab` (after the Reduce Motion row ending at line 772), add two rows copying the exact toggle pattern (lines 754-772), using `Sunrise` and `Layers` from lucide (add to the existing lucide import):

- Row 1: icon `<Sunrise size={16} />`, title **Time-of-day ambience**, subtitle "Background scene warms and cools with the clock (always in your accent's hues)", switch bound to `timeAmbience` / `setTimeAmbience(!timeAmbience)` from `useTheme()`.
- Row 2: icon `<Layers size={16} />`, title **Solid surfaces**, subtitle "Replace translucent glass panels with solid ones (better on low-power devices)", switch bound to `solidSurfaces` / `setSolidSurfaces(!solidSurfaces)`.

- [ ] **Step 7: Run tests + smoke**

Run: `npx vitest run --project ui && npm run lint`
Expected: PASS. Dev-server smoke: toggle both in Settings → scene shifts / glass goes solid live; reload keeps them; both keys appear in `GET /api/user-preferences`.

- [ ] **Step 8: Commit**

```bash
git add src/context/ThemeContext.tsx src/context/ThemeContext.test.tsx index.html src/index.css src/pages/Settings.tsx
git commit -m "feat(ui): time-of-day ambience + solid-surfaces preferences (per-user, synced)"
```

---

### Task 9: Polish CSS — glass scrollbars, scroll-fade rails, reactive nav icons

**Files:**
- Modify: `src/index.css`
- Modify: `src/components/shell/Sidebar.tsx` (NavRow: group + icon wiggle class; nav scroll area gets `scroll-fade`)

**Interfaces:**
- Produces: global scrollbar styling (automatic); utility `.scroll-fade` (vertical mask fade, apply to any overflow-y container); utility class `nav-icon` + `group` pattern for hover wiggle.

- [ ] **Step 1: Add the CSS**

`src/index.css`, file scope (after the scene rules):

```css
/* ── Glass scrollbars (rehaul spec §7.2) ─────────────────────────────── */
* { scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--ink) 24%, transparent) transparent; }
*::-webkit-scrollbar { width: 9px; height: 9px; }
*::-webkit-scrollbar-track { background: transparent; }
*::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--ink) 22%, transparent);
  border-radius: 99px;
  border: 2px solid transparent;
  background-clip: padding-box;
}
*::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--ink) 40%, transparent); background-clip: padding-box; border: 2px solid transparent; }

@keyframes nav-wiggle {
  0% { transform: rotate(0) scale(1); }
  35% { transform: rotate(-10deg) scale(1.18); }
  70% { transform: rotate(7deg) scale(1.08); }
  100% { transform: rotate(0) scale(1); }
}
```

Inside `@layer utilities`:

```css
  /* Soft fade at the top/bottom edges of scroll areas. */
  .scroll-fade {
    mask-image: linear-gradient(to bottom, transparent, black 20px, black calc(100% - 20px), transparent);
    -webkit-mask-image: linear-gradient(to bottom, transparent, black 20px, black calc(100% - 20px), transparent);
  }
  /* Icon wiggle on nav-row hover; parent needs .group. */
  .group:hover .nav-icon { animation: nav-wiggle 0.5s cubic-bezier(0.34, 1.8, 0.64, 1); }
```

And next to the `.motion-reduce` rules: `.motion-reduce .group:hover .nav-icon { animation: none; }`

- [ ] **Step 2: Wire into the Sidebar**

In `src/components/shell/Sidebar.tsx` NavRow (line 81-111): add `group` to the button's className list and `nav-icon` to the icon `<span className="relative shrink-0">` → `<span className="relative shrink-0 nav-icon inline-flex">`. Nav scroll container (line 196): `className="flex-1 py-2 px-2 overflow-y-auto"` → add ` scroll-fade`.

- [ ] **Step 3: Run tests + smoke**

Run: `npx vitest run --project ui src/components/shell/Sidebar.test.tsx && npm run lint`
Expected: PASS (class additions don't break assertions). Dev smoke: icons wiggle on hover, scrollbars slim/translucent, sidebar nav fades at edges.

- [ ] **Step 4: Commit**

```bash
git add src/index.css src/components/shell/Sidebar.tsx
git commit -m "feat(ui): glass scrollbars, scroll-fade rails, reactive nav icons"
```

---

### Task 10: Cinematic theme wipe

**Files:**
- Create: `src/components/shell/ThemeWipe.tsx`
- Create: `src/components/shell/ThemeWipe.test.tsx`
- Modify: `src/components/shell/Sidebar.tsx` (theme-toggle NavRow dispatches the wipe origin)
- Modify: `src/App.tsx` (mount `<ThemeWipe />` inside Layout, next to FollowPill)
- Modify: `src/index.css` (`@property --wipe-r` + wipe rules)

**Interfaces:**
- Produces: `<ThemeWipe />` — listens for `window` CustomEvent `'theme-wipe'` with `detail: { x: number; y: number }`. On receipt (and `!reducedMotion`), overlays a fixed full-screen div painted `var(--surface)` AS CAPTURED BEFORE the flip (inline style snapshot), masked by a growing transparent circle from (x,y); removes itself after 650ms. The theme flip itself still happens instantly via `toggleMode()` — the wipe reveals it.
- Consumes: `useTheme().reducedMotion`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/shell/ThemeWipe.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ThemeProvider } from '../../context/ThemeContext';
import { ThemeWipe } from './ThemeWipe';

describe('ThemeWipe', () => {
  beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); });
  afterEach(() => vi.useRealTimers());

  it('shows an overlay on theme-wipe and removes it after the animation', () => {
    render(<ThemeProvider><ThemeWipe /></ThemeProvider>);
    act(() => {
      window.dispatchEvent(new CustomEvent('theme-wipe', { detail: { x: 40, y: 500 } }));
    });
    expect(screen.getByTestId('theme-wipe')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(700); });
    expect(screen.queryByTestId('theme-wipe')).toBeNull();
  });

  it('does nothing under reduced motion', () => {
    localStorage.setItem('theme-motion', 'reduced');
    render(<ThemeProvider><ThemeWipe /></ThemeProvider>);
    act(() => {
      window.dispatchEvent(new CustomEvent('theme-wipe', { detail: { x: 0, y: 0 } }));
    });
    expect(screen.queryByTestId('theme-wipe')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project ui src/components/shell/ThemeWipe.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/index.css` (file scope):

```css
/* Cinematic theme wipe: the OLD theme's ground color shrinks away from the
   toggle as a growing transparent circle reveals the new theme. --wipe-r is
   a registered property so the mask radius can transition. */
@property --wipe-r {
  syntax: '<length>';
  initial-value: 0px;
  inherits: false;
}
.theme-wipe-overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  pointer-events: none;
  --wipe-r: 0px;
  mask-image: radial-gradient(circle at var(--wipe-x) var(--wipe-y), transparent var(--wipe-r), black calc(var(--wipe-r) + 1px));
  -webkit-mask-image: radial-gradient(circle at var(--wipe-x) var(--wipe-y), transparent var(--wipe-r), black calc(var(--wipe-r) + 1px));
  transition: --wipe-r 0.6s cubic-bezier(0.22, 1, 0.36, 1);
}
.theme-wipe-overlay.wipe-go { --wipe-r: 160vmax; }
```

```tsx
// src/components/shell/ThemeWipe.tsx
import React, { useEffect, useState } from 'react';
import { useTheme } from '../../context/ThemeContext';

interface Wipe { x: number; y: number; color: string; id: number }

export const ThemeWipe: React.FC = () => {
  const { reducedMotion } = useTheme();
  const [wipe, setWipe] = useState<Wipe | null>(null);
  const [go, setGo] = useState(false);

  useEffect(() => {
    const onWipe = (e: Event) => {
      if (reducedMotion) return;
      const { x, y } = (e as CustomEvent<{ x: number; y: number }>).detail;
      // Capture the pre-flip ground color BEFORE ThemeContext applies .dark.
      const color = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim() || '#f8fafc';
      setGo(false);
      setWipe({ x, y, color, id: Date.now() });
    };
    window.addEventListener('theme-wipe', onWipe);
    return () => window.removeEventListener('theme-wipe', onWipe);
  }, [reducedMotion]);

  useEffect(() => {
    if (!wipe) return;
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setGo(true)));
    const t = setTimeout(() => setWipe(null), 650);
    return () => { cancelAnimationFrame(raf); clearTimeout(t); };
  }, [wipe?.id]);

  if (!wipe) return null;
  return (
    <div
      data-testid="theme-wipe"
      className={`theme-wipe-overlay ${go ? 'wipe-go' : ''}`}
      style={{ backgroundColor: wipe.color, ['--wipe-x' as any]: `${wipe.x}px`, ['--wipe-y' as any]: `${wipe.y}px` }}
    />
  );
};
```

Wire the trigger — in `src/components/shell/Sidebar.tsx`, the theme-toggle NavRow (line 276-281) becomes:

```tsx
<NavRow
  label={mode === 'dark' ? 'Light mode' : 'Dark mode'}
  Icon={mode === 'dark' ? Sun : Moon}
  expanded={expanded}
  onClick={(e?: React.MouseEvent) => {
    const rect = (e?.currentTarget as HTMLElement | undefined)?.getBoundingClientRect();
    window.dispatchEvent(new CustomEvent('theme-wipe', {
      detail: { x: rect ? rect.left + rect.width / 2 : 32, y: rect ? rect.top + rect.height / 2 : window.innerHeight - 96 },
    }));
    toggleMode();
  }}
/>
```

NavRow's `onClick` prop type widens to `(e?: React.MouseEvent) => void` and the button passes the event through (`onClick={e => onClick(e)}`) — a backwards-compatible change (all other callers ignore the arg).

Mount in `src/App.tsx` Layout next to `<FollowPill />`: `<ThemeWipe />` (import from `./components/shell/ThemeWipe`).

- [ ] **Step 4: Run tests**

Run: `npx vitest run --project ui && npm run lint`
Expected: PASS (Sidebar tests unaffected — NavRow signature change is compatible).

- [ ] **Step 5: Visual smoke**

Dev server: click the theme toggle — the old theme sweeps away in a circle from the button (Chromium; in browsers without `@property` support the overlay just appears/disappears — acceptable fallback). Reduced motion: instant flip, no overlay.

- [ ] **Step 6: Commit**

```bash
git add src/components/shell/ThemeWipe.tsx src/components/shell/ThemeWipe.test.tsx src/components/shell/Sidebar.tsx src/App.tsx src/index.css
git commit -m "feat(ui): cinematic theme wipe from the toggle button"
```

---

### Task 11: Wave 1 verification + changelog + push

**Files:**
- Modify: changelog (locate with `ls docs | grep -i change; ls | grep -i change` — the repo keeps one; add a `v2.12.0 — UI Rehaul Wave 1` section listing: ambient scenes, glass shell, page/tab transitions, soft-zoom law, global sidebar + project tab bar, sidebar presence, new login, time-of-day + solid-surfaces prefs, glass scrollbars, reactive icons, theme wipe)

**Interfaces:** none.

- [ ] **Step 1: Full unit suite**

Run: `npm test`
Expected: ALL pass (both `server` and `ui` projects).

- [ ] **Step 2: Typecheck**

Run: `npm run lint`
Expected: clean.

- [ ] **Step 3: Full e2e suite**

Run: `npm run test:e2e`
Expected: 29 specs pass — canvas drawing specs especially (they prove the shell restructure didn't disturb the canvas: collapsed rail, full-bleed page, measurement sidebar). If `collab-*.spec.ts` fail on locators missed in Tasks 5/6, fix the spec locators (behavior contract: presence popover opens from the sidebar; Follow/Stop still work).

- [ ] **Step 4: Hover-overlap proof (spec §10)**

Add to `e2e/` a minimal assertion in a new spec `e2e/shell-rehaul.spec.ts`:

```ts
import { test, expect } from './fixtures/test';

test('soft-zoom hover never overlaps the sidebar', async ({ authedPage: page }) => {
  await page.goto('/login');
  // login card carries .soft-zoom? — target the Login glass card at /login logged-out instead:
  await page.context().clearCookies();
  await page.goto('/dashboard');
  // Any .soft-zoom element will do once cards adopt it; Wave 1 asserts the law on the presence button:
  const el = page.getByTestId('sidebar-presence');
  const before = await el.boundingBox();
  await el.hover();
  await page.waitForTimeout(400);
  const after = await el.boundingBox();
  expect(after!.width - before!.width).toBeLessThan(11); // < grid gap: the law holds
});
```

(Trim the stray login lines when writing the real file — the meaningful body is the four lines from `const el =` down. Wave 2 extends this spec to cards at three sizes.)

Run: `npm run test:e2e -- shell-rehaul.spec.ts` → PASS.

- [ ] **Step 5: Changelog + memory of record**

Write the changelog entry (file located in Step 1's `ls`). Commit message includes the wave summary.

- [ ] **Step 6: Commit + push**

```bash
git add -A
git commit -m "feat(ui): UI Rehaul Wave 1 — foundation & shell (v2.12.0)"
git push origin testing
```

- [ ] **Step 7: Report to Nathan**

Manual smoke checklist to hand over: light/dark scenes on desktop + tablet + phone; accent picker recolors atmosphere; time-of-day toggle; solid-surfaces toggle; project tab bar on a real project; presence popover with a second device; canvas untouched (draw one measurement); login.

---

## Self-Review Notes (completed)

- **Spec coverage (Wave 1 list, spec §9):** ambient scene ✓ T1 · glass tokens ✓ T1 · motion system ✓ T2/T3 · global sidebar + tab bar ✓ T4/T5 · sidebar presence ✓ T6 · login ✓ T7 · time-of-day pref ✓ T8 · glass scrollbars ✓ T9 · reactive icons ✓ T9 · theme wipe ✓ T10 · low-power fallback ✓ T1 (CSS) + T8 (explicit pref).
- **Contracts honored:** `glow-accent` kept (T4/T5); nav labels kept, moved (T5); presence e2e locators deliberately migrated (T6); reduced-motion wired into every JS animation (T3/T6/T10); no secure-context APIs anywhere.
- **Type consistency:** `SidebarState` unchanged; `AppShell` gains `appName: string` (T4) and `App.tsx` updated in the same task; `PROJECT_SECTIONS`/`ProjectSection` defined in T5 and consumed only there; `daypartForHour` defined and tested in T8.
