import { describe, expect, it } from 'vitest';
import { applyAction, powerDrainPerSec } from '../src/engine/engine';
import { harness, testCfg } from './fixtures';

const D = { team: 'defenders' as const, playerId: 'd1' };
const M = { team: 'monster' as const, playerId: 'm1' };

describe('phases and timer', () => {
  it('runs preparation → infiltration → escalation → final → defenders win on timer', () => {
    const h = harness({
      cfg: testCfg((c) => {
        c.detection.baseChance = 0;
      }),
      durationMs: 300_000,
    });
    expect(h.s.phase).toBe('preparation');
    // keep monster away from HQ: retreat stance from the start
    applyAction(h.ctx, h.s, M, { type: 'command', command: 'HIDE' }, h.rng);
    h.run(20_100);
    expect(h.s.phase).toBe('infiltration');
    expect(h.s.monster.spawned).toBe(true);
    expect(h.s.monster.nodeId).toBe('s1');
    const phases = new Set<string>();
    // Force monster to keep retreating so it never breaches.
    h.runUntil((s) => {
      phases.add(s.phase);
      if (s.monster.stance !== 'RETREAT' && s.monster.cooldowns.RETREAT <= s.t && s.t - s.monster.lastCommandAt > 2000) {
        applyAction(h.ctx, s, M, { type: 'command', command: 'RETREAT' }, h.rng);
      }
      return !!s.result;
    });
    expect([...phases]).toEqual(expect.arrayContaining(['infiltration', 'escalation', 'final']));
    expect(h.s.result?.winner).toBe('defenders');
    expect(h.s.result?.reason).toBe('timer');
  });

  it('does not simulate monster movement during preparation', () => {
    const h = harness();
    h.run(10_000);
    expect(h.s.monster.spawned).toBe(false);
    expect(h.s.monster.nodeId).toBeNull();
  });
});

