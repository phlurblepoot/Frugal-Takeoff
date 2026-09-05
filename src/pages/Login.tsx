import React, { useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { Lock, User, Loader2, FolderOpen } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useTheme } from '../context/ThemeContext';
import { useSoftZoom } from '../hooks/useSoftZoom';

export const Login: React.FC = () => {
  const { appName } = useOutletContext<{ appName: string; logoUrl: string }>();
  const { reducedMotion } = useTheme();
  const softZoomRef = useSoftZoom<HTMLDivElement>();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Login failed');
      }

      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      // Tell the already-mounted ThemeProvider to re-pull this account's
      // theme/accent/motion prefs so they apply immediately on a fresh device
      // (it can't re-run its on-mount sync without a full reload otherwise).
      window.dispatchEvent(new Event('app:prefs-sync'));
      navigate('/dashboard');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen overflow-y-auto flex items-center justify-center p-4">
      <motion.div
        ref={softZoomRef}
        initial={reducedMotion ? false : { opacity: 0, y: 28, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 300, damping: 24 }}
        className="glass-panel soft-zoom rounded-2xl border border-edge shadow-2xl w-full max-w-md"
      >
        <div className="p-8">
          {/* Branding */}
          <div className="text-center mb-8">
            <div className="w-14 h-14 bg-accent-600 rounded-2xl mx-auto mb-4 flex items-center justify-center shadow-lg shadow-accent-600/25">
              <FolderOpen size={28} className="text-white" />
            </div>
            <h1 className="text-3xl font-bold text-ink">{appName}</h1>
            <p className="text-ink-soft mt-2">Sign in to your account</p>
          </div>

          {/* Error message */}
          <AnimatePresence>
            {error && (
              <motion.div
                initial={{ opacity: 0, height: 0, marginBottom: 0 }}
                animate={{ opacity: 1, height: 'auto', marginBottom: '1.5rem' }}
                exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                transition={{ duration: 0.2 }}
                className="bg-red-50 dark:bg-red-950/50 text-red-600 dark:text-red-400 px-4 py-3 rounded-xl text-sm font-medium border border-red-100 dark:border-red-900 overflow-hidden"
              >
                {error}
              </motion.div>
            )}
          </AnimatePresence>

          <form onSubmit={handleLogin} className="space-y-5">
            <div>
              <label className="block text-sm font-medium text-ink-soft mb-2">
                Username
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-ink-faint">
                  <User size={18} />
                </div>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 rounded-xl border border-edge
                             bg-raised/70 text-ink
                             placeholder-ink-faint
                             focus:ring-2 focus:ring-accent-500 focus:border-accent-500 outline-none transition-all"
                  placeholder="Enter your username"
                  required
                  autoComplete="username"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-ink-soft mb-2">
                Password
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-ink-faint">
                  <Lock size={18} />
                </div>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 rounded-xl border border-edge
                             bg-raised/70 text-ink
                             placeholder-ink-faint
                             focus:ring-2 focus:ring-accent-500 focus:border-accent-500 outline-none transition-all"
                  placeholder="Enter your password"
                  required
                  autoComplete="current-password"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={isLoading || !username || !password}
              className="w-full flex items-center justify-center gap-2 bg-accent-600 hover:bg-accent-700
                         text-white py-3 rounded-xl font-medium transition-all
                         shadow-lg shadow-accent-600/25 hover:shadow-accent-600/40
                         disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none
                         active:scale-[0.98]"
            >
              {isLoading ? <Loader2 size={18} className="animate-spin" /> : 'Sign In'}
            </button>
          </form>
        </div>
      </motion.div>
    </div>
  );
};
