# Server hardening and balance measurements

Production values are in `shared/src/config.ts`. This wave fixes the transport/visibility/lifecycle findings and measures the resulting engine with responsive movement. The eight-minute playable night, 20 s preparation, 8 s bare trap hold, 15 s capture, 10 s repair and 15–60 s ability cooldowns retain their defaults. `MECHANICS.md` describes the rules and additive client fields.

## Method and sample sizes

The harness runs production `TacticalBrain`, engine actions/steps and role projections at a 100 ms simulation tick. Bots observe every 250 ms rounded to 300 ms, use separate seeded RNG streams and act only on projected public information. The graph caches are shared; each match has a fresh brain and bots. Competent/novice defender rules and the five monster policies were held fixed during numeric tuning. Expert validation later exposed an unrealistic reservation rule: the bot let a low-power breach finish instead of buying a bare trap hold. The final expert policy now spends that battery on the reported approach (reclaiming a remote trap slot if needed), preserving its reaction/cadence and all information restrictions. Both full expert experiments were rerun with that correction; competent parity measurements are unchanged. Both bots and humans use the same continuous, rate-independent struggle mechanic.

The slow comparison uses the previous 45–65 s edge/15 s trap tuning with the **hardened** engine: 400 games per HQ/count cell, family 1, 6,400 total. `--preset slow` freezes its numeric configuration and scaling. Every field of five baseline trials was replayed exactly with that preset. The earlier published 51.4% slow-tuning figure predates the visibility/command fixes; the matched-engine baseline is 52.9%. The original pre-balance `--preset before` remains available separately.

Final parity: five families (1, 17, 91, 1337, 65537), **400 games per HQ/count/family**, 32,000 total. Equal cycling through five policies yields **400 games per HQ × defender-count × monster-policy cell**, spread across all five families; each HQ/count has 2,000 games. Families 17 and 91 informed small pilots. The first full matrix exposed Oakland/solo misses; SF/Oakland were then remeasured in all five families after selecting 0.98/0.96 HQ breach multipliers. Stanford/San Jose cells were retained only after effective-configuration equality checks and deterministic replay; their effective settings did not change. The derived per-family inputs preserve original/corrected provenance. These families are not an untouched holdout after that correction. HQ/count comparisons share trial seeds, so aggregate intervals are descriptive rather than independent-population estimates. Wilson 95% intervals are in the JSON.

Expert/rusher and novice/adaptive checks each use 6,400 games (400 per HQ/count), matching the earlier validation scale. The corrected expert policy has a direct low-power-breach regression test. Extra same-policy-mixture skill comparisons each use 6,400 games; these provide 1,280 games per monster policy pooled across HQ/counts. HIDE and lockdown checks each use 800 games (50 per HQ/count); their invariants also have deterministic engine regressions.

Policy assumptions: novice defenders react after 3–6 s and act about every 2.4 s; competent after 1.2–3.6 s with 1.1 s cadence; experts after 0.35–1 s with 0.65 s cadence. Team attention scales by `1 + 0.22(count−1)`, affecting reaction, cadence and feed coverage. Non-watched camera notifications are noticed once with probabilities 18% / 65% / 95%; trap/breach/sensor alerts remain explicit. All teams share power and device limits. Rusher attacks directly; stalker hides first; flanker uses FLANK before committing; trickster uses sabotage/decoys; adaptive reacts to legitimate observations. HIDE alone never attacks. Bots receive no secret trap positions, decoy truth, hidden movement or exact opposing resources.

## Outcomes

Monster win rates, slow → final:

