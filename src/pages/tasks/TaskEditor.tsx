// src/pages/tasks/TaskEditor.tsx
import React from 'react';
import { Task, AssignableUser } from '../../utils/store';

interface Props { task: Task; users: AssignableUser[]; onClose: () => void; onSaved: () => void; }

export const TaskEditor: React.FC<Props> = ({ task, onClose }) => (
  <div><p>Task editor for {task.title}</p><button onClick={onClose}>Close</button></div>
);
