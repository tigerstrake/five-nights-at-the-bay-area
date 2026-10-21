import { describe, expect, it } from 'vitest';
import { createRng, type MonsterStance } from '@fnab/shared';
import { TacticalPlanner } from '../pathfinding';
import { TacticalBrain } from '../tacticalBrain';
import { diamond, inputFor } from './fixtures';

describe('tactical A*', () => {
  it.each<MonsterStance>(['HUNT', 'HIDE', 'FLANK', 'ATTACK', 'RETREAT'])('is optimal for %s against exhaustive simple paths', (stance) => {
    const graph = diamond(), input = inputFor(graph, stance, 'start');
    input.knowledge.cameraStatusByNode.blind = 'sabotaged';
    input.knowledge.exposures = [{ nodeId: 'watched', t: input.knowledge.t - 10_000 }];
    const planner = new TacticalPlanner(input, { obviousNodes: new Set(['watched']) });
    const paths: Array<{ path: string[]; cost: number }> = [];
    const visit = (path: string[], cost: number) => {
      const at = path.at(-1)!;
      if (at === 'goal') { paths.push({ path, cost }); return; }
      for (const { to, edge } of graph.adj.get(at)!)
        if (!path.includes(to)) visit([...path, to], cost + planner.edgeCost(at, to, edge));
    };
    visit(['start'], 0);
    const optimal = paths.sort((a, b) => a.cost - b.cost)[0];
    expect(planner.plan('goal')?.cost).toBeCloseTo(optimal.cost);
    expect(planner.plan('goal')?.path).toEqual(optimal.path);
    expect(planner.plan('isolated')).toBeNull();
  });

  it('uses travel time with clamped edges and an admissible travel heuristic', () => {
    const graph = diamond(), input = inputFor(graph, 'ATTACK', 'start');
    input.cfg.monster.tactical = { stanceExposure: { HUNT: 0, HIDE: 0, FLANK: 0, ATTACK: 0, RETREAT: 0 } };
    const planner = new TacticalPlanner(input);
    expect(planner.plan('goal')?.path).toEqual(['start', 'watched', 'goal']);
    expect(planner.plan('goal')?.cost).toBe(planner.travelMs('start', 'goal'));
    // Deliberately nonsensical coordinates in this fixture must have no effect on admissibility.
    expect(graph.geoKm('start', 'goal')).toBeGreaterThan(1_000);
  });

  it('HIDE avoids exposed nodes and immediately exploits a sabotaged camera', () => {
    const input = inputFor(diamond(), 'HIDE', 'start');
    expect(new TacticalPlanner(input).plan('goal')?.path).toEqual(['start', 'watched', 'goal']);
    input.knowledge.cameraStatusByNode.blind = 'sabotaged';
    expect(new TacticalPlanner(input).plan('goal')?.path).toEqual(['start', 'blind', 'goal']);
    input.knowledge.cameraStatusByNode.blind = 'ok';
    input.knowledge.cameraStatusByNode.watched = 'sabotaged';
    expect(new TacticalPlanner(input).plan('goal')?.path).toEqual(['start', 'watched', 'goal']);
  });

  it('FLANK diverges from recent and obvious corridors', () => {
    const input = inputFor(diamond(), 'FLANK', 'start');
    input.knowledge.recentNodes = ['goal', 'watched', 'start'];
    expect(new TacticalPlanner(input, { obviousNodes: new Set(['watched']) }).plan('goal')?.path)
      .toEqual(['start', 'blind', 'goal']);
    expect(new TacticalBrain().decide(input, createRng(1)).path).toEqual(['start', 'blind', 'goal']);
  });

  it('known sensors penalize their node AND its neighbors', () => {
    const input = inputFor(diamond(), 'HIDE', 'start');
    const clear = new TacticalPlanner(input);
    input.knowledge.knownSensors = [{ id: 'seen', nodeId: 'watched', seenAt: input.knowledge.t, disabled: false }];
    const defended = new TacticalPlanner(input);
    expect(defended.risk('watched').sensors).toBeGreaterThan(defended.risk('start').sensors);
    expect(defended.risk('start').sensors).toBeGreaterThan(0);
    expect(defended.plan('goal')!.cost).toBeGreaterThan(clear.plan('goal')!.cost);
    input.knowledge.knownSensors[0].disabled = true;
    expect(new TacticalPlanner(input).risk('start').sensors).toBe(0);
  });

  it('trap, scan and sighting danger decay to zero', () => {
    const input = inputFor(diamond(), 'HIDE', 'start');
    const t = input.knowledge.t;
    input.knowledge.trapEncounters = [{ nodeId: 'watched', t }];
    input.knowledge.scanPulses = [{ nodeId: 'watched', t }];
    input.knowledge.exposures = [{ nodeId: 'watched', t }];
    const fresh = new TacticalPlanner(input).risk('watched').danger;
    input.knowledge.t += input.cfg.visibility.monsterMemoryMs / 2;
    expect(new TacticalPlanner(input).risk('watched').danger).toBeCloseTo(fresh / 2);
    input.knowledge.t += input.cfg.visibility.monsterMemoryMs;
    expect(new TacticalPlanner(input).risk('watched').danger).toBe(0);
  });

  it('accounts for continuing and reversing along a partially travelled edge', () => {
    const input = inputFor(diamond(), 'ATTACK', 'start');
    input.knowledge.position.moving = { from: 'start', to: 'watched', edgeId: 'a', progress: 0.9 };
    expect(new TacticalPlanner(input).plan('goal')?.path[0]).toBe('watched');
    input.knowledge.position.moving.progress = 0.1;
    expect(new TacticalPlanner(input).plan('start')?.path).toEqual(['start']);
  });

  it('invalidates cached travel costs when configuration changes', () => {
    const input = inputFor(diamond(), 'HUNT', 'start');
    const first = new TacticalPlanner(input).travelMs('start', 'goal');
    input.cfg.monster.baseEdgeMs *= 2;
    expect(new TacticalPlanner(input).travelMs('start', 'goal')).toBeGreaterThan(first);
  });
});
