import { DEFAULT_TACTICAL_AI, edgeTravelMs, type Graph, type NetworkEdge, type TacticalAiConfig } from '@fnab/shared';
import type { BrainInput } from './types';

export interface Plan { path: string[]; cost: number }
export interface NodeRisk { camera: number; sensors: number; danger: number; recent: number }

export function tacticalConfig(input: BrainInput): TacticalAiConfig {
  return { ...DEFAULT_TACTICAL_AI, ...input.cfg.monster.tactical };
}

interface TravelTable {
  ids: string[];
  index: Map<string, number>;
  distances: Float64Array[];
  edges: Map<string, number>;
}

// Only immutable public topology/travel costs are cached across decisions, never defender state.
const travelCache = new WeakMap<Graph, Map<string, TravelTable>>();

function travelTable(input: BrainInput): TravelTable {
  const { graph, cfg, knowledge: k } = input;
  const m = cfg.monster;
  const speed = m.stanceSpeed[k.stance] * m.phaseSpeed[k.phase];
  const key = [m.baseEdgeMs, m.msPerKm, m.minEdgeMs, m.maxEdgeMs, speed].join(':');
  let cache = travelCache.get(graph);
  if (!cache) travelCache.set(graph, cache = new Map());
  const hit = cache.get(key);
  if (hit) return hit;
  const ids = [...graph.nodes.keys()];
  const index = new Map(ids.map((id, i) => [id, i]));
  const distances = ids.map((_, i) => Float64Array.from(ids, (_id, j) => i === j ? 0 : Infinity));
  const edges = new Map<string, number>();
  for (const e of graph.edges.values()) {
    const time = edgeTravelMs(e, m, speed);
    edges.set(e.id, time);
    const a = index.get(e.a)!, b = index.get(e.b)!;
    distances[a][b] = distances[b][a] = Math.min(distances[a][b], time);
  }
  // Exact travel-only distances are a consistent, admissible A* lower bound even with clamped edges.
  // Geography is NOT admissible once long edges have clamped travel times.
  for (let via = 0; via < ids.length; via++)
    for (let a = 0; a < ids.length; a++)
      for (let b = 0; b < ids.length; b++)
        distances[a][b] = Math.min(distances[a][b], distances[a][via] + distances[via][b]);
  const table = { ids, index, distances, edges };
  // Custom configs cannot grow a graph's cache without bound.
  if (cache.size >= Object.keys(m.stanceSpeed).length * Object.keys(m.phaseSpeed).length) cache.clear();
  cache.set(key, table);
  return table;
}

export interface PlannerOptions { obviousNodes?: ReadonlySet<string> }

/** One decision's deterministic costs, shared by every candidate search. No RNG during A*. */
export class TacticalPlanner {
  readonly risks = new Map<string, NodeRisk>();
  readonly tuning: TacticalAiConfig;
  readonly aggression: number;
  private readonly travel: TravelTable;
  private readonly plans = new Map<string, Plan | null>();

