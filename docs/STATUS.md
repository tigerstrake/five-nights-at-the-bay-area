# Project status

Updated 2026-10-21 after `a554abc..HEAD`. ✅ means implemented with automated coverage; ⚠️ means partial verification or a material caveat. Test names below identify coverage, not fresh Playwright results.

**Fresh verification:** `npx vitest run`: **368 tests / 34 files passed**; `npm run typecheck` and `npm run build`: passed (build warns about large chunks). **E2E inventory:** **24 tests / 10 spec files** under `e2e/*.spec.ts`, counted from source; not rerun here. Real-camera, visual and capacity evidence below comes from the recorded agent measurements, not a new network session.

## Milestones (spec section 17)

| Milestone | Status | Evidence |
| --- | --- | --- |
| A. Functional foundation: rooms, role UIs, graph, authoritative simulation, outcomes | ✅ | Engine/rooms/full-match Vitest; e2e `lobby`, `outcomes`. Solo entry, either human role, AI seats and three difficulties: `rooms/solo.test.ts`, e2e `solo`. |
| B. Real cameras and maps | ⚠️ | Adapter/classifier, freshness and stall-watchdog unit tests; e2e `cameras`, `outage`. Live-first selection, three live bank tiles, BUFFERING recovery and honest STILL timing measured in `CAMERAS.md` §7.7. Tactical transit map uses the Natural Earth shoreline (schematic tests); geographic map remains manually checked. |
| C. Strategic gameplay: AI, pathfinding, tools, doors/power, sabotage, balance | ✅ / ⚠️ | Engine/AI/pathfinding Vitest; e2e `monster-ai`, `defense`, `solo`. AI players use role-limited observations; balance evidence is bots only (`BALANCE.md`). |
| D. Atmosphere and onboarding | ⚠️ | Audio/FX/coaching unit tests; contextual first-match hints and big-moment banners. Monster grading, shadows, occlusion and motion tuned on real Caltrans stills/HLS; daytime compositing only partly verified. |
| E. QA, recovery, responsive UI, capacity and deployment | ⚠️ | Seat recovery, view-delta, transport and cleanup unit tests; e2e `reconnect`, `disconnect`, `visibility`. Tablet/phone panels stack and scroll; Chromium/manual checks only. Speed-independent e2e uses `test:hold`, render-lite and a recorded 4× CPU-throttled rehearsal. Capacity measured in-process; Docker unbuilt. |

## Required scenarios (spec section 18)

| Scenario | Status | Coverage |
| --- | --- | --- |
| Two players join from separate browsers | ✅ | e2e `lobby` (separate browser contexts, code and invite link) |
| One player is the monster; others defend | ✅ | e2e `lobby`; `solo` also covers human/AI seats |
| Defenders select HQ | ✅ | e2e `lobby`; `solo` covers host choice with AI defenders |
| Monster issues a high-level command | ✅ | e2e `monster-ai` (stances, command gap, cooldowns, validation) |
| AI follows connected nodes | ✅ | e2e `monster-ai`, `solo`; pathfinding unit tests |
| Defenders see sightings, never exact hidden position | ✅ | e2e `visibility` (socket frames); visibility and delta-transport unit tests |
| Monster sabotages a fictional camera; defenders repair it | ✅ | e2e `defense` |
| Defenders trap and contain the monster | ✅ | e2e `defense` (capture, expiry and interrupted containment) |
| Power and cooldowns behave | ✅ | e2e `defense`; engine unit tests |
| Both sides can win | ✅ | e2e `outcomes`, `defense`, `disconnect` (breach, dawn, capture, forfeits) |
| All participants get synchronized results | ✅ | e2e `outcomes` |
| External camera loss does not stop play | ✅ | e2e `outage`; watchdog unit tests cover stalled playback recovery |
| Full simulation match with Caltrans blocked | ✅ | e2e `cameras` |
| State transitions, visibility, pathfinding and victory have automated tests | ✅ | 368 passing Vitest tests; 24 Playwright tests defined |

Additional regression coverage: e2e `reconnect` covers reload/socket recovery, closed-tab seat reclaim (`room:recover`, never taking a live seat) and restart into a second match. Delta views preserve role projections, with full checkpoints on rebind/resync and every 30 seconds.

## Known limitations

**Cameras and rendering**

- Live availability is partial and flaps; published URLs or successful probes do not guarantee browser decoding. `d4-tv301` never decoded in the recorded browser check: its playlist advertises 320×240 while segments are 352×240. It falls back to a labelled still with backoff retries (`CAMERAS.md` §7.7).
- Stills update roughly every five minutes. Cameras start SIMULATED until probed, and upstream outages/CORS changes can delay or prevent real imagery. The watchdog recovers stalls but cannot make the upstream service reliable.
- The first closeup draw has a reported ~200 ms hitch. Daytime monster compositing is only partially verified; most real-footage tuning was at night.
- Geographic mode lacks automated visual coverage.

**Balance and playtesting**

- Balance was measured with scripted bots (32,000 games), not human players: 50.8% overall monster wins, but individual HQ × defender-count cells range roughly 42–59%. The final correction families were not an untouched holdout (`BALANCE.md`).
- Capture success per containment engagement is ~12% (11.6%); early traps usually buy time. Bot skill strongly affects outcomes (~10% monster wins against expert defenders, ~83% against novices).
- Parity is measured only for 1–4 defenders, eight-minute nights and 20-second preparation. Human pacing, fairness and strategy have no recorded playtest data.

**Platform and operations**

- One in-memory instance only; server restarts lose all rooms and matches. View deltas reduce traffic about 11×. The in-process harness supports planning for 50 concurrent 4–5-player matches on 1 vCPU / 512 MB (~13 kB/s per player); 100 matches is a planning ceiling. WebSocket framing/TLS/kernel costs and real cloud/internet load were not measured (`DEPLOYMENT.md` §6).
- The Docker image has not been built locally; Render/Fly configurations exist but have not been deployment-verified. CI run history is unverified.
- Browser verification is Chromium only: no Firefox/Safari verification or physical touch-device validation. Responsive tablet/phone layouts are implemented, but the dense consoles are best on a tablet/computer; phones offer spectator guidance.
- Audio checks were limited to Chromium measurement and listening on one machine. No repository `LICENSE` file has been added.

## Evidence

- Rules: `MECHANICS.md`; balance: `BALANCE.md`, `server/src/balance/results.json`.
- Cameras: `CAMERAS.md`; capacity/deployment: `DEPLOYMENT.md`, `server/src/perf/after.json`.
- E2E hooks, render-lite and throttled rehearsal instructions: `../e2e/README.md`.
