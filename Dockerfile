# syntax=docker/dockerfile:1
# Multi-stage build for the บ้านกาญจน์ dorm management server.
# Final image is ~120MB (alpine), runs as a non-root user, has no dev deps.

# ---- deps stage: install production + optional deps ----------------------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# --include=optional installs nodemailer + @sentry/node so admins can enable
# email + error tracking from the Features UI without rebuilding the image.
RUN npm ci --omit=dev --include=optional --no-audit --no-fund && \
    npm cache clean --force

# ---- runtime stage -------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app

# Tini gives us a proper PID-1 init process so SIGTERM propagates to node.
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    PORT=3000 \
    NPM_CONFIG_LOGLEVEL=warn

# Copy installed deps and app code
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node . .

# Pre-create writable dirs so the non-root user can use them without
# having to chmod a Railway volume mounted on top.
RUN mkdir -p /app/uploads /app/backups && \
    chown -R node:node /app/uploads /app/backups

# Drop privileges
USER node

EXPOSE 3000

# Healthcheck hits /health (which pings the DB). Five-minute grace period
# gives the migration on first boot enough time on slow networks.
HEALTHCHECK --interval=30s --timeout=5s --start-period=300s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health > /dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
