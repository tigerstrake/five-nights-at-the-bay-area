// Full authoritative game state (server-only; NEVER sent to clients as-is — see ../visibility).
import type {
  BalanceConfig,
  CameraGameStatus,
  EventAudience,
  GameEvent,
  GameEventKind,
  Graph,
  HqId,
  ManifestationState,
  MatchPhase,
  MatchResult,
  MatchStats,
  MonsterCommand,
  MonsterStance,
  SightingView,
} from '@fnab/shared';
import { MONSTER_COMMANDS } from '@fnab/shared';
import { createHmac } from 'node:crypto';

export interface CameraState {
  cameraId: string;
  nodeId: string;
  status: Exclude<CameraGameStatus, 'blackout' | 'repairing'>; // 'repairing' is derived from `repair`
  until: number | null; // auto-recovery time for sabotaged/static
  repair: { startedAt: number; endsAt: number } | null;
}

export interface DoorState {
  approachId: string;
  closed: boolean;
  heat: number;
  jammedUntil: number | null;
  battering: boolean;
}

export interface SensorState {
  id: string;
  nodeId: string;
  disabledUntil: number | null;
  lastPingAt: number | null;
}

export interface TrapState {
  id: string;
  nodeId: string;
  armedAt: number; // live from this match time
}

export interface LureState {
  id: string;
  nodeId: string;
  t: number;
  expiresAt: number;
}

export interface Sighting extends SightingView {
  /** SERVER-ONLY. Never serialised to defenders. */
  isDecoy: boolean;
}

export interface StoredEvent extends GameEvent {
  /** Post-match annotation only. Never projected into a live view. */
  decoy?: boolean;
}

export interface MonsterKnowledgeState {
  knownSensors: Record<string, { nodeId: string; seenAt: number; disabledUntil?: number | null }>;
  knownDoors: Record<string, { closed: boolean; jammed: boolean; seenAt: number }>;
  disturbances: Array<{ nodeId: string; t: number; expiresAt: number }>;
  scanPulses: Array<{ nodeId: string; t: number }>;
  exposures: Array<{ nodeId: string; t: number }>;
}

export interface MonsterState {
  spawned: boolean;
  spawnChoice: string | null;
  nodeId: string | null;
  moving: { from: string; to: string; edgeId: string; elapsed: number; duration: number } | null;
  path: string[]; // remaining planned nodes AFTER the current destination/node
  stance: MonsterStance;
  targetApproachId: string | null;
  breachApproachId: string | null; // intent from the brain: breach this approach on arrival
  cooldowns: Record<MonsterCommand, number>; // ready-at match time
  lastCommandAt: number;
  held: { until: number; contained: boolean; struggle: number; struggling: boolean } | null;
  trapImmuneUntil: number;
  nextDecisionAt: number;
  nextDetectAt: number;
  arrivedAt: number;
  lastReason: string;
  knowledge: MonsterKnowledgeState;
  pendingDecoys: Array<{ nodeId: string; at: number }>;
  visited: string[];
}

export interface GameState {
  cfg: BalanceConfig;
  seed: number;
  /** Secret transport identifier key; injected by RoomManager, deterministic fallback for simulations. */
  publicIdKey: string;
  t: number;
  phase: MatchPhase;
  prepMs: number;
  durationMs: number;
  hqId: HqId;
  defenderCount: number;
  power: { value: number; outageUntil: number | null; lowWarned: boolean };
  doors: Record<string, DoorState>;
  sensors: SensorState[];
  traps: TrapState[];
  lures: LureState[];
  cameras: Record<string, CameraState>;
  manifestations: Record<string, ManifestationState>;
  sightings: Sighting[];
  sightingsEvictedThroughT: number;
  scan: { readyAt: number; last: { nodeId: string; t: number; radiusHops: number; found: boolean } | null };
  lureReadyAt: number;
  containment: { nodeId: string; startedAt: number; elapsed: number } | null;
  breach: { approachId: string; progress: number; stalled: boolean } | null;
  monster: MonsterState;
  events: StoredEvent[];
  /** Whole timestamp batches evicted from retention must not reappear later in the same tick. */
  eventsEvictedThroughT: number;
  nextId: number;
  stats: MatchStats;
  monsterPath: Array<{ nodeId: string; t: number }>;
  result: MatchResult | null;
  /** Room lifecycle's reconnect hold (either missing team, only while pause allowance remains). */
  monsterDisconnected: boolean;
}

