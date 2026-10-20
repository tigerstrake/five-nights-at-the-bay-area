// Monster AI interface. Owner: Foundation (baseline) → AI agent (wave 2).
// The brain only ever sees MonsterKnowledge — the monster's LEGITIMATE information (no trap positions,
// no undiscovered sensors, no defender power value, no door states it has not observed).
import type { BalanceConfig, CameraGameStatus, Graph, HqId, MatchPhase, MonsterStance, PowerLevel, Rng } from '@fnab/shared';

export interface MonsterKnowledge {
  t: number;
  phase: MatchPhase;
  hqId: HqId;
  stance: MonsterStance;
  /** Player-chosen approach (ATTACK/FLANK/HUNT may target one), or null = AI picks. */
  targetApproachId: string | null;
  position: {
    nodeId: string | null;
    moving: { from: string; to: string; edgeId: string; progress: number } | null;
  };
  held: boolean;
  /** Camera game status by node id (cameras are visibly dead or alive to the monster). */
  cameraStatusByNode: Record<string, CameraGameStatus>;
  knownSensors: Array<{ id: string; nodeId: string; disabled: boolean; seenAt: number }>;
  knownDoors: Record<string, { closed: boolean; jammed: boolean; seenAt: number }>;
  disturbances: Array<{ nodeId: string; t: number; expiresAt: number }>;
  scanPulses: Array<{ nodeId: string; t: number }>;
  /** Places where the monster believes it was seen recently. */
  exposures: Array<{ nodeId: string; t: number }>;
  recentNodes: string[];
  powerLevel: PowerLevel;
}

export interface BrainInput {
  graph: Graph;
  cfg: BalanceConfig;
  knowledge: MonsterKnowledge;
  /** Phase aggression multiplier from config. */
  aggression: number;
}

export interface MonsterIntent {
  /**
   * Planned route. path[0] must be the monster's current node, or — while moving — either endpoint of the
   * current edge (the endpoint it came from means "turn around"). Subsequent entries must be adjacent.
   * A single-element path means "hold position".
   */
  path: string[];
  /** Breach this approach when standing on its fromNode (null = don't breach). */
  breachApproachId: string | null;
  /** Human-readable explanation, surfaced in the monster player's AI feedback log. */
  reason: string;
  /** Re-plan no later than this many ms from now even if nothing happens. */
  replanInMs?: number;
}

export interface MonsterBrain {
  decide(input: BrainInput, rng: Rng): MonsterIntent;
}
