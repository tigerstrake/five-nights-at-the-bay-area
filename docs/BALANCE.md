# Balance measurements

The authoritative values are in `shared/src/config.ts`. This experiment changes numbers and defender-count scaling only; it does not change engine rules, map data, camera availability, or the tactical brain. The eight-minute playable night still follows 20 seconds of preparation.

## Method

`server/src/balance/harness.ts` runs the production `TacticalBrain`, `createGame`, `step`, `applyAction`, and both visibility projections on the bundled network, without sockets, clocks, downloads, or camera services. Simulation uses the configured 100 ms tick. Bots request observations every 250 ms, rounded up to 300 ms at that tick rate. Actions still pass all engine validation, costs and cooldowns. Each match has independent seeded engine, defender and monster RNG streams. The public graph's immutable caches are reused; brains and bot memories are fresh per match.

The bot module imports only shared public types/rules. Defender policies accept `DefenderView`; monster command policies accept `MonsterView`. Authoritative state is used only for running the engine and recording measurements. Defenders cannot read movement edges, monster stance, struggle progress, undisclosed sightings or decoy truth. Monsters cannot read armed traps, undiscovered sensors, exact power or unobserved doors. A regression test changes hidden authoritative data and checks projection and bot decision equivalence.

`--matches` means **matches per HQ × defender-count cell**, not a total across all cells. `mixed` cycles equally through five monster command policies. Before: 400 games per cell, seed family 1, 6,400 total. Final: 400 games per cell per seed family 1, 17, 91, 1337 and 65537, 32,000 total; every HQ/count cell therefore has 2,000 games, including 400 per monster policy. Each family derives distinct match seeds from its family and trial index. HQs/counts share trial seeds to aid comparisons; aggregate confidence intervals should be treated descriptively because those groups are correlated. Per-cell JSON reports include Wilson 95% intervals.

The original defaults and scaling are frozen under `server/src/balance/before.*`; `--preset before` reproduces the baseline with the same policies, verified by replaying all measurements of five baseline trials exactly. Trial configurations were tested on families 17 and 91 before the final runs. Families 1337 and 65537 were held out until tuning finished. Bot rules were held fixed during numeric tuning.

## Policies and attention

Defenders process map notifications and selected camera feeds, rather than tracking every feed simultaneously. One operator watches two chosen feeds (novice: one), with diminishing attention gains of `1 + 0.22 × (defenders − 1)`. Extra operators shorten reaction/action delays and cover more feeds; they share power, device limits and cooldowns. Camera notifications outside watched feeds are noticed once with probabilities 18% / 65% / 95%; sensors, trap and breach alerts remain explicit notifications. False sightings remain believable until a scan flags them. Memory expires and reports are acted on only after reaction delay.

| Defender | Reaction before attention scaling | Actions and priorities |
| --- | --- | --- |
| Novice | 3–6 s, plus action cadence | Random feed rotation every 10 s; one randomly placed sensor/trap; 2.4 s action cadence; wasteful scans, repairs and door toggles; slow containment. |
| Competent | 1.2–3.6 s, plus action cadence | Three approach sensors, two shuffled approach traps; six-second feed rotation; 1.1 s action cadence; reacts to pings/sightings/breaches, adds corridor traps, repairs nearby sabotage, closes the attacked door, reserves power for containment. |
| Expert | 0.35–1 s, plus action cadence | Three approach traps; three-second feed rotation; 0.65 s action cadence; predicts routes from public graph and vague sensor contacts, conserves capture power, combines traps/lures/scans and prioritizes containment over optional actions. |

Cadences have seeded jitter; reacting to an alert also requires an available action slot. The defender team has coordinated priorities and no simultaneous conflicting actions, which is more organized than many human teams.

| Monster | Command policy |
| --- | --- |
| Rusher | ATTACK immediately; no targeted abilities; slow 2–5 s struggle reaction. Represents an inexperienced, committed attacker. |
| Stalker | HIDE for the first 32%, HUNT until 72%, then ATTACK; sabotages reachable feeds. |
| Flanker | FLANK until 65%, then ATTACK; sabotages reachable feeds to create blind corridors. |
| Trickster | HUNT until 68%, then ATTACK; frequent legal SABOTAGE and DECOY, with 1–2.5 s struggle reaction. |
| Adaptive | Uses notified exposures to hide, observed sealed doors/trap encounters to flank, low/out power or final assault to attack; sabotages discovered sensors or working feeds and sends decoys. |

