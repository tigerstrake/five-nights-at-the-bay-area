// Socket.IO client singleton + session persistence + server clock sync.
import { io, type Socket } from 'socket.io-client';
import type { AiDifficulty, ClientToServerEvents, GameAction, JoinResult, PlayerView, ServerToClientEvents, ActionResult, Role, HqId, SoloOptions } from '@fnab/shared';
import { normalizeResult, useGame } from '../state/store';
import { clearRecovery, clearRoomRecoveries, pruneRecoveries, readRecoveries, roomCode, saveRecovery, type RecoverySeat } from './recovery';
import { applyViewDelta } from '../state/viewDelta';

export type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const SESSION_KEY = 'fnab.session'; // sessionStorage: per tab, so two tabs = two players
const NAME_KEY = 'fnab.name'; // localStorage convenience

interface Session {
  code: string;
  token: string;
}

function readSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}
function writeSession(s: Session | null) {
  try {
    if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage unavailable */
  }
}
function forgetSession() {
  forgetHint(readSession());
  writeSession(null);
}
function recoveriesFor(code: string): RecoverySeat[] {
  try { return readRecoveries(localStorage, code); } catch { return []; }
}
function forgetHint(sess: Session | null) {
  try { if (sess) clearRecovery(localStorage, sess); } catch { /* Storage unavailable. */ }
}
function rememberSeat(res: { code: string; token: string; playerId: string }, name: string) {
  try { saveRecovery(localStorage, { code: res.code, token: res.token, playerId: res.playerId, name }); } catch { /* Storage unavailable. */ }
}
/** Refresh this tab's cross-tab hint while it holds a seat in a lobby or a running match. */
function refreshSeat() {
  const sess = readSession(), { room, view } = useGame.getState();
  if (!sess || !room || room.code !== sess.code || room.stage === 'results' || view?.ended) return;
  const me = room.players?.find(p => p.id === room.youId);
  if (me) rememberSeat({ ...sess, playerId: me.id }, me.name);
}
export function savedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}
function saveName(n: string) {
  try {
    localStorage.setItem(NAME_KEY, n);
  } catch {
    /* ignore */
  }
}
function tabToken(): string {
  const s = readSession();
  if (s?.token) return s.token;
  return crypto.randomUUID();
}

let socket: ClientSocket | null = null;
let cancelResume = () => {};

const SESSION_INVALID_ERRORS = new Set(['Room not found', 'Session expired', 'Reconnection grace expired', 'Invalid session']);
const SEAT_LIVE_ERROR = 'Seat is connected in another tab';
const RECOVERY_FINAL_ERRORS = new Set([SEAT_LIVE_ERROR, 'Match ended', 'Cannot change identity during a match']);
const RESUME_RETRY_BASE_MS = 500;
const RESUME_RETRY_MAX_MS = 4_000;
const RESUME_ACK_TIMEOUT_MS = 4_000;
const RESYNC_MIN_INTERVAL_MS = 500;

function resumeSession(s: ClientSocket, recovery?: RecoverySeat, done?: (res: JoinResult) => void) {
  cancelResume();
  const sess = recovery ?? readSession();
  if (!sess) return;
  let cancelled = false, attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  cancelResume = () => {
    if (cancelled) return;
    cancelled = true; clearTimeout(timer);
    done?.({ ok: false, error: 'Recovery cancelled' });
  };
  const current = () => {
    const saved = readSession();
    return !cancelled && s.connected && (recovery ? !saved : saved?.code === sess.code && saved.token === sess.token);
  };
  const retry = () => {
    if (!current()) return;
    useGame.getState().set({ connection: 'reconnecting' });
    timer = setTimeout(send, Math.min(RESUME_RETRY_MAX_MS, RESUME_RETRY_BASE_MS * 2 ** Math.min(attempt++, 4)));
  };
  const send = () => {
    if (!current()) return;
    let pending = true;
    // Socket.IO may never acknowledge a request lost during a transport interruption.
    timer = setTimeout(() => { pending = false; retry(); }, RESUME_ACK_TIMEOUT_MS);
    const receive = (res: JoinResult) => {
      if (!pending || !current()) return;
      pending = false;
      clearTimeout(timer);
      if (res.ok) {
        cancelled = true; clearTimeout(timer);
        if (recovery) onJoined(res, recovery.name);
        useGame.getState().set({ connection: 'online' });
        done?.(res);
      } else if (SESSION_INVALID_ERRORS.has(res.error) || (recovery && RECOVERY_FINAL_ERRORS.has(res.error))) {
        cancelled = true; clearTimeout(timer);
        if (recovery) {
          if (res.error !== SEAT_LIVE_ERROR) forgetHint(recovery);
          useGame.getState().set({ connection: 'online' });
        } else {
          forgetSession();
          useGame.getState().set({ connection: 'online', room: null, view: null, result: null });
          useGame.getState().toast(res.error === 'Session expired' ? 'Previous session expired' : res.error, 'warn');
        }
        done?.(res);
      } else {
        if (attempt === 0) useGame.getState().toast(res.error, 'warn');
        retry();
      }
    };
    if (recovery) s.emit('room:recover', { code: recovery.code, playerId: recovery.playerId, token: recovery.token }, receive);
    else s.emit('room:resume', sess, receive);
  };
  send();
}

