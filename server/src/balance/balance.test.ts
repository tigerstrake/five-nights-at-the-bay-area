import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, Graph, NETWORK, createRng, type BalanceConfig } from '@fnab/shared';
import { TacticalBrain } from '../ai/tacticalBrain';
import { createGame } from '../engine/state';
import { projectDefenderView, projectMonsterView } from '../visibility';
import { DefenderBot, MonsterBot } from './bots';
import { HQS, playMatch, runBatch, type BatchOptions } from './harness';
import { quantile, summarize } from './report';
import { parseArgs } from './cli';
import { mergeMeasurements } from './aggregate';

const batch: BatchOptions = { matches: 5, hqs: HQS, defenders: [1, 2, 3, 4], duration: 480, skill: 'competent', monster: 'mixed', seed: 123 };

describe('balance harness', () => {
  it('replays complete matches and measurements deterministically', () => {
    const options = { hq: HQS[0], defenders: 2, duration: 480, skill: 'competent' as const, monster: 'adaptive' as const, seed: 61 };
    const game = playMatch(options);
    expect(game).toEqual(playMatch(options));
    expect(() => mergeMeasurements([[game], [game]])).toThrow('Duplicate trial');
  });

  it('bot decisions depend only on their projected observations', () => {
    const graph = new Graph(NETWORK), cfg: BalanceConfig = structuredClone(DEFAULT_CONFIG);
    const ctx = { graph, brain: new TacticalBrain(), placementCount: () => 2 };
    const state = createGame({ graph, cfg, hqId: HQS[0], durationMs: cfg.match.durationMs, defenderCount: 1, seed: 1 });
    const clock = { t0Epoch: 0, serverNow: 0 };
    const dv = projectDefenderView(ctx, state, clock);
    state.monster.cooldowns.RETREAT = 99_000;
    state.monster.trapImmuneUntil = 20_000;
    state.monster.knowledge.exposures.push({ nodeId: NETWORK.nodes[0].id, t: 0 });
    const dv2 = projectDefenderView(ctx, state, clock);
    expect(dv2).toEqual(dv);
    expect(new DefenderBot('expert', graph, cfg, createRng(1), 1).act(dv))
      .toEqual(new DefenderBot('expert', graph, cfg, createRng(1), 1).act(dv2));
    const mv = projectMonsterView(ctx, state, clock);
    state.traps.push({ id: 'secret', nodeId: NETWORK.nodes[2].id, armedAt: 0 });
    state.sensors.push({ id: 'secret-sensor', nodeId: NETWORK.nodes[3].id, disabledUntil: null, lastPingAt: null });
    state.power.value -= 1;
    const mv2 = projectMonsterView(ctx, state, clock);
    expect(mv2).toEqual(mv);
    expect(new MonsterBot('adaptive', graph, cfg, createRng(2)).act(mv))
      .toEqual(new MonsterBot('adaptive', graph, cfg, createRng(2)).act(mv2));
  });

  it('keeps both outcomes possible and most successful breaches late, with wide regression bounds', () => {
    const games = runBatch(batch), r = summarize(games);
    expect(games).toHaveLength(80);
    expect(r.breach + r.capture + r.survive).toBe(80);
    expect(r.monsterWinRate).toBeGreaterThan(0.2);
    expect(r.monsterWinRate).toBeLessThan(0.8);
    expect(r.lastThirdShareOfBreaches).toBeGreaterThan(0.2);
    expect(r.earlyEndRate).toBeLessThan(0.4);
    expect(games.every(g => g.durationMs <= 480_000 && g.distanceKm >= 0 && g.power.every(p => p.value >= 0))).toBe(true);
    expect(r.rejectedActions.defenders).toBe(0);
  });

  it('rewards expert play against rush and punishes novice play against adaptive commands', () => {
    const options = { ...batch, matches: 3, defenders: [1, 4] };
    const experts = summarize(runBatch({ ...options, skill: 'expert', monster: 'rusher' }));
    const novices = summarize(runBatch({ ...options, skill: 'novice', monster: 'adaptive' }));
    expect(experts.monsterWinRate).toBeLessThan(0.35);
    expect(novices.monsterWinRate).toBeGreaterThan(0.65);
  });

  it('HIDE alone cannot win and closing every door loses with heat or blackouts', () => {
    const options = { ...batch, matches: 1, defenders: [1, 4] };
    const hiding = summarize(runBatch({ ...options, monster: 'hide' }));
    const lockdown = summarize(runBatch({ ...options, skill: 'lockdown', monster: 'rusher' }));
    expect(hiding.breach).toBe(0);
    expect(lockdown.monsterWinRate).toBeGreaterThan(0.8);
    expect(lockdown.doorJams).toBeGreaterThan(0);
    expect(lockdown.blackoutFrequency).toBeGreaterThan(0.8);
  });

  it('validates CLI cells and computes interpolated quantiles', () => {
    expect(parseArgs(['--matches', '400', '--hq', 'all', '--defenders', '1,2,3,4']).matches).toBe(400);
    expect(() => parseArgs(['--matches', 'NaN'])).toThrow();
    expect(() => parseArgs(['--monster', 'omniscient'])).toThrow();
    expect(quantile([10, 0, 20, 30], 0.5)).toBe(15);
    expect(quantile([], 0.5)).toBeNull();
  });
});