  constructor(readonly input: BrainInput, readonly options: PlannerOptions = {}) {
    const { graph, cfg, knowledge: k } = input;
    const c = this.tuning = tacticalConfig(input);
    const horizon = cfg.monster.maxEdgeMs * cfg.threat.horizonHops;
    const urgency = 1 - Math.min(1, Math.max(0, k.remainingMs ?? horizon) / horizon);
    this.aggression = Math.max(c.minimumAggression, input.aggression) * (1 + urgency);
    this.travel = travelTable(input);
    const recent = new Map(k.recentNodes.map((n, i) => [n, (i + 1) / k.recentNodes.length]));
    const age = (t: number) => Math.max(0, 1 - Math.max(0, k.t - t) / cfg.visibility.monsterMemoryMs);
    for (const id of graph.nodes.keys()) {
      const working = (n: string) => k.cameraStatusByNode[n] === 'ok' || k.cameraStatusByNode[n] === 'repairing';
      const near = graph.neighbors(id);
      const camera = (working(id) ? 1 : 0) + near.filter(working).length * c.cameraNeighborExposure;
      let sensors = 0, danger = 0;
      for (const s of k.knownSensors) {
        if (!s.disabled && graph.hops(id, s.nodeId) <= 1)
          sensors += c.sensorExposure * (s.nodeId === id ? 1 : c.sensorNeighborWeight);
      }
      for (const x of k.exposures) {
        const hops = graph.hops(id, x.nodeId);
        if (hops <= 1) danger += age(x.t) * c.dangerWeights.sighted * (hops === 0 ? 1 : c.dangerNeighborWeight);
      }
      for (const x of k.scanPulses) {
        const hops = graph.hops(id, x.nodeId);
        if (hops <= cfg.scan.radiusHops + 1)
          danger += age(x.t) * c.dangerWeights.scanned * (hops <= cfg.scan.radiusHops ? 1 : c.dangerNeighborWeight);
      }
      for (const x of k.trapEncounters ?? []) {
        const hops = graph.hops(id, x.nodeId);
        if (hops <= 1) danger += age(x.t) * c.dangerWeights.trapped * (hops === 0 ? 1 : c.dangerNeighborWeight);
      }
      this.risks.set(id, { camera, sensors, danger, recent: recent.get(id) ?? 0 });
    }
  }

  risk(node: string): NodeRisk { return this.risks.get(node) ?? { camera: 0, sensors: 0, danger: 0, recent: 0 }; }

  exposure(node: string): number {
    const r = this.risk(node);
    return r.camera + r.sensors + r.danger;
  }

  travelMs(a: string, b: string): number {
    const ai = this.travel.index.get(a), bi = this.travel.index.get(b);
    return ai === undefined || bi === undefined ? Infinity : this.travel.distances[ai][bi];
  }

  edgeCost = (_from: string, to: string, edge: NetworkEdge): number => {
    const { knowledge: k } = this.input;
    const c = this.tuning, r = this.risk(to);
    const stealth = k.stance === 'HIDE' || k.stance === 'RETREAT';
    const caution = c.stanceExposure[k.stance] / (stealth ? 1 : this.aggression);
    // ATTACK accepts surveillance but retains a credible aversion to remembered traps.
    const danger = k.stance === 'ATTACK' ? r.danger / this.aggression : caution * r.danger;
    const diversity = k.stance === 'FLANK'
      ? (r.recent * c.recentPathPenalty + (this.options.obviousNodes?.has(to) ? c.obviousPathPenalty : 0)) / this.aggression
      : 0;
    return this.travel.edges.get(edge.id)! + c.exposureMs * (caution * (r.camera + r.sensors) + danger + diversity);
  };

  /** Supports continuing or reversing mid-edge; the prefix accounts for fractional travel. */
  plan(goal: string): Plan | null {
    if (this.plans.has(goal)) return this.plans.get(goal)!;
    const { graph, knowledge: k } = this.input;
    const search = (start: string) => graph.has(start) && graph.has(goal) && Number.isFinite(this.travelMs(start, goal))
      ? graph.aStar(start, goal, this.edgeCost, (n) => this.travelMs(n, goal)) : null;
    const moving = k.position.moving;
    let result: Plan | null;
    if (moving) {
      const time = this.travel.edges.get(moving.edgeId), edge = graph.edges.get(moving.edgeId);
      if (time === undefined || !edge) return null;
      const progress = Math.max(0, Math.min(1, moving.progress));
      const forward = search(moving.to), back = search(moving.from);
      const a = forward ? { path: forward.path, cost: forward.cost + time * (1 - progress)
        + this.edgeCost(moving.from, moving.to, edge) - time } : null;
      const b = back ? { path: back.path, cost: back.cost + time * progress
        + this.edgeCost(moving.to, moving.from, edge) - time } : null;
      result = a && (!b || a.cost <= b.cost) ? a : b;
    } else result = k.position.nodeId ? search(k.position.nodeId) : null;
    this.plans.set(goal, result);
    return result;
  }
}
