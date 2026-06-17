import React, { createContext, useContext, useEffect, useState } from 'react';
import { getUserPreferences, saveUserPreferences } from '../utils/store';
import { hexToAccentHue } from '../utils/color';

export type AccentKey = 'blue' | 'indigo' | 'violet' | 'emerald' | 'rose' | 'amber' | 'custom';

const DEFAULT_CUSTOM_HEX = '#2563eb';
export type ThemeMode = 'light' | 'dark';

const ACCENT_HUES: Record<Exclude<AccentKey, 'custom'>, number> = {
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

function applyAccent(key: AccentKey, customHex: string) {
  // Custom accents derive only their HUE from the picked colour and reuse the
  // fixed lightness/chroma scale, so contrast stays consistent with presets.
  const h = key === 'custom' ? hexToAccentHue(customHex) : ACCENT_HUES[key];
  const el = document.documentElement;
  ACCENT_SCALES.forEach(([step, l, c]) => {
    el.style.setProperty(`--color-accent-${step}`, `oklch(${l} ${c} ${h})`);
  });
}

interface ThemeContextType {
  mode: ThemeMode;
  accentColor: AccentKey;
  customAccentHex: string;
  reducedMotion: boolean;
  toggleMode: () => void;
  setAccentColor: (key: AccentKey) => void;
  setCustomAccent: (hex: string) => void;
  setReducedMotion: (v: boolean) => void;
}

const ThemeContext = createContext<ThemeContextType>({
  mode: 'light',
  accentColor: 'blue',
  customAccentHex: DEFAULT_CUSTOM_HEX,
  reducedMotion: false,
  toggleMode: () => {},
  setAccentColor: () => {},
  setCustomAccent: () => {},
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
  const [customAccentHex, setCustomAccentHex] = useState<string>(() => {
    return localStorage.getItem('theme-accent-custom') || DEFAULT_CUSTOM_HEX;
  });
  const [reducedMotion, setReducedMotionState] = useState<boolean>(() => {
    return localStorage.getItem('theme-motion') === 'reduced';
  });

  // Sync from server — server is source of truth for cross-browser settings.
  // Guard: only fetch if logged in (ThemeProvider renders on /login too).
  // Setters use functional/equality checks so re-running is idempotent: applying
  // server values just sets state, which the apply-effects below pick up.
  const syncPrefsFromServer = () => {
    if (!localStorage.getItem('token')) return;
    getUserPreferences().then(prefs => {
      if (prefs['theme-mode']) {
        setMode(prev => prefs['theme-mode'] !== prev ? (prefs['theme-mode'] as ThemeMode) : prev);
      }
      if (prefs['theme-accent']) {
        setAccentColorState(prev => prefs['theme-accent'] !== prev ? (prefs['theme-accent'] as AccentKey) : prev);
      }
      if (prefs['theme-accent-custom']) {
        setCustomAccentHex(prev => prefs['theme-accent-custom'] !== prev ? (prefs['theme-accent-custom'] as string) : prev);
      }
      if (prefs['theme-motion']) {
        const serverReduced = prefs['theme-motion'] === 'reduced';
        setReducedMotionState(prev => serverReduced !== prev ? serverReduced : prev);
      }
    }).catch(() => { /* offline / not logged in — use localStorage values */ });
  };

  // (a) Sync on mount, and (b) re-sync when login dispatches 'app:prefs-sync'
  // so the already-mounted provider re-applies the account's prefs on a fresh
  // device without needing a full page reload.
  useEffect(() => {
    syncPrefsFromServer();
    const onSync = () => syncPrefsFromServer();
    window.addEventListener('app:prefs-sync', onSync);
    return () => window.removeEventListener('app:prefs-sync', onSync);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Apply mode on mount and changes
  useEffect(() => {
    const el = document.documentElement;
    if (mode === 'dark') {
      el.classList.add('dark');
    } else {
      el.classList.remove('dark');
    }
    localStorage.setItem('theme-mode', mode);
    if (localStorage.getItem('token')) saveUserPreferences({ 'theme-mode': mode }).catch(() => {});
  }, [mode]);

  // Apply accent on mount and changes
  useEffect(() => {
    applyAccent(accentColor, customAccentHex);
    localStorage.setItem('theme-accent', accentColor);
    if (localStorage.getItem('token')) saveUserPreferences({ 'theme-accent': accentColor }).catch(() => {});
    if (accentColor === 'custom') {
      localStorage.setItem('theme-accent-custom', customAccentHex);
      if (localStorage.getItem('token')) saveUserPreferences({ 'theme-accent-custom': customAccentHex }).catch(() => {});
    }
  }, [accentColor, customAccentHex]);

  // Apply reduced motion on mount and changes
  useEffect(() => {
    const el = document.documentElement;
    if (reducedMotion) {
      el.classList.add('motion-reduce');
    } else {
      el.classList.remove('motion-reduce');
    }
    localStorage.setItem('theme-motion', reducedMotion ? 'reduced' : 'full');
    if (localStorage.getItem('token')) saveUserPreferences({ 'theme-motion': reducedMotion ? 'reduced' : 'full' }).catch(() => {});
  }, [reducedMotion]);

  const toggleMode = () => setMode(prev => prev === 'light' ? 'dark' : 'light');

  const setAccentColor = (key: AccentKey) => {
    setAccentColorState(key);
  };

  const setCustomAccent = (hex: string) => {
    setCustomAccentHex(hex);
    setAccentColorState('custom');
  };

  const setReducedMotion = (v: boolean) => {
    setReducedMotionState(v);
  };

  return (
    <ThemeContext.Provider value={{ mode, accentColor, customAccentHex, reducedMotion, toggleMode, setAccentColor, setCustomAccent, setReducedMotion }}>
      {children}
    </ThemeContext.Provider>
  );
};
