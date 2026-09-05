// src/cards/index.ts — aggregation entry point. Anything outside src/cards
// imports from here, never from the individual files directly: this is where
// later tasks (6-11) append side-effect imports of each card module so those
// modules' top-level registerCards(...) calls run exactly once, after
// registry.tsx has already initialized CARD_REGISTRY (see registry.tsx's
// header comment for why those imports can never live in registry.tsx itself).
export * from './types';
export * from './registry';
export { CardShell } from './CardShell';
export { useCardLayout } from './useCardLayout';
export { CardGrid } from './CardGrid';
