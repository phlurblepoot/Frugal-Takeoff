FROM node:22-bookworm-slim

# Install build dependencies for native modules (better-sqlite3, etc.)
# python3-setuptools provides distutils which node-gyp requires
RUN apt-get update && apt-get install -y \
    python3 \
    python3-setuptools \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install dependencies
# --mount=type=cache persists the npm download cache across builds (BuildKit)
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# Copy the rest of the application code
COPY . .

# Build the frontend
RUN npm run build

# --- Optional local AI (sheet reading) -------------------------------------
# node-llama-cpp is an OPTIONAL dependency; `npm ci` installs its CPU binaries
# by default and the app runs fine with the feature disabled. For GPU inference
# (the AI sheet-reading feature), build a CUDA-capable image:
#   * base this stage on an NVIDIA CUDA image with Node 22 (or install the CUDA
#     12.x runtime on top of this image — match the GPU, e.g. RTX 5070/Blackwell),
#   * build with `--build-arg WITH_CUDA=1`, and
#   * run the container with `--gpus all`.
# node-llama-cpp resolves its CUDA backend when the GPU + CUDA libs are present.
# Model weights are NOT baked in — mount them at /models.
# See docs/ai-sheet-reading-runbook.md.
ARG WITH_CUDA=0
ENV WITH_CUDA=${WITH_CUDA}
ENV AI_MODELS_DIR=/models
VOLUME ["/models"]

# Set environment variables
ENV NODE_ENV=production
ENV STORAGE_PATH=/app/data
ENV PORT=3000

# Expose the port the app runs on
EXPOSE 3000

# Create the data directory
RUN mkdir -p /app/data

# Start the server
CMD ["npx", "tsx", "server.ts"]
