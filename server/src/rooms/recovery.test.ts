import { describe, expect, it } from 'vitest';
import { Graph, type JoinResult } from '@fnab/shared';
import { RoomManager } from './RoomManager';
import { FIXTURE, testCfg } from '../../test/fixtures';
import { forfeit } from '../engine/engine';

const joined = (r: JoinResult) => { if (!r.ok) throw new Error(r.error); return r; };
function setup() {
  let now = 100_000;
  const cfg = testCfg();
  const rm = new RoomManager({ graph: new Graph(FIXTURE), cfg, now: () => now, seed: () => 17, placementCount: () => 1 });
  const m = joined(rm.create('Monster')), d = joined(rm.join(m.code, 'Defender'));
  rm.setReady(m.code, m.playerId, true); rm.setReady(d.code, d.playerId, true);
  rm.tick(now); rm.tick(now += cfg.match.countdownMs);
  return { rm, m, d, cfg, room: rm.rooms.get(m.code)!, advance: (ms: number) => { now += ms; } };
}

describe('atomic disconnected-seat recovery', () => {
  it.each(['m', 'd'] as const)('restores the same %s seat, role, name and match without adding a spectator', which => {
    const h = setup(), seat = h[which], match = h.room.match;
    h.rm.disconnect(seat.code, seat.playerId); h.advance(1000);
    expect(h.rm.recover(seat.code.toLowerCase(), seat.playerId, seat.recoveryToken!)).toEqual(seat);
    expect(h.room.players.size).toBe(2);
    expect(h.room.match).toBe(match);
    expect(h.room.players.get(seat.playerId)).toMatchObject({ connected: true, name: which === 'm' ? 'Monster' : 'Defender', role: which === 'm' ? 'monster' : 'defender' });
    expect(h.rm.playerView(h.room, seat.playerId)?.pausedForReconnect).toBe(false);
  });
  it('never steals a connected seat and only one fresh tab can win a recovery race', () => {
    const h = setup(), { code, playerId } = h.m, token = h.m.recoveryToken!;
    expect(h.rm.recover(code, playerId, token)).toMatchObject({ ok: false, error: 'Seat is connected in another tab' });
    h.rm.disconnect(code, playerId);
    expect(h.rm.recover(code, playerId, token).ok).toBe(true);
    expect(h.rm.recover(code, playerId, token).ok).toBe(false);
  });
  it('validates the recovery credential, player ID, room, grace deadline and end state', () => {
    const h = setup(), { code, playerId } = h.m, token = h.m.recoveryToken!;
    h.rm.disconnect(code, playerId);
    expect(h.rm.recover('ZZZZ', playerId, token).ok).toBe(false);
    expect(h.rm.recover(code, playerId, h.d.recoveryToken!).ok).toBe(false);
    expect(h.rm.recover(code, playerId, 'forged-session-token').ok).toBe(false);
    h.advance(h.cfg.room.reconnectGraceMs);
    expect(h.rm.recover(code, playerId, token).ok).toBe(false);
    expect(h.room.players.get(playerId)!.connected).toBe(false);
    const ended = setup(); forfeit(ended.room.match!.state, 'defenders');
    ended.rm.disconnect(ended.m.code, ended.m.playerId);
    expect(ended.rm.recover(ended.m.code, ended.m.playerId, ended.m.recoveryToken!)).toMatchObject({ ok: false, error: 'Match ended' });
  });
  it('preserves the ordinary per-tab resume semantics', () => {
    const h = setup();
    expect(h.rm.resume(h.m.code, h.m.token)).toEqual(h.m);
    h.rm.leave(h.m.code, h.m.playerId);
    expect(h.rm.recover(h.m.code, h.m.playerId, h.m.recoveryToken!).ok).toBe(false);
  });
});
