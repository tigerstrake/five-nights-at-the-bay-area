import { describe, expect, it } from 'vitest';
import { AI_PLAYER_CONFIG, Graph, type AiDifficulty, type DefenderView } from '@fnab/shared';
import { AiPlayer } from './AiPlayer';
import { harness } from '../../test/fixtures';
import { projectDefenderView, projectMonsterView } from '../visibility';

describe('AI projected observation boundary and cadence', () => {
  it.each(['novice', 'competent', 'expert'] as const)('%s defender decisions are identical with hidden full-state information removed', difficulty => {
    const h = harness();
    // Private state can carry plans, abilities and decoy truth, none of which are allowed inputs to a defender seat.
    // A public breach fixes the aggregate threat, so stripping hidden location/stance preserves every legal signal.
    h.s.phase = 'escalation';
    h.s.breach = { approachId: 'A1', progress: 0.2, stalled: false };
    h.s.monster.spawned = true;
    h.s.monster.spawnChoice = 's1';
    h.s.monster.nodeId = 'a';
    h.s.monster.moving = { from: 'a', to: 'b', edgeId: 'e2', elapsed: 100, duration: 18_000 };
    h.s.monster.stance = 'HIDE';
    h.s.monster.path = ['a', 'd', 'f'];
    h.s.monster.cooldowns.RETREAT = 91_000;
    h.s.monster.knowledge.exposures.push({ nodeId: 'a', t: 0 });
    h.s.monster.pendingDecoys.push({ nodeId: 'b', at: 5000 });
    h.s.sightings.push({ id: 8, nodeId: 'b', t: 0, confidence: 0.8, source: 'camera', flaggedFalse: false, isDecoy: true });
    const withoutSecrets = structuredClone(h.s);
    withoutSecrets.monster.spawned = false;
    withoutSecrets.monster.spawnChoice = null;
    withoutSecrets.monster.nodeId = null;
    withoutSecrets.monster.moving = null;
    withoutSecrets.monster.stance = 'HUNT';
    withoutSecrets.monster.path = [];
    withoutSecrets.monster.cooldowns.RETREAT = 0;
    withoutSecrets.monster.knowledge.exposures = [];
    withoutSecrets.monster.pendingDecoys = [];
    withoutSecrets.sightings[0].isDecoy = false;
    const rich = new AiPlayer('defender', difficulty, h.graph, h.s.cfg, 11);
    const scrubbed = new AiPlayer('defender', difficulty, h.graph, h.s.cfg, 11);
    const actions = [];
    for (let t = 0; t < 60_000; t += h.s.cfg.tickMs) {
      h.s.t = withoutSecrets.t = t;
      const clock = { t0Epoch: 0, serverNow: t };
      const v1 = projectDefenderView(h.ctx, h.s, clock);
      const v2 = projectDefenderView(h.ctx, withoutSecrets, clock);
      expect(v1).toEqual(v2);
      expect(Object.keys(v1)).not.toContain('monster');
      const a = rich.act(v1);
      expect(a).toEqual(scrubbed.act(v2));
      if (a) actions.push(a);
    }
    expect(actions.length).toBeGreaterThan(0);
  });

  it('skill maps directly to measured defender policies', () => {
    const h = harness(), v = projectDefenderView(h.ctx, h.s, { t0Epoch: 0, serverNow: 0 });
    const counts = new Map<AiDifficulty, number>();
    for (const difficulty of ['novice', 'competent', 'expert'] as const) {
      const ai = new AiPlayer('defender', difficulty, h.graph, h.s.cfg, 19);
      const actions = [];
      for (let t = 0; t < 10_000; t += 100) {
        const a = ai.act({ ...v, t });
        if (a) actions.push({ t, a });
      }
      expect(actions[0].a.type).toBe('placeSensor');
      if (difficulty !== 'novice') expect(h.graph.hopsToHq((actions[0].a as { nodeId: string }).nodeId, v.hqId)).toBe(0);
      else expect(actions.length).toBeLessThan(6);
      expect(ai.difficulty).toBe(difficulty);
      counts.set(difficulty, actions.length);
    }
    expect(counts.get('expert')!).toBeGreaterThan(counts.get('competent')!);
    expect(counts.get('competent')!).toBeGreaterThan(counts.get('novice')!);
  });

  it('adaptive monster thinking is skill-scaled and bounded, with at most one action per observation', () => {
    const h = harness(), v = projectMonsterView(h.ctx, h.s, { t0Epoch: 0, serverNow: 0 });
    const first = new Map<AiDifficulty, number>();
    for (const difficulty of ['novice', 'competent', 'expert'] as const) {
      const ai = new AiPlayer('monster', difficulty, new Graph(h.graph.data), h.s.cfg, 71);
      for (let t = 0; t <= 7000; t += h.s.cfg.tickMs) {
        const view = { ...v, t };
        const a = ai.act(view);
        if (!a) continue;
        expect(a.type).toBe('chooseSpawn');
        expect(ai.act(view)).toBeNull();
        const [min, max] = AI_PLAYER_CONFIG.monsterReactionMs[difficulty];
        expect(t).toBeGreaterThanOrEqual(min);
        expect(t).toBeLessThanOrEqual(max + AI_PLAYER_CONFIG.initialStaggerMs[1] + h.s.cfg.tickMs);
        first.set(difficulty, t); break;
      }
    }
    expect(first.size).toBe(3);
    expect(first.get('expert')!).toBeLessThan(first.get('competent')!);
    expect(first.get('competent')!).toBeLessThan(first.get('novice')!);
  });

  it('ignores ended and wrong-role projections', () => {
    const h = harness();
    const ai = new AiPlayer('monster', 'expert', h.graph, h.s.cfg, 4);
    const d: DefenderView = projectDefenderView(h.ctx, h.s, { t0Epoch: 0, serverNow: 0 });
    expect(ai.act({ ...d, t: 20_000 })).toBeNull();
    expect(ai.act({ ...projectMonsterView(h.ctx, h.s, { t0Epoch: 0, serverNow: 0 }), t: 20_000, ended: true })).toBeNull();
  });
});
