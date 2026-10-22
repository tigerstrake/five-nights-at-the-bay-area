import { describe, expect, it } from 'vitest';
import { VIEW_TRANSPORT_CONFIG, type DefenderView, type PlayerView, type Role } from '@fnab/shared';
import { ViewEncoder } from './viewUpdates';
import { projectView } from '../visibility';
import { applyViewDelta } from '../../../client/src/state/viewDelta';
import { harness, testCfg } from '../../test/fixtures';
import { applyAction } from '../engine/engine';

const clock = { t0Epoch: 100_000, serverNow: 100_000 };
const withoutSequence = (view: PlayerView) => { const { viewSequence: _, ...rest } = view; return rest; };

describe('role-filtered view checkpoints and deltas', () => {
  it.each(['monster', 'defender', 'spectator'] as Role[])('reconstructs every %s view exactly across phases, actions, outage and end', role => {
    const h = harness({ durationMs: 40_000, cfg: testCfg(c => { c.detection.baseChance = 2; }) });
    const encoder = new ViewEncoder();
    let received: PlayerView | null = null, deltas = 0, full = 0;
    for (let i = 0; i <= 610; i++) {
      if (i === 5) applyAction(h.ctx, h.s, { team: 'defenders', playerId: 'd' }, { type: 'armTrap', nodeId: 'b' }, h.rng);
      if (i === 220) applyAction(h.ctx, h.s, { team: 'defenders', playerId: 'd' }, { type: 'door', approachId: 'A1', closed: true }, h.rng);
      if (i === 240) h.s.power.value = 0;
      const view = projectView(h.ctx, h.s, role, { ...clock, serverNow: clock.serverNow + i * 100 });
      const emission = JSON.parse(JSON.stringify(encoder.next(view)));
      if (emission.event === 'game:view') { received = emission.data; full++; }
      else { received = applyViewDelta(received, emission.data); deltas++; }
      expect(received).not.toBeNull();
      expect(withoutSequence(received!)).toEqual(JSON.parse(JSON.stringify(view)));
      h.run(100);
    }
    expect(deltas).toBeGreaterThan(500); expect(full).toBeGreaterThan(6);
  });
  it('sends a checkpoint on reset, match restart, role change, and periodically', () => {
    const h = harness(), encoder = new ViewEncoder();
    const view = projectView(h.ctx, h.s, 'defender', clock);
    expect(encoder.next(view).event).toBe('game:view');
    for (let i = 2; i < VIEW_TRANSPORT_CONFIG.fullEveryTicks; i++) expect(encoder.next(view).event).toBe('game:delta');
    expect(encoder.next(view).event).toBe('game:view');
    encoder.reset(); expect(encoder.next(view).event).toBe('game:view');
    expect(encoder.next(projectView(h.ctx, h.s, 'monster', clock)).event).toBe('game:view');
    h.run(1000); encoder.next(projectView(h.ctx, h.s, 'monster', clock));
    expect(encoder.next(projectView(h.ctx, harness().s, 'monster', clock)).event).toBe('game:view');
  });
  it('removes optional fields that disappear (JSON cannot carry undefined) and never resends unchanged ones', () => {
    const h = harness(), encoder = new ViewEncoder();
    const wire = (v: PlayerView) => JSON.parse(JSON.stringify(encoder.next(v)));
    const connection = { connected: 1, total: 1, graceEndsAt: null, pausedRemainingMs: 0 } as never;
    const base = projectView(h.ctx, h.s, 'defender', clock);
    let received: PlayerView | null = wire({ ...base, monsterConnection: connection, pausedForReconnect: true }).data;
    const delta = wire({ ...base, pausedForReconnect: undefined });
    expect(delta.event).toBe('game:delta');
    expect(delta.data.removed?.sort()).toEqual(['monsterConnection', 'pausedForReconnect']);
    expect(delta.data.changes).toEqual({});
    received = applyViewDelta(received, delta.data);
    expect(received).not.toHaveProperty('monsterConnection');
    expect(received).not.toHaveProperty('pausedForReconnect');
    expect(withoutSequence(received!)).toEqual(JSON.parse(JSON.stringify(base)));
    // A forged removal can never strip the role discriminant.
    expect(applyViewDelta(received, { baseSequence: received!.viewSequence!, sequence: received!.viewSequence! + 1, changes: {}, removed: ['role'] })?.role).toBe('defender');
  });
  it('rejects a missing/wrong/duplicate base and role changes until a full checkpoint arrives', () => {
    const h = harness(), encoder = new ViewEncoder(), view = projectView(h.ctx, h.s, 'defender', clock);
    const first = encoder.next(view).data as PlayerView;
    const delta = { baseSequence: 1, sequence: 2, changes: { t: 100 } };
    expect(applyViewDelta(null, delta)).toBeNull();
    expect(applyViewDelta(first, { ...delta, baseSequence: 7 })).toBeNull();
    const second = applyViewDelta(first, delta)!;
    expect(second.t).toBe(100); expect(applyViewDelta(second, delta)).toBeNull();
    expect(applyViewDelta(first, { ...delta, changes: { role: 'monster' } })).toBeNull();
  });
  it('does not retain mutable authoritative objects or leak hidden keys through deltas', () => {
    const h = harness(), encoder = new ViewEncoder();
    const first = projectView(h.ctx, h.s, 'defender', clock);
    encoder.next(first); h.run(21_000);
    const emitted = encoder.next(projectView(h.ctx, h.s, 'defender', clock));
    const text = JSON.stringify(emitted);
    for (const forbidden of ['"isDecoy"', '"knowledge"', '"monster"', '"publicIdKey"', '"stance"', '"cooldowns":{"RETREAT"']) expect(text).not.toContain(forbidden);
    expect(first.t).toBe(0); expect((first as DefenderView).power.value).toBe(h.s.cfg.power.max);
  });
});
