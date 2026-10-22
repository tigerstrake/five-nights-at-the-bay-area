import { describe, expect, it } from 'vitest';
import { Graph } from '@fnab/shared';
import { RoomManager } from '../src/rooms/RoomManager';
import { DEFAULT_CONFIG } from '@fnab/shared';
import { attachTestHooks, fastForward, setHold, testConfig, testHooksEnabled } from '../src/net/testHooks';
import { FIXTURE, testCfg } from './fixtures';

describe('e2e test hooks guard', () => {
  it('is off by default and unless the flag is exactly 1', () => {
    expect(testHooksEnabled({})).toBe(false);
    expect(testHooksEnabled({ NODE_ENV: 'development' })).toBe(false);
    expect(testHooksEnabled({ FNAB_TEST_HOOKS: '0' })).toBe(false);
    expect(testHooksEnabled({ FNAB_TEST_HOOKS: 'true' })).toBe(false);
    expect(testHooksEnabled({ FNAB_TEST_HOOKS: '1' })).toBe(true);
    expect(testHooksEnabled({ FNAB_TEST_HOOKS: '1', NODE_ENV: 'test' })).toBe(true);
  });

  it('refuses to start in production when the flag is set', () => {
    expect(() => testHooksEnabled({ FNAB_TEST_HOOKS: '1', NODE_ENV: 'production' })).toThrow(/production/);
    expect(() => testHooksEnabled({ FNAB_TEST_HOOKS: 'yes', NODE_ENV: 'production' })).toThrow(/production/);
    expect(testHooksEnabled({ NODE_ENV: 'production' })).toBe(false);
  });
});

describe('e2e balance override', () => {
  it('only applies with hooks on and never in production', () => {
    expect(testConfig({ FNAB_TEST_RECONNECT_GRACE_MS: '5000' })).toBeUndefined();
    expect(testConfig({ FNAB_TEST_HOOKS: '1' })).toBeUndefined();
    expect(testConfig({ FNAB_TEST_HOOKS: '1', FNAB_TEST_RECONNECT_GRACE_MS: '5000' })?.room.reconnectGraceMs).toBe(5000);
    expect(testConfig({ FNAB_TEST_HOOKS: '1', FNAB_TEST_RECONNECT_GRACE_MS: '5' })).toBeUndefined();
    expect(() => testConfig({ FNAB_TEST_HOOKS: '1', FNAB_TEST_RECONNECT_GRACE_MS: '5000', NODE_ENV: 'production' })).toThrow();
    expect(DEFAULT_CONFIG.room.reconnectGraceMs).toBeGreaterThan(5000); // default untouched
  });
});

describe('fastForward', () => {
  it('steps a running match by match time and rejects bad calls', () => {
    let now = 1_000_000;
    const cfg = testCfg();
    const rm = new RoomManager({ graph: new Graph(FIXTURE), cfg, now: () => now, placementCount: () => 2, seed: () => 7 });
    const a = rm.create('Alice');
    const b = rm.join((a as { code: string }).code, 'Bob');
    if (!a.ok || !b.ok) throw new Error('setup');
    expect(fastForward(rm, a.token, 1000).ok).toBe(false); // lobby
    rm.setReady(a.code, a.playerId, true);
    rm.setReady(a.code, b.playerId, true);
    rm.tick((now += 100));
    rm.tick((now += cfg.match.countdownMs + 200));
    const room = rm.rooms.get(a.code)!;
    expect(room.stage).toBe('playing');
    const t0 = room.match!.state.t;
    const epoch0 = room.match!.t0Epoch;
    const r = fastForward(rm, a.token, 5_000);
    expect(r.ok).toBe(true);
    expect(room.match!.state.t).toBeGreaterThanOrEqual(t0 + 5_000);
    expect(room.match!.t0Epoch).toBeLessThan(epoch0);
    expect(fastForward(rm, a.token, -1).ok).toBe(false);
    expect(fastForward(rm, 'nope-nope-nope-nope', 1000).ok).toBe(false);
    // run to the end: the next tick publishes the result
    expect(fastForward(rm, a.token, 600_000).ended).toBe(true);
    expect(rm.tick((now += 100)).ended).toContain(room);
  });
});

describe('hold (frozen match clock)', () => {
  it('real time does not advance a held match; only fastForward does; release restores real time', () => {
    let now = 1_000_000;
    const cfg = testCfg();
    const rm = new RoomManager({ graph: new Graph(FIXTURE), cfg, now: () => now, placementCount: () => 2, seed: () => 7 });
    const a = rm.create('Alice');
    const b = rm.join((a as { code: string }).code, 'Bob');
    if (!a.ok || !b.ok) throw new Error('setup');
    attachTestHooks({ on: () => undefined } as never, rm); // patches rm.tick
    expect(setHold(rm, a.token, true).ok).toBe(true);
    expect(setHold(rm, 'nope-nope-nope-nope', true).ok).toBe(false);
    rm.setReady(a.code, a.playerId, true);
    rm.setReady(a.code, b.playerId, true);
    rm.tick((now += 100));
    rm.tick((now += cfg.match.countdownMs + 200));
    const room = rm.rooms.get(a.code)!;
    expect(room.stage).toBe('playing');
    const t = room.match!.state.t;
    for (let i = 0; i < 300; i++) rm.tick((now += 100)); // 30 s of wall clock
    expect(room.match!.state.t).toBe(t);
    expect(fastForward(rm, a.token, 2_000).ok).toBe(true);
    expect(room.match!.state.t).toBeGreaterThanOrEqual(t + 2_000);
    const t2 = room.match!.state.t;
    for (let i = 0; i < 300; i++) rm.tick((now += 100));
    expect(room.match!.state.t).toBe(t2);
    setHold(rm, a.token, false);
    for (let i = 0; i < 10; i++) rm.tick((now += 100));
    expect(room.match!.state.t).toBeGreaterThan(t2);
  });
});
