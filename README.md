# Five Nights at the Bay Area

An asymmetric browser horror game, playable solo against AI or with friends, on a graph of 36 real Caltrans freeway cameras around the San Francisco Bay Area. The **Monster** gives strategic orders to a creature that walks the freeways. **Defenders** share a CCTV control room and one power budget for doors, sensors, traps and scans. Hold the headquarters until dawn, or trap the thing and hold it for 15 seconds.

![Defender control room with live Caltrans feeds](docs/screenshots/03-defender-control-room-live.jpg)

## Features

- **Two roles with separate interfaces.** Defenders get a dense multi-monitor control room: main feed, 12-tile monitor bank, power bus, doors, containment, team log. The Monster gets a dark command deck: stances, targeted abilities, "through the lens" view, exposure readout and an intent stream. Spectators can watch the control room, with no monster secrets shown.
- **Solo and mixed human/AI rooms.** Play either role against Novice, Competent or Expert opponents; add AI teammates. Hosts can add/remove AI seats and change their difficulty in the lobby.
- **Real cameras, honestly labelled.** Live-first selection, a main HLS feed and up to three live bank tiles. A stall watchdog switches LIVE to BUFFERING and recovers playback; fallback STILL frames show their age and next update. A dead camera or no internet never stops a match.
- **Monster AI.** Server-side tactical brain with A* pathfinding over travel time and camera exposure. The player picks the stance (HUNT, HIDE, FLANK, ATTACK, RETREAT) and abilities (SABOTAGE, DECOY); the AI chooses the route.
- **Two maps.** A schematic freeway transit map over the Natural Earth Bay shoreline, with sightings, routes and HQ gates; plus a geographic MapLibre map on OpenFreeMap tiles.
- **Camera FX and audio.** CCTV interference and monster compositing tuned against real footage for scene lighting, shadows, occlusion and video motion. Breach and containment cinematics and procedural Web Audio have volume, mute and reduce-flashing settings.
- **Coaching and readable alerts.** Contextual hints for the first two matches per role (toggle in Settings), plus big-moment banners for contact, traps, breaches and approaching dawn. Consoles stack and scroll on tablets/phones; phones also offer spectator guidance.
- **Multiplayer.** 4-letter rooms and invite links, host migration, reconnection and closed-tab seat reclaim within a grace period, forfeits, spectators and restart to lobby. The authoritative server projects separate role views and sends view deltas to reduce bandwidth.

## Quick start

Requires Node.js 20+ and npm.

```bash
npm install
npm run dev
```

- Client: http://localhost:5175 (Vite proxies `/api` and `/socket.io`)
- Server: http://localhost:3001 (`/api/health`, `/api/cameras`, Socket.IO)

Choose **Play solo** on the title screen to play against AI. For offline camera imagery, run `CAMERA_MODE=simulation npm run dev`.

## How to play

**Solo:** choose Play solo, your role, AI difficulty (Novice / Competent / Expert) and optional defender teammates. In the lobby pick an HQ, adjust AI seats if desired, and ready up; AI players are always ready.

**With friends:** Create room makes you host and Monster by default. Share the 4-letter code or invite link; others join as Defenders. A defender or the host selects the HQ. Everyone readies up for a 5 second countdown. Separate tabs can also play separate seats; reopening the invite after closing a tab can reclaim its disconnected seat within the grace period without taking over a live one (`room:recover`).

A night is 5 to 10 minutes (default 8) with a 20 second preparation, then three phases: Infiltration, Escalation, Final Assault. The monster is faster and breaches faster as the night goes on.

**Defenders** (shared power pool, all actions cost power):
- Watch the feeds. A camera only catches a glimpse; a sighting is a moment, not a track.
- Place motion sensors and traps (during preparation too), close the three HQ doors (sealed doors drain power and heat up), repair sabotaged cameras, scan a node to confirm a sighting and expose decoys, lure the monster with an alarm.
- When a trap catches the monster, engage containment and hold it for 15 uninterrupted seconds to win. Power at zero causes a 12 second blackout.
- Defenders win at dawn or by capture.

**Monster:**
- Pick a spawn and an opening stance in preparation, then change stance or target a door during the night. SABOTAGE kills a nearby camera or a sensor you found; DECOY fakes a sighting.
- You see the graph, camera status and what you have discovered, never traps or exact power. A breach of the HQ wins.
- If trapped, RETREAT starts a continuous struggle against the restraints.

Rules and numbers: [docs/MECHANICS.md](docs/MECHANICS.md). The in-game "How to play" sheet and `?` help have the same summary.

### Controls

