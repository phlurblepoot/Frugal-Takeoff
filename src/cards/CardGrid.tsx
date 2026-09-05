// src/cards/CardGrid.tsx
//
// Responsive grid host for one page's cards. Renders the user's resolved
// CardLayout at 1-4 columns (driven by window width) and owns "Customize"
// mode: drag-to-reorder, per-card width control, remove, and an add tray for
// cards currently off the layout. Cards render their own CardShell chrome —
// this component only positions them on the grid.
import React, { useEffect, useRef, useState } from 'react';
import type { CardContext, CardLayoutEntry, CardPage, CardWidth } from './types';
import { cardsForPage } from './registry';
import { useCardLayout } from './useCardLayout';

function computeCols(w1600: boolean, w1024: boolean, w640: boolean): number {
  if (w1600) return 4;
  if (w1024) return 3;
  if (w640) return 2;
  return 1;
}

// Three independent min-width queries (mirrors AppShell's single-breakpoint
// matchMedia pattern, tripled) so a crossing at any one threshold re-renders
// without polling resize events.
function useColumnCount(): number {
  const queries = () => ({
    q1600: window.matchMedia('(min-width: 1600px)'),
    q1024: window.matchMedia('(min-width: 1024px)'),
    q640: window.matchMedia('(min-width: 640px)'),
  });

  const [cols, setCols] = useState(() => {
    const { q1600, q1024, q640 } = queries();
    return computeCols(q1600.matches, q1024.matches, q640.matches);
  });

  useEffect(() => {
    const { q1600, q1024, q640 } = queries();
    const update = () => setCols(computeCols(q1600.matches, q1024.matches, q640.matches));
    update();
    q1600.addEventListener('change', update);
    q1024.addEventListener('change', update);
    q640.addEventListener('change', update);
    return () => {
      q1600.removeEventListener('change', update);
      q1024.removeEventListener('change', update);
      q640.removeEventListener('change', update);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return cols;
}

export const CardGrid: React.FC<{ page: CardPage; ctx: CardContext }> = ({ page, ctx }) => {
  const { layout, setLayout, reset } = useCardLayout(page, ctx);
  const cols = useColumnCount();
  const [editing, setEditing] = useState(false);
  // Native HTML5 drag: the dragged card's id lives in a ref (not
  // dataTransfer) so drop handling doesn't depend on jsdom/browser
  // dataTransfer support.
  const dragId = useRef<string | null>(null);

  const available = cardsForPage(page, ctx);
  const byId = new Map(available.map(def => [def.id, def]));
  const inLayout = new Set(layout.cards.map(c => c.id));
  const trayDefs = available.filter(def => !inLayout.has(def.id));

  const updateEntry = (id: string, patch: Partial<CardLayoutEntry>) => {
    setLayout({ ...layout, cards: layout.cards.map(c => (c.id === id ? { ...c, ...patch } : c)) });
  };

  const removeCard = (id: string) => {
    setLayout({ ...layout, cards: layout.cards.filter(c => c.id !== id) });
  };

  const addCard = (id: string, defaultWidth: CardWidth) => {
    setLayout({ ...layout, cards: [...layout.cards, { id, width: defaultWidth }] });
  };

  // Native drag events bubble regardless of a wrapper's own `draggable`
  // attribute — an in-card text-selection drag can still fire dragstart on
  // an ancestor. Gate the handlers themselves (not just `draggable`) so
  // dragging is completely inert outside Customize mode: no drop target, no
  // reorder, no persisted write.
  const handleDragStart = (id: string) => () => {
    if (!editing) return;
    dragId.current = id;
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!editing) return;
    e.preventDefault();
  };

  const handleDrop = (targetId: string) => (e: React.DragEvent<HTMLDivElement>) => {
    if (!editing) return;
    e.preventDefault();
    const draggedId = dragId.current;
    dragId.current = null;
    if (!draggedId || draggedId === targetId) return;

    const cards = [...layout.cards];
    const fromIndex = cards.findIndex(c => c.id === draggedId);
    if (fromIndex === -1) return;
    const [moved] = cards.splice(fromIndex, 1);
    const toIndex = cards.findIndex(c => c.id === targetId);
    // Reorder-before-target: the dragged card lands just ahead of whatever
    // it was dropped on.
    if (toIndex === -1) cards.push(moved);
    else cards.splice(toIndex, 0, moved);

    setLayout({ ...layout, cards });
  };

  return (
    <div>
      <div className="flex items-center justify-end gap-3 mb-3">
        {editing && (
          <button
            type="button"
            data-testid="cards-reset"
            className="text-xs font-medium text-ink-soft hover:text-ink"
            onClick={reset}
          >
            Reset to default
          </button>
        )}
        <button
          type="button"
          data-testid="cards-customize"
          className="text-xs font-medium text-ink-soft hover:text-ink"
          onClick={() => setEditing(e => !e)}
        >
          {editing ? '✓ Done' : '⚙ Customize'}
        </button>
      </div>

      <div
        data-testid="card-grid"
        className="grid gap-3"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {layout.cards.map(entry => {
          const def = byId.get(entry.id);
          if (!def) return null;
          const effectiveWidth = Math.min(entry.width, cols) as CardWidth;
          const widths = [...def.widths].sort((a, b) => a - b);

          return (
            <div
              key={entry.id}
              data-card-id={entry.id}
              draggable={editing}
              onDragStart={handleDragStart(entry.id)}
              onDragOver={handleDragOver}
              onDrop={handleDrop(entry.id)}
              className={
                'relative' +
                (editing ? ' animate-[card-wiggle_.4s_ease-in-out_infinite_alternate]' : '')
              }
              style={{ gridColumn: `span ${effectiveWidth}` }}
            >
              {editing && (
                <div className="absolute top-1.5 right-1.5 z-10 flex items-center gap-1">
                  <div role="group" aria-label={`${def.title} width`} className="flex gap-0.5">
                    {widths.map(w => (
                      <button
                        key={w}
                        type="button"
                        className={
                          'flex size-5 items-center justify-center rounded text-[10px] font-medium ' +
                          (w === entry.width ? 'glow-accent' : 'bg-raised text-ink-soft hover:text-ink')
                        }
                        onClick={() => updateEntry(entry.id, { width: w })}
                      >
                        {w}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    aria-label={`Remove ${def.title}`}
                    className="flex size-5 items-center justify-center rounded bg-raised text-ink-soft hover:text-ink"
                    onClick={() => removeCard(entry.id)}
                  >
                    ×
                  </button>
                </div>
              )}
              <def.Component width={effectiveWidth} ctx={ctx} />
            </div>
          );
        })}

        {layout.cards.length === 0 && (
          <div className="col-span-full flex items-center justify-center rounded-xl border border-dashed border-edge py-10 text-sm text-ink-faint">
            No cards yet — use Customize to add some.
          </div>
        )}
      </div>

      {editing && (
        <div data-testid="cards-tray" className="mt-3 flex flex-wrap gap-2">
          {trayDefs.map(def => (
            <button
              key={def.id}
              type="button"
              className="rounded-full border border-edge px-3 py-1 text-xs font-medium text-ink-soft hover:text-ink"
              onClick={() => addCard(def.id, def.defaultWidth)}
            >
              + {def.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
