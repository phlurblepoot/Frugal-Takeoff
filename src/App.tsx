import React from 'react';
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import { ProjectsList } from './pages/ProjectsList';
import { NewProject } from './pages/NewProject';
import { ProjectView } from './pages/ProjectView';
import { CanvasView } from './pages/CanvasView';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<ProjectsList />} />
        <Route path="/new" element={<NewProject />} />
        <Route path="/project/:projectId" element={<ProjectView />} />
        <Route path="/project/:projectId/page/:pageId" element={<CanvasView />} />
      </Routes>
    </BrowserRouter>
  );
}
