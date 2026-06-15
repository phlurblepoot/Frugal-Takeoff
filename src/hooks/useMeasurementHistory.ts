import { useState } from 'react';
import { Measurement, ProjectPage } from '../types';

export type HistoryAction =
  | { type: 'add'; measurement: Measurement }
  | { type: 'delete'; measurement: Measurement }
  | { type: 'update'; measurementId: string; before: Partial<Measurement>; after: Partial<Measurement> };

interface UseMeasurementHistoryArgs {
  page: ProjectPage | null;
  selectedMeasurementId: string | null;
  setSelectedMeasurementId: (id: string | null) => void;
  savePageUpdates: (updates: Partial<ProjectPage>) => Promise<void> | void;
  toast: (message: string, options?: { type?: 'info' | 'success' | 'warning' | 'error'; duration?: number }) => void;
}

export function useMeasurementHistory({
  page,
  selectedMeasurementId,
  setSelectedMeasurementId,
  savePageUpdates,
  toast,
}: UseMeasurementHistoryArgs) {
  const [history, setHistory] = useState<HistoryAction[]>([]);
  const [redoStack, setRedoStack] = useState<HistoryAction[]>([]);

  const pushToHistory = (action: HistoryAction) => {
    setHistory(prev => [...prev, action].slice(-50));
    setRedoStack([]);
  };

  const applyAction = (action: HistoryAction, direction: 'undo' | 'redo') => {
    if (!page) return;
    if (action.type === 'add') {
      if (direction === 'undo') {
        savePageUpdates({ measurements: page.measurements.filter(m => m.id !== action.measurement.id) });
        if (selectedMeasurementId === action.measurement.id) setSelectedMeasurementId(null);
      } else {
        savePageUpdates({ measurements: [...page.measurements, action.measurement] });
      }
    } else if (action.type === 'delete') {
      if (direction === 'undo') {
        savePageUpdates({ measurements: [...page.measurements, action.measurement] });
      } else {
        savePageUpdates({ measurements: page.measurements.filter(m => m.id !== action.measurement.id) });
      }
    } else if (action.type === 'update') {
      const patch = direction === 'undo' ? action.before : action.after;
      savePageUpdates({ measurements: page.measurements.map(m => m.id === action.measurementId ? { ...m, ...patch } : m) });
    }
  };

  const undo = () => {
    if (history.length === 0 || !page) return;
    const lastAction = history[history.length - 1];
    setHistory(prev => prev.slice(0, -1));
    setRedoStack(prev => [...prev, lastAction]);
    applyAction(lastAction, 'undo');
    toast('Undone', { type: 'info', duration: 1500 });
  };

  const redo = () => {
    if (redoStack.length === 0 || !page) return;
    const action = redoStack[redoStack.length - 1];
    setRedoStack(prev => prev.slice(0, -1));
    setHistory(prev => [...prev, action]);
    applyAction(action, 'redo');
    toast('Redone', { type: 'info', duration: 1500 });
  };

  const reset = () => {
    setHistory([]);
  };

  return { history, redoStack, pushToHistory, undo, redo, reset };
}
