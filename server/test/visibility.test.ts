import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/engine/engine';
import { projectDefenderView, projectMonsterView, projectSpectatorView } from '../src/visibility';
import { harness, testCfg } from './fixtures';

const D = { team: 'defenders' as const, playerId: 'd1' };
const M = { team: 'monster' as const, playerId: 'm1' };
const clock = { t0Epoch: 1_000_000, serverNow: 1_000_000 };

function deepKeys(o: unknown, out = new Set<string>()): Set<string> {
  if (o && typeof o === 'object')
    for (const [k, v] of Object.entries(o)) {
      out.add(k);
      deepKeys(v, out);
    }
  return out;
}

describe('defender view (anti-cheat)', () => {
  it('never contains the monster position, path, stance, cooldowns or decoy flags', () => {
    const h = harness({
      cfg: testCfg((c) => {
        c.detection.baseChance = 0;
        c.detection.arrivalBonus = 0;
      }),
    });
    h.run(20_500);
    applyAction(h.ctx, h.s, M, { type: 'command', command: 'HIDE' }, h.rng);
    h.run(h.s.cfg.monster.globalCommandGapMs);
    applyAction(h.ctx, h.s, M, { type: 'decoy', nodeId: 'b' }, h.rng);
    h.run(3_000);
    for (const v of [projectDefenderView(h.ctx, h.s, clock), projectSpectatorView(h.ctx, h.s, clock)]) {
      const keys = deepKeys(v);
      for (const forbidden of [
        'isDecoy',
        'stance',
        'path',
        'moving',
        'self',
        'knowledge',
        'cooldowns.HIDE',
        'monster',
        'pendingDecoys',
        'exposures',
        'spawnChoice',
      ]) {
        expect(keys.has(forbidden)).toBe(false);
      }
      const json = JSON.stringify(v);
      expect(json).not.toContain('HIDE');
      expect(json).not.toContain('isDecoy');
      expect(v.held).toBeNull();
      // the decoy sighting is present and looks like any other camera sighting
      const sg = v.sightings.find((x) => x.nodeId === 'b');
      expect(sg).toMatchObject({ source: 'camera', flaggedFalse: false });
      // camera events never mention the monster's actual node via ability text
      expect(v.events.some((e) => e.kind === 'ability' || e.kind === 'command')).toBe(false);
    }
  });

  it('decoy and real sightings serialise with identical shapes', () => {
    const h = harness({
      cfg: testCfg((c) => {
        c.detection.baseChance = 1;
      }),
    });
    h.run(22_000); // real sightings at s1
    applyAction(h.ctx, h.s, M, { type: 'decoy', nodeId: 'b' }, h.rng);
    h.run(h.s.cfg.detection.rollEveryMs);
    const v = projectDefenderView(h.ctx, h.s, clock);
    const real = v.sightings.find((x) => x.nodeId === 's1')!;
    const fake = v.sightings.find((x) => x.nodeId === 'b')!;
    expect(Object.keys(real).sort()).toEqual(Object.keys(fake).sort());
    const evReal = v.events.find((e) => e.kind === 'sighting' && e.nodeId === 's1')!;
    const evFake = v.events.find((e) => e.kind === 'sighting' && e.nodeId === 'b')!;
    expect(Object.keys(evReal).sort()).toEqual(Object.keys(evFake).sort());
  });

  it('reveals the monster node only while it is held', () => {
    const h = harness();
    applyAction(h.ctx, h.s, D, { type: 'armTrap', nodeId: 'a' }, h.rng);
    h.run(20_000);
    h.runUntil((s) => !!s.monster.held);
    expect(projectDefenderView(h.ctx, h.s, clock).held?.nodeId).toBe('a');
  });
});

describe('monster view (anti-cheat)', () => {
  it('never contains trap positions or undiscovered sensors or exact power', () => {
    const h = harness();
    applyAction(h.ctx, h.s, D, { type: 'armTrap', nodeId: 'e' }, h.rng);
    applyAction(h.ctx, h.s, D, { type: 'placeSensor', nodeId: 'f' }, h.rng);
    h.run(21_000);
    const v = projectMonsterView(h.ctx, h.s, clock);
    const keys = deepKeys(v);
    expect(keys.has('traps')).toBe(false);
    expect(keys.has('sensors')).toBe(false);
    expect(keys.has('sightings')).toBe(false);
    expect(keys.has('lastKnown')).toBe(false);
    expect(keys.has('power')).toBe(false);
    expect(v.knownSensors).toEqual([]);
    expect(JSON.stringify(v)).not.toContain('"e"'.replace('"e"', h.s.traps[0]!.id));
    expect(v.events.some((e) => e.kind === 'trapArmed' || e.kind === 'sensorPing' || e.kind === 'sighting')).toBe(false);
    expect(['high', 'medium', 'low', 'out']).toContain(v.powerLevel);
  });

  it('door states are only known after being observed nearby', () => {
    const h = harness({
      cfg: testCfg((c) => {
        c.monster.unpredictability = 0;
      }),
    });
    h.run(20_000);
    expect(projectMonsterView(h.ctx, h.s, clock).knownDoors).toEqual([]);
    applyAction(h.ctx, h.s, M, { type: 'command', command: 'ATTACK', approachId: 'A1' }, h.rng);
    h.runUntil((s) => !!s.monster.moving && s.monster.moving.to === 'b' && s.monster.moving.elapsed / s.monster.moving.duration > 0.95);
    applyAction(h.ctx, h.s, D, { type: 'door', approachId: 'A1', closed: true }, h.rng);
    h.runUntil((s) => s.monster.nodeId === 'b');
    const door = projectMonsterView(h.ctx, h.s, clock).knownDoors.find((d) => d.approachId === 'A1');
    expect(door?.closed).toBe(true);
  });
});
