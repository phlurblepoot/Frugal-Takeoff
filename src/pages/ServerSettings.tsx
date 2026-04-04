import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Save, Globe, Image as ImageIcon, Users, Shield } from 'lucide-react';
import { getSettings, saveSettings } from '../utils/store';
import { UsersView } from './UsersView';

export const ServerSettings: React.FC = () => {
  const navigate = useNavigate();
  const [settings, setSettings] = useState<Record<string, string>>({
    appName: 'Takeoff Pro',
    logoUrl: '',
    companyName: '',
    companyPhone: '',
    companyEmail: '',
    companyAddress: '',
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<'general' | 'users'>('general');
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
            </nav>
          </aside>

          {/* Content Area */}
          <div className="flex-1">
            {activeTab === 'general' ? (
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
              </div>
            ) : (
              <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm overflow-hidden p-6">
                <UsersView />
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
};
