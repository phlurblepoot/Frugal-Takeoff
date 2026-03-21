import React from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { ProjectsList } from './pages/ProjectsList';
import { NewProject } from './pages/NewProject';
import { ProjectView } from './pages/ProjectView';
import { CanvasView } from './pages/CanvasView';
import { Login } from './pages/Login';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<ProjectsList />} />
        <Route path="/new" element={<NewProject />} />
        <Route path="/project/:projectId" element={<ProjectView />} />
        <Route path="/project/:projectId/page/:pageId" element={<CanvasView />} />
      </Routes>
    </BrowserRouter>
  );
}
