// src/components/shell/AppShell.tsx
import React, { useEffect, useState } from 'react';
import { useLocation, matchPath } from 'react-router-dom';
import { Sidebar, SidebarState } from './Sidebar';

// Keep the legacy storage key so existing users keep their saved preference.
const SIDEBAR_STORAGE_KEY = 'sideDockState';

export const AppShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const location = useLocation();
  const isLoginPage = location.pathname === '/login';
  const isCanvasPage = !!matchPath('/project/:projectId/page/:pageId', location.pathname);

  const [sidebarState, setSidebarState] = useState<SidebarState>(() => {
    const saved = localStorage.getItem(SIDEBAR_STORAGE_KEY) as SidebarState | null;
    return saved && ['expanded', 'collapsed', 'hidden'].includes(saved) ? saved : 'expanded';
  });

  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const handleChange = (s: SidebarState) => {
    setSidebarState(s);
    localStorage.setItem(SIDEBAR_STORAGE_KEY, s);
  };

  // Canvas is full-bleed (spec §4.3): thin rail on desktop, no sidebar on
  // mobile. The stored preference is left untouched.
  const effectiveState: SidebarState = isCanvasPage ? 'collapsed' : sidebarState;
  const showSidebar = !isLoginPage && !(isMobile && isCanvasPage);

  const marginLeft =
    !showSidebar || effectiveState === 'hidden' ? 0 : effectiveState === 'collapsed' ? 64 : 208;

  return (
    <>
      {showSidebar && <Sidebar state={effectiveState} onChange={handleChange} locked={isCanvasPage} />}
      <div className="min-h-screen bg-surface" style={{ marginLeft, transition: 'margin-left 200ms' }}>
        {children}
      </div>
    </>
  );
};
