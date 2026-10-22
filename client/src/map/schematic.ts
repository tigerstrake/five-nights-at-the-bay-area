// Schematic ("freeway transit map") geometry for the tactical map. Pure data + maths, no React, so the
// shoreline build script (tools/build-shore.mjs, run with tsx) and the tests use exactly what is drawn.
//
// Every graph edge is drawn as an octilinear corridor (0/45/90°) between its nodes' hand-placed `tactical`
// positions, routed by the hints in corridors.json and rounded at the bends. Corridors carry their route
// identity (I-80, US-101, SR-92, a named street…) so the map can draw each freeway as one consistent line
// with shields, and expose helpers to walk along them (monster interpolation, planned routes, tripwires).
import { NETWORK } from '@fnab/shared';
import corridorsJson from './corridors.json';

export type XY = { x: number; y: number };
type Hint = 's' | 'd' | 'm' | number[][];

const HINTS = corridorsJson.hints as Record<string, Hint>;
export const CORNER_RADIUS = corridorsJson.radius;

// ---------------------------------------------------------------------------------------------------------
// Routes

export type RouteClass = 'interstate' | 'us' | 'state' | 'street';
export interface RouteInfo {
  /** Stable key: "I-80", "US-101", "SR-92", or a street name. */
  key: string;
  cls: RouteClass;
  /** Shield number ("80"), null for streets. */
  num: string | null;
}

/** Edges whose route string is ambiguous ("I-580 / I-80") or names a numbered road as a street. */
const ROUTE_OVERRIDE: Record<string, string> = {
  'e-sr37--san-rafael': 'SR-37',
  'e-richmond-580--san-pablo': 'I-580',
  'e-univ-84--willow-101': 'University Ave',
  'e-el-camino-emb--sj-alameda': 'SR-82',
  'e-sj-alameda--sj-i280': 'I-880',
  'e-bay-bridge-sf--octavia': 'Market St',
  'e-embarcadero-101--el-camino-emb': 'Embarcadero Rd',
  'e-280-canada--el-camino-emb': 'Sand Hill Rd',
};

export function routeInfo(key: string): RouteInfo {
  const m = /^(I|US|SR)-(\d+)$/.exec(key);
  if (!m) return { key, cls: 'street', num: null };
  return { key, cls: m[1] === 'I' ? 'interstate' : m[1] === 'US' ? 'us' : 'state', num: m[2]! };
}

function routeKeyOf(e: (typeof NETWORK.edges)[number]): string {
  const o = ROUTE_OVERRIDE[e.id];
  if (o) return o;
  const m = /\b(I|US|SR)-(\d+)\b/.exec(e.route);
  return m ? `${m[1]}-${m[2]}` : e.route;
}

/** Display order of numbered routes (also the palette order in theme.ts). */
export const ROUTE_KEYS = [
  'I-80', 'US-101', 'I-880', 'I-280', 'I-580', 'I-680', 'SR-24', 'SR-92', 'SR-84', 'SR-37', 'I-780', 'I-980', 'SR-82',
] as const;

/** Bridge names for span labels (only bridges whose camera node is not already named after them). */
export const BRIDGE_LABEL: Record<string, string> = {
  'Golden Gate Bridge': 'Golden Gate',
  'San Francisco-Oakland Bay Bridge': 'Bay Bridge',
  'Benicia-Martinez Bridge': 'Benicia Br.',
};

// ---------------------------------------------------------------------------------------------------------
// Node labels: map-sized names (the tooltip / inspector keep the full camera names) and preferred sides.

