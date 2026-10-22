// §3/§18: opposing teams never receive each other's secrets. Every Socket.IO payload each context receives is captured
// off the wire (Playwright websocket frames) and inspected: defenders/spectators must never get the monster's exact
// position, stance, cooldowns, decoy flags or knowledge; the monster must never get traps, undiscovered sensors,
// sightings or exact power. The post-match result legitimately reveals everything.
import { expect, test } from '@playwright/test';
import { CFG, cameraIdOfNode, graph, hqById } from './helpers/data';
import { asMonster, chooseSpawn, disposeAll, expectSameResult, runUntilEnd, skipPrep, startMatch, type Frame, type Player } from './helpers/game';

const DEFENDER_FORBIDDEN_KEYS = [
  'self', 'spawnOptions', 'spawnChoice', 'knownSensors', 'knownDoors', 'disturbances', 'scanPulses', 'exposures', 'powerLevel',
  'stance', 'moving', 'path', 'targetApproachId', 'isDecoy', 'knowledge', 'pendingDecoys', 'monsterPath', 'monster', 'lastReason',
];
const MONSTER_FORBIDDEN_KEYS = [
  'traps', 'sensors', 'sightings', 'lures', 'doors', 'repairs', 'limits', 'lastScan', 'lastKnown', 'threat', 'power', 'drainPerSec', 'isDecoy',
];
/** Events whose audience is the monster only. Defenders must never be sent these. */
const MONSTER_ONLY_EVENT_KINDS = ['command', 'ability', 'spawn', 'moved', 'exposed', 'sensorFound', 'scanFelt', 'disturbance'];
/** Defender-only wording the monster must never be sent. */
const DEFENDER_ONLY_TEXT = [/Trap arming/i, /Motion sensor placed/i, /sealed/i, /Repair crew/i, /Alarm lure sounding/i, /SCAN CONTACT/i];
const SIGHTING_KEYS = new Set(['id', 'nodeId', 't', 'confidence', 'source', 'flaggedFalse']);

function walk(v: unknown, visit: (key: string, value: unknown, parent: Record<string, unknown>) => void): void {
  if (Array.isArray(v)) return v.forEach((x) => walk(x, visit));
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      visit(k, x, v as Record<string, unknown>);
      walk(x, visit);
    }
  }
}
/**
 * Every view as the client reconstructs it off the wire: full `game:view` checkpoints patched by the opt-in
 * `game:delta` frames (top-level `changes`, `removed`). Inspecting these covers every byte either kind carried.
 */
const views = (p: Player): Frame[] => {
  const out: Frame[] = [];
  let last: Record<string, unknown> | null = null;
  for (const f of p.frames) {
    if (f.event === 'game:view') last = f.data[0] as Record<string, unknown>;
    else if (f.event === 'game:delta' && last) {
      const d = f.data[0] as { changes: Record<string, unknown>; removed?: string[] };
      const next: Record<string, unknown> = { ...last, ...d.changes };
      for (const k of d.removed ?? []) delete next[k];
      last = next;
    } else continue;
    out.push({ ...f, data: [last] });
  }
  return out;
};

/** One pass over a player's game:view frames, collecting what was ever sent (cheap; assertions run once afterwards). */
function inspect(frames: Frame[]) {
  const seen = {
    roles: new Set<string>() as unknown as string[],
    keys: new Set<string>(),
    cooldownShapes: new Set<string>(),
    sightingKeys: new Set<string>(),
    eventKinds: new Set<string>(),
    eventTexts: new Set<string>(),
    knownSensors: 0,
  };
  const roles = new Set<string>();
  for (const f of frames) {
    const v = f.data[0] as Record<string, unknown>;
    roles.add(String(v.role));
    walk(v, (k, value) => {
      seen.keys.add(k);
      if (k === 'cooldowns') seen.cooldownShapes.add(Object.keys(value as object).sort().join(','));
      if (k === 'sightings') for (const sg of value as object[]) for (const sk of Object.keys(sg)) seen.sightingKeys.add(sk);
      if (k === 'knownSensors') seen.knownSensors = Math.max(seen.knownSensors, (value as unknown[]).length);
      if (k === 'events')
        for (const e of value as Array<{ kind: string; text: string }>) {
          seen.eventKinds.add(e.kind);
          seen.eventTexts.add(e.text);
        }
    });
  }
  seen.roles = [...roles];
  return seen;
}

