# ─── Stage 1: Builder ────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy manifests first to exploit Docker layer caching.
# If only source files change (not deps), this layer is cached.
COPY package.json package-lock.json ./

# npm ci: deterministic install from lockfile. Faster and safer than npm install.
# RULE-06: package-lock.json must exist before Docker build (run npm install locally first).
RUN npm ci

# tsconfig files must NOT be in .dockerignore (RULE-07).
# nest build requires both tsconfig.json and tsconfig.build.json.
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src

RUN npm run build

# ─── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Non-root user (Section 11 container standards).
RUN addgroup -g 1001 -S nodejs && adduser -S nestjs -u 1001 -G nodejs

WORKDIR /app

# Production dependencies only — dev deps (jest, ts-jest, etc.) are excluded.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output from builder stage.
COPY --from=builder /app/dist ./dist

USER nestjs

EXPOSE 8083

# Graceful shutdown: Node listens for SIGTERM and drains in-flight requests.
# NestJS handles SIGTERM via app.enableShutdownHooks().
# The 30s drain window is enforced by Kubernetes terminationGracePeriodSeconds.
CMD ["node", "dist/main"]
