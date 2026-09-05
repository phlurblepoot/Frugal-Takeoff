// src/cards/useMasonrySpan.ts
//
// Converts a card's rendered content height into a `grid-row: span N` value
// for the dense-packed masonry grid (see CardGrid.tsx). Observes the INNER
// content div passed via the returned ref — not the outer grid-item wrapper
// — because sizing the wrapper by its own span would create a feedback loop
// (wrapper height depends on span, span would depend on wrapper height).
import { useEffect, useRef, useState } from 'react';

// Must match CardGrid's gridAutoRows (8px). The visual gap between cards is
// baked into each wrapper's paddingBottom (12px) rather than the grid's
// row-gap, since fine-grained auto-rows can't mix with a row-gap without
// inflating every span — see CardGrid.tsx.
export const MASONRY_ROW_PX = 8;
export const MASONRY_GAP_PX = 12;

export function spanForHeight(height: number): number {
  return Math.max(1, Math.ceil((height + MASONRY_GAP_PX) / MASONRY_ROW_PX));
}

export function useMasonrySpan<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [span, setSpan] = useState(1);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSpan(spanForHeight(el.offsetHeight));
    measure();
    // jsdom (test env) has no ResizeObserver — the initial measure() above
    // still sets a plausible span, we just skip live re-measurement.
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  });

  return { ref, span };
}
