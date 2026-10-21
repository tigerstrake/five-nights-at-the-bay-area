# Architecture

```
client (React/Vite)  ──socket.io──▶  server/net  ──▶  rooms/RoomManager  ──▶  engine (pure)
   ▲  per-role views                     │                    │                    │
   └─────────────── visibility/ (anti-cheat projection) ◀─────┘        ai/ (MonsterBrain)
                                         │
                             cameras/ (CameraService: real source availability)
shared/  types · protocol · config (all balance numbers) · graph · rng · data (network.json, cameras.json)
```

## shared/ (`@fnab/shared`, zero runtime deps)

| File | What |
| --- | --- |
| `src/types.ts` | Domain types: data schemas (`NetworkData`, `CameraRecord`), roles/phases/commands, `DefenderAction` / `MonsterAction`, `GameEvent`, per-role views (`DefenderView`, `MonsterView`), `MatchResult`, lobby `RoomView`, `CameraSourceStatus`. |
| `src/protocol.ts` | Typed Socket.IO `ClientToServerEvents` / `ServerToClientEvents`. |
| `src/config.ts` | `BalanceConfig`, `DEFAULT_CONFIG`, `scaleForDefenders(n)`, `clampDurationMs`. Every gameplay number lives here. |
| `src/graph.ts` | `Graph` (adjacency, neighbours, BFS hops, `hopsToHq`, `within`, `edgeBetween`, `aStar`, `shortestPath`), `edgeTravelMs`, `haversineKm`. |
| `src/rng.ts` | `createRng(seed)` (mulberry32) and `hashString`. |
| `src/data.ts` | JSON imports of `data/network.json` + `data/cameras.json` (`NETWORK`, `CAMERAS`, `CAMERA_BY_ID`, `getGraph()`, `validateNetwork`). Server and client bundle the same files. |

Times: `t` = match ms since the match started (preparation starts at 0). Views carry `t0Epoch` (server
epoch at t=0) and `serverNow`; the client keeps an NTP-style clock offset (`time:ping`) and renders timers as
`serverNow() - t0Epoch`.

## server/

- `engine/state.ts` — full authoritative `GameState` (server-only) and `createGame`.
- `engine/engine.ts` — `step(ctx, state, dtMs, rng)` and `applyAction(ctx, state, actor, action, rng)`.
  Pure and deterministic: no IO, no `Date.now`, all randomness from the seeded RNG. State is mutated in place.
  `EngineCtx = { graph, brain, placementCount }`. Fixed 10 Hz tick (`cfg.tickMs`).
- `ai/` — `MonsterBrain.decide(BrainInput, rng) → MonsterIntent` (`types.ts`). `TacticalBrain` (`tacticalBrain.ts`,
  the default, one per match) runs a utility-scored mode machine (stalk / investigate / creep / circle / commit /
  batter / escape…) over `TacticalPlanner` (`pathfinding.ts`: A* with travel time + exposure costs from cameras,
  known sensors and remembered danger). `buildMonsterKnowledge` (`knowledge.ts`) is the *only* bridge from state to
  the monster side. All weights: `DEFAULT_TACTICAL_AI` in `shared/src/config.ts`. `BaselineBrain` stays for
  regression tests. The engine calls the brain on every node arrival, on stance changes and every `replanMs` while
  idle; the intent is validated (adjacent edges only) before use. See `server/src/ai/README.md`.
- `visibility/` — `projectDefenderView`, `projectSpectatorView`, `projectMonsterView`. Fields are copied
  explicitly; tests assert no forbidden keys leak.
- `rooms/RoomManager.ts` — transport-agnostic lobby/match lifecycle with an injectable clock (unit-tested):
  4-letter codes, roles, HQ choice, ready → 5 s countdown → match, reconnection by token within a 60 s grace
  period, host migration, forfeits, restart to lobby, empty-room cleanup. `tick(now)` advances matches in
  fixed steps with bounded catch-up.
- `net/` — Socket.IO wiring (`socket.ts`) and zod schemas for every client payload (`schemas.ts`).
  Views are emitted per player socket (never broadcast) every tick, plus immediately after an accepted action.
- `cameras/` — `CameraService` (`types.ts`): real-world source availability only, never fictional game status.
  `CAMERA_MODE` (`auto` default · `live` · `snapshot` · `simulation`) picks the implementation (`index.ts`).
  `CaltransCameraService` (`caltrans.ts`) probes every curated camera's JPEG snapshot and HLS playlist + segment on
  its own polite timers (bounded concurrency, backoff, per-host circuit breaker) and classifies them with the pure
  heuristics in `classify.ts` (rejects the Caltrans "Temporarily Unavailable" card and black frames). A camera is
  `live` only with a verified playable stream *and* a good snapshot, `snapshot` with a good snapshot, otherwise
  labelled `simulated` with a `reason`. `SimulationCameraService` makes no network calls. Statuses are public and
  pushed to everyone on join and on change (`cameras:status`); the browser loads imagery directly from Caltrans
  (CORS verified at curation). Details: `docs/CAMERAS.md`.
- `balance/` — headless bot harness (`npm run balance`) used to tune `DEFAULT_CONFIG` (see `docs/BALANCE.md`).
- `index.ts` — Express (`/api/health`, `/api/cameras`, static `client/dist` in production) + Socket.IO.

## client/

