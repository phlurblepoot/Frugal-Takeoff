# Phase 2: Shell & Design System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the design-token layer, the shared component library (Button, Card, StatusPill, Table, Modal, Form controls, EmptyState, Skeleton, ProgressBar), and the contextual-sidebar shell with first-class light/dark — while every existing page keeps working, mounted in the new shell.

**Architecture:** A semantic token layer (CSS variables exposed as Tailwind 4 utilities via `@theme inline`) defines every surface/border/text color per theme; glow accents become two shared utilities (`glow-accent`, `glow-bar`) reserved for primary buttons, active nav, and progress bars. A new `src/components/ui/` library consumes only tokens. The `SideDock` app-switcher is replaced by a contextual `Sidebar` inside an `AppShell`: company-level nav normally, swapping to project-level nav (← All Projects + project sections) on `/project/:id` routes, collapsing to a thin rail on the canvas. Existing pages are *mounted*, not restyled — screens get rebuilt on the library in Phases 3–5 (structure-before-cosmetics, spec §10).

**Tech Stack:** React 19 + react-router-dom 7, Tailwind 4 (`@tailwindcss/vite`, CSS-first config), motion/react, lucide-react, Inter via `@fontsource-variable/inter`. Tests: Vitest 4 projects (existing `server` node project + new `ui` jsdom project) with @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-06-11-cohesive-app-design.md` (§4 Navigation, §5 Design Language, §9 Phase 2)

**Branch:** all work on `testing` (per project CLAUDE.md — push directly to `testing`, no PRs).

---

## Context You Must Know Before Starting

1. **Tailwind 4, CSS-first.** No `tailwind.config.js` — theme lives in `src/index.css` (`@theme` block with an accent scale, `@custom-variant dark` for class-based dark mode). `ThemeContext` (`src/context/ThemeContext.tsx`) already handles light/dark mode, accent hue (overrides `--color-accent-*` at runtime via inline styles on `<html>`), and reduced motion, all synced to server user-preferences. **Do not rebuild ThemeContext** — Phase 2 only consumes it.
2. **Current shell:** `src/App.tsx` `Layout` renders `SideDock` (`src/components/SideDock.tsx`, states `expanded`/`collapsed`/`hidden` persisted under localStorage key `sideDockState`) and offsets content with `marginLeft` (208/64/0). SideDock self-hides on `/login`, when there's no `token` in localStorage, and on mobile canvas pages.
3. **Routes:** `/` (ProjectsList with `?tab=` projects/templates/bids/users), `/new`, `/project/:projectId` (ProjectView), `/project/:projectId/page/:pageId` (CanvasView — full-bleed canvas), `/settings`, `/pdf-editor`, `/spreadsheet-editor`, `/checklist`, `/time`, `/login`, plus `/share/:shareId` *outside* the Layout. Route *paths* do not change in Phase 2 (the spec's `/p/:id/…` and `/tools/*` URLs are Phase 3).
4. **ProjectView tab state:** `src/pages/ProjectView.tsx:619` keeps `activeTab` (`'pages' | 'takeoffs' | 'printouts' | 'email' | 'notes'`) in `useState`; `location.state.activeTab` is honored on mount (`ProjectView.tsx:969-973`, used by CommandPalette). It already uses `useSearchParams` for `?search=` (`ProjectView.tsx:839-848`). Task 9 moves the tab into `?tab=` so the project sidebar can highlight sections.
5. **Existing primitives to keep:** `Toast` (`const { toast } = useToast(); toast(msg, { type: 'error' })`), `ConfirmDialog` (`useConfirm` returns a promise fn), `ShareLinkModal`, `Skeleton`, `CommandPalette` (opens on `open-command-palette` CustomEvent). The new `ui/` library does **not** replace these in Phase 2.
6. **Do not restyle existing pages.** Pages keep their current ad-hoc Tailwind classes and `glass`/`theme-page`/`theme-card` utilities — leave those utilities in `index.css`. Phase 2 verification is "everything looks and works the same or better in the new shell," not "everything uses the new components."
7. **Tests today:** `vitest.config.ts` only includes `server/**/*.test.ts` in a node environment. tsconfig has no `include`, so every new `.ts`/`.tsx` file is type-checked by `npm run lint` (`tsc --noEmit`).
8. **Member/admin roles, ⌘K actions, Dashboard page:** all Phase 3. The company sidebar in Phase 2 links to what exists today (Projects, Checklists, Time, PDF Editor, Spreadsheet, Settings).
9. **Run the dev server:** `npm run dev` (tsx runs `server.ts` with embedded Vite). Use `STORAGE_PATH=/tmp/...` for throwaway data. Tests: `npm test`.
10. **This phase is UI-only — no server or schema changes.** If you find yourself editing `server/` or `server.ts`, stop; you're off-plan.

## File Structure

```
src/index.css                       # + semantic tokens, glow utilities, Inter font stack
src/main.tsx                        # + @fontsource-variable/inter import
src/test/setup.ts                   # jest-dom matchers + matchMedia polyfill (new)
src/test/sanity.test.tsx            # proves jsdom + RTL pipeline works (new)
src/components/ui/
  Button.tsx        # primary(glow)/secondary/ghost/danger, sm/md
  Card.tsx          # Card, CardHeader, CardBody — flat raised surface
  StatusPill.tsx    # StatusPill + ProjectStatusPill + PROJECT_STATUS_META
  Form.tsx          # Field, Input, Select, Textarea, Checkbox
  Modal.tsx         # portal + esc/overlay close + title/footer slots
  Table.tsx         # Table, THead, TBody, TR, TH, TD — flat, token-styled
  EmptyState.tsx    # icon + title + description + action
  ProgressBar.tsx   # glow-bar fill (one of the three allowed glow surfaces)
  Skeleton.tsx      # re-export of the existing base Skeleton
  index.ts          # barrel
  *.test.tsx        # colocated RTL tests
src/components/shell/
  AppShell.tsx      # sidebar state + mobile + canvas thin-rail + content margin
  Sidebar.tsx       # contextual sidebar: company nav ⇄ project nav
  Sidebar.test.tsx
src/context/ProjectShellContext.tsx # project pages register {id,name} for the sidebar
src/App.tsx                         # Layout uses AppShell; SideDock removed
src/components/SideDock.tsx         # DELETED (replaced by shell/Sidebar)
src/components/Skeleton.tsx         # base block restyled to tokens (bg-edge)
src/pages/ProjectView.tsx           # activeTab → ?tab= search param; registers shell context
src/pages/CanvasView.tsx            # registers shell context
vitest.config.ts                    # server + ui projects
```

---

### Task 1: Frontend Test Infrastructure

**Files:**
- Modify: `vitest.config.ts`
- Create: `src/test/setup.ts`
- Create: `src/test/sanity.test.tsx`

- [ ] **Step 1: Install dev dependencies**

```bash
npm install -D jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event
```

- [ ] **Step 2: Split vitest config into server + ui projects**

Replace the whole of `vitest.config.ts` with:

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'server',
          include: ['server/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'ui',
          include: ['src/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['./src/test/setup.ts'],
        },
      },
    ],
  },
});
```

- [ ] **Step 3: Create the ui test setup file**

```ts
// src/test/setup.ts
import '@testing-library/jest-dom/vitest';

// jsdom has no matchMedia; the shell uses it for mobile detection and
// ThemeContext consumers may touch it. A static non-matching stub is enough.
if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}
```

- [ ] **Step 4: Write a sanity test proving the jsdom pipeline works**

```tsx
// src/test/sanity.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

describe('ui test infrastructure', () => {
  it('renders JSX into jsdom with jest-dom matchers', () => {
    render(<button>hello</button>);
    expect(screen.getByRole('button')).toHaveTextContent('hello');
  });
});
```

- [ ] **Step 5: Run both projects**

Run: `npm test`
Expected: PASS — all existing `server` suites still green, plus 1 `ui` test. Then run `npm run lint` — no type errors (the jest-dom matcher types come from the setup import; tsconfig compiles everything in the repo).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.ts src/test/setup.ts src/test/sanity.test.tsx
git commit -m "test: add jsdom + testing-library ui test project"
```

---

### Task 2: Design Tokens + Inter Font

**Files:**
- Modify: `src/index.css`
- Modify: `src/main.tsx`

No unit test (CSS isn't executed in jsdom) — verification is build + visual sweep in Step 4.

- [ ] **Step 1: Install the self-hosted Inter font** (the app runs on a LAN/Unraid box — no Google Fonts CDN)

```bash
npm install @fontsource-variable/inter
```

In `src/main.tsx`, add as the **first** import, above `./index.css`:

```ts
import '@fontsource-variable/inter';
```

- [ ] **Step 2: Replace `src/index.css` with the token layer**

Replace the entire file with the following. The accent scale, glass utilities, `theme-page`/`theme-card`, motion-reduce, and focus-visible rules are carried over verbatim from the current file — only the marked sections are new.

```css
@import "tailwindcss";

