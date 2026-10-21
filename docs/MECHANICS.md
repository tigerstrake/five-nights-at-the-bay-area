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
| End | Breach → monster wins. Timer expiry → defenders win. 15 s uninterrupted containment → defenders win (capture). Explicitly leaving the final team slot forfeits immediately; connection loss gets 45 s to reconnect. The server produces one `MatchResult`, including `reasonText`, aggregate stats and a bounded recent timeline/route. Host can restart from results. |

When the monster disconnects, or all defenders disconnect, the simulation pauses while that team has allowance:
movement, breach, containment, power and the night clock hold. Each team has **75 s cumulative pause budget per
match** (`room.reconnectPauseBudgetMs`), consumed only while the whole team is absent. Reconnecting never refills
it; only starting a new match does. Simultaneous absences consume each missing team's own budget, with their
pause intervals overlapping. Once a team's budget is exhausted, its disconnection no longer pauses simulation
or blocks the connected opponent's actions. The normal **45 s per-disconnection reconnection deadline** still uses
wall time, even in accelerated tests, and is not extended by spending the pause budget. A returning member
resumes that team; expiry awards the other team a forfeit win. One missing defender
does not pause a team with another defender online. Spectators do not keep either playing team alive.
Repeated disconnect callbacks cannot extend grace. Pauses and discarded catch-up backlog shift `t0Epoch`
to remain aligned with authoritative `t`.

## Solo play

**Play solo** on the title screen opens a role/difficulty chooser and creates an ordinary room. A human
defender gets an AI monster and may add 0–2 AI teammates; a human monster gets one AI defender and can add
more in the lobby. A blank solo name defaults to Nightwatch. Pick an HQ, set the night length, and ready up
as usual. The host can pick HQ even when every defender is AI. Invite codes, spectators, results and restarts
work through the same room lifecycle as multiplayer.

AI players occupy real seats (up to the normal room capacity), display names such as `Unit-1 (AI)`, carry an
AI tag/difficulty, and count toward defender scaling. They are always connected and automatically ready,
including after a restart. Only the human host can add/remove AI or change an individual AI's difficulty in
the lobby. Changes cancel the countdown. Joining humans replace an AI defender before adding another seat;
in a full lobby they may replace an available AI monster instead. Selecting the monster role replaces its
AI occupant; changing to defender replaces one AI defender. Humans never replace another human. Running
matches keep their roster/roles fixed, so late arrivals spectate until the next lobby.

The seat controller reuses the balance harness policies in `server/src/players/policies.ts` (the original
`balance/bots.ts` exports remain compatible). It receives only its own role's projection and submits at most
one action per observation through `RoomManager.action()`, using the same role, phase, resource, cooldown
and target validation as humans. Each seat has its own seeded policy RNG, separate from simulation RNG.
Defenders observe every 300 ms, with a small initial stagger. Each AI seat represents one operator, with
the measured novice/competent/expert defender policy; collective harness attention is not multiplied a
second time by team size:

| Difficulty | Defender reaction | Defender action cadence | Adaptive monster decision interval |
| --- | --- | --- | --- |
| Novice | 3–6 s | about 2.4 s | 3–6 s |
| Competent | 1.2–3.6 s | about 1.1 s | 1.2–3.6 s |
| Expert | 0.35–1 s | about 0.65 s | 0.35–1 s |

Defender cadence varies by ±20%. Camera attention is limited: unwatched camera reports are noticed with
18% / 65% / 95% probability, once per report. Sensor/trap/breach alerts remain explicit and still require
reaction time. The monster uses the `adaptive` commander (stances, sabotage, decoys, escape), sampled at
the skill interval above; existing policy delays and the engine's command gap also apply. It drives the same
tactical movement brain as a human commander and never sees undiscovered defenses. Tunables for seat
observation/stagger/monster intervals live in `AI_PLAYER_CONFIG` in `shared/src/config.ts`; existing defender
policy tuning remains shared with the balance harness. These are skill policies, without a human win-rate claim.

