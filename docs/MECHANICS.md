# Game mechanics (as implemented)

All numbers below are defaults from `shared/src/config.ts` (`DEFAULT_CONFIG`), scaled by
`scaleForDefenders(n)` at match start. Change them there, not in engine code.

## Match flow

| Stage | Details |
| --- | --- |
| Lobby | Room creator starts as monster + host. Exactly one monster, ≥1 defender, all non-spectators ready & connected → 5 s countdown (any change cancels it). Host sets night length 5–10 min (default 8). Defenders (or host) pick the HQ. |
| Preparation (20 s) | Monster is not on the map; it picks a spawn and an opening stance. Spawn options depend on the chosen HQ: any node 5–6 hops from the HQ's nearest approach node (`cfg.spawn`, fallback = farthest nodes; random if none picked), so every HQ is equally far. (`network.json` `spawnNodes` are all North Bay and would make Stanford/San Jose much safer.) Defenders may place sensors and traps (traps arm instantly in prep). Doors/scan/lure/repair are locked. No power drain. |
| Infiltration | first 40 % of the night. Breach takes 1.8× longer. HUNT and FLANK only probe (no auto-breach). |
| Escalation | next 35 %. Monster 10 % faster; breach 1.2×. |
| Final Assault | last 25 %. Monster 20 % faster, detection ×1.2, breach 1.0×. |
| End | Breach → monster wins. Timer expiry → defenders win. 15 s uninterrupted containment → defenders win (capture). A team leaving entirely → forfeit. All checks are server-side; every client receives the same `MatchResult` (stats, full timeline, monster route). Host can restart to lobby without reload. |

## Monster

Position is always a node or a point along one edge. Travel time for an edge:
`clamp(12 s + 0.6 s/km × lengthKm, 8 s, 40 s) × stance × phase` (the clamp keeps 60 km edges like I-680 from taking minutes).

| Command | Speed × | Detection × | Cooldown | Behaviour (BaselineBrain) |
| --- | --- | --- | --- | --- |
| HUNT | 1.0 | 1.0 | 0 | Heads for the best approach (time + mild exposure cost); detours to defender lures within 4 hops. Breaches in Escalation/Final. |
| HIDE | 1.6 | 0.3 | 15 s | Creeps one node at a time along the stealthiest route; holds if the next node is more exposed. Never breaches. Sighting confidence capped at 60 %. |
| FLANK | 1.1 | 0.75 | 15 s | Picks the least-defended approach (known sensors, observed closed doors, recent exposures/scans) and avoids exposure. Breaches after Infiltration. |
| ATTACK | 0.8 | 1.5 | 20 s | Fastest route to the chosen (or weakest) door and breaches it. |
| RETREAT | 0.75 | 1.1 | 30 s | Falls back to a node far from HQ within 3 hops. **While trapped: struggles** (see containment). |
| SABOTAGE | – | – | 30 s | Disable the camera (45 s, or until repaired) or a *known* sensor (30 s) at a node ≤1 hop away. Defenders see "feed tampered" — a sabotage is itself a clue. |
| DECOY | – | – | 25 s | A false camera sighting + monster manifestation on a working camera ≤3 hops away, plus a follow-up 3–6 s later. Indistinguishable from real ones unless a scan covers it. |

Re-issuing the current stance (e.g. to change door target) is free; any two commands need ≥1.5 s between them.
The AI occasionally (12 % × phase aggression 0.6/1.0/1.4) takes the second-best approach to stay unpredictable.

What the monster knows: the graph, the target HQ and its approaches, every camera's *game* status, sensors it
has discovered (standing on/next to them when they ping, or on their node), door states seen within 1 hop of
the approach node, lure "disturbances", scan pulses within radius+1 of it, places where it may have been seen
(70 % of sightings notify it), and a coarse power level (high/medium/low/out). It never sees traps.

## Detection & sightings

