# Project status

Snapshot of what is built, how each claim is verified, and what is known to be incomplete. Written 2026-10-20 against the current working tree.

Legend: ✅ implemented and verified by an automated test or a command run for this document. ⚠️ implemented with a caveat, or only partly verified. "Unverified" means it could not be confirmed here and is not claimed.

**Fresh runs for this document:** `npx vitest run` gave 22 files / 208 tests passed. `E2E_WORKERS=3 npx playwright test` gave 21 passed (1.5 min) across 9 spec files. I did not run `npm run typecheck`, `npm run build` or a real-network camera session for this document.

## Milestones (spec section 17)

| Milestone | Status | Where verified |
| --- | --- | --- |
| A. Functional foundation: frontend + backend, rooms, defender and monster UIs, node graph, server-authoritative movement, win/lose | ✅ | Vitest (engine, rooms, full-match simulation); e2e `lobby`, `outcomes` |
| B. Real cameras: Caltrans adapter, discovery, curated set, snapshot/stream rendering, unavailable handling, geographic map | ⚠️ | Vitest `server/test/cameras.service.test.ts` and classifier tests; e2e `cameras`, `outage`. Real-network behaviour was measured by hand on 2026-10-20 and is recorded in `docs/CAMERAS.md` section 7.5 (not re-run here). Geographic map: manual only, no automated test. |
| C. Strategic gameplay: AI commands, pathfinding, doors/power, surveillance tools, sabotage, traps, repairs, balance config | ✅ / ⚠️ | Vitest (engine, AI, pathfinding); e2e `monster-ai`, `defense`. Balance is measured with bots only (see limitations). |
| D. Atmosphere: monster overlays, distortions, animations, sound, cinematics, visual design | ⚠️ | Vitest for audio graph plumbing and FX logic. Look, feel and loudness were checked by manual screenshots and a Chromium audio measurement (`client/src/audio/README.md`); no human listening/playtest is recorded. |
| E. QA: sync, reconnection, camera-failure recovery, responsive UI, balance testing, automated tests, deployment instructions | ⚠️ | e2e `reconnect`, `disconnect`, `outage`, `visibility`; `docs/BALANCE.md`; `docs/DEPLOYMENT.md`. Responsive UI checked by manual screenshots at 1280x720 to 2560x1440 only. Docker image never built. |

## Required scenarios (spec section 18)

| Scenario | Status | Verified by |
| --- | --- | --- |
| Two players join the same match from separate browsers | ✅ | e2e `lobby.spec.ts` (separate browser contexts, code and invite link) |
| One player is the monster | ✅ | e2e `lobby.spec.ts` (creator is host and the only monster) |
| Others join as defenders | ✅ | e2e `lobby.spec.ts` |
| Defenders select a headquarters | ✅ | e2e `lobby.spec.ts` |
| Monster issues a high-level command | ✅ | e2e `monster-ai.spec.ts` (stances, global gap, cooldowns, validation) |
| AI moves it through connected nodes | ✅ | e2e `monster-ai.spec.ts` (live and revealed route follow graph edges); Vitest pathfinding |
| Defenders see sightings, never the exact position | ✅ | e2e `visibility.spec.ts` (every socket frame inspected); Vitest visibility tests |
| Monster can sabotage a fictional camera | ✅ | e2e `defense.spec.ts` |
| Defenders can repair it | ✅ | e2e `defense.spec.ts` |
| Defenders can activate a trap | ✅ | e2e `defense.spec.ts` (trap, containment, 15 s capture) |
| Power consumption and cooldowns behave | ✅ | e2e `defense.spec.ts` (door drain, scan/lure cooldowns, outage and recovery); Vitest engine |
| Both sides can win | ✅ | e2e `outcomes.spec.ts` (breach and timer), `defense.spec.ts` (capture), `disconnect.spec.ts` (forfeits) |
| All participants get synchronized results | ✅ | e2e `outcomes.spec.ts` (same result, winner and reason on every screen) |
| Game works if external cameras become unavailable | ✅ | e2e `outage.spec.ts` (probes to a closed port; match completes) |
| Complete match in simulation mode with no external access | ✅ | e2e `cameras.spec.ts` (`CAMERA_MODE=simulation`, `*.dot.ca.gov` blocked, no requests) |
| Automated tests for state transitions, visibility, pathfinding, victory | ✅ | 208 Vitest tests plus 21 e2e tests |

## Known limitations and incomplete items

**Balance and gameplay**
- Balance was measured with scripted bots (32,000 games), not human players. Overall monster wins are 50.8% and the HQ and defender-count bands are met, but not every one of the 16 HQ x defender-count cells: the joint cells range from about 42% to 59% (`docs/BALANCE.md`). The families used for the final correction are not an untouched holdout.
- Capture success per containment engagement is about 12% (11.6%) after the struggle fix. Early traps usually buy time rather than end the night.
- Bot skill matters a lot: against expert defenders the monster wins about 10%, against novices about 83% (mixed policies). Whether human strategies are equally strong is unknown; no human playtest data exists.
- Parity is claimed only for 1 to 4 defenders and 8-minute nights with a 20 s preparation.
- Human feel (pacing, fairness, readability of the monster UI) has not been reviewed by playtesters.

**Cameras**
- HLS live availability is partial and flaps. At the last documented check, 14 of 36 curated cameras had playable streams (19 list one); one run saw 15 and some streams moved between 200 and 404. Expect SNAPSHOT for the rest.
- After a server start, all cameras begin SIMULATED until their first probe completes. `docs/CAMERAS.md` measured about 25 s for full classification; slow or failing networks can leave some cameras SIMULATED for up to a couple of minutes (dead streams answer after the 8 s timeout and retry at 60 s, 120 s, ...).
- Caltrans images may carry third-party copyright; none are committed. The game depends on the Caltrans CORS and hotlink behaviour observed on 2026-10-20, which can change.

**Platform and deployment**
- Room and match state is in memory: single instance only, and a server restart (including `tsx watch` reloads in dev) ends all active matches.
- The Docker image has not been built locally or in CI (`docs/DEPLOYMENT.md` section 6). Render and Fly configs are written but not deployed or tested. A CI workflow exists in `.github/workflows/ci.yml`; its run history is unverified.
- No `LICENSE` file is in the repository yet.
- Rate limits and hardening were tested with unit and e2e tests, not under real internet load.

**Client**
- Headless, software-rendered Chromium can freeze when opening the geographic map while live video plays. Not reproduced on a GPU browser here; unverified for real users. The geographic map has no automated test.
- Reported but not confirmed by me: monster route lists show the spawn node twice. Not investigated for this document, so treat as unverified.
- Audio was tuned by measurement in Chromium and by ear on one machine only. File-based audio overrides are supported, but the shipped build uses synthesis only.
- Browsers and devices tested: Chromium only (Playwright and screenshots). Firefox, Safari and touch/mobile layouts are unverified.

**Test infrastructure**
- During the e2e run the Vite dev proxy printed repeated `ws proxy socket error: write EPIPE` lines when contexts closed. All 21 tests still passed; this looks like teardown noise but is unexplained.
- `docs/BALANCE.md` cites "21 files, 204 tests"; the current count is 22 files, 208 tests. The balance numbers themselves were not re-run for this document.

## Where to look

- Rules and numbers: `docs/MECHANICS.md`. Balance evidence: `docs/BALANCE.md` and `server/src/balance/results.json`.
- Camera research and measured behaviour: `docs/CAMERAS.md`.
- Test inventory: `e2e/README.md`.
