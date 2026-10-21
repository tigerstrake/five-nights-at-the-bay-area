import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, Graph } from '@fnab/shared';
import { RoomManager } from './RoomManager';
import { endMatch } from '../engine/engine';
import { fastForward } from '../net/testHooks';
import { FIXTURE, testCfg } from '../../test/fixtures';

function playing(defenders = 1, over?: Parameters<typeof testCfg>[0]) {
  let now = 1_000_000;
  const cfg = testCfg(over), rm = new RoomManager({ graph: new Graph(FIXTURE), cfg, placementCount: () => 2, now: () => now, seed: () => 3 });
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
  return { rm, cfg, room, monster, team, advance, elapse: (ms: number) => { now += ms; }, now: () => now };
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
    expect(v.monsterConnection).toMatchObject({ connected: false, connectedPlayers: 0, totalPlayers: 1, reconnectDeadlineEpoch: h.now() + 25_000 });
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

  it.each(['monster', 'defenders'] as const)('caps cumulative %s pauses across reconnects and keeps the normal forfeit deadline', team => {
    const h = playing(2), m = h.room.match!, s = m.state;
    const players = team === 'monster' ? [h.monster] : h.team;
    const observer = team === 'monster' ? h.team[0] : h.monster;
    const connection = () => {
      const view = h.rm.playerView(h.room, observer.playerId)!;
      return team === 'monster' ? view.monsterConnection! : view.defenderConnection!;
    };
    const budget = h.cfg.room.reconnectPauseBudgetMs!;
    const startT = s.t;
    for (const p of players) h.rm.disconnect(h.room.code, p.playerId);
    h.advance(44_000);
    expect(s.t).toBe(startT);
    expect(connection().pauseRemainingMs).toBe(budget - 44_000);
    expect(h.rm.resume(h.room.code, players[0].token).ok).toBe(true);
    // Repeated successful resumes and a second missing defender cannot replenish the team budget.
    expect(h.rm.resume(h.room.code, players[0].token).ok).toBe(true);
    expect(connection().pauseRemainingMs).toBe(budget - 44_000);
    h.rm.disconnect(h.room.code, players[0].playerId);
    const deadline = connection().reconnectDeadlineEpoch;
    h.advance(budget - 44_000 - 100);
    expect(connection().pauseRemainingMs).toBe(100);
    expect(h.rm.playerView(h.room, observer.playerId)?.pausedForReconnect).toBe(true);
    h.advance(100);
    expect(connection().pauseRemainingMs).toBe(0);
    expect(h.rm.playerView(h.room, observer.playerId)?.pausedForReconnect).toBe(false);
    const progress = s.monster.moving!.elapsed, power = s.power.value;
    expect(h.rm.action(h.room.code, observer.playerId, team === 'monster'
      ? { type: 'door', approachId: 'A1', closed: true }
      : { type: 'command', command: 'HIDE' }).ok).toBe(true);
    h.advance(100);
    expect(s.t).toBe(startT + 100);
    expect(s.monster.moving!.elapsed).toBeGreaterThan(progress);
    if (team === 'monster') expect(s.power.value).toBeLessThan(power);
    expect(connection().reconnectDeadlineEpoch).toBe(deadline);
    expect(h.rm.resume(h.room.code, players[0].token).ok).toBe(true);
    h.rm.disconnect(h.room.code, players[0].playerId);
    for (let i = 0; i < 10; i++) h.advance(100);
    expect(s.t).toBe(startT + 1100);
    expect(connection().pauseRemainingMs).toBe(0);
    h.advance(h.cfg.room.reconnectGraceMs - 1000);
    expect(h.room.result).toMatchObject({ reason: 'forfeit', winner: team === 'monster' ? 'defenders' : 'monster' });
  });

  it('charges simultaneous missing teams independently without double-counting paused wall time', () => {
    const h = playing(), m = h.room.match!, budget = h.cfg.room.reconnectPauseBudgetMs!;
    h.rm.disconnect(h.room.code, h.monster.playerId);
    h.advance(10_000);
    h.rm.disconnect(h.room.code, h.team[0].playerId);
    h.advance(10_000);
    expect(m.pauseRemainingMs).toEqual({ monster: budget - 20_000, defenders: budget - 10_000 });
    expect(h.rm.resume(h.room.code, h.monster.token).ok).toBe(true);
    h.advance(10_000);
    expect(m.pauseRemainingMs).toEqual({ monster: budget - 20_000, defenders: budget - 20_000 });
    expect(h.rm.resume(h.room.code, h.team[0].token).ok).toBe(true);
    const t = m.state.t;
    h.advance(100);
    expect(m.state.t).toBe(t + 100);
    expect(m.t0Epoch + m.state.t).toBe(h.now());
  });

  it('charges resume intervals between ticks and advances only the portion beyond the remaining budget', () => {
    const h = playing(1, c => { c.room.reconnectPauseBudgetMs = 1500; }), m = h.room.match!, t = m.state.t;
    h.rm.disconnect(h.room.code, h.monster.playerId);
    h.elapse(1000); // no tick between disconnect and resume
    expect(h.rm.resume(h.room.code, h.monster.token).ok).toBe(true);
    expect(m.pauseRemainingMs.monster).toBe(500);
    expect(m.state.t).toBe(t);
    expect(m.t0Epoch + m.state.t).toBe(h.now());
    h.rm.disconnect(h.room.code, h.monster.playerId);
    h.elapse(800);
    expect(h.rm.resume(h.room.code, h.monster.token).ok).toBe(true);
    h.advance(0);
    expect(m.pauseRemainingMs.monster).toBe(0);
    expect(m.state.t).toBe(t + 300);
    expect(m.t0Epoch + m.state.t).toBe(h.now());
  });

  it.each([undefined, 0])('uses a default for saved configs and honors an explicit zero pause budget (%s)', budget => {
    const h = playing(1, c => { c.room.reconnectPauseBudgetMs = budget; }), m = h.room.match!, t = m.state.t;
    h.rm.disconnect(h.room.code, h.monster.playerId);
    h.advance(100);
    expect(m.pauseRemainingMs.monster).toBe(budget === undefined ? DEFAULT_CONFIG.room.reconnectPauseBudgetMs! - 100 : 0);
    expect(m.state.t).toBe(budget === 0 ? t + 100 : t);
    expect(h.rm.playerView(h.room, h.team[0].playerId)?.pausedForReconnect).toBe(budget !== 0);
  });

  it('refills pause allowances only when a new match starts', () => {
    const h = playing(), budget = h.cfg.room.reconnectPauseBudgetMs!;
    h.rm.disconnect(h.room.code, h.monster.playerId);
    h.advance(1000);
    expect(h.rm.resume(h.room.code, h.monster.token).ok).toBe(true);
    expect(h.room.match!.pauseRemainingMs.monster).toBe(budget - 1000);
    endMatch(h.room.match!.state, 'defenders', 'timer');
    h.advance(100);
    expect(h.rm.restart(h.room.code, h.monster.playerId).ok).toBe(true);
    for (const p of [h.monster, ...h.team]) h.rm.setReady(h.room.code, p.playerId, true);
    h.advance(100); h.advance(h.cfg.match.countdownMs);
    expect(h.room.stage).toBe('playing');
    expect(h.room.match!.pauseRemainingMs).toEqual({ monster: budget, defenders: budget });
  });

  it('extra rejects a mid-match restart and no-op lobby changes leave versions stable', () => {
    const h = playing();
    expect(h.rm.restart(h.room.code, h.monster.playerId).ok).toBe(false);
    const version = h.room.version;
    expect(h.rm.setName(h.room.code, h.monster.playerId, 'monster').ok).toBe(true);
    expect(h.room.version).toBe(version);
  });
});
