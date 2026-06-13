import React from 'react';
import { PunchItem } from '../../../utils/store';

interface Props {
  item: PunchItem;
  projectId: string;
  onClose: () => void;
  onSaved: () => void;
}

// Stub — fully implemented in Task 9.
export const PunchItemEditor: React.FC<Props> = ({ item, onClose }) => {
  return (
    <div>
      <p>Punch item editor for {item.description}</p>
      <button onClick={onClose}>Close</button>
    </div>
  );
};