Non-rusher/non-trickster struggle reactions are 0.25–1.25 s before the monster action cadence. Released monsters recover briefly before resuming their policy. Ability targets use only the monster's projected camera/sensor information and legal graph range. Two additional adversarial policies, `lockdown` and `hide`, test closing every door and HIDE without ever attacking.

## Results

Monster win rates, before → final (defender capture/timer wins are the complement):

| HQ | 1 defender | 2 defenders | 3 defenders | 4 defenders |
| --- | ---: | ---: | ---: | ---: |
| Stanford | 77.3% → 50.5% | 80.5% → 52.7% | 82.5% → 48.3% | 83.3% → 51.9% |
| San Francisco | 71.0% → 53.0% | 75.5% → 53.1% | 79.3% → 49.1% | 76.8% → 52.4% |
| Oakland | 68.0% → 51.6% | 73.0% → 51.9% | 82.3% → 50.8% | 77.3% → 51.3% |
| San Jose | 68.5% → 52.0% | 71.3% → 54.5% | 74.5% → 49.2% | 76.0% → 51.2% |
| All HQs | 71.2% → 51.8% | 75.1% → 53.0% | 79.6% → 49.3% | 78.3% → 51.7% |

Overall monster wins: **76.0% → 51.4%**. Final defender-count means are all within 45–55%; all sixteen HQ/count means also fall in that band. HQ means are stanford: 50.8%, sf: 51.9%, oakland: 51.4%, sanjose: 51.7%, comfortably within ±10 percentage points of the overall mean. Each final HQ/count has 2,000 trials; a 95% per-cell interval near 50% has a roughly ±2.2 pp margin.

| Competent vs monster policy | Before monster wins | Final monster wins | Final N |
| --- | ---: | ---: | ---: |
| rusher | 27.7% | 23.6% | 6,400 |
| stalker | 86.8% | 59.0% | 6,400 |
| flanker | 90.4% | 62.4% | 6,400 |
| trickster | 77.3% | 38.8% | 6,400 |
| adaptive | 98.0% | 73.4% | 6,400 |

Equal-mixture parity does not mean every policy has a 50% win rate. Rush is counterable; adaptive play is materially stronger than the mixture.

| Metric | Before (6,400) | Final (32,000) |
| --- | ---: | ---: |
| Breach / capture / timer counts | 4867 / 1362 / 171 | 16462 / 15340 / 198 |
| Successful breach p10 / median / p90, s | 141.7 / 224.4 / 312.0 | 251.7 / 331.3 / 430.2 |
| Containment attempts | 6,563 | 28,696 |
| Successful captures / containment attempts | 20.8% | 53.5% |
| Median trapped time per match, s | 18.1 | 17.2 |
| Triggered / armed traps | 39.0% | 27.8% |
| Any blackout | 2.3% | 1.5% |
| Mean closed-door uptime | 1.5% | 0.6% |
| Sabotage → completed repair median, s | 10.9 | 20.5 |
| Median distance actually traveled, km | 94.3 | 63.7 |
| Sightings/min: infiltration / escalation / final | 3.4 / 2.9 / 4.7 | 3.2 / 3.6 / 3.5 |
| Ends before escalation | 37.8% | 15.1% |
| Monster wins in last third | 8.1% | 55.8% |

Median power (alive sample count), conditional on the match still running:

| Playable time | Before | Final |
| --- | ---: | ---: |
| 0 s | 95.0 (6,400) | 74.0 (32,000) |
| 120 s | 62.2 (5,139) | 64.6 (29,435) |
| 240 s | 26.7 (2,205) | 62.2 (22,702) |
| 360 s | 18.7 (291) | 44.1 (7,627) |
| 480 s | 14.3 (171) | 13.1 (198) |

**Remaining pacing gap:** 4,806 early captures and 20 early breaches (0.1% of all games). 23.8% of all games reach the actual final-assault phase. The last-third breach target is met; the stronger interpretation that almost every match should reach escalation/final assault is not. Capture remains a viable early victory under the current engine rules.

Additional final checks:

| Pairing / adversary | Games | Outcome |
| --- | ---: | --- |
| Expert vs novice-ish rusher | 6,400 | 100.0% defender wins |
| Novice vs adaptive monster | 6,400 | 100.0% monster wins |
| Close every door vs rush | 160 | 100.0% monster wins; blackouts in 100.0%, 840 door jams |
| Competent vs pure HIDE | 160 | 100.0% defender wins |