| HQ | 1 defender | 2 defenders | 3 defenders | 4 defenders |
| --- | ---: | ---: | ---: | ---: |
| Stanford | 56.8% → 50.0% | 55.5% → 52.9% | 52.5% → 58.8% | 52.8% → 56.1% |
| San Francisco | 51.2% → 51.8% | 52.0% → 55.2% | 51.5% → 47.6% | 50.2% → 45.1% |
| Oakland | 53.8% → 57.0% | 51.2% → 52.5% | 52.8% → 48.8% | 54.3% → 44.8% |
| San Jose | 53.8% → 42.0% | 54.8% → 49.2% | 51.0% → 50.5% | 51.7% → 50.0% |
| All HQs | 53.9% → 50.2% | 53.4% → 52.5% | 51.9% → 51.4% | 52.3% → 49.0% |

| HQ mean | Slow | Final |
| --- | ---: | ---: |
| Stanford | 54.4% | 54.4% |
| San Francisco | 51.2% | 49.9% |
| Oakland | 53.0% | 50.8% |
| San Jose | 52.8% | 47.9% |

Overall monster wins: **52.9% → 50.8%**. HQ 45–55% band: **met**. Defender-count band: **met**. All sixteen individual HQ/count bands: **not all met**; the full table exposes subgroup differences rather than hiding them in the overall mean. Every final HQ/count has 2,000 trials, with a Wilson interval near 50% of roughly ±2.2 percentage points.

All values below are monster win rates; stronger defender play should reduce them:

| Monster policy | Slow competent | Final competent | Final expert | Final novice |
| --- | ---: | ---: | ---: | ---: |
| rusher | 24.6% | 64.1% | 5.8% | 99.8% |
| stalker | 62.6% | 19.6% | 1.0% | 58.5% |
| flanker | 63.9% | 48.0% | 5.6% | 79.5% |
| trickster | 40.2% | 40.2% | 14.9% | 79.1% |
| adaptive | 73.0% | 81.9% | 23.8% | 98.4% |

| Pairing/adversary | Games | Monster wins | Defender wins |
| --- | ---: | ---: | ---: |
| Expert vs rusher | 6400 | 5.8% | 94.2% |
| Novice vs adaptive | 6400 | 98.8% | 1.2% |
| Expert vs equal policy mixture | 6400 | 10.2% | 89.8% |
| Novice vs equal policy mixture | 6400 | 83.1% | 16.9% |
| Lockdown vs rush | 800 | 100.0% | 0.0% |
| Competent vs pure HIDE | 800 | 0.0% | 100.0% |

The skill comparisons use the same five command policies for experts and novices, in addition to the original extreme pairings. No claim that human strategies are equally strong follows from mixture parity. The policy rows show which strategies need further human testing; HIDE and permanent lockdown are explicitly losing adversaries.

Every tested monster policy loses most games against the corrected expert response. Adaptive remains strongest
against competent defenders (81.9% monster wins); spending low-power reserves on bare trap holds counters it
(23.8% monster wins against experts). This is evidence of counterplay in the tested policies, rather than a
proof about every human strategy.

## Pacing and capture

| Metric | Slow (6,400) | Final (32,000) |
| --- | ---: | ---: |
| Monster wins | 52.9% | 50.8% |
| Breach / capture / timer counts | 3383 / 2987 / 30 | 16247 / 6096 / 9657 |
| Median match length, playable seconds | 292.1 | 427.7 |
| Successful breach p10 / median / p90, seconds | 251.7 / 333.8 / 431.2 | 325.7 / 417.3 / 460.7 |
| Median completed edges per match | 6.0 | 10.0 |
| Edge duration p10 / median / p90, seconds | 34.1 / 44.2 / 54.0 | 11.9 / 18.4 / 23.1 |
| Maximum edge duration, seconds | 104.0 | 40.0 |
| Real camera sightings ≥3 per match | 83.7% | 94.7% |
| Public camera sightings ≥3 (includes decoys) | 89.7% | 95.5% |
| Containment engagements | 5767 | 52329 |
| Capture success / containment engagements | 51.8% | 11.6% |
| Median trapped seconds per match | 17.1 | 28.7 |
| Reached escalation | 85.1% | 93.7% |
| Reached final assault | 24.5% | 76.0% |
| Monster breaches in last third | 56.6% | 90.6% |
| Triggered / armed traps | 28.0% | 48.4% |
| Any blackout | 1.7% | 67.4% |
| Mean closed-door uptime | 0.6% | 5.2% |
| Median sabotage → completed repair, seconds | 20.5 | 10.9 |
| Median distance traveled, km | 63.0 | 109.8 |
| Sightings/min infiltration / escalation / final | 3.1 / 3.5 / 3.5 | 3.9 / 7.2 / 9.0 |

