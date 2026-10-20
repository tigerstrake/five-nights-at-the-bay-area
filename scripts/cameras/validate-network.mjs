#!/usr/bin/env node
// Validate shared/src/data/network.json (+ cameras.json cross-references). Zero dependencies.
// Exit code 0 = all checks pass, 1 = failures. Usage: node scripts/cameras/validate-network.mjs [--quiet]
//
// Hop-distance convention (documented in docs/CAMERAS.md): an HQ is not a graph node. A monster must stand
// on an approach's `fromNode` and then attack its door, so   hqHops(node) = 1 + min over approaches of
// graphHops(node, fromNode).   Spawns must satisfy hqHops >= MIN_SPAWN_HQ_HOPS for every HQ.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const quiet = process.argv.includes('--quiet');

export const LIMITS = {
  nodesMin: 28, nodesMax: 36,
  degreeMin: 2, degreeMax: 4, degreeSoftMax: 5, maxDegree5Nodes: 3,
  minSpawnHqHops: 5,
  minTacticalSpacing: 40, // node-node, in tactical units (0..1000)
  minHqNodeSpacing: 40,
  minEdgeNodeClearance: 18, // an edge's straight line must not pass within this of a non-endpoint node
  spawnsMin: 4, spawnsMax: 8,
  approachesPerHq: 3,
  minDisjointPaths: 2,
};
const REGIONS = ['sf', 'north-bay', 'east-bay', 'peninsula', 'south-bay'];
const KINDS = ['freeway', 'bridge', 'surface', 'tunnel'];
const HQ_IDS = ['hq-stanford', 'hq-sf', 'hq-oakland', 'hq-sanjose'];

const errors = [], warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;

const net = JSON.parse(await readFile(resolve(ROOT, 'shared/src/data/network.json'), 'utf8'));
const cams = JSON.parse(await readFile(resolve(ROOT, 'shared/src/data/cameras.json'), 'utf8'));