test('information hiding on the wire: defenders/spectators never see the monster, the monster never sees defender secrets', async ({ browser }) => {
  const m = await startMatch(browser, { hq: 'hq-sf', defenders: 2, spectators: 1 });
  try {
    const { monster, defenders, spectators } = m;
    const [d1, d2] = defenders as [Player, Player];
    const hq = hqById('hq-sf');
    const spawn = await chooseSpawn(m, asMonster(await monster.view()).spawnOptions.find((n) => cameraIdOfNode(n)));
    const farNode = hq.approaches[0]!.fromNode; // far from the spawn: the monster cannot stumble on these
    const trapNode = graph.neighbors(farNode)[0]!;
    expect((await d1.act({ type: 'placeSensor', nodeId: farNode })).ok).toBe(true);
    expect((await d2.act({ type: 'armTrap', nodeId: trapNode })).ok).toBe(true);
    await skipPrep(m);
    await monster.passGap();

    // Monster uses its abilities: a sabotage at its own node and a decoy somewhere in reach.
    expect((await monster.act({ type: 'sabotage', nodeId: spawn, target: 'camera' })).ok).toBe(true);
    const decoyNode = graph.within(spawn, CFG.monster.decoyRangeHops).find((n) => n !== spawn && cameraIdOfNode(n));
    expect(decoyNode).toBeTruthy();
    await monster.passGap();
    expect((await monster.act({ type: 'decoy', nodeId: decoyNode! })).ok).toBe(true);
    await monster.passGap();
    expect((await monster.act({ type: 'command', command: 'HUNT' })).ok).toBe(true);
    // Defenders do things the monster must not learn about.
    const door = hq.approaches[1]!.id;
    expect((await d1.act({ type: 'door', approachId: door, closed: true })).ok).toBe(true);
    expect((await d2.act({ type: 'scan', nodeId: spawn })).ok).toBe(true);

    // Let the match run (match-time), tracking whether the monster ever got near the secret devices.
    let nearSensor = false;
    for (let i = 0; i < 25; i++) {
      const r = await monster.fastForward(2_000);
      if (r.ended) break;
      const s = asMonster(await monster.view()).self;
      for (const n of [s.nodeId, s.moving?.from, s.moving?.to]) if (n && graph.hops(n, farNode) <= 1) nearSensor = true;
    }
    await d1.waitView('true');

    // ── defenders + spectator ──
    for (const p of [d1, d2, ...spectators]) {
      expect(views(p).length, `${p.name} should have received views`).toBeGreaterThan(20);
      const seen = inspect(views(p));
      expect(seen.roles.every((r) => r === 'defender' || r === 'spectator')).toBe(true);
      expect(DEFENDER_FORBIDDEN_KEYS.filter((k) => seen.keys.has(k)), `${p.name} received forbidden keys`).toEqual([]);
      expect([...seen.cooldownShapes], 'defender cooldowns carry only scan/lure timers').toEqual(['lureReadyAt,scanReadyAt']);
      expect(seen.sightingKeys.size).toBeGreaterThan(0); // we did get sightings (positive control) ...
      expect([...seen.sightingKeys].filter((k) => !SIGHTING_KEYS.has(k)), '... carrying no hidden fields').toEqual([]);
      expect(MONSTER_ONLY_EVENT_KINDS.filter((k) => seen.eventKinds.has(k)), `${p.name} received monster-only events`).toEqual([]);
      expect([...seen.eventTexts].filter((t) => /You emerge|You will emerge|\[DECOY\]|Command:|DECOY:|SABOTAGE:/.test(t))).toEqual([]);
      // Before the match ends nothing about the route/decoys is public.
      const room = p.eventFrames('room:state').map((f) => f.data[0] as { result: unknown });
      expect(room.every((r) => r.result === null)).toBe(true);
      expect(p.eventFrames('game:result')).toHaveLength(0);
      const raw = p.frames.map((f) => f.raw).join('\n');
      expect(raw).not.toContain('"isDecoy"');
      expect(raw).not.toContain('"spawnChoice"');
      expect(raw).not.toMatch(/"(HUNT|HIDE|FLANK|ATTACK|RETREAT|SABOTAGE|DECOY)":\s*\d/); // monster cooldown table
    }

    // ── monster ──
    expect(views(monster).length).toBeGreaterThan(20);
    const mSeen = inspect(views(monster));
    expect(mSeen.roles).toEqual(['monster']);
    // positive control: the detector does flag the monster's own (secret) fields when they are present
    expect(DEFENDER_FORBIDDEN_KEYS.filter((k) => mSeen.keys.has(k)).length).toBeGreaterThan(3);
    expect(MONSTER_FORBIDDEN_KEYS.filter((k) => mSeen.keys.has(k)), 'monster received defender-only keys').toEqual([]);
    expect(
      [...mSeen.eventTexts].filter((t) => DEFENDER_ONLY_TEXT.some((re) => re.test(t))),
      'defender-only event text reached the monster',
    ).toEqual([]);
    if (!nearSensor) expect(mSeen.knownSensors, 'an undiscovered sensor leaked to the monster').toBe(0);
    const mRaw = monster.frames.map((f) => f.raw).join('\n');
    expect(mRaw).not.toMatch(/"id":"t\d+"/); // trap ids

    // ── after the match everything is revealed to everyone, identically ──
    await runUntilEnd(monster, { chunk: 60_000 });
    const result = await expectSameResult(m);
    expect(result.monsterPath.length).toBeGreaterThan(0);
    expect(result.timeline.some((e) => /\[DECOY\]/.test(e.text))).toBe(true); // our decoy is exposed post-match
    for (const p of m.all) expect(p.eventFrames('game:result').length).toBeGreaterThanOrEqual(1);
  } finally {
    await disposeAll(m);
  }
});
