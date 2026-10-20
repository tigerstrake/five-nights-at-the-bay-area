#!/usr/bin/env node
// Print the markdown table of curated cameras used in docs/CAMERAS.md (reads cameras.json, network.json, selection.json).
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const j = async (p) => JSON.parse(await readFile(resolve(ROOT, p), 'utf8'));
const [cams, net, sel] = await Promise.all([j('shared/src/data/cameras.json'), j('shared/src/data/network.json'), j('scripts/cameras/selection.json')]);
const nodeOf = new Map(net.nodes.map((n) => [n.cameraId, n]));
const notes = new Map(sel.cameras.map((c) => [`d4-${c.code.toLowerCase()}`, c.notes ?? '']));
const hqOf = new Map();
for (const h of net.headquarters) for (const a of h.approaches) hqOf.set(a.fromNode, [...(hqOf.get(a.fromNode) ?? []), h.id.replace('hq-', '')]);
const out = ['| Node | Camera id | Name | Route / dir | Tags | Snapshot | HLS | Notes |', '|---|---|---|---|---|---|---|---|'];
for (const c of cams) {
  const n = nodeOf.get(c.id), v = c.verified;
  const snap = v.imageHttp === 200 && !v.imageIsPlaceholder ? `OK (${Math.round(v.imageBytes / 1024)} KB)` : 'FAIL';
  const hls = c.streamUrl ? (v.streamPlayable ? 'OK' : `listed, HTTP ${v.streamHttp}`) : 'none';
  const hq = hqOf.get(n.id);
  const note = [hq ? `**${hq.join('/')} approach**` : '', notes.get(c.id)].filter(Boolean).join('; ');
  out.push(`| ${n.id} | ${c.id} | ${c.name} | ${c.route}${c.direction ? ' ' + c.direction : ''} | ${c.tags.join(', ')} | ${snap} | ${hls} | ${note} |`);
}
console.log(out.join('\n'));
