FROM node:22-bookworm AS builder
WORKDIR /app

# Install bun 1.3.8 (pinned to match local dev — newer versions resolve deps differently)
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local BUN_VERSION=1.3.8 bash

# Copy dependency manifests first for layer caching
# CACHE_BUST: 2026-04-07 — force fresh install to fix remotion 4.0.441 vs 4.0.445 mismatch
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source and build scripts
COPY . .

# Agentuity CLI's Vite bundler requires npm in PATH (provided by node base image)
RUN bash create-stubs.sh && bun fix-registry-paths.js --skip-type-check

# --- Runtime stage (smaller image) ---
FROM oven/bun:1.3.8-debian
WORKDIR /app

# FFmpeg + s5cmd (12x faster S3 uploads than aws-cli)
RUN apt-get update && apt-get install -y ffmpeg curl && \
    curl -fsSL https://github.com/peak/s5cmd/releases/download/v2.3.0/s5cmd_2.3.0_linux_amd64.deb -o /tmp/s5cmd.deb && \
    dpkg -i /tmp/s5cmd.deb && rm /tmp/s5cmd.deb && \
    rm -rf /var/lib/apt/lists/*

# Copy only what's needed to run
COPY --from=builder /app/.agentuity .agentuity/
COPY --from=builder /app/node_modules node_modules/
COPY --from=builder /app/package.json ./

# Patch: Agentuity binds to 127.0.0.1 by default, but Railway's reverse proxy
# needs the server on 0.0.0.0. Replace the hardcoded hostname with an env-var lookup.
RUN sed -i 's/hostname:"127.0.0.1"/hostname:process.env.HOST||"127.0.0.1"/g' .agentuity/app.js

# Railway sets PORT env var; app.js reads process.env.PORT
ENV HOST=0.0.0.0
ENV NODE_ENV=production
EXPOSE 3500
CMD ["bun", ".agentuity/app.js"]
