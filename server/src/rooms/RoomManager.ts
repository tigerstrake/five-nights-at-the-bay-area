// Lobby / room lifecycle. Transport-agnostic (no sockets) so it can be unit-tested with a fake clock.
import { randomBytes, randomUUID } from 'node:crypto';
import type {
  ActionResult,
  BalanceConfig,
  GameAction,
  Graph,
  HqId,
  JoinResult,
  LobbyPlayer,
  MatchResult,
  PlayerView,
  Role,
  RoomSettings,
  RoomView,
  Rng,
} from '@fnab/shared';
import { DEFAULT_CONFIG, clampDurationMs, createRng, scaleForDefenders } from '@fnab/shared';
import type { MonsterBrain } from '../ai/types';
import { defaultBrain } from '../ai/baselineBrain';
import { applyAction, forfeit, step, type EngineCtx } from '../engine/engine';
import { createGame, pushEvent, type GameState } from '../engine/state';
import { projectView } from '../visibility';

const MONSTER_ACTIONS = new Set(['command', 'sabotage', 'decoy', 'chooseSpawn']);
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O to avoid confusion

export interface Player {
  id: string;
  token: string;
  name: string;
  role: Role;
  ready: boolean;
  connected: boolean;
  disconnectedAt: number | null;
  joinedAt: number;
}

export interface Match {
  state: GameState;
  rng: Rng;
  ctx: EngineCtx;
  t0Epoch: number;
  lastStepAt: number;
  roles: Map<string, Role>; // role snapshot at match start
  connectionLostAt: { monster: number | null; defenders: number | null };
  pauseRemainingMs: { monster: number; defenders: number };
  connectionUpdatedAt: number;
}

export interface Room {
  code: string;
  players: Map<string, Player>;
  hostId: string;
  settings: RoomSettings;
  stage: RoomView['stage'];
  countdownEndsAt: number | null;
  match: Match | null;
  result: MatchResult | null;
  emptySince: number | null;
  /** Bumped on every lobby-visible change so the transport knows to rebroadcast room:state. */
  version: number;
}

export interface RoomManagerOptions {
  graph: Graph;
  placementCount: (cameraId: string) => number;
  cfg?: BalanceConfig;
  now?: () => number;
  brainFactory?: () => MonsterBrain;
  seed?: () => number;
}

