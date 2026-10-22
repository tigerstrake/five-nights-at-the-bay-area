// ALL balance tunables live here (spec §13). Engine code must not hard-code gameplay numbers.
// Times in ms, power in abstract units, rates per second unless noted.
import type { AiDifficulty, MonsterCommand, MonsterStance, MatchPhase, ManifestationKind, HqId } from './types';

/** Seat controllers; the reused defender policy retains its measured skill/attention settings. */
export const AI_PLAYER_CONFIG: {
  observeMs: number;
  initialStaggerMs: [number, number];
  monsterReactionMs: Record<AiDifficulty, [number, number]>;
  soloMaxTeammates: number;
} = {
  observeMs: 300,
  initialStaggerMs: [0, 350],
  monsterReactionMs: { novice: [3_000, 6_000], competent: [1_200, 3_600], expert: [350, 1_000] },
  soloMaxTeammates: 2,
};

/** Utility weights for the tactical brain only; these do not change simulation balance. */
export interface TacticalAiConfig {
  exposureMs: number;
  cameraNeighborExposure: number;
  sensorExposure: number;
  sensorNeighborWeight: number;
  dangerNeighborWeight: number;
  dangerWeights: { sighted: number; scanned: number; trapped: number };
  stanceExposure: Record<MonsterStance, number>;
  recentPathPenalty: number;
  obviousPathPenalty: number;
  safetyWeight: number;
  openDoorCredit: number;
  switchMargin: number;
  variationCostRatio: number;
  variationChanceMin: number;
  variationChanceMax: number;
  lureHops: number;
  lureAttractionMs: number;
  relocationDanger: number;
  minimumAggression: number;
}

export const DEFAULT_TACTICAL_AI: TacticalAiConfig = {
  exposureMs: 8_000,
  cameraNeighborExposure: 0.15,
  sensorExposure: 2,
  sensorNeighborWeight: 0.5,
  dangerNeighborWeight: 0.25,
  dangerWeights: { sighted: 2, scanned: 2.5, trapped: 6 },
  stanceExposure: { HUNT: 0.6, HIDE: 4, FLANK: 2, ATTACK: 0.08, RETREAT: 1.2 },
  recentPathPenalty: 3,
  obviousPathPenalty: 2,
  safetyWeight: 6,
  openDoorCredit: 1.5,
  switchMargin: 0.2,
  variationCostRatio: 1.2,
  variationChanceMin: 0.1,
  variationChanceMax: 0.2,
  lureHops: 4,
  lureAttractionMs: 120_000,
  relocationDanger: 1,
  minimumAggression: 0.25,
};