AI has no socket or resumable token. Disconnect/leave callbacks cannot disconnect an AI, and AI never
causes a reconnect pause or forfeit. A connected AI teammate keeps its defender team online when a human
drops; a team consisting of an offline human still uses the normal reconnect rules. AI cannot become host
or keep an abandoned room alive: cleanup considers human connections, and a room with no human members
is deleted on the next housekeeping tick. The guarded E2E fast-forward runs the same AI decisions as live ticks.

New protocol payloads (zod validated and charged to the existing socket/IP token buckets):

```ts
'room:createSolo': { name: string; token?: string; role: 'defender' | 'monster';
  difficulty: 'novice' | 'competent' | 'expert'; teammates?: number }; // integer 0–2
'lobby:addAi': { role: 'defender' | 'monster'; difficulty: AiDifficulty };
'lobby:removeAi': { playerId: string };
'lobby:setAiDifficulty': { playerId: string; difficulty: AiDifficulty };
```

`room:createSolo` uses the usual `JoinResult` acknowledgement and join budget; the lobby events use
`ActionResult`. `LobbyPlayer.ai?: {difficulty: AiDifficulty}` is absent for humans. `MatchResult.players?`
contains the match-start roster (`id`, `name`, `role`, optional `ai`), retaining AI/human names for results and
timeline attribution even when a participant leaves. No AI configuration adds hidden information to views.

## Monster

Position is always a node or a point along one edge. Travel time for an edge:
`clamp(18 s + 0.2 s/km × lengthKm, 8 s, 25 s) × stance × phase`, before defender-count scaling.
The slowest supported stance multiplier is 1.6, so actual travel never exceeds 40 s. The measured median
across completed edges is reported in `BALANCE.md`.

| Command | Speed × | Detection × | Cooldown | Behaviour (BaselineBrain) |
| --- | --- | --- | --- | --- |
| HUNT | 1.0 | 1.0 | 0 | Heads for the best approach (time + mild exposure cost); detours to defender lures within 4 hops. Breaches in Escalation/Final. |
| HIDE | 1.6 | 0.3 | 15 s | Creeps one node at a time along the stealthiest route; holds if the next node is more exposed. Never breaches. Sighting confidence capped at 60 %. |
| FLANK | 1.1 | 0.75 | 15 s | Picks the least-defended approach (known sensors, observed closed doors, recent exposures/scans) and avoids exposure. Breaches after Infiltration. |
| ATTACK | 0.8 | 1.5 | 20 s | Fastest route to the chosen (or weakest) door and breaches it. |
| RETREAT | 0.75 | 1.1 | 30 s | Falls back to a node far from HQ within 2 hops. **While trapped: starts continuous struggle** (see containment). |
| SABOTAGE | – | – | 30 s | Disable the camera (45 s, or until repaired) or a *known* sensor (30 s) at a node ≤1 hop away. Defenders see "feed tampered" — a sabotage is itself a clue. |
| DECOY | – | – | 25 s | Queues a false sighting/manifestation on a working camera ≤3 hops away and another after 3–6 s. Both publish at camera-roll boundaries. |

Stances, spawn selection, SABOTAGE and DECOY share a 1.5 s command gap. Rejected actions do not spend it.
Retargeting the current stance does not restart its ability cooldown. Identical commands, including repeated
RETREAT while already struggling, do nothing and add no events, progress or cooldowns.
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
Real and decoy camera sightings use the same confidence distribution (45–95 %, or 45–60 % while HIDE),
text, severity and manifestation generation. Initial decoys and follow-ups wait for the same detection
cadence. Action acknowledgements never trigger view broadcasts. Live event/sighting/device identifiers
are opaque, stable numbers/strings derived from a secret per-match key; equal-time entries sort by opaque
ID, independently of creation order. Scan contacts, trap contacts and breach alerts remain explicit sources.
Visible windows sort before selection. Event and sighting windows and authoritative retention evict whole
equal-time batches, so contacts published together disappear together. Bounds remain strict; an oversized batch
is dropped entirely, and additional entries from that same timestamp cannot reappear as a retained suffix.
Cosmetic manifestation seeds are derived independently of raw simulation RNG outputs. Post-match decoy
labels attach to their originating event, so sighting expiry and simultaneous real contacts cannot corrupt them.
Client event consumers must deduplicate with an ID set, never `id > lastId` or `Math.max(id)`; in particular
the existing `client/src/hooks/useGameAudio.ts` counter assumption requires an integration-owner update.
Threat (defender HUD) = max(phase floor, 1 − hops/6), ×0.75 under HIDE, quantised to 5 steps; 1.0 during a breach.

