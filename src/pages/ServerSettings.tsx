import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Save, Globe, Image as ImageIcon, Users, Shield, History } from 'lucide-react';
import { getSettings, saveSettings } from '../utils/store';
import { UsersView } from './UsersView';

interface ChangelogEntry {
  version: string;
  date: string;
  changes: string[];
}

const CHANGELOG: ChangelogEntry[] = [
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

const ChangelogView: React.FC = () => (
  <div className="space-y-6">
    {CHANGELOG.map((entry, i) => (
      <div
        key={entry.version}
        className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden"
      >
        <div className="p-6 border-b border-slate-100 dark:border-slate-700 flex items-center gap-3">
          <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-bold bg-accent-100 dark:bg-accent-900/40 text-accent-700 dark:text-accent-300">
            v{entry.version}
          </span>
          <span className="text-sm text-slate-500 dark:text-slate-400">
            {entry.date}
          </span>
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

export const ServerSettings: React.FC = () => {
  const navigate = useNavigate();
  const [settings, setSettings] = useState<Record<string, string>>({
    appName: 'Takeoff Pro',
    logoUrl: '',
    companyName: '',
    companyPhone: '',
    companyEmail: '',
    companyAddress: '',
    publicHost: '',
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<'general' | 'users' | 'changelog'>('general');
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    const checkAdmin = () => {
      const userStr = localStorage.getItem('user');
      if (userStr) {
        const user = JSON.parse(userStr);
        if (user.role === 'admin') {
          setIsAdmin(true);
        } else {
          navigate('/');
        }
      } else {
        navigate('/login');
      }
    };

    const fetchSettings = async () => {
      try {
        const data = await getSettings();
        setSettings(prev => ({ ...prev, ...data }));
      } catch (error) {
        console.error('Failed to fetch settings:', error);
      } finally {
        setIsLoading(false);
      }
    };

    checkAdmin();
    fetchSettings();
  }, [navigate]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await saveSettings(settings);
      if (settings.appName) {
        document.title = settings.appName;
      }
      alert('Settings saved successfully');
    } catch (error) {
      console.error('Failed to save settings:', error);
      alert('Failed to save settings');
    } finally {
      setIsSaving(false);
    }
  };

  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setSettings(prev => ({ ...prev, logoUrl: reader.result as string }));
      };
      reader.readAsDataURL(file);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-900 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-600"></div>
      </div>
    );
  }

  if (!isAdmin) return null;

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900">
      <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center gap-4">
              <button
                onClick={() => navigate('/')}
                className="p-2 text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-all"
              >
                <ArrowLeft size={20} />
              </button>
              <h1 className="text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Shield className="text-accent-600" size={24} />
                Server Settings
              </h1>
            </div>
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="flex items-center gap-2 px-4 py-2 bg-accent-600 text-white rounded-lg font-medium hover:bg-accent-700 transition-all disabled:opacity-50 shadow-sm"
            >
              <Save size={18} />
              {isSaving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex flex-col md:flex-row gap-8">
          {/* Sidebar Tabs */}
          <aside className="w-full md:w-64 shrink-0">
            <nav className="space-y-1">
              <button
                onClick={() => setActiveTab('general')}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all ${
                  activeTab === 'general'
                    ? 'bg-accent-600 text-white shadow-md'
                    : 'text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-800 hover:shadow-sm'
                }`}
              >
                <Globe size={18} />
                General Settings
              </button>
              <button
                onClick={() => setActiveTab('users')}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all ${
                  activeTab === 'users'
                    ? 'bg-accent-600 text-white shadow-md'
                    : 'text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-800 hover:shadow-sm'
                }`}
              >
                <Users size={18} />
                User Management
              </button>
              <button
                onClick={() => setActiveTab('changelog')}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all ${
                  activeTab === 'changelog'
                    ? 'bg-accent-600 text-white shadow-md'
                    : 'text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-800 hover:shadow-sm'
                }`}
              >
                <History size={18} />
                Changelog
              </button>
            </nav>
          </aside>

          {/* Content Area */}
          <div className="flex-1">
            {activeTab === 'general' && (
              <div className="space-y-6">
                <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
                  <div className="p-6 border-b border-slate-100 dark:border-slate-700">
                    <h2 className="text-lg font-bold text-slate-900 dark:text-white">Application Branding</h2>
                    <p className="text-sm text-slate-500 dark:text-slate-400">Customize how the application appears to users.</p>
                  </div>
                  <div className="p-6 space-y-6">
                    <div>
                      <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2 uppercase tracking-wider">
                        Application Name
                      </label>
                      <input
                        type="text"
                        value={settings.appName}
                        onChange={e => setSettings({ ...settings, appName: e.target.value })}
                        className="w-full px-4 py-2.5 rounded-xl border border-slate-300 dark:border-slate-600 dark:bg-slate-800/50 dark:text-white dark:placeholder-slate-500 focus:ring-2 focus:ring-accent-500 outline-none transition-all"
                        placeholder="e.g. My Custom Takeoff"
                      />
                      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400 italic">
                        This will update the name shown in the navigation bar and the browser tab title.
                      </p>
                    </div>

                    <div>
                      <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2 uppercase tracking-wider">
                        Application Logo
                      </label>
                      <div className="flex items-start gap-6">
                        <div className="w-24 h-24 rounded-2xl border-2 border-dashed border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 flex items-center justify-center overflow-hidden shrink-0">
                          {settings.logoUrl ? (
                            <img src={settings.logoUrl} alt="Logo Preview" className="max-w-full max-h-full object-contain" />
                          ) : (
                            <ImageIcon className="text-slate-300 dark:text-slate-600" size={32} />
                          )}
                        </div>
                        <div className="flex-1">
                          <input
                            type="file"
                            accept="image/*"
                            onChange={handleLogoUpload}
                            className="hidden"
                            id="logo-upload"
                          />
                          <label
                            htmlFor="logo-upload"
                            className="inline-flex items-center gap-2 px-4 py-2 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-600 hover:border-slate-300 cursor-pointer transition-all shadow-sm"
                          >
                            <ImageIcon size={16} />
                            Upload New Logo
                          </label>
                          {settings.logoUrl && (
                            <button
                              onClick={() => setSettings({ ...settings, logoUrl: '' })}
                              className="ml-3 text-sm text-red-500 hover:text-red-600 font-medium"
                            >
                              Remove
                            </button>
                          )}
                          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                            Recommended: Square or horizontal logo with transparent background. Max 2MB.
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
                      <div>
                        <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2 uppercase tracking-wider">
                          Company Name
                        </label>
                        <input
                          type="text"
                          value={settings.companyName || ''}
                          onChange={e => setSettings({ ...settings, companyName: e.target.value })}
                          className="w-full px-4 py-2.5 rounded-xl border border-slate-300 dark:border-slate-600 dark:bg-slate-800/50 dark:text-white dark:placeholder-slate-500 focus:ring-2 focus:ring-accent-500 outline-none transition-all"
                          placeholder="e.g. Acme Contracting LLC"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2 uppercase tracking-wider">
                          Phone
                        </label>
                        <input
                          type="tel"
                          value={settings.companyPhone || ''}
                          onChange={e => setSettings({ ...settings, companyPhone: e.target.value })}
                          className="w-full px-4 py-2.5 rounded-xl border border-slate-300 dark:border-slate-600 dark:bg-slate-800/50 dark:text-white dark:placeholder-slate-500 focus:ring-2 focus:ring-accent-500 outline-none transition-all"
                          placeholder="e.g. (555) 123-4567"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2 uppercase tracking-wider">
                          Email
                        </label>
                        <input
                          type="email"
                          value={settings.companyEmail || ''}
                          onChange={e => setSettings({ ...settings, companyEmail: e.target.value })}
                          className="w-full px-4 py-2.5 rounded-xl border border-slate-300 dark:border-slate-600 dark:bg-slate-800/50 dark:text-white dark:placeholder-slate-500 focus:ring-2 focus:ring-accent-500 outline-none transition-all"
                          placeholder="e.g. info@acmecontracting.com"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2 uppercase tracking-wider">
                          Address
                        </label>
                        <input
                          type="text"
                          value={settings.companyAddress || ''}
                          onChange={e => setSettings({ ...settings, companyAddress: e.target.value })}
                          className="w-full px-4 py-2.5 rounded-xl border border-slate-300 dark:border-slate-600 dark:bg-slate-800/50 dark:text-white dark:placeholder-slate-500 focus:ring-2 focus:ring-accent-500 outline-none transition-all"
                          placeholder="e.g. 123 Main St, Springfield, IL"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden">
                  <div className="p-6 border-b border-slate-100 dark:border-slate-700">
                    <h2 className="text-lg font-bold text-slate-900 dark:text-white">Sharing</h2>
                    <p className="text-sm text-slate-500 dark:text-slate-400">Configure the public URL used to generate shareable links.</p>
                  </div>
                  <div className="p-6">
                    <label className="block text-sm font-bold text-slate-700 dark:text-slate-300 mb-2 uppercase tracking-wider">
                      Public Host URL
                    </label>
                    <input
                      type="url"
                      value={settings.publicHost || ''}
                      onChange={e => setSettings({ ...settings, publicHost: e.target.value })}
                      className="w-full px-4 py-2.5 rounded-xl border border-slate-300 dark:border-slate-600 dark:bg-slate-800/50 dark:text-white dark:placeholder-slate-500 focus:ring-2 focus:ring-accent-500 outline-none transition-all"
                      placeholder="https://takeoff.mydomain.com"
                    />
                    <p className="mt-2 text-xs text-slate-500 dark:text-slate-400 italic">
                      The external URL this app is accessible at. Used to generate shareable links for printouts and project pages. Leave blank to use the current browser origin.
                    </p>
                  </div>
                </div>
              </div>
            )}
            {activeTab === 'users' && (
              <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden p-6">
                <UsersView />
              </div>
            )}
            {activeTab === 'changelog' && (
              <ChangelogView />
            )}
          </div>
        </div>
      </main>
    </div>
  );
};
