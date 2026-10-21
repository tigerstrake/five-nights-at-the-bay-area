# Five Nights at the Bay Area

Browser-based asymmetric multiplayer survival horror on a graph of real Bay Area Caltrans traffic cameras.
One player is the **Monster** (issues strategic commands to an AI-driven creature), everyone else is a
**Defender** in a shared CCTV control room. Survive until dawn, or trap and contain the thing.

## Requirements

- Node.js 20+ (developed on Node 24), npm 10+

## Install

```bash
npm install
npx playwright install chromium   # only needed for e2e tests
```

## Run (development)

```bash
npm run dev
```

- Server: http://localhost:3001 (`/api/health`, `/api/cameras`, Socket.IO at `/socket.io`)
- Client: http://localhost:5175 (Vite proxies `/api` and `/socket.io` to the server — one origin)

Open the client in two browser windows (or two tabs — each tab is its own player because the session token
lives in `sessionStorage`). Create a room in one, join with the 4-letter code in the other, pick roles and
an HQ, ready up.

The server runs under `tsx watch`, so editing server code or `shared/src/data/*.json` restarts it and
drops active rooms (clients fall back to the title screen).

## Build / production

```bash
npm run build      # builds client/dist and typechecks the server
npm start          # serves the built client + API + Socket.IO on $PORT (default 3001)
```

Deploying for internet play: run `npm start` behind any HTTPS reverse proxy that supports WebSockets
(proxy `/` including `/socket.io`). Copy `.env.example` to `.env` (or set env vars) as needed.

## Test

```bash
npm run typecheck  # shared, server, client
npm test           # Vitest: engine, visibility (anti-cheat), pathfinding, rooms, full-match simulation
npm run test:e2e   # Playwright (starts its own server on 3101 and client on 5199)
```

## Camera modes

`CAMERA_MODE=auto` (default) health-checks the 36 curated Caltrans cameras politely and shows real imagery only
where it is verified: **LIVE** (HLS video, enlarged feed only) > **SNAPSHOT** (still image, with its age) > a clearly
labelled **SIMULATED** feed. A dead or "Temporarily Unavailable" camera, or no internet at all, never affects the
match: those cameras just fall back to SIMULATED. `live` shows only verified-live cameras as real, `snapshot` uses stills
only, and `CAMERA_MODE=simulation` needs no network at all (a complete match is playable offline). Badges show the real
source state, independent of fictional in-game sabotage. Details: `docs/CAMERAS.md` section 7; ops view at
`/api/cameras?detail=1` and `/api/health`.

## Docs

- `docs/SPEC.md` — product spec
- `docs/CONTRACT.md` — team layout/ownership/schemas
- `docs/ARCHITECTURE.md` — how the code fits together
- `docs/MECHANICS.md` — the actual rules and numbers
- `docs/CAMERAS.md` — camera curation
