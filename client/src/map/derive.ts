// Static, precomputed map geometry shared by the map modes (computed once at module load).
import type { HqId, NetworkData } from '@fnab/shared';
import { graph, NETWORK } from '../lib/data';
import type { MapLayers } from './layers';

type Hq = NetworkData['headquarters'][number];
type Approach = Hq['approaches'][number];
export type XY = { x: number; y: number };

export const NODE_POS = new Map<string, XY>(NETWORK.nodes.map((n) => [n.id, n.tactical]));
export const NODE_BY_ID = new Map(NETWORK.nodes.map((n) => [n.id, n]));
export const HQ_BY_ID = new Map<HqId, Hq>(NETWORK.headquarters.map((h) => [h.id as HqId, h]));

export function pos(id: string | null | undefined): XY {
  return (id && NODE_POS.get(id)) || { x: 0, y: 0 };
}

export const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Base tactical extent (nodes + HQs) with padding. */
export const BASE_BOX = (() => {
  const xs = [...NETWORK.nodes.map((n) => n.tactical.x), ...NETWORK.headquarters.map((h) => h.tactical.x)];
  const ys = [...NETWORK.nodes.map((n) => n.tactical.y), ...NETWORK.headquarters.map((h) => h.tactical.y)];
  const PAD_X = 46;
  const PAD_Y = 40;
  const minX = Math.min(...xs) - PAD_X;
  const minY = Math.min(...ys) - PAD_Y;
  return { x: minX, y: minY, w: Math.max(...xs) + PAD_X - minX, h: Math.max(...ys) + PAD_Y - minY };
})();

/** Short approach name: "Bayfront Approach (SR-84)" → "Bayfront". */
export function approachShort(ap: Approach): string {
  return ap.label.replace(/\s*\(.*\)\s*/g, '').replace(/\s*Approach\s*$/i, '').trim() || ap.door;
}

/**
 * Door glyph positions around an HQ (map units). Doors sit on a small ring around the HQ marker at the
 * bearing of their approach node, spread apart so they never stack (SF's three approaches all lie to the NE).
 * `u` = map units per screen pixel; the ring radius is in pixels so the layout reads at any zoom.
 */
const doorCache = new Map<string, Map<string, XY & { angle: number }>>();
export function doorLayout(hqId: string, u: number, radiusPx = 30): Map<string, XY & { angle: number }> {
  const key = `${hqId}@${u.toFixed(3)}`;
  const hit = doorCache.get(key);
  if (hit) return hit;
  const h = HQ_BY_ID.get(hqId as HqId);
  const out = new Map<string, XY & { angle: number }>();
  if (!h) return out;
  const items = h.approaches
    .map((ap) => {
      const p = pos(ap.fromNode);
      return { id: ap.id, a: Math.atan2(p.y - h.tactical.y, p.x - h.tactical.x), len: Math.hypot(p.x - h.tactical.x, p.y - h.tactical.y) };
    })
    .sort((x, y) => x.a - y.a);
  const SEP = (62 * Math.PI) / 180;
  for (let it = 0; it < 60; it++) {
    for (let i = 1; i < items.length; i++) {
      const d = items[i]!.a - items[i - 1]!.a;
      if (d < SEP) {
        const push = (SEP - d) / 2;
        items[i - 1]!.a -= push;
        items[i]!.a += push;
      }
    }
  }
  for (const it of items) {
    const r = Math.min(radiusPx * u, it.len * 0.55);
    out.set(it.id, { x: h.tactical.x + Math.cos(it.a) * r, y: h.tactical.y + Math.sin(it.a) * r, angle: it.a });
  }
  if (doorCache.size > 64) doorCache.clear();
  doorCache.set(key, out);
  return out;
}

/** Legacy helper: a point on the HQ → approach-node spoke. */
export function doorPoint(h: Hq, ap: Approach, along = 0.4, maxDist = 52): XY {
  const p = pos(ap.fromNode);
  const dx = p.x - h.tactical.x, dy = p.y - h.tactical.y;
  const len = Math.hypot(dx, dy) || 1;
  const d = Math.min(maxDist, len * along);
  return { x: h.tactical.x + (dx / len) * d, y: h.tactical.y + (dy / len) * d };
}

/** Compact HQ names for small viewports. */
export const HQ_SHORT: Record<string, string> = {
  'hq-stanford': 'Stanford Annex',
  'hq-sf': 'SF Operations',
  'hq-oakland': 'Oakland Port Command',
  'hq-sanjose': 'San Jose Data Vault',
};

function hull(points: XY[]): XY[] {
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: XY, a: XY, b: XY) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: XY[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: XY[] = [];
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Rounded hull (inflated by `r`) around an HQ and its approach nodes: the defended zone. */
function zonePath(h: Hq, r: number): string {
  const pts: XY[] = [];
  const anchors = [h.tactical, ...h.approaches.map((a) => pos(a.fromNode))];
  for (const a of anchors) for (let i = 0; i < 20; i++) pts.push({ x: a.x + Math.cos((i / 20) * 2 * Math.PI) * r, y: a.y + Math.sin((i / 20) * 2 * Math.PI) * r });
  const hp = hull(pts);
  return 'M' + hp.map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join('L') + 'Z';
}

export const HQ_ZONES = new Map<HqId, string>(NETWORK.headquarters.map((h) => [h.id as HqId, zonePath(h, 26)]));

/** Every route name that touches a node (for tooltips). */
export const NODE_ROUTES = new Map<string, string[]>(
  NETWORK.nodes.map((n) => {
    const routes = new Set<string>();
    for (const e of NETWORK.edges) if (e.a === n.id || e.b === n.id) routes.add(e.route.replace(/\s*\(.*\)/, ''));
    return [n.id, [...routes]];
  }),
);

export function monsterXY(m: NonNullable<MapLayers['monster']>): XY | null {
  if (m.moving) {
    const a = pos(m.moving.from);
    const b = pos(m.moving.to);
    return { x: a.x + (b.x - a.x) * m.moving.progress, y: a.y + (b.y - a.y) * m.moving.progress };
  }
  return m.nodeId ? pos(m.nodeId) : null;
}

/** Shortest node paths from `start` to each approach node of `hqId`. */
export function attackPathsFrom(start: string | null, hqId: HqId | null | undefined): Array<{ approachId: string; path: string[] }> {
  if (!start || !hqId) return [];
  const h = HQ_BY_ID.get(hqId);
  if (!h) return [];
  const out: Array<{ approachId: string; path: string[] }> = [];
  for (const ap of h.approaches) {
    const p = start === ap.fromNode ? [start] : graph.shortestPath(start, ap.fromNode);
    if (p) out.push({ approachId: ap.id, path: p });
  }
  return out;
}

/** Hop distance per node to an HQ (memoised per HQ). */
const hopsCache = new Map<HqId, Map<string, number>>();
export function hopsToHq(nodeId: string, hqId: HqId): number {
  let m = hopsCache.get(hqId);
  if (!m) {
    m = new Map(NETWORK.nodes.map((n) => [n.id, graph.hopsToHq(n.id, hqId)]));
    hopsCache.set(hqId, m);
  }
  return m.get(nodeId) ?? 99;
}
