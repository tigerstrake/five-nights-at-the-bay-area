import { DEFAULT_CONFIG, Graph, NETWORK, createRng, hashString, scaleForDefenders,
  type BalanceConfig, type HqId, type MatchPhase, type MatchStats, type WinReason } from '@fnab/shared';
import { TacticalBrain } from '../ai/tacticalBrain';
import { applyAction, step, type EngineCtx } from '../engine/engine';
import { createGame } from '../engine/state';
import { projectDefenderView, projectMonsterView } from '../visibility';
import { DefenderBot, MonsterBot, POLICIES, type DefenderSkill, type MonsterPolicy } from './bots';
import { BEFORE_CONFIG, scaleBefore } from './before';
import { SLOW_CONFIG, scaleSlow } from './slow';

export const PHASES: MatchPhase[] = ['preparation', 'infiltration', 'escalation', 'final'];
export const HQS = NETWORK.headquarters.map(h => h.id);
const graph = new Graph(NETWORK); // immutable graph caches are shared; brains and bots never are

export interface MatchOptions {
  hq: HqId; defenders: number; duration: number; skill: DefenderSkill; monster: MonsterPolicy; seed: number;
  config?: BalanceConfig; preset?: 'before' | 'current' | 'slow';
}
export interface MatchMeasurement {
  hq: HqId; defenders: number; skill: DefenderSkill; monster: MonsterPolicy; seed: number;
  winner: 'monster' | 'defenders'; reason: WinReason; durationMs: number; stats: MatchStats;
  trappedMs: number; distanceKm: number; doorUptime: number; earlyEnd: boolean; lastThirdBreach: boolean;
  power: Array<{ second: number; value: number }>;
  phaseMs: Record<MatchPhase, number>; sightings: Record<MatchPhase, number>;
  repairLatencyMs: number[]; unrepairedSabotages: number; doorJams: number;
  actions: { defenders: number; monster: number; rejectedDefenders: number; rejectedMonster: number };
  edgesTravelled: number;
  edgeTravelMs: number[];
  realCameraSightings: number;
  reachedFinal: boolean;
}