The skill checks each use 400 games per HQ/count cell. Adversarial HIDE/lockdown checks use ten games per cell because their invariants are also covered by deterministic engine tests. No permanent-lockdown exploit requiring an engine edit was found. The original multiplayer struggle numbers could make capture impossible against immediate struggle even with immediate containment; the numeric scaling change removes that cliff for one through four defenders.

Machine-readable summaries, configurations, input paths and source hashes are preserved in [`server/src/balance/results.json`](../server/src/balance/results.json). Full raw trials are in `/tmp/fnab-balance-*.json`; they can be regenerated with the commands below.

## Final numeric changes

| Setting | Before → final | Rationale |
| --- | --- | --- |
| `monster.baseEdgeMs` | 12,000 → 45,000 ms | Make the five-to-six-hop opening consume a meaningful part of the night. |
| `monster.msPerKm` | 600 → 400 ms/km | Reduce the spread caused by geographically long edges while increasing overall travel time. |
| `monster.maxEdgeMs` | 40,000 → 65,000 ms | Allow the slower opening to apply to long edges while retaining a finite travel cap. |
| `power.regenPerSec` | 0.15 → 0.22 | Support surveillance and one serious capture opportunity during the longer approach. |
| `traps.armDelayMs` | 3,000 → 15,000 ms | Reward anticipating a corridor; reduce emergency traps dropped onto a reported moving target. Preparation traps remain immediately live under the existing rule. |
| `containment.struggleBreakMs` | 11,000 → 12,300 ms | Give attentive solo defenders a realistic capture window while preserving RETREAT counterplay. |
| Movement scaling | divisor `1 + 0.08e` → `1 + 0.04e` | Additional human attention needs less travel acceleration once openings are longer (`e` capped at 5). |
| Power scaling | +20 → +6 per extra defender | Extra attention/devices should not also fund several free containment attempts (bonus capped at four extras). |
| Struggle scaling | divisor `1 + 0.06e` → `1 + 0.06 min(e,2) + 0.03 max(0,min(e,5)−2)` | Stronger struggle for the first extra operators, then diminishing gains matching attention; avoids the three-defender advantage and the four-defender capture cliff. |

For one through four defenders, max power is 100 / 106 / 112 / 118, base edge time is 45,000 / 43,269 / 41,667 / 40,179 ms, and struggle break time is 12,300 / 11,604 / 10,982 / 10,696 ms. The 480 s night, 20 s prep, 8 s trap hold, 15 s uninterrupted capture, 10 s repair, ability cooldowns, door heat/drain, detection and breach rules retain their defaults. A struggling monster held without containment still releases after eight seconds; the struggle number determines its progress once containment extends that hold.

## Metric definitions

Every scratch JSON includes per-match measurements and summaries by HQ, defender count, skill/policy pairing, HQ/count and HQ/count/policy. Breach percent is monster wins; capture and timer survival are separate defender outcomes. Breach times exclude preparation; quantiles use linear interpolation. Late means the last third (≥320 s), rather than the narrower final-assault phase (≥360 s).

Capture attempts count successful containment engagements, with completed captures recorded separately. Time trapped includes both the bare trap and extended containment. Trap hit rate is triggered/armed; unused traps count against it. Door uptime divides summed closed-door seconds by all three doors × playable match duration. Blackout frequency is the share of matches with any outage; total outages per match are also recorded.

Power is sampled every 30 seconds after preparation. Curves report the median **among matches still running**, plus the remaining sample count; winning matches are not carried forward as artificial power samples. Sabotage-to-repair latency measures camera sabotage → `repairDone`, including response, queue and ten-second work time. Natural recovery, canceled repairs and sabotage still unresolved at match end count as unrepaired, rather than disappearing from the denominator. Sensor sabotage is not repairable through the camera repair action and is excluded from this latency.

Sightings/minute divide camera-sighting notifications (including convincing decoys) by actual time spent in each phase, not scheduled phase length. Distance integrates actual fractional travel on each edge, including reversals and unfinished final edges; this is more accurate than the engine's completed-edge distance statistic, which is retained separately in raw stats. Measurement sampling is quantized to the engine tick.

## Limits and follow-up

Bots are not human playtest data. Reaction distributions, notification attention and shared priorities are assumptions, not fitted measurements of players. The expert and novice policies deliberately bracket competence; their extreme matchup results are not human population forecasts. Spawn choices are seeded random legal choices, not optimal human-selected spawns. Tactical movement is the production brain, but human command creativity, team communication failures, visual ambiguity, UI friction and connection latency are not simulated. Camera source outages are not included; fictional game failures and sabotage are.

