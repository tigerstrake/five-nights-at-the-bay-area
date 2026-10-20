// Socket.IO client singleton + session persistence + server clock sync.
import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, GameAction, JoinResult, ServerToClientEvents, ActionResult, Role, HqId } from '@fnab/shared';
import { useGame } from '../state/store';

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

export function getSocket(): ClientSocket {
  if (socket) return socket;
  const s: ClientSocket = io({ path: '/socket.io', transports: ['websocket', 'polling'], autoConnect: true });
  socket = s;
  const store = useGame.getState;

  s.on('connect', () => {
    store().set({ connection: 'online' });
    syncClock();
    const sess = readSession();
    if (sess) {
      s.emit('room:resume', sess, (res) => {
        if (!res.ok) {
          writeSession(null);
          store().set({ room: null, view: null, result: null });
          store().toast(res.error === 'Session expired' ? 'Previous session expired' : res.error, 'warn');
        }
      });
    }
  });
  s.on('disconnect', () => store().set({ connection: 'reconnecting' }));
  s.io.on('reconnect_attempt', () => store().set({ connection: 'reconnecting' }));
  s.on('room:state', (room) => {
    store().setRoom(room);
  });
  s.on('game:view', (view) => store().setView(view));
  s.on('game:result', (result) => store().set({ result }));
  s.on('cameras:status', (st) => store().setCameraStatuses(st));
  s.on('room:kicked', ({ reason }) => {
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
      const sent = Date.now();
      s.emit('time:ping', { clientSentAt: sent }, (res) => {
        const now = Date.now();
        const rtt = now - res.clientSentAt;
        samples.push({ rtt, offset: res.serverNow + rtt / 2 - now });
        if (samples.length > 10) samples.shift();
        const best = [...samples].sort((a, b) => a.rtt - b.rtt)[0]!;
        useGame.getState().set({ clockOffset: best.offset, rtt: best.rtt });
      });
    }, i * 150);
  }
}

function onJoined(res: JoinResult, name: string): JoinResult {
  if (res.ok) {
    writeSession({ code: res.code, token: res.token });
    saveName(name);
  }
  return res;
}

export function createRoom(name: string): Promise<JoinResult> {
  return new Promise((resolve) => getSocket().emit('room:create', { name, token: tabToken() }, (r) => resolve(onJoined(r, name))));
}
export function joinRoom(code: string, name: string): Promise<JoinResult> {
  return new Promise((resolve) => getSocket().emit('room:join', { code, name, token: tabToken() }, (r) => resolve(onJoined(r, name))));
}
export function leaveRoom() {
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
