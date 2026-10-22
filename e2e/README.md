# End-to-end tests (Playwright)

Real browsers, real server, real Socket.IO. Every player is its own browser **context** (own `sessionStorage`, own
socket), so two contexts are two different people. Rooms are unique per test, so specs run in parallel.

```bash
npx playwright test                     # whole suite (starts and stops its own servers)
npx playwright test e2e/defense.spec.ts # one file
E2E_WORKERS=2 npx playwright test       # fewer parallel workers on a small machine (default 4)
npx playwright show-trace test-results/<failed-test>/trace.zip
```

Ports are reserved for e2e (docs/CONTRACT.md): server 3101 / client 5199 for the main stack, and 3102 / 5198 for the
camera-outage stack. Playwright starts them fresh (`reuseExistingServer: false`) and tears them down; stop anything
else on those ports first. Typecheck the specs with `npx tsc -p e2e/tsconfig.json`.

The e2e client servers use `e2e/vite.e2e.config.ts` (the app's config plus a private dependency cache per server, in
`node_modules/.vite-e2e-*`), so the two Vite servers never reload each other's pages. Browser contexts run with
`reducedMotion: 'reduce'` to keep the canvas FX from saturating the CPU with several tabs per test.

## What is covered (spec §18)

| Spec | Scenarios |
| --- | --- |
| `lobby.spec.ts` | players join by code and by invite link; creator is host and the only monster; others are defenders; a spectator joins; a defender picks the HQ and everyone sees it; ready states; every client sees the same countdown end; one shared match clock; unknown room code; late joiner spectates read-only and cannot act |
| `solo.spec.ts` | title → Play solo → role/difficulty → lobby/HQ/ready with a single human; defender observes AI monster sightings and the revealed graph walk; monster manages AI defender difficulty/add/remove, plays against their actions and sees their names in results |
| `monster-ai.spec.ts` | monster picks a spawn and opening stance in the UI; the AI walks it along real graph edges (checked live and against the revealed route); commands, the global command gap, per-command cooldowns, team gating and validation |
| `defense.spec.ts` | SABOTAGE a camera, the defender sees "feed tampered", repairs it (status transitions, power spent, repair crew limits), ability cooldown; trap springs, containment, 15 s capture win (all participants); trap alone does not win; interrupting containment frees the monster; door power drain; scan/lure cooldowns and rejection while cooling; full power outage and recovery |
| `visibility.spec.ts` | captures every Socket.IO frame each context receives. Defenders/spectators never get the monster's position, stance, cooldowns, spawn, knowledge, decoy flags or monster-only events; the monster never gets traps, sensors it has not discovered, sightings, exact power or defender-only events. The post-match result then reveals the route and `[DECOY]` flags identically to everyone |
| `outcomes.spec.ts` | monster wins by breach; defenders win by the survival timer (phases advance); same result, winner and reason on every participant's screen |
| `reconnect.spec.ts` | reload a defender and the monster mid-match and resume the same seat/state; dropped socket shows the banner and resumes by itself; host restarts to the lobby without a page reload and a second match starts |
| `disconnect.spec.ts` | monster disconnects: defenders and spectators are notified, the match pauses, defenders win by forfeit after the grace period; reconnecting inside the grace resumes; all defenders disconnect: monster wins by forfeit |
| `cameras.spec.ts` | full match with `CAMERA_MODE=simulation` and `*.dot.ca.gov` blocked: no request goes out, every feed is badged SIMULATED, nothing says LIVE |
| `outage.spec.ts` | second server with `CAMERA_MODE=auto` and `CAMERA_PROBE_ORIGIN` pointing at a closed port: probes fail, breakers open, every camera degrades to SIMULATED with a reason, and the match (sabotage, repair, result) still completes |

UI is driven where it is reliable (create/join, roles, HQ, ready, spawn, stances, sabotage targeting, trap tool, repair,
doors, containment, restart). Precise or time-critical actions go through the app's own socket module
(`import('/src/net/socket.ts')` in the page, the same code path the UI uses). State is read from `window.__fnab`
(the store; enabled by the `?e2e` query flag). Balance numbers always come from `shared/src/config.ts`.

Solo spec selectors: `#name`; `data-testid="title-screen"`, `play-solo`, `solo-setup`,
`solo-role-defender`, `solo-role-monster`, `solo-difficulty-competent`, `solo-difficulty-novice`,
`solo-teammates-0`, `solo-start`, `lobby-screen`, `ai-tag`, `hq-hq-sf`, `ready`, `defender-screen`,
`monster-screen`, `ai-difficulty-${playerId}-expert`, `ai-add-defender`, `ai-remove-${playerId}`,
`spawn-${spawnOptions[0]}`, `cmd-ATTACK`, `results-screen`, `result-players`. IDs in the two AI management
selectors come from `RoomView.players`, and the spawn ID comes from the monster's own projection.
`test:fastForward` exercises AI controllers through `RoomManager.stepMatch()` as well as engine movement.

## Test-only server hooks, and why they cannot reach production

Real matches take 5 to 10 minutes, so the e2e servers start with `FNAB_TEST_HOOKS=1`:

* `test:fastForward {token, ms}` socket event: steps the caller's running match forward by `ms` of match time through the
  normal engine `step()` (same code path as real time; the regular tick then publishes views and results).
* `FNAB_TEST_RECONNECT_GRACE_MS`: shortens the reconnection grace so a forfeit can be seen in seconds.
* `FNAB_RATE_LIMIT_MULTIPLIER` (in `server/src/net/limits.ts`): every e2e socket shares 127.0.0.1, so the per-IP budgets are raised.

* `test:hold {token, hold}` socket event: freezes (or releases) the room's match clock. `startMatch` freezes it, so
  preparation, trap holds and cooldowns advance only through `fastForward`: no test depends on how fast the machine is
  (the cause of the CI failures on slow runners, where the 20 s preparation phase expired before the helper chose a spawn).
  Implemented by wrapping `RoomManager.tick` so a held match sees no elapsed wall time (`FNAB_TEST_HOOKS=1` only).

The e2e Vite config explicitly sets `VITE_FNAB_TEST_HOOKS=1`. In that test build, `?e2e` enables **render-lite**
(`client/src/fx/core/settings.ts`): FX canvases repaint at up to 4 fps, reducing CPU cost on software-rendered runners
while continuing to display gameplay changes. DOM state, labels and badges are unchanged; `?e2e&fx=full` restores the
full animation rate. Normal builds ignore the URL flag for render-lite.

Slow-runner rehearsal: `CI=1 E2E_THROTTLE=4 E2E_WORKERS=2 npx playwright test` throttles every page's CPU 4x through CDP
(`Emulation.setCPUThrottlingRate`) and scales the wait timeouts.

Guards (`server/src/net/testHooks.ts`, unit-tested in `server/test/testHooks.test.ts`):

* everything is **off unless `FNAB_TEST_HOOKS` is set**; the socket handlers are not even registered otherwise;
* if `FNAB_TEST_HOOKS` is set while `NODE_ENV=production` (`npm start` sets it), `testHooksEnabled()` throws during startup
  and the server refuses to boot. The other two variables are ignored unless hooks are enabled;
* the hooks need a valid player token for a running match, so they cannot touch other rooms.

Playwright's `webServer` config is the only place that sets these variables.