Match length excludes preparation and includes breach, capture and timer outcomes. Edge counts record completed edge arrivals, including a turnback arrival; edge duration is the nominal full-edge duration at completion after stance retiming. Actual fractional distance is integrated separately, including unfinished/reversed travel. The movement cap is a per-edge traversal cap, not a limit on a player's repeated reversals. Real sightings count camera detections only; the public alternative includes decoys. Scan/sensor/trap/breach contacts are not counted as camera detections. Capture success is completed captures divided by accepted containment engagements, including failed fields; multiple attempts in one match count separately.

Phase reach means the simulation entered escalation/final assault. Last-third breaches mean ≥320 playable seconds, while final assault begins at 360 s. Camera-sighting rates include convincing decoys and divide by actual time alive in each phase. Power curves in the JSON are conditional on still-running games, with alive sample counts; ended games are not carried forward as fake samples. Repair latency counts completed repair work after camera sabotage; natural recovery and unresolved sabotage remain unrepaired.

## Final settings and rationale

| Setting | Slow | Final | Rationale |
| --- | ---: | ---: | ---: |
| Edge base / km term / cap | 45 s / 0.4 s/km / 65 s | 18 s / 0.2 s/km / 25 s | Responsive hops; HIDE ×1.6 makes the actual maximum 40 s. |
| Trap arming / cost | 15 s / 10 | 6 s / 8 | Allow useful responses and repeated corridor contests. |
| Base power by defender count (1–4) | 100 / 106 / 112 / 118 | 94 / 114 / 136 / 142 | Fund operator attention and the extra trap without linear surplus. |
| HQ reserve offsets | 0 everywhere | Stanford +24; SF −8; Oakland −8; San Jose 0 | Compensate for route topology with a public resource budget. |
| Power regeneration | 0.22/s | 0.24/s | Support repeated defense while reserves still decline in final assault. |
| Containment start / drain | 5 / 2.5 per second | 4 / 1.6 per second | Make multiple escape/capture races affordable. |
| Contained struggle phase multiplier | 1 / 1 / 1 | 1.4 / 1.1 / 0.8 | Early traps buy time; the field stabilizes through escalation and final assault. |
| Breach channel base | 5 s | 16 s; SF ×0.98, Oakland ×0.96 | Give defenders a response window, with small HQ channel adjustments for route topology. |
| Edge acceleration divisor per extra operator | 0.04 | 0.025 | More operators no longer require large movement acceleration. |
| Struggle acceleration coefficients | 0.06 / 0.03 | 0.04 / 0.02 | Keep capture timing fair under diminishing reaction delays. |
| Breach acceleration per extra operator | 0.05 | 0.03 | Reduce the speed advantage against larger teams. |

Power count bonuses are 0/20/42/48/62 for 0/1/2/3/≥4 extra operators. Sensor, trap and repair capacity scaling retains its earlier values. Detection cadence/probabilities, doors' drain/heat/jam rules, sensor range, scan cost/cooldown, repair time and ability cooldowns otherwise retain defaults. Real/decoy confidence and cadence now share generation rules; public IDs are opaque and same-time ordering is neutral. Those security fixes change observation sequences legitimately and are included in every new experiment.

Containment progresses only through elapsed ticks after one accepted RETREAT. Duplicates have no effect. The final phase multiplier gives an attentive defender a meaningful capture opportunity: at one defender, a field started 2 s after immediate struggle captures; waiting 5 s permits escape. Earlier fields are intentionally less stable, so trapping an alert monster usually buys time instead of ending the night early. Measured engagement conversion is reported explicitly, including those early failed races.

