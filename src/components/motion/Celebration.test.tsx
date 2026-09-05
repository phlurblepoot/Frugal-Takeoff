import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ThemeProvider } from '../../context/ThemeContext';
import { CelebrationOverlay } from './Celebration';

describe('CelebrationOverlay', () => {
  beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); });
  afterEach(() => vi.useRealTimers());

  it('renders confetti pieces on a confetti celebrate event and self-removes after ~1s', () => {
    render(<ThemeProvider><CelebrationOverlay /></ThemeProvider>);
    act(() => {
      window.dispatchEvent(new CustomEvent('celebrate', { detail: { variant: 'confetti', x: 40, y: 500 } }));
    });
    const overlay = screen.getByTestId('celebration-confetti');
    expect(overlay).toBeInTheDocument();
    expect(overlay.querySelectorAll('.celebration-confetti-piece').length).toBeGreaterThanOrEqual(14);
    act(() => { vi.advanceTimersByTime(1050); });
    expect(screen.queryByTestId('celebration-confetti')).toBeNull();
  });

  it('renders a pulse glow on a pulse celebrate event and self-removes after ~700ms', () => {
    render(<ThemeProvider><CelebrationOverlay /></ThemeProvider>);
    act(() => {
      window.dispatchEvent(new CustomEvent('celebrate', { detail: { variant: 'pulse', x: 10, y: 20 } }));
    });
    expect(screen.getByTestId('celebration-pulse')).toBeInTheDocument();
    expect(screen.queryByTestId('celebration-confetti')).toBeNull();
    act(() => { vi.advanceTimersByTime(750); });
    expect(screen.queryByTestId('celebration-pulse')).toBeNull();
  });

  it('defaults to confetti variant when none is given', () => {
    render(<ThemeProvider><CelebrationOverlay /></ThemeProvider>);
    act(() => {
      window.dispatchEvent(new CustomEvent('celebrate', { detail: {} }));
    });
    expect(screen.getByTestId('celebration-confetti')).toBeInTheDocument();
  });

  it('does nothing under reduced motion', () => {
    localStorage.setItem('theme-motion', 'reduced');
    render(<ThemeProvider><CelebrationOverlay /></ThemeProvider>);
    act(() => {
      window.dispatchEvent(new CustomEvent('celebrate', { detail: { variant: 'confetti', x: 0, y: 0 } }));
    });
    expect(screen.queryByTestId('celebration-confetti')).toBeNull();
    expect(screen.queryByTestId('celebration-pulse')).toBeNull();
  });
});
