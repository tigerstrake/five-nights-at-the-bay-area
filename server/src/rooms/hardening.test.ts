import { describe, expect, it } from 'vitest';
import { Graph } from '@fnab/shared';
import { RoomManager } from './RoomManager';
import { fastForward } from '../net/testHooks';
import { FIXTURE, testCfg } from '../../test/fixtures';

function playing(defenders = 1) {
  let now = 1_000_000;
  const cfg = testCfg(), rm = new RoomManager({ graph: new Graph(FIXTURE), cfg, placementCount: () => 2, now: () => now, seed: () => 3 });
  const monster = rm.create('monster'); if (!monster.ok) throw new Error();
  const team = Array.from({ length: defenders }, (_, i) => {
    const d = rm.join(monster.code, `d${i}`); if (!d.ok) throw new Error(); return d;
  });
  const room = rm.rooms.get(monster.code)!;
  rm.setReady(room.code, monster.playerId, true);
  for (const d of team) rm.setReady(room.code, d.playerId, true);
  const advance = (ms: number) => { now += ms; return rm.tick(now); };
  advance(100); advance(cfg.match.countdownMs);
  for (let i = 0; i < 210; i++) advance(100);
  return { rm, cfg, room, monster, team, advance, now: () => now };
}

describe('room lifecycle regressions', () => {
  it('8 realigns t0Epoch with authoritative simulation after dropping a long backlog', () => {
    const h = playing(), m = h.room.match!;
    const before = m.state.t;
    h.advance(90_000);
    expect(m.state.t - before).toBe(h.cfg.tickMs * 10);
    const view = h.rm.playerView(h.room, h.team[0].playerId)!;
    expect(view.serverNow - view.t0Epoch).toBe(view.t);
    h.advance(100);
    const next = h.rm.playerView(h.room, h.team[0].playerId)!;
    expect(next.t - view.t).toBe(100);
    expect(next.serverNow - next.t0Epoch).toBe(next.t);
  });

  it('11 exposes monster signal loss, holds the AI and resumes within grace without a time jump', () => {
    const h = playing(), s = h.room.match!.state;
    expect(s.monster.moving).not.toBeNull();
    const elapsed = s.monster.moving!.elapsed, t = s.t;
    h.rm.disconnect(h.room.code, h.monster.playerId);
    h.advance(20_000);
    const v = h.rm.playerView(h.room, h.team[0].playerId)!;
    expect(v.monsterConnection).toEqual({ connected: false, connectedPlayers: 0, totalPlayers: 1, reconnectDeadlineEpoch: h.now() + 25_000 });
    expect(v.pausedForReconnect).toBe(true);
    expect(v.events.some(e => e.kind === 'connectionLost' && e.text.includes("entity's signal is lost"))).toBe(true);
    expect(s.t).toBe(t); expect(s.monster.moving!.elapsed).toBe(elapsed);
    expect(v.serverNow - v.t0Epoch).toBe(v.t);
    expect(h.rm.action(h.room.code, h.team[0].playerId, { type: 'armTrap', nodeId: 'a' }).ok).toBe(false);
    expect(fastForward(h.rm, h.monster.token, 5000)).toEqual({ ok: false, error: 'Waiting for reconnection' });
    expect(h.rm.resume(h.room.code, h.monster.token).ok).toBe(true);
    h.advance(100);
    const resumed = h.rm.playerView(h.room, h.team[0].playerId)!;
    expect(resumed.monsterConnection?.connected).toBe(true); expect(resumed.pausedForReconnect).toBe(false);
    expect(resumed.events.filter(e => e.kind === 'connectionRestored')).toHaveLength(1);
    expect(s.t).toBe(t + 100); expect(s.monster.moving!.elapsed).toBe(elapsed + 100);
  });

  it('11 monster grace expiry gives defenders a clear forfeit result, including spectators', () => {
    const h = playing(), observer = h.rm.join(h.room.code, 'observer'); if (!observer.ok) throw new Error();
    h.rm.disconnect(h.room.code, h.monster.playerId);
    const out = h.advance(h.cfg.room.reconnectGraceMs);
    expect(out.ended).toContain(h.room);
    expect(h.room.result).toMatchObject({ winner: 'defenders', reason: 'forfeit', reasonText: expect.stringContaining('entity failed to reconnect') });
    expect(h.rm.playerView(h.room, observer.playerId)?.ended).toBe(true);
    expect(h.rm.playerView(h.room, observer.playerId)?.events.some(e => e.kind === 'connectionLost')).toBe(true);
    expect(h.rm.resume(h.room.code, h.monster.token).ok).toBe(false);
  });

  it('11 only ALL defenders offline pauses play and starts the full team grace window', () => {
    const h = playing(2), s = h.room.match!.state;
    h.rm.disconnect(h.room.code, h.team[0].playerId);
    h.advance(20_000);
    expect(h.rm.playerView(h.room, h.monster.playerId)?.defenderConnection?.connectedPlayers).toBe(1);
    expect(s.result).toBeNull();
    const t = s.t;
    h.rm.disconnect(h.room.code, h.team[1].playerId);
    h.advance(30_000); // first defender's individual grace has expired; whole-team grace has not
    expect(s.result).toBeNull(); expect(s.t).toBe(t);
    expect(h.rm.playerView(h.room, h.monster.playerId)?.defenderConnection?.reconnectDeadlineEpoch).toBe(h.now() + 15_000);
    h.advance(15_000);
    expect(h.room.result).toMatchObject({ winner: 'monster', reason: 'forfeit', reasonText: expect.stringContaining('all defenders failed to reconnect') });
  });

  it('11 one returning defender resumes the team; repeated disconnect callbacks cannot extend grace', () => {
    const h = playing(2);
    for (const p of h.team) h.rm.disconnect(h.room.code, p.playerId);
    const deadline = h.rm.playerView(h.room, h.monster.playerId)?.defenderConnection?.reconnectDeadlineEpoch;
    h.advance(10_000);
    h.rm.disconnect(h.room.code, h.team[1].playerId);
    expect(h.rm.playerView(h.room, h.monster.playerId)?.defenderConnection?.reconnectDeadlineEpoch).toBe(deadline);
    expect(h.rm.resume(h.room.code, h.team[1].token).ok).toBe(true);
    h.advance(100);
    expect(h.rm.playerView(h.room, h.monster.playerId)?.pausedForReconnect).toBe(false);
    expect(h.room.result).toBeNull();
  });

  it('11 rejects late resume even before the next housekeeping tick', () => {
    const h = playing();
    h.rm.disconnect(h.room.code, h.monster.playerId);
    // Move the injected clock without invoking tick by advancing a private external clock in a fresh manager.
    let now = 0;
    const rm = new RoomManager({ graph: new Graph(FIXTURE), cfg: h.cfg, placementCount: () => 2, now: () => now });
    const p = rm.create('m'); if (!p.ok) throw new Error();
    rm.disconnect(p.code, p.playerId); now += h.cfg.room.reconnectGraceMs;
    expect(rm.resume(p.code, p.token)).toEqual({ ok: false, error: 'Session expired' });
  });

  it('extra rejects a mid-match restart and no-op lobby changes leave versions stable', () => {
    const h = playing();
    expect(h.rm.restart(h.room.code, h.monster.playerId).ok).toBe(false);
    const version = h.room.version;
    expect(h.rm.setName(h.room.code, h.monster.playerId, 'monster').ok).toBe(true);
    expect(h.room.version).toBe(version);
  });
});
