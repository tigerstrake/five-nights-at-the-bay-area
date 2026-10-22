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

describe('fresh-tab seat recovery', () => {
  const hint = { ...session, playerId: 'p', name: 'Original', savedAt: 1_000_000 };
  const prepare = () => {
    sessionStorage.removeItem('fnab.session');
    localStorage.setItem('fnab.recovery.ABCD', JSON.stringify(hint));
    state.useGame.getState().set({ room: null, view: null, result: null });
  };
  it('automatically recovers a disconnected seat from an invitation URL and saves a per-tab session', () => {
    prepare(); vi.stubGlobal('location', { search: '?room=abcd' }); connect();
    expect(requests('room:recover').at(-1)![1]).toEqual({ ...session, playerId: 'p' });
    requests('room:recover').at(-1)![2]({ ok: true, ...session, playerId: 'p' });
    expect(JSON.parse(sessionStorage.getItem('fnab.session')!)).toEqual(session);
    expect(state.useGame.getState().connection).toBe('online');
    expect(requests('room:join')).toHaveLength(0);
    expect(requests('room:resume')).toHaveLength(0);
  });
  it('recovers before joining by code and retains the original player name', async () => {
    prepare();
    const pending = net.joinRoom('abcd', 'New name');
    expect(requests('room:join')).toHaveLength(0);
    requests('room:recover').at(-1)![2]({ ok: true, ...session, playerId: 'p' });
    expect(await pending).toMatchObject({ ok: true, playerId: 'p' });
    expect(localStorage.getItem('fnab.name')).toBe('Original');
  });
  it('a connected seat stays in its live tab and the joining tab gets an independent token', async () => {
    prepare(); const pending = net.joinRoom('ABCD', 'Second tab');
    requests('room:recover').at(-1)![2]({ ok: false, error: 'Seat is connected in another tab' });
    await vi.waitFor(() => expect(requests('room:join')).toHaveLength(1));
    const request = requests('room:join').at(-1)!;
    expect(request[1].token).not.toBe(session.token);
    const joined = { ok: true, code: 'ABCD', token: 'second-tab-session-token', playerId: 'other' };
    request[2](joined); expect(await pending).toEqual(joined);
    expect(requests('room:resume')).toHaveLength(0);
  });
  it('a tab with its own session ignores another tab\'s local recovery hint', async () => {
    localStorage.setItem('fnab.recovery.ABCD', JSON.stringify({ ...hint, token: 'some-other-tab-token' }));
    vi.stubGlobal('location', { search: '?room=ABCD' }); connect();
    expect(requests('room:recover')).toHaveLength(0);
    expect(requests('room:resume')[0]![1]).toEqual(session);
  });
  it('keeps a fresh-tab hint through temporary failures and retries lost acknowledgements safely', () => {
    prepare(); vi.stubGlobal('location', { search: '?room=ABCD' }); connect();
    const stale = requests('room:recover')[0]![2];
    vi.advanceTimersByTime(4500);
    expect(requests('room:recover')).toHaveLength(2);
    requests('room:recover').at(-1)![2]({ ok: false, error: 'Join limit exceeded — try again shortly' });
    expect(localStorage.getItem('fnab.recovery.ABCD')).not.toBeNull();
    expect(requests('room:join')).toHaveLength(0);
    vi.advanceTimersByTime(1000);
    requests('room:recover').at(-1)![2]({ ok: true, ...session, playerId: 'p' });
    stale({ ok: false, error: 'Session expired' });
    expect(sessionStorage.getItem('fnab.session')).not.toBeNull();
  });
  it.each(['room:leave', 'room:kicked', 'game:result', 'room:state'])('clears the local recovery hint on leave/kick/match end via %s', event => {
    localStorage.setItem('fnab.recovery.ABCD', JSON.stringify(hint)); net.getSocket();
    if (event === 'room:leave') net.leaveRoom();
    else if (event === 'room:kicked') wire.handlers.get(event)!({ reason: 'Removed' });
    else if (event === 'room:state') wire.handlers.get(event)!({ ...room, stage: 'results', players: [], youId: 'p' });
    else wire.handlers.get(event)!({ ...result, timeline: [], monsterPath: [] });
    expect(localStorage.getItem('fnab.recovery.ABCD')).toBeNull();
    if (event === 'game:result' || event === 'room:state') expect(sessionStorage.getItem('fnab.session')).not.toBeNull();
  });
  it('refreshes the hint every 15 seconds and when the tab is closed, never after the match ended', () => {
    const page = new EventTarget();
    vi.stubGlobal('addEventListener', page.addEventListener.bind(page));
    const dispatchEvent = page.dispatchEvent.bind(page);
    localStorage.setItem('fnab.recovery.ABCD', JSON.stringify(hint)); net.getSocket();
    const fullRoom = { ...room, players: [{ id: 'p', name: 'Original', role: 'monster' as const, ready: true, connected: true, isHost: true }], youId: 'p' };
    state.useGame.getState().set({ room: fullRoom });
    const savedAt = () => JSON.parse(localStorage.getItem('fnab.recovery.ABCD')!)[0].savedAt;
    vi.advanceTimersByTime(15_000);
    expect(savedAt()).toBe(Date.now());
    vi.advanceTimersByTime(5_000);
    dispatchEvent(new Event('pagehide'));
    expect(savedAt()).toBe(Date.now());
    wire.handlers.get('game:view')!({ ...view, ended: true });
    expect(localStorage.getItem('fnab.recovery.ABCD')).toBeNull();
    vi.advanceTimersByTime(15_000); dispatchEvent(new Event('pagehide'));
    expect(localStorage.getItem('fnab.recovery.ABCD')).toBeNull();
  });
  it('tries every recent seat of this browser in the room, skipping seats that are live in other tabs', async () => {
    sessionStorage.removeItem('fnab.session');
    state.useGame.getState().set({ room: null, view: null, result: null });
    const older = { ...hint, playerId: 'p-old', token: 'older-session-token', savedAt: 990_000 };
    localStorage.setItem('fnab.recovery.ABCD', JSON.stringify([older, hint]));
    vi.stubGlobal('location', { search: '?room=ABCD' }); connect();
    expect(requests('room:recover')[0]![1]).toMatchObject({ playerId: 'p' });
    requests('room:recover')[0]![2]({ ok: false, error: 'Seat is connected in another tab' });
    await vi.waitFor(() => expect(requests('room:recover')).toHaveLength(2));
    expect(requests('room:recover')[1]![1]).toEqual({ code: 'ABCD', playerId: 'p-old', token: older.token });
    requests('room:recover')[1]![2]({ ok: true, code: 'ABCD', playerId: 'p-old', token: older.token });
    expect(JSON.parse(sessionStorage.getItem('fnab.session')!)).toEqual({ code: 'ABCD', token: older.token });
    // The live tab's hint is untouched.
    expect(JSON.parse(localStorage.getItem('fnab.recovery.ABCD')!).map((s: { token: string }) => s.token)).toContain(hint.token);
  });
  it('a live seat in another tab only produces a notice on the invite link; nothing is joined or taken over', async () => {
    prepare(); vi.stubGlobal('location', { search: '?room=ABCD' }); connect();
    requests('room:recover')[0]![2]({ ok: false, error: 'Seat is connected in another tab' });
    await vi.waitFor(() => expect(state.useGame.getState().toasts.at(-1)?.text).toMatch(/another tab/));
    expect(requests('room:join')).toHaveLength(0);
    expect(requests('room:resume')).toHaveLength(0);
    expect(sessionStorage.getItem('fnab.session')).toBeNull();
    expect(localStorage.getItem('fnab.recovery.ABCD')).not.toBeNull();
  });
  it('forgets every hint of a room that no longer exists', async () => {
    prepare(); vi.stubGlobal('location', { search: '?room=ABCD' }); connect();
    requests('room:recover')[0]![2]({ ok: false, error: 'Room not found' });
    await Promise.resolve();
    expect(localStorage.getItem('fnab.recovery.ABCD')).toBeNull();
    expect(requests('room:recover')).toHaveLength(1);
  });
});

describe('view delta transport', () => {
  it('opts in, patches the last view, and asks for a checkpoint (throttled) when the base is missing', () => {
    connect();
    wire.handlers.get('game:view')!({ ...view, viewSequence: 1, power: { value: 50 } });
    wire.handlers.get('game:delta')!({ baseSequence: 1, sequence: 2, changes: { t: 1100 }, removed: ['power'] });
    expect(state.useGame.getState().view).toMatchObject({ t: 1100, viewSequence: 2, role: 'monster' });
    expect(state.useGame.getState().view).not.toHaveProperty('power');
    wire.handlers.get('game:delta')!({ baseSequence: 7, sequence: 8, changes: { t: 1200 } });
    wire.handlers.get('game:delta')!({ baseSequence: 8, sequence: 9, changes: { t: 1300 } });
    expect(state.useGame.getState().view?.t).toBe(1100);
    expect(requests('game:resync')).toHaveLength(1);
    vi.advanceTimersByTime(600);
    wire.handlers.get('game:delta')!({ baseSequence: 8, sequence: 9, changes: { t: 1300 } });
    expect(requests('game:resync')).toHaveLength(2);
  });
});
