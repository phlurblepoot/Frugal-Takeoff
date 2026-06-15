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
