#!/usr/bin/env node
// Build shared/src/data/network.json from scripts/cameras/network-design.json + shared/src/data/cameras.json.
// Node lat/lon/cameraId come from the camera; edge lengthKm = haversine x roadFactor. Zero dependencies.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const design = JSON.parse(await readFile(resolve(HERE, 'network-design.json'), 'utf8'));
const cameras = JSON.parse(await readFile(resolve(ROOT, 'shared/src/data/cameras.json'), 'utf8'));
const camById = new Map(cameras.map((c) => [c.id, c]));

export function haversineKm(a, b) {
  const R = 6371, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const nodes = design.nodes.map((n) => {
  const cam = camById.get(`d4-${n.code.toLowerCase()}`);
  if (!cam) throw new Error(`node ${n.id}: camera d4-${n.code.toLowerCase()} not in cameras.json (add it to selection.json and run curate)`);
  return { id: n.id, cameraId: cam.id, name: n.name, lat: cam.lat, lon: cam.lon, region: n.region, tags: n.tags, tactical: n.tactical };
});
const nodeById = new Map(nodes.map((n) => [n.id, n]));
const edges = design.edges.map(([a, b, kind, route], i) => {
  const A = nodeById.get(a), B = nodeById.get(b);
  if (!A || !B) throw new Error(`edge ${a}-${b}: unknown node`);
  return { id: `e-${a.replace(/^n-/, '')}--${b.replace(/^n-/, '')}`, a, b, kind, route, lengthKm: Math.max(0.5, +(haversineKm(A, B) * design.roadFactor).toFixed(1)) };
});
const out = { version: 1, nodes, edges, headquarters: design.headquarters, spawnNodes: design.spawnNodes };
await writeFile(resolve(ROOT, 'shared/src/data/network.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`wrote network.json: ${nodes.length} nodes, ${edges.length} edges, ${out.headquarters.length} HQs, ${out.spawnNodes.length} spawns`);