export interface BalanceConfig {
  tickMs: number;
  /**
   * Monster spawn options are chosen per selected HQ so every HQ is equally far: any node whose hop distance to
   * the HQ's nearest approach node is within [minHopsFromHq, maxHopsFromHq] (fallback: the farthest nodes).
   */
  spawn: { minHopsFromHq: number; maxHopsFromHq: number };
  match: {
    durationMs: number; // default 480s
    minDurationMs: number;
    maxDurationMs: number;
    prepMs: number;
    /** Fractions of the (post-prep) match duration. final = remainder. */
    phaseFractions: { infiltration: number; escalation: number };
    countdownMs: number;
  };
  monster: {
    /** Optional overrides of AI utility weights; old configurations remain valid. */
    tactical?: Partial<TacticalAiConfig>;
    /** Edge travel time = clamp(baseEdgeMs + lengthKm × msPerKm, min, max) × stance × phase multipliers. */
    baseEdgeMs: number;
    msPerKm: number;
    minEdgeMs: number;
    maxEdgeMs: number;
    stanceSpeed: Record<MonsterStance, number>; // multiplier on travel time (>1 = slower)
    phaseSpeed: Record<MatchPhase, number>;
    cooldownMs: Record<MonsterCommand, number>;
    /** Minimum gap between any two commands (anti-spam). */
    globalCommandGapMs: number;
    sabotageRangeHops: number;
    sabotageDurationMs: number;
    sensorSabotageDurationMs: number;
    decoyRangeHops: number;
    decoyFollowupMs: [number, number];
    /** Idle re-plan interval for the AI when waiting. */
    replanMs: number;
    /** Chance per decision that the AI deviates to a second-best plan (×phase aggression). */
    unpredictability: number;
    phaseAggression: Record<MatchPhase, number>;
    retreatHops: number;
    freedTrapImmunityMs: number;
  };
  detection: {
    /** Detection roll cadence. */
    rollEveryMs: number;
    /** Per-roll chance to be sighted by a working camera at the monster's node. */
    baseChance: number;
    stanceMult: Record<MonsterStance, number>;
    phaseMult: Record<MatchPhase, number>;
    movingMult: number;
    /** Multiplier by hop distance to the selected HQ's nearest approach node (index = hops, last = beyond). */
    proximityMult: number[];
    /** Extra chance on the roll right after arriving at a node. */
    arrivalBonus: number;
    confidence: { min: number; max: number; hideMax: number };
    sightingTtlMs: number;
    exposureNoticeChance: number; // chance the monster is told it was seen
    /** Manifestation kind by hop distance to HQ (index = hops, last = beyond). */
    manifestationByHops: ManifestationKind[];
    manifestationMs: [number, number];
  };
  power: {
    max: number;
    /** Small HQ reserve offsets compensate for graph approach topology. */
    hqBonus?: Partial<Record<HqId, number>>;
    regenPerSec: number;
    lowThreshold: number;
    outageMs: number;
    restoreTo: number;
    doorDrainPerSec: number;
    sensorPlaceCost: number;
    sensorUpkeepPerSec: number;
    trapArmCost: number;
    scanCost: number;
    repairCost: number;
    lureCost: number;
    containmentDrainPerSec: number;
    containmentStartCost: number;
  };
  doors: {
    heatPerSecClosed: number; // 0..1 scale
    heatPerSecBattered: number;
    coolPerSecOpen: number;
    jamMs: number;
    heatAfterJam: number;
  };
  sensors: {
    maxCount: number;
    pingCooldownMs: number;
    /** Same vague confidence for exact-node and adjacent motion. Optional for saved configs. */
    confidence?: number;
    hideDetectChance: number;
    /** Chance a pinging sensor reveals itself to the monster. */
    revealChance: number;
  };
  scan: {
    cooldownMs: number;
    radiusHops: number;
    /** Decoy sightings younger than this inside the scan radius are flagged false. */
    decoyExposeWindowMs: number;
  };
  traps: {
    maxCount: number;
    armDelayMs: number;
    holdMs: number; // spec: 8s
  };
  containment: {
    captureMs: number; // spec: 15s uninterrupted
    /** Time of continuous struggling needed to break free of a bare trap. */
    struggleBreakMs: number;
    /** Struggle rate multiplier while containment is engaged (<1 = containment holds better). */
    containedStruggleMult: number;
    /** Early containment is less stable; later phases improve the field without changing the 15 s capture timer. */
    phaseStruggleMult?: Record<MatchPhase, number>;
  };
  repair: { durationMs: number; maxConcurrent: number };
  lure: { cooldownMs: number; durationMs: number; maxActive: number };
  failures: {
    /** Expected random fictional camera failures per minute across the whole network. */
    perMinute: number;
    durationMs: [number, number];
  };
  breach: {
    durationMs: number;
    /** HQ security channel adjustment, applied once at match creation. */
    hqMult?: Partial<Record<HqId, number>>;
    phaseMult: Record<MatchPhase, number>; // multiplier on duration
    decayPerSecWhenStalled: number; // fraction of progress lost per second when door closed
  };
  threat: { steps: number; horizonHops: number; phaseFloor: Record<MatchPhase, number>; hideDampen: number };
  visibility: {
    /** Bounds on authoritative retained logs, including events emitted between ticks. */
    maxRetainedEvents?: number;
    maxRetainedSightings?: number;
    maxRetainedPath?: number;
    eventsInView: number;
    sightingsInView: number;
    phaseInterference: Record<MatchPhase, number>;
    /** Monster knowledge items older than this are dropped. */
    monsterMemoryMs: number;
    /** A door's state is observed by the monster within this many hops of its approach node. */
    doorObserveHops: number;
  };
  room: {
    codeLength: number;
    reconnectGraceMs: number;
    /** Cumulative wall-time pause allowance per team per match; reconnects never refill it. */
    reconnectPauseBudgetMs?: number;
    emptyRoomTtlMs: number;
    maxPlayers: number;
    maxNameLength: number;
  };
  /** Transport token buckets; optional so saved balance configurations remain compatible. */
  net?: {
    socketBurst: number; socketPerSecond: number;
    ipBurst: number; ipPerSecond: number;
    joinBurst: number; joinPerSecond: number;
    failedJoinBurst: number; failedJoinPerSecond: number;
    ipIdleTtlMs: number; maxTrackedIps: number;
  };
}

