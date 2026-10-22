import { DEFAULT_CONFIG } from '@fnab/shared';

export type PlayingRole = 'defender' | 'monster';
const C = DEFAULT_CONFIG;
const seconds = (ms: number) => ms / 1000;
const coldDoorSeconds = Math.round(1 / C.doors.heatPerSecClosed);
const batteredDoorSeconds = Math.round(1 / (C.doors.heatPerSecClosed + C.doors.heatPerSecBattered));
// Round the full channel's gross cost up to a practical reserve; other systems still draw power.
const containmentReserve = Math.ceil((C.power.containmentStartCost + C.power.containmentDrainPerSec * seconds(C.containment.captureMs)) / 10) * 10;

/** Tactical advice checked against docs/MECHANICS.md; timings use default balance. */
const STRATEGY: Record<PlayingRole, Array<[string, string]>> = {
  defender: [
    ['Play for dawn', 'Surviving until the clock expires is your main win. Make it waste time; capture is an opportunity, not a reason to spend every resource.'],
    ['Prepare the routes', `Use prep to cover likely approach nodes with traps and reserve one for a chokepoint 2–3 hops out. Solo has ${C.traps.maxCount} traps, so prioritize routes. Prep traps arm immediately.`],
    ['Space your sensors', 'A ping covers the sensor’s node and its neighbours, not an exact location. Spread sensors across different routes instead of stacking overlapping coverage.'],
    ['Keep doors open early', 'Do not seal doors just because the monster is somewhere on the map. Save power and cool doors until a confirmed approach or breach alert.'],
    ['Chase the next contact', `From last-known, check the next node toward HQ, then nearby branches. Use roughly 15–25 s per hop as a search window, not a live track: stance, phase and team size change speed; HIDE can take up to ${seconds(C.monster.maxEdgeMs * C.monster.stanceSpeed.HIDE)} s.`],
    ['Confirm before committing', `Scan the likely node: it checks that node plus ${C.scan.radiusHops} hop and exposes decoys there from the last ${seconds(C.scan.decoyExposeWindowMs)} s. “Feed tampered” means the monster was within ${C.monster.sabotageRangeHops} hop when it sabotaged; ordinary interference is not that clue.`],
    ['Bait a trap', 'Put a lure next to a trap so the route to the alarm crosses the trapped node. HUNT investigates disturbances; a human monster may ignore the bait.'],
    ['Seal only the threatened door', `Seal only the door it is at, then release it to cool before heat fills. A cold door jams after about ${coldDoorSeconds} s sealed, or only about ${batteredDoorSeconds} s while battered; an already hot door jams sooner. Never seal all three: draining power to zero forces every door open for ${seconds(C.power.outageMs)} s.`],
    ['Fund the capture', `Keep about ${containmentReserve} power for containment, plus room for other drains. Engage immediately when a trap holds it: a bare trap lasts ${seconds(C.traps.holdMs)} s and never captures. Containment needs ${seconds(C.containment.captureMs)} s uninterrupted; early struggle can still beat it.`],
    ['Split the control room', 'Assign one teammate to cameras and contact calls, one to doors and power, and one to traps and containment. Call your scan before spending the shared pool; solo, check alerts and power before chasing feeds.'],
  ],
  monster: [
    ['Use Infiltration to set up', `Do not rush the doors: breach takes ${C.breach.phaseMult.infiltration}× as long in Infiltration, and HUNT / FLANK do not breach during it. Only ATTACK commits early. Use that time to learn their coverage.`],
    ['Approach quietly', 'Use HIDE for a slow, less visible approach and FLANK to pressure a less defended door. Switch to ATTACK when you want to commit; HIDE never breaches.'],
    ['Blind the route ahead', `SABOTAGE the next camera once it is within ${C.monster.sabotageRangeHops} hop to create a blind spot before crossing. The camera stays down for ${seconds(C.monster.sabotageDurationMs)} s unless repaired, but “feed tampered” also gives defenders a proximity clue.`],
    ['Send eyes the wrong way', `Place a DECOY away from your real approach, on a working camera within ${C.monster.decoyRangeHops} hops. Move along another route while they check it; a scan can expose the fake.`],
    ['Push on low power', `Watch their coarse power readout. When it reads low, make them choose between sealing and saving power; when it reads out, doors are forced open during the ${seconds(C.power.outageMs)} s blackout. Use ATTACK if you need breach intent now.`],
    ['Heat a door or split them', 'Batter a sealed door until heat jams it open, or FLANK to another approach and make them divide attention. Sealing stalls and reverses your breach progress, so watch heat instead of expecting progress through a closed door.'],
    ['Expect hidden traps', `Assume approach nodes are trapped. Vary your route and entry door; you cannot see traps. After escape you have ${seconds(C.monster.freedTrapImmunityMs)} s of trap immunity—use it to move before another hold.`],
    ['Struggle once', 'While trapped, issue one accepted RETREAT to start continuous struggle (when ready). Spamming adds no progress. Move on after escape; the cooldown still matters for your next hold.'],
    ['Learn the other side', 'Try Play solo → Monster against a Novice defender. Practice a quiet approach, a distant decoy and a door switch; seeing what defenders react to will also improve your defender play.'],
  ],
};

export function RoleStrategy({ role }: { role: PlayingRole }) {
  return (
    <section className="p-5" aria-labelledby="strategy-title" data-testid={`strategy-${role}`}>
      <h3 id="strategy-title" className={`mb-3 font-display text-[17px] font-bold ${role === 'monster' ? 'text-bone' : 'text-cyan'}`}>
        {role === 'monster' ? 'Monster' : 'Defender'} strategy
      </h3>
      <ul className="grid gap-x-6 gap-y-3 md:grid-cols-2">
        {STRATEGY[role].map(([title, advice]) => (
          <li key={title} className="text-[12.5px] leading-snug text-mute">
            <strong className="mb-1 block text-text">{title}</strong>
            {advice}
          </li>
        ))}
      </ul>
      <p className="mt-4 border-t border-edge pt-3 text-[11px] text-dim">
        Timings use default balance. Movement and breach speed also change with phase and defender count. The match continues while this manual is open.
      </p>
    </section>
  );
}
