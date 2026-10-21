// Domain types shared by server and client. Owner: Foundation.
// Everything here is plain data (JSON-serialisable). Times are numbers:
//   - "t" values are *match time* in ms since the match started (preparation begins at t = 0).
//   - "epoch" values are server wall-clock ms (Date.now() on the server).
// Clients convert match time → epoch with `view.t0Epoch + t` and correct by their clock offset.

// ───────────────────────────── Static data (shared/src/data/*.json) ─────────────────────────────

export interface PlacementRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
}

export interface CameraRecord {
  id: string;
  caltransIndex: string;
  name: string;
  route: string;
  direction: string | null;
  county: string;
  nearbyPlace: string;
  lat: number;
  lon: number;
  imageUrl: string | null;
  streamUrl: string | null;
  imageUpdateFrequencyMin: number | null;
  inService: boolean;
  verified: {
    checkedAt: string;
    imageHttp: number | null;
    streamHttp: number | null;
    imageCors: boolean | null;
    streamCors: boolean | null;
    imageBytes?: number | null;
    /** Snapshot was a "Temporarily Unavailable" card at curation time. */
    imageIsPlaceholder?: boolean | null;
    /** HLS playlist + first segment verified playable at curation time. Only then is streamUrl usable. */
    streamPlayable?: boolean | null;
  };
  placement: PlacementRegion[];
  tags: string[];
}

export type Region = 'sf' | 'north-bay' | 'east-bay' | 'peninsula' | 'south-bay';
export type EdgeKind = 'freeway' | 'bridge' | 'surface' | 'tunnel';
export type HqId = 'hq-stanford' | 'hq-sf' | 'hq-oakland' | 'hq-sanjose';

export interface NetworkNode {
  id: string;
  cameraId: string | null;
  name: string;
  lat: number;
  lon: number;
  region: Region;
  tags: string[];
  tactical: { x: number; y: number };
}

export interface NetworkEdge {
  id: string;
  a: string;
  b: string;
  kind: EdgeKind;
  route: string;
  lengthKm: number;
}

export interface HqApproach {
  id: string;
  label: string;
  fromNode: string;
  door: string;
}

export interface Headquarters {
  id: HqId;
  name: string;
  lat: number;
  lon: number;
  tactical: { x: number; y: number };
  approaches: HqApproach[];
}

export interface NetworkData {
  version: 1;
  nodes: NetworkNode[];
  edges: NetworkEdge[];
  headquarters: Headquarters[];
  spawnNodes: string[];
}

// ───────────────────────────── Roles, phases, commands ─────────────────────────────

export type Role = 'monster' | 'defender' | 'spectator';
export type AiDifficulty = 'novice' | 'competent' | 'expert';
export interface AiSeat { difficulty: AiDifficulty }
export interface SoloOptions {
  role: 'monster' | 'defender';
  difficulty: AiDifficulty;
  /** Additional defenders for a human defender; ignored for a human monster. */
  teammates?: number;
}
export type Team = 'monster' | 'defenders';

/** Match phases (spec §12). Preparation is a fixed window; the others split the match duration. */
export type MatchPhase = 'preparation' | 'infiltration' | 'escalation' | 'final';

/** Persistent movement stances. The AI turns the active stance into movement every decision. */
export type MonsterStance = 'HUNT' | 'HIDE' | 'FLANK' | 'ATTACK' | 'RETREAT';
/** Instant targeted abilities (do not change stance). */
export type MonsterAbility = 'SABOTAGE' | 'DECOY';
export type MonsterCommand = MonsterStance | MonsterAbility;
export const MONSTER_COMMANDS: readonly MonsterCommand[] = ['HUNT', 'HIDE', 'FLANK', 'SABOTAGE', 'DECOY', 'ATTACK', 'RETREAT'];
export const MONSTER_STANCES: readonly MonsterStance[] = ['HUNT', 'HIDE', 'FLANK', 'ATTACK', 'RETREAT'];

/** Fictional in-game camera status. Independent of the real source availability (CameraSourceStatus). */
export type CameraGameStatus = 'ok' | 'sabotaged' | 'repairing' | 'static' | 'blackout';

export type ManifestationKind = 'shadow' | 'silhouette' | 'figure' | 'closeup';

/** Matches MonsterManifestation in client/src/fx/index.ts, with match time instead of epoch. */
export interface ManifestationState {
  kind: ManifestationKind;
  strength: number;
  regionIndex: number;
  startedAtT: number;
  durationMs: number;
  seed: number;
}

export type PowerLevel = 'high' | 'medium' | 'low' | 'out';

// ───────────────────────────── Actions (client → server, validated with zod) ─────────────────────────────

export type DefenderAction =
  | { type: 'door'; approachId: string; closed: boolean }
  | { type: 'placeSensor'; nodeId: string }
  | { type: 'removeSensor'; sensorId: string }
  | { type: 'armTrap'; nodeId: string }
  | { type: 'disarmTrap'; trapId: string }
  | { type: 'scan'; nodeId: string }
  | { type: 'repair'; cameraId: string }
  | { type: 'lure'; nodeId: string }
  | { type: 'containment'; engage: boolean };