All actions have on-screen controls. On tablets/phones, scroll through the stacked panels; a tablet or computer is recommended for the dense consoles. Coaching cards can be dismissed or switched off in Settings.

| Defender | |
| --- | --- |
| `1`-`9`, arrow keys | Show monitor on the main screen, move through the bank |
| `[` `]`, `O` | Previous / next bank page, auto-cycle pages |
| `P`, `V`, `R` | Pin the main camera, view latest sighting, repair the main camera |
| `Q` `W` `E` | Seal / open doors 1-3 |
| `H` | Engage / disengage containment |
| `I` `S` `T` `C` `L` | Map tool: inspect, sensor, trap, scan, lure |
| `Esc`, `?` | Back to inspect / close help, toggle the shortcut sheet |

| Monster | |
| --- | --- |
| `H` `C` `F` `A` `R` | HUNT, HIDE, FLANK, ATTACK, RETREAT |
| `S`, `D` | SABOTAGE, DECOY (then click a target on the map, `Enter` to confirm) |
| `0`-`3` | Target door: AI picks, or door 1-3 |
| `Space` | While trapped: struggle (RETREAT) |
| `Esc` | Cancel pending target, otherwise return to move tool |

<details><summary>More screenshots</summary>

![Monster command deck](docs/screenshots/04-monster-command.jpg)
![Geographic map](docs/screenshots/05-geographic-map.jpg)

</details>

## Camera modes

`CAMERA_MODE` selects how real imagery is used. Real camera trouble never stops a match; cameras degrade to SIMULATED on their own.

| Mode | Behaviour |
| --- | --- |
| `auto` (default) | Polite health checks. Try verified HLS first, else STILL, else labelled SIMULATED. |
| `live` | Like `auto`, but only cameras with a verified live stream show real imagery; the rest are SIMULATED. |
| `snapshot` | Stills only; HLS is never probed. |
| `simulation` | Fully offline. Every feed is the labelled procedural simulation and no external request is made. A full match is playable. |

Badges show the real source state, never the fictional in-game sabotage:

- **LIVE** - HLS video frames are advancing on the main feed or a live bank tile.
- **BUFFERING** - live video is connecting or stalled; recovery runs automatically, revealing the still after a prolonged stall.
- **STILL** - a Caltrans snapshot, with frame age and update timing; live-capable cameras have a red ring. The API still calls this mode `snapshot`.
- **SIMULATED** - dashed amber, a procedural stand-in. Never styled like live.

Caltrans data notes, usage terms, measured availability and the classification heuristics are in [docs/CAMERAS.md](docs/CAMERAS.md). Ops view: `/api/cameras?detail=1` and `/api/health`.

## Scripts

All exist in the root `package.json`.

| Command | What it does |
| --- | --- |
| `npm run dev` | Server (tsx watch, port 3001) and client (Vite, port 5175) together |
| `npm run build` | Build `client/dist`, then build/typecheck the server |
| `npm start` | Serve the built client, API and Socket.IO from one port (`$PORT`, default 3001) |
| `npm test` | Vitest unit and integration tests (`vitest run`) |
| `npm run test:watch` | Vitest in watch mode |
| `npm run test:e2e` | Playwright end-to-end suite (own servers on 3101/5199 and 3102/5198) |
| `npm run typecheck` | Typecheck shared, server and client |
| `npm run balance` | Headless bot balance harness (see [docs/BALANCE.md](docs/BALANCE.md)) |
| `npm run perf` | In-process room capacity harness (see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#6-capacity)) |

For e2e, run `npx playwright install chromium` once.

## Configuration

Copy `.env.example` to `.env` or set variables in the environment.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | Server port |
| `CAMERA_MODE` | `auto` | `auto`, `live`, `snapshot`, `simulation` |
| `CAMERA_CHECK_INTERVAL_MS` | `300000` | Per-camera re-check cadence |
| `CAMERA_TIMEOUT_MS` | `8000` | Probe timeout |
| `CAMERA_CONCURRENCY` | `3` | Max parallel probes |
| `CAMERA_REFRESH_MS` | `60000` | Suggested client snapshot refresh |
| `CAMERA_PROBE_ORIGIN` | unset | Test only: send probes to another origin to simulate an outage |
| `CORS_ORIGIN` | reflect origin | Comma-separated allowed Socket.IO origins when the client is hosted elsewhere |
| `API_PORT` | `3001` | Client dev server only: where to proxy the API |

## Architecture

```
client (React/Vite) <-socket.io-> server/net -> rooms -> engine (pure, deterministic)
        ^ per-role views                |                   |
        +------ visibility/ (anti-cheat projection)    ai/ (MonsterBrain)
                                   cameras/ (CameraService)
shared/  types, protocol, config (all balance numbers), graph, data
```

npm workspaces: `shared` (types, config, graph, camera and network data), `server` (Express, Socket.IO, engine, AI, visibility, cameras, balance/performance harnesses) and `client` (React, Vite, Tailwind, zustand, hls.js, MapLibre). The engine is pure and seeded; each player receives a role-projected view, with delta patches and periodic full checkpoints. Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/CONTRACT.md](docs/CONTRACT.md), [server/src/ai/README.md](server/src/ai/README.md), [client/src/audio/README.md](client/src/audio/README.md).

