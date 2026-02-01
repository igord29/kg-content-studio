FROM oven/bun:1.3.8

WORKDIR /app

# Copy package files
COPY package.json bun.lock ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# Create stub files
RUN bash create-stubs.sh

# Build the application
RUN bun run build

# Fix imports after build
RUN bash fix-imports.sh

# Set environment variables for production
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV HOST=0.0.0.0
ENV PORT=8080

# Expose port
EXPOSE 3500

# Start the application
CMD ["bun", ".agentuity/app.js"]
