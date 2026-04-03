import React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Sun, Moon, Check, Zap, ZapOff } from 'lucide-react';
import { useTheme, AccentKey } from '../context/ThemeContext';

const ACCENT_PRESETS: { key: AccentKey; label: string; hue: number }[] = [
  { key: 'blue',    label: 'Blue',    hue: 264 },
  { key: 'indigo',  label: 'Indigo',  hue: 283 },
  { key: 'violet',  label: 'Violet',  hue: 303 },
  { key: 'emerald', label: 'Emerald', hue: 162 },
  { key: 'rose',    label: 'Rose',    hue: 15  },
  { key: 'amber',   label: 'Amber',   hue: 84  },
];

function accentSwatchColor(hue: number) {
  return `oklch(0.52 0.24 ${hue})`;
}

interface ToggleRowProps {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  icon?: React.ReactNode;
}

const ToggleRow: React.FC<ToggleRowProps> = ({ label, description, checked, onChange, icon }) => (
  <div className="flex items-center justify-between gap-4">
    <div className="flex items-center gap-3 min-w-0">
      {icon && (
        <div className="w-9 h-9 rounded-xl bg-accent-100 dark:bg-accent-900/40 flex items-center justify-center text-accent-600 dark:text-accent-400 flex-shrink-0">
          {icon}
        </div>
      )}
      <div className="min-w-0">
        <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{label}</p>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{description}</p>
      </div>
    </div>
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative flex-shrink-0 w-12 h-6 rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:ring-offset-2 dark:focus:ring-offset-slate-900 ${
        checked ? 'bg-accent-600' : 'bg-slate-200 dark:bg-slate-700'
      }`}
    >
      <motion.div
        layout
        transition={{ type: 'spring', stiffness: 700, damping: 35 }}
        className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow-sm flex items-center justify-center ${
          checked ? 'left-6' : 'left-0.5'
        }`}
      />
    </button>
  </div>
);

export const UserSettingsPanel: React.FC = () => {
  const { mode, accentColor, reducedMotion, toggleMode, setAccentColor, setReducedMotion } = useTheme();

  return (
    <div className="glass-card p-6 sm:p-8 max-w-2xl space-y-8">

      {/* Section: Appearance */}
      <div>
        <h3 className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-4">
          Appearance
        </h3>
        <div className="space-y-4">
          {/* Dark Mode Toggle */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-accent-100 dark:bg-accent-900/40 flex items-center justify-center text-accent-600 dark:text-accent-400 flex-shrink-0">
                <AnimatePresence mode="wait" initial={false}>
                  {mode === 'dark' ? (
                    <motion.div key="moon"
                      initial={{ opacity: 0, rotate: -30, scale: 0.7 }}
                      animate={{ opacity: 1, rotate: 0, scale: 1 }}
                      exit={{ opacity: 0, rotate: 30, scale: 0.7 }}
                      transition={{ duration: 0.18 }}
                    >
                      <Moon size={18} />
                    </motion.div>
                  ) : (
                    <motion.div key="sun"
                      initial={{ opacity: 0, rotate: 30, scale: 0.7 }}
                      animate={{ opacity: 1, rotate: 0, scale: 1 }}
                      exit={{ opacity: 0, rotate: -30, scale: 0.7 }}
                      transition={{ duration: 0.18 }}
                    >
                      <Sun size={18} />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">Dark Mode</p>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Switch between light and dark interface
                </p>
              </div>
            </div>
            <button
              role="switch"
              aria-checked={mode === 'dark'}
              onClick={toggleMode}
              className={`relative flex-shrink-0 w-12 h-6 rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:ring-offset-2 dark:focus:ring-offset-slate-900 ${
                mode === 'dark' ? 'bg-accent-600' : 'bg-slate-200 dark:bg-slate-700'
              }`}
            >
              <motion.div
                layout
                transition={{ type: 'spring', stiffness: 700, damping: 35 }}
                className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow-sm ${
                  mode === 'dark' ? 'left-6' : 'left-0.5'
                }`}
              />
            </button>
          </div>
        </div>
      </div>

      <div className="border-t border-slate-200 dark:border-slate-700/60" />

      {/* Section: Accent Colour */}
      <div>
        <h3 className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1">
          Accent Colour
        </h3>
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
          Applied to buttons, active states, and interactive elements
        </p>
        <div className="flex items-center gap-3 flex-wrap">
          {ACCENT_PRESETS.map(preset => (
            <button
              key={preset.key}
              onClick={() => setAccentColor(preset.key)}
              title={preset.label}
              className="relative w-9 h-9 rounded-full transition-transform hover:scale-110 active:scale-95 focus:outline-none focus:ring-2 focus:ring-offset-2 dark:focus:ring-offset-slate-900"
              style={{ background: accentSwatchColor(preset.hue), focusRingColor: accentSwatchColor(preset.hue) } as React.CSSProperties}
              aria-label={preset.label}
              aria-pressed={accentColor === preset.key}
            >
              <AnimatePresence>
                {accentColor === preset.key && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.5 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.5 }}
                    transition={{ duration: 0.15 }}
                    className="absolute inset-0 flex items-center justify-center rounded-full ring-2 ring-white ring-offset-2 ring-offset-transparent"
                    style={{ ringOffsetColor: accentSwatchColor(preset.hue) } as React.CSSProperties}
                  >
                    <Check size={14} className="text-white drop-shadow" strokeWidth={3} />
                  </motion.div>
                )}
              </AnimatePresence>
            </button>
          ))}
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-3 capitalize">
          Current: <span className="font-medium text-slate-700 dark:text-slate-300">{accentColor}</span>
        </p>
      </div>

      <div className="border-t border-slate-200 dark:border-slate-700/60" />

      {/* Section: Animations */}
      <div>
        <h3 className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-4">
          Animations
        </h3>
        <ToggleRow
          label="Reduce Motion"
          description="Minimize animations for better accessibility or performance"
          checked={reducedMotion}
          onChange={setReducedMotion}
          icon={reducedMotion ? <ZapOff size={16} /> : <Zap size={16} />}
        />
      </div>
    </div>
  );
};
