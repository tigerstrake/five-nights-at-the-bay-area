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
5. In **Environment**, set `TRUST_PROXY` to a comma-separated list of verified Render ingress proxy IPs/CIDRs and any additional trusted proxy hops between the service and the client. For example, **if** the verified ingress pool is `10.42.0.0/24`, set `TRUST_PROXY=10.42.0.0/24`; this is an illustrative range, not a Render-wide default. Obtain the ingress ranges for your service/region from your platform operator before configuring them. Render forwards client addresses through `X-Forwarded-For` ([Render's client-IP guidance](https://render.com/articles/how-render-handles-ddos-attacks)); without this allowlist, users of a shared ingress address share rate-limit buckets.

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
5. Set the allowlist to your verified Fly Proxy ingress IPs/CIDRs, including trusted intermediate hops in `X-Forwarded-For`, then deploy/restart with that environment value:
   ```bash
   fly secrets set TRUST_PROXY='<verified-proxy-ip-or-cidr>,<other-trusted-hop>'
   ```
   Replace the placeholders with actual addresses/ranges; omit unused entries. If the immediate proxy is verified to connect over loopback, `TRUST_PROXY=127.0.0.1,::1` covers that hop; otherwise list its actual peer IP/CIDR. Use proxy source addresses, not your app's public Anycast or egress IP. Fly documents the forwarded chain in its [request headers reference](https://docs.fly.io/networking/request-headers). This server reads `X-Forwarded-For` through trusted hops; it does not implicitly trust `Fly-Client-IP`.

> **CRITICAL**: Ensure only 1 machine is running (`fly scale count 1`).

---

## 4. Configuration & Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` (Docker: `3001`, Render: `10000`, Fly: `8080`) | HTTP and WebSocket listener port. |
| `NODE_ENV` | `production` | Enables production mode and static asset serving from `client/dist`. |
| `CAMERA_MODE` | `auto` | Camera ingestion mode (`auto`, `live`, `snapshot`, `simulation`). |
| `CORS_ORIGIN` | reflect origin | Comma-separated list of allowed origins (e.g., `https://example.com`) if the client is hosted on a separate CDN/domain. |
| `TRUST_PROXY` | empty (trust none) | Comma-separated trusted reverse-proxy IPs/CIDRs, IPv4 or IPv6. Enables `X-Forwarded-For` only from allowlisted socket peers and walks the chain right-to-left, stopping at the first untrusted hop. Unset/empty/`false` disables forwarding trust; invalid entries, `true`, and hop counts fail startup. |
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
- Configure `TRUST_PROXY` on Render and Fly as above. Allowlist only proxies whose forwarding behavior you trust; use the narrowest verified ingress ranges, and ensure those proxies append the real peer address or overwrite untrusted forwarding headers. Missing/malformed forwarding headers fall back to the socket address. Direct connections from other peers ignore forwarding headers. IPv4-mapped IPv6 and equivalent IPv6 spellings share a rate-limit key. Do not set `0.0.0.0/0` or `::/0`: that would also trust arbitrary direct clients.

### 3. Camera Modes & Offline Resilience
- `CAMERA_MODE=auto`: Probes Caltrans feeds and gracefully falls back to simulated procedural feeds if external streams are offline or unreachable.
- `CAMERA_MODE=simulation`: Runs completely offline with zero external network requests. Feeds render labelled simulated CCTV footage. The game remains 100% playable in airgapped or test environments.

---

## 6. Capacity

### How it was measured

`npm run perf` (`server/src/perf/`) runs N concurrent rooms in-process through the real `RoomManager` on a simulated
clock: 1 AI monster + 1–4 AI defenders per room (mixed HQs and difficulties; `--defenders 4` for 5-player rooms), a
connected human spectator keeping each room alive, and finished matches restarted through the normal results →
lobby → countdown cycle so the load is sustained. For every AI seat it also does what the transport would do for a
human in that seat each tick: project the role view, delta-encode it and `JSON.stringify` it (bytes counted). Options:
`--rooms 10,25,50,100 --minutes 10 --defenders 4 --full-views --output file.json`. Raw results:
`server/src/perf/before.json` (commit f6a747f) and `server/src/perf/after.json`. Every seed is fixed, and the match
outcome digests are identical before and after, so the optimisations changed no game rule or AI decision.

"Tick" is the wall time of one 100 ms server tick for all rooms together (simulation + AI + projection +
serialisation). Event-loop lag is sampled during the accelerated run and is about one tick at worst. Machine: Apple M4
Max, Node 24, one core, with other agents' browsers using 8–20 cores at the same time (the 100-room 5-player rows were
the noisiest). 10 simulated minutes per row.

| Rooms × players | Tick p50 / p95 / p99 ms (before → after) | CPU per room-tick ms | Bytes/player/s | Peak heap / RSS MiB (after) |
| --- | --- | --- | --- | --- |
| 10 × 2–5 | 2.1 / 2.8 / 3.1 → **0.5 / 0.9 / 1.5** | 0.197 → 0.059 | 138.7 k → **12.2 k** | 60 / 197 |
| 25 × 2–5 | 5.4 / 7.1 / 7.5 → **1.4 / 2.0 / 3.1** | 0.204 → 0.058 | 137.6 k → 12.1 k | 75 / 221 |
| 50 × 2–5 | 11.2 / 15.4 / 16.2 → **2.7 / 3.5 / 4.9** | 0.216 → 0.055 | 137.8 k → 11.9 k | 76 / 231 |
| 100 × 2–5 | 24.0 / 34.0 / 36.2 → **5.4 / 6.7 / 9.0** | 0.234 → 0.055 | 138.3 k → 11.9 k | 89 / 258 |
| 50 × 5 | 16.3 / 23.3 / 24.2 → **3.0 / 3.8 / 4.7** | 0.315 → 0.061 | 146.1 k → 13.1 k | 87 / 235 |
| 100 × 5 | 42.2 / 93.5 / 143.7 → **8.2 / 14.3 / 20.9** | 0.469 → 0.089 | 146.2 k → 13.3 k | 152 / 339 |
| 50 × 5, old full-view clients | 13.2 / 33.8 / 67.4 (after, loaded host) | 0.333 | 146.1 k | 85 / 240 |

Simulation + AI alone costs 0.015–0.025 ms per room-tick. Before the changes, about 85 % of the cost was view
projection and serialisation, and bandwidth was the real limit: 146 kB/s per player is ~290 Mbit/s for 250 players.

**Optimisations** (no rule changes, deterministic):
- Views are projected once per role per room per tick (`RoomManager.viewBatch`) and shared by teammates.
- The visible event window (the largest view field, ~10 kB) is memoised per match and returned as the same frozen
  array until an event is pushed. History older than the window is no longer hashed, copied and sorted per observer.
- The monster view reads its remembered observations directly instead of rebuilding the full AI brain input.
- Opt-in **view deltas**: the bundled client receives top-level patches against its previous view, with a full
  checkpoint on (re)connect, role or match change, resync and every 30 s (see `docs/MECHANICS.md`). This cuts
  bandwidth about 11×. Old or third-party clients still get full views.
- Bounded AI memory (a defender bot's seen-sighting set keeps only ids still visible); AI controllers are released when
  a match ends, restarts or its room is deleted.

**Leaks.** After each run every room is left and swept: 0 rooms remain and the heap returns to 9–10 MiB after GC
(8–12 MiB at the start) at every size. `server/src/rooms/cleanup.test.ts` runs 100 finish/restart/abandon cycles and checks that
controllers, matches, tokens and memberships are released and no timers are created.
`server/src/net/socket.test.ts` attaches and disposes the transport 100 times and checks that no interval, camera
subscription, connection listener or socket handler survives. Socket handlers are also removed on disconnect.

### Recommendation

One instance comfortably runs **50 concurrent matches of 4–5 players**. On the test core that used ~3 ms (p99 < 5 ms)
of the 100 ms tick. Plan on a typical cloud vCPU being 2–3× slower than this core. **100 matches** also fit
(p99 ~21 ms under contention), but treat that as the ceiling for a single instance. Budget:
- **CPU:** 1 vCPU up to ~50 matches, 2 vCPUs (Node stays single-threaded, the rest absorbs GC, TLS and the OS) up to
  ~100. Not measured: Socket.IO/WebSocket framing, TLS and kernel send cost per emit (one emit per player per tick,
  2,500 emits/s at 50 × 5). That is the main reason for the 3× headroom above.
- **Bandwidth:** ~13 kB/s per connected player with deltas. 50 × 5 players ≈ 3.3 MB/s ≈ 26 Mbit/s egress
  (~8.5 TB/month if sustained). Full-view clients cost ~146 kB/s each.
- **Memory:** heap stayed under 160 MiB and RSS under 350 MiB at 100 five-player rooms. A 512 MB instance is enough
  for 50 matches; use 1 GB for 100.

Beyond that, scale-out needs shared room state (see §5.1). Watch event-loop lag (tick > 50 ms means you are
saturated) and egress.

---

## 7. Open Issues

1. **Docker image not yet built in CI or locally.** The Dockerfile was written against the current scripts (`tsx` is a server runtime dependency, so `npm prune --omit=dev` keeps it), but no Docker daemon was available when it was authored. Run `docker build -t fnab . && docker run -p 3001:3001 fnab` and check `/api/health` before the first deploy.
2. **Single instance only.** Match state lives in memory, so keep exactly one instance (`numInstances: 1` on Render, one machine on Fly). On Fly, `auto_stop_machines` with `min_machines_running = 1` keeps one machine up; stopping it ends any matches in progress.