Random fictional camera failures: ~1.2 per minute network-wide, 6–14 s of "interference" (repairable).
These are game status only; the real source state comes from the `CameraService`.

## Defenders (shared power pool)

| System | Cost | Rules |
| --- | --- | --- |
| Power | baseline max 94/114/136/142 for 1/2/3/4 defenders; regen +0.24/s | Add HQ reserves: Stanford +24, SF −8, Oakland −8, San Jose +0. ≤0 → **outage** 12 s: cameras black, doors forced open, sensors dead, repairs cancelled, containment collapses. Restores to 15. Low warning at 25. |
| Doors (3 per HQ) | 0.8/s while sealed | A sealed door stalls a breach (progress decays 8 %/s). Heat +1/25 per s sealed, +1/20 extra while battered; at 100 % it jams **open** for 12 s (heat → 40 %). Cools 1/20 per s when open. No permanent lockdown. |
| Motion sensors | 5 to place, 0.03/s upkeep, max 4 (+1/extra defender) | Pings when the monster arrives at the sensor's node or a neighbour (vague: reports the sensor's node with the same 50 % confidence in either case, `sensors.confidence`; 50 % detection chance under HIDE; 6 s cooldown per sensor). A ping may reveal the sensor to the monster (50 %, always when it is on that node). |
| Scan | 12, 20 s team cooldown | Radius 1 hop around a node. Reveals the monster exactly (even hidden) if inside; otherwise "no contact". Flags decoy sightings in the area from the last 40 s as FALSE. The monster feels pulses within radius+1. |
| Traps | 8, max 3 (+1 per 2 extra defenders) | Invisible to the monster. Go live after 6 s (immediately in prep). Arrival/idle contact holds for 8 s, cancels breach and reveals location. Release grants 6 s trap immunity. |
| Containment | 4 to engage, 1.6/s | Only while the monster is held. Extends the hold; 15 s uninterrupted = capture. Disengagement, outage or successful struggle interrupts it. |
| Repair | 8, 10 s, max 2 concurrent | Restores a sabotaged/interference camera. |
| Lure (alarm) | 6, 25 s cooldown, lasts 25 s, max 2 | The monster player sees a "disturbance"; a HUNTing AI detours to it — bait it into a trap. |

### Struggle vs containment

One accepted RETREAT while held toggles continuous struggle for that hold. No click adds progress:
`progress += dt / struggleBreakMs × containmentMultiplier`. Uncontained multiplier is 1. Contained multiplier
is `0.7 × phaseStruggleMult`, with phase values 1.4 / 1.1 / 0.8 for infiltration / escalation / final assault.
Unscaled `struggleBreakMs` is 12.3 s; scaling for more operators is described below. The RETREAT cooldown
still applies when starting a new struggle. A bare trap releases after 8 s and never captures.

The field grows more stable across phases. Early traps usually buy time against an alert monster; later
containment rewards a quick, funded response. For one defender in final assault, an immediate struggle
versus containment started after 2 s is captured; containment delayed 5 s loses the race. Spam and one
accepted RETREAT produce the same outcome. This preserves a 15 s capture channel while reducing early finishes.

## Breach

Monster idle on an approach's `fromNode` with breach intent (ATTACK always; HUNT/FLANK after Infiltration):
progress fills over 16 s × HQ multiplier × phase multiplier while the door is open/jammed.
HQ multipliers are 0.98 for San Francisco, 0.96 for Oakland and 1 otherwise; these compensate for approach
topology (before defender-count scaling). Defenders get an alert and the
monster's node (breach sighting). Sealing the door stalls and decays progress and batters the door hotter.
Door-jam events reach defenders always; the monster receives them only while observing that approach
within `visibility.doorObserveHops`. Remembering an old door observation does not grant a live remote feed.

## Difficulty scaling (`scaleForDefenders`)

