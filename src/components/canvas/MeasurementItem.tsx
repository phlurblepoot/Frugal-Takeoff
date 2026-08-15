import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Edit2, Trash2 } from 'lucide-react';
import { Measurement, ScaleConfig, MeasurementTakeoff } from '../../types';
import { calculatePolylineLength, calculatePolygonArea, formatMeasurement, calculateSurfaceAreaPx, expandArcPoints, measurementAreaPx } from '../../utils/math';

export function MeasurementItem({
  measurement,
  scaleConfig,
  takeoffType,
  takeoff,
  onDelete,
  selected,
  onSelect,
  onRename,
  onEditHeights,
  pageName,
  pageId,
  projectId,
  planSetName,
  pageIds,
  testId
}: {
  measurement: Measurement;
  scaleConfig: ScaleConfig | null;
  takeoffType?: string;
  takeoff?: MeasurementTakeoff;
  onDelete: () => void;
  selected: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  onEditHeights?: () => void;
  pageName?: string;
  pageId?: string;
  projectId?: string;
  planSetName?: string;
  pageIds?: string[];
  testId?: string;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(measurement.name);
  const rowRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (selected && rowRef.current) {
      rowRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selected]);

  const handleSaveName = () => {
    if (editName.trim()) {
      onRename(editName.trim());
    } else {
      setEditName(measurement.name);
    }
    setIsEditing(false);
  };

  return (
    <div
      ref={rowRef}
      data-testid={testId}
      data-measurement-id={measurement.id}
      className={`p-3 relative group flex flex-col gap-2 transition-colors cursor-grab active:cursor-grabbing border-l-4 ${selected ? 'bg-accent-100 dark:bg-accent-900/40 border-accent-500 ring-2 ring-accent-400 ring-inset shadow-sm' : 'hover:bg-slate-50 dark:hover:bg-slate-700/50 border-transparent'}`}
      onClick={onSelect}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', measurement.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
    >
      {selected && (
        <span className="absolute top-1.5 right-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-amber-400 text-amber-950 text-[9px] font-bold uppercase tracking-wider shadow-sm">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-700 animate-pulse" />
          Active
        </span>
      )}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {!measurement.takeoffId && (
            <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: measurement.color }} />
          )}
          <div className="flex flex-col flex-1 min-w-0">
            {isEditing ? (
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={handleSaveName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveName();
                  if (e.key === 'Escape') {
                    setEditName(measurement.name);
                    setIsEditing(false);
                  }
                }}
                className="text-sm border border-accent-300 rounded px-1 py-0.5 w-full focus:outline-none focus:ring-1 focus:ring-accent-500"
                autoFocus
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span
                className="text-sm text-slate-700 dark:text-slate-300 break-words whitespace-normal hover:text-accent-600 dark:hover:text-accent-400"
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setIsEditing(true);
                }}
                title="Double-click to rename"
              >
                {measurement.name}
              </span>
            )}
            {pageName && pageId && projectId && (
              <Link
                to={`/project/${projectId}/page/${pageId}`}
                state={{ pageIds }}
                className="text-[10px] text-accent-500 hover:text-accent-700 hover:underline font-medium uppercase tracking-wide truncate"
                onClick={(e) => e.stopPropagation()}
              >
                Page: {pageName}
              </Link>
            )}
            {pageName && (!pageId || !projectId) && (
              <span className="text-[10px] text-slate-400 font-medium uppercase tracking-wide truncate">
                Page: {pageName}
              </span>
            )}
            {planSetName && (
              <span className="text-[10px] text-purple-500 font-medium uppercase tracking-wide truncate">
                Set: {planSetName}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0 ml-2">
          <span data-testid="measurement-value" className="text-sm font-semibold text-slate-900 dark:text-slate-100 whitespace-pre-line text-right">
            {measurement.type === 'count'
              ? formatMeasurement(1, 'count', scaleConfig, takeoff)
              : (() => {
                  const allPts = [
                    expandArcPoints(measurement.points, measurement.arcMidIndices),
                    ...(measurement.segments ?? []).map(s => expandArcPoints(s.points, s.arcMidIndices)),
                  ];
                  return measurement.type === 'length'
                    ? (takeoffType === 'area'
                        ? formatMeasurement(
                            allPts.reduce((sum, pts) => sum + calculateSurfaceAreaPx(pts, measurement.heights || [], measurement.isTwoSided || false, scaleConfig), 0),
                            'area', scaleConfig, takeoff)
                        : formatMeasurement(
                            allPts.reduce((sum, pts) => sum + calculatePolylineLength(pts), 0),
                            'length', scaleConfig, takeoff))
                    : formatMeasurement(measurementAreaPx(measurement), 'area', scaleConfig, takeoff);
                })()
            }
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setIsEditing(true);
              }}
              className="md:hidden p-2 text-slate-400 hover:text-accent-500 active:scale-95 transition-all"
              title="Rename Measurement"
            >
              <Edit2 size={18} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="p-2 text-slate-400 hover:text-red-500 can-hover:md:opacity-0 can-hover:md:group-hover:opacity-100 active:scale-95 transition-all"
              title="Delete Measurement"
            >
              <Trash2 size={18} />
            </button>
          </div>
        </div>
      </div>

      {measurement.type === 'area' && (measurement.segments ?? []).some(s => s.subtract) && (
        <div className="flex flex-col gap-0.5 pl-1">
          {(measurement.segments ?? [])
            .filter(s => s.subtract)
            .map((s, i) => (
              <div key={i} className="flex items-center justify-between text-xs text-slate-400 dark:text-slate-500">
                <span>Cutout {i + 1}</span>
                <span className="font-medium">
                  −{formatMeasurement(calculatePolygonArea(expandArcPoints(s.points, s.arcMidIndices)), 'area', scaleConfig, takeoff)}
                </span>
              </div>
            ))}
        </div>
      )}

      {selected && !isEditing && (
        <div className="flex items-center gap-2 mt-1" onClick={(e) => e.stopPropagation()}>
          <span className="text-xs text-slate-500 italic">Drag to move to another takeoff</span>
          <div className="ml-auto flex items-center gap-3">
            {takeoffType === 'area' && measurement.type === 'length' && (
              <button
                data-testid="btn-edit-heights"
                onClick={(e) => { e.stopPropagation(); onEditHeights?.(); }}
                className="text-xs text-accent-600 hover:text-accent-800 flex items-center gap-1"
              >
                <Edit2 size={10} /> Edit Heights
              </button>
            )}
            <button
              onClick={() => setIsEditing(true)}
              className="text-xs text-accent-600 hover:text-accent-800 flex items-center gap-1"
            >
              <Edit2 size={10} /> Rename
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
