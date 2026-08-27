// src/pages/project/daily/DailyReportEditor.tsx
//
// Placeholder for Task 5 — keeps ProjectDailyReports.tsx compiling and
// reviewable on its own. Task 5 replaces this with the real editor
// (weather, man counts, field notes, photos, send).
import React from 'react';
import { DailyReport } from '../../../utils/store';
import { Modal } from '../../../components/ui';
import { formatReportDate } from '../ProjectDailyReports';

export const DailyReportEditor: React.FC<{
  report: DailyReport;
  projectId: string;
  projectName: string;
  contractor?: string | null;
  onClose: () => void;
  onSaved: () => void;
}> = ({ report, onClose }) => (
  <Modal open onClose={onClose} title={`Daily Report — ${formatReportDate(report.reportDate)}`}>
    <p className="text-sm text-ink-soft">Editor coming soon.</p>
  </Modal>
);
