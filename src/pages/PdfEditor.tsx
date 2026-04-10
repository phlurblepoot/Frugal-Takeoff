import React from 'react';
import { FileEdit } from 'lucide-react';

export const PdfEditor: React.FC = () => {
  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 flex items-center justify-center">
      <div className="text-center">
        <div className="w-20 h-20 bg-accent-100 dark:bg-accent-900/30 rounded-2xl flex items-center justify-center mx-auto mb-6">
          <FileEdit size={40} className="text-accent-600 dark:text-accent-400" />
        </div>
        <h1 className="text-3xl font-bold text-slate-900 dark:text-white mb-3">PDF Editor</h1>
        <p className="text-slate-500 dark:text-slate-400 text-lg">Coming Soon</p>
        <p className="text-slate-400 dark:text-slate-500 text-sm mt-2">
          A powerful PDF markup and annotation tool is on the way.
        </p>
      </div>
    </div>
  );
};