Dev server: http://localhost:5175 (`--strictPort`; 5173 is used by another local project). Proxies `/api` + `/socket.io`
to `API_PORT` (default 3001). Webfonts are self-hosted (`src/fonts.ts`, @fontsource, OFL): no runtime CDN requests.

- `App.tsx` — screen router (Title → Lobby → Loading/uplink → Defender | Monster → Results) inside `ScreenTransition`.
  Sets `data-team` (accent tokens), `data-reduce-flash` (global "reduce flashing" CSS) and, on very large viewports,
  a root CSS `zoom` (`hooks/useConsoleZoom.ts`: layout for ~1680×1000, scaled up to 1.6×) so every screen scales alike.
  Components that convert pointer coordinates use layout px (`clientWidth`) or divide by `rootZoom(el)`.
- `net/socket.ts` — socket singleton, sessionStorage session `{code, token}` (per tab; cleared on leave/kick), auto-resume
  on reconnect, NTP-style clock sync, `sendAction`, `lobby.*` helpers. Errors surface as toasts.
- `state/store.ts` — zustand store (`room`, `view`, `result`, `cameraStatuses`, clock offset, UI state) and
  `serverNow()` / `matchNow(view)`. In dev (or with `?e2e`) it is exposed as `window.__fnab` for scripted tests.
- `ui/` — the shared kit: `kit.tsx` (Panel, Button, Badge, Meter, Stat, Segmented, Kbd…), `chrome.tsx` (settings menu:
  volume / mute / reduce flashing, connection badge, reconnect banner, audio-unlock prompt, toasts, screen grain),
  `assets.ts` (optional art from `public/assets/ui/manifest.json`). Tokens live in `src/index.css` `@theme`
  (defender = cyan/phosphor, monster = bone/blood; `text-team` follows `data-team`).
- `screens/` — `TitleScreen`, `LobbyScreen` (roles incl. spectator, HQ cards, night length, difficulty preview),
  `LoadingScreen` (countdown + real uplink checks, `shell/uplink.ts`), `DefenderScreen` + `defender/*` (main monitor,
  12-tile monitor bank with AUTO priority paging, map + tool dock + node inspector, power / doors / containment /
  team log, alert ticker, keyboard shortcuts; read-only for spectators), `MonsterScreen` + `monster/*` (command deck,
  "through the lens", exposure / intent stream, emergence picker, targeting bar, trapped overlay; own scoped CSS
  `.mx`), `ResultsScreen` + `shell/results.tsx` (verdict, route replay on the viewer's own map theme, timeline, stats;
  plays `<BreachSequence>` / `<ContainmentSequence>`). `hud.tsx` holds the shared `TopBar` (non-wrapping; screen
  readouts compress before controls), clock, phase badge, `SpectatorBanner`, event log.
- `feeds/` — `CameraFeed.tsx` chooses HLS `<video>` (main monitor only; `useHls.ts`, lazy hls.js, start/stall
  timeouts) → refreshing snapshot (`SnapshotLayer.tsx`: one request in flight, one deadline over fetch/body/decode,
  pixel check for the unavailable card, cross-fade, bounded failures) → `<SimulatedFeed>`; local failures only demote.
  Always overlays `<FeedFxOverlay>`. The source badge reflects REAL availability only: LIVE / SNAPSHOT /
  SIMULATED (dashed amber, never styled like live) / OFFLINE; thumbnails show one compact badge (a live-capable camera
  shows `LIVE·SNAP`: a still in the tile, video on the main monitor; other stills `SNAP · 2m`).
- `map/` — `MapPanel.tsx` (mode toggle, remembered per tab) over two modes sharing the `MapLayers` props contract
  (`layers.ts`): `TacticalMap.tsx` (SVG over node `tactical` coords, pan/zoom, label declutter, threat heat, door
  heat/jam, breach + containment progress, sightings decay, attack paths in the monster theme) and `GeoMap.tsx`
  (MapLibre GL + OpenFreeMap vector tiles, code-split, created once per mount and `remove()`d on unmount; falls back
  gracefully when tiles are unreachable). `inset` keeps the default fit clear of a screen's overlays; `theme` picks the
  defender or monster palette (`theme.ts`).
- `fx/` — canvas feed effects through one shared rAF scheduler (offscreen surfaces skipped, sleeps when hidden):
  `overlay/` (noise, tears, interference, sabotage/repair, monster compositing into each camera's placement regions,
  status cards), `sim/` (procedural labelled SIMULATED scenes), `cinematic/` (breach, containment, signal lost),
  `core/settings.ts` (reduced motion: OS preference or the in-app toggle). Consumed through `fx/index.ts`.
- `audio/` — procedural Web Audio engine (no files required): ambience per screen, tension, sfx, stingers, master
  volume / mute, unlocked on first gesture (`hooks/useGameAudio.ts`). Consumed through `audio/index.ts`.

## Anti-cheat summary

Defender/spectator views never include: monster node/edge/path/stance/cooldowns/knowledge, `isDecoy`, monster
command events. The only position information is sightings (camera / sensor / scan / trap / breach) and the
`held` node while trapped. Monster views never include traps, undiscovered sensors, sightings, exact power, or
door states it has not observed within `doorObserveHops`. The baseline AI only reads `MonsterKnowledge`.
The post-match `MatchResult` reveals everything (timeline with `[DECOY]` annotations, monster path).
