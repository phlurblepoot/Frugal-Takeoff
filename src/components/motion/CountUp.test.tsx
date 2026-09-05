// Test approach note: motion's animate() drives updates via requestAnimationFrame.
// Rather than stub rAF and hand-step frames (fragile against motion's internal
// frame-batching), the "normal mode" cases use REAL timers with a short
// `durationMs` and assert only the deterministic end-state via `waitFor` — no
// sleeps, no assertions on interim frames. The reduced-motion cases assert
// synchronously right after render(), since CountUp's initial state is
// computed lazily from `reducedMotion` (no effect needs to fire first).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '../../context/ThemeContext';
import { CountUp } from './CountUp';
import { formatMoney } from '../../utils/money';

// Vitest can't spy on a live ESM named export ("Module namespace is not
// configurable"), so the stop() observation for the unmount-cleanup test is
// wired through a real vi.mock that wraps the actual `animate` — hoisted spy
// so both the mock factory and the test can reach it.
const { stopSpy } = vi.hoisted(() => ({ stopSpy: vi.fn() }));
vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return {
    ...actual,
    animate: (...args: Parameters<typeof actual.animate>) => {
      const controls = actual.animate(...args);
      const originalStop = controls.stop.bind(controls);
      controls.stop = () => {
        stopSpy();
        originalStop();
      };
      return controls;
    },
  };
});

afterEach(() => {
  localStorage.removeItem('theme-motion');
});

describe('CountUp — reduced motion', () => {
  it('renders the exact final formatted value synchronously, no animation', () => {
    localStorage.setItem('theme-motion', 'reduced');
    render(
      <ThemeProvider>
        <CountUp value={148200} format={formatMoney} />
      </ThemeProvider>
    );
    // Present immediately — no waitFor, no interim frame.
    expect(screen.getByText(formatMoney(148200))).toBeInTheDocument();
  });

  it('jumps straight to the new final value when value changes, still no animation', () => {
    localStorage.setItem('theme-motion', 'reduced');
    const { rerender } = render(
      <ThemeProvider>
        <CountUp value={10} />
      </ThemeProvider>
    );
    expect(screen.getByText('10')).toBeInTheDocument();

    rerender(
      <ThemeProvider>
        <CountUp value={2500} />
      </ThemeProvider>
    );
    expect(screen.getByText('2,500')).toBeInTheDocument();
  });
});

describe('CountUp — normal motion', () => {
  it('eventually shows the final default-formatted (toLocaleString) value', async () => {
    render(
      <ThemeProvider>
        <CountUp value={2500} durationMs={30} />
      </ThemeProvider>
    );
    await waitFor(() => {
      expect(screen.getByText('2,500')).toBeInTheDocument();
    });
  });

  it('applies the caller-supplied format (money) to the final value', async () => {
    render(
      <ThemeProvider>
        <CountUp value={148200} format={formatMoney} durationMs={30} />
      </ThemeProvider>
    );
    await waitFor(() => {
      expect(screen.getByText(formatMoney(148200))).toBeInTheDocument();
    });
  });

  it('re-animates to a new final value when `value` changes', async () => {
    const { rerender } = render(
      <ThemeProvider>
        <CountUp value={10} durationMs={30} />
      </ThemeProvider>
    );
    await waitFor(() => {
      expect(screen.getByText('10')).toBeInTheDocument();
    });

    rerender(
      <ThemeProvider>
        <CountUp value={9999} durationMs={30} />
      </ThemeProvider>
    );
    await waitFor(() => {
      expect(screen.getByText('9,999')).toBeInTheDocument();
    });
  });

  it('stops its animation on unmount (no post-unmount updates, no thrown errors)', () => {
    stopSpy.mockClear();
    const { unmount } = render(
      <ThemeProvider>
        <CountUp value={500} durationMs={200} />
      </ThemeProvider>
    );

    expect(() => unmount()).not.toThrow();
    expect(stopSpy).toHaveBeenCalled();
  });
});