This measures 480 s matches and one through four defenders. Five-to-ten-minute duration limits and larger groups remain supported, but were not calibrated here. Subgroup policy rates have smaller samples than pooled HQ/count rates. An equal mixture is an explicit test distribution; a lobby full of adaptive monster players will be harder than that mixture. The stronger command policies should be tested against human experts before claiming that no dominant human strategy exists.

Early captures remain possible anywhere on the map under the existing remote-trap/containment rules. Slower travel and fifteen-second arming greatly reduce early finishes but do not impose a phase gate on captures. Early-end and final-phase reach rates are reported explicitly rather than hiding this remaining pacing limitation. Further preventing early captures would trade away useful trap counterplay or require an engine rule change outside numeric tuning.

## Re-run

No installation or network access is required with the existing workspace dependencies. From the repository root:

```sh
npm run balance -- --matches 400 --hq all --defenders 1,2,3,4 --duration 480 --defender-skill competent --monster mixed --seed 1 --out /tmp/fnab-balance-after-1.json
npm run balance -- --matches 400 --hq all --defenders 1,2,3,4 --seed 17 --out /tmp/fnab-balance-after-17.json
npm run balance -- --matches 400 --hq all --defenders 1,2,3,4 --seed 91 --out /tmp/fnab-balance-after-91.json
npm run balance -- --matches 400 --hq all --defenders 1,2,3,4 --seed 1337 --out /tmp/fnab-balance-after-1337.json
npm run balance -- --matches 400 --hq all --defenders 1,2,3,4 --seed 65537 --out /tmp/fnab-balance-after-65537.json
node --import tsx server/src/balance/aggregate.ts --out /tmp/fnab-balance-after.json /tmp/fnab-balance-after-1.json /tmp/fnab-balance-after-17.json /tmp/fnab-balance-after-91.json /tmp/fnab-balance-after-1337.json /tmp/fnab-balance-after-65537.json
npm run balance -- --preset before --matches 400 --hq all --defenders 1,2,3,4 --seed 1 --out /tmp/fnab-balance-before.json
npm run balance -- --matches 400 --hq all --defenders 1,2,3,4 --defender-skill expert --monster rusher --seed 17 --out /tmp/fnab-balance-expert-final.json
npm run balance -- --matches 400 --hq all --defenders 1,2,3,4 --defender-skill novice --monster adaptive --seed 91 --out /tmp/fnab-balance-novice-final.json
npm run balance -- --matches 10 --hq all --defenders 1,2,3,4 --defender-skill lockdown --monster rusher --seed 91 --out /tmp/fnab-balance-lockdown.json
npm run balance -- --matches 10 --hq all --defenders 1,2,3,4 --monster hide --seed 91 --out /tmp/fnab-balance-hide.json
npx vitest run
npm run typecheck
```

Use `--config /tmp/candidate.json` for a complete alternative unscaled `BalanceConfig`; it is then scaled using the selected current/before preset. A compact row prints after each cell; raw JSON is written only to the requested `--out`. Aggregation rejects duplicate trials and different base configurations. The frozen before preset is for comparisons, never production gameplay.

## Verification and cross-boundary edits

The harness suite checks deterministic full matches, hidden-information equivalence, broad outcome/pacing guards, skill separation, HIDE/lockdown adversaries, quantiles, CLI validation and duplicate-seed rejection. Guards use wide bands, not 45–55% assertions on small samples.

The root `package.json` adds only the `balance` script. Existing engine and visibility tests now seal doors near arrival instead of assuming travel completes before door overheat. Four tactical AI test scenarios derive their scenario costs from config so that an asserted open-door detour or cautious route is actually preferable at the current travel speed. Production AI/engine/visibility files were not changed by this balance work. Other concurrent agents' changes to those files are independent.

Verification: `npx vitest run` — **17 files, 162 tests passed** (about 4.3 s). The first full `npm run typecheck` passed all workspaces. A final recheck after concurrent client edits still passed **shared and server**, but client failed at `client/src/screens/MonsterScreen.tsx:34`: `TS2304 Cannot find name 'useDisplayFont'`. That UI file is outside balance ownership and was left to its owner. No dependency installation, production engine edit, server process, commit, checkout, stash or reset was needed.
