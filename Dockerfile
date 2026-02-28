FROM oven/bun:1.3.8-debian AS builder
WORKDIR /app

# Copy dependency manifests first for layer caching
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source and build scripts
COPY . .

# Run the same build command as package.json "build" script
# bun can run Node.js scripts natively (node:fs, node:child_process supported)
RUN bash create-stubs.sh && bun fix-registry-paths.js --skip-type-check

# --- Runtime stage (smaller image) ---
FROM oven/bun:1.3.8-debian
WORKDIR /app

# FFmpeg needed for video preprocessing + scene analysis
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

# Copy only what's needed to run
COPY --from=builder /app/.agentuity .agentuity/
COPY --from=builder /app/node_modules node_modules/
COPY --from=builder /app/package.json ./

# Railway sets PORT env var; app.js reads process.env.PORT
EXPOSE 3500
CMD ["bun", ".agentuity/app.js"]
