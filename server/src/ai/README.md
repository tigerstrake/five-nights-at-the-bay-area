# Monster AI

`TacticalBrain` implements the existing `MonsterBrain.decide(input, rng)` interface. The room
factory and `defaultBrain()` create a fresh tactical brain per match. `BaselineBrain` remains
available, and the existing engine fixture deliberately keeps it for comparison/regression tests.

## Knowledge boundary

`knowledge.ts` is the sole authoritative-state adapter. The brain and pathfinder import no engine
state or visibility implementation. Their inputs are the public graph, public game camera statuses,
the monster's position/stance, player-selected approach, own cooldowns, public remaining time, coarse
power band, observed doors, discovered sensors, perceived disturbances/scan pulses, notified sightings,
recent route, and trap encounters the game explicitly announced to the monster.

Undiscovered sensors, armed traps, defender scan results, sightings not notified to the monster,
door heat, unseen door states, exact power, repair crews and defender UI selections are unavailable.
Camera `repairing` is the existing public game status, treated conservatively as exposure because
that feed may return. It does not reveal repair progress or completion times.

The old adapter queried `s.sensors` for a discovered sensor's live disabled state, making remote
changes an oracle. It now projects remembered `disabledUntil` observations, updated only on
discovery or the monster's own successful sabotage. The monster view uses that same snapshot,
including its remembered expiry. Remote removal does not erase a remembered sensor. All mutable
observation objects are copied, so a brain cannot mutate authoritative knowledge through aliases.
Trap history comes only from public `trapTriggered` notifications, expires with the configured
memory window, and contains no armed trap IDs or positions.

## Search and utility

`TacticalPlanner` runs A* with deterministic, nonnegative costs:

```
edgeTravelMs(edge, stance × phase)
  + exposureMs × (command caution × (working cameras + nearby cameras + known sensors)
                  + decaying notified danger + FLANK corridor penalties)
```

All utility weights live in `shared/src/config.ts` as `DEFAULT_TACTICAL_AI`, with optional
`cfg.monster.tactical` overrides. Existing simulation balance defaults are unchanged. Exposure
decreases as aggression/clock urgency rises for HUNT, FLANK and ATTACK; HIDE remains cautious and
RETREAT prioritizes recovery throughout the match. Sensor and danger penalties include neighbors;
scan danger covers the configured scan radius and a softer surrounding ring. Trap, scan and sighting
danger decays linearly across `monsterMemoryMs`. Disabled cameras remove direct camera exposure.

Immutable travel tables are cached by graph and travel configuration in a bounded weak cache. An
all-pairs travel-only table supplies a consistent, admissible heuristic. Geographic distance would
overestimate with clamped long edges. Risk maps and candidate routes are shared within one decision;
no dynamic defender observations survive in those caches. Disconnected goals return null before
search. Mid-edge plans compare continuing and reversing, including remaining travel and endpoint risk.

Approach utility adds discovered surveillance, fresh observed door states, an open-door credit, and
the maximum battering delay inferred from public door rules. The brain subtracts only its own
continuous battering time, never hidden door heat. Goal hysteresis limits reversals during frequent
replans. A player-selected approach is always honored. No decision changes the player's stance.

## Command state machines

| Command | States and transitions |
| --- | --- |
| HUNT | Stalk the vulnerable approach → investigate a competitive perceived disturbance → listen briefly on arrival → resume stalking. At an approach, wait during infiltration; commit/batter during escalation/final. A lure is investigated once per perceived signal, not classified as fake. |
| HIDE | Rank nearby hiding places → creep one edge → wait in cover. Seeded pauses last one replan interval. A notified threat interrupts waiting and causes relocation. Never supplies breach intent. |
| FLANK | Remember the opening obvious corridor → circle through a different corridor where feasible → stalk the least defended eligible approach → commit/batter after infiltration. Both the recent path and the obvious corridor are penalized, including nodes near discovered sensors. |
| ATTACK | Commit to the shortest credible approach → batter a known sealed door or switch if a known alternative is faster → breach. A selected door stays selected, including when sealed. No random pauses or approach changes during ATTACK. |
| RETREAT | While held, wait for the engine's struggle/release rules → escape away from HQ and remembered danger → recover at a safe remote node. Never supplies breach intent. RETREAT issued while trapped now also preserves that stance after release. |
| SABOTAGE / DECOY | These are targeted instant actions in the existing game, not movement stances. `planAbility(input, explicitOrder)` offers invalid/cooldown → position → ready states. It routes to a safe node within the configured range and returns the requested action only when eligible under known conditions. Unknown sensors/dead decoy feeds are rejected; uncertain camera repair/outage states are conservative. |

