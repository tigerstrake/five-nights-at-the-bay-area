import { describe, expect, it } from 'vitest';
import { Graph, NETWORK, createRng, type MatchPhase, type MonsterStance } from '@fnab/shared';
import { TacticalBrain, type AbilityOrder } from '../tacticalBrain';
import { BaselineBrain, defaultBrain } from '../baselineBrain';
import { assertPath, diamond, inputFor } from './fixtures';

describe('tactical commands on the Bay Area network', () => {
  const graph = new Graph(NETWORK);
  it('is the default while BaselineBrain remains available', () => {
    expect(defaultBrain()).toBeInstanceOf(TacticalBrain);
    expect(new BaselineBrain()).toBeInstanceOf(BaselineBrain);
  });

  it('HUNT investigates perceived disturbances and resumes after reaching them', () => {
    const input = inputFor(graph, 'HUNT');
    input.knowledge.disturbances = [{ nodeId: 'n-rsr-bridge', t: input.knowledge.t, expiresAt: input.knowledge.t + 25_000 }];
    const brain = new TacticalBrain();
    const first = brain.decide(input, createRng(1));
    expect(first.path.at(-1)).toBe('n-rsr-bridge');
    expect(first.reason).toContain('disturbance');
    input.knowledge.position.nodeId = 'n-rsr-bridge';
    input.knowledge.recentNodes.push('n-rsr-bridge');
    expect(brain.decide(input, createRng(1)).path).toEqual(['n-rsr-bridge']);
    input.knowledge.t += input.cfg.monster.replanMs;
    const after = brain.decide(input, createRng(1));
    expect(after.path.length).toBeGreaterThan(1);
    expect(after.reason).not.toContain('Following the sound');
  });

  it('HUNT favors a door it saw open over a nearby sealed one', () => {
    const input = inputFor(graph, 'HUNT', 'n-willow-101');
    // Make the sealed-door delay exceed the detour at the current travel speed.
    const heatScale = input.cfg.monster.minEdgeMs / input.cfg.monster.maxEdgeMs;
    input.cfg.doors.heatPerSecClosed *= heatScale;
    input.cfg.doors.heatPerSecBattered *= heatScale;
    for (const n of Object.keys(input.knowledge.cameraStatusByNode)) input.knowledge.cameraStatusByNode[n] = 'blackout';
    input.knowledge.knownDoors = {
      'stanford-palm': { closed: false, jammed: false, seenAt: input.knowledge.t },
      'stanford-bayfront': { closed: true, jammed: false, seenAt: input.knowledge.t },
      'stanford-sandhill': { closed: true, jammed: false, seenAt: input.knowledge.t },
    };
    expect(new TacticalBrain().decide(input, createRng(1)).path.at(-1)).toBe('n-el-camino-emb');
  });

  it.each<MatchPhase>(['infiltration', 'escalation', 'final'])('HUNT and FLANK respect breach rules during %s', (phase) => {
    for (const stance of ['HUNT', 'FLANK'] as const) {
      const input = inputFor(graph, stance, 'n-univ-84');
      input.knowledge.phase = phase;
      input.knowledge.targetApproachId = 'stanford-bayfront';
      const intent = new TacticalBrain().decide(input, createRng(1));
      expect(intent.path).toEqual(['n-univ-84']);
      expect(intent.breachApproachId).toBe(phase === 'infiltration' ? null : 'stanford-bayfront');
    }
  });

  it.each<MatchPhase>(['infiltration', 'escalation', 'final'])('HIDE never breaches during %s, even at an open door', (phase) => {
    const input = inputFor(graph, 'HIDE', 'n-univ-84');
    input.knowledge.phase = phase;
    input.knowledge.targetApproachId = 'stanford-bayfront';
    input.knowledge.knownDoors['stanford-bayfront'] = { closed: false, jammed: false, seenAt: input.knowledge.t };
    const intent = new TacticalBrain().decide(input, createRng(1));
    expect(intent.breachApproachId).toBeNull();
    expect(assertPath(graph, intent.path)).toBe(true);
  });

  it('HIDE relocates after a sighting and creeps into a newly disabled camera corridor', () => {
    const input = inputFor(graph, 'HIDE', 'n-hillsdale');
    input.knowledge.exposures = [{ nodeId: 'n-hillsdale', t: input.knowledge.t }];
    input.knowledge.cameraStatusByNode['n-280-canada'] = 'sabotaged';
    const intent = new TacticalBrain().decide(input, createRng(1));
    expect(intent.path).toHaveLength(2);
    expect(intent.path[1]).toBe('n-280-canada');
    expect(intent.reason).toContain('Slipping');
  });

  it('FLANK takes Willow Road instead of retracing the I-280 corridor', () => {
    const input = inputFor(graph, 'FLANK', 'n-hillsdale');
    input.cfg.monster.tactical = { exposureMs: input.cfg.monster.baseEdgeMs };
    input.knowledge.targetApproachId = 'stanford-palm';
    input.knowledge.recentNodes = ['n-el-camino-emb', 'n-280-canada', 'n-hillsdale'];
    const intent = new TacticalBrain().decide(input, createRng(1));
    expect(intent.path).toEqual(['n-hillsdale', 'n-willow-101', 'n-embarcadero-101', 'n-el-camino-emb']);
    expect(intent.reason).toContain('obvious corridor');
  });

  it('FLANK avoids an approach protected by discovered sensors', () => {
    const input = inputFor(graph, 'FLANK', 'n-hillsdale');
    input.knowledge.knownSensors = [{ id: 'known', nodeId: 'n-280-canada', disabled: false, seenAt: input.knowledge.t }];
    const intent = new TacticalBrain().decide(input, createRng(1));
    expect(intent.path).not.toContain('n-280-canada');
  });

  it('ATTACK commits to a player-selected sealed door, even during infiltration', () => {
    const input = inputFor(graph, 'ATTACK', 'n-soma-split');
    input.knowledge.hqId = 'hq-sf';
    input.knowledge.targetApproachId = 'sf-division';
    input.knowledge.knownDoors['sf-division'] = { closed: true, jammed: false, seenAt: input.knowledge.t };
    const intent = new TacticalBrain().decide(input, createRng(1));
    expect(intent.path).toEqual(['n-soma-split']);
    expect(intent.breachApproachId).toBe('sf-division');
    expect(intent.reason).toContain('Battering');
  });

  it('ATTACK switches from a sealed door when a known open alternative is quicker', () => {
    const input = inputFor(graph, 'ATTACK', 'n-soma-split');
    const heatScale = input.cfg.monster.minEdgeMs / input.cfg.monster.maxEdgeMs;
    input.cfg.doors.heatPerSecClosed *= heatScale;
    input.cfg.doors.heatPerSecBattered *= heatScale;
    input.knowledge.hqId = 'hq-sf';
    input.knowledge.knownDoors = {
      'sf-division': { closed: true, jammed: false, seenAt: input.knowledge.t },
      'sf-embarcadero': { closed: false, jammed: false, seenAt: input.knowledge.t },
    };
    const intent = new TacticalBrain().decide(input, createRng(1));
    expect(intent.breachApproachId).toBe('sf-embarcadero');
    expect(intent.path.at(-1)).toBe('n-bay-bridge-sf');
  });

  it('RETREAT moves away from HQ and recovers at a remote safe node', () => {
    const input = inputFor(graph, 'RETREAT', 'n-univ-84');
    input.knowledge.trapEncounters = [{ nodeId: 'n-univ-84', t: input.knowledge.t }];
    const brain = new TacticalBrain();
    const intent = brain.decide(input, createRng(1));
    expect(graph.hopsToHq(intent.path.at(-1)!, input.knowledge.hqId)).toBeGreaterThan(0);
    expect(intent.breachApproachId).toBeNull();
    const farthest = [...graph.nodes.keys()].sort((a, b) => graph.hopsToHq(b, input.knowledge.hqId) - graph.hopsToHq(a, input.knowledge.hqId))[0];
    input.knowledge.position.nodeId = farthest;
    input.knowledge.recentNodes = [farthest];
    input.knowledge.trapEncounters = [];
    for (const n of Object.keys(input.knowledge.cameraStatusByNode)) input.knowledge.cameraStatusByNode[n] = 'blackout';
    const recovered = brain.decide(input, createRng(1));
    expect(recovered.path).toEqual([farthest]);
    expect(recovered.reason).toContain('recovering');
  });

  it.each<MonsterStance>(['HUNT', 'HIDE', 'FLANK', 'ATTACK', 'RETREAT'])('%s cannot walk or breach while held', (stance) => {
    const input = inputFor(graph, stance);
    input.knowledge.held = true;
    const intent = new TacticalBrain().decide(input, createRng(1));
    expect(intent.path).toEqual([input.knowledge.position.nodeId]);
    expect(intent.breachApproachId).toBeNull();
  });

  it('every stance yields adjacent paths for every HQ, including mid-edge replans', () => {
    for (const hq of NETWORK.headquarters) for (const stance of ['HUNT', 'HIDE', 'FLANK', 'ATTACK', 'RETREAT'] as const) {
      const input = inputFor(graph, stance, 'n-hillsdale');
      input.knowledge.hqId = hq.id;
      const edge = graph.adj.get('n-hillsdale')![0];
      input.knowledge.position.moving = { from: 'n-hillsdale', to: edge.to, edgeId: edge.edge.id, progress: 0.4 };
      const intent = new TacticalBrain().decide(input, createRng(1));
      expect(assertPath(graph, intent.path)).toBe(true);
      expect(['n-hillsdale', edge.to]).toContain(intent.path[0]);
      if (intent.breachApproachId) expect(hq.approaches.some((ap) => ap.id === intent.breachApproachId)).toBe(true);
    }
  });
});

