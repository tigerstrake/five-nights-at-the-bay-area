#!/usr/bin/env node
// Build the tactical-map coastline: the real Natural Earth shoreline, warped into tactical space.
//
//   npx tsx client/src/map/tools/build-shore.mjs [--ne <ne_10m_land.geojson>] [--json <debug.json>]
//
// Source: Natural Earth 1:10m Land (public domain, naturalearthdata.com — "Made with Natural Earth").
// Without --ne the file is downloaded once into $TMPDIR; only the warped, simplified result is committed.
//
// Pipeline
//  1. Thin-plate spline fitted on every camera node (real lon/lat in local km → its hand-placed `tactical`
//     position), plus the shore anchors in shore-anchors.json and a far ring of affine anchors that keeps the
//     extrapolation sane. Rings are densified before warping so straight source segments bend with the warp.
//  2. The warped land is rasterised (1 tactical unit per cell) and "guarded": every non-bridge corridor and
//     node gets a strip of land, every HQ a pad, and the hand strokes in shore-anchors.json open straits that
//     the 1:10m data closes at this magnification (Golden Gate, Carquinez). Specks and enclosed ponds go.
//  3. A light blur + marching squares trace the shore, then Douglas-Peucker + Chaikin give a clean silhouette.
// Output: client/src/map/shore.gen.ts (land rings, SVG path, bridge-over-water spans, layout signature).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CORRIDORS } from '../schematic.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../..');
const arg = (k) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const NE_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_land.geojson';
const OUT = arg('--out') ?? resolve(HERE, '../shore.gen.ts');

const net = JSON.parse(readFileSync(resolve(ROOT, 'shared/src/data/network.json'), 'utf8'));
const cfg = JSON.parse(readFileSync(resolve(HERE, 'shore-anchors.json'), 'utf8'));

// ---- real → local km (y grows southward like tactical)
const LAT0 = 37.75, LON0 = -122.3;
const KX = 111.32 * Math.cos((LAT0 * Math.PI) / 180), KY = 110.57;
const km = (lon, lat) => [(lon - LON0) * KX, (LAT0 - lat) * KY];

// ---- linear algebra
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c];
    if (Math.abs(d) < 1e-12) throw new Error('singular system');
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}
function fitAffine(src, dst) {
  // least squares [x y 1] → x', y'
  const AtA = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], Atx = [0, 0, 0], Aty = [0, 0, 0];
  for (let i = 0; i < src.length; i++) {
    const r = [src[i][0], src[i][1], 1];
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) AtA[a][b] += r[a] * r[b];
      Atx[a] += r[a] * dst[i][0];
      Aty[a] += r[a] * dst[i][1];
    }
  }
  const cx = solve(AtA, Atx), cy = solve(AtA, Aty);
  return (p) => [cx[0] * p[0] + cx[1] * p[1] + cx[2], cy[0] * p[0] + cy[1] * p[1] + cy[2]];
}
const U = (r2) => (r2 < 1e-12 ? 0 : 0.5 * r2 * Math.log(r2));
function fitTps(src, dst) {
  const n = src.length, N = n + 3;
  const A = Array.from({ length: N }, () => new Array(N).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const dx = src[i][0] - src[j][0], dy = src[i][1] - src[j][1];
      A[i][j] = U(dx * dx + dy * dy);
    }
    A[i][n] = A[n][i] = 1;
    A[i][n + 1] = A[n + 1][i] = src[i][0];
    A[i][n + 2] = A[n + 2][i] = src[i][1];
  }
  const wx = solve(A, [...dst.map((d) => d[0]), 0, 0, 0]);
  const wy = solve(A, [...dst.map((d) => d[1]), 0, 0, 0]);
  return (p) => {
    let x = wx[n] + wx[n + 1] * p[0] + wx[n + 2] * p[1];
    let y = wy[n] + wy[n + 1] * p[0] + wy[n + 2] * p[1];
    for (let i = 0; i < n; i++) {
      const dx = p[0] - src[i][0], dy = p[1] - src[i][1];
      const u = U(dx * dx + dy * dy);
      x += wx[i] * u;
      y += wy[i] * u;
    }
    return [x, y];
  };
}