/**
 * Fresh tab (no per-tab session): try this browser's recent seats in `code`, newest first. The server only hands
 * back a seat that is currently disconnected, so a seat still open in another tab is never taken over.
 * Resolves null when there was nothing to try.
 */
async function recoverAny(s: ClientSocket, code: string): Promise<JoinResult | null> {
  let last: JoinResult | null = null;
  for (const seat of recoveriesFor(code)) {
    if (readSession()) break;
    const res = await new Promise<JoinResult>(resolve => resumeSession(s, seat, resolve));
    last = res;
    if (!res.ok && res.error === 'Room not found') {
      try { clearRoomRecoveries(localStorage, code); } catch { /* Storage unavailable. */ }
    }
    if (res.ok || !RETRY_NEXT_SEAT.has(res.error)) return res;
  }
  return last;
}
const RETRY_NEXT_SEAT = new Set([SEAT_LIVE_ERROR, 'Session expired', 'Reconnection grace expired', 'Invalid session', 'Match ended']);

export function getSocket(): ClientSocket {
  if (socket) return socket;
  const s: ClientSocket = io({ path: '/socket.io', transports: ['websocket', 'polling'], autoConnect: true, auth: { viewDeltas: true } });
  socket = s;
  const store = useGame.getState;
  try { pruneRecoveries(localStorage); } catch { /* Storage unavailable. */ }

  s.on('connect', () => {
    store().set({ connection: 'online' });
    syncClock();
    const invited = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('room');
    if (readSession() || !invited) return resumeSession(s);
    void recoverAny(s, invited).then(res => {
      if (res && !res.ok && res.error === SEAT_LIVE_ERROR) store().toast('Your seat in this room is open in another tab', 'info');
    });
  });
  s.on('disconnect', () => { cancelResume(); store().set({ connection: 'reconnecting' }); });
  s.io.on('reconnect_attempt', () => store().set({ connection: 'reconnecting' }));
  s.on('room:state', (room) => {
    store().setRoom(room);
    const sess = readSession();
    if (sess?.code !== room.code) return;
    if (room.stage === 'results') forgetHint(sess);
    else refreshSeat();
  });
  const receiveView = (view: PlayerView) => {
    const wasEnded = store().view?.ended;
    store().setView(view);
    if (view.ended && !wasEnded) forgetHint(readSession());
  };
  s.on('game:view', receiveView);
  // Opt-in delta transport (auth.viewDeltas): patch the last view; on any gap ask for a full checkpoint.
  let resyncAt = -Infinity;
  s.on('game:delta', delta => {
    const view = applyViewDelta(store().view, delta);
    if (view) return receiveView(view);
    if (Date.now() - resyncAt < RESYNC_MIN_INTERVAL_MS) return;
    resyncAt = Date.now();
    s.emit('game:resync');
  });
  s.on('game:result', (result) => {
    forgetHint(readSession());
    store().set({ result: normalizeResult(result) });
  });
  s.on('cameras:status', (st) => store().setCameraStatuses(st));
  s.on('room:kicked', ({ reason }) => {
    // Forget the seat: otherwise this tab would auto-resume on its next reconnect and kick the replacement
    // connection (e.g. the same player who reopened the game in another tab).
    cancelResume();
    forgetSession();
    store().toast(reason, 'warn');
    store().set({ room: null, view: null, result: null });
  });
  setInterval(() => { syncClock(); refreshSeat(); }, 15_000);
  // Closing the tab is exactly when a fresh tab will need the hint: stamp it with the closing time.
  if (typeof addEventListener === 'function') addEventListener('pagehide', refreshSeat);
  return s;
}

