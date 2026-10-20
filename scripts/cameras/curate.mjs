#!/usr/bin/env node
// Build shared/src/data/cameras.json from scripts/cameras/selection.json + live Caltrans data.
// Re-runnable. Zero dependencies.
//
//   node scripts/cameras/curate.mjs              probe every selected camera and rewrite cameras.json
//   node scripts/cameras/curate.mjs --refresh    re-run discover first (fresh D4 feed)
//   node scripts/cameras/curate.mjs --offline    no network: keep previous `verified` blocks from cameras.json
//   node scripts/cameras/curate.mjs --images-dir <dir>   also save each downloaded snapshot (outside the repo!)
//
// `verified` is always filled from real HTTP checks (never invented). Extra (backwards-compatible) keys:
//   imageBytes, imageIsPlaceholder (Caltrans "Temporarily Unavailable" card), streamPlayable
//   (playlist + first segment both 200 and CORS-enabled).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { probeImage, probeStream, pool } from './lib/probe.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const SELECTION = resolve(HERE, 'selection.json');
const D4_ALL = resolve(HERE, 'out/d4-all.json');
const OUT = resolve(ROOT, 'shared/src/data/cameras.json');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);

const clamp01 = (v) => Math.min(1, Math.max(0, v));
function cleanPlacement(list) {
  return list.map((p) => ({
    x: +clamp01(p.x).toFixed(3), y: +clamp01(p.y).toFixed(3),
    w: +Math.min(p.w, 1 - clamp01(p.x)).toFixed(3), h: +Math.min(p.h, 1 - clamp01(p.y)).toFixed(3),
    scale: +Math.min(0.9, Math.max(0.05, p.scale)).toFixed(3),
  }));
}

async function main() {
  if (flag('--refresh') || !existsSync(D4_ALL)) {
    console.log('running discover…');
    const r = spawnSync(process.execPath, [resolve(HERE, 'discover.mjs')], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('discover failed');
  }
  const selection = JSON.parse(await readFile(SELECTION, 'utf8'));
  const all = JSON.parse(await readFile(D4_ALL, 'utf8')).cameras;
  const byCode = new Map(all.filter((c) => c.code).map((c) => [c.code.toUpperCase(), c]));
  const previous = existsSync(OUT) ? new Map(JSON.parse(await readFile(OUT, 'utf8')).map((c) => [c.id, c])) : new Map();
  const offline = flag('--offline');
  const imagesDir = opt('--images-dir');
  if (imagesDir) await mkdir(imagesDir, { recursive: true });

  const picked = selection.cameras.map((s) => {
    const src = byCode.get(String(s.code).toUpperCase());
    if (!src) throw new Error(`selection code ${s.code} not found in the D4 feed`);
    return { sel: s, src };
  });
  const seen = new Set();
  for (const { sel } of picked) {
    if (seen.has(sel.code)) throw new Error(`duplicate selection ${sel.code}`);
    seen.add(sel.code);
  }

  const warnings = [];
  const checkedAt = new Date().toISOString();
  const records = await pool(picked, async ({ sel, src }) => {
    const id = `d4-${src.code.toLowerCase()}`;
    let verified;
    if (offline) {
      verified = previous.get(id)?.verified;
      if (!verified) throw new Error(`--offline but no previous verified block for ${id}`);
    } else {
      const img = await probeImage(src.imageUrl);
      if (imagesDir && img.body && img.jpeg) await writeFile(resolve(imagesDir, `${src.code}.jpg`), img.body);
      const st = src.streamUrl ? await probeStream(src.streamUrl) : null;
      verified = {
        checkedAt,
        imageHttp: img.http,
        streamHttp: st ? st.http : null,
        imageCors: img.http ? !!img.cors : null,
        streamCors: st && st.http ? !!st.cors : null,
        imageBytes: img.bytes ?? null,
        imageIsPlaceholder: img.http === 200 ? !!img.placeholder : null,
        streamPlayable: st ? st.http === 200 && st.segmentHttp === 200 && !!st.cors && !!st.segmentCors && !!st.segmentMpegTs : null,
      };
      if (img.http !== 200) warnings.push(`${src.code}: image HTTP ${img.http} ${img.error || ''}`);
      if (img.placeholder) warnings.push(`${src.code}: snapshot is the "Temporarily Unavailable" placeholder -> pick another camera`);
      if (!src.inService) warnings.push(`${src.code}: feed says inService=false`);
      if (src.streamUrl && !verified.streamPlayable) warnings.push(`${src.code}: published stream not playable (HTTP ${st.http}, segment ${st.segmentHttp ?? '-'}) ${st.error || ''}`);
    }
    const name = sel.name || src.locationName.replace(/^\s*[A-Za-z0-9]+\s*--\s*/, '');
    return {
      id,
      caltransIndex: src.index,
      name,
      route: src.route,
      direction: src.direction,
      county: src.county,
      nearbyPlace: src.nearbyPlace,
      lat: src.lat,
      lon: src.lon,
      imageUrl: src.imageUrl,
      streamUrl: src.streamUrl,
      imageUpdateFrequencyMin: src.imageUpdateFrequencyMin,
      inService: src.inService,
      verified,
      placement: cleanPlacement(sel.placement?.length ? sel.placement : selection.defaultPlacement),
      tags: [...new Set(sel.tags ?? [])],
    };
  }, { concurrency: 3, delayMs: 200 });

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(records, null, 2) + '\n');
  const ok = records.filter((r) => r.verified.imageHttp === 200 && !r.verified.imageIsPlaceholder).length;
  const live = records.filter((r) => r.verified.streamPlayable).length;
  console.log(`wrote ${records.length} cameras -> ${OUT}`);
  console.log(`real snapshots: ${ok}/${records.length}; playable HLS: ${live}/${records.length}`);
  for (const w of warnings) console.warn('WARN', w);
  if (warnings.length) process.exitCode = 0;
}
main().catch((e) => { console.error(e); process.exit(1); });