For `e = count − 1`, capped where indicated: base/min edge time and km term divide by
`1 + 0.025 min(e,5)`; base camera detection divides by `1 + 0.1 min(e,5)`; struggle break time divides by
`1 + 0.04 min(e,2) + 0.02 max(0,min(e,5)−2)`; breach time divides by `1 + 0.03 min(e,5)`.
Power bonuses for 0/1/2/3/≥4 extra operators are 0/20/42/48/62. The third operator's extra trap gets a
funding allowance; later attention gains diminish. Sensor/trap/repair capacity retains its existing scaling.
One through four defenders are measured; larger teams are supported without a parity claim.

## Transport and client integration

Each socket has exactly one room/player binding. A live-match identity change is rejected before membership
mutation. Taking over the same token clears the old socket; every private emit checks both code and player ID.
All client handlers catch/log exceptions and return an error acknowledgement. Views push at most once per
transport tick per socket/player, including repeated resumes; lobby changes coalesce on that tick too.
Rooms retain at most 4,096 events, 256 sightings and 512 route entries, with aggregate stats retained separately.

`BalanceConfig.net` defines token buckets: socket burst/rate 40 / 12 per second, IP 160 / 48 per second,
IP join/create/resume 12 / 0.5 per second, failed room/session lookups 8 / 0.1 per second. IP buckets survive
socket reconnects; idle TTL is 600,000 ms and tracking caps at 10,000 IPs. Limits use wall time and default to the
socket peer address. `TRUST_PROXY` accepts a comma-separated explicit IP/CIDR allowlist (IPv4/IPv6, default:
trust none). Only trusted peers may supply `X-Forwarded-For`; the chain is walked right-to-left until the first
untrusted address. Direct/untrusted peers and malformed chains retain the socket address. See `docs/DEPLOYMENT.md`
for Render/Fly configuration. With `FNAB_TEST_HOOKS=1`, `FNAB_RATE_LIMIT_MULTIPLIER=100` multiplies burst/rate
budgets for rapid E2E actions (range 1–1,000). The multiplier is ignored without the explicit test guard.
Saved configs can override `net`; absent fields use defaults. Grace uses `room.reconnectGraceMs`;
an absent `room.reconnectPauseBudgetMs` uses the default 75 s budget.

Client automatic resume preserves saved credentials and game state on temporary failures, including rate-limit
and internal-server errors. It retries after 0.5/1/2/4 s, capped at 4 s, and retries a missing acknowledgement
after a 4 s timeout plus backoff. Disconnect, leave, kick or a successful new join cancels pending attempts;
stale callbacks cannot invalidate a newer session. Definitive invalidation (`Room not found`, `Session expired`,
`Reconnection grace expired`, `Invalid session`) clears the saved session. Clock pings accept only matching,
finite timestamps, a finite nonnegative RTT and a finite offset, retaining the last valid estimate on errors.

Additive optional fields on every `PlayerView`:

```ts
monsterConnection?: { connected: boolean; connectedPlayers: number; totalPlayers: number;
  reconnectDeadlineEpoch: number | null; pauseRemainingMs?: number };
defenderConnection?: { connected: boolean; connectedPlayers: number; totalPlayers: number;
  reconnectDeadlineEpoch: number | null; pauseRemainingMs?: number };
pausedForReconnect?: boolean;
```

`pauseRemainingMs` reports that team's remaining cumulative allowance. Display the missing team's reconnect
notice and wall-time countdown; connection loss can continue without a pause after allowance is exhausted.
While paused, render the night clock
from `view.t`. `events` includes new `connectionLost`, `connectionRestored`, and `forfeit` kinds using the
normal `VisibleEvent` shape: `{id:number,t:number,kind,text:string,severity:'info'|'warn'|'alert'|'good'}`
(plus existing optional location/attribution fields). Loss/restoration are public. `MatchResult.reason`
stays `'forfeit'`; display optional `reasonText` for the explicit winner/reconnect-expiry explanation.

The Caltrans adapter separately caps master/media HLS playlists at 262,144 bytes and 4,096 lines before
parsing (`CaltransConfig.maxPlaylistBytes/maxPlaylistLines`). Oversized streams are cancelled/aborted and
fall back to available snapshots or labelled simulation.
