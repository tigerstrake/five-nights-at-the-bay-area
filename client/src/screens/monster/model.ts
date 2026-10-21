// Derived, monster-legitimate situational data. Everything here is computed only from the MonsterView
// (what the creature knows) plus public rules (balance config) and the public graph.
import { scaleForDefenders, type BalanceConfig, type MonsterCommand, type MonsterStance, type MonsterView } from '@fnab/shared';
import { graph } from '../../lib/data';

export interface CommandInfo {
  id: MonsterCommand;
  key: string;
  desc: string;
}

export const STANCE_INFO: Record<MonsterStance, CommandInfo> = {
  HUNT: { id: 'HUNT', key: 'H', desc: 'Stalk the HQ. Lured by disturbances. Breaches from Escalation.' },
  HIDE: { id: 'HIDE', key: 'C', desc: 'Creep between blind spots. Slow, nearly invisible. Never breaches.' },
  FLANK: { id: 'FLANK', key: 'F', desc: 'Circle to the least-defended door, around known sensors.' },
  ATTACK: { id: 'ATTACK', key: 'A', desc: 'Charge the target door and break it. Fast and loud.' },
  RETREAT: { id: 'RETREAT', key: 'R', desc: 'Fall back from the HQ. When trapped, struggle free.' },
};
export const STANCE_ORDER: MonsterStance[] = ['HUNT', 'HIDE', 'FLANK', 'ATTACK', 'RETREAT'];

export const ABILITY_INFO = {
  SABOTAGE: { id: 'SABOTAGE' as const, key: 'S', desc: 'Kill a nearby camera or a sensor you found.' },
  DECOY: { id: 'DECOY' as const, key: 'D', desc: 'Fake a sighting on a working camera.' },
};

export type RiskLevel = 'unseen' | 'watched' | 'exposed' | 'hunted';

export interface Situation {
  cfg: BalanceConfig;
  origins: string[];
  /** Node the monster is at, or the nearer endpoint while moving. */
  focusNode: string | null;
  hopsToHq: number | null;
  camByNode: Record<string, MonsterView['cameras'][number]>;
  /** Chance per second that the camera on the focus node sights you (public detection rule). */
  detectPerSec: number;
  watchedHere: boolean;
  sensorsInReach: number;
  scanNearby: boolean;
  seenRecently: { nodeId: string; ago: number } | null;
  risk: number;
  riskLevel: RiskLevel;
  pathAhead: string[];
  pathWatched: number;
  blindNear: number;
  camsNear: number;
  sabotageTargets: Map<string, { camera: boolean; sensor: string | null }>;
  decoyTargets: Set<string>;
  sabotageRange: Set<string>;
  decoyRange: Set<string>;
}

const cfgCache = new Map<number, BalanceConfig>();
export function cfgFor(defenders: number): BalanceConfig {
  let c = cfgCache.get(defenders);
  if (!c) cfgCache.set(defenders, (c = scaleForDefenders(defenders)));
  return c;
}

