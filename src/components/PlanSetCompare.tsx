import React, { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { GitCompare, X, Columns, Layers as LayersIcon, Contrast } from 'lucide-react';
import { Project, ProjectPage } from '../types';
import { getImageUrl } from '../utils/store';
import { computeRevisionModel, sheetKey } from '../utils/planSets';

interface Props {
  project: Project;
  pageId: string;
  onClose: () => void;
}

type Mode = 'side' | 'overlay' | 'difference';

const setLabel = (project: Project, page: ProjectPage) => {
  const ps = project.planSets?.find(s => s.id === page.planSetId);
  if (!ps) return 'Unversioned';
  return `${ps.name}${ps.date ? ` · ${ps.date}` : ''}`;
};

// Visual comparison of two revisions of the same sheet. Uses the stored page
// raster (thumbnail/full image) so it works for both legacy and vector pages.
export const PlanSetCompare: React.FC<Props> = ({ project, pageId, onClose }) => {
  const revs = useMemo(() => {
    const model = computeRevisionModel(project, '');
    const page = project.pages.find(p => p.id === pageId);
    const key = page ? sheetKey(page) : null;
    return key ? (model.revisionsBySheet.get(key) || []) : [];
  }, [project, pageId]);

  // Default: newest two revisions (older on the left, newer on the right).
  const [leftId, setLeftId] = useState(() => (revs.length >= 2 ? revs[revs.length - 2].id : revs[0]?.id) || '');
  const [rightId, setRightId] = useState(() => revs[revs.length - 1]?.id || '');
  const [mode, setMode] = useState<Mode>('side');
  const [slider, setSlider] = useState(50);

  const left = revs.find(p => p.id === leftId);
  const right = revs.find(p => p.id === rightId);
  const src = (p?: ProjectPage) => (p ? getImageUrl(p.thumbnailId || p.imageId) : '');

  const sheetNo = (right || left)?.pageNumber || 'sheet';

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose} role="dialog" aria-modal="true" aria-label="Compare revisions">
      <motion.div
        initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.16 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-5xl bg-white dark:bg-slate-800 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 overflow-hidden flex flex-col max-h-[90vh]"
      >
        <div className="p-4 border-b border-slate-100 dark:border-slate-700 flex flex-wrap items-center gap-3 justify-between shrink-0">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <GitCompare size={18} className="text-accent-600" /> Compare {sheetNo}
          </h2>
          <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-900/50 rounded-lg p-1">
            {([['side', 'Side by side', Columns], ['overlay', 'Overlay', LayersIcon], ['difference', 'Difference', Contrast]] as const).map(([m, label, Icon]) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-2.5 py-1.5 rounded-md text-xs font-medium flex items-center gap-1.5 transition-all ${mode === m ? 'bg-white dark:bg-slate-700 text-accent-600 shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}`}
              >
                <Icon size={14} /> {label}
              </button>
            ))}
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700">
            <X size={18} />
          </button>
        </div>

        <div className="p-4 grid grid-cols-2 gap-3 shrink-0">
          <div>
            <label className="text-[10px] uppercase tracking-wider font-bold text-slate-400">Left (older)</label>
            <select value={leftId} onChange={(e) => setLeftId(e.target.value)} className="w-full mt-1 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 dark:bg-slate-900/50 dark:text-white text-sm outline-none">
              {revs.map(p => <option key={p.id} value={p.id}>{setLabel(project, p)}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider font-bold text-slate-400">Right (newer)</label>
            <select value={rightId} onChange={(e) => setRightId(e.target.value)} className="w-full mt-1 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 dark:bg-slate-900/50 dark:text-white text-sm outline-none">
              {revs.map(p => <option key={p.id} value={p.id}>{setLabel(project, p)}</option>)}
            </select>
          </div>
        </div>

        <div className="flex-1 overflow-auto bg-slate-50 dark:bg-slate-900 p-4">
          {mode === 'side' && (
            <div className="grid grid-cols-2 gap-4 h-full">
              {[left, right].map((p, i) => (
                <div key={i} className="flex flex-col">
                  <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1 text-center truncate">{p ? setLabel(project, p) : '—'}</div>
                  <div className="flex-1 flex items-center justify-center bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
                    {p ? <img src={src(p)} alt="" className="max-w-full max-h-[55vh] object-contain" referrerPolicy="no-referrer" /> : null}
                  </div>
                </div>
              ))}
            </div>
          )}

          {mode === 'overlay' && (
            <div className="relative mx-auto bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden" style={{ maxWidth: 900 }}>
              <img src={src(left)} alt="" className="block w-full max-h-[60vh] object-contain" referrerPolicy="no-referrer" />
              <img src={src(right)} alt="" className="absolute inset-0 w-full h-full object-contain" style={{ clipPath: `inset(0 ${100 - slider}% 0 0)` }} referrerPolicy="no-referrer" />
              <div className="absolute top-0 bottom-0 w-0.5 bg-accent-500" style={{ left: `${slider}%` }} />
            </div>
          )}

          {mode === 'difference' && (
            <div className="relative mx-auto bg-white rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden" style={{ maxWidth: 900 }}>
              <img src={src(left)} alt="" className="block w-full max-h-[60vh] object-contain" referrerPolicy="no-referrer" />
              <img src={src(right)} alt="" className="absolute inset-0 w-full h-full object-contain" style={{ mixBlendMode: 'difference' }} referrerPolicy="no-referrer" />
            </div>
          )}
        </div>

        {mode === 'overlay' && (
          <div className="px-6 py-3 border-t border-slate-100 dark:border-slate-700 flex items-center gap-3 shrink-0">
            <span className="text-xs text-slate-400 whitespace-nowrap">Wipe</span>
            <input type="range" min={0} max={100} value={slider} onChange={(e) => setSlider(Number(e.target.value))} className="flex-1 accent-accent-600" aria-label="Wipe between revisions" />
          </div>
        )}
        {mode === 'difference' && (
          <div className="px-6 py-3 border-t border-slate-100 dark:border-slate-700 text-xs text-slate-400 shrink-0">
            Areas that match appear black; anything that changed between the two revisions shows up bright.
          </div>
        )}
      </motion.div>
    </div>
  );
};