/* ── Dark mode class variant ──────────────────────────────────────────── */
@custom-variant dark (&:where(.dark, .dark *));

/* ── Type scale + accent colour scale ─────────────────────────────────── */
/* JS overrides the accent vars at runtime for the colour picker
   (ThemeContext.applyAccent). --font-sans changes the app-wide default. */
@theme {
  --font-sans: 'Inter Variable', ui-sans-serif, system-ui, -apple-system,
    'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;

  --color-accent-50:  oklch(0.97 0.012 264);
  --color-accent-100: oklch(0.93 0.032 264);
  --color-accent-200: oklch(0.87 0.065 264);
  --color-accent-300: oklch(0.78 0.12  264);
  --color-accent-400: oklch(0.68 0.17  264);
  --color-accent-500: oklch(0.60 0.22  264);
  --color-accent-600: oklch(0.52 0.24  264);
  --color-accent-700: oklch(0.44 0.22  264);
  --color-accent-800: oklch(0.36 0.18  264);
  --color-accent-900: oklch(0.28 0.14  264);
}

/* ── Semantic design tokens (spec §5) ─────────────────────────────────────
   NEW IN PHASE 2. Every surface/border/text colour should come from these.
   Light and dark are both first-class: each token is defined per theme below,
   and the generated utilities (bg-surface, bg-raised, border-edge, text-ink,
   text-ink-soft, …) resolve the variable at render time. */
@theme inline {
  --color-surface:     var(--surface);      /* page background          */
  --color-raised:      var(--raised);       /* cards, popovers, modals  */
  --color-sunken:      var(--sunken);       /* inset wells, table heads */
  --color-hover:       var(--hover);        /* hover wash on rows/nav   */
  --color-edge:        var(--edge);         /* default 1px borders      */
  --color-edge-strong: var(--edge-strong);  /* emphasised borders       */
  --color-ink:         var(--ink);          /* primary text             */
  --color-ink-soft:    var(--ink-soft);     /* secondary text           */
  --color-ink-faint:   var(--ink-faint);    /* placeholder / disabled   */
}

:root {
  --surface:     #f8fafc;
  --raised:      #ffffff;
  --sunken:      #f1f5f9;
  --hover:       #eef2f7;
  --edge:        #e2e8f0;
  --edge-strong: #cbd5e1;
  --ink:         #0f172a;
  --ink-soft:    #475569;
  --ink-faint:   #94a3b8;

  /* Legacy aliases — pre-Phase-2 classes (theme-page/theme-card) resolve to
     the same tokens, so old screens track theme changes automatically. */
  --surface-bg:  var(--surface);
  --card-bg:     var(--raised);
  --card-border: var(--edge);

  --glass-bg:     rgba(255, 255, 255, 0.72);
  --glass-border: rgba(255, 255, 255, 0.40);
  --glass-shadow: 0 8px 32px rgba(0, 0, 0, 0.08);
  --glass-blur:   blur(16px);
}

.dark {
  --surface:     #0f172a;
  --raised:      #1e293b;
  --sunken:      #0b1220;
  --hover:       #334155;
  --edge:        #334155;
  --edge-strong: #475569;
  --ink:         #f1f5f9;
  --ink-soft:    #94a3b8;
  --ink-faint:   #64748b;

  --glass-bg:     rgba(15, 23, 42, 0.75);
  --glass-border: rgba(255, 255, 255, 0.08);
  --glass-shadow: 0 8px 32px rgba(0, 0, 0, 0.40);
}

/* ── Glow accents (spec §5 rule 2) ────────────────────────────────────────
   NEW IN PHASE 2. Reserved for exactly three things: primary buttons, the
   active nav item, and progress bars. Nothing else may use these. */
@utility glow-accent {
  background-image: linear-gradient(to bottom, var(--color-accent-500), var(--color-accent-600));
  box-shadow:
    0 1px 2px 0 rgb(0 0 0 / 0.25),
    0 0 14px 0 color-mix(in oklab, var(--color-accent-500) 35%, transparent);
}

@utility glow-bar {
  background-image: linear-gradient(to right, var(--color-accent-400), var(--color-accent-600));
  box-shadow: 0 0 10px 0 color-mix(in oklab, var(--color-accent-500) 45%, transparent);
}

/* ── Legacy utility classes (kept until Phases 3–5 restyle the screens) ── */
@layer utilities {
  .glass {
    background: var(--glass-bg);
    backdrop-filter: var(--glass-blur);
    -webkit-backdrop-filter: var(--glass-blur);
    border: 1px solid var(--glass-border);
    box-shadow: var(--glass-shadow);
  }

  .glass-card {
    background: var(--glass-bg);
    backdrop-filter: var(--glass-blur);
    -webkit-backdrop-filter: var(--glass-blur);
    border: 1px solid var(--glass-border);
    box-shadow: var(--glass-shadow);
    border-radius: 1rem;
  }

  .glass-subtle {
    background: rgba(255, 255, 255, 0.50);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border: 1px solid rgba(255, 255, 255, 0.30);
  }

  .theme-page {
    background-color: var(--surface-bg);
  }

  .theme-card {
    background-color: var(--card-bg);
    border-color: var(--card-border);
  }

  /* CSS-level reduced motion override */
  .motion-reduce *,
  .motion-reduce *::before,
  .motion-reduce *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}