export interface CreateGameOptions {
  graph: Graph;
  cfg: BalanceConfig; // already scaled for defenders
  hqId: HqId;
  durationMs: number;
  defenderCount: number;
  seed: number;
  publicIdKey?: string;
}

export function emptyStats(): MatchStats {
  return {
    durationMs: 0,
    sightings: 0,
    falseSightings: 0,
    decoysExposed: 0,
    sensorPings: 0,
    scans: 0,
    trapsArmed: 0,
    trapsTriggered: 0,
    containmentAttempts: 0,
    sabotages: 0,
    repairs: 0,
    cameraFailures: 0,
    powerSpent: 0,
    powerOutages: 0,
    doorCloseSeconds: 0,
    monsterDistanceKm: 0,
    monsterNodesVisited: 0,
    commandsIssued: 0,
  };
}

export function createGame(o: CreateGameOptions): GameState {
  const hq = o.graph.hqs.get(o.hqId);
  if (!hq) throw new Error(`unknown HQ ${o.hqId}`);
  const cfg: BalanceConfig = {
    ...o.cfg,
    power: { ...o.cfg.power, max: o.cfg.power.max + (o.cfg.power.hqBonus?.[o.hqId] ?? 0) },
    breach: { ...o.cfg.breach, durationMs: o.cfg.breach.durationMs * (o.cfg.breach.hqMult?.[o.hqId] ?? 1) },
  };
  const cameras: Record<string, CameraState> = Object.create(null);
  for (const n of o.graph.data.nodes) {
    if (!n.cameraId) continue;
    cameras[n.cameraId] = { cameraId: n.cameraId, nodeId: n.id, status: 'ok', until: null, repair: null };
  }
  const doors: Record<string, DoorState> = Object.create(null);
  for (const ap of hq.approaches) doors[ap.id] = { approachId: ap.id, closed: false, heat: 0, jammedUntil: null, battering: false };
  const cooldowns = Object.fromEntries(MONSTER_COMMANDS.map((c) => [c, 0])) as Record<MonsterCommand, number>;
  return {
    cfg,
    seed: o.seed,
    publicIdKey: o.publicIdKey ?? `simulation:${o.seed}`,
    t: 0,
    phase: 'preparation',
    prepMs: o.cfg.match.prepMs,
    durationMs: o.durationMs,
    hqId: o.hqId,
    defenderCount: o.defenderCount,
    power: { value: cfg.power.max, outageUntil: null, lowWarned: false },
    doors,
    sensors: [],
    traps: [],
    lures: [],
    cameras,
    manifestations: Object.create(null),
    sightings: [],
    sightingsEvictedThroughT: -Infinity,
    scan: { readyAt: 0, last: null },
    lureReadyAt: 0,
    containment: null,
    breach: null,
    monster: {
      spawned: false,
      spawnChoice: null,
      nodeId: null,
      moving: null,
      path: [],
      stance: 'HUNT',
      targetApproachId: null,
      breachApproachId: null,
      cooldowns,
      lastCommandAt: -Infinity,
      held: null,
      trapImmuneUntil: 0,
      nextDecisionAt: 0,
      nextDetectAt: 0,
      arrivedAt: 0,
      lastReason: '',
      knowledge: { knownSensors: Object.create(null), knownDoors: Object.create(null), disturbances: [], scanPulses: [], exposures: [] },
      pendingDecoys: [],
      visited: [],
    },
    events: [],
    eventsEvictedThroughT: -Infinity,
    nextId: 1,
    stats: emptyStats(),
    monsterPath: [],
    result: null,
    monsterDisconnected: false,
  };
}

