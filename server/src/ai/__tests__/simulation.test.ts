import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, Graph, NETWORK, createRng, scaleForDefenders, spawnCandidates,
  type GameAction, type MonsterStance } from '@fnab/shared';
import { BaselineBrain } from '../baselineBrain';
import { TacticalBrain } from '../tacticalBrain';
import { applyAction } from '../../engine/engine';
import { projectDefenderView, projectMonsterView } from '../../visibility';
import { harness } from '../../../test/fixtures';
import { assertPath, inputFor } from './fixtures';

const M = { team: 'monster' as const, playerId: 'm' };
const D = { team: 'defenders' as const, playerId: 'd' };
const clock = { t0Epoch: 0, serverNow: 0 };
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return !sorted.length ? null : sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

describe('tactical decision budget', () => {
  it('averages less than 1 ms across mixed commands on the 36-node graph', () => {
    const graph = new Graph(NETWORK), brain = new TacticalBrain(), rng = createRng(41);
    const stances: MonsterStance[] = ['HUNT', 'HIDE', 'FLANK', 'ATTACK', 'RETREAT'];
    const inputs = stances.map((stance) => inputFor(graph, stance));
    for (const input of inputs) {
      input.cfg.monster.unpredictability = DEFAULT_CONFIG.monster.unpredictability;
      input.knowledge.knownSensors = NETWORK.nodes.slice(12, 16).map((n) => ({ id: n.id, nodeId: n.id, seenAt: 40_000, disabled: false }));
      input.knowledge.exposures = [{ nodeId: 'n-hillsdale', t: 40_000 }];
      input.knowledge.scanPulses = [{ nodeId: 'n-willow-101', t: 40_000 }];
      input.knowledge.trapEncounters = [{ nodeId: 'n-maze', t: 40_000 }];
      input.knowledge.recentNodes = NETWORK.nodes.slice(10, 18).map((n) => n.id);
    }
    for (let i = 0; i < 500; i++) brain.decide(inputs[i % inputs.length], rng);
    const samples: number[] = [], byCommand: Record<string, number[]> = {};
    for (let i = 0; i < 5_000; i++) {
      const input = inputs[i % inputs.length];
      input.knowledge.position.nodeId = NETWORK.nodes[i % NETWORK.nodes.length].id;
      input.knowledge.t = 40_000 + i;
      const before = performance.now();
      const intent = brain.decide(input, rng);
      const elapsed = performance.now() - before;
      samples.push(elapsed);
      (byCommand[input.knowledge.stance] ??= []).push(elapsed);
      if (i % 100 === 0) expect(assertPath(graph, intent.path)).toBe(true);
    }
    const averageMs = samples.reduce((a, b) => a + b, 0) / samples.length;
    const p95Ms = [...samples].sort((a, b) => a - b)[Math.floor(samples.length * 0.95)];
    console.info('TACTICAL_PERF', JSON.stringify({ nodes: graph.nodes.size, decisions: samples.length,
      averageMs, medianMs: median(samples), p95Ms,
      meanByCommand: Object.fromEntries(Object.entries(byCommand).map(([command, times]) => [command, times.reduce((a, b) => a + b, 0) / times.length])),
    }));
    expect(averageMs).toBeLessThan(1);
  });
});