const src = [], dst = [];
for (const n of net.nodes) {
  src.push(km(n.lon, n.lat));
  dst.push([n.tactical.x, n.tactical.y]);
}
const affine = fitAffine(src, dst);
for (const a of cfg.anchors) {
  src.push(km(a.lon, a.lat));
  dst.push([a.x, a.y]);
}
for (let i = 0; i < 20; i++) {
  const t = (i / 20) * 2 * Math.PI;
  const p = [Math.cos(t) * 150, Math.sin(t) * 150 + 20];
  src.push(p);
  dst.push(affine(p));
}
const warp = fitTps(src, dst);

// ---- Natural Earth land, clipped to a box comfortably larger than the raster's warped footprint
async function loadNe() {
  const p = arg('--ne') ?? resolve(tmpdir(), 'fnab-ne_10m_land.geojson');
  if (!existsSync(p)) {
    console.log('downloading', NE_URL);
    const r = await fetch(NE_URL);
    if (!r.ok) throw new Error(`Natural Earth download failed: HTTP ${r.status}`);
    writeFileSync(p, Buffer.from(await r.arrayBuffer()));
  }
  return JSON.parse(readFileSync(p, 'utf8'));
}
const BB = { w: -123.6, e: -120.9, s: 36.6, n: 38.9 };
function clipRing(ring) {
  let pts = ring;
  const inside = [(p) => p[0] >= BB.w, (p) => p[0] <= BB.e, (p) => p[1] >= BB.s, (p) => p[1] <= BB.n];
  const cut = [
    (a, b) => [BB.w, a[1] + ((BB.w - a[0]) / (b[0] - a[0])) * (b[1] - a[1])],
    (a, b) => [BB.e, a[1] + ((BB.e - a[0]) / (b[0] - a[0])) * (b[1] - a[1])],
    (a, b) => [a[0] + ((BB.s - a[1]) / (b[1] - a[1])) * (b[0] - a[0]), BB.s],
    (a, b) => [a[0] + ((BB.n - a[1]) / (b[1] - a[1])) * (b[0] - a[0]), BB.n],
  ];
  for (let k = 0; k < 4; k++) {
    const res = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const ia = inside[k](a), ib = inside[k](b);
      if (ia) res.push(a);
      if (ia !== ib) res.push(cut[k](a, b));
    }
    pts = res;
  }
  return pts;
}
function densify(ring, step) {
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

const ne = await loadNe();
const warpedRings = [];
for (const f of ne.features) {
  const g = f.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  for (const poly of polys)
    for (const ring of poly) {
      if (!ring.some(([x, y]) => x >= BB.w && x <= BB.e && y >= BB.s && y <= BB.n)) continue;
      const c = clipRing(ring);
      if (c.length > 2) warpedRings.push(densify(c.map(([lon, lat]) => km(lon, lat)), 0.25).map(warp));
    }
}

// ---- raster
const X0 = -400, Y0 = -400, GW = 1800, GH = 1800; // 1 unit per cell
const grid = new Uint8Array(GW * GH); // 1 = land
function fillRings(rings) {
  const xs = [];
  for (let gy = 0; gy < GH; gy++) {
    const y = Y0 + gy + 0.5;
    xs.length = 0;
    for (const r of rings)
      for (let i = 0; i < r.length; i++) {
        const a = r[i], b = r[(i + 1) % r.length];
        if (a[1] <= y !== b[1] <= y) xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const g0 = Math.max(0, Math.ceil(xs[k] - X0 - 0.5)), g1 = Math.min(GW - 1, Math.floor(xs[k + 1] - X0 - 0.5));
      for (let gx = g0; gx <= g1; gx++) grid[gy * GW + gx] ^= 1;
    }
  }
}
fillRings(warpedRings);

function stampSegment(a, b, r, val) {
  const minx = Math.max(0, Math.floor(Math.min(a.x, b.x) - r - X0)), maxx = Math.min(GW - 1, Math.ceil(Math.max(a.x, b.x) + r - X0));
  const miny = Math.max(0, Math.floor(Math.min(a.y, b.y) - r - Y0)), maxy = Math.min(GH - 1, Math.ceil(Math.max(a.y, b.y) + r - Y0));
  const vx = b.x - a.x, vy = b.y - a.y, l2 = vx * vx + vy * vy || 1e-9;
  for (let gy = miny; gy <= maxy; gy++)
    for (let gx = minx; gx <= maxx; gx++) {
      const px = gx + X0 + 0.5, py = gy + Y0 + 0.5;
      const t = Math.max(0, Math.min(1, ((px - a.x) * vx + (py - a.y) * vy) / l2));
      if (Math.hypot(px - (a.x + t * vx), py - (a.y + t * vy)) <= r) grid[gy * GW + gx] = val;
    }
}
const stampPolyline = (pts, r, val) => {
  for (let i = 0; i < pts.length - 1; i++) stampSegment(pts[i], pts[i + 1], r, val);
  if (pts.length === 1) stampSegment(pts[0], pts[0], r, val);
};

// water strokes first (open straits), then land guards win
for (const s of cfg.water ?? []) stampPolyline(s.pts.map(([x, y]) => ({ x, y })), s.r, 0);
const G = cfg.guard ?? { road: 9, node: 11, hq: 24 };
const bridgeNodes = new Set(net.nodes.filter((n) => n.tags.includes('bridge') && cfg.onWater?.includes(n.id)).map((n) => n.id));
for (const c of CORRIDORS.values()) {
  if (c.kind === 'bridge') {
    // keep both abutments on land for a short stretch; the span itself is free to cross water
    const ends = [c.pts[0], c.pts[c.pts.length - 1]];
    if (!bridgeNodes.has(c.a)) stampSegment(ends[0], ends[0], G.node, 1);
    if (!bridgeNodes.has(c.b)) stampSegment(ends[1], ends[1], G.node, 1);
    continue;
  }
  stampPolyline(c.pts, G.road, 1);
}
for (const n of net.nodes) if (!bridgeNodes.has(n.id)) stampSegment(n.tactical, n.tactical, G.node, 1);
for (const h of net.headquarters) stampSegment(h.tactical, h.tactical, G.hq, 1);
for (const s of cfg.land ?? []) stampPolyline(s.pts.map(([x, y]) => ({ x, y })), s.r, 1);

// ---- remove specks / ponds (connected components)
function components(val) {
  const seen = new Uint8Array(GW * GH);
  const comps = [];
  const stack = new Int32Array(GW * GH);
  for (let i = 0; i < GW * GH; i++) {
    if (seen[i] || grid[i] !== val) continue;
    let sp = 0, size = 0, edge = false;
    stack[sp++] = i;
    seen[i] = 1;
    const cells = [];
    while (sp) {
      const c = stack[--sp];
      cells.push(c);
      size++;
      const x = c % GW, y = (c / GW) | 0;
      if (x === 0 || y === 0 || x === GW - 1 || y === GH - 1) edge = true;
      for (const nb of [c - 1, c + 1, c - GW, c + GW]) {
        if (nb < 0 || nb >= GW * GH || seen[nb] || grid[nb] !== val) continue;
        if ((nb === c - 1 && x === 0) || (nb === c + 1 && x === GW - 1)) continue;
        seen[nb] = 1;
        stack[sp++] = nb;
      }
    }
    comps.push({ size, edge, cells });
  }
  return comps;
}
for (const c of components(1)) if (!c.edge && c.size < (cfg.minIsland ?? 120)) for (const i of c.cells) grid[i] = 0;
for (const c of components(0)) if (!c.edge && c.size < (cfg.minPond ?? 2500)) for (const i of c.cells) grid[i] = 1;

// ---- blur + marching squares at 0.5 (a water frame round the raster closes every land loop far off-screen)
for (let i = 0; i < GW; i++) for (const y of [0, 1, 2, 3, 4, 5, GH - 6, GH - 5, GH - 4, GH - 3, GH - 2, GH - 1]) grid[y * GW + i] = 0;
for (let j = 0; j < GH; j++) for (const x of [0, 1, 2, 3, 4, 5, GW - 6, GW - 5, GW - 4, GW - 3, GW - 2, GW - 1]) grid[j * GW + x] = 0;
const field = new Float32Array(GW * GH);
for (let i = 0; i < GW * GH; i++) field[i] = grid[i];
function boxBlur(r) {
  const tmp = new Float32Array(GW * GH);
  for (let y = 0; y < GH; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += field[y * GW + Math.min(GW - 1, Math.max(0, x))];
    for (let x = 0; x < GW; x++) {
      tmp[y * GW + x] = acc / (2 * r + 1);
      acc += field[y * GW + Math.min(GW - 1, x + r + 1)] - field[y * GW + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < GW; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(GH - 1, Math.max(0, y)) * GW + x];
    for (let y = 0; y < GH; y++) {
      field[y * GW + x] = acc / (2 * r + 1);
      acc += tmp[Math.min(GH - 1, y + r + 1) * GW + x] - tmp[Math.max(0, y - r) * GW + x];
    }
  }
}
boxBlur(2);
boxBlur(2);

function contours(iso) {
  // segments keyed by quantised endpoints, then chained into loops
  const segs = new Map();
  const key = (p) => `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)}`;
  const add = (p, q) => {
    const kp = key(p);
    (segs.get(kp) ?? segs.set(kp, []).get(kp)).push({ p, q, used: false });
  };
  const v = (x, y) => field[y * GW + x];
  for (let y = 0; y < GH - 1; y++)
    for (let x = 0; x < GW - 1; x++) {
      const a = v(x, y), b = v(x + 1, y), c = v(x + 1, y + 1), d = v(x, y + 1);
      const idx = (a > iso ? 8 : 0) | (b > iso ? 4 : 0) | (c > iso ? 2 : 0) | (d > iso ? 1 : 0);
      if (idx === 0 || idx === 15) continue;
      const lerp = (p0, p1, v0, v1) => {
        const t = (iso - v0) / (v1 - v0);
        return [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t];
      };
      const P = [x + X0 + 0.5, y + Y0 + 0.5];
      const tl = P, tr = [P[0] + 1, P[1]], br = [P[0] + 1, P[1] + 1], bl = [P[0], P[1] + 1];
      const top = lerp(tl, tr, a, b), right = lerp(tr, br, b, c), bottom = lerp(bl, br, d, c), left = lerp(tl, bl, a, d);
      // orientation: land on the left of p→q
      const T = {
        1: [[left, bottom]], 2: [[bottom, right]], 3: [[left, right]], 4: [[right, top]],
        5: [[left, top], [right, bottom]], 6: [[bottom, top]], 7: [[left, top]], 8: [[top, left]],
        9: [[top, bottom]], 10: [[top, right], [bottom, left]], 11: [[top, right]], 12: [[right, left]],
        13: [[right, bottom]], 14: [[bottom, left]],
      }[idx];
      for (const [p, q] of T) add(p, q);
    }
  const loops = [];
  for (const list of segs.values())
    for (const s0 of list) {
      if (s0.used) continue;
      s0.used = true;
      const loop = [s0.p];
      let cur = s0.q;
      for (let guard = 0; guard < 1e6; guard++) {
        const next = (segs.get(key(cur)) ?? []).find((s) => !s.used);
        if (!next) break;
        next.used = true;
        loop.push(next.p);
        cur = next.q;
      }
      if (loop.length > 8) loops.push(loop);
    }
  return loops;
}
function dp(pts, eps) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    const [ax, ay] = pts[i0], [bx, by] = pts[i1];
    const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy || 1e-9;
    let best = -1, bd = 0;
    for (let i = i0 + 1; i < i1; i++) {
      const t = Math.max(0, Math.min(1, ((pts[i][0] - ax) * vx + (pts[i][1] - ay) * vy) / l2));
      const d = Math.hypot(pts[i][0] - (ax + t * vx), pts[i][1] - (ay + t * vy));
      if (d > bd) { bd = d; best = i; }
    }
    if (bd > eps && best > 0) { keep[best] = 1; stack.push([i0, best], [best, i1]); }
  }
  return pts.filter((_, i) => keep[i]);
}
function chaikin(p, iters) {
  for (let k = 0; k < iters; k++) {
    const q = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      q.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    p = q;
  }
  return p;
}
const EPS = Number(arg('--eps') ?? cfg.eps ?? 1.1);
const rings = [];
for (const loop of contours(0.5)) {
  let s = dp([...loop, loop[0]], EPS).slice(0, -1);
  if (s.length < 3) continue;
  s = chaikin(s, 2);
  s = dp([...s, s[0]], 0.35).slice(0, -1);
  // drop loops entirely outside the useful area
  const xs = s.map((p) => p[0]), ys = s.map((p) => p[1]);
  if (Math.max(...xs) < -250 || Math.min(...xs) > 1250 || Math.max(...ys) < -250 || Math.min(...ys) > 1250) continue;
  rings.push(s.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]));
}