/** 0 = E, 1 = SE, 2 = S, 3 = SW, 4 = W, 5 = NW, 6 = N, 7 = NE (screen directions). */
type Dir = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export interface NodeLabelSpec {
  text: string;
  /** Fallback when space is short. */
  short?: string;
  dir: Dir;
}
export const NODE_LABEL: Record<string, NodeLabelSpec> = {
  'n-sr37': { text: 'Sonoma Marsh', short: 'Sonoma', dir: 4 },
  'n-vallejo': { text: 'Vallejo', dir: 6 },
  'n-benicia': { text: 'Benicia', dir: 0 },
  'n-carquinez': { text: 'Carquinez', dir: 0 },
  'n-san-rafael': { text: 'San Rafael', dir: 4 },
  'n-rsr-bridge': { text: 'Richmond–San Rafael Br.', short: 'RSR Bridge', dir: 2 },
  'n-richmond-580': { text: 'Richmond', dir: 2 },
  'n-san-pablo': { text: 'San Pablo', dir: 0 },
  'n-marin-city': { text: 'Marin City', dir: 0 },
  'n-spencer': { text: 'Waldo Grade', short: 'Waldo', dir: 0 },
  'n-gg-north': { text: 'Vista Point', dir: 0 },
  'n-ashby': { text: 'Berkeley', dir: 0 },
  'n-caldecott': { text: 'Caldecott', dir: 4 },
  'n-walnut-creek': { text: 'Walnut Creek', short: 'Walnut Ck', dir: 4 },
  'n-maze': { text: 'MacArthur Maze', short: 'Maze', dir: 7 },
  'n-oak-980': { text: 'SR-24 / I-980', short: 'I-980', dir: 7 },
  'n-oak-880': { text: 'Broadway', dir: 0 },
  'n-bay-bridge-east': { text: 'East Span', dir: 2 },
  'n-bay-bridge-west': { text: 'West Span', dir: 6 },
  'n-bay-bridge-sf': { text: 'Bay Br. Approach', short: 'Br. Approach', dir: 0 },
  'n-octavia': { text: 'Octavia', dir: 4 },
  'n-soma-split': { text: 'SoMa', dir: 0 },
  'n-us101-alemany': { text: 'Alemany', dir: 0 },
  'n-hayward-238': { text: 'Hayward', dir: 0 },
  'n-sm-bridge': { text: 'San Mateo Br.', short: 'SM Bridge', dir: 0 },
  'n-hillsdale': { text: 'Hillsdale', dir: 7 },
  'n-280-canada': { text: 'Cañada Rd', dir: 4 },
  'n-fremont-84': { text: 'Fremont', dir: 0 },
  'n-dumbarton': { text: 'Dumbarton Br.', short: 'Dumbarton', dir: 2 },
  'n-univ-84': { text: 'University Av', short: 'Univ. Av', dir: 6 },
  'n-willow-101': { text: 'Willow Rd', dir: 6 },
  'n-embarcadero-101': { text: 'Embarcadero Rd', short: 'Embarcadero', dir: 1 },
  'n-el-camino-emb': { text: 'El Camino', dir: 1 },
  'n-sj-880-101': { text: 'SJ 101 / 880', short: 'SJ 101', dir: 0 },
  'n-sj-alameda': { text: 'The Alameda', short: 'Alameda', dir: 0 },
  'n-sj-i280': { text: 'SJ 280 / 880', short: 'SJ 280', dir: 2 },
};
export const DIR_ANGLE = (d: Dir) => (d * Math.PI) / 4;

export function nodeLabel(id: string): NodeLabelSpec {
  return NODE_LABEL[id] ?? { text: NETWORK.nodes.find((n) => n.id === id)?.name ?? id, dir: 6 };
}

// ---------------------------------------------------------------------------------------------------------
// Corridor routing

/** Octilinear corner points from a to b (inclusive). */
export function corridorCorners(a: XY, b: XY, hint: Hint | undefined): XY[] {
  if (Array.isArray(hint)) return [a, ...hint.map(([x, y]) => ({ x: x!, y: y! })), b];
  const dx = b.x - a.x, dy = b.y - a.y;
  const adx = Math.abs(dx), ady = Math.abs(dy);
  const d = Math.min(adx, ady);
  const sx = Math.sign(dx), sy = Math.sign(dy);
  if (d < 0.5 || Math.abs(adx - ady) < 0.5) return [a, b]; // already straight or diagonal
  if (hint === 'd') return [a, { x: a.x + sx * d, y: a.y + sy * d }, b];
  if (hint === 'm') {
    const ex = adx > ady ? ((adx - d) / 2) * sx : 0;
    const ey = ady > adx ? ((ady - d) / 2) * sy : 0;
    return [a, { x: a.x + ex, y: a.y + ey }, { x: b.x - ex, y: b.y - ey }, b];
  }
  return [a, { x: b.x - sx * d, y: b.y - sy * d }, b];
}

