FROM node:22-bookworm AS builder
WORKDIR /app

# Install bun 1.3.8 (pinned to match local dev — newer versions resolve deps differently)
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local BUN_VERSION=1.3.8 bash

# Copy dependency manifests first for layer caching
# CACHE_BUST: 2026-04-08a
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source and build scripts
COPY . .

# Agentuity CLI's Vite bundler requires npm in PATH (provided by node base image)
RUN bash create-stubs.sh && bun fix-registry-paths.js --skip-type-check

# Pin Remotion to exactly match the deployed Lambda function.
# Two node_modules trees exist after agentuity build:
#   /app/node_modules                    (from bun install, pinned by bun.lock)
#   /app/.agentuity/node_modules         (from agentuity build's Vite bundler,
#                                         which runs `npm install` internally
#                                         and resolves caret ranges to latest)
# The RUNTIME resolves from .agentuity/node_modules, so BOTH must be pinned.
# Diagnosis history: 2026-04-22 — runtime shipped 4.0.451 while Lambda was
# 4.0.448, causing every render to fail with a Version-mismatch error payload
# that our submit code swallowed into a 901s safety-net timeout.
ARG REMOTION_TARGET_VERSION=4.0.448

# Pin the outer (bun-installed) tree.
RUN INSTALLED=$(node -e "console.log(require('@remotion/lambda/package.json').version)") && \
    echo "[outer] Remotion installed: $INSTALLED (target: $REMOTION_TARGET_VERSION)" && \
    if [ "$INSTALLED" != "$REMOTION_TARGET_VERSION" ]; then \
      echo "[outer] Version drift — patching with npm install..." && \
      npm install --no-save \
        @remotion/lambda@$REMOTION_TARGET_VERSION \
        @remotion/lambda-client@$REMOTION_TARGET_VERSION \
        remotion@$REMOTION_TARGET_VERSION \
        @remotion/serverless@$REMOTION_TARGET_VERSION \
        @remotion/serverless-client@$REMOTION_TARGET_VERSION \
        @remotion/streaming@$REMOTION_TARGET_VERSION 2>&1 | tail -3 && \
      AFTER=$(node -e "console.log(require('@remotion/lambda/package.json').version)") && \
      echo "[outer] Remotion after fix: $AFTER" && \
      [ "$AFTER" = "$REMOTION_TARGET_VERSION" ] || (echo "[outer] FATAL: still $AFTER" && exit 1); \
    else \
      echo "[outer] OK: matches target"; \
    fi

# Pin the inner (.agentuity) tree — this is what runs at runtime.
# Guard with a -d check because the Agentuity build may not always create this tree.
RUN if [ -d "/app/.agentuity/node_modules/@remotion/lambda" ]; then \
      INNER_INSTALLED=$(node -e "console.log(require('/app/.agentuity/node_modules/@remotion/lambda/package.json').version)") && \
      echo "[inner] Remotion installed: $INNER_INSTALLED (target: $REMOTION_TARGET_VERSION)" && \
      if [ "$INNER_INSTALLED" != "$REMOTION_TARGET_VERSION" ]; then \
        echo "[inner] Version drift — patching with npm install at .agentuity/..." && \
        cd /app/.agentuity && npm install --no-save \
          @remotion/lambda@$REMOTION_TARGET_VERSION \
          @remotion/lambda-client@$REMOTION_TARGET_VERSION \
          remotion@$REMOTION_TARGET_VERSION \
          @remotion/serverless@$REMOTION_TARGET_VERSION \
          @remotion/serverless-client@$REMOTION_TARGET_VERSION \
          @remotion/streaming@$REMOTION_TARGET_VERSION 2>&1 | tail -3 && \
        INNER_AFTER=$(node -e "console.log(require('/app/.agentuity/node_modules/@remotion/lambda/package.json').version)") && \
        echo "[inner] Remotion after fix: $INNER_AFTER" && \
        [ "$INNER_AFTER" = "$REMOTION_TARGET_VERSION" ] || (echo "[inner] FATAL: still $INNER_AFTER" && exit 1); \
      else \
        echo "[inner] OK: matches target"; \
      fi \
    else \
      echo "[inner] .agentuity/node_modules/@remotion/lambda not found — skipping (will runtime-fail if agentuity bundles remotion)"; \
    fi

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
