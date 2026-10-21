// Socket.IO transport: validates payloads, routes to RoomManager, broadcasts role-filtered views.
import type { Server, Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, ActionResult, GameAction, Role } from '@fnab/shared';
import type { RoomManager, Room } from '../rooms/RoomManager';
import type { CameraService } from '../cameras';
import * as S from './schemas';
import { networkLimits, TokenBucket } from './limits';

interface SocketData {
  code?: string;
  playerId?: string;
}
type IO = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type Sock = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

const bad = (msg = 'Invalid request'): ActionResult => ({ ok: false, error: msg });
const safeAck = <T>(ack: unknown, value: T) => {
  if (typeof ack !== 'function') return;
  try { (ack as (v: T) => void)(value); }
  catch (error) { console.error('[net] acknowledgement failed', error); }
};

export function attachSockets(io: IO, rooms: RoomManager, cameras: CameraService, tickMs: number): () => void {
  /** playerId → socket (latest connection wins; a second tab has its own token so its own player). */
  const sockets = new Map<string, Sock>();
  const limits = networkLimits(rooms.cfg);
  const ips = new Map<string, { requests: TokenBucket; joins: TokenBucket; failures: TokenBucket; seenAt: number }>();
  const dirty = new Set<Room>();
  let generation = 0;
  const sent = new Map<string, { match: Room['match']; generation: number }>();
  const identities = new WeakMap<Sock, { room: Room; match: NonNullable<Room['match']>; playerId: string }>();
  const bound = (s: Sock | undefined, room: Room, id: string): s is Sock =>
    !!s && s.data.code === room.code && s.data.playerId === id && sockets.get(id) === s && !!room.players.get(id)?.connected;
  const sendView = (room: Room, id: string, s: Sock, now = Date.now()) => {
    if (!bound(s, room, id)) return;
    const last = sent.get(id);
    if (last?.match === room.match && last.generation === generation) return;
    const view = rooms.playerView(room, id, now);
    if (view) {
      if (room.stage === 'playing' && room.match && !room.match.state.result)
        identities.set(s, { room, match: room.match, playerId: id });
      s.emit('game:view', view);
      sent.set(id, { match: room.match, generation });
    }
  };

  const broadcastRoom = (room: Room) => {
    for (const p of room.players.values()) {
      const s = sockets.get(p.id);
      if (bound(s, room, p.id)) s.emit('room:state', rooms.roomView(room, p.id));
    }
  };

  const bind = (socket: Sock, code: string, playerId: string) => {
    const existingRoom = rooms.rooms.get(code);
    if (existingRoom && bound(socket, existingRoom, playerId)) return;
    const oldId = socket.data.playerId;
    const oldCode = socket.data.code;
    if (oldId && (oldId !== playerId || oldCode !== code) && sockets.get(oldId) === socket) {
      sockets.delete(oldId);
      if (oldCode) {
        rooms.disconnect(oldCode, oldId);
        const oldRoom = rooms.rooms.get(oldCode);
        if (oldRoom) dirty.add(oldRoom);
      }
    }
    const prev = sockets.get(playerId);
    if (prev && prev.id !== socket.id) {
      if (prev.data.code === code && prev.data.playerId === playerId)
        prev.emit('room:kicked', { reason: 'Session opened elsewhere' });
      prev.data = {};
    }
    socket.data.code = code;
    socket.data.playerId = playerId;
    sockets.set(playerId, socket);
    const room = rooms.rooms.get(code);
    if (room) {
      dirty.add(room);
      if (bound(socket, room, playerId)) socket.emit('room:state', rooms.roomView(room, playerId));
      sendView(room, playerId, socket);
      if (room.result && bound(socket, room, playerId)) socket.emit('game:result', room.result);
    }
    socket.emit('cameras:status', cameras.getStatuses());
  };

  const unsubCams = cameras.subscribe((st) => io.emit('cameras:status', st));

  io.on('connection', (socket: Sock) => {
    const now = Date.now();
    const ip = socket.handshake.address; // never trust client-supplied forwarding headers
    let budget = ips.get(ip);
    if (!budget) {
      for (const [key, b] of ips) if (now - b.seenAt >= limits.ipIdleTtlMs) ips.delete(key);
      if (ips.size >= limits.maxTrackedIps) { socket.disconnect(true); return; }
      budget = { requests: new TokenBucket(limits.ipBurst, limits.ipPerSecond, now),
        joins: new TokenBucket(limits.joinBurst, limits.joinPerSecond, now),
        failures: new TokenBucket(limits.failedJoinBurst, limits.failedJoinPerSecond, now), seenAt: now };
      ips.set(ip, budget);
    }
    const ipBudget = budget;
    const requests = new TokenBucket(limits.socketBurst, limits.socketPerSecond, now);
    // Register every client handler through the same exception and budget boundary.
    const on = <E extends keyof ClientToServerEvents>(event: E, handler: ClientToServerEvents[E]) => {
      socket.on(event, ((...args: unknown[]) => {
        const ack = args.at(-1);
        const t = Date.now();
        ipBudget.seenAt = t;
        if (!requests.take(t) || !ipBudget.requests.take(t)) return safeAck(ack, bad('Rate limit exceeded — try again shortly'));
        if ((event === 'room:create' || event === 'room:join' || event === 'room:resume') &&
          (!ipBudget.joins.take(t) || !ipBudget.failures.available(t))) return safeAck(ack, bad('Join limit exceeded — try again shortly'));
        try {
          const result = (handler as (...a: unknown[]) => unknown)(...args);
          if (result instanceof Promise) void result.catch(error => {
            console.error(`[net] ${event} handler failed`, error);
            safeAck(ack, bad('Internal server error'));
          });
        } catch (error) {
          console.error(`[net] ${event} handler failed`, error);
          safeAck(ack, bad('Internal server error'));
        }
      }) as never);
    };
    const ctx = () => {
      const { code, playerId } = socket.data;
      const room = code && rooms.rooms.get(code);
      return room && playerId && bound(socket, room, playerId) ? { code: room.code, playerId } : null;
    };
    const afterLobbyChange = () => {
      const c = ctx();
      const room = c && rooms.rooms.get(c.code);
      if (room) dirty.add(room);
    };

    const identityAllowed = (code?: string, token?: string) => {
      const locked = identities.get(socket);
      if (locked && locked.room.stage === 'playing' && locked.room.match === locked.match && !locked.match.state.result) {
        const target = token ? rooms.locate(token) : null;
        return !!target && target.room === locked.room && target.room.code === code?.toUpperCase().trim() && target.player.id === locked.playerId;
      }
      const c = ctx();
      if (!c || rooms.rooms.get(c.code)?.stage !== 'playing') return true;
      const target = token ? rooms.locate(token) : null;
      return !!target && target.room.code === code?.toUpperCase().trim() && target.room.code === c.code && target.player.id === c.playerId;
    };

    on('room:create', (p, ack) => {
      const v = S.createSchema.safeParse(p);
      if (!v.success) return safeAck(ack, { ok: false, error: 'Invalid name' });
      if (!identityAllowed()) return safeAck(ack, bad('Cannot change identity during a match'));
      leaveCurrent();
      const res = rooms.create(v.data.name, v.data.token);
      if (res.ok) bind(socket, res.code, res.playerId);
      if (!res.ok && (res.error === 'Room not found' || res.error === 'Session expired')) ipBudget.failures.take(Date.now());
      safeAck(ack, res);
    });

    on('room:join', (p, ack) => {
      const v = S.joinSchema.safeParse(p);
      if (!v.success) return safeAck(ack, { ok: false, error: 'Invalid room code or name' });
      if (!identityAllowed(v.data.code, v.data.token)) return safeAck(ack, bad('Cannot change identity during a match'));
      const res = rooms.join(v.data.code, v.data.name, v.data.token);
      if (res.ok) {
        bind(socket, res.code, res.playerId);
      }
      if (!res.ok && (res.error === 'Room not found' || res.error === 'Session expired')) ipBudget.failures.take(Date.now());
      safeAck(ack, res);
    });

    on('room:resume', (p, ack) => {
      const v = S.resumeSchema.safeParse(p);
      if (!v.success) return safeAck(ack, { ok: false, error: 'Invalid session' });
      if (!identityAllowed(v.data.code, v.data.token)) return safeAck(ack, bad('Cannot change identity during a match'));
      const res = rooms.resume(v.data.code, v.data.token);
      if (res.ok) bind(socket, res.code, res.playerId);
      if (!res.ok && (res.error === 'Room not found' || res.error === 'Session expired')) ipBudget.failures.take(Date.now());
      safeAck(ack, res);
    });

    function leaveCurrent() {
      const c = ctx();
      if (!c) return;
      rooms.leave(c.code, c.playerId);
      sockets.delete(c.playerId);
      socket.data = {};
      const room = rooms.rooms.get(c.code);
      if (room) dirty.add(room);
    }
    on('room:leave', leaveCurrent);

    const lobby =
      <T>(
        schema: { safeParse: (x: unknown) => { success: true; data: T } | { success: false } },
        fn: (c: { code: string; playerId: string }, d: T) => ActionResult,
      ) =>
      (p: unknown, ack?: unknown) => {
        const c = ctx();
        if (!c) return safeAck(ack, bad('Not in a room'));
        const v = schema.safeParse(p);
        if (!v.success) return safeAck(ack, bad());
        const room = rooms.rooms.get(c.code), version = room?.version;
        const res = fn(c, v.data);
        safeAck(ack, res);
        if (res.ok && room?.version !== version) afterLobbyChange();
      };

    on(
      'lobby:setName',
      lobby(S.setNameSchema, (c, d) => rooms.setName(c.code, c.playerId, d.name)),
    );
    on(
      'lobby:setRole',
      lobby(S.roleSchema, (c, d) => rooms.setRole(c.code, c.playerId, d.role as Role)),
    );
    on(
      'lobby:setReady',
      lobby(S.readySchema, (c, d) => rooms.setReady(c.code, c.playerId, d.ready)),
    );
    on(
      'lobby:setSettings',
      lobby(S.settingsSchema, (c, d) => rooms.setSettings(c.code, c.playerId, d)),
    );
    on(
      'lobby:selectHq',
      lobby(S.hqSchema, (c, d) => rooms.selectHq(c.code, c.playerId, d.hqId)),
    );

    on('room:restart', (ack) => {
      const c = ctx();
      if (!c) return safeAck(ack, bad('Not in a room'));
      const res = rooms.restart(c.code, c.playerId);
      safeAck(ack, res);
      if (res.ok) afterLobbyChange();
    });

    on('game:action', (p, ack) => {
      const c = ctx();
      if (!c) return safeAck(ack, bad('Not in a room'));
      const v = S.actionSchema.safeParse(p);
      if (!v.success) return safeAck(ack, bad('Malformed action'));
      const res = rooms.action(c.code, c.playerId, v.data as GameAction);
      safeAck(ack, res);
      // Views are pushed only by the tick loop, irrespective of action type or acceptance.
    });

    on('time:ping', (p, ack) => {
      const v = S.pingSchema.safeParse(p);
      if (!v.success) return;
      safeAck(ack, { clientSentAt: v.data.clientSentAt, serverNow: Date.now() });
    });

    socket.on('disconnect', () => {
      const c = ctx();
      if (!c) return;
      try {
        if (sockets.get(c.playerId) !== socket) return;
        sockets.delete(c.playerId);
        rooms.disconnect(c.code, c.playerId);
        socket.data = {};
        const room = rooms.rooms.get(c.code);
        if (room) dirty.add(room);
      } catch (error) {
        console.error('[net] disconnect handler failed', error);
      }
    });
  });

  const sendViews = (room: Room) => {
    const now = Date.now();
    for (const p of room.players.values()) {
      const s = sockets.get(p.id);
      if (bound(s, room, p.id)) sendView(room, p.id, s, now);
    }
  };

  const timer = setInterval(() => {
    generation++;
    for (const [id, last] of sent) if (last.generation < generation - 1) sent.delete(id);
    const out = rooms.tick(Date.now());
    for (const room of out.playing) sendViews(room);
    for (const room of out.ended) {
      for (const p of room.players.values()) {
        const s = sockets.get(p.id);
        if (room.result && bound(s, room, p.id)) s.emit('game:result', room.result);
      }
    }
    for (const room of out.changed) dirty.add(room);
    for (const room of dirty) broadcastRoom(room);
    dirty.clear();
  }, tickMs);

  return () => {
    clearInterval(timer);
    unsubCams();
  };
}