export interface Corridor {
  id: string;
  a: string;
  b: string;
  kind: 'freeway' | 'bridge' | 'surface' | 'tunnel';
  route: RouteInfo;
  /** Raw route string from network.json. */
  routeName: string;
  lengthKm: number;
  corners: XY[];
  /** Flattened polyline (rounded corners sampled), a → b. */
  pts: XY[];
  /** Cumulative length at each point. */
  cum: number[];
  len: number;
  /** SVG path a → b with rounded corners. */
  d: string;
}

const f1 = (v: number) => Math.round(v * 10) / 10;

/** Rounded path + flattened polyline through corner points. */
export function roundCorners(corners: XY[], radius = CORNER_RADIUS): { d: string; pts: XY[] } {
  if (corners.length < 3) {
    const [a, b] = [corners[0]!, corners[corners.length - 1]!];
    return { d: `M${f1(a.x)} ${f1(a.y)}L${f1(b.x)} ${f1(b.y)}`, pts: [a, b] };
  }
  const pts: XY[] = [corners[0]!];
  let d = `M${f1(corners[0]!.x)} ${f1(corners[0]!.y)}`;
  for (let i = 1; i < corners.length - 1; i++) {
    const p = corners[i]!, a = corners[i - 1]!, b = corners[i + 1]!;
    const la = Math.hypot(a.x - p.x, a.y - p.y), lb = Math.hypot(b.x - p.x, b.y - p.y);
    // half of each neighbouring leg (interior legs are shared by two corners)
    const r = Math.min(radius, la / 2, lb / 2);
    const p1 = { x: p.x + ((a.x - p.x) / la) * r, y: p.y + ((a.y - p.y) / la) * r };
    const p2 = { x: p.x + ((b.x - p.x) / lb) * r, y: p.y + ((b.y - p.y) / lb) * r };
    d += `L${f1(p1.x)} ${f1(p1.y)}Q${f1(p.x)} ${f1(p.y)} ${f1(p2.x)} ${f1(p2.y)}`;
    pts.push(p1);
    for (let k = 1; k < 6; k++) {
      const t = k / 6, u = 1 - t;
      pts.push({ x: u * u * p1.x + 2 * u * t * p.x + t * t * p2.x, y: u * u * p1.y + 2 * u * t * p.y + t * t * p2.y });
    }
    pts.push(p2);
  }
  const z = corners[corners.length - 1]!;
  d += `L${f1(z.x)} ${f1(z.y)}`;
  pts.push(z);
  return { d, pts };
}

function cumulative(pts: XY[]): number[] {
  const c = [0];
  for (let i = 1; i < pts.length; i++) c.push(c[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y));
  return c;
}

export function buildCorridors(
  pos: (id: string) => XY,
  edges: ReadonlyArray<(typeof NETWORK.edges)[number]> = NETWORK.edges,
): Map<string, Corridor> {
  const out = new Map<string, Corridor>();
  for (const e of edges) {
    const corners = corridorCorners(pos(e.a), pos(e.b), HINTS[e.id]);
    const { d, pts } = roundCorners(corners);
    const cum = cumulative(pts);
    out.set(e.id, {
      id: e.id,
      a: e.a,
      b: e.b,
      kind: e.kind,
      route: routeInfo(routeKeyOf(e)),
      routeName: e.route,
      lengthKm: e.lengthKm,
      corners,
      pts,
      cum,
      len: cum[cum.length - 1]!,
      d,
    });
  }
  return out;
}

const NODE_XY = new Map<string, XY>(NETWORK.nodes.map((n) => [n.id, n.tactical]));
const nodeXY = (id: string): XY => NODE_XY.get(id) ?? { x: 0, y: 0 };

/** Corridors over the bundled network (computed once). */
export const CORRIDORS: Map<string, Corridor> = buildCorridors(nodeXY);
const BY_PAIR = new Map<string, Corridor>();
for (const c of CORRIDORS.values()) {
  BY_PAIR.set(`${c.a}|${c.b}`, c);
  BY_PAIR.set(`${c.b}|${c.a}`, c);
}

