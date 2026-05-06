# syntax=docker/dockerfile:1
# Multi-stage build for the บ้านกาญจน์ dorm management server.
# Final image is small, runs as a non-root user, has no dev deps.

# ---- deps stage: install production deps only --------------------------------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- runtime stage -----------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Copy installed deps and app code
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node . .

# Drop privileges
USER node

EXPOSE 3000

# Health check uses the built-in /health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health > /dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