describe('monster commands and cooldowns', () => {
  it('ATTACK moves along the graph and breaches an open door → monster wins', () => {
    const h = harness({
      cfg: testCfg((c) => {
        c.monster.unpredictability = 0;
      }),
    });
    h.run(20_000);
    expect(applyAction(h.ctx, h.s, M, { type: 'command', command: 'ATTACK', approachId: 'A1' }, h.rng).ok).toBe(true);
    const visited: string[] = [];
    h.runUntil((s) => {
      if (s.monster.nodeId && visited[visited.length - 1] !== s.monster.nodeId) visited.push(s.monster.nodeId);
      return !!s.result;
    });
    expect(visited).toEqual(['s1', 'a', 'b', 'c']);
    expect(h.s.result?.winner).toBe('monster');
    expect(h.s.result?.reason).toBe('breach');
    expect(h.s.result?.approachId).toBe('A1');
  });

  it('enforces per-command cooldowns and the global command gap', () => {
    const h = harness();
    h.run(21_000);
    expect(applyAction(h.ctx, h.s, M, { type: 'command', command: 'HIDE' }, h.rng).ok).toBe(true);
    expect(applyAction(h.ctx, h.s, M, { type: 'command', command: 'FLANK' }, h.rng)).toMatchObject({ ok: false });
    h.run(2_000);
    expect(applyAction(h.ctx, h.s, M, { type: 'command', command: 'FLANK' }, h.rng).ok).toBe(true);
    h.run(2_000);
    expect(applyAction(h.ctx, h.s, M, { type: 'command', command: 'HIDE' }, h.rng)).toMatchObject({ ok: false, error: 'HIDE on cooldown' });
    h.run(15_000);
    expect(applyAction(h.ctx, h.s, M, { type: 'command', command: 'HIDE' }, h.rng).ok).toBe(true);
  });

  it('HIDE travels slower than ATTACK', () => {
    const time = (cmd: 'HIDE' | 'ATTACK') => {
      const h = harness({
        cfg: testCfg((c) => {
          c.detection.baseChance = 0;
          c.detection.arrivalBonus = 0;
        }),
      });
      h.run(20_000);
      applyAction(h.ctx, h.s, M, { type: 'command', command: cmd, approachId: 'A1' }, h.rng);
      const t0 = h.s.t;
      h.runUntil((s) => s.monster.nodeId === 'a');
      return h.s.t - t0;
    };
    expect(time('HIDE')).toBeGreaterThan(time('ATTACK'));
  });

  it('SABOTAGE disables an in-range camera; defenders repair it in 10 s for power', () => {
    const h = harness();
    h.run(20_500);
    expect(applyAction(h.ctx, h.s, M, { type: 'sabotage', nodeId: 'c', target: 'camera' }, h.rng)).toMatchObject({
      ok: false,
      error: 'Target out of range',
    });
    expect(applyAction(h.ctx, h.s, M, { type: 'sabotage', nodeId: 'a', target: 'camera' }, h.rng).ok).toBe(true);
    expect(h.s.cameras['cam-a']!.status).toBe('sabotaged');
    expect(applyAction(h.ctx, h.s, M, { type: 'sabotage', nodeId: 's1', target: 'camera' }, h.rng)).toMatchObject({
      ok: false,
      error: 'Too fast — the beast needs a moment',
    });
    const p0 = h.s.power.value;
    expect(applyAction(h.ctx, h.s, D, { type: 'repair', cameraId: 'cam-a' }, h.rng).ok).toBe(true);
    expect(h.s.power.value).toBeCloseTo(p0 - h.s.cfg.power.repairCost, 5);
    h.run(9_000);
    expect(h.s.cameras['cam-a']!.repair).not.toBeNull();
    h.run(1_100);
    expect(h.s.cameras['cam-a']!.status).toBe('ok');
    expect(h.s.cameras['cam-a']!.repair).toBeNull();
  });

  it('DECOY creates a sighting flagged only by a scan', () => {
    const h = harness({
      cfg: testCfg((c) => {
        c.detection.baseChance = 0;
        c.detection.arrivalBonus = 0;
      }),
    });
    h.run(20_500);
    expect(applyAction(h.ctx, h.s, M, { type: 'decoy', nodeId: 'b' }, h.rng).ok).toBe(true);
    h.run(h.s.cfg.detection.rollEveryMs);
    const sg = h.s.sightings.find((x) => x.nodeId === 'b');
    expect(sg?.isDecoy).toBe(true);
    expect(sg?.flaggedFalse).toBe(false);
    expect(applyAction(h.ctx, h.s, D, { type: 'scan', nodeId: 'b' }, h.rng).ok).toBe(true);
    expect(h.s.sightings.find((x) => x.nodeId === 'b')?.flaggedFalse).toBe(true);
    expect(h.s.stats.decoysExposed).toBe(1);
  });
});