export type MonsterAction =
  | { type: 'command'; command: MonsterStance; approachId?: string }
  | { type: 'sabotage'; nodeId: string; target: 'camera' | 'sensor' }
  | { type: 'decoy'; nodeId: string }
  | { type: 'chooseSpawn'; nodeId: string };

export type GameAction = DefenderAction | MonsterAction;

export interface ActionResult {
  ok: boolean;
  error?: string;
}

// ───────────────────────────── Events ─────────────────────────────

export type GameEventKind =
  | 'phase'
  | 'sighting'
  | 'sensorPing'
  | 'scan'
  | 'scanClear'
  | 'decoyExposed'
  | 'trapArmed'
  | 'trapTriggered'
  | 'containmentStart'
  | 'containmentBroken'
  | 'containmentCancelled'
  | 'captured'
  | 'doorClosed'
  | 'doorOpened'
  | 'doorJammed'
  | 'doorBattered'
  | 'breachStart'
  | 'breachStalled'
  | 'breached'
  | 'sabotage'
  | 'cameraFailure'
  | 'cameraRestored'
  | 'repairStart'
  | 'repairDone'
  | 'powerLow'
  | 'powerOut'
  | 'powerRestored'
  | 'lure'
  | 'disturbance'
  | 'command'
  | 'ability'
  | 'exposed'
  | 'sensorFound'
  | 'scanFelt'
  | 'moved'
  | 'struggle'
  | 'freed'
  | 'spawn'
  | 'timer'
  | 'connectionLost'
  | 'connectionRestored'
  | 'forfeit'
  | 'info';

export type EventAudience = 'all' | 'defenders' | 'monster';

/** Event as stored server-side. Visibility filters by audience before sending. */
export interface GameEvent {
  id: number;
  t: number;
  kind: GameEventKind;
  audience: EventAudience;
  text: string;
  nodeId?: string;
  cameraId?: string;
  approachId?: string;
  severity: 'info' | 'warn' | 'alert' | 'good';
  /** Player id of the defender whose action produced this event (team attribution). */
  by?: string;
}

/** Event as seen by a client (no audience/internal fields). */
export interface VisibleEvent {
  id: number;
  t: number;
  kind: GameEventKind;
  text: string;
  nodeId?: string;
  cameraId?: string;
  approachId?: string;
  severity: GameEvent['severity'];
  /** Defender player id that caused it (defender/spectator views only). */
  by?: string;
}

// ───────────────────────────── Per-role views (server → client) ─────────────────────────────

export interface TeamConnectionView {
  connected: boolean;
  connectedPlayers: number;
  totalPlayers: number;
  /** Wall-clock deadline; null while at least one member of the team is online. */
  reconnectDeadlineEpoch: number | null;
  /** Cumulative whole-team pause allowance left this match (wall milliseconds). */
  pauseRemainingMs?: number;
}

export interface ViewBase {
  monsterConnection?: TeamConnectionView;
  defenderConnection?: TeamConnectionView;
  /** Simulation is paused during a whole-team reconnection grace period. */
  pausedForReconnect?: boolean;
  t: number;
  /** Server epoch at match time 0. epoch(t) = t0Epoch + t. */
  t0Epoch: number;
  /** Server epoch when this view was produced (for clock sync). */
  serverNow: number;
  phase: MatchPhase;
  phaseEndsAt: number; // match time
  matchEndsAt: number; // match time
  hqId: HqId;
  defenderCount: number;
  events: VisibleEvent[];
  ended: boolean;
}

export interface CameraView {
  cameraId: string;
  nodeId: string;
  status: CameraGameStatus;
  repairProgress: number | null; // 0..1 while repairing
  /** 0..1 ambient interference (phase + global threat + recent activity). Never encodes exact position. */
  interference: number;
  manifestation: ManifestationState | null;
}

export interface DoorView {
  approachId: string;
  closed: boolean;
  heat: number; // 0..1
  jammedUntil: number | null; // match time
  battering: boolean; // monster hitting it (defenders hear it)
}

export interface SensorView {
  id: string;
  nodeId: string;
  disabledUntil: number | null;
  lastPingAt: number | null;
}

export interface TrapView {
  id: string;
  nodeId: string;
  armedAt: number; // match time when it becomes live
  live: boolean;
}

export interface LureView {
  id: string;
  nodeId: string;
  expiresAt: number;
}

export interface SightingView {
  id: number;
  nodeId: string;
  t: number;
  confidence: number; // 0..1
  source: 'camera' | 'sensor' | 'scan' | 'trap' | 'breach';
  /** Only ever true after a scan exposed it as false. Never reveals decoys otherwise. */
  flaggedFalse: boolean;
}

export interface BreachView {
  approachId: string;
  progress: number; // 0..1
  stalled: boolean;
}

export interface ContainmentView {
  nodeId: string;
  active: boolean;
  progress: number; // 0..1 toward capture
}