export function pushEvent(
  s: GameState,
  kind: GameEventKind,
  audience: EventAudience,
  text: string,
  extra: Partial<Pick<GameEvent, 'nodeId' | 'cameraId' | 'approachId' | 'severity'>> = {},
): StoredEvent {
  const ev: GameEvent = { id: s.nextId++, t: s.t, kind, audience, text, severity: extra.severity ?? 'info', ...extra };
  const limit = s.cfg.visibility.maxRetainedEvents ?? 4096;
  s.eventsEvictedThroughT = retainBatchEntry(s.events, ev, limit, s.eventsEvictedThroughT);
  return ev;
}

/** Strictly bounded chronological retention, evicting whole simultaneous batches, including oversized ones. */
export function retainBatchEntry<T extends { t: number }>(entries: T[], entry: T, limit: number, evictedThroughT: number): number {
  if (entry.t <= evictedThroughT) return evictedThroughT;
  entries.push(entry);
  if (entries.length > limit) {
    const cutoff = entries[entries.length - limit - 1]!.t;
    let end = 0;
    while (end < entries.length && entries[end]!.t <= cutoff) end++;
    entries.splice(0, end);
    return cutoff;
  }
  return evictedThroughT;
}

const idCaches = new WeakMap<GameState, { ids: Map<number, number>; used: Set<number> }>();

/** Stable opaque safe-integer identifiers, independent of hidden counter ordering and gaps. No IO or random source. */
export function publicId(s: GameState, id: number): number {
  let cache = idCaches.get(s);
  if (!cache) { cache = { ids: new Map(), used: new Set() }; idCaches.set(s, cache); }
  const previous = cache.ids.get(id);
  if (previous !== undefined) return previous;
  let salt = 0, value: number;
  do {
    const digest = createHmac('sha256', s.publicIdKey).update(`${id}:${salt++}`).digest();
    value = digest.readUIntBE(0, 6) * 32 + (digest[6]! & 31);
  } while (cache.used.has(value));
  cache.ids.set(id, value); cache.used.add(value);
  const limit = (s.cfg.visibility.maxRetainedEvents ?? 4096) + (s.cfg.visibility.maxRetainedSightings ?? 256) + 1024;
  if (cache.ids.size > limit) {
    const oldest = cache.ids.keys().next().value!;
    cache.used.delete(cache.ids.get(oldest)!); cache.ids.delete(oldest);
  }
  return value;
}

export function matchEndT(s: GameState): number {
  return s.prepMs + s.durationMs;
}

/** Phase boundaries in match time. */
export function phaseBounds(s: GameState): Record<MatchPhase, { start: number; end: number }> {
  const f = s.cfg.match.phaseFractions;
  const a = s.prepMs;
  const b = a + s.durationMs * f.infiltration;
  const c = b + s.durationMs * f.escalation;
  const d = a + s.durationMs;
  return {
    preparation: { start: 0, end: a },
    infiltration: { start: a, end: b },
    escalation: { start: b, end: c },
    final: { start: c, end: d },
  };
}

export function phaseAt(s: GameState, t: number): MatchPhase {
  const b = phaseBounds(s);
  if (t < b.preparation.end) return 'preparation';
  if (t < b.infiltration.end) return 'infiltration';
  if (t < b.escalation.end) return 'escalation';
  return 'final';
}

/** The node the monster is "at" for detection/sabotage purposes (nearer endpoint while moving). */
export function monsterEffectiveNode(s: GameState): string | null {
  const m = s.monster;
  if (!m.spawned) return null;
  if (m.moving) return m.moving.elapsed / m.moving.duration < 0.5 ? m.moving.from : m.moving.to;
  return m.nodeId;
}

export function isOutage(s: GameState): boolean {
  return s.power.outageUntil !== null && s.t < s.power.outageUntil;
}
