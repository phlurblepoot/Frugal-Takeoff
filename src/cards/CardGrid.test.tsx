// src/cards/CardGrid.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import type { CardDef, CardLayout } from './types';

const getUserPreferences = vi.fn(async (): Promise<Record<string, string>> => ({}));
const saveUserPreferences = vi.fn(async (_p: Record<string, string>): Promise<void> => {});

vi.mock('../utils/store', async () => {
  const actual = await vi.importActual<typeof import('../utils/store')>('../utils/store');
  return { ...actual, getUserPreferences, saveUserPreferences };
});

const { CardGrid } = await import('./CardGrid');
const { CARD_REGISTRY, registerCards, DEFAULT_LAYOUTS } = await import('./registry');

// Three throwaway cards covering the width spectrum (brief: [1,2,3]/[1]/[1,2],
// one adminOnly). Component body renders id+width so span/clamp assertions
// have something concrete to read.
const CARD_A: CardDef = {
  id: 'card-a', title: 'Card A', icon: () => null, page: 'dashboard',
  widths: [1, 2, 3], defaultWidth: 1,
  Component: ({ width }) => <div data-testid="body-card-a">a:{width}</div>,
};
const CARD_B: CardDef = {
  id: 'card-b', title: 'Card B', icon: () => null, page: 'dashboard',
  widths: [1], defaultWidth: 1,
  Component: ({ width }) => <div data-testid="body-card-b">b:{width}</div>,
};
const CARD_C: CardDef = {
  id: 'card-c', title: 'Card C', icon: () => null, page: 'dashboard',
  widths: [1, 2], defaultWidth: 1, adminOnly: true,
  Component: ({ width }) => <div data-testid="body-card-c">c:{width}</div>,
};

const ORIGINAL_DASHBOARD_DEFAULT = DEFAULT_LAYOUTS.dashboard;

function seed(layout: CardLayout) {
  localStorage.setItem('cards-dashboard', JSON.stringify(layout));
}

function mockMatchMedia(matching: string[] = []) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: matching.includes(query),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// cols=3 (mid breakpoint only) is the default for tests that don't care about
// clamping — every fixture width here is <=2 so nothing clamps at cols=3.
function mockCols3() {
  mockMatchMedia(['(min-width: 1024px)']);
}

beforeEach(() => {
  CARD_REGISTRY.splice(0, CARD_REGISTRY.length);
  registerCards([CARD_A, CARD_B, CARD_C]);
  // Test-owned default layout (distinct widths from any "customized" fixture
  // below) so the reset case can prove it actually restored something.
  DEFAULT_LAYOUTS.dashboard = {
    version: 1,
    cards: [{ id: 'card-a', width: 1 }, { id: 'card-b', width: 1 }, { id: 'card-c', width: 1 }],
  };
  localStorage.clear();
  getUserPreferences.mockClear().mockResolvedValue({});
  saveUserPreferences.mockClear().mockResolvedValue(undefined);
  mockCols3();
});

afterEach(() => {
  DEFAULT_LAYOUTS.dashboard = ORIGINAL_DASHBOARD_DEFAULT;
});

function mount(ctx = { isAdmin: true }) {
  return render(<CardGrid page="dashboard" ctx={ctx} />);
}

function wrapperIds() {
  return Array.from(screen.getByTestId('card-grid').querySelectorAll('[data-card-id]')).map(el =>
    el.getAttribute('data-card-id')
  );
}

