// Socket.IO client singleton + session persistence + server clock sync.
import { io, type Socket } from 'socket.io-client';
import type { AiDifficulty, ClientToServerEvents, GameAction, JoinResult, ServerToClientEvents, ActionResult, Role, HqId, SoloOptions } from '@fnab/shared';
import { normalizeResult, useGame } from '../state/store';

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
const RESUME_RETRY_BASE_MS = 500;
const RESUME_RETRY_MAX_MS = 4_000;
const RESUME_ACK_TIMEOUT_MS = 4_000;

function resumeSession(s: ClientSocket) {
  cancelResume();
  const sess = readSession();
  if (!sess) return;
  let cancelled = false, attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  cancelResume = () => { cancelled = true; clearTimeout(timer); };
  const current = () => {
    const saved = readSession();
    return !cancelled && s.connected && saved?.code === sess.code && saved.token === sess.token;
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
    s.emit('room:resume', sess, (res) => {
      if (!pending || !current()) return;
      pending = false;
      clearTimeout(timer);
      if (res.ok) {
        cancelResume();
        useGame.getState().set({ connection: 'online' });
      } else if (SESSION_INVALID_ERRORS.has(res.error)) {
        cancelResume();
        writeSession(null);
        useGame.getState().set({ connection: 'online', room: null, view: null, result: null });
        useGame.getState().toast(res.error === 'Session expired' ? 'Previous session expired' : res.error, 'warn');
      } else {
        if (attempt === 0) useGame.getState().toast(res.error, 'warn');
        retry();
      }
    });
  };
  send();
}

export function getSocket(): ClientSocket {
  if (socket) return socket;
  const s: ClientSocket = io({ path: '/socket.io', transports: ['websocket', 'polling'], autoConnect: true });
  socket = s;
  const store = useGame.getState;

  s.on('connect', () => {
    store().set({ connection: 'online' });
    syncClock();
    resumeSession(s);
  });
  s.on('disconnect', () => { cancelResume(); store().set({ connection: 'reconnecting' }); });
  s.io.on('reconnect_attempt', () => store().set({ connection: 'reconnecting' }));
  s.on('room:state', (room) => {
    store().setRoom(room);
  });
  s.on('game:view', (view) => store().setView(view));
  s.on('game:result', (result) => store().set({ result: normalizeResult(result) }));
  s.on('cameras:status', (st) => store().setCameraStatuses(st));
  s.on('room:kicked', ({ reason }) => {
    // Forget the seat: otherwise this tab would auto-resume on its next reconnect and kick the replacement
    // connection (e.g. the same player who reopened the game in another tab).
    cancelResume();
    writeSession(null);
    store().toast(reason, 'warn');
    store().set({ room: null, view: null, result: null });
  });
  setInterval(syncClock, 15_000);
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
export function joinRoom(code: string, name: string): Promise<JoinResult> {
  return new Promise((resolve) => getSocket().emit('room:join', { code, name, token: tabToken() }, (r) => resolve(onJoined(r, name))));
}
export function leaveRoom() {
  cancelResume();
  getSocket().emit('room:leave');
  writeSession(null);
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