/** NTP-style offset estimate; keeps the best (lowest RTT) of recent samples. */
const samples: Array<{ rtt: number; offset: number }> = [];
export function syncClock() {
  const s = socket;
  if (!s?.connected) return;
  for (let i = 0; i < 3; i++) {
    setTimeout(() => {
      if (!s.connected) return;
      const sent = Date.now();
      s.emit('time:ping', { clientSentAt: sent }, (res) => {
        const now = Date.now();
        // The generic server limiter can acknowledge any event with a failure payload.
        if (!res || !Number.isFinite(res.clientSentAt) || !Number.isFinite(res.serverNow) || res.clientSentAt !== sent) return;
        const rtt = now - res.clientSentAt;
        const offset = res.serverNow + rtt / 2 - now;
        if (rtt < 0 || !Number.isFinite(rtt) || !Number.isFinite(offset)) return;
        samples.push({ rtt, offset });
        if (samples.length > 10) samples.shift();
        const best = [...samples].sort((a, b) => a.rtt - b.rtt)[0]!;
        useGame.getState().set({ clockOffset: best.offset, rtt: best.rtt });
      });
    }, i * 150);
  }
}

function onJoined(res: JoinResult, name: string): JoinResult {
  if (res.ok) {
    cancelResume();
    writeSession({ code: res.code, token: res.token });
    if (useGame.getState().room?.stage !== 'results') rememberSeat(res, name);
    saveName(name);
    useGame.getState().set({ connection: 'online' });
  }
  return res;
}

export function createRoom(name: string): Promise<JoinResult> {
  return new Promise((resolve) => getSocket().emit('room:create', { name, token: tabToken() }, (r) => resolve(onJoined(r, name))));
}
export function createSoloRoom(name: string, options: SoloOptions): Promise<JoinResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: 'Server did not respond' }), 4000);
    getSocket().emit('room:createSolo', { name, ...options, token: tabToken() }, (r) => {
      clearTimeout(timer);
      resolve(onJoined(r, name));
    });
  });
}
export async function joinRoom(code: string, name: string): Promise<JoinResult> {
  const s = getSocket();
  if (!readSession()) {
    const res = await recoverAny(s, code);
    if (res && (res.ok || res.error === 'Recovery cancelled' || res.error === 'Cannot change identity during a match')) return res;
    // A seat still open in another tab stays there: joining creates an independent player with its own token.
    if (res && !res.ok && res.error === SEAT_LIVE_ERROR) useGame.getState().toast('Your earlier seat is open in another tab — joining as a new player', 'info');
  }
  return new Promise((resolve) => s.emit('room:join', { code: roomCode(code), name, token: tabToken() }, (r) => resolve(onJoined(r, name))));
}
export function leaveRoom() {
  cancelResume();
  getSocket().emit('room:leave');
  forgetSession();
  useGame.getState().set({ room: null, view: null, result: null });
}

const ackP = (fn: (ack: (r: ActionResult) => void) => void): Promise<ActionResult> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: 'Server did not respond' }), 4000);
    fn((r) => {
      clearTimeout(timer);
      resolve(r);
    });
  });

async function withToast(p: Promise<ActionResult>): Promise<ActionResult> {
  const r = await p;
  if (!r.ok && r.error) useGame.getState().toast(r.error, 'error');
  return r;
}

export const lobby = {
  addAi: (role: 'monster' | 'defender', difficulty: AiDifficulty) => withToast(ackP((a) => getSocket().emit('lobby:addAi', { role, difficulty }, a))),
  removeAi: (playerId: string) => withToast(ackP((a) => getSocket().emit('lobby:removeAi', { playerId }, a))),
  setAiDifficulty: (playerId: string, difficulty: AiDifficulty) => withToast(ackP((a) => getSocket().emit('lobby:setAiDifficulty', { playerId, difficulty }, a))),
  setRole: (role: Role) => withToast(ackP((a) => getSocket().emit('lobby:setRole', { role }, a))),
  setReady: (ready: boolean) => withToast(ackP((a) => getSocket().emit('lobby:setReady', { ready }, a))),
  setName: (name: string) => withToast(ackP((a) => getSocket().emit('lobby:setName', { name }, a))),
  setDuration: (durationSec: number) => withToast(ackP((a) => getSocket().emit('lobby:setSettings', { durationSec }, a))),
  selectHq: (hqId: HqId) => withToast(ackP((a) => getSocket().emit('lobby:selectHq', { hqId }, a))),
  restart: () => withToast(ackP((a) => getSocket().emit('room:restart', a))),
};

export function sendAction(action: GameAction): Promise<ActionResult> {
  return withToast(ackP((a) => getSocket().emit('game:action', action, a)));
}