Every 1 s (and 0.2 s after arriving at a node) the camera at the monster's node (nearer endpoint while moving)
rolls if it is working and power is on:
`chance = 0.08 × stance × phase × proximity[hops to HQ] (× 0.35 while moving) + 0.15 × stance on arrival`,
proximity = 2.2 / 1.8 / 1.4 / 1.1 / 1.0 for 0 / 1 / 2 / 3 / ≥4 hops. Capped at 95 %.
A hit creates a sighting (node, time, confidence 45–95 %) and a manifestation on that camera only:
kind by hops to HQ — 0 closeup, 1 figure, 2 silhouette, ≥3 shadow (low confidence never better than
silhouette), strength rising toward HQ, region index into the camera's `placement`, 2.5–5 s long.
Sightings stay on the defender map for 60 s; "last known" = newest non-false, non-sensor sighting.
Threat (defender HUD) = max(phase floor, 1 − hops/6), ×0.75 under HIDE, quantised to 5 steps; 1.0 during a breach.

Random fictional camera failures: ~1.2 per minute network-wide, 6–14 s of "interference" (repairable).
These are game status only; the real source state comes from the `CameraService`.

## Defenders (shared power pool)

| System | Cost | Rules |
| --- | --- | --- |
| Power | max 100 (+20 per extra defender, up to +80), regen +0.15/s | ≤0 → **outage** 12 s: all cameras black, doors forced open, sensors dead, repairs cancelled, containment collapses, no actions. Then restores to 15. Low-power warning at 25. |
| Doors (3 per HQ) | 0.8/s while sealed | A sealed door stalls a breach (progress decays 8 %/s). Heat +1/25 per s sealed, +1/20 extra while battered; at 100 % it jams **open** for 12 s (heat → 40 %). Cools 1/20 per s when open. No permanent lockdown. |
| Motion sensors | 5 to place, 0.03/s upkeep, max 4 (+1/extra defender) | Pings when the monster arrives at the sensor's node or a neighbour (vague: reports the sensor's node; 50 % under HIDE; 6 s cooldown per sensor). A ping may reveal the sensor to the monster (50 %, always when it is on that node). |
| Scan | 12, 20 s team cooldown | Radius 1 hop around a node. Reveals the monster exactly (even hidden) if inside; otherwise "no contact". Flags decoy sightings in the area from the last 40 s as FALSE. The monster feels pulses within radius+1. |
| Traps | 10, max 3 (+1 per 2 extra defenders) | Invisible to the monster. Go live 3 s after arming. Spring when the monster arrives on the node (or is idle there when it goes live): immobilised 8 s, breach cancelled, location revealed. After release the monster is trap-immune for 6 s. |
| Containment | 5 to engage, 2.5/s | Only while the monster is held. Holds it indefinitely; 15 s uninterrupted = capture. Interrupted by disengaging, power outage, or the monster breaking free. |
| Repair | 8, 10 s, max 2 concurrent | Restores a sabotaged/interference camera. |
| Lure (alarm) | 6, 25 s cooldown, lasts 25 s, max 2 | The monster player sees a "disturbance"; a HUNTing AI detours to it — bait it into a trap. |

### Struggle vs containment

RETREAT while held starts struggling: break-free progress fills over 11 s (÷ up to 1.3 with more defenders),
at 0.7× speed while containment is engaged. Roughly: if containment starts within ~1 s of the trap and the
monster struggles immediately it is a coin flip; react faster or make the monster waste RETREAT (30 s cooldown)
and the defenders win; react slowly and it escapes. A trap alone never wins.

## Breach

Monster idle on an approach's `fromNode` with breach intent (ATTACK always; HUNT/FLANK after Infiltration):
progress fills over 5 s × phase multiplier while the door is open/jammed. Defenders get an alert and the
monster's node (breach sighting). Sealing the door stalls and decays progress and batters the door hotter.

## Difficulty scaling (`scaleForDefenders`)

Per extra defender (capped at 5 extra): monster up to ~29 % faster, base detection −10 % each, struggle
faster, breach slightly faster; defenders get more power and devices (see table).
