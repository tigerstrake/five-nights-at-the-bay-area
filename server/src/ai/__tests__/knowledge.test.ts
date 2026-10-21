import { describe, expect, it } from 'vitest';
import { createRng, type MonsterStance } from '@fnab/shared';
import { buildMonsterKnowledge } from '../knowledge';
import { TacticalBrain } from '../tacticalBrain';
import { applyAction } from '../../engine/engine';
import { pushEvent } from '../../engine/state';
import { projectDefenderView, projectMonsterView } from '../../visibility';
import { RoomManager } from '../../rooms/RoomManager';
import { harness, testCfg } from '../../../test/fixtures';

const M = { team: 'monster' as const, playerId: 'm' };
const D = { team: 'defenders' as const, playerId: 'd' };
const clock = { t0Epoch: 0, serverNow: 0 };

describe('monster knowledge boundary', () => {
  it.each<MonsterStance>(['HUNT', 'HIDE', 'FLANK', 'ATTACK', 'RETREAT'])('%s cannot depend on hidden traps, sensors, doors, sightings or exact power', (stance) => {
    const h = harness();
    h.run(20_000);
    h.s.monster.stance = stance;
    const clear = structuredClone(h.s), hidden = structuredClone(h.s);
    hidden.traps.push({ id: 'secret-trap', nodeId: 'a', armedAt: 0 });
    hidden.sensors.push({ id: 'secret-sensor', nodeId: 'b', disabledUntil: null, lastPingAt: null });
    hidden.doors.A1.closed = true;
    hidden.doors.A2.heat = 0.9;
    hidden.power.value -= 1; // Same legitimate coarse power band.
    hidden.scan.last = { nodeId: 'f', t: hidden.t, radiusHops: 1, found: false };
    hidden.sightings.push({ id: 500, nodeId: 'a', t: hidden.t, confidence: 1, source: 'camera', isDecoy: false, flaggedFalse: false });
    pushEvent(hidden, 'trapArmed', 'defenders', 'Trap armed', { nodeId: 'a' });
    pushEvent(hidden, 'sensorPing', 'defenders', 'Sensor ping', { nodeId: 'b' });
    const a = buildMonsterKnowledge(clear, h.graph), b = buildMonsterKnowledge(hidden, h.graph);
    expect(b).toEqual(a);
    const left = new TacticalBrain(), right = new TacticalBrain(), r1 = createRng(42), r2 = createRng(42);
    for (let i = 0; i < 8; i++) {
      a.t += 2_500;
      b.t += 2_500;
      expect(left.decide({ graph: h.graph, cfg: h.s.cfg, knowledge: a, aggression: 1 }, r1))
        .toEqual(right.decide({ graph: h.graph, cfg: h.s.cfg, knowledge: b, aggression: 1 }, r2));
    }
  });

  it('does not query the hidden sensor collection to update a previously discovered sensor', () => {
    const h = harness();
    h.s.monster.knowledge.knownSensors.seen = { nodeId: 'f', seenAt: 1 };
    const before = buildMonsterKnowledge(h.s, h.graph);
    h.s.sensors.push({ id: 'seen', nodeId: 'f', disabledUntil: 100_000, lastPingAt: null });
    expect(buildMonsterKnowledge(h.s, h.graph)).toEqual(before);
    expect(projectMonsterView(h.ctx, h.s, clock).knownSensors[0].disabledUntil).toBeNull();
    h.s.sensors = [];
    expect(buildMonsterKnowledge(h.s, h.graph)).toEqual(before);
  });

  it('remembers its own successful sensor sabotage and its known expiry', () => {
    const h = harness();
    h.run(20_000);
    applyAction(h.ctx, h.s, D, { type: 'placeSensor', nodeId: 'a' }, h.rng);
    const sensor = h.s.sensors[0];
    h.s.monster.knowledge.knownSensors[sensor.id] = { nodeId: 'a', seenAt: h.s.t };
    expect(applyAction(h.ctx, h.s, M, { type: 'sabotage', target: 'sensor', nodeId: 'a' }, h.rng).ok).toBe(true);
    const k = buildMonsterKnowledge(h.s, h.graph);
    expect(k.knownSensors[0].disabled).toBe(true);
    expect(k.knownSensors[0].disabledUntil).toBe(h.s.t + h.s.cfg.monster.sensorSabotageDurationMs);
    const remembered = projectMonsterView(h.ctx, h.s, clock).knownSensors[0].disabledUntil;
    sensor.disabledUntil = h.s.t + 999_999; // An unobserved remote change cannot alter our memory or view.
    expect(projectMonsterView(h.ctx, h.s, clock).knownSensors[0].disabledUntil).toBe(remembered);
    h.s.t = remembered!;
    expect(buildMonsterKnowledge(h.s, h.graph).knownSensors[0].disabled).toBe(false);
  });

  it('retains trap encounters only after the game actually tells the monster it was trapped', () => {
    const h = harness();
    pushEvent(h.s, 'trapArmed', 'defenders', 'Secret', { nodeId: 'a' });
    expect(buildMonsterKnowledge(h.s, h.graph).trapEncounters).toEqual([]);
    pushEvent(h.s, 'trapTriggered', 'all', 'Caught', { nodeId: 'a' });
    expect(buildMonsterKnowledge(h.s, h.graph).trapEncounters).toEqual([{ nodeId: 'a', t: 0 }]);
    h.s.t += h.s.cfg.visibility.monsterMemoryMs;
    expect(buildMonsterKnowledge(h.s, h.graph).trapEncounters).toEqual([]);
  });

  it('copies mutable observations so a brain cannot mutate the authoritative state', () => {
    const h = harness();
    const original = h.s.monster.knowledge;
    original.knownDoors.A1 = { closed: true, jammed: false, seenAt: 1 };
    original.disturbances.push({ nodeId: 'a', t: 1, expiresAt: 10_000 });
    original.scanPulses.push({ nodeId: 'a', t: 1 });
    original.exposures.push({ nodeId: 'a', t: 1 });
    const before = structuredClone(h.s), k = buildMonsterKnowledge(h.s, h.graph);
    k.knownDoors.A1.closed = false;
    k.disturbances[0].nodeId = 'f';
    k.scanPulses[0].t = 50;
    k.exposures[0].nodeId = 'f';
    k.cooldowns!.DECOY = 999;
    expect(h.s).toEqual(before);
  });

  it('a tactical decision does not mutate its input', () => {
    const h = harness();
    h.run(20_000);
    const k = buildMonsterKnowledge(h.s, h.graph), before = structuredClone(k);
    new TacticalBrain().decide({ graph: h.graph, cfg: h.s.cfg, knowledge: k, aggression: 1 }, h.rng);
    expect(k).toEqual(before);
  });
});

