import { afterEach, describe, expect, it, vi } from 'vitest';
import { Graph, type JoinResult } from '@fnab/shared';
import { RoomManager } from './RoomManager';
import { forfeit } from '../engine/engine';
import { FIXTURE, testCfg } from '../../test/fixtures';
const joined = (r: JoinResult) => { if (!r.ok) throw new Error(r.error); return r; };
afterEach(() => vi.useRealTimers());

describe('room and AI resource cleanup', () => {
  it('releases controllers, matches, tokens and membership over repeated finish/restart/abandon cycles without creating timers', () => {
    vi.useFakeTimers();
    let now = 100_000;
    const cfg = testCfg(), rm = new RoomManager({ graph: new Graph(FIXTURE), cfg, now: () => now, seed: () => 7, placementCount: () => 1 });
    const timerCount = vi.getTimerCount();
    for (let i = 0; i < 100; i++) {
      const host = joined(rm.createSolo('Observer', { role: 'defender', difficulty: 'expert', teammates: 2 }));
      const room = rm.rooms.get(host.code)!;
      rm.setReady(host.code, host.playerId, true); rm.tick(now); rm.tick(now += cfg.match.countdownMs);
      const first = room.match!;
      expect(first.aiPlayers.size).toBe(3);
      forfeit(first.state, 'monster'); rm.tick(now += cfg.tickMs);
      expect(first.aiPlayers.size).toBe(0);
      rm.restart(host.code, host.playerId);
      rm.setReady(host.code, host.playerId, true); rm.tick(now); rm.tick(now += cfg.match.countdownMs);
      const second = room.match!;
      expect(second).not.toBe(first); expect(second.aiPlayers.size).toBe(3);
      // Cover both explicit final leave and transport loss followed by grace/empty-room eviction.
      if (i % 2) rm.leave(host.code, host.playerId);
      else { rm.disconnect(host.code, host.playerId); now += cfg.room.reconnectGraceMs + cfg.room.emptyRoomTtlMs + 1; }
      rm.tick(now);
      // First disconnected tick starts empty TTL; housekeeping must eventually reclaim even AI-only rosters.
      rm.tick(now += cfg.room.emptyRoomTtlMs + 1);
      expect(rm.rooms.size).toBe(0);
      expect(rm.locate(host.token)).toBeNull();
      expect(first.aiPlayers.size).toBe(0); expect(second.aiPlayers.size).toBe(0);
      expect(room.match).toBeNull(); expect(room.players.size).toBe(0);
      expect(vi.getTimerCount()).toBe(timerCount);
    }
  });
});
