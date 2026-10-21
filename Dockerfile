# syntax=docker/dockerfile:1

# ------------------------------------------------------------------------------
# Stage 1: Build stage
# ------------------------------------------------------------------------------
FROM node:24-slim AS builder

WORKDIR /app

# Install build dependencies
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/

RUN npm ci

# Copy full application sources
COPY tsconfig.base.json ./
COPY shared/ shared/
COPY server/ server/
COPY client/ client/

# Build client production bundle (Vite -> client/dist) and verify server builds
RUN npm run build

# Prune devDependencies for production image
RUN npm prune --omit=dev

# ------------------------------------------------------------------------------
# Stage 2: Minimal runtime stage
# ------------------------------------------------------------------------------
FROM node:24-slim AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001
ENV CAMERA_MODE=auto

# Run as non-root user for security
USER node

# Copy dependencies and application artifacts from builder
COPY --chown=node:node --from=builder /app/package.json /app/package-lock.json ./
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/shared ./shared
COPY --chown=node:node --from=builder /app/server ./server
COPY --chown=node:node --from=builder /app/client/dist ./client/dist
COPY --chown=node:node --from=builder /app/client/package.json ./client/package.json

EXPOSE 3001

# Built-in health check using Node (no extra curl dependency needed)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e 'require("node:http").get(`http://localhost:${process.env.PORT || 3001}/api/health`, (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on("error", () => process.exit(1))'

CMD ["npm", "start"]