`planAbility` is a separate explicit-order API. The current engine/client continues using instant
validated `sabotage`/`decoy` actions: it does not queue an out-of-range ability, automatically follow
the positioning plan, fire unsolicited abilities, or replace a standing movement command. Consumers
that want positioning can follow the returned route and then submit its ready action through
`applyAction`. Unknown cooldowns conservatively return `cooldown`. The engine remains authoritative,
including whether a remembered sensor still exists. DECOY may fire while held if already in range,
as the current engine permits; immobilization never permits a positioning move.

Internal state holds only command/mode, current goal/approach, pause/battering timers, investigated
perceived signals, and the initial obvious route. It resets on graph/match-clock changes. The engine
already starts struggling when the human issues RETREAT while trapped; the brain does not invent
extra struggle actions or bypass cooldowns.

## Variation and feedback

Only the supplied seeded `rng` is used. A* never draws randomness during expansion. At a new command
or node arrival, comparable alternatives may be selected with the configured variation probability
(normally 10–20%, capped by utility quality). HIDE can also pause briefly. Mid-edge periodic replans
do not repeatedly reroll tactics. Identical input histories and RNG seeds produce identical intents.

Short explanations mention only public graph names and projected observations. Existing engine
`decide` turns changed `intent.reason` strings into monster-audience `command` events. The monster's
AI feedback panel already displays those events; defender projections omit them. No client changes
or new events are required.

## Verification

Run from the repository root:

```
npx vitest run
npm run typecheck
npx vitest run server/src/ai/__tests__/simulation.test.ts --reporter=verbose --silent=false
```

The AI suite covers exhaustive small-graph optimality for all stances, clamped travel heuristics,
disconnected goals, exposure/sensor/corridor costs, blind spots, memory decay, moving-edge reversals,
all command scenarios on the real network, phase gating, explicit ability positioning/cooldowns,
determinism, seeded variation frequency, knowledge equivalence under hidden full-state changes,
projection aliasing, production default wiring, feedback audience and trapped RETREAT recovery.

The benchmark warms immutable caches, then measures 5,000 mixed decisions with known sensors and
danger on the 36-node network. The initial full-suite run averaged **0.078 ms/decision**, with
**0.140 ms p95**, below the asserted **1 ms average** budget. Timing varies with concurrent work.

The headless comparison reuses `server/test/fixtures.ts`, running 20 seeds × four HQs per brain at
the unchanged one-defender defaults and eight-minute night. Both use the same human command policy
(HUNT, RETREAT when held, resume after recovery, ATTACK in final, in-range sabotage/decoys). The
defender uses only its projected view, places approach sensors/a trap, scans recent contacts, repairs,
arms traps on reported contacts, lures toward a trap, seals a breached door, and attempts containment
after a seed-dependent reaction delay. Scripts react once a second. All matches must terminate;
recorded moves must remain on real graph edges, allowing repeated nodes after mid-edge reversals.

| Brain | Matches | Monster wins | Median successful breach, after preparation |
| --- | ---: | ---: | ---: |
| Tactical | 80 | 80 (100%) | 211.1 s |
| Baseline | 80 | 79 (98.75%) | 230.1 s |

There were no captures in this batch and one baseline timer defense. This simple defender is weak;
these are reproducible regression/comparison numbers, not a claim about human-player balance. No
engine balance values were tuned for the result. The simulation test prints fresh metrics each run.
