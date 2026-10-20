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
- `ai/` — `MonsterBrain.decide(BrainInput, rng) → MonsterIntent` (`types.ts`), `buildMonsterKnowledge`
  (`knowledge.ts`, the *only* bridge from state to the monster side), `BaselineBrain` (`baselineBrain.ts`).
  The engine calls the brain on every node arrival, on stance changes and every `replanMs` while idle.
  The intent is validated (adjacent edges only) before use.
- `visibility/` — `projectDefenderView`, `projectSpectatorView`, `projectMonsterView`. Fields are copied
  explicitly; tests assert no forbidden keys leak.
- `rooms/RoomManager.ts` — transport-agnostic lobby/match lifecycle with an injectable clock (unit-tested):
  4-letter codes, roles, HQ choice, ready → 5 s countdown → match, reconnection by token within a 60 s grace
  period, host migration, forfeits, restart to lobby, empty-room cleanup. `tick(now)` advances matches in
  fixed steps with bounded catch-up.
- `net/` — Socket.IO wiring (`socket.ts`) and zod schemas for every client payload (`schemas.ts`).
  Views are emitted per player socket (never broadcast) every tick, plus immediately after an accepted action.
- `cameras/` — `CameraService` interface (implementations must only expose a `streamUrl` when it is playable — `usableStreamUrl` in shared checks the curation flag `verified.streamPlayable`) (`getStatuses`, `subscribe`, `start/stop`) and the default
  `SimulationCameraService`. `CAMERA_MODE` selects the implementation (`createCameraService`). Statuses are
  public and sent to everyone on join and on change (`cameras:status`).
- `index.ts` — Express (`/api/health`, `/api/cameras`, static `client/dist` in production) + Socket.IO.

## client/

Dev server: http://localhost:5175 (`--strictPort`; 5173 is used by another local project). Proxies `/api` + `/socket.io` to 3001.


- `net/socket.ts` — socket singleton, sessionStorage session `{code, token}` (per tab), auto-resume on
  reconnect, clock sync, `sendAction`, `lobby.*` helpers. Errors surface as toasts.
- `state/store.ts` — zustand store (`room`, `view`, `result`, `cameraStatuses`, clock offset, UI state) and
  `serverNow()` / `matchNow(view)`. In dev (or with `?e2e`) it is exposed as `window.__fnab` for scripted tests.
- `screens/` — Title, Lobby, Loading (countdown), DefenderScreen (also used read-only for spectators),
  MonsterScreen, ResultsScreen (plays `<BreachSequence>` on a breach). `hud.tsx` has the shared top bar,
  clock and event log.
- `feeds/CameraFeed.tsx` — picks HLS video / refreshing snapshot `<img>` / `<SimulatedFeed>` from the camera
  service status, always overlays `<FeedFxOverlay>`, draws OSD + source badge + game-status label.
- `map/TacticalMap.tsx` — SVG map over node `tactical` coords; props are the `MapLayers` contract.
  `map/MapPanel.tsx` holds `MAP_MODES`; a MapLibre `GeoMap` taking the same props can be appended there and a
  mode toggle appears automatically.
- `hooks/useGameAudio.ts` — unlocks audio on first gesture, ambience per screen, sfx per new event, tension
  from threat, stingers on result. `ui/` — design-token components (tokens in `src/index.css` `@theme`).
- `fx/` (FX agent) and `audio/` (audio agent) are consumed only through their `index.ts` exports.

## Anti-cheat summary

Defender/spectator views never include: monster node/edge/path/stance/cooldowns/knowledge, `isDecoy`, monster
command events. The only position information is sightings (camera / sensor / scan / trap / breach) and the
`held` node while trapped. Monster views never include traps, undiscovered sensors, sightings, exact power, or
door states it has not observed within `doorObserveHops`. The baseline AI only reads `MonsterKnowledge`.
The post-match `MatchResult` reveals everything (timeline with `[DECOY]` annotations, monster path).