export interface TickOutput {
  /** Rooms whose lobby state changed (rebroadcast room:state). */
  changed: Room[];
  /** Rooms with a running match (broadcast views). */
  playing: Room[];
  /** Rooms whose match just ended (broadcast result). */
  ended: Room[];
}

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  private byToken = new Map<string, { code: string; playerId: string }>();
  readonly cfg: BalanceConfig;
  private now: () => number;
  private graph: Graph;
  private brainFactory: () => MonsterBrain;
  private seed: () => number;
  private placementCount: (cameraId: string) => number;

  constructor(o: RoomManagerOptions) {
    this.graph = o.graph;
    this.cfg = o.cfg ?? DEFAULT_CONFIG;
    this.now = o.now ?? Date.now;
    this.brainFactory = o.brainFactory ?? defaultBrain;
    this.seed = o.seed ?? (() => randomBytes(4).readUInt32LE(0));
    this.placementCount = o.placementCount;
  }

  // ───────────── membership ─────────────

  private newCode(): string {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const bytes = randomBytes(this.cfg.room.codeLength);
      let code = '';
      for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('could not allocate room code');
  }

  private cleanName(name: string): string {
    const n = name
      .replace(/[^\p{L}\p{N} _.\-']/gu, '')
      .trim()
      .slice(0, this.cfg.room.maxNameLength);
    return n || 'Operator';
  }

  create(name: string, token?: string): JoinResult {
    const code = this.newCode();
    const defaultHq = (this.graph.data.headquarters[0]?.id ?? 'hq-sf') as HqId;
    const room: Room = {
      code,
      players: new Map(),
      hostId: '',
      settings: { durationSec: this.cfg.match.durationMs / 1000, hqId: defaultHq },
      stage: 'lobby',
      countdownEndsAt: null,
      match: null,
      result: null,
      emptySince: null,
      version: 0,
    };
    this.rooms.set(code, room);
    const p = this.addPlayer(room, name, token, 'monster');
    room.hostId = p.id;
    return { ok: true, code, playerId: p.id, token: p.token };
  }

  join(code: string, name: string, token?: string): JoinResult {
    const room = this.rooms.get(code.toUpperCase().trim());
    if (!room) return { ok: false, error: 'Room not found' };
    if (token) {
      const existing = this.findByToken(room, token);
      if (existing) return this.resume(room.code, token);
    }
    if (room.players.size >= this.cfg.room.maxPlayers) return { ok: false, error: 'Room is full' };
    const hasMonster = [...room.players.values()].some((p) => p.role === 'monster');
    const role: Role = room.stage === 'playing' || room.stage === 'results' ? 'spectator' : hasMonster ? 'defender' : 'monster';
    const p = this.addPlayer(room, name, token, role);
    if (!room.hostId) room.hostId = p.id;
    this.cancelCountdown(room);
    return { ok: true, code: room.code, playerId: p.id, token: p.token };
  }

  private findByToken(room: Room, token: string): Player | undefined {
    for (const p of room.players.values()) if (p.token === token) return p;
    return undefined;
  }

  private addPlayer(room: Room, name: string, token: string | undefined, role: Role): Player {
    const t = token && token.length >= 16 && !this.byToken.has(token) ? token : randomUUID();
    const p: Player = {
      id: randomUUID(),
      token: t,
      name: this.cleanName(name),
      role,
      ready: false,
      connected: true,
      disconnectedAt: null,
      joinedAt: this.now(),
    };
    room.players.set(p.id, p);
    this.byToken.set(t, { code: room.code, playerId: p.id });
    room.emptySince = null;
    room.version++;
    return p;
  }

  resume(code: string, token: string): JoinResult {
    const room = this.rooms.get(code.toUpperCase().trim());
    if (!room) return { ok: false, error: 'Room not found' };
    const p = this.findByToken(room, token);
    if (!p) return { ok: false, error: 'Session expired' };
    if (!p.connected && p.disconnectedAt !== null && this.now() - p.disconnectedAt >= this.cfg.room.reconnectGraceMs)
      return { ok: false, error: 'Session expired' };
    // A resume between timer callbacks must not resurrect an already forfeited team.
    this.updateConnections(room, this.now());
    const lost = room.match?.connectionLostAt;
    if (room.stage === 'playing' && lost && [lost.monster, lost.defenders].some(t => t !== null && this.now() - t >= this.cfg.room.reconnectGraceMs))
      return { ok: false, error: 'Reconnection grace expired' };
    const wasConnected = p.connected;
    p.connected = true;
    p.disconnectedAt = null;
    room.emptySince = null;
    if (!wasConnected) room.version++;
    this.updateConnections(room, this.now());
    return { ok: true, code: room.code, playerId: p.id, token: p.token };
  }

  disconnect(code: string, playerId: string): void {
    const room = this.rooms.get(code);
    const p = room?.players.get(playerId);
    if (!room || !p || !p.connected) return;
    p.connected = false;
    p.disconnectedAt = this.now();
    room.version++;
    this.updateConnections(room, this.now());
    if (room.stage === 'countdown') this.cancelCountdown(room);
  }

  leave(code: string, playerId: string): void {
    const room = this.rooms.get(code);
    if (!room) return;
    this.removePlayer(room, playerId);
  }

  private removePlayer(room: Room, playerId: string) {
    const p = room.players.get(playerId);
    if (!p) return;
    room.players.delete(playerId);
    this.byToken.delete(p.token);
    room.version++;
    if (room.match && !room.match.state.result) {
      const role = room.match.roles.get(playerId);
      if (role === 'monster') forfeit(room.match.state, 'monster');
      else if (role === 'defender') {
        const defendersLeft = [...room.players.values()].some((x) => room.match!.roles.get(x.id) === 'defender');
        if (!defendersLeft) forfeit(room.match.state, 'defenders');
      }
    }
    if (room.hostId === playerId) {
      const next = [...room.players.values()].sort((a, b) => Number(b.connected) - Number(a.connected) || a.joinedAt - b.joinedAt)[0];
      room.hostId = next?.id ?? '';
    }
    this.cancelCountdown(room);
    this.updateConnections(room, this.now());
  }

  locate(token: string): { room: Room; player: Player } | null {
    const loc = this.byToken.get(token);
    if (!loc) return null;
    const room = this.rooms.get(loc.code);
    const player = room?.players.get(loc.playerId);
    return room && player ? { room, player } : null;
  }

  // ───────────── lobby ─────────────

  private lobbyGuard(room: Room | undefined, playerId: string): { room: Room; p: Player } | ActionResult {
    if (!room) return { ok: false, error: 'Room not found' };
    const p = room.players.get(playerId);
    if (!p) return { ok: false, error: 'Not in room' };
    if (room.stage !== 'lobby' && room.stage !== 'countdown') return { ok: false, error: 'Match in progress' };
    return { room, p };
  }

  setName(code: string, playerId: string, name: string): ActionResult {
    const room = this.rooms.get(code);
    const p = room?.players.get(playerId);
    if (!room || !p) return { ok: false, error: 'Not in room' };
    const cleaned = this.cleanName(name);
    if (p.name === cleaned) return { ok: true };
    p.name = cleaned;
    room.version++;
    return { ok: true };
  }

  setRole(code: string, playerId: string, role: Role): ActionResult {
    const g = this.lobbyGuard(this.rooms.get(code), playerId);
    if ('ok' in g) return g;
    const { room, p } = g;
    if (role === 'monster') {
      const other = [...room.players.values()].find((x) => x.role === 'monster' && x.id !== p.id);
      if (other) return { ok: false, error: `${other.name} is already the monster` };
    }
    if (p.role !== role) {
      p.role = role;
      p.ready = false;
      room.version++;
      this.cancelCountdown(room);
    }
    return { ok: true };
  }

  setReady(code: string, playerId: string, ready: boolean): ActionResult {
    const g = this.lobbyGuard(this.rooms.get(code), playerId);
    if ('ok' in g) return g;
    if (g.p.ready === ready) return { ok: true };
    g.p.ready = ready;
    g.room.version++;
    if (!ready) this.cancelCountdown(g.room);
    return { ok: true };
  }

  setSettings(code: string, playerId: string, s: { durationSec?: number }): ActionResult {
    const g = this.lobbyGuard(this.rooms.get(code), playerId);
    if ('ok' in g) return g;
    if (g.room.hostId !== playerId) return { ok: false, error: 'Only the host can change settings' };
    if (s.durationSec === undefined || g.room.settings.durationSec === clampDurationMs(s.durationSec * 1000, this.cfg) / 1000)
      return { ok: true };
    if (s.durationSec !== undefined) g.room.settings.durationSec = clampDurationMs(s.durationSec * 1000, this.cfg) / 1000;
    g.room.version++;
    this.cancelCountdown(g.room);
    return { ok: true };
  }

  selectHq(code: string, playerId: string, hqId: HqId): ActionResult {
    const g = this.lobbyGuard(this.rooms.get(code), playerId);
    if ('ok' in g) return g;
    if (g.p.role !== 'defender' && g.room.hostId !== playerId) return { ok: false, error: 'Defenders choose the headquarters' };
    if (!this.graph.hqs.has(hqId)) return { ok: false, error: 'Unknown headquarters' };
    if (g.room.settings.hqId === hqId) return { ok: true };
    g.room.settings.hqId = hqId;
    g.room.version++;
    this.cancelCountdown(g.room);
    return { ok: true };
  }

  restart(code: string, playerId: string): ActionResult {
    const room = this.rooms.get(code);
    if (!room) return { ok: false, error: 'Room not found' };
    if (room.hostId !== playerId) return { ok: false, error: 'Only the host can restart' };
    if (room.stage !== 'results') return { ok: false, error: 'Finish the current match before restarting' };
    const roles = room.match?.roles;
    room.stage = 'lobby';
    room.match = null;
    room.result = null;
    room.countdownEndsAt = null;
    for (const p of room.players.values()) {
      p.ready = false;
      // Players who joined mid-match (auto-spectators) get a playing role for the next match.
      if (p.role === 'spectator' && roles && !roles.has(p.id)) {
        p.role = [...room.players.values()].some((x) => x.role === 'monster') ? 'defender' : 'monster';
      }
    }
    room.version++;
    return { ok: true };
  }

  blocker(room: Room): string | null {
    const players = [...room.players.values()];
    const monsters = players.filter((p) => p.role === 'monster');
    const defenders = players.filter((p) => p.role === 'defender');
    if (monsters.length !== 1) return 'Need exactly one monster';
    if (defenders.length < 1) return 'Need at least one defender';
    const notReady = players.filter((p) => p.role !== 'spectator' && (!p.ready || !p.connected));
    if (notReady.length) return `Waiting for ${notReady.map((p) => p.name).join(', ')}`;
    return null;
  }

  private cancelCountdown(room: Room) {
    if (room.stage === 'countdown') {
      room.stage = 'lobby';
      room.countdownEndsAt = null;
      room.version++;
    }
  }

  // ───────────── match ─────────────

  action(code: string, playerId: string, action: GameAction): ActionResult {
    const room = this.rooms.get(code);
    const m = room?.match;
    if (!room || !m || room.stage !== 'playing') return { ok: false, error: 'No match running' };
    if (!room.players.get(playerId)?.connected) return { ok: false, error: 'Player disconnected' };
    if (this.pausedForReconnect(m)) return { ok: false, error: 'Waiting for reconnection' };
    const role = m.roles.get(playerId);
    if (role !== 'monster' && role !== 'defender') return { ok: false, error: 'Spectators cannot act' };
    const isMonsterAction = MONSTER_ACTIONS.has(action.type);
    if (isMonsterAction !== (role === 'monster')) return { ok: false, error: 'Not your team’s action' };
    return applyAction(m.ctx, m.state, { team: role === 'monster' ? 'monster' : 'defenders', playerId }, action, m.rng);
  }

  private startMatch(room: Room, now: number) {
    const defenders = [...room.players.values()].filter((p) => p.role === 'defender').length;
    const cfg = scaleForDefenders(defenders, this.cfg);
    const seed = this.seed();
    const state = createGame({
      graph: this.graph,
      cfg,
      hqId: room.settings.hqId,
      durationMs: clampDurationMs(room.settings.durationSec * 1000, cfg),
      defenderCount: defenders,
      seed,
      publicIdKey: randomBytes(32).toString('hex'),
    });
    room.match = {
      state,
      rng: createRng(seed),
      ctx: { graph: this.graph, brain: this.brainFactory(), placementCount: this.placementCount },
      t0Epoch: now,
      lastStepAt: now,
      roles: new Map([...room.players.values()].map((p) => [p.id, p.role])),
      connectionLostAt: { monster: null, defenders: null },
      pauseRemainingMs: {
        monster: cfg.room.reconnectPauseBudgetMs ?? DEFAULT_CONFIG.room.reconnectPauseBudgetMs!,
        defenders: cfg.room.reconnectPauseBudgetMs ?? DEFAULT_CONFIG.room.reconnectPauseBudgetMs!,
      },
      connectionUpdatedAt: now,
    };
    room.stage = 'playing';
    room.countdownEndsAt = null;
    room.result = null;
    room.version++;
  }

  private pausedForReconnect(m: Match): boolean {
    return (['monster', 'defenders'] as const).some(team => m.connectionLostAt[team] !== null && m.pauseRemainingMs[team] > 0);
  }

  private updateConnections(room: Room, now: number): void {
    const m = room.match;
    if (!m || room.stage !== 'playing' || m.state.result) return;
    // Account before changing connections so a resume between ticks cannot refill or skip pause usage.
    const elapsed = Math.max(0, now - m.connectionUpdatedAt);
    let pausedMs = 0;
    for (const team of ['monster', 'defenders'] as const) {
      if (m.connectionLostAt[team] === null) continue;
      pausedMs = Math.max(pausedMs, Math.min(elapsed, m.pauseRemainingMs[team]));
      m.pauseRemainingMs[team] = Math.max(0, m.pauseRemainingMs[team] - elapsed);
    }
    m.connectionUpdatedAt = now;
    m.lastStepAt += pausedMs;
    for (const team of ['monster', 'defenders'] as const) {
      const role = team === 'monster' ? 'monster' : 'defender';
      const online = [...m.roles].some(([id, r]) => r === role && room.players.get(id)?.connected);
      const previous = m.connectionLostAt[team];
      if (!online && previous === null) {
        m.connectionLostAt[team] = now;
        pushEvent(m.state, 'connectionLost', 'all', team === 'monster'
          ? "The entity's signal is lost — reconnecting…"
          : 'All defenders disconnected — reconnecting…', { severity: 'warn' });
        room.version++;
      } else if (online && previous !== null) {
        m.connectionLostAt[team] = null;
        pushEvent(m.state, 'connectionRestored', 'all', team === 'monster'
          ? "The entity's signal is restored."
          : 'Defender connection restored.', { severity: 'good' });
        room.version++;
      }
    }
    // The engine's connection hold applies only while a missing team has pause allowance left.
    m.state.monsterDisconnected = this.pausedForReconnect(m);
    m.t0Epoch = m.lastStepAt - m.state.t;
  }

  /** Advance every room to `now`. Fixed-step simulation (cfg.tickMs) with bounded catch-up. */
  tick(now: number = this.now()): TickOutput {
    const out: TickOutput = { changed: [], playing: [], ended: [] };
    for (const room of [...this.rooms.values()]) {
      const v0 = room.version;
      this.updateConnections(room, now);
      const lost = room.match?.connectionLostAt;
      if (room.stage === 'playing' && lost) {
        const expired = (['monster', 'defenders'] as const)
          .filter(team => lost[team] !== null && now - lost[team]! >= this.cfg.room.reconnectGraceMs)
          .sort((a, b) => lost[a]! - lost[b]!);
        const team = expired[0];
        if (team) forfeit(room.match!.state, team, team === 'monster'
          ? 'Defenders win — the entity failed to reconnect before the grace period expired.'
          : 'Monster wins — all defenders failed to reconnect before the grace period expired.');
      }
      // reconnection grace
      for (const p of [...room.players.values()]) {
        // Preserve the match roster so staggered defender losses get a full whole-team grace period.
        if (room.stage === 'playing' && room.match?.roles.get(p.id) !== 'spectator' && room.match?.roles.has(p.id)) continue;
        if (!p.connected && p.disconnectedAt !== null && now - p.disconnectedAt > this.cfg.room.reconnectGraceMs)
          this.removePlayer(room, p.id);
      }
      const anyConnected = [...room.players.values()].some((p) => p.connected);
      if (!anyConnected) {
        room.emptySince ??= now;
        if (now - room.emptySince > this.cfg.room.emptyRoomTtlMs || room.players.size === 0) {
          this.deleteRoom(room);
          continue;
        }
      } else room.emptySince = null;

      if (room.stage === 'lobby' && this.blocker(room) === null) {
        room.stage = 'countdown';
        room.countdownEndsAt = now + this.cfg.match.countdownMs;
        room.version++;
      } else if (room.stage === 'countdown') {
        if (this.blocker(room) !== null) this.cancelCountdown(room);
        else if (room.countdownEndsAt !== null && now >= room.countdownEndsAt) this.startMatch(room, now);
      }

      if (room.stage === 'playing' && room.match) {
        const m = room.match;
        const tick = m.state.cfg.tickMs;
        const paused = this.pausedForReconnect(m);
        if (paused) m.lastStepAt = now;
        let steps = 0;
        while (now - m.lastStepAt >= tick && steps < 10 && !m.state.result) {
          step(m.ctx, m.state, tick, m.rng);
          m.lastStepAt += tick;
          steps++;
        }
        if (steps === 10 && now - m.lastStepAt >= tick) m.lastStepAt = now; // drop backlog after a stall
        // The clock mapping must follow simulation, including pauses and discarded backlog.
        m.t0Epoch = m.lastStepAt - m.state.t;
        out.playing.push(room);
        if (m.state.result) {
          room.stage = 'results';
          room.result = m.state.result;
          for (const p of room.players.values()) p.ready = false;
          room.version++;
          out.ended.push(room);
        }
      }
      if (room.version !== v0) out.changed.push(room);
    }
    return out;
  }

  private deleteRoom(room: Room) {
    for (const p of room.players.values()) this.byToken.delete(p.token);
    this.rooms.delete(room.code);
  }

  // ───────────── views ─────────────

  roomView(room: Room, playerId: string): RoomView {
    const players: LobbyPlayer[] = [...room.players.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) => ({ id: p.id, name: p.name, role: p.role, ready: p.ready, connected: p.connected, isHost: p.id === room.hostId }));
    return {
      code: room.code,
      youId: playerId,
      stage: room.stage,
      players,
      settings: { ...room.settings },
      countdownEndsAt: room.countdownEndsAt,
      serverNow: this.now(),
      blocker: room.stage === 'lobby' ? this.blocker(room) : null,
      result: room.result,
    };
  }

  playerView(room: Room, playerId: string, now: number = this.now()): PlayerView | null {
    const m = room.match;
    if (!m || !room.players.has(playerId)) return null;
    const role = m.roles.get(playerId) ?? 'spectator';
    const view = projectView(m.ctx, m.state, role, { t0Epoch: m.t0Epoch, serverNow: now });
    for (const team of ['monster', 'defenders'] as const) {
      const ids = [...m.roles].filter(([, r]) => r === (team === 'monster' ? 'monster' : 'defender')).map(([id]) => id);
      const connectedPlayers = ids.filter(id => room.players.get(id)?.connected).length;
      const lost = m.connectionLostAt[team];
      view[team === 'monster' ? 'monsterConnection' : 'defenderConnection'] = {
        connected: connectedPlayers > 0, connectedPlayers, totalPlayers: ids.length,
        reconnectDeadlineEpoch: lost === null ? null : lost + this.cfg.room.reconnectGraceMs,
        pauseRemainingMs: Math.max(0, m.pauseRemainingMs[team] - (lost === null || m.state.result ? 0 : Math.max(0, now - m.connectionUpdatedAt))),
      };
    }
    view.pausedForReconnect = !m.state.result && this.pausedForReconnect(m);
    return view;
  }
}