## Reproduce and evidence

Configurations, all report groups and source SHA-256 hashes persist in [results.json](../server/src/balance/results.json); complete raw matches are in the scratch files recorded there. Run from the repository root with installed dependencies, without downloads:

```sh
npm run balance -- --preset slow --matches 400 --hq all --defenders 1,2,3,4 --seed 1 --out /tmp/fnab-hardening-slow-baseline.json
for seed in 1 17 91 1337 65537; do
  npm run balance -- --matches 400 --hq all --defenders 1,2,3,4 --seed "$seed" --out "/tmp/fnab-hardened-final-$seed.json"
done
node --import tsx server/src/balance/aggregate.ts --out /tmp/fnab-hardened-final.json /tmp/fnab-hardened-final-1.json /tmp/fnab-hardened-final-17.json /tmp/fnab-hardened-final-91.json /tmp/fnab-hardened-final-1337.json /tmp/fnab-hardened-final-65537.json
npm run balance -- --matches 400 --hq all --defenders 1,2,3,4 --defender-skill expert --monster rusher --seed 17 --out /tmp/fnab-hardened-expert.json
npm run balance -- --matches 400 --hq all --defenders 1,2,3,4 --defender-skill novice --monster adaptive --seed 91 --out /tmp/fnab-hardened-novice.json
npm run balance -- --matches 400 --hq all --defenders 1,2,3,4 --defender-skill expert --monster mixed --seed 17 --out /tmp/fnab-hardened-expert-mixed.json
npm run balance -- --matches 400 --hq all --defenders 1,2,3,4 --defender-skill novice --monster mixed --seed 91 --out /tmp/fnab-hardened-novice-mixed.json
npm run balance -- --matches 50 --hq all --defenders 1,2,3,4 --defender-skill lockdown --monster rusher --seed 91 --out /tmp/fnab-hardened-lockdown.json
npm run balance -- --matches 50 --hq all --defenders 1,2,3,4 --monster hide --seed 91 --out /tmp/fnab-hardened-hide.json
npx vitest run
npm run typecheck -w @fnab/shared && npm run typecheck -w @fnab/server
```

Seed replay, hidden-information equivalence, outcome/pacing guards, skill ordering, HIDE/lockdown, quantiles and duplicate-trial rejection have harness tests. The 1–12 security/QA regressions live in `server/src/engine/hardening.test.ts`, `server/src/net/socket.test.ts`, `server/src/rooms/hardening.test.ts` and `server/test/cameras.service.test.ts`. `MECHANICS.md` specifies the new connection fields/events, bounded logs and guarded E2E rate-limit override. `client/` is outside this wave's ownership; its event consumers must treat IDs as opaque and its UI must display reconnection/forfeit state.

Completed measurements are detached into snapshots before subsequent simulations. The CLI rejects duplicate
trials, checks JSON round trips and writes reports atomically after verifying file contents. Trial seed
metadata has a multi-cell regression. Source hashes, raw-file hashes and verification results are recorded
in `results.json`.

Final verification: `npx vitest run` — **21 files, 204 tests passed**. Shared, server and client workspace
typechecks all passed. `git diff --check` passed. No client edits, package installation or server process
was needed for this wave; the concurrent E2E hooks were preserved.

## Limits

These are deterministic bot measurements, not a fitted model of human play. No camera-source outages, transport latency, UI friction, multi-person communication failures or optimal human spawn/command selection are simulated. The simulator measures connected play; reconnection and forfeits have separate deterministic lifecycle tests. All final settings are calibrated for one through four defenders and 480 s nights, with 20 s preparation. Larger teams and other supported durations have no parity claim. Longer late-game contests improve measured pacing, but their feel still needs human review. Policy win rates and low-confidence reports must remain visible when assessing whether a dominant human strategy exists.
