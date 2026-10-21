import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatchResult, PlayerView, RoomView } from '@fnab/shared';

const wire = vi.hoisted(() => ({
  connected: true,
  handlers: new Map<string, (...args: any[]) => void>(),
  on: vi.fn(), emit: vi.fn(), io: { on: vi.fn() },
}));
vi.mock('socket.io-client', () => ({ io: () => wire }));

function storage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) };
}

let net: typeof import('../socket');
let state: typeof import('../../state/store');
const session = { code: 'ABCD', token: 'valid-session-token' };
const room = { code: 'ABCD', stage: 'playing' } as RoomView;
const view = { role: 'monster', t: 1000, t0Epoch: 999_000, ended: false, events: [] } as unknown as PlayerView;
const result = { reason: 'timer' } as MatchResult;
const requests = (event: string) => wire.emit.mock.calls.filter(([name]) => name === event);
const reply = (res: unknown) => requests('room:resume').at(-1)![2](res);
const connect = () => { net.getSocket(); wire.connected = true; wire.handlers.get('connect')!(); };

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  vi.stubGlobal('sessionStorage', storage()); vi.stubGlobal('localStorage', storage());
  sessionStorage.setItem('fnab.session', JSON.stringify(session));
  wire.handlers.clear(); wire.connected = true; wire.emit.mockReset(); wire.on.mockReset(); wire.io.on.mockReset();
  wire.on.mockImplementation((name, handler) => { wire.handlers.set(name, handler); return wire; });
  state = await import('../../state/store'); net = await import('../socket');
  state.useGame.getState().set({ room, view, result, clockOffset: 250, rtt: 20 });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('session recovery', () => {
  it.each(['Join limit exceeded — try again shortly', 'Rate limit exceeded — try again shortly', 'Internal server error'])('retains credentials and game state and backs off on temporary resume failure: %s', error => {
    connect(); reply({ ok: false, error });
    expect(JSON.parse(sessionStorage.getItem('fnab.session')!)).toEqual(session);
    expect(state.useGame.getState()).toMatchObject({ room, view, result, connection: 'reconnecting' });
    for (const delay of [500, 1000, 2000, 4000, 4000]) {
      const before = requests('room:resume').length;
      vi.advanceTimersByTime(delay - 1);
      expect(requests('room:resume')).toHaveLength(before);
      vi.advanceTimersByTime(1);
      expect(requests('room:resume')).toHaveLength(before + 1);
      expect(requests('room:resume').at(-1)![1]).toEqual(session);
      reply({ ok: false, error });
    }
    vi.advanceTimersByTime(4000);
    reply({ ok: true, ...session, playerId: 'p' });
    const before = requests('room:resume').length;
    vi.advanceTimersByTime(5000);
    expect(requests('room:resume')).toHaveLength(before);
    expect(state.useGame.getState().connection).toBe('online');
    expect(sessionStorage.getItem('fnab.session')).not.toBeNull();
  });

  it.each(['Room not found', 'Session expired', 'Reconnection grace expired', 'Invalid session'])('clears credentials only on definitive session invalidation: %s', error => {
    connect(); reply({ ok: false, error });
    expect(sessionStorage.getItem('fnab.session')).toBeNull();
    expect(state.useGame.getState()).toMatchObject({ room: null, view: null, result: null });
    vi.advanceTimersByTime(10_000);
    expect(requests('room:resume')).toHaveLength(1);
  });

  it('retries missing acknowledgements and ignores late failures from an older attempt', () => {
    connect();
    const stale = requests('room:resume')[0]![2];
    vi.advanceTimersByTime(4500);
    expect(requests('room:resume')).toHaveLength(2);
    reply({ ok: true, ...session, playerId: 'p' });
    stale({ ok: false, error: 'Session expired' });
    expect(sessionStorage.getItem('fnab.session')).not.toBeNull();
    expect(state.useGame.getState().connection).toBe('online');
  });

  it.each(['leave', 'kick', 'disconnect'])('cancels queued retries and stale callbacks on %s', action => {
    connect(); const stale = requests('room:resume')[0]![2];
    reply({ ok: false, error: 'Join limit exceeded — try again shortly' });
    if (action === 'leave') net.leaveRoom();
    else if (action === 'kick') wire.handlers.get('room:kicked')!({ reason: 'Session opened elsewhere' });
    else { wire.connected = false; wire.handlers.get('disconnect')!(); }
    stale({ ok: false, error: 'Session expired' });
    vi.advanceTimersByTime(10_000);
    expect(requests('room:resume')).toHaveLength(1);
    if (action === 'disconnect') {
      expect(sessionStorage.getItem('fnab.session')).not.toBeNull();
      connect(); expect(requests('room:resume')).toHaveLength(2);
    } else expect(sessionStorage.getItem('fnab.session')).toBeNull();
  });

  it('cancels resume recovery when a new join succeeds and ignores the old session callback', async () => {
    connect(); const stale = requests('room:resume')[0]![2];
    reply({ ok: false, error: 'Join limit exceeded — try again shortly' });
    const pending = net.joinRoom('EFGH', 'Operator');
    const next = { ok: true, code: 'EFGH', token: 'new-session-token', playerId: 'other' };
    requests('room:join').at(-1)![2](next);
    expect(await pending).toEqual(next);
    stale({ ok: false, error: 'Session expired' });
    vi.advanceTimersByTime(5000);
    expect(requests('room:resume')).toHaveLength(1);
    expect(JSON.parse(sessionStorage.getItem('fnab.session')!)).toEqual({ code: next.code, token: next.token });
    expect(state.useGame.getState().connection).toBe('online');
  });
});

describe('clock synchronization', () => {
  it('preserves the last valid estimate and finite match time when clock pings are rate limited', () => {
    wire.emit.mockImplementation((event, payload, ack) => {
      if (event === 'time:ping') ack({ clientSentAt: payload.clientSentAt, serverNow: Date.now() + 100 });
    });
    connect(); vi.advanceTimersByTime(300);
    expect(state.useGame.getState().clockOffset).toBe(100);
    const estimate = { clockOffset: state.useGame.getState().clockOffset, rtt: state.useGame.getState().rtt };
    wire.emit.mockImplementation((event, _payload, ack) => { if (event === 'time:ping') ack({ ok: false, error: 'Rate limit exceeded' }); });
    net.syncClock(); vi.advanceTimersByTime(300);
    expect(state.useGame.getState()).toMatchObject(estimate);
    expect(Number.isFinite(state.matchNow(view))).toBe(true);
    expect(Number.isFinite(state.serverNow())).toBe(true);
  });

  it.each([null, {}, { clientSentAt: NaN, serverNow: 0 }, { clientSentAt: 1_000_000, serverNow: Infinity },
    { clientSentAt: '1000000', serverNow: 0 }, { clientSentAt: 999_999, serverNow: 1_000_000 }])('ignores malformed, non-finite and mismatched clock replies: %j', response => {
    wire.emit.mockImplementation((event, _payload, ack) => { if (event === 'time:ping') ack(response); });
    connect(); vi.advanceTimersByTime(300);
    expect(state.useGame.getState()).toMatchObject({ clockOffset: 250, rtt: 20 });
    expect(Number.isFinite(state.matchNow(view))).toBe(true);
  });
});