describe('tactical engine integration', () => {
  it('production rooms create TacticalBrain by default', () => {
    const h = harness(), rm = new RoomManager({ graph: h.graph, cfg: h.s.cfg, now: () => 0, placementCount: () => 1 });
    const a = rm.create('Monster');
    if (!a.ok) throw new Error('create failed');
    const b = rm.join(a.code, 'Defender');
    if (!b.ok) throw new Error('join failed');
    rm.setReady(a.code, a.playerId, true);
    rm.setReady(a.code, b.playerId, true);
    rm.tick(0);
    rm.tick(h.s.cfg.match.countdownMs + h.s.cfg.tickMs);
    expect(rm.rooms.get(a.code)!.match!.ctx.brain).toBeInstanceOf(TacticalBrain);
  });

  it('feedback reaches only the monster view through the existing command log', () => {
    const h = harness();
    h.ctx.brain = new TacticalBrain();
    h.run(20_000);
    const mv = projectMonsterView(h.ctx, h.s, clock), dv = projectDefenderView(h.ctx, h.s, clock);
    expect(mv.events.some((e) => e.kind === 'command' && e.text.includes('HUNT:'))).toBe(true);
    expect(dv.events.some((e) => e.kind === 'command')).toBe(false);
  });

  it('RETREAT while trapped struggles under engine rules and recovers after release', () => {
    const h = harness({ cfg: testCfg((c) => { c.monster.unpredictability = 0; }) });
    h.ctx.brain = new TacticalBrain();
    applyAction(h.ctx, h.s, D, { type: 'armTrap', nodeId: 'a' }, h.rng);
    h.run(20_000);
    applyAction(h.ctx, h.s, M, { type: 'command', command: 'ATTACK', approachId: 'A1' }, h.rng);
    expect(h.runUntil((s) => !!s.monster.held)).toBe(true);
    expect(applyAction(h.ctx, h.s, M, { type: 'command', command: 'RETREAT' }, h.rng).ok).toBe(true);
    expect(h.s.monster.held?.struggling).toBe(true);
    expect(h.s.monster.stance).toBe('RETREAT');
    h.runUntil((s) => !s.monster.held);
    h.run(200);
    expect(h.s.monster.breachApproachId).toBeNull();
    expect(h.s.monster.lastReason).toContain('RETREAT:');
    expect(buildMonsterKnowledge(h.s, h.graph).trapEncounters?.[0].nodeId).toBe('a');
  });
});
