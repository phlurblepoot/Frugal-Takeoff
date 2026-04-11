import React, { useState, useEffect } from 'react';
import { Globe, Image as ImageIcon, Users, History, User, Palette, Sun, Moon, Check, Zap, ZapOff, Save } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { getSettings, saveSettings } from '../utils/store';
import { UsersView } from './UsersView';
import { useTheme, AccentKey } from '../context/ThemeContext';

// ── Changelog data ────────────────────────────────────────────────────────────

interface ChangelogEntry {
  version: string;
  date: string;
  changes: string[];
}

const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.9.1',
    date: 'April 11, 2026',
    changes: [
      'PDF Editor: multi-file tabs — opening a second PDF creates a new tab above the toolbar; switching tabs preserves each file\'s annotation and undo history independently',
      'PDF Editor: page thumbnail sidebar with per-page thumbnails; clicking scrolls to the page in scroll mode or switches to it in single-page mode; toggleable via toolbar button',
      'PDF Editor: zoom controls — zoom in/out buttons, preset levels (50%–200%), Fit Width, Fit Height, Fit Page; Ctrl+wheel and Ctrl+=/- keyboard shortcuts',
      'PDF Editor: single-page view mode toggle with Previous/Next navigation bar',
    ],
  },
  {
    version: '0.9.0',
    date: 'April 11, 2026',
    changes: [
      'PDF Editor sub-application: open local PDFs, annotate with freehand pen, lines, arrows, rectangles, ellipses, text, and images, then export back to PDF',
      'Signature tool: save reusable signatures from image files with automatic white-background removal, place and resize on any page',
      'Full undo/redo history and keyboard shortcuts in the PDF Editor',
      'Side dock navigation: collapsible/hideable left sidebar with per-app navigation, persistent across sessions',
      'Merged Settings page: user preferences and server settings combined under one route with admin-only tab gating',
      'Advanced costing: Unit label field added to Material Yield and Rate per Units cost types in all takeoff editors',
      'Fixed username display in the active users overlay — eliminated intermittent "User" placeholder caused by async state race',
      'Version changelog added to Settings',
    ],
  },
  {
    version: '0.8.0',
    date: 'April 7–8, 2026',
    changes: [
      'Proposal PDF enhancements: header color picker, custom fonts, cover page notes, valid-until date, terms & conditions page, signature block, and page numbers',
      'Highlight print quality selector with preset options for proposal and standalone printing',
      'Server-side user preference sync for cross-browser persistence',
      'Collaboration user list improvements: numbered duplicate instances and readable page location names',
    ],
  },
  {
    version: '0.7.0',
    date: 'April 5–6, 2026',
    changes: [
      'Price package field on takeoffs with automatic grouping in sidebar',
      'Custom autocomplete dropdown for price package selection',
      'Shared NewTakeoffModal component extracted for reuse',
      'Proposal PDF takeoff list grouped by price package',
      'Append highlighted blueprint pages to proposal PDF using pdf-lib merge',
    ],
  },
  {
    version: '0.6.0',
    date: 'April 4, 2026',
    changes: [
      'Proposal PDF generator with branded cover page and takeoff summary',
      'Accent color system replacing all hardcoded blues throughout the app',
    ],
  },
  {
    version: '0.5.0',
    date: 'April 3, 2026',
    changes: [
      'Glass UI design with dark mode support',
      'Accent color picker in user settings',
      'Dark mode applied across all pages and components',
      'Toast notifications for user feedback',
      'Undo/redo support for measurements',
      'Keyboard shortcuts for common actions',
    ],
  },
  {
    version: '0.4.0',
    date: 'April 2, 2026',
    changes: [
      'Security hardening: rate limiting, input validation, and query optimization',
      'Fixed authentication header handling across all views',
      'Performance improvements for large project lists',
    ],
  },
  {
    version: '0.3.0',
    date: 'March 29–31, 2026',
    changes: [
      'Project notes with rich text support',
      'Server settings page for application branding and contractor info',
      'Search with persistence and term highlighting',
      'Global user presence and real-time collaboration controls',
    ],
  },
  {
    version: '0.2.0',
    date: 'March 24–28, 2026',
    changes: [
      'Legend display and customization on canvas pages',
      'Copy/paste functionality for measurements',
      'Ability to resume incomplete measurements',
    ],
  },
  {
    version: '0.1.0',
    date: 'March 11–21, 2026',
    changes: [
      'Initial project structure with React, TypeScript, and Tailwind CSS',
      'Express.js backend with SQLite database',
      'JWT authentication and user management',
      'PDF blueprint upload, rendering, and page navigation',
      'Canvas-based measurement tools (linear, area, count)',
      'Takeoff cost management and bid tracking',
      'Real-time collaboration via Socket.IO',
      'Thumbnail generation and plan set versioning',
      'Docker deployment configuration',
    ],
  },
];

