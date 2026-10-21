// Test-only server hooks for the Playwright suite (e2e/). OFF unless FNAB_TEST_HOOKS=1, and the server
// refuses to start if that variable is set while NODE_ENV=production (see `testHooksEnabled`).
// Nothing here is reachable in a normal run: the socket handlers below are only registered when enabled.
import type { Server } from 'socket.io';
import { DEFAULT_CONFIG, type BalanceConfig } from '@fnab/shared';
import { step } from '../engine/engine';
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
  if (m.connectionLostAt.monster !== null || m.connectionLostAt.defenders !== null)
    return { ok: false, error: 'Waiting for reconnection' };
  if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_FAST_FORWARD_MS) return { ok: false, error: 'Bad duration' };
  const tick = m.state.cfg.tickMs;
  const steps = Math.ceil(ms / tick);
  let done = 0;
  while (done < steps && !m.state.result) {
    step(m.ctx, m.state, tick, m.rng);
    done++;
  }
  m.t0Epoch -= done * tick;
  return { ok: true, t: m.state.t, ended: !!m.state.result };
}

export function attachTestHooks(io: Server, rooms: RoomManager): void {
  io.on('connection', (socket) => {
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
  console.warn('[fnab] TEST HOOKS ENABLED (FNAB_TEST_HOOKS=1): test:fastForward is available. Never use in production.');
}