describe('explicit SABOTAGE / DECOY positioning', () => {
  const graph = new Graph(NETWORK);
  it.each<AbilityOrder>([
    { type: 'sabotage', nodeId: 'n-univ-84', target: 'camera' },
    { type: 'decoy', nodeId: 'n-univ-84' },
  ])('approaches within range for $type and returns the requested action only when ready', (order) => {
    const input = inputFor(graph, 'HIDE', 'n-san-rafael');
    const brain = new TacticalBrain();
    const plan = brain.planAbility(input, order);
    const range = order.type === 'decoy' ? input.cfg.monster.decoyRangeHops : input.cfg.monster.sabotageRangeHops;
    expect(plan.stage).toBe('position');
    expect(assertPath(graph, plan.path)).toBe(true);
    expect(graph.hops(plan.path.at(-1)!, order.nodeId)).toBeLessThanOrEqual(range);
    expect(plan.action).toBeUndefined();
    expect(plan.breachApproachId).toBeNull();
    input.knowledge.position.nodeId = plan.path.at(-1)!;
    const ready = brain.planAbility(input, order);
    expect(ready.stage).toBe('ready');
    expect(ready.action).toEqual(order);
  });

  it.each<AbilityOrder>([
    { type: 'sabotage', nodeId: 'n-univ-84', target: 'camera' },
    { type: 'decoy', nodeId: 'n-univ-84' },
  ])('respects $type cooldown and does not move away to fire prematurely', (order) => {
    const input = inputFor(graph, 'HUNT');
    input.knowledge.cooldowns = { SABOTAGE: input.knowledge.t + 1, DECOY: input.knowledge.t + 1 };
    const plan = new TacticalBrain().planAbility(input, order);
    expect(plan.stage).toBe('cooldown');
    expect(plan.path).toEqual([input.knowledge.position.nodeId]);
    expect(plan.action).toBeUndefined();
  });

  it('never targets an unknown sensor or emits a decoy onto a dead feed', () => {
    const input = inputFor(graph, 'HUNT', 'n-univ-84'), brain = new TacticalBrain();
    const order: AbilityOrder = { type: 'sabotage', nodeId: 'n-univ-84', target: 'sensor' };
    expect(brain.planAbility(input, order).stage).toBe('invalid');
    input.knowledge.knownSensors = [{ id: 'known', nodeId: order.nodeId, seenAt: input.knowledge.t, disabled: false }];
    expect(brain.planAbility(input, order).stage).toBe('ready');
    input.knowledge.cameraStatusByNode[order.nodeId] = 'sabotaged';
    expect(brain.planAbility(input, { type: 'decoy', nodeId: order.nodeId }).stage).toBe('invalid');
  });

  it('uses the engine rule allowing an in-range DECOY while held, with no positioning movement', () => {
    const input = inputFor(graph, 'RETREAT', 'n-univ-84'), brain = new TacticalBrain();
    input.knowledge.held = true;
    expect(brain.planAbility(input, { type: 'decoy', nodeId: 'n-univ-84' }).stage).toBe('ready');
    const distant = brain.planAbility(input, { type: 'decoy', nodeId: 'n-san-rafael' });
    expect(distant.stage).toBe('invalid');
    expect(distant.path).toEqual(['n-univ-84']);
    expect(brain.planAbility(input, { type: 'sabotage', nodeId: 'n-univ-84', target: 'camera' }).stage).toBe('invalid');
  });

  it('does not assume ambiguous repairing/outage camera states are valid sabotage targets', () => {
    const input = inputFor(graph, 'HUNT', 'n-univ-84'), brain = new TacticalBrain();
    for (const status of ['repairing', 'blackout'] as const) {
      input.knowledge.cameraStatusByNode['n-univ-84'] = status;
      expect(brain.planAbility(input, { type: 'sabotage', nodeId: 'n-univ-84', target: 'camera' }).stage).toBe('invalid');
    }
    input.knowledge.cameraStatusByNode['n-univ-84'] = 'ok';
    input.knowledge.cooldowns = undefined;
    expect(brain.planAbility(input, { type: 'decoy', nodeId: 'n-univ-84' }).stage).toBe('cooldown');
  });
});

