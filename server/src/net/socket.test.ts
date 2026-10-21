import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Graph, type ActionResult, type JoinResult, type PlayerView } from '@fnab/shared';
import { RoomManager } from '../rooms/RoomManager';
import { SimulationCameraService } from '../cameras/simulation';
import { attachSockets } from './socket';
import { networkLimits, TokenBucket } from './limits';
import { FIXTURE, testCfg } from '../../test/fixtures';

// Exercise the real transport registrations without opening ports or using the network.
class WireSocket {
  data: { code?: string; playerId?: string } = {};
  handshake: { address: string; headers: { 'x-forwarded-for'?: string } };
  handlers = new Map<string, (...args: any[]) => void>();
  out: Array<{ event: string; value: any }> = [];
  constructor(readonly id: string, ip = '127.0.0.1', forwarded?: string) { this.handshake = { address: ip, headers: { 'x-forwarded-for': forwarded } }; }
  on(event: string, handler: (...args: any[]) => void) { this.handlers.set(event, handler); }
  emit(event: string, value: unknown) { this.out.push({ event, value }); }
  disconnect() { this.handlers.get('disconnect')?.(); }
  request<T = ActionResult>(event: string, payload?: unknown): T {
    let reply: unknown;
    const ack = (v: unknown) => { reply = v; };
    if (event === 'room:restart') this.handlers.get(event)?.(ack);
    else this.handlers.get(event)?.(payload, ack);
    return reply as T;
  }
  values(event: string) { return this.out.filter(e => e.event === event).map(e => e.value); }
}