export function situation(view: MonsterView, t: number): Situation {
  const cfg = cfgFor(view.defenderCount);
  const self = view.self;
  const origins = self.moving ? [self.moving.from, self.moving.to] : self.nodeId ? [self.nodeId] : [];
  const focusNode = self.moving ? (self.moving.progress < 0.5 ? self.moving.from : self.moving.to) : self.nodeId;
  const hopsToHq = focusNode
    ? Math.min(...origins.map((o) => graph.hopsToHq(o, view.hqId)).filter((h) => Number.isFinite(h)))
    : null;
  const camByNode = Object.fromEntries(view.cameras.map((c) => [c.nodeId, c]));
  const powered = view.powerLevel !== 'out';

  const camOk = (n: string) => powered && camByNode[n]?.status === 'ok';
  const watchedHere = !!focusNode && camOk(focusNode);
  let detectPerSec = 0;
  if (watchedHere && hopsToHq !== null) {
    const d = cfg.detection;
    const prox = d.proximityMult[Math.min(hopsToHq, d.proximityMult.length - 1)] ?? 1;
    const per = d.baseChance * d.stanceMult[self.stance] * d.phaseMult[view.phase] * prox * (self.moving ? d.movingMult : 1);
    detectPerSec = Math.min(0.95, (per * 1000) / d.rollEveryMs);
  }

  const reach = new Set<string>();
  for (const o of origins) for (const n of [o, ...graph.neighbors(o)]) reach.add(n);
  const sensorsInReach = view.knownSensors.filter((s) => !s.disabledUntil && reach.has(s.nodeId)).length;
  const near2 = new Set<string>();
  for (const o of origins) for (const n of graph.within(o, 2)) near2.add(n);
  const scanNearby = view.scanPulses.some((p) => near2.has(p.nodeId) && t - p.t < 20_000);
  const lastExposure = [...view.exposures].sort((a, b) => b.t - a.t)[0];
  const seenRecently = lastExposure && t - lastExposure.t < 30_000 ? { nodeId: lastExposure.nodeId, ago: t - lastExposure.t } : null;

  // Risk: chance of a camera sighting over the next ~5 s, plus what you know is watching nearby.
  let risk = 1 - Math.pow(1 - detectPerSec, 5);
  risk += 0.25 * sensorsInReach;
  if (scanNearby) risk += 0.2;
  if (seenRecently && reach.has(seenRecently.nodeId)) risk += 0.25;
  if (self.held) risk = 1;
  risk = Math.max(0, Math.min(1, risk));
  let riskLevel: RiskLevel = risk >= 0.75 ? 'hunted' : risk >= 0.45 ? 'exposed' : risk >= 0.15 ? 'watched' : 'unseen';
  if (riskLevel === 'unseen' && (watchedHere || sensorsInReach)) riskLevel = 'watched';

  const pathAhead = self.path.filter(Boolean);
  const pathWatched = pathAhead.filter(camOk).length;
  let camsNear = 0;
  let blindNear = 0;
  for (const n of near2) {
    const c = camByNode[n];
    if (!c) continue;
    camsNear++;
    if (!camOk(n)) blindNear++;
  }

  const sabotageRange = new Set<string>();
  for (const o of origins) for (const n of graph.within(o, cfg.monster.sabotageRangeHops)) sabotageRange.add(n);
  const decoyRange = new Set<string>();
  for (const o of origins) for (const n of graph.within(o, cfg.monster.decoyRangeHops)) decoyRange.add(n);

  const sabotageTargets = new Map<string, { camera: boolean; sensor: string | null }>();
  for (const n of sabotageRange) {
    const c = camByNode[n];
    const camera = !!c && c.status !== 'sabotaged' && c.status !== 'blackout';
    const sensor = view.knownSensors.find((s) => s.nodeId === n && !s.disabledUntil)?.id ?? null;
    if (camera || sensor) sabotageTargets.set(n, { camera, sensor });
  }
  const decoyTargets = new Set([...decoyRange].filter(camOk));

  return {
    cfg,
    origins,
    focusNode,
    hopsToHq: hopsToHq !== null && Number.isFinite(hopsToHq) ? hopsToHq : null,
    camByNode,
    detectPerSec,
    watchedHere,
    sensorsInReach,
    scanNearby,
    seenRecently,
    risk,
    riskLevel,
    pathAhead,
    pathWatched,
    blindNear,
    camsNear,
    sabotageTargets,
    decoyTargets,
    sabotageRange,
    decoyRange,
  };
}

export const RISK_WORD: Record<RiskLevel, string> = {
  unseen: 'Unseen',
  watched: 'Watched',
  exposed: 'Exposed',
  hunted: 'Hunted',
};

/** Phase boundaries in match time, from public config. */
export function phaseMarks(view: MonsterView, cfg: BalanceConfig) {
  const prepEnd = cfg.match.prepMs;
  const total = Math.max(1, view.matchEndsAt - prepEnd);
  const inf = prepEnd + total * cfg.match.phaseFractions.infiltration;
  const esc = inf + total * cfg.match.phaseFractions.escalation;
  return { prepEnd, inf, esc, end: view.matchEndsAt };
}

/** Plain-language rule for the current phase. */
export function phaseRule(view: MonsterView): string {
  switch (view.phase) {
    case 'preparation':
      return 'Pick where you emerge and an opening stance. The defenders are laying traps.';
    case 'infiltration':
      return 'Only ATTACK breaches now, and slowly. HUNT and FLANK just probe the doors.';
    case 'escalation':
      return 'You move faster. HUNT and FLANK will now breach an open door.';
    case 'final':
      return 'Fastest, but cameras see you more easily. Break in before dawn.';
  }
}