// ── User Preferences tab ─────────────────────────────────────────────────────

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

const PreferencesTab: React.FC = () => {
  const { mode, accentColor, reducedMotion, toggleMode, setAccentColor, setReducedMotion } = useTheme();

  return (
    <div className="space-y-6">
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
        <div className="p-6 border-b border-slate-100 dark:border-slate-700">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">Appearance</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">Control how the application looks and feels.</p>
        </div>
        <div className="p-6 space-y-6">
          {/* Dark Mode */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-accent-100 dark:bg-accent-900/40 flex items-center justify-center text-accent-600 dark:text-accent-400 shrink-0">
                <AnimatePresence mode="wait" initial={false}>
                  {mode === 'dark' ? (
                    <motion.div key="moon"
                      initial={{ opacity: 0, rotate: -30, scale: 0.7 }} animate={{ opacity: 1, rotate: 0, scale: 1 }}
                      exit={{ opacity: 0, rotate: 30, scale: 0.7 }} transition={{ duration: 0.18 }}>
                      <Moon size={18} />
                    </motion.div>
                  ) : (
                    <motion.div key="sun"
                      initial={{ opacity: 0, rotate: 30, scale: 0.7 }} animate={{ opacity: 1, rotate: 0, scale: 1 }}
                      exit={{ opacity: 0, rotate: -30, scale: 0.7 }} transition={{ duration: 0.18 }}>
                      <Sun size={18} />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">Dark Mode</p>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Switch between light and dark interface</p>
              </div>
            </div>
            <button
              role="switch" aria-checked={mode === 'dark'} onClick={toggleMode}
              className={`relative shrink-0 w-12 h-6 rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:ring-offset-2 dark:focus:ring-offset-slate-900 ${mode === 'dark' ? 'bg-accent-600' : 'bg-slate-200 dark:bg-slate-700'}`}
            >
              <motion.div layout transition={{ type: 'spring', stiffness: 700, damping: 35 }}
                className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow-sm ${mode === 'dark' ? 'left-6' : 'left-0.5'}`} />
            </button>
          </div>

          {/* Reduce Motion */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-accent-100 dark:bg-accent-900/40 flex items-center justify-center text-accent-600 dark:text-accent-400 shrink-0">
                {reducedMotion ? <ZapOff size={16} /> : <Zap size={16} />}
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">Reduce Motion</p>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Minimize animations for accessibility or performance</p>
              </div>
            </div>
            <button
              role="switch" aria-checked={reducedMotion} onClick={() => setReducedMotion(!reducedMotion)}
              className={`relative shrink-0 w-12 h-6 rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:ring-offset-2 dark:focus:ring-offset-slate-900 ${reducedMotion ? 'bg-accent-600' : 'bg-slate-200 dark:bg-slate-700'}`}
            >
              <motion.div layout transition={{ type: 'spring', stiffness: 700, damping: 35 }}
                className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow-sm ${reducedMotion ? 'left-6' : 'left-0.5'}`} />
            </button>
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
        <div className="p-6 border-b border-slate-100 dark:border-slate-700">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white">Accent Colour</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">Applied to buttons, active states, and interactive elements.</p>
        </div>
        <div className="p-6">
          <div className="flex items-center gap-3 flex-wrap">
            {ACCENT_PRESETS.map(preset => (
              <button
                key={preset.key}
                onClick={() => setAccentColor(preset.key)}
                title={preset.label}
                aria-label={preset.label}
                aria-pressed={accentColor === preset.key}
                className="relative w-9 h-9 rounded-full transition-transform hover:scale-110 active:scale-95 focus:outline-none focus:ring-2 focus:ring-offset-2 dark:focus:ring-offset-slate-800"
                style={{ background: accentSwatchColor(preset.hue) } as React.CSSProperties}
              >
                <AnimatePresence>
                  {accentColor === preset.key && (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.5 }} animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.5 }} transition={{ duration: 0.15 }}
                      className="absolute inset-0 flex items-center justify-center rounded-full ring-2 ring-white ring-offset-2"
                    >
                      <Check size={14} className="text-white drop-shadow" strokeWidth={3} />
                    </motion.div>
                  )}
                </AnimatePresence>
              </button>
            ))}
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-4 capitalize">
            Current: <span className="font-medium text-slate-700 dark:text-slate-300">{accentColor}</span>
          </p>
        </div>
      </div>
    </div>
  );
};