let stop: (() => void) | undefined;
function setup(over?: Parameters<typeof testCfg>[0]) {
  const cfg = testCfg(over);
  const rm = new RoomManager({ graph: new Graph(FIXTURE), cfg, now: Date.now, placementCount: () => 2, seed: () => 3 });
  let connect!: (s: WireSocket) => void;
  const io = { on: (_event: string, handler: typeof connect) => { connect = handler; }, emit: vi.fn() };
  stop = attachSockets(io as never, rm, new SimulationCameraService({ cameras: [] }), cfg.tickMs);
  let id = 0;
  const socket = (ip?: string, forwarded?: string) => { const s = new WireSocket(String(++id), ip, forwarded); connect(s); return s; };
  return { rm, cfg, socket };
}
function joined(result: JoinResult) { if (!result.ok) throw new Error(result.error); return result; }

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); vi.stubEnv('TRUST_PROXY', ''); });
afterEach(() => { stop?.(); stop = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('socket security regressions', () => {
  it('1 unbinds same-room and cross-room identities and disconnects only the latest player', () => {
    const { rm, socket } = setup(), s = socket();
    const a = joined(s.request<JoinResult>('room:create', { name: 'm' }));
    const b = joined(s.request<JoinResult>('room:join', { code: a.code, name: 'd' }));
    expect(rm.rooms.get(a.code)!.players.get(a.playerId)!.connected).toBe(false);
    s.request('room:resume', { code: a.code, token: a.token });
    expect(rm.rooms.get(a.code)!.players.get(b.playerId)!.connected).toBe(false);
    const second = joined(socket().request<JoinResult>('room:create', { name: 'other' }));
    s.request('room:join', { code: second.code, name: 'visitor' });
    expect(rm.rooms.get(a.code)!.players.get(a.playerId)!.connected).toBe(false);
    const latest = s.data.playerId!; s.disconnect();
    expect(rm.rooms.get(second.code)!.players.get(latest)!.connected).toBe(false);
  });

  it('1 rejects mid-match identity changes before creating spectators and emits exactly one team view', () => {
    const { rm, cfg, socket } = setup(), m = socket(), d = socket();
    const a = joined(m.request<JoinResult>('room:create', { name: 'm' }));
    const b = joined(d.request<JoinResult>('room:join', { code: a.code, name: 'd' }));
    m.request('lobby:setReady', { ready: true }); d.request('lobby:setReady', { ready: true });
    vi.advanceTimersByTime(cfg.tickMs + cfg.match.countdownMs + cfg.tickMs);
    expect(rm.rooms.get(a.code)!.stage).toBe('playing');
    expect(m.request('room:join', { code: a.code, name: 'sneak' }).ok).toBe(false);
    expect(m.request('room:resume', { code: a.code, token: b.token }).ok).toBe(false);
    expect(m.request('room:create', { name: 'new' }).ok).toBe(false);
    expect(rm.rooms.get(a.code)!.players.size).toBe(2);
    m.request('room:resume', { code: a.code, token: a.token });
    vi.advanceTimersByTime(cfg.tickMs);
    expect(m.values('game:view').every((v: PlayerView) => v.role === 'monster')).toBe(true);
    const spectator = socket(); spectator.request('room:join', { code: a.code, name: 'observer' });
    expect(spectator.request('room:resume', { code: a.code, token: a.token }).ok).toBe(false);
  });

  it('1 replaced sockets cannot act or receive room, view or result emissions', () => {
    const { rm, cfg, socket } = setup(), m = socket(), d = socket();
    const a = joined(m.request<JoinResult>('room:create', { name: 'm' }));
    d.request('room:join', { code: a.code, name: 'd' });
    const replacement = socket(); replacement.request('room:resume', { code: a.code, token: a.token });
    expect(m.values('room:kicked')).toHaveLength(1);
    expect(m.request('lobby:setReady', { ready: true }).ok).toBe(false);
    const old = m.out.length; m.disconnect();
    expect(rm.rooms.get(a.code)!.players.get(a.playerId)!.connected).toBe(true);
    replacement.request('lobby:setReady', { ready: true }); d.request('lobby:setReady', { ready: true });
    vi.advanceTimersByTime(cfg.tickMs + cfg.match.countdownMs + cfg.tickMs);
    rm.leave(a.code, a.playerId); vi.advanceTimersByTime(cfg.tickMs);
    expect(d.values('game:result')).toHaveLength(1);
    expect(m.out.length).toBe(old);
  });

  it('1 cannot bypass the match identity lock by explicitly leaving a still-running team', () => {
    const { rm, cfg, socket } = setup(), m = socket(), d = socket(), d2 = socket();
    const a = joined(m.request<JoinResult>('room:create', { name: 'm' }));
    d.request('room:join', { code: a.code, name: 'd' }); d2.request('room:join', { code: a.code, name: 'd2' });
    for (const s of [m, d, d2]) s.request('lobby:setReady', { ready: true });
    vi.advanceTimersByTime(cfg.tickMs + cfg.match.countdownMs + cfg.tickMs);
    d.request('room:leave');
    expect(rm.rooms.get(a.code)!.stage).toBe('playing');
    expect(d.request('room:join', { code: a.code, name: 'sneak' }).ok).toBe(false);
    expect(d.request('room:resume', { code: a.code, token: a.token }).ok).toBe(false);
  });

  it('2/5 coalesces accepted actions and duplicate resumes to one view per transport tick', () => {
    const { cfg, socket } = setup(), m = socket(), d = socket();
    const a = joined(m.request<JoinResult>('room:create', { name: 'm' }));
    d.request('room:join', { code: a.code, name: 'd' });
    m.request('lobby:setReady', { ready: true }); d.request('lobby:setReady', { ready: true });
    vi.advanceTimersByTime(cfg.tickMs + cfg.match.countdownMs + cfg.tickMs);
    const n = d.values('game:view').length;
    for (let i = 0; i < 8; i++) d.request('game:action', { type: 'armTrap', nodeId: 'b' });
    for (let i = 0; i < 3; i++) m.request('room:resume', { code: a.code, token: a.token });
    expect(d.values('game:view')).toHaveLength(n);
    vi.advanceTimersByTime(cfg.tickMs);
    expect(d.values('game:view')).toHaveLength(n + 1);
  });

  it('4 catches handler exceptions, logs them and acknowledges an error', () => {
    const { rm, socket } = setup(), s = socket();
    vi.spyOn(rm, 'create').mockImplementation(() => { throw new Error('regression'); });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(s.request('room:create', { name: 'm' })).toEqual({ ok: false, error: 'Internal server error' });
    expect(log).toHaveBeenCalledOnce();
  });

  it('5 suppresses duplicate lobby actions and duplicate resumes without private pushes', () => {
    const { socket, cfg } = setup(), s = socket();
    const a = joined(s.request<JoinResult>('room:create', { name: 'm' }));
    vi.advanceTimersByTime(cfg.tickMs);
    const n = s.out.length;
    for (let i = 0; i < 3; i++) {
      s.request('lobby:setReady', { ready: false });
      s.request('room:resume', { code: a.code, token: a.token });
    }
    vi.advanceTimersByTime(cfg.tickMs);
    expect(s.out).toHaveLength(n);
  });

  it('5 applies socket budgets, shared IP budgets and failed-code lookup throttles across reconnects', () => {
    const { rm, socket } = setup(c => { c.net = { ...c.net!, socketBurst: 3, ipBurst: 5, joinBurst: 20, failedJoinBurst: 2 }; });
    const a = socket('ip1');
    for (let i = 0; i < 3; i++) expect(a.request<any>('time:ping', { clientSentAt: 0 }).serverNow).toBeDefined();
    expect(a.request('time:ping', { clientSentAt: 0 }).error).toContain('Rate limit');
    const b = socket('ip1'); b.request('time:ping', { clientSentAt: 0 }); b.request('time:ping', { clientSentAt: 0 });
    expect(b.request('time:ping', { clientSentAt: 0 }).error).toContain('Rate limit');
    const spy = vi.spyOn(rm, 'join');
    for (let i = 0; i < 2; i++) expect(socket('ip2').request('room:join', { code: 'ZZZZ', name: 'probe' }).error).toBe('Room not found');
    expect(socket('ip2').request('room:join', { code: 'ZZZZ', name: 'probe' }).error).toContain('Join limit');
    expect(spy).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(10_000);
    expect(socket('ip2').request('room:join', { code: 'ZZZZ', name: 'probe' }).error).toBe('Room not found');
  });

  it('5 token buckets refill by wall time and test-mode overrides are explicitly guarded', () => {
    const bucket = new TokenBucket(2, 1, 0);
    expect([bucket.take(0), bucket.take(0), bucket.take(0), bucket.take(1000)]).toEqual([true, true, false, true]);
    const cfg = testCfg();
    expect(networkLimits(cfg, { FNAB_RATE_LIMIT_MULTIPLIER: '100' }).socketBurst).toBe(cfg.net!.socketBurst);
    expect(networkLimits(cfg, { FNAB_TEST_HOOKS: '1', FNAB_RATE_LIMIT_MULTIPLIER: '100' }).socketBurst).toBe(cfg.net!.socketBurst * 100);
  });

  it('isolates request and resume budgets for clients behind an explicitly trusted proxy', () => {
    vi.stubEnv('TRUST_PROXY', '10.42.0.0/16');
    const { rm, socket } = setup(c => { c.net = { ...c.net!, ipBurst: 4, joinBurst: 1 }; });
    const first = socket('10.42.0.7', '198.51.100.1');
    const player = joined(first.request<JoinResult>('room:create', { name: 'm' }));
    first.disconnect();
    expect(socket('10.42.0.7', '198.51.100.1').request('room:resume', player).error).toContain('Join limit');
    const second = socket('10.42.0.7', '198.51.100.2');
    expect(second.request('room:resume', player).ok).toBe(true);
    expect(rm.locate(player.token)?.player.connected).toBe(true);
    for (let i = 0; i < 3; i++) first.request('time:ping', { clientSentAt: 0 });
    expect(first.request('time:ping', { clientSentAt: 0 }).error).toContain('Rate limit');
    expect(socket('10.42.0.7', '198.51.100.3').request<any>('time:ping', { clientSentAt: 0 }).serverNow).toBeDefined();
  });

  it('ignores spoofed forwarded addresses on direct connections and untrusted proxies', () => {
    const { socket } = setup(c => { c.net = { ...c.net!, joinBurst: 1 }; });
    joined(socket('198.51.100.1', '203.0.113.1').request<JoinResult>('room:create', { name: 'm' }));
    expect(socket('198.51.100.1', '203.0.113.2').request('room:create', { name: 'other' }).error).toContain('Join limit');
  });
});
