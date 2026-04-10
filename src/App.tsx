import React, { useEffect, useState } from 'react';
import { createBrowserRouter, RouterProvider, Outlet, useLocation } from 'react-router-dom';
import { ThemeProvider } from './context/ThemeContext';
import { ProjectsList } from './pages/ProjectsList';
import { NewProject } from './pages/NewProject';
import { ProjectView } from './pages/ProjectView';
import { CanvasView } from './pages/CanvasView';
import { Login } from './pages/Login';
import { Settings } from './pages/Settings';
import { PdfEditor } from './pages/PdfEditor';
import { CollaborationProvider } from './context/CollaborationContext';
import { NotesProvider } from './context/NotesContext';
import { UserPresenceOverlay } from './components/UserPresenceOverlay';
import { NotesOverlay } from './components/NotesOverlay';
import { ToastProvider } from './components/Toast';
import { SideDock, DockState } from './components/SideDock';
import { getSettings } from './utils/store';

const DOCK_STORAGE_KEY = 'sideDockState';

const Layout: React.FC<{ appName: string; logoUrl: string }> = ({ appName, logoUrl }) => {
  const location = useLocation();
  const isLoginPage = location.pathname === '/login';

  const [dockState, setDockState] = useState<DockState>(() => {
    const saved = localStorage.getItem(DOCK_STORAGE_KEY) as DockState | null;
    return saved && ['expanded', 'collapsed', 'hidden'].includes(saved) ? saved : 'collapsed';
  });

  const handleDockChange = (s: DockState) => {
    setDockState(s);
    localStorage.setItem(DOCK_STORAGE_KEY, s);
  };

  const marginLeft = isLoginPage
    ? 0
    : dockState === 'hidden'
    ? 0
    : dockState === 'collapsed'
    ? 64
    : 208;

  return (
    <ToastProvider>
      <CollaborationProvider>
        <NotesProvider>
          <SideDock state={dockState} onChange={handleDockChange} />
          <div
            style={{ marginLeft, transition: 'margin-left 200ms' }}
          >
            <UserPresenceOverlay />
            <NotesOverlay />
            <Outlet context={{ appName, logoUrl }} />
          </div>
        </NotesProvider>
      </CollaborationProvider>
    </ToastProvider>
  );
};

export default function App() {
  const [appName, setAppName] = useState('Takeoff Pro');
  const [logoUrl, setLogoUrl] = useState('');

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const settings = await getSettings();
        if (settings.appName) {
          setAppName(settings.appName);
          document.title = settings.appName;
        }
        if (settings.logoUrl) {
          setLogoUrl(settings.logoUrl);
        }
      } catch (error) {
        console.error('Failed to fetch settings:', error);
      }
    };
    fetchSettings();
  }, []);

  const router = createBrowserRouter([
    {
      path: '/',
      element: <Layout appName={appName} logoUrl={logoUrl} />,
      children: [
        {
          path: 'login',
          element: <Login />,
        },
        {
          index: true,
          element: <ProjectsList appName={appName} logoUrl={logoUrl} />,
        },
        {
          path: 'new',
          element: <NewProject />,
        },
        {
          path: 'project/:projectId',
          element: <ProjectView />,
        },
        {
          path: 'project/:projectId/page/:pageId',
          element: <CanvasView />,
        },
        {
          path: 'settings',
          element: <Settings />,
        },
        {
          path: 'pdf-editor',
          element: <PdfEditor />,
        },
      ],
    },
  ]);

  return <ThemeProvider><RouterProvider router={router} /></ThemeProvider>;
}