/** Same human command policy and view-only defender script for each brain; no engine balance edits. */
function play(brain: 'tactical' | 'baseline', seed: number, hqIndex: number) {
  const hq = NETWORK.headquarters[hqIndex];
  const h = harness({ data: { ...NETWORK, headquarters: [hq] }, seed, cfg: scaleForDefenders(1), durationMs: DEFAULT_CONFIG.match.durationMs });
  h.ctx.brain = brain === 'tactical' ? new TacticalBrain() : new BaselineBrain();
  const act = (actor: typeof M | typeof D, action: GameAction) => applyAction(h.ctx, h.s, actor, action, h.rng);
  for (const approach of hq.approaches) act(D, { type: 'placeSensor', nodeId: approach.fromNode });
  act(D, { type: 'armTrap', nodeId: hq.approaches[seed % hq.approaches.length].fromNode });
  const spawns = spawnCandidates(h.graph, h.s.hqId, h.s.cfg.spawn);
  act(M, { type: 'chooseSpawn', nodeId: spawns[seed % spawns.length] });
  act(M, { type: 'command', command: 'HUNT' });
  let heldSeenAt: number | null = null, releasedAt: number | null = null;
  while (!h.s.result && h.s.t <= h.s.prepMs + h.s.durationMs) {
    h.run(1_000);
    const dv = projectDefenderView(h.ctx, h.s, clock);
    const mv = projectMonsterView(h.ctx, h.s, clock);
    // Defender policy reads only its view. Reactions happen on a one-second cadence.
    if (dv.held) {
      heldSeenAt ??= h.s.t;
      if (!dv.containment && h.s.t - heldSeenAt >= (seed % 4) * 1_000)
        act(D, { type: 'containment', engage: true });
    } else if (heldSeenAt !== null) { heldSeenAt = null; releasedAt = h.s.t; }
    if (dv.breach) act(D, { type: 'door', approachId: dv.breach.approachId, closed: true });
    for (const door of dv.doors)
      if (door.closed && dv.breach?.approachId !== door.approachId) act(D, { type: 'door', approachId: door.approachId, closed: false });
    if (dv.power.value > 35) {
      for (const camera of dv.cameras)
        if (camera.status === 'sabotaged' || camera.status === 'static') act(D, { type: 'repair', cameraId: camera.cameraId });
      if (dv.lastKnown && h.s.t - dv.lastKnown.t < 6_000 && h.s.t >= dv.cooldowns.scanReadyAt)
        act(D, { type: 'scan', nodeId: dv.lastKnown.nodeId });
      if (dv.lastKnown && h.s.t - dv.lastKnown.t < 6_000 && dv.traps.length < dv.limits.traps
        && !dv.traps.some((trap) => trap.nodeId === dv.lastKnown!.nodeId))
        act(D, { type: 'armTrap', nodeId: dv.lastKnown.nodeId });
      if (dv.traps[0] && dv.lastKnown && h.s.t >= dv.cooldowns.lureReadyAt
        && h.graph.hops(dv.traps[0].nodeId, dv.lastKnown.nodeId) <= 4)
        act(D, { type: 'lure', nodeId: dv.traps[0].nodeId });
    }
    // Human monster policy also reads only its view; both brains receive the same policy.
    if (!mv.self.spawned) continue;
    if (mv.self.held && !mv.self.held.struggling)
      act(M, { type: 'command', command: 'RETREAT' });
    if (!mv.self.held && mv.self.stance === 'RETREAT' && releasedAt !== null && h.s.t - releasedAt >= 10_000)
      act(M, { type: 'command', command: mv.phase === 'final' ? 'ATTACK' : 'HUNT' });
    else if (!mv.self.held && mv.phase === 'final' && mv.self.stance !== 'ATTACK' && mv.self.stance !== 'RETREAT')
      act(M, { type: 'command', command: 'ATTACK' });
    if (!mv.self.held && mv.self.nodeId) {
      const here = mv.self.moving?.to ?? mv.self.nodeId;
      if (h.s.t >= mv.self.cooldowns.SABOTAGE) {
        const target = mv.cameras.filter((camera) => camera.status === 'ok' && h.graph.hops(here, camera.nodeId) <= h.s.cfg.monster.sabotageRangeHops)
          .sort((a, b) => h.graph.hopsToHq(a.nodeId, mv.hqId) - h.graph.hopsToHq(b.nodeId, mv.hqId))[0];
        if (target) act(M, { type: 'sabotage', nodeId: target.nodeId, target: 'camera' });
      }
      if (h.s.t >= mv.self.cooldowns.DECOY) {
        const target = mv.cameras.filter((camera) => camera.status === 'ok' && camera.nodeId !== here
          && h.graph.hops(here, camera.nodeId) <= h.s.cfg.monster.decoyRangeHops)
          .sort((a, b) => h.graph.hops(here, b.nodeId) - h.graph.hops(here, a.nodeId))[0];
        if (target) act(M, { type: 'decoy', nodeId: target.nodeId });
      }
    }
  }
  expect(h.s.result).not.toBeNull();
  // Turning around mid-edge may return to the last recorded node without reaching the other end.
  const visited = h.s.result!.monsterPath.map((p) => p.nodeId).filter((node, i, all) => i === 0 || node !== all[i - 1]);
  expect(assertPath(h.graph, visited)).toBe(true);
  return h.s.result!;
}

describe('headless full-match comparison', () => {
  it('replays a complete tactical match identically with the same seed and scripted inputs', () => {
    expect(play('tactical', 11, 1)).toEqual(play('tactical', 11, 1));
  });

  it('finishes 80 seeded matches per brain across all four HQs and reports outcomes', () => {
    const report = (['tactical', 'baseline'] as const).map((brain) => {
      const matches = NETWORK.headquarters.flatMap((_, hq) => Array.from({ length: 20 }, (_x, seed) => play(brain, seed + 1, hq)));
      const breaches = matches.filter((r) => r.reason === 'breach');
      return {
        brain, matches: matches.length, monsterWins: matches.filter((r) => r.winner === 'monster').length,
        monsterWinRate: matches.filter((r) => r.winner === 'monster').length / matches.length,
        medianBreachMs: median(breaches.map((r) => r.stats.durationMs)),
        captures: matches.filter((r) => r.reason === 'capture').length,
        timerDefenses: matches.filter((r) => r.reason === 'timer').length,
        byHq: NETWORK.headquarters.map((hq) => ({ hq: hq.id, wins: matches.filter((r) => r.hqId === hq.id && r.winner === 'monster').length })),
      };
    });
    console.info('BRAIN_MATCH_COMPARISON', JSON.stringify(report));
    expect(report.every((r) => r.matches === 80 && r.monsterWins + r.captures + r.timerDefenses === 80)).toBe(true);
  }, 120_000);
});