export const DEFAULT_CONFIG: BalanceConfig = {
  tickMs: 100,
  spawn: { minHopsFromHq: 5, maxHopsFromHq: 6 },
  match: {
    durationMs: 480_000,
    minDurationMs: 300_000,
    maxDurationMs: 600_000,
    prepMs: 20_000,
    phaseFractions: { infiltration: 0.4, escalation: 0.35 },
    countdownMs: 5_000,
  },
  monster: {
    baseEdgeMs: 18_000,
    msPerKm: 200,
    minEdgeMs: 8_000,
    maxEdgeMs: 25_000,
    stanceSpeed: { HUNT: 1.0, HIDE: 1.6, FLANK: 1.1, ATTACK: 0.8, RETREAT: 0.75 },
    phaseSpeed: { preparation: 1, infiltration: 1.0, escalation: 0.9, final: 0.8 },
    cooldownMs: { HUNT: 0, HIDE: 15_000, FLANK: 15_000, ATTACK: 20_000, RETREAT: 30_000, SABOTAGE: 30_000, DECOY: 25_000 },
    globalCommandGapMs: 1_500,
    sabotageRangeHops: 1,
    sabotageDurationMs: 45_000,
    sensorSabotageDurationMs: 30_000,
    decoyRangeHops: 3,
    decoyFollowupMs: [3_000, 6_000],
    replanMs: 2_500,
    unpredictability: 0.12,
    phaseAggression: { preparation: 0, infiltration: 0.6, escalation: 1.0, final: 1.4 },
    retreatHops: 2,
    freedTrapImmunityMs: 6_000,
  },
  detection: {
    rollEveryMs: 1_000,
    baseChance: 0.08,
    stanceMult: { HUNT: 1.0, HIDE: 0.3, FLANK: 0.75, ATTACK: 1.5, RETREAT: 1.1 },
    phaseMult: { preparation: 0, infiltration: 0.9, escalation: 1.0, final: 1.2 },
    movingMult: 0.35,
    proximityMult: [2.2, 1.8, 1.4, 1.1, 1.0],
    arrivalBonus: 0.15,
    confidence: { min: 0.45, max: 0.95, hideMax: 0.6 },
    sightingTtlMs: 60_000,
    exposureNoticeChance: 0.7,
    manifestationByHops: ['closeup', 'figure', 'silhouette', 'shadow'],
    manifestationMs: [2_500, 5_000],
  },
  power: {
    max: 94,
    hqBonus: { 'hq-stanford': 24, 'hq-sf': -8, 'hq-oakland': -8, 'hq-sanjose': 0 },
    regenPerSec: 0.24,
    lowThreshold: 25,
    outageMs: 12_000,
    restoreTo: 15,
    doorDrainPerSec: 0.8,
    sensorPlaceCost: 5,
    sensorUpkeepPerSec: 0.03,
    trapArmCost: 8,
    scanCost: 12,
    repairCost: 8,
    lureCost: 6,
    containmentDrainPerSec: 1.6,
    containmentStartCost: 4,
  },
  doors: {
    heatPerSecClosed: 1 / 25,
    heatPerSecBattered: 1 / 20,
    coolPerSecOpen: 1 / 20,
    jamMs: 12_000,
    heatAfterJam: 0.4,
  },
  sensors: { maxCount: 4, pingCooldownMs: 6_000, confidence: 0.5, hideDetectChance: 0.5, revealChance: 0.5 },
  scan: { cooldownMs: 20_000, radiusHops: 1, decoyExposeWindowMs: 40_000 },
  traps: { maxCount: 3, armDelayMs: 6_000, holdMs: 8_000 },
  containment: {
    captureMs: 15_000, struggleBreakMs: 12_300, containedStruggleMult: 0.7,
    phaseStruggleMult: { preparation: 1, infiltration: 1.4, escalation: 1.1, final: 0.8 },
  },
  repair: { durationMs: 10_000, maxConcurrent: 2 },
  lure: { cooldownMs: 25_000, durationMs: 25_000, maxActive: 2 },
  failures: { perMinute: 1.2, durationMs: [6_000, 14_000] },
  breach: {
    durationMs: 16_000,
    hqMult: { 'hq-sf': 0.98, 'hq-oakland': 0.96 },
    phaseMult: { preparation: 99, infiltration: 1.8, escalation: 1.2, final: 1.0 },
    decayPerSecWhenStalled: 0.08,
  },
  threat: {
    steps: 5,
    horizonHops: 6,
    phaseFloor: { preparation: 0, infiltration: 0.05, escalation: 0.2, final: 0.4 },
    hideDampen: 0.75,
  },
  visibility: {
    maxRetainedEvents: 4096,
    maxRetainedSightings: 256,
    maxRetainedPath: 512,
    eventsInView: 60,
    sightingsInView: 20,
    phaseInterference: { preparation: 0.05, infiltration: 0.1, escalation: 0.2, final: 0.35 },
    monsterMemoryMs: 45_000,
    doorObserveHops: 1,
  },
  room: { codeLength: 4, reconnectGraceMs: 45_000, reconnectPauseBudgetMs: 75_000, emptyRoomTtlMs: 120_000, maxPlayers: 12, maxNameLength: 20 },
  net: {
    socketBurst: 40, socketPerSecond: 12,
    ipBurst: 160, ipPerSecond: 48,
    joinBurst: 12, joinPerSecond: 0.5,
    failedJoinBurst: 8, failedJoinPerSecond: 0.1,
    ipIdleTtlMs: 600_000, maxTrackedIps: 10_000,
  },
};