## Testing

- **Unit/integration:** `npx vitest run` passed **368 tests in 34 files** on 2026-10-21, including solo AI, seat recovery, view deltas, coaching rules, feed recovery and map/FX logic.
- **End-to-end inventory:** **24 Playwright tests in 10 spec files** under `e2e/*.spec.ts`, including solo play and closed-tab reclaim. Counted from source; not rerun for this refresh. Tests freeze match time with guarded `test:hold` hooks and use render-lite FX to avoid machine-speed dependencies. Slow-runner rehearsal: `CI=1 E2E_THROTTLE=4 E2E_WORKERS=2 npx playwright test`. See [e2e/README.md](e2e/README.md).
- **Balance:** measured with scripted bots, not humans. See [docs/BALANCE.md](docs/BALANCE.md).

Honest project status and known limitations: [docs/STATUS.md](docs/STATUS.md).

## Deployment

One Node process serves the built client, API and Socket.IO. **Match state is in memory, so run exactly one instance**. The in-process capacity harness supports planning for **50 concurrent 4–5-player matches on 1 vCPU / 512 MB**, with about **13 kB/s per player** using deltas; actual WebSocket/TLS overhead and cloud performance remain unmeasured. Put it behind HTTPS with WebSocket upgrade preserved. A `Dockerfile`, `render.yaml` and `fly.toml` are included; the Docker image has not been built locally. Measurement details and the 100-room ceiling: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Documentation

[SPEC](docs/SPEC.md) | [STATUS](docs/STATUS.md) | [ARCHITECTURE](docs/ARCHITECTURE.md) | [MECHANICS](docs/MECHANICS.md) | [CAMERAS](docs/CAMERAS.md) | [BALANCE](docs/BALANCE.md) | [DEPLOYMENT](docs/DEPLOYMENT.md) | [CONTRACT](docs/CONTRACT.md)

## Credits and licensing

- **Camera data:** Caltrans CWWP2 District 4 feed. Per the Caltrans Conditions of Use, website information is in the public domain unless otherwise indicated, with a note that some content (for example photographs) may be copyrighted. The data is free to use; we read it, link to it and display it, we do not archive or commit Caltrans images, and every real feed is labelled with its source. See [docs/CAMERAS.md](docs/CAMERAS.md) section 2 (not legal advice).
- **Maps:** tactical shoreline from Natural Earth 1:10m Land (public domain); geographic [OpenFreeMap](https://openfreemap.org) vector tiles, (c) OpenMapTiles, data (c) OpenStreetMap contributors, rendered with MapLibre GL.
- **Fonts:** self-hosted through `@fontsource` (Big Shoulders Display, IBM Plex Mono, Inter, Overpass), all SIL Open Font License. No runtime CDN requests.
- **Audio:** generated procedurally with Web Audio at runtime; no sample files.
- **Art:** original AI-generated images in `client/public/assets`, made with Google Antigravity's image model. Simulated feeds are drawn procedurally.
- **Built by** a team of Claude Code subagents, OpenAI Codex and Google Antigravity.
- **Repository license:** no `LICENSE` file has been added yet.

## Screenshot gallery

| | |
| --- | --- |
| ![Title](docs/screenshots/01-title.jpg) Title | ![Lobby](docs/screenshots/02-lobby-hq-select.jpg) Lobby and HQ selection |
| ![Defender](docs/screenshots/03-defender-control-room-live.jpg) Earlier control room (source badges and tactical map have since changed) | ![Monster](docs/screenshots/04-monster-command.jpg) Monster command deck |
| ![Geo map](docs/screenshots/05-geographic-map.jpg) Geographic map | ![FX](docs/screenshots/06-monster-on-feed-fx-lab.jpg) Monster composited on a feed (FX lab, simulated feed) |
| ![Containment](docs/screenshots/07-containment.jpg) Containment field | ![Breach](docs/screenshots/08-breach-cinematic.jpg) Breach cinematic |
| ![Monster win](docs/screenshots/09-results-monster-win.jpg) Results, monster wins | ![Defender win](docs/screenshots/10-results-defender-win-route-reveal.jpg) Results, route revealed |
