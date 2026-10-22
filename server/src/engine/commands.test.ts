import { describe, expect, it } from 'vitest';
import { applyAction } from './engine';
import { harness } from '../../test/fixtures';

const monster = { team: 'monster' as const, playerId: 'm' };

function breaching(target: string | undefined, stalled = false) {
  const h = harness();
  h.run(h.s.cfg.match.prepMs);
  Object.assign(h.s.monster, { nodeId: 'c', moving: null, path: [] });
  expect(applyAction(h.ctx, h.s, monster, { type: 'command', command: 'ATTACK', approachId: target }, h.rng).ok).toBe(true);
  h.run(2000);
  expect(h.s.breach).toMatchObject({ approachId: 'A1', stalled: false });
  expect(h.s.breach!.progress).toBeGreaterThan(0);
  if (stalled) {
    h.s.doors.A1!.closed = true;
    h.run(h.s.cfg.tickMs);
    expect(h.s.breach!.stalled).toBe(true);
  }
  return h;
}

describe('monster command idempotency during a breach', () => {
  for (const target of ['A1', undefined]) {
    for (const repeatTarget of ['A1', undefined]) {
      it.each([false, true])(`preserves all state for repeated ATTACK (target=${target}, repeated=${repeatTarget}, stalled=%s)`, stalled => {
        const h = breaching(target, stalled);
        for (const sinceCommand of [h.s.cfg.tickMs, h.s.cfg.monster.globalCommandGapMs * 2]) {
          h.s.monster.lastCommandAt = h.s.t - sinceCommand;
          const before = structuredClone(h.s);
          const breach = h.s.breach;
          for (let i = 0; i < 5; i++) {
            expect(applyAction(h.ctx, h.s, monster, { type: 'command', command: 'ATTACK', approachId: repeatTarget }, h.rng)).toEqual({ ok: true });
            // Includes breach progress, planning, cooldowns, events, counters and the command gap.
            expect(h.s).toEqual(before);
            expect(h.s.breach).toBe(breach);
          }
        }
        const progress = h.s.breach!.progress;
        h.run(h.s.cfg.tickMs);
        const change = stalled
          ? -h.s.cfg.breach.decayPerSecWhenStalled * h.s.cfg.tickMs / 1000
          : h.s.cfg.tickMs / (h.s.cfg.breach.durationMs * h.s.cfg.breach.phaseMult[h.s.phase]);
        expect(h.s.breach!.progress).toBeCloseTo(progress + change);
      });
    }
  }

  it('retargets ATTACK to a different door without restarting its cooldown and stops the old breach', () => {
    const h = breaching('A1');
    const cooldown = h.s.monster.cooldowns.ATTACK;
    const commands = h.s.stats.commandsIssued;
    expect(applyAction(h.ctx, h.s, monster, { type: 'command', command: 'ATTACK', approachId: 'A2' }, h.rng)).toEqual({ ok: true });
    expect(h.s.monster.targetApproachId).toBe('A2');
    expect(h.s.monster.cooldowns.ATTACK).toBe(cooldown);
    expect(h.s.monster.lastCommandAt).toBe(h.s.t);
    expect(h.s.stats.commandsIssued).toBe(commands + 1);
    expect(h.s.events.at(-1)).toMatchObject({ kind: 'command', text: 'Command: ATTACK → Door B' });
    h.run(h.s.cfg.tickMs);
    expect(h.s.breach).toBeNull();
    expect(h.s.monster.breachApproachId).toBe('A2');
    expect(h.s.monster.moving?.to).toBe('e');
  });
});