/* Dark glass-subtle override */
.dark .glass-subtle {
  background: rgba(30, 41, 59, 0.60);
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.dark body {
  color-scheme: dark;
}

/* ── Keyboard focus visibility ────────────────────────────────────────── */
/* Show a clear focus ring for keyboard users without affecting mouse clicks
   (which use :focus, not :focus-visible). */
:focus-visible {
  outline: 2px solid var(--color-accent-500);
  outline-offset: 2px;
  border-radius: 0.25rem;
}
.dark :focus-visible {
  outline-color: var(--color-accent-400);
}
```

**Design notes locked in here (do not deviate):**
- `@theme inline` (not plain `@theme`) for the semantic tokens — it makes utilities emit `var(--surface)` etc. so the `.dark` overrides work at render time.
- The `.dark` block no longer redefines `--surface-bg`/`--card-bg`/`--card-border`; the `:root` aliases point at theme-switching vars, so one definition serves both themes.
- Exact hex values are Nathan-tunable later — that's the point of tokens — but ship these defaults.

- [ ] **Step 3: Typecheck and build**

Run: `npm run lint && npm run build`
Expected: clean build; no missing-module errors for the font package.

- [ ] **Step 4: Visual sweep**

```bash
STORAGE_PATH=/tmp/ft-p2-$$ npm run dev
```

In the browser: log in (admin/admin on fresh data), confirm the whole app now renders in Inter, toggle dark mode in Settings → Appearance — every page keeps its current look (slate backgrounds, cards, dock) with no flash of unstyled/wrong-theme content. Stop the server.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/index.css src/main.tsx
git commit -m "feat: semantic design tokens, glow utilities, Inter font"
```

---

### Task 3: Button + Card

**Files:**
- Create: `src/components/ui/Button.tsx`
- Create: `src/components/ui/Card.tsx`
- Test: `src/components/ui/Button.test.tsx`
- Test: `src/components/ui/Card.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
// src/components/ui/Button.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Button } from './Button';

describe('Button', () => {
  it('defaults to primary variant (glow) and type=button', () => {
    render(<Button>Save</Button>);
    const btn = screen.getByRole('button', { name: 'Save' });
    expect(btn.className).toContain('glow-accent');
    expect(btn).toHaveAttribute('type', 'button');
  });

  it('secondary variant is flat — no glow class', () => {
    render(<Button variant="secondary">Cancel</Button>);
    expect(screen.getByRole('button').className).not.toContain('glow-accent');
  });

  it('fires onClick when enabled', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('passes through disabled', () => {
    render(<Button disabled>Go</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
  });
});
```

```tsx
// src/components/ui/Card.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Card, CardHeader, CardBody } from './Card';

describe('Card', () => {
  it('renders a flat raised surface with children', () => {
    render(
      <Card data-testid="card">
        <CardHeader title="Invoices" actions={<button>New</button>} />
        <CardBody>rows</CardBody>
      </Card>
    );
    const card = screen.getByTestId('card');
    expect(card.className).toContain('bg-raised');
    expect(card.className).not.toContain('glass'); // data surfaces stay flat
    expect(screen.getByRole('heading', { name: 'Invoices' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New' })).toBeInTheDocument();
    expect(screen.getByText('rows')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/ui`
Expected: FAIL — `Cannot find module './Button'` (and `./Card`)

- [ ] **Step 3: Implement Button**

```tsx
// src/components/ui/Button.tsx
import React from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

// Glow is reserved for primary actions (spec §5 rule 2). Everything else
// stays flat per the hybrid design language.
const VARIANTS: Record<Variant, string> = {
  primary:
    'glow-accent text-white hover:brightness-110 active:brightness-95 ' +
    'disabled:opacity-50 disabled:hover:brightness-100',
  secondary:
    'bg-raised text-ink border border-edge hover:bg-hover disabled:opacity-50',
  ghost:
    'text-ink-soft hover:bg-hover hover:text-ink disabled:opacity-50',
  danger:
    'bg-red-600 text-white hover:bg-red-500 active:bg-red-700 disabled:opacity-50',
};

const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5',
  md: 'h-9 px-4 text-sm gap-2',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', className = '', type = 'button', ...rest }, ref) => (
    <button
      ref={ref}
      type={type}
      className={
        'inline-flex items-center justify-center font-medium rounded-lg ' +
        `transition-colors disabled:cursor-not-allowed ${VARIANTS[variant]} ${SIZES[size]} ${className}`
      }
      {...rest}
    />
  )
);
Button.displayName = 'Button';
```

- [ ] **Step 4: Implement Card**

```tsx
// src/components/ui/Card.tsx
import React from 'react';

// Flat raised surface — data surfaces never get glass or glow (spec §5 rule 4).
export const Card: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ className = '', ...rest }) => (
  <div className={`rounded-xl border border-edge bg-raised ${className}`} {...rest} />
);

export const CardHeader: React.FC<{
  title: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}> = ({ title, actions, className = '' }) => (
  <div className={`flex items-center justify-between gap-3 border-b border-edge px-5 py-4 ${className}`}>
    <h3 className="text-sm font-semibold text-ink">{title}</h3>
    {actions}
  </div>
);

export const CardBody: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ className = '', ...rest }) => (
  <div className={`px-5 py-4 ${className}`} {...rest} />
);
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run src/components/ui`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add src/components/ui/Button.tsx src/components/ui/Button.test.tsx src/components/ui/Card.tsx src/components/ui/Card.test.tsx
git commit -m "feat: ui library — Button (glow primary) and Card"
```

---

### Task 4: StatusPill

**Files:**
- Create: `src/components/ui/StatusPill.tsx`
- Test: `src/components/ui/StatusPill.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
// src/components/ui/StatusPill.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusPill, ProjectStatusPill, PROJECT_STATUS_META } from './StatusPill';

describe('StatusPill', () => {
  it('renders children with the requested tone', () => {
    render(<StatusPill tone="emerald">Done</StatusPill>);
    const pill = screen.getByText('Done');
    expect(pill.className).toContain('emerald');
  });

  it('defaults to the slate tone', () => {
    render(<StatusPill>Meh</StatusPill>);
    expect(screen.getByText('Meh').className).toContain('slate');
  });
});

describe('ProjectStatusPill', () => {
  it('maps every lifecycle status from the spec', () => {
    for (const s of ['estimating', 'proposal_sent', 'awarded', 'in_progress',
                     'punch_list', 'complete', 'archived', 'lost']) {
      expect(PROJECT_STATUS_META[s], `missing status ${s}`).toBeDefined();
    }
  });

  it('renders the human label for a known status', () => {
    render(<ProjectStatusPill status="proposal_sent" />);
    expect(screen.getByText('Proposal Sent')).toBeInTheDocument();
  });

  it('falls back to slate + raw text for unknown statuses', () => {
    render(<ProjectStatusPill status="something_else" />);
    expect(screen.getByText('something_else').className).toContain('slate');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/ui/StatusPill.test.tsx`
Expected: FAIL — `Cannot find module './StatusPill'`

- [ ] **Step 3: Implement**

```tsx
// src/components/ui/StatusPill.tsx
import React from 'react';

export type PillTone =
  | 'slate' | 'blue' | 'violet' | 'green' | 'emerald' | 'amber' | 'orange' | 'red';

// Soft colour-tinted pills (spec §5 rule 1). Full class strings per tone so
// Tailwind's scanner sees every class statically.
const TONES: Record<PillTone, string> = {
  slate:   'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-400/10 dark:text-slate-300 dark:border-slate-400/20',
  blue:    'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-400/10 dark:text-blue-300 dark:border-blue-400/20',
  violet:  'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-400/10 dark:text-violet-300 dark:border-violet-400/20',
  green:   'bg-green-50 text-green-700 border-green-200 dark:bg-green-400/10 dark:text-green-300 dark:border-green-400/20',
  emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-400/10 dark:text-emerald-300 dark:border-emerald-400/20',
  amber:   'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-400/10 dark:text-amber-300 dark:border-amber-400/20',
  orange:  'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-400/10 dark:text-orange-300 dark:border-orange-400/20',
  red:     'bg-red-50 text-red-700 border-red-200 dark:bg-red-400/10 dark:text-red-300 dark:border-red-400/20',
};

export const StatusPill: React.FC<{
  tone?: PillTone;
  className?: string;
  children: React.ReactNode;
}> = ({ tone = 'slate', className = '', children }) => (
  <span
    className={
      'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 ' +
      `text-xs font-medium whitespace-nowrap ${TONES[tone]} ${className}`
    }
  >
    {children}
  </span>
);

// Project lifecycle (spec §2): estimating → proposal_sent → awarded →
// in_progress → punch_list → complete → archived, with lost as an exit.
export const PROJECT_STATUS_META: Record<string, { label: string; tone: PillTone }> = {
  estimating:    { label: 'Estimating',    tone: 'blue' },
  proposal_sent: { label: 'Proposal Sent', tone: 'violet' },
  awarded:       { label: 'Awarded',       tone: 'green' },
  in_progress:   { label: 'In Progress',   tone: 'amber' },
  punch_list:    { label: 'Punch List',    tone: 'orange' },
  complete:      { label: 'Complete',      tone: 'emerald' },
  archived:      { label: 'Archived',      tone: 'slate' },
  lost:          { label: 'Lost',          tone: 'red' },
};

export const ProjectStatusPill: React.FC<{ status?: string | null; className?: string }> = ({
  status,
  className,
}) => {
  const meta = (status && PROJECT_STATUS_META[status]) ||
    { label: status || 'Unknown', tone: 'slate' as PillTone };
  return (
    <StatusPill tone={meta.tone} className={className}>
      {meta.label}
    </StatusPill>
  );
};
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/components/ui/StatusPill.test.tsx`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/StatusPill.tsx src/components/ui/StatusPill.test.tsx
git commit -m "feat: ui library — StatusPill with project lifecycle mapping"
```

---

### Task 5: Form Controls

**Files:**
- Create: `src/components/ui/Form.tsx`
- Test: `src/components/ui/Form.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
// src/components/ui/Form.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Field, Input, Select, Textarea, Checkbox } from './Form';

describe('Form controls', () => {
  it('Field associates its label with the control via htmlFor', () => {
    render(
      <Field label="Contractor" htmlFor="contractor">
        <Input id="contractor" defaultValue="GC Co" />
      </Field>
    );
    expect(screen.getByLabelText('Contractor')).toHaveValue('GC Co');
  });

  it('Field shows error text instead of hint when both given', () => {
    render(
      <Field label="Amount" hint="Dollars" error="Required">
        <Input />
      </Field>
    );
    expect(screen.getByText('Required')).toBeInTheDocument();
    expect(screen.queryByText('Dollars')).not.toBeInTheDocument();
  });

  it('Input forwards value and onChange', () => {
    const onChange = vi.fn();
    render(<Input value="a" onChange={onChange} aria-label="name" />);
    fireEvent.change(screen.getByLabelText('name'), { target: { value: 'ab' } });
    expect(onChange).toHaveBeenCalled();
  });

  it('Select renders options; Textarea renders; Checkbox toggles', () => {
    const onChange = vi.fn();
    render(
      <>
        <Select aria-label="kind" defaultValue="b">
          <option value="a">A</option>
          <option value="b">B</option>
        </Select>
        <Textarea aria-label="desc" defaultValue="text" />
        <Checkbox label="Include photos" onChange={onChange} />
      </>
    );
    expect(screen.getByLabelText('kind')).toHaveValue('b');
    expect(screen.getByLabelText('desc')).toHaveValue('text');
    fireEvent.click(screen.getByLabelText('Include photos'));
    expect(onChange).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/ui/Form.test.tsx`
Expected: FAIL — `Cannot find module './Form'`

- [ ] **Step 3: Implement**

```tsx
// src/components/ui/Form.tsx
import React from 'react';

// Shared chrome for all text-like controls — forms stay flat (spec §5 rule 4).
const CONTROL =
  'w-full rounded-lg border border-edge bg-raised px-3 py-2 text-sm text-ink ' +
  'placeholder:text-ink-faint transition-colors ' +
  'focus:border-accent-400 focus:outline-none focus:ring-2 focus:ring-accent-500/25 ' +
  'disabled:opacity-50 disabled:cursor-not-allowed';

export const Field: React.FC<{
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}> = ({ label, htmlFor, hint, error, children }) => (
  <div className="space-y-1.5">
    <label htmlFor={htmlFor} className="block text-sm font-medium text-ink">
      {label}
    </label>
    {children}
    {error ? (
      <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
    ) : hint ? (
      <p className="text-xs text-ink-faint">{hint}</p>
    ) : null}
  </div>
);

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className = '', ...rest }, ref) => <input ref={ref} className={`${CONTROL} ${className}`} {...rest} />
);
Input.displayName = 'Input';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className = '', ...rest }, ref) => <textarea ref={ref} className={`${CONTROL} ${className}`} {...rest} />
);
Textarea.displayName = 'Textarea';

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className = '', children, ...rest }, ref) => (
    <select ref={ref} className={`${CONTROL} ${className}`} {...rest}>
      {children}
    </select>
  )
);
Select.displayName = 'Select';

export const Checkbox: React.FC<
  React.InputHTMLAttributes<HTMLInputElement> & { label: string }
> = ({ label, className = '', ...rest }) => (
  <label className={`inline-flex items-center gap-2 text-sm text-ink cursor-pointer ${className}`}>
    <input type="checkbox" className="size-4 rounded border-edge-strong accent-accent-600" {...rest} />
    {label}
  </label>
);
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/components/ui/Form.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/Form.tsx src/components/ui/Form.test.tsx
git commit -m "feat: ui library — Field, Input, Select, Textarea, Checkbox"
```

---

### Task 6: Modal

**Files:**
- Create: `src/components/ui/Modal.tsx`
- Test: `src/components/ui/Modal.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
// src/components/ui/Modal.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Modal } from './Modal';

describe('Modal', () => {
  it('renders nothing when closed', () => {
    render(<Modal open={false} onClose={() => {}} title="Hi">body</Modal>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders title, body, and footer when open', () => {
    render(
      <Modal open onClose={() => {}} title="Send proposal" footer={<button>Send</button>}>
        body text
      </Modal>
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Send proposal' })).toBeInTheDocument();
    expect(screen.getByText('body text')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it('calls onClose on Escape', () => {
    const onClose = vi.fn();
    render(<Modal open onClose={onClose} title="Hi">body</Modal>);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose on overlay click but not on panel click', () => {
    const onClose = vi.fn();
    render(<Modal open onClose={onClose} title="Hi">body</Modal>);
    fireEvent.click(screen.getByText('body')); // inside the panel
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('modal-overlay'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/ui/Modal.test.tsx`
Expected: FAIL — `Cannot find module './Modal'`

- [ ] **Step 3: Implement**

```tsx
// src/components/ui/Modal.tsx
import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';

const WIDTHS = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-3xl' } as const;

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  footer?: React.ReactNode;
  width?: keyof typeof WIDTHS;
  children: React.ReactNode;
}

export const Modal: React.FC<ModalProps> = ({
  open, onClose, title, footer, width = 'md', children,
}) => {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          data-testid="modal-overlay"
          className="fixed inset-0 z-[150] flex items-center justify-center bg-black/40 p-4"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.96, y: 8 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.96, opacity: 0 }}
            transition={{ duration: 0.15 }}
            role="dialog"
            aria-modal="true"
            className={`flex max-h-[85vh] w-full ${WIDTHS[width]} flex-col rounded-xl border border-edge bg-raised shadow-xl`}
            onClick={(e) => e.stopPropagation()}
          >
            {title !== undefined && (
              <div className="flex shrink-0 items-center justify-between border-b border-edge px-5 py-4">
                <h2 className="text-base font-semibold text-ink">{title}</h2>
                <button
                  onClick={onClose}
                  aria-label="Close dialog"
                  className="rounded-lg p-1.5 text-ink-faint transition-colors hover:bg-hover hover:text-ink"
                >
                  <X size={16} />
                </button>
              </div>
            )}
            <div className="overflow-y-auto px-5 py-4">{children}</div>
            {footer && (
              <div className="flex shrink-0 justify-end gap-2 border-t border-edge px-5 py-4">
                {footer}
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
};
```

**Note:** assertions about closing test `onClose` being *called*, not DOM removal — motion's exit animation removes the node asynchronously.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/components/ui/Modal.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/Modal.tsx src/components/ui/Modal.test.tsx
git commit -m "feat: ui library — Modal with esc/overlay close"
```

---

### Task 7: Table, EmptyState, ProgressBar, Skeleton + Barrel

**Files:**
- Create: `src/components/ui/Table.tsx`
- Create: `src/components/ui/EmptyState.tsx`
- Create: `src/components/ui/ProgressBar.tsx`
- Create: `src/components/ui/Skeleton.tsx`
- Create: `src/components/ui/index.ts`
- Modify: `src/components/Skeleton.tsx` (base block → tokens)
- Test: `src/components/ui/Table.test.tsx`
- Test: `src/components/ui/EmptyState.test.tsx`
- Test: `src/components/ui/ProgressBar.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
// src/components/ui/Table.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Table, THead, TBody, TR, TH, TD } from './Table';

describe('Table', () => {
  it('renders a semantic table with header and rows', () => {
    render(
      <Table>
        <THead>
          <TR><TH>Name</TH><TH>Amount</TH></TR>
        </THead>
        <TBody>
          <TR><TD>Drywall</TD><TD>$1,200</TD></TR>
        </TBody>
      </Table>
    );
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '$1,200' })).toBeInTheDocument();
  });

  it('interactive rows get the hover wash class', () => {
    render(
      <Table>
        <TBody>
          <TR interactive data-testid="row"><TD>x</TD></TR>
        </TBody>
      </Table>
    );
    expect(screen.getByTestId('row').className).toContain('hover:bg-hover');
  });
});
```

```tsx
// src/components/ui/EmptyState.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmptyState } from './EmptyState';

describe('EmptyState', () => {
  it('renders title, description, and action', () => {
    render(
      <EmptyState
        title="No invoices yet"
        description="Create your first invoice to get started."
        action={<button>New invoice</button>}
      />
    );
    expect(screen.getByRole('heading', { name: 'No invoices yet' })).toBeInTheDocument();
    expect(screen.getByText(/first invoice/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New invoice' })).toBeInTheDocument();
  });

  it('renders without optional parts', () => {
    render(<EmptyState title="Nothing here" />);
    expect(screen.getByRole('heading', { name: 'Nothing here' })).toBeInTheDocument();
  });
});
```

```tsx
// src/components/ui/ProgressBar.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProgressBar } from './ProgressBar';

describe('ProgressBar', () => {
  it('exposes the value via aria and sizes the fill', () => {
    render(<ProgressBar value={40} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '40');
    expect((bar.firstChild as HTMLElement).style.width).toBe('40%');
  });

  it('clamps out-of-range values', () => {
    render(<ProgressBar value={150} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/ui`
Expected: FAIL — cannot find modules `./Table`, `./EmptyState`, `./ProgressBar` (earlier suites still pass).

- [ ] **Step 3: Implement Table**

```tsx
// src/components/ui/Table.tsx
import React from 'react';

// Flat data table (spec §5 rule 4: tables never get glass or glow).
// Compose: <Table><THead><TR><TH/>…</TR></THead><TBody><TR><TD/>…</TBody></Table>
export const Table: React.FC<React.TableHTMLAttributes<HTMLTableElement>> = ({
  className = '',
  ...rest
}) => (
  <div className="overflow-x-auto">
    <table className={`w-full text-sm text-ink ${className}`} {...rest} />
  </div>
);

export const THead: React.FC<React.HTMLAttributes<HTMLTableSectionElement>> = ({
  className = '',
  ...rest
}) => (
  <thead
    className={`bg-sunken text-left text-xs font-semibold uppercase tracking-wider text-ink-soft ${className}`}
    {...rest}
  />
);

export const TBody: React.FC<React.HTMLAttributes<HTMLTableSectionElement>> = ({
  className = '',
  ...rest
}) => <tbody className={`divide-y divide-edge ${className}`} {...rest} />;

export const TR: React.FC<React.HTMLAttributes<HTMLTableRowElement> & { interactive?: boolean }> = ({
  interactive = false,
  className = '',
  ...rest
}) => (
  <tr
    className={`${interactive ? 'cursor-pointer transition-colors hover:bg-hover ' : ''}${className}`}
    {...rest}
  />
);

export const TH: React.FC<React.ThHTMLAttributes<HTMLTableCellElement>> = ({
  className = '',
  ...rest
}) => <th className={`px-4 py-3 font-semibold ${className}`} {...rest} />;

export const TD: React.FC<React.TdHTMLAttributes<HTMLTableCellElement>> = ({
  className = '',
  ...rest
}) => <td className={`px-4 py-3 ${className}`} {...rest} />;
```

- [ ] **Step 4: Implement EmptyState and ProgressBar**

```tsx
// src/components/ui/EmptyState.tsx
import React from 'react';

export const EmptyState: React.FC<{
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}> = ({ icon, title, description, action }) => (
  <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
    {icon && (
      <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-sunken text-ink-faint">
        {icon}
      </div>
    )}
    <h3 className="text-sm font-semibold text-ink">{title}</h3>
    {description && <p className="mt-1 max-w-sm text-sm text-ink-faint">{description}</p>}
    {action && <div className="mt-4">{action}</div>}
  </div>
);
```

```tsx
// src/components/ui/ProgressBar.tsx
import React from 'react';

// One of the three allowed glow surfaces (spec §5 rule 2).
export const ProgressBar: React.FC<{ value: number; className?: string }> = ({
  value,
  className = '',
}) => {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={`h-2 w-full overflow-hidden rounded-full bg-sunken ${className}`}
    >
      <div
        className="glow-bar h-full rounded-full transition-[width] duration-300"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
};
```

- [ ] **Step 5: Restyle the base Skeleton to tokens and re-export it**

In `src/components/Skeleton.tsx`, change the base block (line 5-7) — the `bg-edge` token resolves to the exact colors used today (#e2e8f0 light / #334155 dark):

```tsx
export const Skeleton: React.FC<{ className?: string }> = ({ className = '' }) => (
  <div className={`animate-pulse rounded bg-edge ${className}`} />
);
```

(The `ProjectTableSkeleton`/`ProjectCardsSkeleton` composites in that file stay unchanged — they're page-specific and get rebuilt with their pages in Phase 3.)

```ts
// src/components/ui/Skeleton.tsx
// The base shimmer block predates the ui library; re-export it so library
// consumers import everything from one place.
export { Skeleton } from '../Skeleton';
```

- [ ] **Step 6: Create the barrel**

```ts
// src/components/ui/index.ts
export { Button } from './Button';
export type { ButtonProps } from './Button';
export { Card, CardHeader, CardBody } from './Card';
export { StatusPill, ProjectStatusPill, PROJECT_STATUS_META } from './StatusPill';
export type { PillTone } from './StatusPill';
export { Field, Input, Select, Textarea, Checkbox } from './Form';
export { Modal } from './Modal';
export type { ModalProps } from './Modal';
export { Table, THead, TBody, TR, TH, TD } from './Table';
export { EmptyState } from './EmptyState';
export { ProgressBar } from './ProgressBar';
export { Skeleton } from './Skeleton';
```

- [ ] **Step 7: Run to verify pass**

Run: `npx vitest run src/components/ui && npm run lint`
Expected: PASS (all ui suites: Button 4, Card 1, StatusPill 5, Form 4, Modal 4, Table 2, EmptyState 2, ProgressBar 2), no type errors.

- [ ] **Step 8: Commit**

```bash
git add src/components/ui src/components/Skeleton.tsx
git commit -m "feat: ui library — Table, EmptyState, ProgressBar, Skeleton, barrel"
```

---

### Task 8: AppShell + Sidebar (Company Mode)

**Files:**
- Create: `src/components/shell/Sidebar.tsx`
- Create: `src/components/shell/AppShell.tsx`
- Modify: `src/App.tsx`
- Delete: `src/components/SideDock.tsx`
- Test: `src/components/shell/Sidebar.test.tsx`

The Sidebar keeps SideDock's three states and `sideDockState` localStorage key (users keep their saved preference) but reorganizes nav into labeled groups (Workspace / Tools), styles everything from tokens, gives the active item the glow treatment, and adds a theme toggle to the footer. AppShell owns state, mobile detection, and the canvas thin-rail rule.

- [ ] **Step 1: Write the failing tests**

```tsx
// src/components/shell/Sidebar.test.tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../../context/ThemeContext';
import { Sidebar } from './Sidebar';

const renderAt = (path: string) =>
  render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[path]}>
        <Sidebar state="expanded" onChange={() => {}} />
      </MemoryRouter>
    </ThemeProvider>
  );

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('token', 'test-token');
  localStorage.setItem('user', JSON.stringify({ username: 'nathan' }));
});

describe('Sidebar — company mode', () => {
  it('shows workspace and tools nav groups', () => {
    renderAt('/');
    for (const label of ['Projects', 'Checklists', 'Time', 'PDF Editor', 'Spreadsheet', 'Settings']) {
      expect(screen.getByRole('button', { name: new RegExp(label) })).toBeInTheDocument();
    }
  });

  it('gives only the active item the glow treatment', () => {
    renderAt('/time');
    expect(screen.getByRole('button', { name: /Time/ }).className).toContain('glow-accent');
    expect(screen.getByRole('button', { name: /Projects/ }).className).not.toContain('glow-accent');
  });

  it('offers a theme toggle', () => {
    renderAt('/');
    expect(screen.getByRole('button', { name: /Dark mode|Light mode/ })).toBeInTheDocument();
  });

  it('renders nothing when logged out', () => {
    localStorage.clear();
    const { container } = renderAt('/');
    expect(container.querySelector('button')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/shell`
Expected: FAIL — `Cannot find module './Sidebar'`

- [ ] **Step 3: Implement the Sidebar**

```tsx
// src/components/shell/Sidebar.tsx
import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Menu, PanelLeftClose, Search, FolderKanban, ClipboardList, Clock,
  FileEdit, Sheet, Settings, LogOut, Sun, Moon,
} from 'lucide-react';
import { useTheme } from '../../context/ThemeContext';

export type SidebarState = 'expanded' | 'collapsed' | 'hidden';

interface NavEntry {
  id: string;
  label: string;
  Icon: React.FC<{ size?: number; className?: string }>;
  path: string;
  match: (pathname: string) => boolean;
}

const WORKSPACE_NAV: NavEntry[] = [
  { id: 'projects', label: 'Projects', Icon: FolderKanban, path: '/', match: p => p === '/' || p === '/new' || p.startsWith('/project') },
  { id: 'checklists', label: 'Checklists', Icon: ClipboardList, path: '/checklist', match: p => p.startsWith('/checklist') },
  { id: 'time', label: 'Time', Icon: Clock, path: '/time', match: p => p.startsWith('/time') },
];

const TOOLS_NAV: NavEntry[] = [
  { id: 'pdf-editor', label: 'PDF Editor', Icon: FileEdit, path: '/pdf-editor', match: p => p.startsWith('/pdf-editor') },
  { id: 'spreadsheet-editor', label: 'Spreadsheet', Icon: Sheet, path: '/spreadsheet-editor', match: p => p.startsWith('/spreadsheet-editor') },
];

// Row used by every nav item. The active item gets the glow treatment —
// spec §5 rule 2: glow is for primary buttons, active nav, progress bars only.
const NavRow: React.FC<{
  label: string;
  Icon: NavEntry['Icon'];
  active?: boolean;
  expanded: boolean;
  onClick: () => void;
  trailing?: React.ReactNode;
}> = ({ label, Icon, active = false, expanded, onClick, trailing }) => (
  <button
    onClick={onClick}
    title={!expanded ? label : undefined}
    className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
      active ? 'glow-accent text-white' : 'text-ink-soft hover:bg-hover hover:text-ink'
    }`}
  >
    <Icon size={18} className="shrink-0" />
    {expanded && <span className="flex-1 truncate text-left">{label}</span>}
    {expanded && trailing}
  </button>
);

const SectionLabel: React.FC<{ show: boolean; children: React.ReactNode }> = ({ show, children }) =>
  show ? (
    <p className="px-3 pt-4 pb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
      {children}
    </p>
  ) : null;

interface SidebarProps {
  state: SidebarState;
  onChange: (s: SidebarState) => void;
  // True on canvas routes: the rail is forced thin and the size toggles hide.
  locked?: boolean;
}

export const Sidebar: React.FC<SidebarProps> = ({ state, onChange, locked = false }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { mode, toggleMode } = useTheme();

  if (location.pathname === '/login' || !localStorage.getItem('token')) return null;

  const user = JSON.parse(localStorage.getItem('user') || '{}');
  const expanded = state === 'expanded';

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = '/login';
  };

  if (state === 'hidden') {
    return (
      <button
        onClick={() => onChange('collapsed')}
        title="Open navigation"
        className="fixed top-4 left-4 z-50 p-2.5 bg-raised rounded-xl shadow-lg border border-edge text-ink-soft hover:bg-hover transition-colors"
      >
        <Menu size={18} />
      </button>
    );
  }

  return (
    <div
      className={`fixed left-0 top-0 h-full z-40 flex flex-col bg-surface border-r border-edge overflow-hidden transition-all duration-200 ${
        expanded ? 'w-52' : 'w-16'
      }`}
    >
      {/* Header */}
      <div className={`flex items-center h-14 px-3 border-b border-edge shrink-0 ${expanded ? 'justify-between' : 'justify-center'}`}>
        {!locked ? (
          <button
            onClick={() => onChange(expanded ? 'collapsed' : 'expanded')}
            title={expanded ? 'Collapse' : 'Expand navigation'}
            className="p-1.5 rounded-lg hover:bg-hover text-ink-soft transition-colors"
          >
            <Menu size={18} />
          </button>
        ) : (
          <div className="p-1.5 text-ink-faint"><Menu size={18} /></div>
        )}
        {expanded && !locked && (
          <button
            onClick={() => onChange('hidden')}
            title="Hide sidebar"
            className="p-1.5 rounded-lg hover:bg-hover text-ink-faint transition-colors"
          >
            <PanelLeftClose size={18} />
          </button>
        )}
      </div>

      {/* Nav */}
      <div className="flex-1 py-2 px-2 overflow-y-auto">
        <NavRow
          label="Search"
          Icon={Search}
          expanded={expanded}
          onClick={() => window.dispatchEvent(new CustomEvent('open-command-palette'))}
          trailing={
            <kbd className="text-[10px] font-mono text-ink-faint border border-edge rounded px-1 py-0.5">⌘K</kbd>
          }
        />
        <SectionLabel show={expanded}>Workspace</SectionLabel>
        <div className="space-y-0.5">
          {WORKSPACE_NAV.map(item => (
            <NavRow
              key={item.id}
              label={item.label}
              Icon={item.Icon}
              expanded={expanded}
              active={item.match(location.pathname)}
              onClick={() => navigate(item.path)}
            />
          ))}
        </div>
        <SectionLabel show={expanded}>Tools</SectionLabel>
        <div className="space-y-0.5">
          {TOOLS_NAV.map(item => (
            <NavRow
              key={item.id}
              label={item.label}
              Icon={item.Icon}
              expanded={expanded}
              active={item.match(location.pathname)}
              onClick={() => navigate(item.path)}
            />
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className="px-2 pb-3 pt-2 border-t border-edge space-y-0.5 shrink-0">
        <NavRow
          label={mode === 'dark' ? 'Light mode' : 'Dark mode'}
          Icon={mode === 'dark' ? Sun : Moon}
          expanded={expanded}
          onClick={toggleMode}
        />
        <NavRow
          label="Settings"
          Icon={Settings}
          expanded={expanded}
          active={location.pathname === '/settings'}
          onClick={() => navigate('/settings')}
        />
        <button
          onClick={handleLogout}
          title={!expanded ? `${user.username || 'User'} — Logout` : undefined}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium text-ink-soft hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-600 dark:hover:text-red-400 transition-colors"
        >
          <LogOut size={18} className="shrink-0" />
          {expanded && (
            <div className="text-left min-w-0">
              <p className="text-sm font-medium truncate">{user.username || 'User'}</p>
              <p className="text-[11px] text-ink-faint">Logout</p>
            </div>
          )}
        </button>
      </div>
    </div>
  );
};
```

- [ ] **Step 4: Implement AppShell**

```tsx
// src/components/shell/AppShell.tsx
import React, { useEffect, useState } from 'react';
import { useLocation, matchPath } from 'react-router-dom';
import { Sidebar, SidebarState } from './Sidebar';

// Keep the legacy storage key so existing users keep their saved preference.
const SIDEBAR_STORAGE_KEY = 'sideDockState';

export const AppShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const location = useLocation();
  const isLoginPage = location.pathname === '/login';
  const isCanvasPage = !!matchPath('/project/:projectId/page/:pageId', location.pathname);

  const [sidebarState, setSidebarState] = useState<SidebarState>(() => {
    const saved = localStorage.getItem(SIDEBAR_STORAGE_KEY) as SidebarState | null;
    return saved && ['expanded', 'collapsed', 'hidden'].includes(saved) ? saved : 'expanded';
  });

  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const handleChange = (s: SidebarState) => {
    setSidebarState(s);
    localStorage.setItem(SIDEBAR_STORAGE_KEY, s);
  };

  // Canvas is full-bleed (spec §4.3): thin rail on desktop, no sidebar on
  // mobile. The stored preference is left untouched.
  const effectiveState: SidebarState = isCanvasPage ? 'collapsed' : sidebarState;
  const showSidebar = !isLoginPage && !(isMobile && isCanvasPage);

  const marginLeft =
    !showSidebar || effectiveState === 'hidden' ? 0 : effectiveState === 'collapsed' ? 64 : 208;

  return (
    <>
      {showSidebar && <Sidebar state={effectiveState} onChange={handleChange} locked={isCanvasPage} />}
      <div className="min-h-screen bg-surface" style={{ marginLeft, transition: 'margin-left 200ms' }}>
        {children}
      </div>
    </>
  );
};
```

**Deliberate behavior changes vs SideDock (all intended):**
- Default state is `expanded` (was `collapsed`) — Linear/Notion pattern; saved preferences still win.
- On desktop canvas routes the rail is *forced* thin (`collapsed`) and the size toggles disappear; previously the user's stored state applied. Stored preference is untouched.
- A stored `hidden` state also becomes the thin rail on canvas (you can't expand there anyway).

- [ ] **Step 5: Rewire App.tsx and delete SideDock**

In `src/App.tsx`:

1. Remove the imports of `SideDock`/`DockState` and `matchPath`; add `import { AppShell } from './components/shell/AppShell';`
2. Remove the `DOCK_STORAGE_KEY` constant.
3. Replace the whole `Layout` component (lines 29-83) with:

```tsx
const Layout: React.FC<{ appName: string; logoUrl: string }> = ({ appName, logoUrl }) => {
  const location = useLocation();
  const isLoginPage = location.pathname === '/login';

  return (
    <ToastProvider>
      <ProjectConflictListener />
      <ConfirmProvider>
        <ShareProvider>
          <CollaborationProvider>
            <NotesProvider>
              {!isLoginPage && <CommandPalette />}
              <AppShell>
                <UserPresenceOverlay />
                <NotesOverlay />
                <Outlet context={{ appName, logoUrl }} />
              </AppShell>
            </NotesProvider>
          </CollaborationProvider>
        </ShareProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
};
```

(`useState`/`useEffect` may become unused in App.tsx's React import — `React, { useEffect, useState }` is still needed by the `App` component below; leave it.)

4. Delete the old dock file:

```bash
git rm src/components/SideDock.tsx
```

- [ ] **Step 6: Run tests, typecheck, and verify in the browser**

Run: `npx vitest run src/components/shell && npm run lint`
Expected: PASS (4 tests), no type errors (a leftover `SideDock` reference anywhere would fail lint here).

```bash
STORAGE_PATH=/tmp/ft-p2-$$ npm run dev
```

Verify: sidebar shows Workspace/Tools groups with the active item glowing; collapse/expand/hide all work and persist across reload; theme toggle flips the whole app instantly; open a project → open a sheet (canvas) → sidebar becomes a thin rail with no toggles, canvas gets the full width minus 64px; on a narrow window (<768px) the canvas has no sidebar at all; `/login` (after logout) has no sidebar. Stop the server.

- [ ] **Step 7: Commit**

```bash
git add src/components/shell src/App.tsx
git commit -m "feat: contextual app shell — token-styled sidebar with glow active nav"
```

---

### Task 9: ProjectView Tabs → URL Search Param

**Files:**
- Modify: `src/pages/ProjectView.tsx`

The project sidebar (Task 10) needs to highlight and navigate to ProjectView's sections. Tab state moves from `useState` to the `?tab=` search param. No automated test — ProjectView is a 5,619-line monolith with heavy fetch dependencies (it gets split in Phase 5); verification is manual in Step 4.

- [ ] **Step 1: Add the tab type at module scope**

In `src/pages/ProjectView.tsx`, directly above the `export const ProjectView` component declaration, add:

```ts
const PROJECT_TAB_VALUES = ['pages', 'takeoffs', 'printouts', 'email', 'notes'] as const;
type ProjectTab = (typeof PROJECT_TAB_VALUES)[number];
```

- [ ] **Step 2: Move the searchParams hook above the tab state**

The `useSearchParams` block currently sits at `ProjectView.tsx:839-848`, *below* where `activeTab` is declared (line 619). Cut these lines:

```ts
  const [searchParams, setSearchParams] = useSearchParams();
  const searchTerm = searchParams.get('search') || '';
  const setSearchTerm = (term: string) => {
    if (term) {
      searchParams.set('search', term);
    } else {
      searchParams.delete('search');
    }
    setSearchParams(searchParams, { replace: true });
  };
```

and paste them immediately after `const location = useLocation();` (line 612), so `searchParams` exists before the tab derivation.

- [ ] **Step 3: Replace the activeTab useState with a URL derivation**

Replace line 619:

```ts
  const [activeTab, setActiveTab] = useState<'pages' | 'takeoffs' | 'printouts' | 'email' | 'notes'>('pages');
```

with:

```ts
  // Tab lives in the URL so the project sidebar can highlight the section,
  // refresh/back preserve it, and links can target a tab directly.
  const tabParam = searchParams.get('tab');
  const activeTab: ProjectTab = (PROJECT_TAB_VALUES as readonly string[]).includes(tabParam ?? '')
    ? (tabParam as ProjectTab)
    : 'pages';
  const setActiveTab = (tab: ProjectTab) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (tab === 'pages') next.delete('tab');
      else next.set('tab', tab);
      return next;
    }, { replace: true });
  };
```

Everything else keeps working unchanged: the tab-button row (`ProjectView.tsx:3450-3505`) and the `location.state.activeTab` effect (`ProjectView.tsx:969-973`, used by CommandPalette's takeoff results) both call `setActiveTab(...)`, which now writes the URL. Effects keyed on `activeTab` (lines 677, 685, 744) see the same value transitions as before.

- [ ] **Step 4: Typecheck and verify manually**

Run: `npm run lint`
Expected: clean. (If tsc reports `setActiveTab` being called with a plain `string` anywhere, cast at that call site after confirming the value is one of the five tabs.)

Then with the dev server running: open a project → click Takeoffs → URL shows `?tab=takeoffs` → refresh keeps the tab → browser Back returns to Pages → ⌘K, search a takeoff name, select it → lands on the Takeoffs tab. The `?search=` box on the pages tab still works alongside `?tab=`.

- [ ] **Step 5: Commit**

```bash
git add src/pages/ProjectView.tsx
git commit -m "feat: ProjectView tab state lives in ?tab= search param"
```

---

### Task 10: Project-Context Sidebar

**Files:**
- Create: `src/context/ProjectShellContext.tsx`
- Modify: `src/components/shell/AppShell.tsx` (wrap children in the provider)
- Modify: `src/components/shell/Sidebar.tsx` (project mode)
- Modify: `src/pages/ProjectView.tsx` (register project)
- Modify: `src/pages/CanvasView.tsx` (register project)
- Test: `src/components/shell/Sidebar.test.tsx` (append describe block)

This is the contextual swap (spec §2 "Navigation shell"): on `/project/:id` routes the sidebar replaces company nav with "← All Projects", the project name, and the project's sections. Sections map to today's ProjectView tabs; Phase 3 replaces them with the full section list (Overview, Documents, Billing, …).

- [ ] **Step 1: Write the failing tests** (append to `src/components/shell/Sidebar.test.tsx`; add the two imports to the top of the file)

```tsx
import { ProjectShellProvider, useRegisterProjectShell } from '../../context/ProjectShellContext';

const RegisterProject: React.FC<{ id: string; name: string }> = ({ id, name }) => {
  useRegisterProjectShell(id, name);
  return null;
};
```

(Also add `import React from 'react';` if not already present.)

```tsx
describe('Sidebar — project mode', () => {
  const renderProject = (path: string) =>
    render(
      <ThemeProvider>
        <MemoryRouter initialEntries={[path]}>
          <ProjectShellProvider>
            <RegisterProject id="p1" name="Maple St Office" />
            <Sidebar state="expanded" onChange={() => {}} />
          </ProjectShellProvider>
        </MemoryRouter>
      </ThemeProvider>
    );

  it('swaps to project nav on project routes', () => {
    renderProject('/project/p1');
    expect(screen.getByRole('button', { name: /All Projects/ })).toBeInTheDocument();
    expect(screen.getByText('Maple St Office')).toBeInTheDocument();
    for (const label of ['Plans & Pages', 'Takeoffs', 'Printouts', 'Proposal', 'Notes']) {
      expect(screen.getByRole('button', { name: new RegExp(label) })).toBeInTheDocument();
    }
    // company nav is gone
    expect(screen.queryByRole('button', { name: /Checklists/ })).not.toBeInTheDocument();
  });

  it('highlights the section matching ?tab=', () => {
    renderProject('/project/p1?tab=takeoffs');
    expect(screen.getByRole('button', { name: /Takeoffs/ }).className).toContain('glow-accent');
    expect(screen.getByRole('button', { name: /Plans & Pages/ }).className).not.toContain('glow-accent');
  });

  it('stays in company mode off project routes', () => {
    renderProject('/time');
    expect(screen.queryByRole('button', { name: /All Projects/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Checklists/ })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/shell`
Expected: FAIL — `Cannot find module '../../context/ProjectShellContext'`

- [ ] **Step 3: Implement the context**

```tsx
// src/context/ProjectShellContext.tsx
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

export interface ProjectShellInfo {
  id: string;
  name: string;
}

interface ProjectShellCtx {
  project: ProjectShellInfo | null;
  setProject: (p: ProjectShellInfo | null) => void;
}

// Default works without a provider (company-mode-only renders in tests).
const ProjectShellContext = createContext<ProjectShellCtx>({
  project: null,
  setProject: () => {},
});

export const useProjectShell = () => useContext(ProjectShellContext);

export const ProjectShellProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [project, setProject] = useState<ProjectShellInfo | null>(null);
  const value = useMemo(() => ({ project, setProject }), [project]);
  return <ProjectShellContext.Provider value={value}>{children}</ProjectShellContext.Provider>;
};

// Pages that load a project call this so the sidebar can show its name.
// Cleared on unmount. Safe to call with undefined while the project loads.
export function useRegisterProjectShell(id: string | undefined, name: string | undefined): void {
  const { setProject } = useProjectShell();
  useEffect(() => {
    if (id) setProject({ id, name: name || 'Untitled' });
  }, [id, name, setProject]);
  useEffect(() => () => setProject(null), [setProject]);
}
```

- [ ] **Step 4: Wrap AppShell's tree in the provider**

In `src/components/shell/AppShell.tsx`, add `import { ProjectShellProvider } from '../../context/ProjectShellContext';` and change the return statement to:

```tsx
  return (
    <ProjectShellProvider>
      {showSidebar && <Sidebar state={effectiveState} onChange={handleChange} locked={isCanvasPage} />}
      <div className="min-h-screen bg-surface" style={{ marginLeft, transition: 'margin-left 200ms' }}>
        {children}
      </div>
    </ProjectShellProvider>
  );
```

- [ ] **Step 5: Add project mode to the Sidebar**

In `src/components/shell/Sidebar.tsx`:

1. Extend the react-router import: `import { useLocation, useNavigate, matchPath } from 'react-router-dom';`
2. Extend the lucide import with: `ArrowLeft, LayoutGrid, Ruler, Printer, Mail, StickyNote`
3. Add: `import { useProjectShell } from '../../context/ProjectShellContext';`
4. Below `TOOLS_NAV`, add the project section list:

```tsx
// Project sections, Phase 2 edition: they map onto ProjectView's tabs
// (?tab= — Task 9). Phase 3 replaces these with the full section list
// (Overview, Documents, Billing, …) and real routes.
const PROJECT_NAV: { id: string; label: string; Icon: NavEntry['Icon']; tab: string | null }[] = [
  { id: 'pages',     label: 'Plans & Pages', Icon: LayoutGrid, tab: null },
  { id: 'takeoffs',  label: 'Takeoffs',      Icon: Ruler,      tab: 'takeoffs' },
  { id: 'printouts', label: 'Printouts',     Icon: Printer,    tab: 'printouts' },
  { id: 'email',     label: 'Proposal',      Icon: Mail,       tab: 'email' },
  { id: 'notes',     label: 'Notes',         Icon: StickyNote, tab: 'notes' },
];
```

5. Inside the `Sidebar` component body, after `const { mode, toggleMode } = useTheme();`, add:

```tsx
  const { project } = useProjectShell();
  const projectMatch = matchPath({ path: '/project/:projectId', end: false }, location.pathname);
  const projectId = projectMatch?.params.projectId;
  const onProjectRoot = !!matchPath('/project/:projectId', location.pathname);
  const activeTab = new URLSearchParams(location.search).get('tab') ?? 'pages';
```

(Hooks must stay above the `if (location.pathname === '/login' …) return null;` line — put these right before it.)

6. Replace the entire `{/* Nav */}` block (from `<div className="flex-1 py-2 px-2 overflow-y-auto">` through its closing `</div>`) with:

```tsx
      {/* Nav */}
      <div className="flex-1 py-2 px-2 overflow-y-auto">
        <NavRow
          label="Search"
          Icon={Search}
          expanded={expanded}
          onClick={() => window.dispatchEvent(new CustomEvent('open-command-palette'))}
          trailing={
            <kbd className="text-[10px] font-mono text-ink-faint border border-edge rounded px-1 py-0.5">⌘K</kbd>
          }
        />
        {projectId ? (
          <>
            <div className="pt-2">
              <NavRow
                label="All Projects"
                Icon={ArrowLeft}
                expanded={expanded}
                onClick={() => navigate('/')}
              />
            </div>
            {expanded && (
              <p
                className="px-3 pt-3 pb-1 text-sm font-semibold text-ink truncate"
                title={project && project.id === projectId ? project.name : undefined}
              >
                {project && project.id === projectId ? project.name : 'Project'}
              </p>
            )}
            <div className="space-y-0.5">
              {PROJECT_NAV.map(item => (
                <NavRow
                  key={item.id}
                  label={item.label}
                  Icon={item.Icon}
                  expanded={expanded}
                  active={onProjectRoot && activeTab === (item.tab ?? 'pages')}
                  onClick={() =>
                    navigate(item.tab ? `/project/${projectId}?tab=${item.tab}` : `/project/${projectId}`)
                  }
                />
              ))}
            </div>
          </>
        ) : (
          <>
            <SectionLabel show={expanded}>Workspace</SectionLabel>
            <div className="space-y-0.5">
              {WORKSPACE_NAV.map(item => (
                <NavRow
                  key={item.id}
                  label={item.label}
                  Icon={item.Icon}
                  expanded={expanded}
                  active={item.match(location.pathname)}
                  onClick={() => navigate(item.path)}
                />
              ))}
            </div>
            <SectionLabel show={expanded}>Tools</SectionLabel>
            <div className="space-y-0.5">
              {TOOLS_NAV.map(item => (
                <NavRow
                  key={item.id}
                  label={item.label}
                  Icon={item.Icon}
                  expanded={expanded}
                  active={item.match(location.pathname)}
                  onClick={() => navigate(item.path)}
                />
              ))}
            </div>
          </>
        )}
      </div>
```

- [ ] **Step 6: Register the project from both project pages**

In `src/pages/ProjectView.tsx`, add the import:

```ts
import { useRegisterProjectShell } from '../context/ProjectShellContext';
```

and directly after `const [project, setProject] = useState<Project | null>(null);` (line 613) add:

```ts
  useRegisterProjectShell(project?.id, project?.name);
```

In `src/pages/CanvasView.tsx`, add the same import and the same line directly after its `const [project, setProject] = useState<Project | null>(null);` (line 211).

- [ ] **Step 7: Run to verify pass**

Run: `npx vitest run src/components/shell && npm run lint`
Expected: PASS (7 tests: 4 company + 3 project), no type errors.

- [ ] **Step 8: Verify the swap in the browser**

With the dev server running: open a project from the list → sidebar swaps to "← All Projects" + project name + sections; click Takeoffs → ProjectView switches tabs and the sidebar item glows; click "All Projects" → company sidebar returns; refresh on `/project/:id?tab=takeoffs` → sidebar shows "Project" for an instant, then the name once loaded, Takeoffs highlighted; open a sheet → thin rail (icons only) with project sections still clickable.

- [ ] **Step 9: Commit**

```bash
git add src/context/ProjectShellContext.tsx src/components/shell src/pages/ProjectView.tsx src/pages/CanvasView.tsx
git commit -m "feat: contextual sidebar swaps to project sections on project routes"
```

---

### Task 11: Full Verification + Manual Smoke

**Files:** none (verification only)

- [ ] **Step 1: Full automated pass**

Run: `npm run lint && npm test && npm run build`
Expected: zero type errors, all server + ui suites green, production build succeeds.

- [ ] **Step 2: Shell smoke checklist** (fresh dev server: `STORAGE_PATH=/tmp/ft-p2-final-$$ npm run dev`)

Run the whole list once in **light** and once in **dark** (toggle from the sidebar footer):

- [ ] `/login` — no sidebar; login works (admin/admin on fresh data)
- [ ] `/` — projects list renders in the shell; Projects nav item glows; tabs (Projects/Templates/Bids/Users) all render
- [ ] `/new` — wizard renders; Projects stays the active nav item
- [ ] `/project/:id` — sidebar swaps to project mode (name + sections); all five sections switch ProjectView tabs and highlight correctly; `?tab=` survives refresh and Back
- [ ] Canvas page — thin rail, no size toggles, full-bleed canvas; drawing/panning unaffected; rail sections navigate back to ProjectView
- [ ] `/checklist`, `/time`, `/pdf-editor`, `/spreadsheet-editor`, `/settings` — each renders in the shell with the right item active
- [ ] Sidebar expand/collapse/hide persists across reload; hidden state shows the floating menu button
- [ ] Narrow window (<768px): canvas has no sidebar; other pages keep the rail
- [ ] ⌘K palette opens from the sidebar Search row and from the keyboard; navigation entries still work
- [ ] Accent color change in Settings → Appearance recolors glow (active nav, primary buttons) live
- [ ] Whole app renders in Inter (check a table and a heading); no layout breakage anywhere obvious
- [ ] Logout from the sidebar footer returns to `/login` with no sidebar

- [ ] **Step 3: Regression spot-check on real workflows** (same server)

- [ ] Create a project from a small PDF; pages appear; draw a measurement; reload — persists (Phase 1 behavior intact)
- [ ] Two-tab conflict test still shows the conflict toast (Phase 1 Task 11 behavior — the shell must not swallow the listener)
- [ ] Share link (`/share/:shareId`) still renders **without** any sidebar (it's outside Layout)

- [ ] **Step 4: Push**

```bash
git push origin testing
```

---

## Plan Self-Review Notes (already applied)

1. **Spec coverage (§5, §9 Phase 2, §2 nav-shell decision):** design tokens per theme ✅ (Task 2, `@theme inline` + per-theme vars) · glow reserved for primary buttons/active nav/progress bars ✅ (Tasks 2, 3, 7, 8 — `glow-accent`/`glow-bar` are the only glow sources) · data surfaces stay flat ✅ (Card/Table/Form ship borderless-of-glass; pinned by Card test) · component library Button/Card/StatusPill/Table/Modal/Form/EmptyState/Skeleton ✅ (Tasks 3–7, plus ProgressBar) · contextual sidebar swap with "← All Projects" ✅ (Tasks 8, 10) · canvas full-bleed thin rail (spec §4.3) ✅ (Task 8) · light/dark first-class ✅ (every token per-theme; theme toggle in sidebar; smoke runs both) · Inter with system fallback ✅ (Task 2) · existing pages mounted unchanged ✅ (Task 11 regression checks).
2. **Known deliberate deferrals:** Dashboard page, `/tools/*` + `/p/:id/*` routes, role-based nav hiding, ⌘K actions ("clock in"), and rebuilding screens on the library are all Phase 3+; ProjectsList keeps its internal Bids/Templates/Users tabs until Phase 3; `glass`/`theme-page`/`theme-card` utilities stay until Phases 3–5 remove their last consumers; StatusPill ships now but gains consumers in Phase 3 (pipeline cards).
3. **Type consistency check:** `SidebarState` defined once in `Sidebar.tsx`, imported by `AppShell` · `NavRow`/`NavEntry` shapes match between Task 8 definition and Task 10 usage (`PROJECT_NAV` reuses `NavEntry['Icon']`) · `useRegisterProjectShell(id, name)` signature matches both page call sites and the test helper · `ProjectTab` in ProjectView matches the five `?tab=` values the Sidebar navigates to (`null` ⇒ `pages`) · barrel exports match each component's actual export names.
4. **Placeholder scan:** every code step contains complete code; the only intentionally deferred items are labeled as Phase 3+ work in prose, not as TODOs in code.
5. **Interaction risks checked:** `sideDockState` localStorage key reused so saved layouts survive · CommandPalette's `navigate('/project/:id', { state: { activeTab: 'takeoffs' } })` keeps working because the `location.state` effect now writes the URL param · `?search=` and `?tab=` coexist (independent keys, both `replace: true`) · Sidebar renders fine without `ProjectShellProvider` (context default) so Task 8 tests don't depend on Task 10's provider.