export interface DefenderView extends ViewBase {
  role: 'defender' | 'spectator';
  power: { value: number; max: number; outageUntil: number | null; drainPerSec: number };
  threat: number; // 0..1 (quantised)
  doors: DoorView[];
  sensors: SensorView[];
  traps: TrapView[];
  lures: LureView[];
  cameras: CameraView[];
  sightings: SightingView[];
  lastKnown: { nodeId: string; t: number } | null;
  /** Present only while the monster is physically held by a trap/containment (its location is known then). */
  held: { nodeId: string; until: number; struggling: boolean } | null;
  containment: ContainmentView | null;
  breach: BreachView | null;
  repairs: Array<{ cameraId: string; endsAt: number }>;
  cooldowns: { scanReadyAt: number; lureReadyAt: number };
  limits: { sensors: number; traps: number; repairsConcurrent: number };
  lastScan: { nodeId: string; t: number; radiusHops: number; found: boolean } | null;
}

export interface MonsterSelfView {
  spawned: boolean;
  spawnChoice: string | null;
  nodeId: string | null;
  moving: { from: string; to: string; edgeId: string; progress: number } | null;
  path: string[];
  stance: MonsterStance;
  targetApproachId: string | null;
  held: { until: number; contained: boolean; struggle: number; struggling: boolean } | null;
  cooldowns: Record<MonsterCommand, number>; // match time when ready
}

export interface MonsterView extends ViewBase {
  role: 'monster';
  self: MonsterSelfView;
  /** Valid spawn nodes for the selected HQ (only meaningful during preparation). */
  spawnOptions: string[];
  /** Camera game statuses are visible to the monster (it can see which cameras are dead). */
  cameras: Array<{ cameraId: string; nodeId: string; status: CameraGameStatus }>;
  knownSensors: Array<{ id: string; nodeId: string; disabledUntil: number | null }>;
  knownDoors: Array<{ approachId: string; closed: boolean; jammed: boolean; seenAt: number }>;
  disturbances: Array<{ nodeId: string; t: number; expiresAt: number }>;
  scanPulses: Array<{ nodeId: string; t: number }>;
  exposures: Array<{ nodeId: string; t: number }>;
  powerLevel: PowerLevel;
  breach: BreachView | null;
  containment: { active: boolean; progress: number } | null;
}

export type PlayerView = DefenderView | MonsterView;

// ───────────────────────────── Results ─────────────────────────────

export type WinReason = 'breach' | 'timer' | 'capture' | 'forfeit';

export interface MatchStats {
  durationMs: number;
  sightings: number;
  falseSightings: number;
  decoysExposed: number;
  sensorPings: number;
  scans: number;
  trapsArmed: number;
  trapsTriggered: number;
  containmentAttempts: number;
  sabotages: number;
  repairs: number;
  cameraFailures: number;
  powerSpent: number;
  powerOutages: number;
  doorCloseSeconds: number;
  monsterDistanceKm: number;
  monsterNodesVisited: number;
  commandsIssued: number;
}

export interface MatchResult {
  /** Match-start roster, retained for timeline attribution even after players leave. */
  players?: Array<Pick<LobbyPlayer, 'id' | 'name' | 'role' | 'ai'>>;
  /** Human-readable result detail, including which team failed to reconnect. */
  reasonText?: string;
  winner: Team;
  reason: WinReason;
  hqId: HqId;
  approachId: string | null;
  endedAtT: number;
  stats: MatchStats;
  /** Full timeline (all audiences) revealed after the match. */
  timeline: VisibleEvent[];
  /** Monster's actual path, revealed after the match. */
  monsterPath: Array<{ nodeId: string; t: number }>;
}

// ───────────────────────────── Lobby / rooms ─────────────────────────────

export type RoomStage = 'lobby' | 'countdown' | 'playing' | 'results';

export interface LobbyPlayer {
  /** Absent for humans. AI seats are always connected and ready in the lobby. */
  ai?: AiSeat;
  id: string;
  name: string;
  role: Role;
  ready: boolean;
  connected: boolean;
  isHost: boolean;
}

export interface RoomSettings {
  durationSec: number;
  hqId: HqId;
}

export interface RoomView {
  code: string;
  youId: string;
  stage: RoomStage;
  players: LobbyPlayer[];
  settings: RoomSettings;
  countdownEndsAt: number | null; // epoch
  serverNow: number;
  /** Why the match can't start yet (null when ready to count down). */
  blocker: string | null;
  result: MatchResult | null;
}

// ───────────────────────────── Camera source (real-world availability) ─────────────────────────────

export type CameraSourceMode = 'live' | 'snapshot' | 'simulated' | 'offline';

export interface CameraSourceStatus {
  cameraId: string;
  mode: CameraSourceMode;
  snapshotUrl: string | null;
  streamUrl: string | null;
  lastUpdated: number | null; // epoch
  error: string | null;
  // ── additive (camera service, wave 2) ────────────────────────────────────────────────────────────
  /** Human-readable explanation of `mode` ("Caltrans 'Temporarily Unavailable' card", "HLS playable", ...). */
  reason?: string | null;
  /** Epoch ms of the image content itself (Caltrans Last-Modified, else probe time). Drives "4m ago". */
  imageAt?: number | null;
  /** Suggested client snapshot refresh interval in ms. */
  refreshMs?: number;
}
