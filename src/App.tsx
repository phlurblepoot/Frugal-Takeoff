import React, { useEffect, useState } from 'react';
import { createBrowserRouter, RouterProvider, Outlet, useLocation } from 'react-router-dom';
import { ThemeProvider } from './context/ThemeContext';
import { Dashboard } from './pages/Dashboard';
import { ProjectsPage } from './pages/ProjectsPage';
import { NewProject } from './pages/NewProject';
import { ProjectView } from './pages/ProjectView';
import { CanvasView } from './pages/CanvasView';
import { Login } from './pages/Login';
import { Settings } from './pages/Settings';
import { PdfEditor } from './pages/PdfEditor';
import { SpreadsheetEditor } from './pages/SpreadsheetEditor';
import { ChecklistEditor } from './pages/ChecklistEditor';
import { TimeKeeping } from './pages/TimeKeeping';
import { ShareView } from './pages/ShareView';
import { CollaborationProvider } from './context/CollaborationContext';
import { NotesProvider } from './context/NotesContext';
import { UserPresenceOverlay } from './components/UserPresenceOverlay';
import { NotesOverlay } from './components/NotesOverlay';
import { ToastProvider } from './components/Toast';
import { ConfirmProvider } from './components/ConfirmDialog';
import { ShareProvider } from './components/ShareLinkModal';
import { CommandPalette } from './components/CommandPalette';
import { AppShell } from './components/shell/AppShell';
import ProjectConflictListener from './components/ProjectConflictListener';
import { getSettings } from './utils/store';

const Layout: React.FC<{ appName: string; logoUrl: string }> = ({ appName, logoUrl }) => {
  const location = useLocation();
  const isLoginPage = location.pathname === '/login';

  return (
    <ToastProvider>
      <ProjectConflictListener />
      <ConfirmProvider>
        <ShareProvider>
          <CollaborationProvider>
            <NotesProvider>
              {!isLoginPage && <CommandPalette />}
              <AppShell>
                <UserPresenceOverlay />
                <NotesOverlay />
                <Outlet context={{ appName, logoUrl }} />
              </AppShell>
            </NotesProvider>
          </CollaborationProvider>
        </ShareProvider>
      </ConfirmProvider>
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
          element: <ProjectsPage />,
        },
        {
          path: 'dashboard',
          element: <Dashboard />,
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
        {
          path: 'spreadsheet-editor',
          element: <SpreadsheetEditor />,
        },
        {
          path: 'checklist',
          element: <ChecklistEditor />,
        },
        {
          path: 'time',
          element: <TimeKeeping />,
        },
      ],
    },
    {
      path: '/share/:shareId',
      element: <ShareView />,
    },
  ]);

  return <ThemeProvider><RouterProvider router={router} /></ThemeProvider>;
}
