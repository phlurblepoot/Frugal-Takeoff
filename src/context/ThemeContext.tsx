import React, { createContext, useContext, useEffect, useState } from 'react';

export type AccentKey = 'blue' | 'indigo' | 'violet' | 'emerald' | 'rose' | 'amber';
export type ThemeMode = 'light' | 'dark';

const ACCENT_HUES: Record<AccentKey, number> = {
  blue:    264,
  indigo:  283,
  violet:  303,
  emerald: 162,
  rose:    15,
  amber:   84,
};

const ACCENT_SCALES: [number, number, number][] = [
  [50,  0.97, 0.012],
  [100, 0.93, 0.032],
  [200, 0.87, 0.065],
  [300, 0.78, 0.12],
  [400, 0.68, 0.17],
  [500, 0.60, 0.22],
  [600, 0.52, 0.24],
  [700, 0.44, 0.22],
  [800, 0.36, 0.18],
  [900, 0.28, 0.14],
];

function applyAccent(key: AccentKey) {
  const h = ACCENT_HUES[key];
  const el = document.documentElement;
  ACCENT_SCALES.forEach(([step, l, c]) => {
    el.style.setProperty(`--color-accent-${step}`, `oklch(${l} ${c} ${h})`);
  });
}

interface ThemeContextType {
  mode: ThemeMode;
  accentColor: AccentKey;
  reducedMotion: boolean;
  toggleMode: () => void;
  setAccentColor: (key: AccentKey) => void;
  setReducedMotion: (v: boolean) => void;
}

const ThemeContext = createContext<ThemeContextType>({
  mode: 'light',
  accentColor: 'blue',
  reducedMotion: false,
  toggleMode: () => {},
  setAccentColor: () => {},
  setReducedMotion: () => {},
});

export const useTheme = () => useContext(ThemeContext);

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [mode, setMode] = useState<ThemeMode>(() => {
    return (localStorage.getItem('theme-mode') as ThemeMode) || 'light';
  });
  const [accentColor, setAccentColorState] = useState<AccentKey>(() => {
    return (localStorage.getItem('theme-accent') as AccentKey) || 'blue';
  });
  const [reducedMotion, setReducedMotionState] = useState<boolean>(() => {
    return localStorage.getItem('theme-motion') === 'reduced';
  });

  // Apply mode on mount and changes
  useEffect(() => {
    const el = document.documentElement;
    if (mode === 'dark') {
      el.classList.add('dark');
    } else {
      el.classList.remove('dark');
    }
    localStorage.setItem('theme-mode', mode);
  }, [mode]);

  // Apply accent on mount and changes
  useEffect(() => {
    applyAccent(accentColor);
    localStorage.setItem('theme-accent', accentColor);
  }, [accentColor]);

  // Apply reduced motion on mount and changes
  useEffect(() => {
    const el = document.documentElement;
    if (reducedMotion) {
      el.classList.add('motion-reduce');
    } else {
      el.classList.remove('motion-reduce');
    }
    localStorage.setItem('theme-motion', reducedMotion ? 'reduced' : 'full');
  }, [reducedMotion]);

  const toggleMode = () => setMode(prev => prev === 'light' ? 'dark' : 'light');

  const setAccentColor = (key: AccentKey) => {
    setAccentColorState(key);
  };

  const setReducedMotion = (v: boolean) => {
    setReducedMotionState(v);
  };

  return (
    <ThemeContext.Provider value={{ mode, accentColor, reducedMotion, toggleMode, setAccentColor, setReducedMotion }}>
      {children}
    </ThemeContext.Provider>
  );
};