// ---- cameras.json schema
const camIds = new Set();
for (const c of cams) {
  if (!isStr(c.id)) err(`camera without id`);
  if (camIds.has(c.id)) err(`duplicate camera id ${c.id}`);
  camIds.add(c.id);
  for (const k of ['caltransIndex', 'name', 'route', 'county', 'nearbyPlace']) if (typeof c[k] !== 'string') err(`camera ${c.id}: ${k} must be string`);
  if (c.direction !== null && typeof c.direction !== 'string') err(`camera ${c.id}: direction must be string|null`);
  if (!isNum(c.lat) || !isNum(c.lon) || c.lat < 36.5 || c.lat > 38.9 || c.lon < -123.2 || c.lon > -121.2) err(`camera ${c.id}: lat/lon missing or outside Bay Area`);
  for (const k of ['imageUrl', 'streamUrl']) if (c[k] !== null && !/^https:\/\//.test(c[k] ?? '')) err(`camera ${c.id}: ${k} must be https URL or null`);
  if (c.imageUpdateFrequencyMin !== null && !isNum(c.imageUpdateFrequencyMin)) err(`camera ${c.id}: imageUpdateFrequencyMin`);
  if (typeof c.inService !== 'boolean') err(`camera ${c.id}: inService`);
  const v = c.verified;
  if (!v || !isStr(v.checkedAt) || Number.isNaN(Date.parse(v.checkedAt))) err(`camera ${c.id}: verified.checkedAt`);
  else {
    for (const k of ['imageHttp', 'streamHttp']) if (v[k] !== null && !isNum(v[k])) err(`camera ${c.id}: verified.${k}`);
    for (const k of ['imageCors', 'streamCors']) if (v[k] !== null && typeof v[k] !== 'boolean') err(`camera ${c.id}: verified.${k}`);
  }
  if (!Array.isArray(c.placement) || c.placement.length < 1 || c.placement.length > 3) err(`camera ${c.id}: placement needs 1..3 boxes`);
  else for (const p of c.placement) {
    if (![p.x, p.y, p.w, p.h, p.scale].every(isNum)) { err(`camera ${c.id}: placement fields must be numbers`); continue; }
    if (p.x < 0 || p.y < 0 || p.w <= 0 || p.h <= 0 || p.x + p.w > 1.0001 || p.y + p.h > 1.0001) err(`camera ${c.id}: placement box outside 0..1`);
    if (p.scale < 0.05 || p.scale > 0.9) err(`camera ${c.id}: placement scale ${p.scale} outside 0.05..0.9`);
    if (p.y + p.h > 0.905) err(`camera ${c.id}: placement box reaches into Caltrans' burned-in timestamp bar (y+h=${(p.y + p.h).toFixed(3)} > 0.905)`);
  }
  if (!Array.isArray(c.tags) || c.tags.some((t) => typeof t !== 'string')) err(`camera ${c.id}: tags`);
  if (c.verified?.imageIsPlaceholder === true) warn(`camera ${c.id}: snapshot is currently the "Temporarily Unavailable" placeholder`);
}

// ---- network schema
if (net.version !== 1) err('version must be 1');
const nodes = net.nodes ?? [], edges = net.edges ?? [], hqs = net.headquarters ?? [], spawns = net.spawnNodes ?? [];
const nodeIds = new Set();
for (const n of nodes) {
  if (!/^n-[a-z0-9-]+$/.test(n.id ?? '')) err(`node id "${n.id}" must match n-<slug>`);
  if (nodeIds.has(n.id)) err(`duplicate node id ${n.id}`);
  nodeIds.add(n.id);
  if (n.cameraId !== null && !camIds.has(n.cameraId)) err(`node ${n.id}: cameraId ${n.cameraId} not in cameras.json`);
  if (n.cameraId === null) warn(`node ${n.id} has no camera`);
  if (!isStr(n.name)) err(`node ${n.id}: name`);
  if (!isNum(n.lat) || !isNum(n.lon)) err(`node ${n.id}: lat/lon`);
  if (!REGIONS.includes(n.region)) err(`node ${n.id}: region "${n.region}"`);
  if (!Array.isArray(n.tags)) err(`node ${n.id}: tags`);
  if (!n.tactical || !isNum(n.tactical.x) || !isNum(n.tactical.y) || n.tactical.x < 0 || n.tactical.x > 1000 || n.tactical.y < 0 || n.tactical.y > 1000) err(`node ${n.id}: tactical must be within 0..1000`);
}
{
  const used = new Map();
  for (const n of nodes) if (n.cameraId) { if (used.has(n.cameraId)) err(`camera ${n.cameraId} used by both ${used.get(n.cameraId)} and ${n.id}`); used.set(n.cameraId, n.id); }
  for (const c of cams) if (!used.has(c.id)) warn(`camera ${c.id} is curated but unused by any node`);
}
if (nodes.length < LIMITS.nodesMin || nodes.length > LIMITS.nodesMax) err(`node count ${nodes.length} outside ${LIMITS.nodesMin}..${LIMITS.nodesMax}`);

const edgeIds = new Set(), pairs = new Set();
const adj = new Map(nodes.map((n) => [n.id, new Set()]));
for (const e of edges) {
  if (!isStr(e.id)) err('edge without id');
  if (edgeIds.has(e.id)) err(`duplicate edge id ${e.id}`);
  edgeIds.add(e.id);
  if (!nodeIds.has(e.a)) err(`edge ${e.id}: unknown node a=${e.a}`);
  if (!nodeIds.has(e.b)) err(`edge ${e.id}: unknown node b=${e.b}`);
  if (e.a === e.b) err(`edge ${e.id}: self loop`);
  const key = [e.a, e.b].sort().join('|');
  if (pairs.has(key)) err(`edge ${e.id}: duplicate pair ${key}`);
  pairs.add(key);
  if (!KINDS.includes(e.kind)) err(`edge ${e.id}: kind "${e.kind}"`);
  if (!isStr(e.route)) err(`edge ${e.id}: route`);
  if (!isNum(e.lengthKm) || e.lengthKm <= 0) err(`edge ${e.id}: lengthKm`);
  adj.get(e.a)?.add(e.b); adj.get(e.b)?.add(e.a);
}

// ---- graph helpers
function bfs(src) {
  const d = new Map([[src, 0]]), q = [src];
  while (q.length) { const u = q.shift(); for (const v of adj.get(u) ?? []) if (!d.has(v)) { d.set(v, d.get(u) + 1); q.push(v); } }
  return d;
}
const connected = nodes.length > 0 && bfs(nodes[0].id).size === nodes.length;
if (!connected) err('graph is not connected');

const degHist = {};
const deg5 = [];
for (const n of nodes) {
  const d = adj.get(n.id).size;
  degHist[d] = (degHist[d] ?? 0) + 1;
  if (d < LIMITS.degreeMin) err(`node ${n.id}: degree ${d} < ${LIMITS.degreeMin}`);
  else if (d > LIMITS.degreeSoftMax) err(`node ${n.id}: degree ${d} > ${LIMITS.degreeSoftMax}`);
  else if (d > LIMITS.degreeMax) deg5.push(n.id);
}
if (deg5.length > LIMITS.maxDegree5Nodes) err(`too many degree-5 nodes (${deg5.length}): ${deg5.join(', ')}`);
else if (deg5.length) warn(`degree-5 nodes (allowed at interchanges): ${deg5.join(', ')}`);

// ---- tactical spacing
const nodeById = new Map(nodes.map((n) => [n.id, n]));
const dist2 = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
let minSpacing = Infinity, minPair = '';
for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
  const d = dist2(nodes[i].tactical, nodes[j].tactical);
  if (d < minSpacing) { minSpacing = d; minPair = `${nodes[i].id} / ${nodes[j].id}`; }
  if (d < LIMITS.minTacticalSpacing) err(`tactical overlap: ${nodes[i].id} and ${nodes[j].id} only ${d.toFixed(0)} apart (< ${LIMITS.minTacticalSpacing})`);
}
function segDist(p, a, b) {
  const vx = b.x - a.x, vy = b.y - a.y, l2 = vx * vx + vy * vy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2));
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}
for (const e of edges) {
  const A = nodeById.get(e.a), B = nodeById.get(e.b);
  if (!A || !B) continue;
  for (const n of nodes) {
    if (n.id === e.a || n.id === e.b) continue;
    const d = segDist(n.tactical, A.tactical, B.tactical);
    if (d < LIMITS.minEdgeNodeClearance) err(`edge ${e.id} passes ${d.toFixed(0)} from node ${n.id} (< ${LIMITS.minEdgeNodeClearance})`);
  }
}

