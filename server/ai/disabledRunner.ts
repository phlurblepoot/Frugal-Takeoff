import type { AiRunner } from './types';

/** A runner used when AI is disabled or the model failed to load. */
export function createDisabledRunner(reason = 'disabled'): AiRunner {
  const unavailable = () => Promise.reject(new Error('ai runner unavailable'));
  return {
    available: () => Promise.resolve(false),
    info: () => ({ model: reason, device: 'none' }),
    readSheet: unavailable,
    matchSheet: unavailable,
  };
}
