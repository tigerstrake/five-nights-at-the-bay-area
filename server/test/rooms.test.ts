import { describe, expect, it } from 'vitest';
import { Graph, DEFAULT_CONFIG } from '@fnab/shared';
import { RoomManager } from '../src/rooms/RoomManager';
import { FIXTURE, testCfg } from './fixtures';

function setup() {
  let now = 1_000_000;
  const cfg = testCfg();
  const rm = new RoomManager({ graph: new Graph(FIXTURE), cfg, now: () => now, placementCount: () => 2, seed: () => 7 });
  return {
    rm,
    cfg,
    advance: (ms: number) => {
      now += ms;
      return rm.tick(now);
    },
    now: () => now,
  };
}

describe('room flow', () => {
  it('create → join → roles → HQ → ready → countdown → playing', () => {
    const { rm, cfg, advance } = setup();
    const host = rm.create('Alice');
    expect(host.ok).toBe(true);
    if (!host.ok) return;
    expect(host.code).toMatch(/^[A-Z]{4}$/);
    const room = rm.rooms.get(host.code)!;
    expect(room.players.get(host.playerId)!.role).toBe('monster');
    const guest = rm.join(host.code.toLowerCase(), 'Bob');
    expect(guest.ok).toBe(true);
    if (!guest.ok) return;
    expect(room.players.get(guest.playerId)!.role).toBe('defender');
    // only one monster
    expect(rm.setRole(host.code, guest.playerId, 'monster').ok).toBe(false);
    expect(rm.selectHq(host.code, guest.playerId, 'hq-sf').ok).toBe(true);
    expect(rm.setSettings(host.code, guest.playerId, { durationSec: 400 }).ok).toBe(false); // not host
    expect(rm.setSettings(host.code, host.playerId, { durationSec: 9999 }).ok).toBe(true);
    expect(room.settings.durationSec).toBe(cfg.match.maxDurationMs / 1000);
    expect(rm.roomView(room, host.playerId).blocker).toMatch(/Waiting/);
    rm.setReady(host.code, host.playerId, true);
    rm.setReady(host.code, guest.playerId, true);
    advance(100);
    expect(room.stage).toBe('countdown');
    // un-ready cancels
    rm.setReady(host.code, guest.playerId, false);
    expect(room.stage).toBe('lobby');
    rm.setReady(host.code, guest.playerId, true);
    advance(100);
    advance(cfg.match.countdownMs + 100);
    expect(room.stage).toBe('playing');
    expect(room.match?.state.durationMs).toBe(cfg.match.maxDurationMs);
    const mv = rm.playerView(room, host.playerId)!;
    const dv = rm.playerView(room, guest.playerId)!;
    expect(mv.role).toBe('monster');
    expect(dv.role).toBe('defender');
    // team action routing
    expect(rm.action(host.code, guest.playerId, { type: 'command', command: 'HUNT' }).ok).toBe(false);
    expect(rm.action(host.code, host.playerId, { type: 'armTrap', nodeId: 'a' }).ok).toBe(false);
    expect(rm.action(host.code, guest.playerId, { type: 'armTrap', nodeId: 'a' }).ok).toBe(true);
  });

  it('reconnects with the same token within the grace period, drops after it', () => {
    const { rm, cfg, advance } = setup();
    const a = rm.create('Alice');
    if (!a.ok) throw new Error();
    const b = rm.join(a.code, 'Bob', 'tok-bob-0123456789abcdef');
    if (!b.ok) throw new Error();
    expect(b.token).toBe('tok-bob-0123456789abcdef');
    rm.disconnect(a.code, b.playerId);
    advance(cfg.room.reconnectGraceMs / 2);
    const r = rm.resume(a.code, b.token);
    expect(r).toMatchObject({ ok: true, playerId: b.playerId });
    rm.disconnect(a.code, b.playerId);
    advance(cfg.room.reconnectGraceMs + 1000);
    expect(rm.rooms.get(a.code)!.players.has(b.playerId)).toBe(false);
    expect(rm.resume(a.code, b.token).ok).toBe(false);
  });

  it('host migration, monster forfeit, restart to lobby and empty room cleanup', () => {
    const { rm, cfg, advance } = setup();
    const a = rm.create('Alice');
    if (!a.ok) throw new Error();
    const b = rm.join(a.code, 'Bob');
    if (!b.ok) throw new Error();
    const room = rm.rooms.get(a.code)!;
    rm.setReady(a.code, a.playerId, true);
    rm.setReady(a.code, b.playerId, true);
    advance(100);
    advance(cfg.match.countdownMs + 200);
    expect(room.stage).toBe('playing');
    rm.leave(a.code, a.playerId); // monster leaves → defenders win by forfeit
    const out = advance(200);
    expect(out.ended).toContain(room);
    expect(room.stage).toBe('results');
    expect(room.result).toMatchObject({ winner: 'defenders', reason: 'forfeit' });
    expect(room.hostId).toBe(b.playerId);
    expect(rm.restart(a.code, b.playerId).ok).toBe(true);
    expect(room.stage).toBe('lobby');
    expect(room.match).toBeNull();
    rm.disconnect(a.code, b.playerId);
    advance(DEFAULT_CONFIG.room.reconnectGraceMs + 1000);
    advance(cfg.room.emptyRoomTtlMs + 1000);
    expect(rm.rooms.has(a.code)).toBe(false);
  });

  it('late joiners become spectators during a match', () => {
    const { rm, cfg, advance } = setup();
    const a = rm.create('Alice');
    if (!a.ok) throw new Error();
    const b = rm.join(a.code, 'Bob');
    if (!b.ok) throw new Error();
    rm.setReady(a.code, a.playerId, true);
    rm.setReady(a.code, b.playerId, true);
    advance(100);
    advance(cfg.match.countdownMs + 200);
    const c = rm.join(a.code, 'Carol');
    if (!c.ok) throw new Error();
    const room = rm.rooms.get(a.code)!;
    expect(room.players.get(c.playerId)!.role).toBe('spectator');
    expect(rm.playerView(room, c.playerId)!.role).toBe('spectator');
    expect(rm.action(a.code, c.playerId, { type: 'scan', nodeId: 'a' }).ok).toBe(false);
  });
});