// ---- HQs
const hqSummary = [];
if (hqs.length !== 4 || !HQ_IDS.every((id) => hqs.some((h) => h.id === id))) err(`headquarters must be exactly ${HQ_IDS.join(', ')}`);
const approachIds = new Set();
for (const h of hqs) {
  if (!isStr(h.name) || !isNum(h.lat) || !isNum(h.lon)) err(`hq ${h.id}: name/lat/lon`);
  if (!h.tactical || !isNum(h.tactical.x) || !isNum(h.tactical.y) || h.tactical.x < 0 || h.tactical.x > 1000 || h.tactical.y < 0 || h.tactical.y > 1000) err(`hq ${h.id}: tactical within 0..1000`);
  for (const n of nodes) if (h.tactical && dist2(h.tactical, n.tactical) < LIMITS.minHqNodeSpacing) err(`hq ${h.id} overlaps node ${n.id} on the tactical map`);
  for (const h2 of hqs) if (h2.id < h.id && dist2(h.tactical, h2.tactical) < 100) err(`hqs ${h.id}/${h2.id} too close on tactical map`);
  if (!Array.isArray(h.approaches) || h.approaches.length !== LIMITS.approachesPerHq) { err(`hq ${h.id}: needs exactly ${LIMITS.approachesPerHq} approaches`); continue; }
  const from = h.approaches.map((a) => a.fromNode);
  if (new Set(from).size !== from.length) err(`hq ${h.id}: approach fromNodes are not distinct`);
  for (const a of h.approaches) {
    if (!isStr(a.id) || !isStr(a.label) || !isStr(a.door)) err(`hq ${h.id}: approach needs id/label/door`);
    if (approachIds.has(a.id)) err(`duplicate approach id ${a.id}`);
    approachIds.add(a.id);
    if (!nodeIds.has(a.fromNode)) err(`hq ${h.id} approach ${a.id}: unknown fromNode ${a.fromNode}`);
  }
  // an approach node should be geographically near its HQ (rough sanity)
  for (const a of h.approaches) {
    const n = nodeById.get(a.fromNode);
    if (!n) continue;
    const km = haversineKm(n, h);
    if (km > 25) warn(`hq ${h.id} approach ${a.id}: fromNode ${n.id} is ${km.toFixed(0)} km from the HQ`);
  }
}
function haversineKm(a, b) {
  const R = 6371, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// ---- spawns
if (spawns.length < LIMITS.spawnsMin || spawns.length > LIMITS.spawnsMax) err(`spawnNodes count ${spawns.length} outside ${LIMITS.spawnsMin}..${LIMITS.spawnsMax}`);
if (new Set(spawns).size !== spawns.length) err('duplicate spawn node');
for (const s of spawns) if (!nodeIds.has(s)) err(`spawn ${s}: unknown node`);

function hqHops(src, hq) {
  const d = bfs(src);
  return 1 + Math.min(...hq.approaches.map((a) => d.get(a.fromNode) ?? Infinity));
}
const distTable = [];
for (const s of spawns) {
  if (!nodeIds.has(s)) continue;
  const row = { spawn: s };
  for (const h of hqs) {
    if (!h.approaches) continue;
    const v = hqHops(s, h);
    row[h.id] = v;
    if (v < LIMITS.minSpawnHqHops) err(`spawn ${s} is only ${v} hops from ${h.id} (< ${LIMITS.minSpawnHqHops})`);
  }
  distTable.push(row);
}

// ---- corridor diversity: node-disjoint paths from each spawn to each HQ (max-flow, node splitting)
function disjointPaths(src, approachNodes) {
  // vertices: in(v)=2i, out(v)=2i+1; sink T. capacity 1 on v_in->v_out (except src), 1 per edge direction
  const idx = new Map(nodes.map((n, i) => [n.id, i]));
  const T = nodes.length * 2;
  const cap = new Map();
  const g = Array.from({ length: T + 1 }, () => []);
  const add = (u, v, c) => { g[u].push(v); g[v].push(u); cap.set(`${u}>${v}`, (cap.get(`${u}>${v}`) ?? 0) + c); if (!cap.has(`${v}>${u}`)) cap.set(`${v}>${u}`, 0); };
  for (const n of nodes) { const i = idx.get(n.id); add(2 * i, 2 * i + 1, n.id === src ? 99 : 1); }
  for (const e of edges) { const a = idx.get(e.a), b = idx.get(e.b); if (a === undefined || b === undefined) continue; add(2 * a + 1, 2 * b, 1); add(2 * b + 1, 2 * a, 1); }
  for (const a of approachNodes) add(2 * idx.get(a) + 1, T, 1);
  const S = 2 * idx.get(src);
  let flow = 0;
  while (true) {
    const prev = new Map([[S, null]]), q = [S];
    while (q.length && !prev.has(T)) { const u = q.shift(); for (const v of g[u]) if (!prev.has(v) && cap.get(`${u}>${v}`) > 0) { prev.set(v, u); q.push(v); } }
    if (!prev.has(T)) break;
    for (let v = T; prev.get(v) !== null; v = prev.get(v)) { const u = prev.get(v); cap.set(`${u}>${v}`, cap.get(`${u}>${v}`) - 1); cap.set(`${v}>${u}`, cap.get(`${v}>${u}`) + 1); }
    flow++;
  }
  return flow;
}
const flowTable = [];
for (const s of spawns) {
  if (!nodeIds.has(s)) continue;
  const row = { spawn: s };
  for (const h of hqs) {
    if (!h.approaches || h.approaches.some((a) => !nodeIds.has(a.fromNode))) continue;
    const f = disjointPaths(s, h.approaches.map((a) => a.fromNode));
    row[h.id] = f;
    if (f < LIMITS.minDisjointPaths) err(`only ${f} node-disjoint route(s) from spawn ${s} to ${h.id} approaches (< ${LIMITS.minDisjointPaths})`);
  }
  flowTable.push(row);
}

// ---- chokepoints (bridge edges & articulation points)
function articulation() {
  const disc = new Map(), low = new Map(), ap = new Set(), br = [];
  let t = 0;
  const dfs = (u, p) => {
    disc.set(u, ++t); low.set(u, t);
    let children = 0;
    for (const v of adj.get(u)) {
      if (v === p) continue;
      if (disc.has(v)) low.set(u, Math.min(low.get(u), disc.get(v)));
      else {
        children++;
        dfs(v, u);
        low.set(u, Math.min(low.get(u), low.get(v)));
        if (low.get(v) > disc.get(u)) br.push([u, v]);
        if (p !== null && low.get(v) >= disc.get(u)) ap.add(u);
      }
    }
    if (p === null && children > 1) ap.add(u);
  };
  if (nodes.length) dfs(nodes[0].id, null);
  return { ap: [...ap], br };
}
const { ap, br } = nodes.length ? articulation() : { ap: [], br: [] };
if (br.length) warn(`cut edges (removing one disconnects the graph): ${br.map(([a, b]) => `${a}--${b}`).join(', ')}`);
if (ap.length) warn(`articulation nodes: ${ap.join(', ')}`);

// ---- report
const totalKm = edges.reduce((s, e) => s + e.lengthKm, 0);
const byKind = edges.reduce((m, e) => ((m[e.kind] = (m[e.kind] ?? 0) + 1), m), {});
if (!quiet) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log('=== network.json validation ===');
  console.log(`nodes ${nodes.length}  edges ${edges.length} (${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(', ')})  total ${totalKm.toFixed(0)} km  cameras ${cams.length}`);
  console.log(`connected: ${connected}   min tactical spacing: ${minSpacing.toFixed(0)} (${minPair})`);
  console.log(`degree histogram: ${Object.entries(degHist).sort((a, b) => a[0] - b[0]).map(([d, c]) => `${d}:${c}`).join('  ')}`);
  const regions = nodes.reduce((m, n) => ((m[n.region] = (m[n.region] ?? 0) + 1), m), {});
  console.log(`regions: ${Object.entries(regions).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log('\nHQ hop distance from each spawn  (hqHops = 1 + hops to nearest approach fromNode; min required ' + LIMITS.minSpawnHqHops + ')');
  console.log(pad('spawn', 20) + HQ_IDS.map((h) => pad(h, 12)).join(''));
  for (const r of distTable) console.log(pad(r.spawn, 20) + HQ_IDS.map((h) => pad(r[h] ?? '-', 12)).join(''));
  console.log('\nnode-disjoint corridors spawn -> HQ approaches (min required ' + LIMITS.minDisjointPaths + ')');
  console.log(pad('spawn', 20) + HQ_IDS.map((h) => pad(h, 12)).join(''));
  for (const r of flowTable) console.log(pad(r.spawn, 20) + HQ_IDS.map((h) => pad(r[h] ?? '-', 12)).join(''));
  console.log('\napproaches');
  for (const h of hqs) console.log(`  ${h.id}: ${(h.approaches ?? []).map((a) => `${a.fromNode} ("${a.door}")`).join('  |  ')}`);
  if (warnings.length) { console.log('\nwarnings:'); for (const w of warnings) console.log('  - ' + w); }
}
if (errors.length) { console.error(`\nFAILED with ${errors.length} error(s):`); for (const e of errors) console.error('  x ' + e); process.exit(1); }
console.log(quiet ? 'network OK' : '\nPASS: all network checks OK');
