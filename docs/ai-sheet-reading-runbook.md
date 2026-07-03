# AI Sheet Reading — Ops Runbook

## What it is
A local vision model (default Qwen2.5-VL-3B GGUF) runs on the server GPU to read
plan-sheet numbers/titles and match revisions when adding a plan set. Fully
local; no external calls, no API key. If the model isn't available, the app
silently falls back to the existing text/OCR extraction + manual naming.

## Requirements
- NVIDIA GPU (tested target: RTX 5070) with the NVIDIA Container Toolkit
  configured on the host.
- Container image built with CUDA support (`--build-arg WITH_CUDA=1`) — see the
  Dockerfile notes. For a GPU build, base the image on an NVIDIA CUDA 12.x image
  with Node 22 (or add the CUDA 12.x runtime to the existing base) so
  `node-llama-cpp` can use its CUDA backend.
- A host directory mounted at `/models` holding the model weights.

## First-time setup
1. Create a models directory on the host and mount it to `/models`.
2. Download the model + vision projector GGUF files into it (filenames must
   match `AI_MODEL_FILE` / `AI_MMPROJ_FILE`, defaults shown):
   - `qwen2.5-vl-3b-instruct-q4_k_m.gguf`
   - `qwen2.5-vl-3b-instruct-mmproj-f16.gguf`
   If Qwen2.5-VL misbehaves in the installed `node-llama-cpp` / llama.cpp
   version, use MiniCPM-V 2.6 GGUF + its mmproj and set `AI_MODEL_FILE` /
   `AI_MMPROJ_FILE` accordingly.
3. Run the container with GPU access (e.g. `--gpus all`).

## Config (environment variables)
- `AI_ENABLED` — default on; set `false`/`0` to disable the feature entirely.
- `AI_MODELS_DIR` — default `/models`.
- `AI_MODEL_FILE` / `AI_MMPROJ_FILE` — model + vision projector filenames in
  `AI_MODELS_DIR`.
- `AI_MODEL_PATH` / `AI_MMPROJ_PATH` — absolute overrides (bypass the dir+file join).
- `AI_GPU_LAYERS` — default `-1` (all layers on GPU).
- `AI_TIMEOUT_MS` — per-inference timeout, default `30000`.

## Verify
Authenticated request to `GET /api/ai/status`:
```
{"available": true, "model": "qwen2.5-vl-3b-instruct", "device": "cuda"}
```
Then read a real page (use an actual page `imageId`):
```
curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"imageId":"<imageId>"}' http://localhost:3331/api/ai/read-sheet
# → {"sheetNumber":"A-201","sheetTitle":"...","confidence":0.x}
```

## Troubleshooting
- `available:false`, `device:"none"`, model `"model files not found"` → the GGUF
  files aren't at the configured paths in `/models`.
- `available:false` but files present → the container can't load the model:
  confirm CUDA libs are in the image, the container sees the GPU
  (`nvidia-smi` inside the container), and `node-llama-cpp` installed. Check
  server logs for the load error.
- `device:"cpu"` → the model loaded but without GPU offload; check CUDA/driver
  and `AI_GPU_LAYERS`.

## Fallback behaviour
When unavailable, imports and the add-set review step use the existing OCR +
manual-region naming and the manual "Revision of / New sheet" dropdown. Nothing
blocks; the AI badges simply don't appear.
