import React, { useEffect, useState } from 'react';
import { createBrowserRouter, RouterProvider, Outlet, useLocation, Navigate } from 'react-router-dom';
import { ThemeProvider } from './context/ThemeContext';
import { Dashboard } from './pages/Dashboard';
import { ProjectsPage } from './pages/ProjectsPage';
import { NewProject } from './pages/NewProject';
import { ProjectView } from './pages/ProjectView';
import { CanvasView } from './pages/CanvasView';
import { ProjectLayout } from './pages/project/ProjectLayout';
import { ProjectOverview } from './pages/project/ProjectOverview';
import { ProjectDocuments } from './pages/project/ProjectDocuments';
import { ProjectNotes } from './pages/project/ProjectNotes';
import { ProjectTime } from './pages/project/ProjectTime';
import { ProjectBilling } from './pages/project/ProjectBilling';
import { ProjectIssues } from './pages/project/ProjectIssues';
import { ProjectPunch } from './pages/project/ProjectPunch';
import { ProjectProposal } from './pages/project/ProjectProposal';
import { ProjectSettings } from './pages/project/ProjectSettings';
import { Login } from './pages/Login';
import { Settings } from './pages/Settings';
import { PdfEditor } from './pages/PdfEditor';
import { SpreadsheetEditor } from './pages/SpreadsheetEditor';
import { TasksPage } from './pages/TasksPage';
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
          element: <Navigate to="/dashboard" replace />,
        },
        {
          path: 'dashboard',
          element: <Dashboard />,
        },
        {
          path: 'projects',
          element: <ProjectsPage />,
        },
        {
          path: 'new',
          element: <NewProject />,
        },
        {
          path: 'project/:projectId',
          element: <ProjectLayout />,
          children: [
            { index: true, element: <ProjectOverview /> },
            { path: 'takeoff', element: <ProjectView /> },
            { path: 'proposal', element: <ProjectProposal /> },
            { path: 'documents', element: <ProjectDocuments /> },
            { path: 'notes', element: <ProjectNotes /> },
            { path: 'time', element: <ProjectTime /> },
            { path: 'punch', element: <ProjectPunch /> },
            { path: 'issues', element: <ProjectIssues /> },
            { path: 'billing', element: <ProjectBilling /> },
            { path: 'settings', element: <ProjectSettings /> },
            { path: 'page/:pageId', element: <CanvasView /> },
          ],
        },
        {
          path: 'settings',
          element: <Settings />,
        },
        {
          path: 'tools/pdf',
          element: <PdfEditor />,
        },
        {
          path: 'tools/sheets',
          element: <SpreadsheetEditor />,
        },
        {
          path: 'pdf-editor',
          element: <Navigate to="/tools/pdf" replace />,
        },
        {
          path: 'spreadsheet-editor',
          element: <Navigate to="/tools/sheets" replace />,
        },
        {
          path: 'tasks',
          element: <TasksPage />,
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
