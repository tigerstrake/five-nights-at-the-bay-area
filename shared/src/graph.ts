// Graph helpers over network.json (pure, no deps). Owner: Foundation.
import type { NetworkData, NetworkEdge, NetworkNode, Headquarters, HqId } from './types';

export interface Adjacent {
  to: string;
  edge: NetworkEdge;
}

export class Graph {
  readonly data: NetworkData;
  readonly nodes = new Map<string, NetworkNode>();
  readonly edges = new Map<string, NetworkEdge>();
  readonly adj = new Map<string, Adjacent[]>();
  readonly hqs = new Map<HqId, Headquarters>();
  readonly nodeByCamera = new Map<string, string>();
  private hopCache = new Map<string, Map<string, number>>();

  constructor(data: NetworkData) {
    this.data = data;
    for (const n of data.nodes) {
      this.nodes.set(n.id, n);
      this.adj.set(n.id, []);
      if (n.cameraId) this.nodeByCamera.set(n.cameraId, n.id);
    }
    for (const e of data.edges) {
      if (!this.nodes.has(e.a) || !this.nodes.has(e.b) || e.a === e.b) continue;
      this.edges.set(e.id, e);
      this.adj.get(e.a)!.push({ to: e.b, edge: e });
      this.adj.get(e.b)!.push({ to: e.a, edge: e });
    }
    for (const h of data.headquarters) this.hqs.set(h.id, h);
  }

  node(id: string): NetworkNode {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`unknown node ${id}`);
    return n;
  }

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  neighbors(id: string): string[] {
    return (this.adj.get(id) ?? []).map((a) => a.to);
  }

  edgeBetween(a: string, b: string): NetworkEdge | null {
    return (this.adj.get(a) ?? []).find((x) => x.to === b)?.edge ?? null;
  }

  /** BFS hop distances from a node to every reachable node (cached). */
  hopsFrom(id: string): Map<string, number> {
    let m = this.hopCache.get(id);
    if (m) return m;
    m = new Map([[id, 0]]);
    const q = [id];
    while (q.length) {
      const cur = q.shift()!;
      const d = m.get(cur)!;
      for (const nb of this.neighbors(cur)) {
        if (!m.has(nb)) {
          m.set(nb, d + 1);
          q.push(nb);
        }
      }
    }
    this.hopCache.set(id, m);
    return m;
  }

  hops(a: string, b: string): number {
    return this.hopsFrom(a).get(b) ?? Infinity;
  }

  /** Nodes within `radius` hops of `id` (inclusive of id). */
  within(id: string, radius: number): string[] {
    const out: string[] = [];
    for (const [n, d] of this.hopsFrom(id)) if (d <= radius) out.push(n);
    return out;
  }

  /** Hop distance from a node to the nearest approach node of an HQ. */
  hopsToHq(nodeId: string, hqId: HqId): number {
    const hq = this.hqs.get(hqId);
    if (!hq) return Infinity;
    let best = Infinity;
    const m = this.hopsFrom(nodeId);
    for (const ap of hq.approaches) best = Math.min(best, m.get(ap.fromNode) ?? Infinity);
    return best;
  }

  /** Great-circle distance between two nodes in km. */
  geoKm(a: string, b: string): number {
    const na = this.node(a);
    const nb = this.node(b);
    return haversineKm(na.lat, na.lon, nb.lat, nb.lon);
  }

  isConnected(): boolean {
    const first = this.data.nodes[0];
    if (!first) return true;
    return this.hopsFrom(first.id).size === this.nodes.size;
  }

  /**
   * A* search. `cost(from, to, edge)` must be ≥ 0. `heuristic(node)` must be admissible (never overestimate).
   * Returns the node path including start and goal, or null.
   */
  aStar(
    start: string,
    goal: string | ((id: string) => boolean),
    cost: (from: string, to: string, edge: NetworkEdge) => number,
    heuristic: (id: string) => number = () => 0,
  ): { path: string[]; cost: number } | null {
    const isGoal = typeof goal === 'string' ? (id: string) => id === goal : goal;
    const g = new Map<string, number>([[start, 0]]);
    const came = new Map<string, string>();
    const open = new Set<string>([start]);
    const f = new Map<string, number>([[start, heuristic(start)]]);
    const closed = new Set<string>();
    while (open.size) {
      let cur = '';
      let bestF = Infinity;
      for (const id of open) {
        const v = f.get(id) ?? Infinity;
        if (v < bestF || (v === bestF && id < cur)) {
          bestF = v;
          cur = id;
        }
      }
      if (isGoal(cur)) {
        const path = [cur];
        while (came.has(path[0]!)) path.unshift(came.get(path[0]!)!);
        return { path, cost: g.get(cur)! };
      }
      open.delete(cur);
      closed.add(cur);
      for (const { to, edge } of this.adj.get(cur) ?? []) {
        if (closed.has(to)) continue;
        const c = cost(cur, to, edge);
        if (!Number.isFinite(c)) continue;
        const tentative = g.get(cur)! + c;
        if (tentative < (g.get(to) ?? Infinity)) {
          came.set(to, cur);
          g.set(to, tentative);
          f.set(to, tentative + heuristic(to));
          open.add(to);
        }
      }
    }
    return null;
  }

  /** Shortest path by edge length (km). */
  shortestPath(start: string, goal: string): string[] | null {
    const target = this.nodes.get(goal);
    if (!target) return null;
    return (
      this.aStar(
        start,
        goal,
        (_a, _b, e) => e.lengthKm,
        // Straight-line distance never exceeds road distance for consistent data; scale down for safety.
        (id) => this.geoKm(id, goal) * 0.5,
      )?.path ?? null
    );
  }

  pathLengthKm(path: string[]): number {
    let km = 0;
    for (let i = 1; i < path.length; i++) km += this.edgeBetween(path[i - 1]!, path[i]!)?.lengthKm ?? 0;
    return km;
  }
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Base travel time across an edge before stance/phase multipliers. */
export function edgeTravelMs(
  edge: NetworkEdge,
  cfg: { baseEdgeMs: number; msPerKm: number; minEdgeMs: number; maxEdgeMs: number },
  multiplier = 1,
): number {
  const base = Math.min(cfg.maxEdgeMs, Math.max(cfg.minEdgeMs, cfg.baseEdgeMs + edge.lengthKm * cfg.msPerKm));
  return Math.round(base * multiplier);
}

/**
 * Nodes the monster may spawn on for a given HQ: hop distance to the HQ within [minHops, maxHops].
 * Falls back to the farthest reachable nodes if the band is empty. Sorted by id (deterministic).
 */
export function spawnCandidates(graph: Graph, hqId: HqId, cfg: { minHopsFromHq: number; maxHopsFromHq: number }): string[] {
  const all = [...graph.nodes.keys()].map((id) => ({ id, h: graph.hopsToHq(id, hqId) })).filter((x) => Number.isFinite(x.h));
  let pick = all.filter((x) => x.h >= cfg.minHopsFromHq && x.h <= cfg.maxHopsFromHq);
  if (!pick.length) {
    const max = Math.max(...all.map((x) => x.h));
    pick = all.filter((x) => x.h === max);
  }
  return pick.map((x) => x.id).sort();
}