/** The corridor between two adjacent nodes, and whether it runs b → a in that order. */
export function corridorBetween(from: string, to: string): { c: Corridor; rev: boolean } | null {
  const c = BY_PAIR.get(`${from}|${to}`);
  return c ? { c, rev: c.a !== from } : null;
}

/** Point (and heading) at fraction t along the corridor, measured from `from`. */
export function pointAlong(from: string, to: string, t: number): (XY & { angle: number }) | null {
  const hit = corridorBetween(from, to);
  if (!hit) return null;
  const { c, rev } = hit;
  const s = Math.min(1, Math.max(0, rev ? 1 - t : t)) * c.len;
  let lo = 0, hi = c.cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (c.cum[mid]! < s) lo = mid;
    else hi = mid;
  }
  const a = c.pts[lo]!, b = c.pts[hi]!;
  const seg = c.cum[hi]! - c.cum[lo]! || 1;
  const k = (s - c.cum[lo]!) / seg;
  const ang = Math.atan2(b.y - a.y, b.x - a.x) + (rev ? Math.PI : 0);
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, angle: ang };
}

/** Polyline points of the corridor from `from` to `to`, clipped to fractions [t0, t1] (measured from `from`). */
export function corridorPoints(from: string, to: string, t0 = 0, t1 = 1): XY[] {
  const hit = corridorBetween(from, to);
  if (!hit) return [];
  const { c, rev } = hit;
  const pts = rev ? [...c.pts].reverse() : c.pts;
  const cum = rev ? c.cum.map((v) => c.len - v).reverse() : c.cum;
  const s0 = Math.max(0, Math.min(t0, t1)) * c.len, s1 = Math.min(1, Math.max(t0, t1)) * c.len;
  const out: XY[] = [];
  const lerp = (i: number, s: number): XY => {
    const a = pts[i]!, b = pts[i + 1]!;
    const k = (s - cum[i]!) / (cum[i + 1]! - cum[i]! || 1);
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
  };
  for (let i = 0; i < pts.length - 1; i++) {
    if (cum[i + 1]! < s0 || cum[i]! > s1) continue;
    if (!out.length) out.push(cum[i]! >= s0 ? pts[i]! : lerp(i, s0));
    if (cum[i + 1]! <= s1) out.push(pts[i + 1]!);
    else {
      out.push(lerp(i, s1));
      break;
    }
  }
  return out;
}

export function pointsToD(pts: XY[]): string {
  return pts.length ? 'M' + pts.map((p) => `${f1(p.x)} ${f1(p.y)}`).join('L') : '';
}

