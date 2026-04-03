import React, { useEffect, useState } from 'react';
import { createBrowserRouter, RouterProvider, Outlet } from 'react-router-dom';
import { ProjectsList } from './pages/ProjectsList';
import { NewProject } from './pages/NewProject';
import { ProjectView } from './pages/ProjectView';
import { CanvasView } from './pages/CanvasView';
import { Login } from './pages/Login';
import { ServerSettings } from './pages/ServerSettings';
import { CollaborationProvider, useCollaboration } from './context/CollaborationContext';
import { NotesProvider } from './context/NotesContext';
import { UserPresenceOverlay } from './components/UserPresenceOverlay';
import { NotesOverlay } from './components/NotesOverlay';
import { ToastProvider } from './components/Toast';
import { getSettings } from './utils/store';

const Layout: React.FC<{ appName: string; logoUrl: string }> = ({ appName, logoUrl }) => {
  return (
    <ToastProvider>
      <CollaborationProvider>
        <NotesProvider>
          <UserPresenceOverlay />
          <NotesOverlay />
          <Outlet context={{ appName, logoUrl }} />
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
          element: <ServerSettings />,
        },
      ],
    },
  ]);

  return <RouterProvider router={router} />;
}
