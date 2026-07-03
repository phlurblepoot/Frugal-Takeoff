// Real AiRunner backed by node-llama-cpp on CUDA. Loads lazily on first use and
// serializes calls through the single-flight queue. Any load/inference failure
// degrades to "unavailable" rather than throwing at import time.
//
// node-llama-cpp is an OPTIONAL native dependency: it is imported via a
// non-literal specifier so the server compiles/starts fine without it (the
// factory only constructs this runner when the model files exist). The exact
// multimodal calls (getLlama / loadModel / mmproj / image input) MUST be
// confirmed against the installed node-llama-cpp version — see the plan's
// "Task 6 Step 1" — and adjusted inside `ensureLoaded()` if needed. Everything
// outside this file is insulated by the AiRunner interface.
import type { AiRunner, AiInfo, SheetRead, SheetMatch, ExistingSheetRef } from './types';
import { createSingleFlightQueue } from './queue';
import { buildReadPrompt, parseReadResponse, buildMatchPrompt, parseMatchResponse } from './prompt';

export interface RunnerConfig {
  modelPath: string;      // absolute path to the GGUF model
  mmprojPath: string;     // absolute path to the vision projector GGUF
  gpuLayers: number;      // -1 / large = all on GPU
  timeoutMs: number;
  modelLabel: string;     // shown in /status
}

interface LlamaEngine {
  complete(prompt: string, image?: Buffer): Promise<string>;
}

export function createLlamaRunner(cfg: RunnerConfig): AiRunner {
  const queue = createSingleFlightQueue({ timeoutMs: cfg.timeoutMs });
  let device: AiInfo['device'] = 'cpu';
  let loadPromise: Promise<LlamaEngine> | null = null;
  let loadFailed = false;

  async function ensureLoaded(): Promise<LlamaEngine> {
    if (loadFailed) throw new Error('ai model failed to load');
    if (!loadPromise) {
      loadPromise = (async (): Promise<LlamaEngine> => {
        // Non-literal specifier keeps TypeScript/Vite from resolving the optional
        // native dep at build time; it only needs to exist at runtime on the host.
        const specifier = 'node-llama-cpp';
        const mod: any = await import(specifier);
        const llama = await mod.getLlama();
        device = llama?.gpu ? 'cuda' : 'cpu';
        const model = await llama.loadModel({ modelPath: cfg.modelPath, gpuLayers: cfg.gpuLayers });
        // Vision projector + image-input wiring is version-specific — confirm the
        // API and pass `cfg.mmprojPath` accordingly. Shape of `complete`:
        //   complete(prompt, image?) => Promise<string>
        const ctx = await model.createContext();
        return {
          async complete(prompt: string, image?: Buffer): Promise<string> {
            const sequence = ctx.getSequence();
            const session = new mod.LlamaChatSession({ contextSequence: sequence });
            const opts: any = { maxTokens: 256, temperature: 0 };
            if (image) opts.images = [image]; // adjust per confirmed API
            try {
              return await session.prompt(prompt, opts);
            } finally {
              // Best-effort cleanup so long import batches don't exhaust the
              // context's sequence pool / leak KV-cache. Method names are
              // version-specific; guard with optional chaining.
              try { session?.dispose?.(); } catch { /* ignore */ }
              try { sequence?.dispose?.(); } catch { /* ignore */ }
            }
          },
        };
      })().catch((err: unknown) => { loadFailed = true; throw err; });
    }
    return loadPromise;
  }

  return {
    async available(): Promise<boolean> {
      try { await ensureLoaded(); return true; } catch { return false; }
    },
    info(): AiInfo { return { model: cfg.modelLabel, device }; },
    async readSheet({ image, embeddedText }: { image: Buffer; embeddedText?: string }): Promise<SheetRead> {
      const engine = await ensureLoaded();
      const raw = await queue.enqueue(() => engine.complete(buildReadPrompt(embeddedText), image));
      return parseReadResponse(raw);
    },
    async matchSheet({ page, existing }: { page: SheetRead; existing: ExistingSheetRef[] }): Promise<SheetMatch> {
      const engine = await ensureLoaded();
      const raw = await queue.enqueue(() => engine.complete(buildMatchPrompt(page, existing)));
      return parseMatchResponse(raw, existing.map(e => e.sheetId));
    },
  };
}