// ── Changelog tab ─────────────────────────────────────────────────────────────

const ChangelogTab: React.FC = () => (
  <div className="space-y-6">
    {CHANGELOG.map((entry, i) => (
      <div key={entry.version} className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
        <div className="p-6 border-b border-slate-100 dark:border-slate-700 flex items-center gap-3">
          <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-bold bg-accent-100 dark:bg-accent-900/40 text-accent-700 dark:text-accent-300">
            v{entry.version}
          </span>
          <span className="text-sm text-slate-500 dark:text-slate-400">{entry.date}</span>
          {i === 0 && (
            <span className="ml-auto inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300">
              Latest
            </span>
          )}
        </div>
        <div className="p-6">
          <ul className="space-y-2">
            {entry.changes.map((change, j) => (
              <li key={j} className="flex items-start gap-3 text-sm text-slate-700 dark:text-slate-300">
                <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-accent-500 shrink-0" />
                {change}
              </li>
            ))}
          </ul>
        </div>
      </div>
    ))}
  </div>
);

// ── Main component ────────────────────────────────────────────────────────────

type TabId = 'preferences' | 'general' | 'users' | 'changelog';

export const Settings: React.FC = () => {
  const [serverSettings, setServerSettings] = useState<Record<string, string>>({
    appName: 'Takeoff Pro',
    logoUrl: '',
    companyName: '',
    companyPhone: '',
    companyEmail: '',
    companyAddress: '',
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>('preferences');
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    try {
      const userStr = localStorage.getItem('user');
      if (userStr) {
        const user = JSON.parse(userStr);
        setIsAdmin(user.role === 'admin');
      }
    } catch { /* ignore */ }

    const fetchSettings = async () => {
      try {
        const data = await getSettings();
        setServerSettings(prev => ({ ...prev, ...data }));
      } catch (error) {
        console.error('Failed to fetch settings:', error);
      } finally {
        setIsLoading(false);
      }
    };
    fetchSettings();
  }, []);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await saveSettings(serverSettings);
      if (serverSettings.appName) document.title = serverSettings.appName;
      alert('Settings saved successfully');
    } catch {
      alert('Failed to save settings');
    } finally {
      setIsSaving(false);
    }
  };

  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => setServerSettings(prev => ({ ...prev, logoUrl: reader.result as string }));
      reader.readAsDataURL(file);
    }
  };

  // Admin-only tabs not shown to regular users
  const allTabs: { id: TabId; label: string; icon: React.ReactNode; adminOnly?: boolean }[] = [
    { id: 'preferences', label: 'User Preferences', icon: <User size={18} /> },
    { id: 'general',     label: 'General Settings', icon: <Globe size={18} />,   adminOnly: true },
    { id: 'users',       label: 'User Management',  icon: <Users size={18} />,   adminOnly: true },
    { id: 'changelog',   label: 'Changelog',         icon: <History size={18} /> },
  ];
  const tabs = allTabs.filter(t => !t.adminOnly || isAdmin);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-900 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-600" />
      </div>
    );
  }

  const inputCls = 'w-full px-4 py-2.5 rounded-xl border border-slate-300 dark:border-slate-600 dark:bg-slate-800/50 dark:text-white dark:placeholder-slate-500 focus:ring-2 focus:ring-accent-500 outline-none transition-all';
  const labelCls = 'block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2 uppercase tracking-wider';

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900">
      <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <h1 className="text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
              <Palette className="text-accent-600" size={24} />
              Settings
            </h1>
            {activeTab === 'general' && isAdmin && (
              <button
                onClick={handleSave}
                disabled={isSaving}
                className="flex items-center gap-2 px-4 py-2 bg-accent-600 text-white rounded-lg font-medium hover:bg-accent-700 transition-all disabled:opacity-50 shadow-sm"
              >
                <Save size={18} />
                {isSaving ? 'Saving…' : 'Save Changes'}
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex flex-col md:flex-row gap-8">
          {/* Sidebar */}
          <aside className="w-full md:w-64 shrink-0">
            <nav className="space-y-1">
              {tabs.map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all ${
                    activeTab === tab.id
                      ? 'bg-accent-600 text-white shadow-md'
                      : 'text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-800 hover:shadow-sm'
                  }`}
                >
                  {tab.icon}
                  {tab.label}
                </button>
              ))}
            </nav>
          </aside>

          {/* Content */}
          <div className="flex-1">
            {activeTab === 'preferences' && <PreferencesTab />}

            {activeTab === 'general' && isAdmin && (
              <div className="space-y-6">
                <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
                  <div className="p-6 border-b border-slate-100 dark:border-slate-700">
                    <h2 className="text-lg font-bold text-slate-900 dark:text-white">Application Branding</h2>
                    <p className="text-sm text-slate-500 dark:text-slate-400">Customize how the application appears to users.</p>
                  </div>
                  <div className="p-6 space-y-6">
                    <div>
                      <label className={labelCls}>Application Name</label>
                      <input type="text" value={serverSettings.appName}
                        onChange={e => setServerSettings({ ...serverSettings, appName: e.target.value })}
                        className={inputCls} placeholder="e.g. My Custom Takeoff" />
                      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400 italic">
                        Updates the name shown in the navigation bar and browser tab title.
                      </p>
                    </div>
                    <div>
                      <label className={labelCls}>Application Logo</label>
                      <div className="flex items-start gap-6">
                        <div className="w-24 h-24 rounded-2xl border-2 border-dashed border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 flex items-center justify-center overflow-hidden shrink-0">
                          {serverSettings.logoUrl
                            ? <img src={serverSettings.logoUrl} alt="Logo Preview" className="max-w-full max-h-full object-contain" />
                            : <ImageIcon className="text-slate-300 dark:text-slate-600" size={32} />}
                        </div>
                        <div className="flex-1">
                          <input type="file" accept="image/*" onChange={handleLogoUpload} className="hidden" id="logo-upload" />
                          <label htmlFor="logo-upload"
                            className="inline-flex items-center gap-2 px-4 py-2 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-600 cursor-pointer transition-all shadow-sm">
                            <ImageIcon size={16} /> Upload New Logo
                          </label>
                          {serverSettings.logoUrl && (
                            <button onClick={() => setServerSettings({ ...serverSettings, logoUrl: '' })}
                              className="ml-3 text-sm text-red-500 hover:text-red-600 font-medium">
                              Remove
                            </button>
                          )}
                          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                            Recommended: Square or horizontal logo, transparent background. Max 2MB.
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
                  <div className="p-6 border-b border-slate-100 dark:border-slate-700">
                    <h2 className="text-lg font-bold text-slate-900 dark:text-white">Contractor Information</h2>
                    <p className="text-sm text-slate-500 dark:text-slate-400">Shown on proposal PDFs generated from projects.</p>
                  </div>
                  <div className="p-6">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                      {[
                        { key: 'companyName',    label: 'Company Name', type: 'text',  placeholder: 'e.g. Acme Contracting LLC' },
                        { key: 'companyPhone',   label: 'Phone',        type: 'tel',   placeholder: 'e.g. (555) 123-4567' },
                        { key: 'companyEmail',   label: 'Email',        type: 'email', placeholder: 'e.g. info@acme.com' },
                        { key: 'companyAddress', label: 'Address',      type: 'text',  placeholder: 'e.g. 123 Main St, Springfield, IL' },
                      ].map(field => (
                        <div key={field.key}>
                          <label className={labelCls}>{field.label}</label>
                          <input
                            type={field.type}
                            value={serverSettings[field.key] || ''}
                            onChange={e => setServerSettings({ ...serverSettings, [field.key]: e.target.value })}
                            className={inputCls}
                            placeholder={field.placeholder}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'users' && isAdmin && (
              <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden p-6">
                <UsersView />
              </div>
            )}

            {activeTab === 'changelog' && <ChangelogTab />}
          </div>
        </div>
      </main>
    </div>
  );
};
