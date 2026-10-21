# Deployment Guide

*Five Nights at the Bay Area* (`fnab`) is an asymmetric survival horror game featuring a Node.js Express + Socket.IO server and a React single-page frontend. In production, the Node server serves both the built static client (`client/dist`) and real-time Socket.IO game traffic from a single unified HTTP port.

---

## 1. Local Production Run

To build and run the production server locally without Docker:

```bash
# 1. Install dependencies
npm ci

# 2. Build the client bundle and typecheck the server
npm run build

# 3. Start the production server
PORT=3001 CAMERA_MODE=simulation npm start
```

- **Client & Game UI**: `http://localhost:3001`
- **Health Check**: `http://localhost:3001/api/health`
- **Camera Status API**: `http://localhost:3001/api/cameras`

---

## 2. Docker Build & Run

A multi-stage `Dockerfile` is provided using `node:24-slim` with a non-root runtime user (`node`).

### Build Container
```bash
docker build -t fnab:latest .
```

### Run Container
```bash
docker run -p 3001:3001 \
  -e PORT=3001 \
  -e CAMERA_MODE=simulation \
  fnab:latest
```

The container includes a built-in `HEALTHCHECK` that queries `/api/health` every 30 seconds.

---

## 3. Platform Deployments

### Render (`render.yaml`)

Deployable via Render Blueprints or as a Docker Web Service:

1. Push your repository to GitHub / GitLab.
2. In the Render Dashboard, create a **New Blueprint Instance** and point to the repository (or create a **Web Service** with runtime `Docker`).
3. Render automatically picks up `render.yaml` or `Dockerfile`.
4. WebSockets are natively supported over HTTPS.

> **CRITICAL**: In Render settings, ensure instance count is set to **1** (`numInstances: 1`). Do not enable autoscaling.

---

### Fly.io (`fly.toml`)

Deployable using the Fly CLI (`flyctl`):

1. Launch and configure the application:
   ```bash
   fly launch --no-deploy
   ```
2. Verify settings in `fly.toml` (defaults to San Jose `sjc` region close to the Caltrans cameras).
3. Deploy:
   ```bash
   fly deploy
   ```
4. Verify deployment health:
   ```bash
   fly status
   fly logs
   ```

> **CRITICAL**: Ensure only 1 machine is running (`fly scale count 1`).

---

## 4. Configuration & Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` (Docker: `3001`, Render: `10000`, Fly: `8080`) | HTTP and WebSocket listener port. |
| `NODE_ENV` | `production` | Enables production mode and static asset serving from `client/dist`. |
| `CAMERA_MODE` | `auto` | Camera ingestion mode (`auto`, `live`, `snapshot`, `simulation`). |
| `CORS_ORIGIN` | reflect origin | Comma-separated list of allowed origins (e.g., `https://example.com`) if the client is hosted on a separate CDN/domain. |
| `CAMERA_CHECK_INTERVAL_MS`| `300000` (5m) | Background health check interval for external Caltrans feeds. |
| `CAMERA_TIMEOUT_MS` | `8000` (8s) | Probe timeout when checking external camera streams. |
| `CAMERA_CONCURRENCY` | `3` | Max simultaneous external probes. |
| `CAMERA_REFRESH_MS` | `60000` (1m) | Recommended client snapshot refresh rate. |

---

## 5. Architectural Constraints & Operational Rules

### 1. In-Memory Match State (Single-Instance Only)
- Active match state and room sessions (`RoomManager`) are stored **strictly in-memory** on the server.
- The service **MUST run as exactly ONE instance**.
- Do not configure horizontal autoscaling, round-robin load balancers, or multiple server replicas without refactoring room state to an external backing store (e.g. Redis) and implementing Redis adapter for Socket.IO.

### 2. WebSockets & Sticky Sessions
- Client and server communicate over Socket.IO using WebSocket transport (falling back to HTTP long-polling).
- When fronted by a reverse proxy or CDN (e.g., Nginx, Cloudflare), WebSocket upgrading (`Upgrade: websocket` and `Connection: Upgrade`) must be preserved.

### 3. Camera Modes & Offline Resilience
- `CAMERA_MODE=auto`: Probes Caltrans feeds and gracefully falls back to simulated procedural feeds if external streams are offline or unreachable.
- `CAMERA_MODE=simulation`: Runs completely offline with zero external network requests. Feeds render labelled simulated CCTV footage. The game remains 100% playable in airgapped or test environments.

---

## 6. Open Issues

The following item was identified during deployment verification:

1. **Client TypeScript Type Check (`client/src/ui/assets.ts`)**:
   - `npm run build` succeeds cleanly and generates `client/dist`.
   - However, `npm run typecheck` (`tsc -p tsconfig.json --noEmit` in `@fnab/client`) reports two TypeScript errors in `src/ui/assets.ts` (lines 36 and 39) because `fetch().then(r => r.ok ? r.json() : {})` resolves to a type union including `{}` without explicit index signatures.
   - *Workaround / Planned Fix*: Add type casting `r.json() as Promise<Record<string, unknown>>` to the empty fallback object `({} as Record<string, unknown>)`. In accordance with non-destructive deployment instructions, existing application source code was not modified.
