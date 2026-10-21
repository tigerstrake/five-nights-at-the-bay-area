import { describe, expect, it } from 'vitest';
import { createRng, scaleForDefenders, type GameAction } from '@fnab/shared';
import { applyAction, endMatch, step } from './engine';
import { pushEvent } from './state';
import { projectDefenderView, projectMonsterView } from '../visibility';
import { harness, testCfg } from '../../test/fixtures';

const M = { team: 'monster' as const, playerId: 'm' }, D = { team: 'defenders' as const, playerId: 'd' };
const clock = { t0Epoch: 0, serverNow: 0 };

describe('review regressions: engine and visibility', () => {
  it('2 queues initial and follow-up decoys onto real detection boundaries', () => {
    const h = harness({ cfg: testCfg(c => { c.detection.baseChance = 0; c.detection.arrivalBonus = 0; }) });
    h.run(20_500);
    const before = projectDefenderView(h.ctx, h.s, clock);
    expect(applyAction(h.ctx, h.s, M, { type: 'decoy', nodeId: 'b' }, h.rng).ok).toBe(true);
    expect(projectDefenderView(h.ctx, h.s, clock)).toEqual(before);
    h.run(400);
    expect(h.s.sightings).toHaveLength(0);
    h.run(100);
    expect(h.s.sightings[0]).toMatchObject({ t: 21_000, isDecoy: true });
    h.run(7000);
    expect(h.s.sightings.filter(x => x.isDecoy)).toHaveLength(2);
    expect(h.s.sightings.every(x => (x.t - 20_000) % h.s.cfg.detection.rollEveryMs === 0)).toBe(true);
  });

  it('3 exposes opaque stable ids and neutral same-tick ordering for events and sightings', () => {
    const orders = new Set<boolean>(), eventOrders = new Set<boolean>();
    for (let seed = 1; seed <= 40; seed++) {
      const h = harness({ seed });
      h.s.sightings.push(
        { id: h.s.nextId++, nodeId: 'a', t: 0, confidence: 0.5, source: 'camera', flaggedFalse: false, isDecoy: false },
        { id: h.s.nextId++, nodeId: 'b', t: 0, confidence: 0.5, source: 'camera', flaggedFalse: false, isDecoy: true },
      );
      pushEvent(h.s, 'sighting', 'defenders', 'Movement', { nodeId: 'a' });
      pushEvent(h.s, 'sighting', 'defenders', 'Movement', { nodeId: 'b' });
      const v = projectDefenderView(h.ctx, h.s, clock);
      expect(v).toEqual(projectDefenderView(h.ctx, h.s, clock));
      expect(v.sightings.every(x => Number.isSafeInteger(x.id) && x.id > h.s.nextId)).toBe(true);
      expect(new Set(v.sightings.map(x => x.id)).size).toBe(2);
      orders.add(v.sightings[0].nodeId === 'a');
      eventOrders.add(v.events[0].nodeId === 'a');
      expect(v.sightings[0].id).toBeLessThan(v.sightings[1].id);
    }
    expect(orders.size).toBe(2);
    expect(eventOrders.size).toBe(2);
  });

  it.each(['toString', 'constructor', '__proto__', 'valueOf'])('4 rejects inherited keys %s for every keyed action without throwing', key => {
    const h = harness(); h.run(20_000);
    const defender: GameAction[] = [
      { type: 'door', approachId: key, closed: true }, { type: 'repair', cameraId: key },
      { type: 'scan', nodeId: key }, { type: 'armTrap', nodeId: key }, { type: 'placeSensor', nodeId: key },
      { type: 'lure', nodeId: key }, { type: 'removeSensor', sensorId: key }, { type: 'disarmTrap', trapId: key },
    ];
    for (const action of defender) expect(applyAction(h.ctx, h.s, D, action, h.rng).ok).toBe(false);
    for (const action of [
      { type: 'command', command: 'ATTACK', approachId: key }, { type: 'sabotage', nodeId: key, target: 'camera' },
      { type: 'sabotage', nodeId: key, target: 'sensor' }, { type: 'decoy', nodeId: key }, { type: 'chooseSpawn', nodeId: key },
    ] as GameAction[]) expect(applyAction(h.ctx, h.s, M, action, h.rng).ok).toBe(false);
  });

  it('5 suppresses no-op commands and bounds event retention even between steps', () => {
    const h = harness({ cfg: testCfg(c => { c.visibility.maxRetainedEvents = 12; }) }); h.run(20_000);
    applyAction(h.ctx, h.s, M, { type: 'command', command: 'ATTACK' }, h.rng);
    const count = h.s.events.length, issued = h.s.stats.commandsIssued;
    for (let i = 0; i < 1000; i++) applyAction(h.ctx, h.s, M, { type: 'command', command: 'ATTACK' }, h.rng);
    expect(h.s.events).toHaveLength(count); expect(h.s.stats.commandsIssued).toBe(issued);
    for (let i = 0; i < 100; i++) applyAction(h.ctx, h.s, D, { type: 'door', approachId: 'A1', closed: i % 2 === 0 }, h.rng);
    // A same-tick flood is evicted as one whole batch rather than retaining a creation-order suffix.
    expect(h.s.events).toHaveLength(0);
    h.s.t += h.s.cfg.tickMs;
    applyAction(h.ctx, h.s, D, { type: 'door', approachId: 'A1', closed: true }, h.rng);
    expect(h.s.events).toHaveLength(1);
    expect(h.s.events.every(x => x.by === 'd')).toBe(true);
  });

  it('evicts simultaneous real and decoy events together after 59 accepted door toggles', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const h = harness({ seed }); h.run(20_000);
      h.s.events = [];
      pushEvent(h.s, 'sighting', 'defenders', 'Movement', { nodeId: 'a' });
      pushEvent(h.s, 'sighting', 'defenders', 'Movement', { nodeId: 'b' });
      for (let i = 0; i < 62; i++) {
        const contacts = projectDefenderView(h.ctx, h.s, clock).events.filter(e => e.kind === 'sighting');
        expect([0, 2]).toContain(contacts.length);
        h.s.t += h.s.cfg.tickMs;
        expect(applyAction(h.ctx, h.s, D, { type: 'door', approachId: 'A1', closed: i % 2 === 0 }, h.rng).ok).toBe(true);
      }
    }
  });

  it('authoritative retention drops whole simultaneous batches and never readmits a same-tick suffix', () => {
    const h = harness({ cfg: testCfg(c => { c.visibility.maxRetainedEvents = 4; }) });
    pushEvent(h.s, 'sighting', 'defenders', 'Real', { nodeId: 'a' });
    pushEvent(h.s, 'sighting', 'defenders', 'Decoy', { nodeId: 'b' });
    for (let i = 0; i < 3; i++) { h.s.t++; pushEvent(h.s, 'info', 'all', 'Newer'); }
    expect(h.s.events.map(e => e.text)).toEqual(['Newer', 'Newer', 'Newer']);
    h.s.t++;
    for (let i = 0; i < 10; i++) pushEvent(h.s, 'info', 'all', 'Flood');
    expect(h.s.events).toHaveLength(0);
    h.s.t++;
    pushEvent(h.s, 'info', 'all', 'Next tick');
    expect(h.s.events.map(e => e.text)).toEqual(['Next tick']);
  });

  it('retains and projects simultaneous real and decoy sightings as whole batches', () => {
    const h = harness({ cfg: testCfg(c => {
      c.visibility.maxRetainedSightings = 3; c.visibility.sightingsInView = 1;
      c.detection.baseChance = 10;
    }) });
    h.run(20_000);
    for (let batch = 0; batch < 4; batch++) {
      h.s.monster.pendingDecoys.push({ nodeId: 'b', at: h.s.t });
      h.run(h.s.cfg.detection.rollEveryMs);
      expect(h.s.sightings).toHaveLength(2);
      expect(h.s.sightings.filter(s => s.isDecoy)).toHaveLength(1);
      expect(new Set(h.s.sightings.map(s => s.t)).size).toBe(1);
      expect(projectDefenderView(h.ctx, h.s, clock).sightings).toHaveLength(0);
    }
  });

  it('sensor confidence is identical at the occupied node and adjacent nodes through movement and projection', () => {
    const h = harness();
    for (const nodeId of ['a', 's1', 'b', 'd']) {
      expect(applyAction(h.ctx, h.s, D, { type: 'placeSensor', nodeId }, h.rng).ok).toBe(true);
    }
    h.run(20_000);
    expect(h.runUntil(s => s.monster.nodeId === 'a', 30_000)).toBe(true);
    const v = projectDefenderView(h.ctx, h.s, clock);
    const pings = v.sightings.filter(s => s.source === 'sensor');
    expect(pings.map(s => s.nodeId).sort()).toEqual(['a', 'b', 'd', 's1']);
    expect(new Set(pings.map(s => s.confidence))).toEqual(new Set([h.s.cfg.sensors.confidence]));
    expect(pings.every(s => s.t === h.s.monster.arrivedAt)).toBe(true);
  });

  it('6 real and decoy confidence share the full distribution, including HIDE caps', () => {
    for (const stance of ['HUNT', 'HIDE'] as const) {
      const h = harness({ cfg: testCfg(c => { c.detection.baseChance = 10; c.detection.rollEveryMs = 100; }) }); h.run(20_000);
      h.s.monster.stance = stance; h.s.monster.moving = null; h.s.monster.path = []; h.s.monster.nextDecisionAt = Infinity;
      for (let i = 0; i < 100; i++) { h.s.monster.pendingDecoys.push({ nodeId: 'b', at: h.s.t }); h.run(100); }
      const real = h.s.sightings.filter(x => !x.isDecoy), fake = h.s.sightings.filter(x => x.isDecoy);
      for (const samples of [real, fake]) {
        expect(samples.some(x => x.confidence < 0.55)).toBe(true);
        expect(samples.every(x => x.confidence >= 0.45 && x.confidence <= (stance === 'HIDE' ? 0.6 : 0.95))).toBe(true);
      }
    }
  });

  it('extra cosmetic seeds use opaque sighting ids rather than a simulation RNG output', () => {
    const h = harness({ cfg: testCfg(c => { c.detection.baseChance = 10; c.detection.rollEveryMs = 100; }) });
    h.run(20_100);
    h.s.monster.pendingDecoys.push({ nodeId: 'b', at: h.s.t }); h.run(100);
    const v = projectDefenderView(h.ctx, h.s, clock);
    for (const camera of v.cameras.filter(c => c.manifestation)) {
      const sighting = [...v.sightings].reverse().find(x => x.nodeId === camera.nodeId)!;
      expect(camera.manifestation!.seed).toBe(sighting.id % 2 ** 31);
    }
  });

  it.each([false, true])('extra post-match decoy annotations survive sighting pruning=%s without marking same-time real events false', prune => {
    const h = harness({ cfg: testCfg(c => { c.detection.baseChance = 0; c.detection.arrivalBonus = 0; }) });
    h.run(20_000);
    applyAction(h.ctx, h.s, M, { type: 'decoy', nodeId: 'b' }, h.rng); h.run(1000);
    pushEvent(h.s, 'sighting', 'defenders', 'Real contact', { nodeId: 'b' });
    expect(JSON.stringify(projectDefenderView(h.ctx, h.s, clock))).not.toContain('"decoy":');
    if (prune) h.s.sightings = [];
    endMatch(h.s, 'defenders', 'timer');
    const events = h.s.result!.timeline.filter(e => e.kind === 'sighting' && e.nodeId === 'b');
    expect(events).toHaveLength(2);
    expect(events.filter(e => e.text.endsWith('[DECOY]'))).toHaveLength(1);
  });

  it('7 sends remote door jams only to defenders and nearby jams to both teams', () => {
    for (const nearby of [false, true]) {
      const h = harness(); h.run(20_000);
      h.s.monster.moving = null; h.s.monster.nodeId = nearby ? 'b' : 's1'; h.s.monster.nextDecisionAt = Infinity;
      h.s.monster.knowledge.knownDoors.A1 = { closed: true, jammed: false, seenAt: 0 };
      h.s.doors.A1.closed = true; h.s.doors.A1.heat = 1;
      h.run(100);
      expect(projectDefenderView(h.ctx, h.s, clock).events.some(e => e.kind === 'doorJammed')).toBe(true);
      expect(projectMonsterView(h.ctx, h.s, clock).events.some(e => e.kind === 'doorJammed')).toBe(nearby);
    }
  });

  it('9 all monster abilities share one command gap and rejected attempts do not consume it', () => {
    const h = harness(); h.run(20_000);
    expect(applyAction(h.ctx, h.s, M, { type: 'sabotage', nodeId: 's1', target: 'camera' }, h.rng).ok).toBe(true);
    expect(applyAction(h.ctx, h.s, M, { type: 'decoy', nodeId: 'b' }, h.rng)).toMatchObject({ ok: false, error: expect.stringContaining('Too fast') });
    expect(applyAction(h.ctx, h.s, M, { type: 'command', command: 'ATTACK' }, h.rng).ok).toBe(false);
    h.run(h.s.cfg.monster.globalCommandGapMs);
    expect(applyAction(h.ctx, h.s, M, { type: 'decoy', nodeId: 'missing' }, h.rng).ok).toBe(false);
    expect(applyAction(h.ctx, h.s, M, { type: 'decoy', nodeId: 'b' }, h.rng).ok).toBe(true);
    expect(applyAction(h.ctx, h.s, M, { type: 'command', command: 'ATTACK' }, h.rng).ok).toBe(false);
  });

  it.each([1, 2, 3, 4])('12 struggle progresses identically after one RETREAT or spam for %i defenders', count => {
    const cfg = scaleForDefenders(count, testCfg());
    const make = () => {
      const h = harness({ cfg }); h.run(20_000);
      h.s.monster.moving = null; h.s.monster.nodeId = 'a';
      h.s.monster.held = { until: h.s.t + cfg.traps.holdMs, contained: true, struggling: false, struggle: 0 };
      applyAction(h.ctx, h.s, D, { type: 'containment', engage: true }, h.rng);
      applyAction(h.ctx, h.s, M, { type: 'command', command: 'RETREAT' }, h.rng);
      return h;
    };
    const once = make(), spam = make();
    for (let i = 0; i < 50; i++) {
      applyAction(spam.ctx, spam.s, M, { type: 'command', command: 'RETREAT' }, spam.rng);
      once.run(100); spam.run(100);
    }
    expect(spam.s).toEqual(once.s);
    expect(spam.s.monster.held?.struggle).toBeCloseTo(5000 / cfg.containment.struggleBreakMs * cfg.containment.containedStruggleMult * (cfg.containment.phaseStruggleMult?.infiltration ?? 1));
    expect(spam.s.events.filter(e => e.kind === 'struggle')).toHaveLength(1);
    once.run(20_000); spam.run(20_000);
    expect(spam.s.result).toEqual(once.s.result);
  });

  it('11 pure engine holds position and timers when monster connection is lost', () => {
    const h = harness(); h.run(21_000); h.s.monsterDisconnected = true;
    const before = structuredClone(h.s);
    step(h.ctx, h.s, 1000, createRng(3));
    expect(h.s).toEqual(before);
  });

  it('12 final-assault containment rewards a fast response and permits escape after a slow response', () => {
    const result = (delay: number) => {
      const h = harness(); h.run(20_000);
      h.s.t = h.s.prepMs + h.s.durationMs * 0.75 + 100; h.s.phase = 'final';
      h.s.monster.moving = null; h.s.monster.nodeId = 'a';
      h.s.monster.held = { until: h.s.t + 8000, contained: false, struggling: false, struggle: 0 };
      applyAction(h.ctx, h.s, M, { type: 'command', command: 'RETREAT' }, h.rng);
      h.run(delay); applyAction(h.ctx, h.s, D, { type: 'containment', engage: true }, h.rng);
      h.runUntil(s => !!s.result || !s.monster.held, 20_000);
      return h.s;
    };
    expect(result(2000).result?.reason).toBe('capture');
    const escaped = result(5000);
    expect(escaped.result).toBeNull(); expect(escaped.monster.held).toBeNull();
  });
});
