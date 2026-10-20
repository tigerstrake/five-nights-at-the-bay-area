#!/usr/bin/env node
// Fetch and normalize every Caltrans District 4 CCTV record.
// Sources: CWWP2 JSON feed (primary) + ArcGIS FeatureServer layer (cross-check).
// Output: scripts/cameras/out/d4-all.json (gitignored). Zero dependencies (Node 18+, global fetch).
//
// Usage: node scripts/cameras/discover.mjs [--no-gis] [--feed <path-to-local-json>]
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, 'out/d4-all.json');
const FEED_URL = 'https://cwwp2.dot.ca.gov/data/d4/cctv/cctvStatusD04.json';
const GIS_URL = 'https://caltrans-gis.dot.ca.gov/arcgis/rest/services/CHhighway/CCTV/FeatureServer/0/query';
const UA = 'fnab-camera-research/1.0 (hackathon game; polite, low-rate)';

const num = (v) => {
  if (v === undefined || v === null || v === '' || /not reported/i.test(String(v))) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v) => (v === undefined || v === null || /^not reported$/i.test(String(v).trim()) ? '' : String(v).trim());
const url = (v) => {
  const s = str(v);
  return /^https?:\/\//i.test(s) ? s : null;
};

/** "TV102 -- I-580 : West of SR-24" -> { code: "TV102", title: "I-580 : West of SR-24" } */
export function splitLocationName(locationName) {
  const m = /^\s*([A-Za-z0-9]+)\s*--\s*(.*)$/.exec(locationName || '');
  return m ? { code: m[1], title: m[2].trim() } : { code: null, title: (locationName || '').trim() };
}

export function normalizeFeedRecord(rec) {
  const c = rec.cctv ?? rec;
  const loc = c.location ?? {};
  const img = c.imageData ?? {};
  const st = img.static ?? {};
  const { code, title } = splitLocationName(loc.locationName);
  const ts = c.recordTimestamp ?? {};
  const epoch = num(ts.recordEpoch);
  return {
    index: str(c.index),
    code, // e.g. "TV102"
    locationName: str(loc.locationName),
    title,
    district: num(loc.district),
    nearbyPlace: str(loc.nearbyPlace),
    county: str(loc.county),
    route: str(loc.route),
    routeSuffix: str(loc.routeSuffix),
    direction: str(loc.direction) || null,
    postmile: num(loc.postmile),
    milepost: num(loc.milepost),
    lat: num(loc.latitude),
    lon: num(loc.longitude),
    elevationFt: num(loc.elevation),
    inService: String(c.inService).toLowerCase() === 'true',
    inServiceRaw: str(c.inService),
    imageDescription: str(img.imageDescription),
    imageUrl: url(st.currentImageURL),
    imageUpdateFrequencyMin: num(st.currentImageUpdateFrequency),
    streamUrl: url(img.streamingVideoURL),
    recordedAt: epoch ? new Date(epoch * 1000).toISOString() : null,
    source: 'cwwp2',
  };
}

export function normalizeGisFeature(f) {
  const a = f.attributes ?? {};
  return {
    index: str(a.index_),
    code: splitLocationName(a.locationName).code,
    locationName: str(a.locationName),
    lat: num(a.latitude ?? f.geometry?.y),
    lon: num(a.longitude ?? f.geometry?.x),
    inService: String(a.inService).toLowerCase() === 'true',
    imageUrl: url(a.currentImageURL),
    streamUrl: url(a.streamingVideoURL),
  };
}

async function getJson(u, tries = 3) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(u, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(60000) });
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${u}`);
      return { json: await r.json(), headers: r.headers };
    } catch (e) {
      err = e;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw err;
}

async function fetchGis() {
  const feats = [];
  for (let offset = 0; ; offset += 500) {
    const q = new URLSearchParams({
      where: 'district=4', outFields: '*', returnGeometry: 'true', outSR: '4326', f: 'json',
      resultOffset: String(offset), resultRecordCount: '500', orderByFields: 'OBJECTID',
    });
    const { json } = await getJson(`${GIS_URL}?${q}`);
    if (json.error) throw new Error('ArcGIS error: ' + JSON.stringify(json.error));
    feats.push(...(json.features ?? []));
    if (!json.exceededTransferLimit && (json.features ?? []).length < 500) break;
  }
  return feats.map(normalizeGisFeature);
}

async function main() {
  const args = process.argv.slice(2);
  const noGis = args.includes('--no-gis');
  const feedIdx = args.indexOf('--feed');
  let feed, feedMeta = {};
  if (feedIdx >= 0) {
    feed = JSON.parse(await readFile(args[feedIdx + 1], 'utf8'));
  } else {
    const r = await getJson(FEED_URL);
    feed = r.json;
    feedMeta = { lastModified: r.headers.get('last-modified'), fetchedAt: new Date().toISOString() };
  }
  const cams = (feed.data ?? []).map(normalizeFeedRecord);
  let gis = null, gisOnly = [], feedOnly = [];
  if (!noGis) {
    try {
      gis = await fetchGis();
      const gi = new Map(gis.map((g) => [g.index, g]));
      const fi = new Map(cams.map((c) => [c.index, c]));
      for (const c of cams) {
        const g = gi.get(c.index);
        c.inGisLayer = !!g;
        if (!g) feedOnly.push(c.index);
        else if (g.imageUrl !== c.imageUrl) c.gisImageUrlDiffers = true;
      }
      gisOnly = gis.filter((g) => !fi.has(g.index)).map((g) => g.index);
    } catch (e) {
      console.error('ArcGIS cross-check failed (continuing with feed only):', e.message);
    }
  }
  const summary = {
    fetchedAt: new Date().toISOString(),
    feedUrl: FEED_URL, feedMeta,
    feedCount: cams.length,
    inService: cams.filter((c) => c.inService).length,
    withImage: cams.filter((c) => c.imageUrl).length,
    withStream: cams.filter((c) => c.streamUrl).length,
    inServiceWithImageAndStream: cams.filter((c) => c.inService && c.imageUrl && c.streamUrl).length,
    gisCount: gis ? gis.length : null,
    feedOnlyIndexes: feedOnly.length, gisOnlyIndexes: gisOnly.length,
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify({ summary, cameras: cams }, null, 1));
  console.log(JSON.stringify(summary, null, 2));
  console.log(`wrote ${OUT}`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('discover.mjs')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