/**
 * Difficulty scaling by defender count (spec §3, §13). One defender = baseline.
 * More defenders: monster moves faster, is detected less, struggles harder; defenders get more devices
 * but proportionally less power per head.
 */
export function scaleForDefenders(count: number, base: BalanceConfig = DEFAULT_CONFIG): BalanceConfig {
  const n = Math.max(1, Math.floor(count));
  const extra = n - 1;
  const c: BalanceConfig = JSON.parse(JSON.stringify(base)) as BalanceConfig;
  const speed = 1 / (1 + 0.025 * Math.min(extra, 5));
  c.monster.baseEdgeMs = Math.round(base.monster.baseEdgeMs * speed);
  c.monster.msPerKm = base.monster.msPerKm * speed;
  c.monster.minEdgeMs = Math.round(base.monster.minEdgeMs * speed);
  c.detection.baseChance = base.detection.baseChance / (1 + 0.1 * Math.min(extra, 5));
  c.power.max = base.power.max + [0, 20, 42, 48, 62][Math.min(extra, 4)]!;
  c.sensors.maxCount = base.sensors.maxCount + Math.min(extra, 3);
  c.traps.maxCount = base.traps.maxCount + Math.floor(Math.min(extra, 4) / 2);
  c.repair.maxConcurrent = base.repair.maxConcurrent + Math.floor(Math.min(extra, 2) / 2);
  c.containment.struggleBreakMs = Math.round(base.containment.struggleBreakMs / (1 + 0.04 * Math.min(extra, 2) + 0.02 * Math.max(0, Math.min(extra, 5) - 2)));
  c.breach.durationMs = Math.round(base.breach.durationMs / (1 + 0.03 * Math.min(extra, 5)));
  return c;
}

export function clampDurationMs(ms: number, cfg: BalanceConfig = DEFAULT_CONFIG): number {
  return Math.min(cfg.match.maxDurationMs, Math.max(cfg.match.minDurationMs, Math.round(ms)));
}
/**
 * Opt-in view delta transport (server/src/net/viewUpdates.ts). A full `game:view` checkpoint is also sent every
 * `fullEveryTicks` emissions (30 s at 10 Hz) as a safety net; gaps are otherwise repaired by `game:resync`.
 */
export const VIEW_TRANSPORT_CONFIG = { fullEveryTicks: 300 } as const;
