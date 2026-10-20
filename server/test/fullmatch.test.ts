// Headless full-match simulations on the bundled network.json with scripted players.
import { describe, expect, it } from 'vitest';
import { NETWORK, scaleForDefenders, DEFAULT_CONFIG, spawnCandidates, Graph, type GameAction } from '@fnab/shared';
import { applyAction } from '../src/engine/engine';
import { projectDefenderView, projectMonsterView } from '../src/visibility';
import { harness } from './fixtures';

const D = { team: 'defenders' as const, playerId: 'd1' };
const M = { team: 'monster' as const, playerId: 'm1' };
const clock = { t0Epoch: 0, serverNow: 0 };

describe('full match simulation (bundled network)', () => {
  it('scripted match runs to a synchronized result with stats and timeline', () => {
    const cfg = scaleForDefenders(2, DEFAULT_CONFIG);
    const h = harness({ data: NETWORK, cfg, seed: 1234, defenders: 2, durationMs: 300_000 });
    const hq = h.graph.hqs.get(h.s.hqId)!;
    const act = (actor: typeof D | typeof M, a: GameAction) => applyAction(h.ctx, h.s, actor, a, h.rng);
    // Preparation: defenders set sensors/traps on approach nodes, monster picks spawn + HUNT.
    for (const ap of hq.approaches) act(D, { type: 'placeSensor', nodeId: ap.fromNode });
    act(D, { type: 'armTrap', nodeId: hq.approaches[0]!.fromNode });
    const spawns = spawnCandidates(h.graph, h.s.hqId, cfg.spawn);
    expect(spawns.length).toBeGreaterThan(0);
    expect(act(M, { type: 'chooseSpawn', nodeId: spawns[0]! }).ok).toBe(true);
    act(M, { type: 'command', command: 'HUNT' });
    let tick = 0;
    while (!h.s.result && tick < 400_000 / cfg.tickMs) {
      h.run(cfg.tickMs);
      tick++;
      const dv = projectDefenderView(h.ctx, h.s, clock);
      const mv = projectMonsterView(h.ctx, h.s, clock);
      // Defender script
      if (dv.held && !dv.containment) act(D, { type: 'containment', engage: true });
      for (const c of dv.cameras) if (c.status === 'sabotaged' || c.status === 'static') act(D, { type: 'repair', cameraId: c.cameraId });
      if (dv.lastKnown && h.s.t >= dv.cooldowns.scanReadyAt && dv.power.value > 40) act(D, { type: 'scan', nodeId: dv.lastKnown.nodeId });
      if (dv.breach) act(D, { type: 'door', approachId: dv.breach.approachId, closed: true });
      for (const d of dv.doors) if (d.closed && d.heat > 0.8) act(D, { type: 'door', approachId: d.approachId, closed: false });
      // Monster script
      if (mv.self.spawned) {
        if (mv.self.held && !mv.self.held.struggling) act(M, { type: 'command', command: 'RETREAT' });
        const here = mv.self.nodeId!;
        if (h.s.t >= mv.self.cooldowns.SABOTAGE) {
          const target = [here, ...h.graph.neighbors(here)].find((n) => mv.cameras.find((c) => c.nodeId === n)?.status === 'ok');
          if (target) act(M, { type: 'sabotage', nodeId: target, target: 'camera' });
        }
        if (h.s.t >= mv.self.cooldowns.DECOY) {
          const far = h.graph.within(here, 3).find((n) => n !== here && mv.cameras.find((c) => c.nodeId === n)?.status === 'ok');
          if (far) act(M, { type: 'decoy', nodeId: far });
        }
        if (mv.phase === 'final' && mv.self.stance !== 'ATTACK' && h.s.t >= mv.self.cooldowns.ATTACK)
          act(M, { type: 'command', command: 'ATTACK' });
      }
    }
    const r = h.s.result!;
    expect(r).toBeTruthy();
    expect(['monster', 'defenders']).toContain(r.winner);
    expect(r.timeline.length).toBeGreaterThan(10);
    expect(r.monsterPath.length).toBeGreaterThan(1);
    expect(r.stats.sabotages).toBeGreaterThan(0);
    expect(r.stats.powerSpent).toBeGreaterThan(0);
    // every monster step is along a real edge
    for (let i = 1; i < r.monsterPath.length; i++) {
      const a = r.monsterPath[i - 1]!.nodeId;
      const b = r.monsterPath[i]!.nodeId;
      if (a !== b) expect(h.graph.edgeBetween(a, b)).not.toBeNull();
    }
  });

  it('is deterministic for the same seed and inputs', () => {
    const run = () => {
      const h = harness({ data: NETWORK, seed: 99, durationMs: 300_000, cfg: { ...DEFAULT_CONFIG } });
      applyAction(h.ctx, h.s, M, { type: 'command', command: 'FLANK' }, h.rng);
      h.runUntil((s) => !!s.result, 400_000);
      return JSON.stringify(h.s.monsterPath) + h.s.result?.reason;
    };
    expect(run()).toEqual(run());
  });
});

describe('spawn fairness', () => {
  it('every HQ gets spawn options within the configured hop band', () => {
    const g = new Graph(NETWORK);
    const { minHopsFromHq, maxHopsFromHq } = DEFAULT_CONFIG.spawn;
    for (const hq of NETWORK.headquarters) {
      const c = spawnCandidates(g, hq.id, DEFAULT_CONFIG.spawn);
      expect(c.length).toBeGreaterThan(0);
      for (const n of c) {
        expect(g.hopsToHq(n, hq.id)).toBeGreaterThanOrEqual(minHopsFromHq);
        expect(g.hopsToHq(n, hq.id)).toBeLessThanOrEqual(maxHopsFromHq);
      }
    }
  });
});
