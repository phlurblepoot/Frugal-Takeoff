// AiRunner backed by a bundled llama.cpp `llama-server` subprocess (CUDA).
//
// node-llama-cpp has no public vision API, so multimodal inference goes through
// llama.cpp's own server: we spawn it once (lazily) pointing at a vision model +
// its mmproj (auto-downloaded via `-hf` on first run), wait for `/health`, then
// call the OpenAI-compatible `/v1/chat/completions` endpoint on localhost. The
// whole thing sits behind the AiRunner interface, so nothing else changes.
import { spawn, ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { AiRunner, AiInfo, SheetRead, SheetMatch, ExistingSheetRef } from './types';
import { createSingleFlightQueue } from './queue';
import { buildReadPrompt, parseReadResponse, buildMatchPrompt, parseMatchResponse } from './prompt';

export interface RunnerConfig {
  serverBin: string;       // path to the llama-server binary
  modelArgs: string[];     // ['-hf','repo:quant'] OR ['--model',p,'--mmproj',m]
  host: string;            // bind host, e.g. 127.0.0.1
  port: number;
  gpuLayers: number;       // -ngl (999 = offload all)
  cacheDir: string;        // LLAMA_CACHE — where -hf downloads land (a volume)
  timeoutMs: number;       // per-inference timeout
  startupTimeoutMs: number;// max wait for the server to become healthy (first run downloads weights)
  modelLabel: string;
}

/** Build the llama-server CLI args (pure; unit-tested). */
export function buildServerArgs(cfg: RunnerConfig): string[] {
  return [
    ...cfg.modelArgs,
    '--host', cfg.host,
    '--port', String(cfg.port),
    '-ngl', String(cfg.gpuLayers),
    '--no-webui',
  ];
}

/** Pull the assistant text out of an OpenAI-compatible chat completion (pure). */
export function extractContent(json: any): string {
  const c = json?.choices?.[0]?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p: any) => (typeof p === 'string' ? p : p?.text ?? '')).join(' ');
  return '';
}

export function createLlamaServerRunner(cfg: RunnerConfig): AiRunner {
  const queue = createSingleFlightQueue({ timeoutMs: cfg.timeoutMs });
  const base = `http://${cfg.host}:${cfg.port}`;
  const device: AiInfo['device'] = 'cuda';
  let proc: ChildProcess | null = null;
  let spawnFailed = false;

  function ensureStarted(): void {
    if (proc || spawnFailed) return;
    if (!existsSync(cfg.serverBin)) { spawnFailed = true; return; }
    try {
      // Inherit stdio so llama-server's model-download progress bar + load logs
      // stream straight to the container log (docker logs / Unraid log viewer).
      proc = spawn(cfg.serverBin, buildServerArgs(cfg), {
        env: { ...process.env, LLAMA_CACHE: cfg.cacheDir },
        stdio: 'inherit',
      });
      proc.on('exit', () => { proc = null; });
      proc.on('error', () => { spawnFailed = true; proc = null; });
    } catch {
      spawnFailed = true;
    }
  }

  async function health(timeoutMs = 1500): Promise<boolean> {
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function waitReady(): Promise<void> {
    ensureStarted();
    if (spawnFailed) throw new Error('llama-server unavailable');
    const deadline = Date.now() + cfg.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (await health()) return;
      if (spawnFailed) throw new Error('llama-server exited during startup');
      await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error('llama-server did not become ready in time');
  }

  async function chat(messages: unknown[]): Promise<string> {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, temperature: 0, max_tokens: 256 }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!res.ok) throw new Error(`llama-server responded ${res.status}`);
    return extractContent(await res.json());
  }

  return {
    async available(): Promise<boolean> {
      ensureStarted();
      if (spawnFailed) return false;
      return health(1000);
    },
    info(): AiInfo { return { model: cfg.modelLabel, device }; },
    async readSheet({ image, embeddedText }: { image: Buffer; embeddedText?: string }): Promise<SheetRead> {
      await waitReady();
      const dataUrl = `data:image/jpeg;base64,${image.toString('base64')}`;
      const messages = [{
        role: 'user',
        content: [
          { type: 'text', text: buildReadPrompt(embeddedText) },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      }];
      const raw = await queue.enqueue(() => chat(messages));
      return parseReadResponse(raw);
    },
    async matchSheet({ page, existing }: { page: SheetRead; existing: ExistingSheetRef[] }): Promise<SheetMatch> {
      await waitReady();
      const messages = [{ role: 'user', content: buildMatchPrompt(page, existing) }];
      const raw = await queue.enqueue(() => chat(messages));
      return parseMatchResponse(raw, existing.map(e => e.sheetId));
    },
  };
}