export function playMatch(o: MatchOptions): MatchMeasurement {
  const scaled = o.preset === 'before' ? scaleBefore(o.defenders, o.config ?? BEFORE_CONFIG)
    : o.preset === 'slow' ? scaleSlow(o.defenders, o.config ?? SLOW_CONFIG) : scaleForDefenders(o.defenders, o.config ?? DEFAULT_CONFIG);
  const s = createGame({ graph, cfg: scaled, hqId: o.hq, durationMs: o.duration * 1000, defenderCount: o.defenders, seed: o.seed });
  const cfg = s.cfg;
  const ctx: EngineCtx = { graph, brain: new TacticalBrain(), placementCount: () => 2 };
  const rng = createRng(o.seed);
  const defenders = new DefenderBot(o.skill, graph, cfg, createRng(hashString(`${o.seed}:defenders`)), o.defenders);
  const monster = new MonsterBot(o.monster, graph, cfg, createRng(hashString(`${o.seed}:monster`)));
  const phaseMs = Object.fromEntries(PHASES.map(p => [p, 0])) as Record<MatchPhase, number>;
  const sightings = { ...phaseMs };
  let trappedMs = 0, distanceKm = 0, nextObserve = 0, nextPower = s.prepMs, lastEventId = 0, edgesTravelled = 0;
  const edgeTravelMs: number[] = [];
  const power: MatchMeasurement['power'] = [];
  const actions = { defenders: 0, monster: 0, rejectedDefenders: 0, rejectedMonster: 0 };
  while (!s.result && s.t <= s.prepMs + s.durationMs) {
    if (s.t >= nextObserve) {
      nextObserve = s.t + 250;
      const clock = { t0Epoch: 0, serverNow: s.t };
      const da = defenders.act(projectDefenderView(ctx, s, clock));
      const ma = monster.act(projectMonsterView(ctx, s, clock));
      if (da) {
        actions.defenders++;
        if (!applyAction(ctx, s, { team: 'defenders', playerId: `d${actions.defenders % o.defenders}` }, da, rng).ok) actions.rejectedDefenders++;
      }
      if (ma) {
        actions.monster++;
        if (!applyAction(ctx, s, { team: 'monster', playerId: 'm' }, ma, rng).ok) actions.rejectedMonster++;
      }
    }
    const dt = Math.min(cfg.tickMs, s.prepMs + s.durationMs - s.t);
    if (dt <= 0) throw new Error('Engine failed to finish at the deadline');
    if (s.monster.held) trappedMs += dt;
    const moving = s.monster.moving;
    if (moving) distanceKm += (graph.edges.get(moving.edgeId)?.lengthKm ?? 0) * Math.min(dt, moving.duration - moving.elapsed) / moving.duration;
    if (moving && moving.elapsed + dt >= moving.duration) { edgesTravelled++; edgeTravelMs.push(moving.duration); }
    step(ctx, s, dt, rng);
    phaseMs[s.phase] += dt;
    for (let i = s.events.length - 1; i >= 0 && s.events[i].id > lastEventId; i--)
      if (s.events[i].kind === 'sighting') sightings[s.phase]++;
    lastEventId = s.events.at(-1)?.id ?? lastEventId;
    if (s.t >= nextPower) {
      power.push({ second: Math.round((s.t - s.prepMs) / 1000), value: s.power.value });
      nextPower += 30_000;
    }
  }
  const result = s.result!;
  const pending = new Map<string, number>(), repairLatencyMs: number[] = [];
  let unrepairedSabotages = 0;
  for (const e of s.events) {
    if (e.kind === 'sabotage' && e.cameraId) {
      if (pending.has(e.cameraId)) unrepairedSabotages++;
      pending.set(e.cameraId, e.t);
    }
    if (e.cameraId && pending.has(e.cameraId)) {
      if (e.kind === 'repairDone') { repairLatencyMs.push(e.t - pending.get(e.cameraId)!); pending.delete(e.cameraId); }
      else if (e.kind === 'cameraRestored') { unrepairedSabotages++; pending.delete(e.cameraId); }
    }
  }
  return {
    hq: o.hq, defenders: o.defenders, skill: o.skill, monster: o.monster, seed: o.seed,
    winner: result.winner, reason: result.reason, durationMs: result.stats.durationMs, stats: result.stats,
    trappedMs, distanceKm, doorUptime: result.stats.doorCloseSeconds / Math.max(0.001, result.stats.durationMs / 1000 * Object.keys(s.doors).length),
    earlyEnd: result.stats.durationMs < s.durationMs * cfg.match.phaseFractions.infiltration,
    lastThirdBreach: result.reason === 'breach' && result.stats.durationMs >= s.durationMs * 2 / 3,
    phaseMs, sightings, power, repairLatencyMs, unrepairedSabotages: unrepairedSabotages + pending.size,
    doorJams: s.events.filter(e => e.kind === 'doorJammed').length, actions,
    edgesTravelled, edgeTravelMs, realCameraSightings: s.stats.sightings - s.stats.falseSightings,
    reachedFinal: phaseMs.final > 0,
  };
}

export interface BatchOptions {
  matches: number; hqs: HqId[]; defenders: number[]; duration: number; skill: DefenderSkill;
  monster: MonsterPolicy | 'mixed'; seed: number; config?: BalanceConfig; preset?: 'before' | 'current' | 'slow';
}
export function runBatch(o: BatchOptions, onCell?: (cell: MatchMeasurement[]) => void): MatchMeasurement[] {
  const all: MatchMeasurement[] = [];
  for (const hq of o.hqs) for (const defenders of o.defenders) {
    const cell: MatchMeasurement[] = [];
    for (let i = 0; i < o.matches; i++) {
      const seed = hashString(`${o.seed}:${i}`);
      const measurement = playMatch({
        hq, defenders, duration: o.duration, skill: o.skill,
        monster: o.monster === 'mixed' ? POLICIES[i % POLICIES.length] : o.monster,
        seed, config: o.config, preset: o.preset,
      });
      // Detach completed measurements before subsequent simulations or report callbacks can reuse anything.
      const snapshot = structuredClone(measurement);
      if (snapshot.seed !== seed) throw new Error('Trial seed metadata changed during simulation');
      cell.push(snapshot);
    }
    all.push(...cell);
    onCell?.(cell);
  }
  return all;
}
