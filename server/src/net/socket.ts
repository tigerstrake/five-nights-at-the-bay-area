// Socket.IO transport: validates payloads, routes to RoomManager, broadcasts role-filtered views.
import type { Server, Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, ActionResult, GameAction, Role, PlayerView } from '@fnab/shared';
import type { RoomManager, Room } from '../rooms/RoomManager';
import type { CameraService } from '../cameras';
import * as S from './schemas';
import { networkLimits, TokenBucket } from './limits';
import { clientAddressResolver } from './clientAddress';
import { ViewEncoder } from './viewUpdates';

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
  const encoders = new Map<string, ViewEncoder>();
  const limits = networkLimits(rooms.cfg);
  const clientAddress = clientAddressResolver();
  const ips = new Map<string, { requests: TokenBucket; joins: TokenBucket; failures: TokenBucket; seenAt: number }>();
  const dirty = new Set<Room>();
  const listeners = new Map<Sock, Array<() => void>>();
  let generation = 0;
  const sent = new Map<string, { match: Room['match']; generation: number }>();
  const identities = new WeakMap<Sock, { code: string; match: WeakRef<NonNullable<Room['match']>>; playerId: string }>();
  const bound = (s: Sock | undefined, room: Room, id: string): s is Sock =>
    !!s && s.data.code === room.code && s.data.playerId === id && sockets.get(id) === s && !!room.players.get(id)?.connected;
  const sendView = (room: Room, id: string, s: Sock, now = Date.now(), project?: (id: string) => PlayerView | null) => {
    if (!bound(s, room, id)) return;
    const last = sent.get(id);
    if (last?.match === room.match && last.generation === generation) return;
    const view = project ? project(id) : rooms.playerView(room, id, now);
    if (view) {
      if (room.stage === 'playing' && room.match && !room.match.state.result)
        identities.set(s, { code: room.code, match: new WeakRef(room.match), playerId: id });
      if (s.handshake.auth?.viewDeltas === true) {
        let encoder = encoders.get(id);
        if (!encoder) { encoder = new ViewEncoder(); encoders.set(id, encoder); }
        const emission = encoder.next(view);
        if (emission.event === 'game:view') s.emit('game:view', emission.data);
        else s.emit('game:delta', emission.data);
      } else s.emit('game:view', view);
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
      encoders.delete(oldId);
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
    encoders.delete(playerId);
    sent.delete(playerId);
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

  const onConnection = (socket: Sock) => {
    const now = Date.now();
    const ip = clientAddress(socket.handshake.address, socket.handshake.headers?.['x-forwarded-for']);
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
    const unregister: Array<() => void> = [];
    listeners.set(socket, unregister);
    const register = (event: string, handler: (...args: unknown[]) => void) => {
      socket.on(event as never, handler as never);
      unregister.push(() => socket.off?.(event as never, handler as never));
    };
    // Register every client handler through the same exception and budget boundary.
    const on = <E extends keyof ClientToServerEvents>(event: E, handler: ClientToServerEvents[E]) => {
      register(event, (...args: unknown[]) => {
        const ack = args.at(-1);
        const t = Date.now();
        ipBudget.seenAt = t;
        // Leaving only removes the current binding; it must remain possible after either bucket is exhausted.
        if (event !== 'room:leave' && (!requests.take(t) || !ipBudget.requests.take(t))) return safeAck(ack, bad('Rate limit exceeded — try again shortly'));
        if ((event === 'room:create' || event === 'room:createSolo' || event === 'room:join' || event === 'room:resume' || event === 'room:recover') &&
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
      });
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
      const lockedRoom = locked && rooms.rooms.get(locked.code);
      if (locked && lockedRoom?.stage === 'playing' && lockedRoom.match === locked.match.deref() && !lockedRoom.match?.state.result) {
        const target = token ? rooms.locate(token) : null;
        return !!target && target.room === lockedRoom && target.room.code === code?.toUpperCase().trim() && target.player.id === locked.playerId;
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

    on('room:createSolo', (p, ack) => {
      const v = S.createSoloSchema.safeParse(p);
      if (!v.success) return safeAck(ack, bad('Invalid solo setup'));
      if (!identityAllowed()) return safeAck(ack, bad('Cannot change identity during a match'));
      leaveCurrent();
      const res = rooms.createSolo(v.data.name, v.data, v.data.token);
      if (res.ok) bind(socket, res.code, res.playerId);
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

    on('room:recover', (p, ack) => {
      const v = S.recoverSchema.safeParse(p);
      if (!v.success) return safeAck(ack, bad('Invalid session'));
      const room = rooms.rooms.get(v.data.code.toUpperCase().trim());
      const player = room?.players.get(v.data.playerId);
      const valid = player && !player.ai && player.recoveryToken === v.data.token;
      if (!identityAllowed(v.data.code, valid ? player.token : undefined)) return safeAck(ack, bad('Cannot change identity during a match'));
      // A lost acknowledgement may retry on this same socket; it still cannot displace another tab.
      const sameBinding = valid && room && bound(socket, room, player.id);
      const res = sameBinding ? rooms.resume(v.data.code, player.token) : rooms.recover(v.data.code, v.data.playerId, v.data.token);
      if (res.ok) bind(socket, res.code, res.playerId);
      if (!res.ok && (res.error === 'Room not found' || res.error === 'Session expired')) ipBudget.failures.take(Date.now());
      safeAck(ack, res);
    });

    function leaveCurrent() {
      const c = ctx();
      if (!c) return;
      rooms.leave(c.code, c.playerId);
      sockets.delete(c.playerId);
      encoders.delete(c.playerId);
      sent.delete(c.playerId);
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
    on('lobby:addAi', lobby(S.addAiSchema, (c, d) => rooms.addAi(c.code, c.playerId, d.role, d.difficulty)));
    on('lobby:removeAi', lobby(S.removeAiSchema, (c, d) => rooms.removeAi(c.code, c.playerId, d.playerId)));
    on('lobby:setAiDifficulty', lobby(S.aiDifficultySchema, (c, d) => rooms.setAiDifficulty(c.code, c.playerId, d.playerId, d.difficulty)));
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
    on('game:resync', ack => {
      const c = ctx();
      if (!c) return safeAck(ack, bad('Not in a room'));
      encoders.get(c.playerId)?.reset();
      safeAck(ack, { ok: true });
    });

    on('time:ping', (p, ack) => {
      const v = S.pingSchema.safeParse(p);
      if (!v.success) return;
      safeAck(ack, { clientSentAt: v.data.clientSentAt, serverNow: Date.now() });
    });

    register('disconnect', () => {
      try {
        const c = ctx();
        if (!c) return;
        if (sockets.get(c.playerId) !== socket) return;
        sockets.delete(c.playerId);
        encoders.delete(c.playerId);
        sent.delete(c.playerId);
        rooms.disconnect(c.code, c.playerId);
        socket.data = {};
        const room = rooms.rooms.get(c.code);
        if (room) dirty.add(room);
      } catch (error) {
        console.error('[net] disconnect handler failed', error);
      } finally {
        identities.delete(socket);
        for (const off of unregister) off();
        listeners.delete(socket);
      }
    });
  };
  io.on('connection', onConnection);

  const sendViews = (room: Room) => {
    const now = Date.now();
    const project = rooms.viewBatch(room, now);
    for (const p of room.players.values()) {
      const s = sockets.get(p.id);
      if (bound(s, room, p.id)) sendView(room, p.id, s, now, project);
    }
  };

  const timer = setInterval(() => {
    generation++;
    if (generation % 600 === 0) {
      const now = Date.now();
      for (const [ip, budget] of ips) if (now - budget.seenAt >= limits.ipIdleTtlMs) ips.delete(ip);
    }
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
    io.off?.('connection', onConnection);
    for (const [socket, unregister] of listeners) {
      identities.delete(socket);
      for (const off of unregister) off();
    }
    listeners.clear(); sockets.clear(); encoders.clear(); sent.clear(); dirty.clear(); ips.clear();
  };
}