describe('power and doors', () => {
  it('closed doors drain power and overheat → jam open (no permanent lockdown)', () => {
    const h = harness();
    h.run(20_100);
    expect(applyAction(h.ctx, h.s, D, { type: 'door', approachId: 'A1', closed: true }, h.rng).ok).toBe(true);
    expect(powerDrainPerSec(h.s)).toBeCloseTo(h.s.cfg.power.doorDrainPerSec);
    const p0 = h.s.power.value;
    h.run(10_000);
    expect(h.s.power.value).toBeLessThan(p0 - 5);
    h.runUntil((s) => !s.doors.A1!.closed, 30_000);
    expect(h.s.doors.A1!.jammedUntil).not.toBeNull();
    expect(applyAction(h.ctx, h.s, D, { type: 'door', approachId: 'A1', closed: true }, h.rng)).toMatchObject({
      ok: false,
      error: 'Door is jammed',
    });
  });

  it('a closed door stalls a breach', () => {
    const h = harness({
      cfg: testCfg((c) => {
        c.monster.unpredictability = 0;
      }),
    });
    h.run(20_000);
    applyAction(h.ctx, h.s, M, { type: 'command', command: 'ATTACK', approachId: 'A1' }, h.rng);
    // Seal on arrival; travel may now take longer than a door's safe closed time.
    h.runUntil((s) => s.monster.nodeId === 'c');
    applyAction(h.ctx, h.s, D, { type: 'door', approachId: 'A1', closed: true }, h.rng);
    h.runUntil((s) => !!s.breach);
    h.run(4_000);
    expect(h.s.result).toBeNull();
    expect(h.s.breach?.stalled).toBe(true);
    expect(h.s.doors.A1!.heat).toBeGreaterThan(0.2);
  });

  it('running out of power causes a temporary outage, then recovery', () => {
    const h = harness();
    h.run(20_100);
    h.s.power.value = 1;
    applyAction(h.ctx, h.s, D, { type: 'door', approachId: 'A1', closed: true }, h.rng);
    applyAction(h.ctx, h.s, D, { type: 'door', approachId: 'A2', closed: true }, h.rng);
    h.run(2_000);
    expect(h.s.power.outageUntil).not.toBeNull();
    expect(h.s.doors.A1!.closed).toBe(false);
    expect(applyAction(h.ctx, h.s, D, { type: 'scan', nodeId: 'a' }, h.rng)).toMatchObject({ ok: false });
    h.run(h.s.cfg.power.outageMs + 200);
    expect(h.s.power.outageUntil).toBeNull();
    expect(h.s.power.value).toBeGreaterThan(10);
  });

  it('enforces device limits and power costs', () => {
    const h = harness();
    for (const n of ['a', 'b', 'c']) expect(applyAction(h.ctx, h.s, D, { type: 'armTrap', nodeId: n }, h.rng).ok).toBe(true);
    expect(applyAction(h.ctx, h.s, D, { type: 'armTrap', nodeId: 'd' }, h.rng)).toMatchObject({ ok: false });
    expect(h.s.power.value).toBeCloseTo(h.s.cfg.power.max - 3 * h.s.cfg.power.trapArmCost);
    expect(applyAction(h.ctx, h.s, D, { type: 'door', approachId: 'A1', closed: true }, h.rng)).toMatchObject({ ok: false });
  });
});

describe('traps, containment, capture', () => {
  function trapped(seed = 1) {
    const h = harness({
      seed,
      cfg: testCfg((c) => {
        c.monster.unpredictability = 0;
      }),
    });
    applyAction(h.ctx, h.s, D, { type: 'armTrap', nodeId: 'b' }, h.rng);
    h.run(20_000);
    applyAction(h.ctx, h.s, M, { type: 'command', command: 'ATTACK', approachId: 'A1' }, h.rng);
    h.runUntil((s) => !!s.monster.held);
    return h;
  }

  it('trap immobilises for 8 s and alone does not win', () => {
    const h = trapped();
    expect(h.s.monster.nodeId).toBe('b');
    expect(h.s.stats.trapsTriggered).toBe(1);
    const t0 = h.s.t;
    h.runUntil((s) => !s.monster.held, 20_000);
    expect(h.s.t - t0).toBeGreaterThanOrEqual(7_900);
    expect(h.s.t - t0).toBeLessThanOrEqual(8_300);
    expect(h.s.result?.reason).not.toBe('capture');
  });

  it('trap → containment held 15 s uninterrupted → defenders win by capture', () => {
    const h = trapped();
    expect(applyAction(h.ctx, h.s, D, { type: 'containment', engage: true }, h.rng).ok).toBe(true);
    h.run(14_000);
    expect(h.s.result).toBeNull();
    h.run(1_200);
    expect(h.s.result?.winner).toBe('defenders');
    expect(h.s.result?.reason).toBe('capture');
  });

  it('containment is interrupted when the monster struggles free (RETREAT)', () => {
    const h = trapped();
    applyAction(h.ctx, h.s, M, { type: 'command', command: 'RETREAT' }, h.rng);
    h.run(3_000);
    applyAction(h.ctx, h.s, D, { type: 'containment', engage: true }, h.rng);
    h.runUntil((s) => !!s.result || !s.containment, 20_000);
    expect(h.s.result).toBeNull();
    expect(h.s.monster.held).toBeNull();
    expect(h.s.events.some((e) => e.kind === 'containmentBroken')).toBe(true);
  });

  it('containment is interrupted by a power outage', () => {
    const h = trapped();
    applyAction(h.ctx, h.s, D, { type: 'containment', engage: true }, h.rng);
    h.s.power.value = 2;
    h.run(2_000);
    expect(h.s.containment).toBeNull();
    expect(h.s.result).toBeNull();
  });
});
