import path from 'node:path';
import { existsSync } from 'node:fs';
import type { AiRunner } from './types';
import { createDisabledRunner } from './disabledRunner';
import { createLlamaRunner } from './runner';

let singleton: AiRunner | null = null;

/** Build (once) the AiRunner from env. Falls back to the disabled runner when
 *  AI is turned off or the configured model files are absent. */
export function getAiRunner(env: NodeJS.ProcessEnv = process.env): AiRunner {
  if (singleton) return singleton;
  if (env.AI_ENABLED === 'false' || env.AI_ENABLED === '0') {
    singleton = createDisabledRunner('disabled by AI_ENABLED');
    return singleton;
  }
  const modelsDir = env.AI_MODELS_DIR || '/models';
  const modelPath = env.AI_MODEL_PATH || path.join(modelsDir, env.AI_MODEL_FILE || 'qwen2.5-vl-3b-instruct-q4_k_m.gguf');
  const mmprojPath = env.AI_MMPROJ_PATH || path.join(modelsDir, env.AI_MMPROJ_FILE || 'qwen2.5-vl-3b-instruct-mmproj-f16.gguf');
  if (!existsSync(modelPath) || !existsSync(mmprojPath)) {
    singleton = createDisabledRunner('model files not found');
    return singleton;
  }
  singleton = createLlamaRunner({
    modelPath,
    mmprojPath,
    gpuLayers: Number(env.AI_GPU_LAYERS ?? -1),
    timeoutMs: Number(env.AI_TIMEOUT_MS ?? 30000),
    modelLabel: env.AI_MODEL_FILE || 'qwen2.5-vl-3b-instruct',
  });
  return singleton;
}
