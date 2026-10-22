// Test-only server hooks for the Playwright suite (e2e/). OFF unless FNAB_TEST_HOOKS=1, and the server
// refuses to start if that variable is set while NODE_ENV=production (see `testHooksEnabled`).
// Nothing here is reachable in a normal run: the socket handlers below are only registered when enabled.
import type { Server } from 'socket.io';
import { DEFAULT_CONFIG, type BalanceConfig } from '@fnab/shared';
import type { RoomManager } from '../rooms/RoomManager';

/** Longest fast-forward a single call may request (match time). */
export const MAX_FAST_FORWARD_MS = 600_000;

/**
 * Whether test hooks are on for this environment. Throws (so startup aborts) when someone sets
 * FNAB_TEST_HOOKS in a production environment; returns false when the variable is absent or not exactly "1".
 */
export function testHooksEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const flag = env.FNAB_TEST_HOOKS;
  if (flag === undefined || flag === '' || flag === '0') return false;
  if (env.NODE_ENV === 'production') {
    throw new Error('FNAB_TEST_HOOKS is set but NODE_ENV=production: refusing to start with test hooks enabled');
  }
  return flag === '1';
}

/**
 * Balance override for e2e only: FNAB_TEST_RECONNECT_GRACE_MS shortens the reconnection grace period so a "player never
 * comes back" forfeit can be observed in seconds. Returns undefined (= DEFAULT_CONFIG untouched) unless test hooks are on.
 */
export function testConfig(env: Record<string, string | undefined> = process.env): BalanceConfig | undefined {
  if (!testHooksEnabled(env)) return undefined;
  const grace = Number(env.FNAB_TEST_RECONNECT_GRACE_MS);
  if (!Number.isFinite(grace) || grace < 1_000) return undefined;
  return { ...DEFAULT_CONFIG, room: { ...DEFAULT_CONFIG.room, reconnectGraceMs: Math.round(grace) } };
}

export interface FastForwardResult {
  ok: boolean;
  error?: string;
  /** Match time (ms) after stepping. */
  t?: number;
  ended?: boolean;
}

/**
 * Advance a running match by `ms` of match time right now, using the normal fixed-step engine (same code path
 * as real time, just without waiting). Shifts `t0Epoch` back so client clocks stay consistent. The regular
 * server tick then publishes views / the result as usual.
 */
export function fastForward(rooms: RoomManager, token: string, ms: number): FastForwardResult {
  const loc = rooms.locate(token);
  const m = loc?.room.match;
  if (!loc || !m || loc.room.stage !== 'playing') return { ok: false, error: 'No match running' };
  if (m.state.monsterDisconnected)
    return { ok: false, error: 'Waiting for reconnection' };
  if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_FAST_FORWARD_MS) return { ok: false, error: 'Bad duration' };
  const tick = m.state.cfg.tickMs;
  const steps = Math.ceil(ms / tick);
  let done = 0;
  while (done < steps && !m.state.result) {
    rooms.stepMatch(loc.room);
    done++;
  }
  m.t0Epoch -= done * tick;
  return { ok: true, t: m.state.t, ended: !!m.state.result };
}

/**
 * Rooms whose match clock is frozen between fast-forwards. With wall-clock-driven matches, a slow CI runner burns
 * the 20 s preparation phase (and the 8 s trap hold, etc.) before a test can act, so e2e freezes time per room and
 * advances it only with `test:fastForward`. `test:hold {token, hold:false}` returns that room to real time.
 */
const heldRooms = new Set<string>();

export function setHold(rooms: RoomManager, token: string, hold: boolean): { ok: boolean; error?: string } {
  const loc = rooms.locate(token);
  if (!loc) return { ok: false, error: 'Not in a room' };
  if (hold) heldRooms.add(loc.room.code);
  else heldRooms.delete(loc.room.code);
  return { ok: true };
}

/** Wrap `rooms.tick` so held matches see no elapsed real time (same trick the reconnect pause uses). */
function patchTickForHold(rooms: RoomManager): void {
  const tick = rooms.tick.bind(rooms);
  rooms.tick = (now?: number) => {
    const at = now ?? Date.now();
    for (const code of heldRooms) {
      const room = rooms.rooms.get(code);
      if (!room) heldRooms.delete(code);
      else if (room.stage === 'playing' && room.match) room.match.lastStepAt = at;
    }
    return tick(at);
  };
}

export function attachTestHooks(io: Server, rooms: RoomManager): void {
  patchTickForHold(rooms);
  io.on('connection', (socket) => {
    socket.on('test:hold', (p: unknown, ack?: (r: { ok: boolean; error?: string }) => void) => {
      const d = (p ?? {}) as { token?: unknown; hold?: unknown };
      const res = typeof d.token === 'string' && typeof d.hold === 'boolean' ? setHold(rooms, d.token, d.hold) : { ok: false, error: 'Bad request' };
      if (typeof ack === 'function') ack(res);
    });
    socket.on('test:fastForward', (p: unknown, ack?: (r: FastForwardResult) => void) => {
      try {
        const d = (p ?? {}) as { token?: unknown; ms?: unknown };
        const res =
          typeof d.token === 'string' && typeof d.ms === 'number' ? fastForward(rooms, d.token, d.ms) : { ok: false, error: 'Bad request' };
        if (typeof ack === 'function') ack(res);
      } catch (error) {
        console.error('[net] test:fastForward handler failed', error);
        if (typeof ack === 'function') ack({ ok: false, error: 'Internal server error' });
      }
    });
  });
  console.warn('[fnab] TEST HOOKS ENABLED (FNAB_TEST_HOOKS=1): test:fastForward and test:hold are available. Never use in production.');
}