describe('CardGrid', () => {
  it('(a) renders layout cards in order with span style', () => {
    seed({ version: 1, cards: [{ id: 'card-a', width: 2 }, { id: 'card-b', width: 1 }, { id: 'card-c', width: 2 }] });
    mount();

    expect(wrapperIds()).toEqual(['card-a', 'card-b', 'card-c']);
    const grid = screen.getByTestId('card-grid');
    const a = grid.querySelector('[data-card-id="card-a"]') as HTMLElement;
    const b = grid.querySelector('[data-card-id="card-b"]') as HTMLElement;
    expect(a.style.gridColumn).toBe('span 2');
    expect(b.style.gridColumn).toBe('span 1');
    expect(screen.getByTestId('body-card-a')).toHaveTextContent('a:2');
  });

  it('(b) span clamps: width-3 card at cols=2 renders span 2', () => {
    seed({ version: 1, cards: [{ id: 'card-a', width: 3 }] });
    mockMatchMedia(['(min-width: 640px)']); // cols=2
    mount();

    const wrapper = screen.getByTestId('card-grid').querySelector('[data-card-id="card-a"]') as HTMLElement;
    expect(wrapper.style.gridColumn).toBe('span 2');
    expect(screen.getByTestId('body-card-a')).toHaveTextContent('a:2');
  });

  it('(c) Customize reveals remove/width/tray controls', () => {
    seed({ version: 1, cards: [{ id: 'card-a', width: 1 }, { id: 'card-b', width: 1 }] });
    mount();

    expect(screen.queryByTestId('cards-tray')).toBeNull();
    expect(screen.queryByLabelText('Remove Card A')).toBeNull();

    fireEvent.click(screen.getByTestId('cards-customize'));

    expect(screen.getByTestId('cards-customize')).toHaveTextContent('✓ Done');
    expect(screen.getByTestId('cards-reset')).toBeInTheDocument();
    expect(screen.getByLabelText('Remove Card A')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Card A width' })).toBeInTheDocument();
    expect(screen.getByTestId('cards-tray')).toBeInTheDocument();
  });

  it('(d) width button updates layout and persists', async () => {
    localStorage.setItem('token', 'tok');
    seed({ version: 1, cards: [{ id: 'card-a', width: 1 }] });
    mount();

    fireEvent.click(screen.getByTestId('cards-customize'));
    const group = screen.getByRole('group', { name: 'Card A width' });
    fireEvent.click(within(group).getByRole('button', { name: '2' }));

    expect(screen.getByTestId('body-card-a')).toHaveTextContent('a:2');
    await waitFor(() => {
      expect(saveUserPreferences).toHaveBeenCalledWith({
        'cards-dashboard': JSON.stringify({ version: 1, cards: [{ id: 'card-a', width: 2 }] }),
      });
    });
  });

  it('(e) remove moves card to tray; tray click re-adds it', () => {
    seed({ version: 1, cards: [{ id: 'card-a', width: 1 }, { id: 'card-b', width: 1 }] });
    mount();
    fireEvent.click(screen.getByTestId('cards-customize'));

    fireEvent.click(screen.getByLabelText('Remove Card B'));
    expect(wrapperIds()).toEqual(['card-a']);
    expect(screen.getByRole('button', { name: '+ Card B' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '+ Card B' }));
    expect(wrapperIds()).toEqual(['card-a', 'card-b']);
    expect(screen.queryByRole('button', { name: '+ Card B' })).toBeNull();
  });

  it('(f) adminOnly card is absent from the tray for a non-admin ctx', () => {
    seed({ version: 1, cards: [{ id: 'card-a', width: 1 }, { id: 'card-b', width: 1 }] });
    mount({ isAdmin: false });
    fireEvent.click(screen.getByTestId('cards-customize'));

    expect(screen.queryByRole('button', { name: '+ Card C' })).toBeNull();
  });

  it('(g) reset restores the default layout', () => {
    seed({ version: 1, cards: [{ id: 'card-a', width: 3 }, { id: 'card-c', width: 2 }] });
    mount();
    fireEvent.click(screen.getByTestId('cards-customize'));

    fireEvent.click(screen.getByTestId('cards-reset'));

    expect(wrapperIds()).toEqual(['card-a', 'card-b', 'card-c']);
    expect(screen.getByTestId('body-card-a')).toHaveTextContent('a:1');
  });

  it('(h) drag reorders before the drop target and persists', async () => {
    localStorage.setItem('token', 'tok');
    seed({ version: 1, cards: [{ id: 'card-a', width: 1 }, { id: 'card-b', width: 1 }, { id: 'card-c', width: 1 }] });
    mount();
    fireEvent.click(screen.getByTestId('cards-customize'));

    const grid = screen.getByTestId('card-grid');
    const a = grid.querySelector('[data-card-id="card-a"]') as HTMLElement;
    const c = grid.querySelector('[data-card-id="card-c"]') as HTMLElement;

    fireEvent.dragStart(a);
    fireEvent.dragOver(c);
    fireEvent.drop(c);

    expect(wrapperIds()).toEqual(['card-b', 'card-a', 'card-c']);
    await waitFor(() => {
      expect(saveUserPreferences).toHaveBeenCalledWith({
        'cards-dashboard': JSON.stringify({
          version: 1,
          cards: [{ id: 'card-b', width: 1 }, { id: 'card-a', width: 1 }, { id: 'card-c', width: 1 }],
        }),
      });
    });
  });

  it('drag is inert outside Customize mode (handlers gated, not just draggable)', async () => {
    localStorage.setItem('token', 'tok');
    seed({ version: 1, cards: [{ id: 'card-a', width: 1 }, { id: 'card-b', width: 1 }, { id: 'card-c', width: 1 }] });
    mount();
    // Not editing — no fireEvent.click(cards-customize).

    const grid = screen.getByTestId('card-grid');
    const a = grid.querySelector('[data-card-id="card-a"]') as HTMLElement;
    const c = grid.querySelector('[data-card-id="card-c"]') as HTMLElement;

    fireEvent.dragStart(a);
    fireEvent.dragOver(c);
    fireEvent.drop(c);

    expect(wrapperIds()).toEqual(['card-a', 'card-b', 'card-c']);
    // Give any errant async persistence a tick to have fired before asserting its absence.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(saveUserPreferences).not.toHaveBeenCalled();
  });

  it('shows a hint and a reachable tray when the layout is empty', () => {
    seed({ version: 1, cards: [] });
    mount();

    expect(screen.getByTestId('card-grid')).toHaveTextContent(/no cards yet/i);
    fireEvent.click(screen.getByTestId('cards-customize'));
    expect(screen.getByTestId('cards-tray')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ Card A' })).toBeInTheDocument();
  });
});
