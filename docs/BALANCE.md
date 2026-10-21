# Balance measurements

The authoritative values are in `shared/src/config.ts`. This experiment changes numbers and defender-count scaling only; it does not change engine rules, map data, camera availability, or the tactical brain. The eight-minute playable night still follows 20 seconds of preparation.

## Method

`server/src/balance/harness.ts` runs the production `TacticalBrain`, `createGame`, `step`, `applyAction`, and both visibility projections on the bundled network, without sockets, clocks, downloads, or camera services. Simulation uses the configured 100 ms tick. Bots request observations every 250 ms, rounded up to 300 ms at that tick rate. Actions still pass all engine validation, costs and cooldowns. Each match has independent seeded engine, defender and monster RNG streams. The public graph's immutable caches are reused; brains and bot memories are fresh per match.

The bot module imports only shared public types/rules. Defender policies accept `DefenderView`; monster command policies accept `MonsterView`. Authoritative state is used only for running the engine and recording measurements. Defenders cannot read movement edges, monster stance, struggle progress, undisclosed sightings or decoy truth. Monsters cannot read armed traps, undiscovered sensors, exact power or unobserved doors. A regression test changes hidden authoritative data and checks projection and bot decision equivalence.

`--matches` means **matches per HQ × defender-count cell**, not a total across all cells. `mixed` cycles equally through five monster command policies. Before: 400 games per cell, seed family 1, 6,400 total. Final: 400 games per cell per seed family 1, 17 and 91, 19,200 total; every HQ/count cell therefore has 1,200 games, including 240 per monster policy. Each family derives distinct match seeds from its family and trial index. HQs/counts share trial seeds to aid comparisons; aggregate confidence intervals should be treated descriptively because those groups are correlated. Per-cell JSON reports include Wilson 95% intervals.

The original defaults and scaling are frozen under `server/src/balance/before.*`; `--preset before` reproduces the baseline with the same policies. Trial configurations were tested on families 17 and 91 before the final three-family runs. Bot rules were held fixed during numeric tuning.

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

<!-- MEASURED_RESULTS -->

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
node --import tsx server/src/balance/aggregate.ts --out /tmp/fnab-balance-after.json /tmp/fnab-balance-after-1.json /tmp/fnab-balance-after-17.json /tmp/fnab-balance-after-91.json
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

<!-- VERIFICATION_RESULTS -->
