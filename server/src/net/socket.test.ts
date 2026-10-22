import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Graph, type ActionResult, type JoinResult, type PlayerView } from '@fnab/shared';
import { RoomManager } from '../rooms/RoomManager';
import { SimulationCameraService } from '../cameras/simulation';
import { attachSockets } from './socket';
import { networkLimits, TokenBucket } from './limits';
import { FIXTURE, testCfg } from '../../test/fixtures';
import { EventEmitter } from 'node:events';

// Exercise the real transport registrations without opening ports or using the network.
class WireSocket {
  data: { code?: string; playerId?: string } = {};
  handshake: { address: string; headers: { 'x-forwarded-for'?: string }; auth?: { viewDeltas: boolean } };
  handlers = new Map<string, (...args: any[]) => void>();
  out: Array<{ event: string; value: any }> = [];
  constructor(readonly id: string, ip = '127.0.0.1', forwarded?: string) { this.handshake = { address: ip, headers: { 'x-forwarded-for': forwarded } }; }
  on(event: string, handler: (...args: any[]) => void) { this.handlers.set(event, handler); }
  off(event: string, handler: (...args: any[]) => void) { if (this.handlers.get(event) === handler) this.handlers.delete(event); }
  emit(event: string, value: unknown) { this.out.push({ event, value }); }
  disconnect() { this.handlers.get('disconnect')?.(); }
  request<T = ActionResult>(event: string, payload?: unknown): T {
    let reply: unknown;
    const ack = (v: unknown) => { reply = v; };
    if (event === 'room:restart' || event === 'game:resync') this.handlers.get(event)?.(ack);
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
  it('validates solo setup, publishes tagged seats and limits AI management to the host/lobby', () => {
    const { rm, cfg, socket } = setup(), host = socket(), guest = socket();
    for (const p of [
      { name: 'Solo', role: 'spectator', difficulty: 'expert' },
      { name: 'Solo', role: 'defender', difficulty: 'cheater' },
      { name: 'Solo', role: 'defender', difficulty: 'expert', teammates: 3 },
      { name: 'Solo', role: 'defender', difficulty: 'expert', teammates: 0.5 },
    ]) expect(host.request('room:createSolo', p).ok).toBe(false);
    expect(rm.rooms.size).toBe(0);
    const a = joined(host.request<JoinResult>('room:createSolo', { name: 'Solo', role: 'defender', difficulty: 'expert', teammates: 1 }));
    const room = rm.rooms.get(a.code)!;
    const aiMonster = [...room.players.values()].find(p => p.ai && p.role === 'monster')!;
    expect(host.values('room:state').at(-1).players).toContainEqual(expect.objectContaining({ id: aiMonster.id, ai: { difficulty: 'expert' }, ready: true }));
    guest.request('room:join', { code: a.code, name: 'Guest' });
    expect(guest.request('lobby:addAi', { role: 'defender', difficulty: 'novice' }).ok).toBe(false);
    expect(guest.request('lobby:removeAi', { playerId: aiMonster.id }).ok).toBe(false);
    expect(guest.request('lobby:setAiDifficulty', { playerId: aiMonster.id, difficulty: 'novice' }).ok).toBe(false);
    expect(host.request('lobby:addAi', { role: 'defender', difficulty: 'novice' }).ok).toBe(true);
    expect(host.request('lobby:setAiDifficulty', { playerId: aiMonster.id, difficulty: 'novice' }).ok).toBe(true);
    expect(host.request('lobby:setAiDifficulty', { playerId: aiMonster.id, difficulty: 'omniscient' }).ok).toBe(false);
    const aiDefender = [...room.players.values()].find(p => p.ai && p.role === 'defender')!;
    expect(host.request('lobby:removeAi', { playerId: aiDefender.id }).ok).toBe(true);
    host.request('lobby:setReady', { ready: true }); guest.request('lobby:setReady', { ready: true });
    vi.advanceTimersByTime(cfg.tickMs + cfg.match.countdownMs + cfg.tickMs);
    expect(room.stage).toBe('playing');
    expect(host.request('lobby:addAi', { role: 'defender', difficulty: 'novice' }).ok).toBe(false);
    expect(host.request('lobby:removeAi', { playerId: aiMonster.id }).ok).toBe(false);
    expect(host.request('room:createSolo', { name: 'Switch', role: 'monster', difficulty: 'expert' }).ok).toBe(false);
  });

  it('AI lobby events share the normal request rate limits', () => {
    const { cfg, socket } = setup(c => { c.net!.socketBurst = 3; c.net!.socketPerSecond = 1; });
    const host = socket();
    joined(host.request<JoinResult>('room:createSolo', { name: 'Solo', role: 'monster', difficulty: 'competent' }));
    expect(host.request('lobby:addAi', { role: 'defender', difficulty: 'novice' }).ok).toBe(true);
    expect(host.request('lobby:addAi', { role: 'defender', difficulty: 'expert' }).ok).toBe(true);
    expect(host.request('lobby:addAi', { role: 'defender', difficulty: 'competent' }).error).toMatch(/Rate limit/);
    vi.advanceTimersByTime(1000);
    expect(host.request('lobby:addAi', { role: 'defender', difficulty: 'expert' }).ok).toBe(true);
    expect(cfg.net!.socketBurst).toBe(3);
  });

  it('solo creates also consume the per-IP join budget across sockets', () => {
    const { rm, socket } = setup(c => { c.net!.joinBurst = 1; c.net!.joinPerSecond = 0.1; });
    const options = { name: 'Solo', role: 'monster', difficulty: 'expert' };
    joined(socket().request<JoinResult>('room:createSolo', options));
    expect(socket().request('room:createSolo', options).error).toMatch(/Join limit/);
    expect(rm.rooms.size).toBe(1);
  });

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
    // A disconnected socket has no handlers left; a new socket from the same client address shares its budget.
    expect(first.handlers.size).toBe(0);
    const again = socket('10.42.0.7', '198.51.100.1');
    for (let i = 0; i < 3; i++) again.request('time:ping', { clientSentAt: 0 });
    expect(again.request('time:ping', { clientSentAt: 0 }).error).toContain('Rate limit');
    expect(socket('10.42.0.7', '198.51.100.3').request<any>('time:ping', { clientSentAt: 0 }).serverNow).toBeDefined();
  });

  it('ignores spoofed forwarded addresses on direct connections and untrusted proxies', () => {
    const { socket } = setup(c => { c.net = { ...c.net!, joinBurst: 1 }; });
    joined(socket('198.51.100.1', '203.0.113.1').request<JoinResult>('room:create', { name: 'm' }));
    expect(socket('198.51.100.1', '203.0.113.2').request('room:create', { name: 'other' }).error).toContain('Join limit');
  });
});