// ---- bridge spans over water (fractions along each bridge corridor, a → b)
function isLand(x, y) {
  let inside = false;
  for (const r of rings)
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  return inside;
}
const spans = {};
for (const c of CORRIDORS.values()) {
  if (c.kind !== 'bridge') continue;
  const N = Math.max(20, Math.ceil(c.len / 2));
  const wet = [];
  for (let i = 0; i <= N; i++) {
    const s = (i / N) * c.len;
    let k = 1;
    while (k < c.cum.length - 1 && c.cum[k] < s) k++;
    const a = c.pts[k - 1], b = c.pts[k];
    const t = (s - c.cum[k - 1]) / (c.cum[k] - c.cum[k - 1] || 1);
    wet.push(!isLand(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t));
  }
  const out = [];
  let start = -1;
  for (let i = 0; i <= N; i++) {
    if (wet[i] && start < 0) start = i;
    if ((!wet[i] || i === N) && start >= 0) {
      const end = wet[i] ? i : i - 1;
      if (end > start) out.push([Math.round((start / N) * 1000) / 1000, Math.round((end / N) * 1000) / 1000]);
      start = -1;
    }
  }
  spans[c.id] = out;
  if (!out.length) console.warn(`warning: bridge ${c.id} does not cross water`);
}

const sig = layoutSignature(net);
const total = rings.reduce((s, r) => s + r.length, 0);
const pathOf = (r) => 'M' + r.map(([x, y]) => `${x} ${y}`).join('L') + 'Z';
writeFileSync(
  OUT,
  `// GENERATED by client/src/map/tools/build-shore.mjs (npx tsx client/src/map/tools/build-shore.mjs) — do not edit.
// Bay Area land in tactical space: Natural Earth 1:10m Land (public domain, naturalearthdata.com), warped by a
// thin-plate spline fitted on the camera nodes' real → tactical positions, guarded so roads stay on land.

/** network.json tactical layout this file was built for (a test fails when they drift apart). */
export const SHORE_LAYOUT_SIG = ${JSON.stringify(sig)};

/** Land rings (tactical units), each [x0, y0, x1, y1, ...]; even-odd fill. */
export const LAND_RINGS: number[][] = ${JSON.stringify(rings.map((r) => r.flat()))};

/** SVG path of every land ring (use fill-rule="evenodd"). */
export const LAND_PATH = ${JSON.stringify(rings.map(pathOf).join(''))};

/** Over-water stretches of each bridge corridor, as [t0, t1] fractions from edge.a to edge.b. */
export const BRIDGE_SPANS: Record<string, Array<[number, number]>> = ${JSON.stringify(spans)};
`,
);
console.log(`rings ${rings.length}, points ${total} → ${OUT}`);

export function layoutSignature(n) {
  const s = [...n.nodes.map((x) => `${x.id}@${x.tactical.x},${x.tactical.y}`), ...n.headquarters.map((h) => `${h.id}@${h.tactical.x},${h.tactical.y}`)].join(';');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

if (arg('--json')) {
  const gridLines = [];
  for (let lat = 37.2; lat <= 38.4; lat += 0.05) { const l = []; for (let lon = -122.9; lon <= -121.6; lon += 0.01) l.push(warp(km(lon, lat))); gridLines.push(l); }
  for (let lon = -122.9; lon <= -121.6; lon += 0.05) { const l = []; for (let lat = 37.2; lat <= 38.4; lat += 0.01) l.push(warp(km(lon, lat))); gridLines.push(l); }
  writeFileSync(arg('--json'), JSON.stringify({ rings, grid: gridLines }));
}
