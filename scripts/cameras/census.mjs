#!/usr/bin/env node
// One-off, polite census: HEAD every in-service D4 snapshot URL to find which return a real image
// versus Caltrans' "Temporarily Unavailable" placeholder (HTTP 200 + fresh Last-Modified either way!).
// Placeholder heuristic: JPEG of ~13.4 KB (Content-Length 13300..13700). Candidate cameras are still
// verified by downloading + eyeballing; this only prioritises. Output: scripts/cameras/out/d4-census.json
// With --streams it also GETs every published HLS master playlist (tiny) and its first media playlist.
// Usage: node scripts/cameras/census.mjs [--limit N] [--streams]
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, ORIGIN, looksLikePlaceholder, sleep } from './lib/probe.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const all = JSON.parse(await readFile(resolve(HERE, 'out/d4-all.json'), 'utf8')).cameras;
const limitIdx = process.argv.indexOf('--limit');
let cams = all.filter((c) => c.inService && c.imageUrl);
if (limitIdx > 0) cams = cams.slice(0, Number(process.argv[limitIdx + 1]));

const t0 = Date.now();
const res = await pool(cams, async (c) => {
  try {
    const r = await fetch(c.imageUrl, { method: 'HEAD', headers: { origin: ORIGIN, 'user-agent': 'fnab-camera-research/1.0 (polite census)' }, signal: AbortSignal.timeout(15000) });
    const len = Number(r.headers.get('content-length')) || null;
    const lm = r.headers.get('last-modified');
    return {
      index: c.index, code: c.code, http: r.status, bytes: len,
      ageMin: lm ? Math.round((Date.now() - new Date(lm).getTime()) / 60000) : null,
      cors: ['*', ORIGIN].includes(r.headers.get('access-control-allow-origin')),
      placeholder: len != null && looksLikePlaceholder(len),
    };
  } catch (e) {
    return { index: c.index, code: c.code, http: null, error: String(e.message || e) };
  }
}, { concurrency: 3, delayMs: 100 });

const summary = {
  at: new Date().toISOString(), checked: res.length,
  http200: res.filter((r) => r.http === 200).length,
  placeholder: res.filter((r) => r.placeholder).length,
  realLooking: res.filter((r) => r.http === 200 && !r.placeholder).length,
  failed: res.filter((r) => r.http !== 200).length,
  seconds: Math.round((Date.now() - t0) / 1000),
};
await writeFile(resolve(HERE, 'out/d4-census.json'), JSON.stringify({ summary, results: res }, null, 1));
console.log(summary);

if (process.argv.includes('--streams')) {
  const withStream = all.filter((c) => c.inService && c.streamUrl);
  const get = async (u) => { const r = await fetch(u, { headers: { origin: ORIGIN, 'user-agent': 'fnab-camera-research/1.0 (polite census)' }, signal: AbortSignal.timeout(15000) }); return { r, text: await r.text() }; };
  const sres = await pool(withStream, async (c) => {
    try {
      const m = await get(c.streamUrl);
      const out = { index: c.index, code: c.code, http: m.r.status, cors: ['*', ORIGIN].includes(m.r.headers.get('access-control-allow-origin')), isM3u8: m.text.startsWith('#EXTM3U') };
      if (m.r.ok && out.isM3u8) {
        const rel = m.text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
        if (rel) { await sleep(100); const k = await get(new URL(rel, c.streamUrl).toString()); out.chunklistHttp = k.r.status; out.segments = (k.text.match(/#EXTINF/g) || []).length; out.live = !/#EXT-X-ENDLIST/.test(k.text); }
      }
      return out;
    } catch (e) { return { index: c.index, code: c.code, http: null, error: String(e.message || e) }; }
  }, { concurrency: 3, delayMs: 100 });
  const ssum = {
    at: new Date().toISOString(), checked: sres.length,
    playlistOk: sres.filter((r) => r.http === 200 && r.isM3u8).length,
    chunklistOk: sres.filter((r) => r.chunklistHttp === 200 && r.segments > 0).length,
    http404: sres.filter((r) => r.http === 404).length,
    otherFail: sres.filter((r) => r.http !== 200 && r.http !== 404).length,
    corsOnOk: sres.filter((r) => r.http === 200 && r.cors).length,
  };
  await writeFile(resolve(HERE, 'out/d4-stream-census.json'), JSON.stringify({ summary: ssum, results: sres }, null, 1));
  console.log('streams', ssum);
}
