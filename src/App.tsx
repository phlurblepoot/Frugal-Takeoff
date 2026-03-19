import React from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { ProjectsList } from './pages/ProjectsList';
import { NewProject } from './pages/NewProject';
import { ProjectView } from './pages/ProjectView';
import { CanvasView } from './pages/CanvasView';
import { Login } from './pages/Login';

const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const token = localStorage.getItem('token');
  const location = useLocation();

  if (!token) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
};

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<ProtectedRoute><ProjectsList /></ProtectedRoute>} />
        <Route path="/new" element={<ProtectedRoute><NewProject /></ProtectedRoute>} />
        <Route path="/project/:projectId" element={<ProtectedRoute><ProjectView /></ProtectedRoute>} />
        <Route path="/project/:projectId/page/:pageId" element={<ProtectedRoute><CanvasView /></ProtectedRoute>} />
      </Routes>
    </BrowserRouter>
  );
}