describe('adaptation, determinism and tactical variation', () => {
  it('reduces caution as aggression and time pressure increase without changing the command', () => {
    const input = inputFor(diamond(), 'HUNT', 'start');
    input.cfg.monster.tactical = { exposureMs: 10 * input.cfg.monster.msPerKm };
    input.knowledge.cameraStatusByNode.blind = 'sabotaged';
    const cautious = new TacticalBrain().decide(input, createRng(1));
    input.aggression = 1.4;
    input.knowledge.phase = 'final';
    input.knowledge.remainingMs = 10_000;
    const urgent = new TacticalBrain().decide(input, createRng(1));
    expect(cautious.path).toContain('blind');
    expect(urgent.path).toContain('watched');
    expect(input.knowledge.stance).toBe('HUNT');
  });

  it('produces identical intent histories for the same seed and changing inputs', () => {
    const graph = new Graph(NETWORK);
    const run = () => {
      const input = inputFor(graph), brain = new TacticalBrain(), rng = createRng(720);
      input.cfg.monster.unpredictability = 0.12;
      return Array.from({ length: 80 }, (_, i) => {
        input.knowledge.t += 2_500;
        input.knowledge.position.nodeId = NETWORK.nodes[i % NETWORK.nodes.length].id;
        input.knowledge.recentNodes.push(input.knowledge.position.nodeId);
        input.knowledge.recentNodes = input.knowledge.recentNodes.slice(-8);
        input.knowledge.stance = (['HUNT', 'HIDE', 'FLANK', 'ATTACK', 'RETREAT'] as const)[i % 5];
        return brain.decide(input, rng);
      });
    };
    expect(run()).toEqual(run());
  });

  it('uses a seeded alternate plan about 10–20% of the time when comparable choices exist', () => {
    const graph = diamond();
    graph.hqs.get('hq-sf')!.approaches = [
      { id: 'left', door: 'Left', fromNode: 'watched', label: 'Left' },
      { id: 'right', door: 'Right', fromNode: 'blind', label: 'Right' },
    ];
    const input = inputFor(graph, 'HUNT', 'start');
    input.aggression = 1;
    input.cfg.monster.unpredictability = 0.12;
    for (const n of Object.keys(input.knowledge.cameraStatusByNode)) input.knowledge.cameraStatusByNode[n] = 'blackout';
    let alternate = 0;
    for (let seed = 0; seed < 1_000; seed++)
      if (new TacticalBrain().decide(input, createRng(seed)).path.at(-1) === 'blind') alternate++;
    expect(alternate).toBeGreaterThan(80);
    expect(alternate).toBeLessThan(220);
  });
});