/** One continuous polyline through a node path, following the corridors (straight hop when not adjacent). */
export function pathPoints(ids: readonly string[]): XY[] {
  const out: XY[] = [];
  for (let i = 0; i < ids.length - 1; i++) {
    const seg = corridorPoints(ids[i]!, ids[i + 1]!);
    const pts = seg.length ? seg : [nodeXY(ids[i]!), nodeXY(ids[i + 1]!)];
    out.push(...(out.length ? pts.slice(1) : pts));
  }
  if (!out.length && ids.length === 1) out.push(nodeXY(ids[0]!));
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Route chains (for shields) and per-node route sets

/** Every numbered route that touches a node, in display order. */
export const NODE_ROUTE_KEYS = new Map<string, string[]>(
  NETWORK.nodes.map((n) => {
    const s = new Set<string>();
    for (const c of CORRIDORS.values()) if ((c.a === n.id || c.b === n.id) && c.route.cls !== 'street') s.add(c.route.key);
    return [n.id, [...s].sort((a, b) => ROUTE_KEYS.indexOf(a as never) - ROUTE_KEYS.indexOf(b as never))];
  }),
);

export interface ShieldSpot extends XY {
  route: RouteInfo;
  /** Corridor the shield sits on. */
  edge: string;
  /** Fallback positions (other straight runs of the same route), best first. */
  alts: Array<XY & { edge: string }>;
}

/**
 * Shield positions: one per route on its longest straight run (fallbacks: the next runs), plus a second
 * far from the first on long routes. Runs near an HQ keep are skipped (the keep and its gates live there).
 */
export const SHIELD_SPOTS: ShieldSpot[] = (() => {
  const byRoute = new Map<string, Corridor[]>();
  for (const c of CORRIDORS.values()) if (c.route.cls !== 'street') (byRoute.get(c.route.key) ?? byRoute.set(c.route.key, []).get(c.route.key)!).push(c);
  const nearHq = (p: XY, r: number) => NETWORK.headquarters.some((h) => Math.hypot(h.tactical.x - p.x, h.tactical.y - p.y) < r);
  const runs = (c: Corridor, hqClear = 62) => {
    const out: Array<XY & { len: number; edge: string }> = [];
    for (let i = 0; i < c.corners.length - 1; i++) {
      const a = c.corners[i]!, b = c.corners[i + 1]!;
      const len = Math.hypot(b.x - a.x, b.y - a.y) - (i > 0 ? CORNER_RADIUS : 0) - (i < c.corners.length - 2 ? CORNER_RADIUS : 0);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (len >= 34 && !nearHq(mid, hqClear)) out.push({ ...mid, len, edge: c.id });
    }
    return out;
  };
  const spots: ShieldSpot[] = [];
  for (const key of ROUTE_KEYS) {
    const cs = byRoute.get(key);
    if (!cs) continue;
    const plain = cs.filter((c) => c.kind !== 'bridge' && c.kind !== 'tunnel');
    let all = plain.flatMap((c) => runs(c));
    if (!all.length) all = cs.flatMap((c) => runs(c));
    if (!all.length) all = cs.flatMap((c) => runs(c, 20)); // short downtown routes (I-980) sit by a keep
    all.sort((p, q) => q.len - p.len);
    const first = all[0];
    if (!first) continue;
    const route = cs[0]!.route;
    spots.push({ x: first.x, y: first.y, route, edge: first.edge, alts: all.slice(1, 4) });
    const total = cs.reduce((s, c) => s + c.len, 0);
    if (total > 420) {
      const far = all.filter((p) => Math.hypot(p.x - first.x, p.y - first.y) > 260 && p.len > 46);
      if (far[0]) spots.push({ x: far[0].x, y: far[0].y, route, edge: far[0].edge, alts: far.slice(1, 3) });
    }
  }
  return spots;
})();

// ---------------------------------------------------------------------------------------------------------
// Cartographic notes: water bodies, bridge names, regions (dropped when they would collide).

export interface MapNote {
  id: string;
  text: string;
  x: number;
  y: number;
  kind: 'water' | 'bridge' | 'region';
  /** Degrees. */
  rotate?: number;
  /** Lower = dropped first. */
  priority: number;
}
export const MAP_NOTES: MapNote[] = [
  { id: 'w-sfbay', text: 'San Francisco Bay', x: 420, y: 662, kind: 'water', priority: 6 },
  { id: 'w-sanpablo', text: 'San Pablo Bay', x: 420, y: 118, kind: 'water', priority: 5 },
  { id: 'w-pacific', text: 'Pacific Ocean', x: 96, y: 640, kind: 'water', rotate: -90, priority: 4 },
  { id: 'w-suisun', text: 'Suisun Bay', x: 870, y: 120, kind: 'water', priority: 2 },
  { id: 'b-goldengate', text: 'Golden Gate', x: 184, y: 445, kind: 'bridge', rotate: -90, priority: 7 },
  { id: 'b-baybridge', text: 'Bay Bridge', x: 435, y: 404, kind: 'bridge', priority: 7 },
  { id: 'r-marin', text: 'Marin', x: 120, y: 300, kind: 'region', priority: 3 },
  { id: 'r-eastbay', text: 'East Bay', x: 690, y: 560, kind: 'region', priority: 3 },
  { id: 'r-peninsula', text: 'Peninsula', x: 205, y: 650, kind: 'region', rotate: -90, priority: 3 },
  { id: 'r-southbay', text: 'South Bay', x: 600, y: 955, kind: 'region', priority: 2 },
];
