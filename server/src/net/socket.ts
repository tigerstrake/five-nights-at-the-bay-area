// Socket.IO transport: validates payloads, routes to RoomManager, broadcasts role-filtered views.
import type { Server, Socket } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, ActionResult, GameAction, Role } from '@fnab/shared';
import type { RoomManager, Room } from '../rooms/RoomManager';
import type { CameraService } from '../cameras';
import * as S from './schemas';

interface SocketData {
  code?: string;
  playerId?: string;
}
type IO = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type Sock = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

const bad = (msg = 'Invalid request'): ActionResult => ({ ok: false, error: msg });
const safeAck = <T>(ack: unknown, value: T) => {
  if (typeof ack === 'function') (ack as (v: T) => void)(value);
};

export function attachSockets(io: IO, rooms: RoomManager, cameras: CameraService, tickMs: number): () => void {
  /** playerId → socket (latest connection wins; a second tab has its own token so its own player). */
  const sockets = new Map<string, Sock>();

  const broadcastRoom = (room: Room) => {
    for (const p of room.players.values()) {
      const s = sockets.get(p.id);
      if (s && s.data.code === room.code) s.emit('room:state', rooms.roomView(room, p.id));
    }
  };

  const bind = (socket: Sock, code: string, playerId: string) => {
    const prev = sockets.get(playerId);
    if (prev && prev.id !== socket.id) {
      prev.data = {};
      prev.emit('room:kicked', { reason: 'Session opened elsewhere' });
    }
    socket.data.code = code;
    socket.data.playerId = playerId;
    sockets.set(playerId, socket);
    const room = rooms.rooms.get(code);
    if (room) {
      broadcastRoom(room);
      const view = rooms.playerView(room, playerId);
      if (view) socket.emit('game:view', view);
      if (room.result) socket.emit('game:result', room.result);
    }
    socket.emit('cameras:status', cameras.getStatuses());
  };

  const unsubCams = cameras.subscribe((st) => io.emit('cameras:status', st));

  io.on('connection', (socket: Sock) => {
    const ctx = () => {
      const { code, playerId } = socket.data;
      return code && playerId ? { code, playerId } : null;
    };
    const afterLobbyChange = () => {
      const c = ctx();
      const room = c && rooms.rooms.get(c.code);
      if (room) broadcastRoom(room);
    };

    socket.on('room:create', (p, ack) => {
      const v = S.createSchema.safeParse(p);
      if (!v.success) return safeAck(ack, { ok: false, error: 'Invalid name' });
      leaveCurrent();
      const res = rooms.create(v.data.name, v.data.token);
      if (res.ok) bind(socket, res.code, res.playerId);
      safeAck(ack, res);
    });

    socket.on('room:join', (p, ack) => {
      const v = S.joinSchema.safeParse(p);
      if (!v.success) return safeAck(ack, { ok: false, error: 'Invalid room code or name' });
      const res = rooms.join(v.data.code, v.data.name, v.data.token);
      if (res.ok) {
        if (ctx()?.code !== res.code) leaveCurrent();
        bind(socket, res.code, res.playerId);
      }
      safeAck(ack, res);
    });

    socket.on('room:resume', (p, ack) => {
      const v = S.resumeSchema.safeParse(p);
      if (!v.success) return safeAck(ack, { ok: false, error: 'Invalid session' });
      const res = rooms.resume(v.data.code, v.data.token);
      if (res.ok) bind(socket, res.code, res.playerId);
      safeAck(ack, res);
    });

    function leaveCurrent() {
      const c = ctx();
      if (!c) return;
      rooms.leave(c.code, c.playerId);
      sockets.delete(c.playerId);
      socket.data = {};
      const room = rooms.rooms.get(c.code);
      if (room) broadcastRoom(room);
    }
    socket.on('room:leave', leaveCurrent);

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
        const res = fn(c, v.data);
        safeAck(ack, res);
        if (res.ok) afterLobbyChange();
      };

    socket.on(
      'lobby:setName',
      lobby(S.setNameSchema, (c, d) => rooms.setName(c.code, c.playerId, d.name)),
    );
    socket.on(
      'lobby:setRole',
      lobby(S.roleSchema, (c, d) => rooms.setRole(c.code, c.playerId, d.role as Role)),
    );
    socket.on(
      'lobby:setReady',
      lobby(S.readySchema, (c, d) => rooms.setReady(c.code, c.playerId, d.ready)),
    );
    socket.on(
      'lobby:setSettings',
      lobby(S.settingsSchema, (c, d) => rooms.setSettings(c.code, c.playerId, d)),
    );
    socket.on(
      'lobby:selectHq',
      lobby(S.hqSchema, (c, d) => rooms.selectHq(c.code, c.playerId, d.hqId)),
    );

    socket.on('room:restart', (ack) => {
      const c = ctx();
      if (!c) return safeAck(ack, bad('Not in a room'));
      const res = rooms.restart(c.code, c.playerId);
      safeAck(ack, res);
      if (res.ok) afterLobbyChange();
    });

    socket.on('game:action', (p, ack) => {
      const c = ctx();
      if (!c) return safeAck(ack, bad('Not in a room'));
      const v = S.actionSchema.safeParse(p);
      if (!v.success) return safeAck(ack, bad('Malformed action'));
      const res = rooms.action(c.code, c.playerId, v.data as GameAction);
      safeAck(ack, res);
      if (res.ok) {
        // Push fresh views immediately for responsiveness.
        const room = rooms.rooms.get(c.code);
        if (room) sendViews(room);
      }
    });

    socket.on('time:ping', (p, ack) => {
      const v = S.pingSchema.safeParse(p);
      if (!v.success) return;
      safeAck(ack, { clientSentAt: v.data.clientSentAt, serverNow: Date.now() });
    });

    socket.on('disconnect', () => {
      const c = ctx();
      if (!c) return;
      if (sockets.get(c.playerId) === socket) {
        sockets.delete(c.playerId);
        rooms.disconnect(c.code, c.playerId);
        const room = rooms.rooms.get(c.code);
        if (room) broadcastRoom(room);
      }
    });
  });

  const sendViews = (room: Room) => {
    const now = Date.now();
    for (const p of room.players.values()) {
      const s = sockets.get(p.id);
      if (!s || s.data.code !== room.code) continue;
      const view = rooms.playerView(room, p.id, now);
      if (view) s.emit('game:view', view);
    }
  };

  const timer = setInterval(() => {
    const out = rooms.tick(Date.now());
    for (const room of out.playing) sendViews(room);
    for (const room of out.ended) {
      for (const p of room.players.values()) {
        const s = sockets.get(p.id);
        if (s && room.result) s.emit('game:result', room.result);
      }
    }
    for (const room of out.changed) broadcastRoom(room);
  }, tickMs);

  return () => {
    clearInterval(timer);
    unsubCams();
  };
}