describe('recovery transport and resource lifecycle', () => {
  it('recovery rejects connected/forged seats, resumes a disconnected seat, and handles lost-ack retries on its own binding', () => {
    const { rm, socket } = setup(), first = socket(), reopened = socket();
    const seat = joined(first.request<JoinResult>('room:create', { name: 'Original' }));
    const request = { code: seat.code, playerId: seat.playerId, token: seat.token };
    expect(reopened.request('room:recover', request)).toMatchObject({ ok: false, error: 'Seat is connected in another tab' });
    expect(first.values('room:kicked')).toHaveLength(0);
    first.disconnect();
    expect(reopened.request('room:recover', { ...request, playerId: 'forged' }).ok).toBe(false);
    expect(reopened.request('room:recover', request)).toEqual(seat);
    expect(reopened.request('room:recover', request)).toEqual(seat);
    expect(rm.rooms.get(seat.code)!.players.size).toBe(1);
    expect(socket().request('room:recover', request).ok).toBe(false);
    expect(reopened.values('room:kicked')).toHaveLength(0);
  });
  it('negotiates deltas, resets on resync/rebind, and keeps legacy clients on full views', () => {
    const { cfg, socket } = setup(), m = socket(), d = socket();
    m.handshake.auth = { viewDeltas: true };
    const seat = joined(m.request<JoinResult>('room:create', { name: 'Monster' }));
    d.request('room:join', { code: seat.code, name: 'Defender' });
    m.request('lobby:setReady', { ready: true }); d.request('lobby:setReady', { ready: true });
    vi.advanceTimersByTime(cfg.tickMs + cfg.match.countdownMs + cfg.tickMs * 2);
    expect(m.values('game:delta').length).toBeGreaterThan(0);
    expect(d.values('game:delta')).toHaveLength(0);
    expect(d.values('game:view').length).toBeGreaterThan(1);
    const before = m.values('game:view').length;
    expect(m.request('game:resync')).toEqual({ ok: true });
    vi.advanceTimersByTime(cfg.tickMs);
    expect(m.values('game:view')).toHaveLength(before + 1);
    m.disconnect();
    const reconnected = socket(); reconnected.handshake.auth = { viewDeltas: true };
    reconnected.request('room:resume', { code: seat.code, token: seat.token });
    expect(reconnected.values('game:view')).toHaveLength(1);
    expect(reconnected.values('game:delta')).toHaveLength(0);
  });
  it('removes transport timers, camera subscriptions, connection listeners and every socket handler when stopped', () => {
    const io = new EventEmitter();
    const cfg = testCfg(), rm = new RoomManager({ graph: new Graph(FIXTURE), cfg, placementCount: () => 1 });
    const cameras = new SimulationCameraService({ cameras: [] });
    let subscriptions = 0;
    vi.spyOn(cameras, 'subscribe').mockImplementation(() => { subscriptions++; return () => { subscriptions--; }; });
    const timers = vi.getTimerCount();
    for (let i = 0; i < 100; i++) {
      const dispose = attachSockets(io as never, rm, cameras, cfg.tickMs);
      const s = new WireSocket(`cycle-${i}`);
      io.emit('connection', s);
      expect(s.handlers.size).toBeGreaterThan(10);
      expect(io.listenerCount('connection')).toBe(1);
      dispose();
      expect(s.handlers.size).toBe(0);
      expect(io.listenerCount('connection')).toBe(0);
      expect(subscriptions).toBe(0);
      expect(vi.getTimerCount()).toBe(timers);
    }
  });
});
