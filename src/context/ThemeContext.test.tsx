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
