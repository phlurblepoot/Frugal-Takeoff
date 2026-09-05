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
// configurable"), so both the stop() observation (unmount-cleanup test) and
// the onUpdate observation (genuine-tween test below) are wired through a
// real vi.mock that wraps the actual `animate` — hoisted spies so both the
// mock factory and the tests can reach them.
const { stopSpy, onUpdateSpy } = vi.hoisted(() => ({ stopSpy: vi.fn(), onUpdateSpy: vi.fn() }));
vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return {
    ...actual,
    animate: (...args: unknown[]) => {
      const [from, to, options] = args as [number, number, { onUpdate?: (v: number) => void } & Record<string, unknown> | undefined];
      const wrappedOptions = options
        ? {
            ...options,
            onUpdate: (latest: number) => {
              onUpdateSpy(latest);
              options.onUpdate?.(latest);
            },
          }
        : options;
      const controls = actual.animate(from, to, wrappedOptions as never);
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

  // Regression coverage: a mutation that replaces the tween with a synchronous
  // no-op (render format(value) immediately, never call animate) still passes
  // every "eventually shows the final value" test above, because those only
  // assert the end-state. This test proves motion's animate() is genuinely
  // driving multiple, monotonically-progressing onUpdate frames from below the
  // target up to it — not a single jump. Verified this actually goes RED
  // against that no-op mutation (see fix report for the stashed repro).
  it('proves a genuine tween: onUpdate fires repeatedly with increasing values up to the target', async () => {
    onUpdateSpy.mockClear();
    render(
      <ThemeProvider>
        <CountUp value={1000} durationMs={150} />
      </ThemeProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('1,000')).toBeInTheDocument();
    });

    const observed = onUpdateSpy.mock.calls.map(([latest]) => latest as number);

    // A no-op / synchronous implementation never calls animate() at all, so
    // onUpdate is never invoked — this is the assertion that catches it.
    expect(observed.length).toBeGreaterThan(1);

    // Frames must actually progress toward the target, not jump straight there.
    expect(observed[0]).toBeLessThan(1000);

    // easeOut is monotonically non-decreasing from 0 -> 1000 for this call.
    for (let i = 1; i < observed.length; i++) {
      expect(observed[i]).toBeGreaterThanOrEqual(observed[i - 1]);
    }

    expect(observed[observed.length - 1]).toBe(1000);
  });

  // Regression coverage: CountUp used to round every intermediate frame to an
  // integer internally, so a fractional caller formatter (toFixed(1), used by
  // dash-my-hours / pj-my-hours) settled on a rounded integer like "3.0"
  // instead of "2.5". Rounding must live only in the default formatter.
  it('does not corrupt a fractional value when the caller formats with toFixed', async () => {
    render(
      <ThemeProvider>
        <CountUp value={2.5} format={v => v.toFixed(1)} durationMs={30} />
      </ThemeProvider>
    );
    await waitFor(() => {
      expect(screen.getByText('2.5')).toBeInTheDocument();
    });
  });
});
