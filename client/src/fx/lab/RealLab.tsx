// Real-footage harness: composites manifestations over REAL Caltrans imagery fetched live by the browser
// (current snapshot, the 15-minute history frames Caltrans publishes next to it, or live HLS video).
// Nothing is saved: images are requested straight from cwwp2.dot.ca.gov / wzmedia.dot.ca.gov (CORS *).
//
//   fxlab.html?real=1&kind=figure&s=0.5&region=all&hist=0&per=12&page=0&aspect=native&boxes=1&phase=0.35
//   fxlab.html?real=1&live=1&kind=figure&s=0.9            (live HLS for live-capable cameras)
//   fxlab.html?real=1&perf=1&kind=figure                  (perf layout: 1 main + 12 bank tiles)
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type Hls from 'hls.js';
import { CAMERAS, usableStreamUrl } from '@fnab/shared';
import { FeedFxOverlay, getFxPerfStats, resetFxPerfStats, setFxReducedMotion, type FeedFxParams, type MonsterManifestation, type PlacementRegion } from '../index';
import { FX_FONT_MONO } from '../core/fonts';
import { setFxClock } from '../core/settings';
import { silhouetteFlashes } from '../monster/manifest';
import { loadedSpriteCount } from '../monster/sprites';
import { looksUnavailable } from '../../feeds/sourceUtils';
import { SceneProber } from '../monster/grade';

type Kind = MonsterManifestation['kind'] | 'none';

const q = new URLSearchParams(window.location.search);
const num = (k: string, d: number) => (q.has(k) && q.get(k) !== '' ? Number(q.get(k)) : d);

// Same CSS grading the game applies to stills / video (client/src/feeds).
const IMG_FILTER = 'grayscale(0.35) contrast(1.08) brightness(0.9)';
const VIDEO_FILTER = 'grayscale(0.3) contrast(1.05)';

/** Caltrans publishes 12 history frames (15 min apart) next to every snapshot: .../previous/<slug>-N.jpg */
export function historyUrl(imageUrl: string, n: number): string {
  if (n <= 0) return imageUrl;
  const dir = imageUrl.slice(0, imageUrl.lastIndexOf('/'));
  const slug = dir.slice(dir.lastIndexOf('/') + 1);
  return `${dir}/previous/${slug}-${n}.jpg`;
}

const DURATION = 8000;
function phaseFor(kind: Kind, m: MonsterManifestation): number {
  if (q.has('phase')) return num('phase', 0.5) * m.durationMs;
  if (kind === 'silhouette') {
    const f = silhouetteFlashes(m);
    const pick = f[Math.min(f.length - 1, num('flash', 1))];
    return pick ? pick[0] + Math.min(30, pick[1] / 2) : m.durationMs * 0.5;
  }
  if (kind === 'figure') return m.durationMs * 0.35;
  return m.durationMs * 0.5;
}

interface Cell {
  key: string;
  camId: string;
  name: string;
  url: string;
  stream: string | null;
  placement: PlacementRegion[];
  region: number;
  seed: number;
  /** 'day' | 'night' | history index; resolved to a concrete frame before render */
  hist: string;
  /** resolved frame is daylit (sky check); null for live video */
  daylit?: boolean | null;
}

/** Pick, per camera, the brightest real frame (day) or the current/darkest real one (night). Polite: 4 at a time. */
async function resolveFrames(cells: Cell[]): Promise<Map<string, { url: string; day: boolean }>> {
  const out = new Map<string, { url: string; day: boolean }>();
  const fixed = new Map((q.get('histmap') ?? '').split(',').filter(Boolean).map((e) => e.split(':') as [string, string]));
  const jobs: Array<() => Promise<void>> = [];
  const want = new Map<string, Set<string>>();
  for (const c of cells) {
    if (!want.has(c.camId)) want.set(c.camId, new Set());
    want.get(c.camId)!.add(c.hist);
  }
  const stats = new Map<string, { n: number; lum: number; day: boolean; ok: boolean; blob: string }[]>();
  const measure = async (camId: string, base: string, n: number) => {
    try {
      const r = await fetch(historyUrl(base, n), { mode: 'cors', cache: 'no-store' });
      if (!r.ok) return;
      const blob = URL.createObjectURL(await r.blob());
      const img = new Image();
      img.src = blob;
      await img.decode();
      const cv = document.createElement('canvas');
      cv.width = 40;
      cv.height = 32;
      const g = cv.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(img, 0, 0, 40, 32);
      const d = g.getImageData(0, 0, 40, 32).data;
      let sum = 0;
      let sky = 0;
      for (let i = 0; i < d.length; i += 4) {
        const v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        sum += v;
        if (i < 40 * 12 * 4) sky += v;
      }
      const list = stats.get(camId) ?? [];
      const lum = sum / (1280 * 255);
      // the "Temporarily Unavailable" card has text on white, so it can slip past the 85%-white test: also reject
      // anything that bright overall (no real CCTV frame averages > 0.72)
      // daylit = the upper frame (sky / distance) is bright, not just a floodlit road
      list.push({ n, lum, day: sky / (480 * 255) > 0.3, ok: !looksUnavailable(d, 40, 32) && lum < 0.72, blob });
      stats.set(camId, list);
    } catch {
      /* skip */
    }
  };
  for (const [camId, hs] of want) {
    const rec = CAMERAS.find((c) => c.id === camId)!;
    const base = rec.imageUrl!;
    const ns = new Set<number>();
    for (const h of hs) {
      const f = fixed.get(camId);
      if (f !== undefined && (h === 'day' || h === 'night')) {
        const [d, nn] = f.split('/');
        ns.add(Number(h === 'day' ? d : (nn ?? 0)));
      } else if (h === 'day') for (let n = 0; n <= 12; n++) ns.add(n);
      else if (h === 'night') {
        ns.add(0);
        ns.add(1);
      } else ns.add(Number(h));
    }
    for (const n of ns) jobs.push(() => measure(camId, base, n));
  }
  let next = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < jobs.length) await jobs[next++]();
    }),
  );
  const chosen: string[] = [];
  for (const [camId, hs] of want) {
    const list = (stats.get(camId) ?? []).filter((e) => e.ok);
    const f = fixed.get(camId);
    for (const h of hs) {
      let pick: (typeof list)[number] | undefined;
      if (h === 'day') {
        const wantN = f ? Number(f.split('/')[0]) : null;
        pick = wantN !== null ? list.find((e) => e.n === wantN) : [...list].sort((a, b) => b.lum - a.lum)[0];
      } else if (h === 'night') {
        const wantN = f ? Number(f.split('/')[1] ?? 0) : null;
        pick = wantN !== null ? list.find((e) => e.n === wantN) : (list.find((e) => e.n === 0) ?? [...list].sort((a, b) => a.lum - b.lum)[0]);
      } else pick = list.find((e) => e.n === Number(h));
      if (pick) out.set(`${camId}|${h}`, { url: pick.blob, day: pick.day });
      if (h === 'day' && pick) chosen.push(`${camId}:${pick.n}`);
    }
  }
  (window as unknown as { __histmap: string }).__histmap = chosen.join(',');
  return out;
}

function buildCells(): Cell[] {
  const histQ = q.get('hist') ?? '0';
  const hists = q.get('pair') === '1' ? ['day', 'night'] : [histQ];
  const only = q.get('cams')?.split(',').filter(Boolean) ?? null;
  const regionQ = q.get('region') ?? 'all';
  const cells: Cell[] = [];
  // ?placejson={"d4-x":[...]} overrides placement (before/after comparisons with older boxes)
  let override: Record<string, PlacementRegion[]> = {};
  try {
    override = JSON.parse(q.get('placejson') ?? '{}') as Record<string, PlacementRegion[]>;
  } catch {
    /* ignore */
  }
  CAMERAS.forEach((c0, ci) => {
    const c = override[c0.id] ? { ...c0, placement: override[c0.id] } : c0;
    if (!c.imageUrl) return;
    if (only && !only.includes(c.id)) return;
    const regions = regionQ === 'all' ? c.placement.map((_, i) => i) : [Number(regionQ) % Math.max(1, c.placement.length)];
    for (const r of regions) for (const hist of hists) {
      cells.push({
        key: `${c.id}-${r}-${hist}`,
        hist,
        camId: c.id,
        name: c.name,
        url: '',
        stream: usableStreamUrl(c),
        placement: c.placement,
        region: r,
        seed: num('seed', 1000 + ci * 17 + r * 5),
      });
    }
  });
  if (q.get('live') === '1') return cells.filter((c) => c.stream && (only || c.region === 0)).slice(0, num('maxlive', 6));
  const per = num('per', 0);
  return per > 0 ? cells.slice(num('page', 0) * per, (num('page', 0) + 1) * per) : cells;
}

function useHlsVideo(url: string | null) {
  const ref = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState('idle');
  useEffect(() => {
    const v = ref.current;
    if (!v || !url) return;
    let hls: Hls | null = null;
    let dead = false;
    setState('loading');
    void import('hls.js').then(({ default: H }) => {
      if (dead) return;
      if (H.isSupported()) {
        hls = new H({ liveSyncDuration: 15, maxBufferLength: 20 });
        hls.on(H.Events.ERROR, (_e, d) => d.fatal && setState(`error:${d.details}`));
        hls.loadSource(url);
        hls.attachMedia(v);
      } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
        v.src = url;
      } else setState('unsupported');
      v.play().catch(() => undefined);
    });
    const onPlay = () => setState('playing');
    v.addEventListener('playing', onPlay);
    return () => {
      dead = true;
      v.removeEventListener('playing', onPlay);
      hls?.destroy();
    };
  }, [url]);
  return { ref, state };
}

function BoxOverlay({ placement, active, imgRect }: { placement: PlacementRegion[]; active: number; imgRect: { x: number; y: number; w: number; h: number } }) {
  return (
    <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 5 }} viewBox="0 0 100 100" preserveAspectRatio="none">
      {placement.map((r, i) => (
        <rect
          key={i}
          x={imgRect.x + r.x * imgRect.w}
          y={imgRect.y + r.y * imgRect.h}
          width={r.w * imgRect.w}
          height={r.h * imgRect.h}
          fill="none"
          stroke={i === active ? '#ff3b4a' : '#3bc6d6'}
          strokeWidth={0.5}
          vectorEffect="non-scaling-stroke"
          strokeDasharray={i === active ? undefined : '2 2'}
        />
      ))}
      {placement.map((r, i) => (
        <text key={`t${i}`} x={imgRect.x + r.x * imgRect.w + 0.8} y={imgRect.y + r.y * imgRect.h + 4} fontSize={4} fill={i === active ? '#ff3b4a' : '#3bc6d6'} style={{ fontFamily: 'monospace' }}>
          {i}
        </text>
      ))}
      {q.get('grid') === '1'
        ? Array.from({ length: 9 }, (_, k) => (k + 1) / 10).map((g) => (
            <g key={g} stroke="rgba(255,255,0,0.35)" strokeWidth={0.3}>
              <line x1={imgRect.x + g * imgRect.w} x2={imgRect.x + g * imgRect.w} y1={0} y2={100} vectorEffect="non-scaling-stroke" />
              <line y1={imgRect.y + g * imgRect.h} y2={imgRect.y + g * imgRect.h} x1={0} x2={100} vectorEffect="non-scaling-stroke" />
            </g>
          ))
        : null}
      <line x1={0} x2={100} y1={imgRect.y + 0.905 * imgRect.h} y2={imgRect.y + 0.905 * imgRect.h} stroke="#f3d28d" strokeWidth={0.4} vectorEffect="non-scaling-stroke" strokeDasharray="1 2" />
    </svg>
  );
}

function RealTile({ cell, params, width, aspect, live, boxes, onLoad, label }: { cell: Cell; params: FeedFxParams; width: number; aspect: number; live: boolean; boxes: boolean; onLoad: () => void; label: boolean }) {
  const { ref, state } = useHlsVideo(live ? cell.stream : null);
  const tileAspect = aspect;
  const imgAspect = live ? 655 / 480 : 320 / 260;
  // object-cover mapping of the image inside the tile, in % of the tile
  const imgRect =
    imgAspect > tileAspect
      ? { w: (imgAspect / tileAspect) * 100, h: 100, x: (100 - (imgAspect / tileAspect) * 100) / 2, y: 0 }
      : { w: 100, h: (tileAspect / imgAspect) * 100, x: 0, y: (100 - (tileAspect / imgAspect) * 100) / 2 };
  const fill: CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' };
  const [dbg, setDbg] = useState('');
  const probeOnce = (el: HTMLImageElement | HTMLVideoElement) => {
    if (q.get('dbg') !== '1') return;
    const nw = el instanceof HTMLImageElement ? el.naturalWidth : el.videoWidth;
    const nh = el instanceof HTMLImageElement ? el.naturalHeight : el.videoHeight;
    const pr = new SceneProber().update(el, nw, nh, performance.now(), true);
    if (pr) setDbg(` · L${pr.mean.toFixed(2)} p50 ${pr.p50.toFixed(2)} day${pr.dayness.toFixed(2)} fog${pr.fog.toFixed(2)} sh${pr.sharp.toFixed(2)} n${pr.noise.toFixed(3)}`);
  };
  return (
    <div style={{ width }}>
      <div style={{ position: 'relative', width, aspectRatio: String(tileAspect), background: '#000', overflow: 'hidden' }} data-cell={cell.key}>
        {live ? (
          <video ref={ref} muted playsInline autoPlay data-fx-source="" style={{ ...fill, filter: VIDEO_FILTER }} onLoadedData={(e) => { onLoad(); probeOnce(e.currentTarget); }} />
        ) : (
          <img crossOrigin="anonymous" src={cell.url} alt="" data-fx-source="" data-fx-daylight={cell.daylit === true ? '1' : cell.daylit === false ? '0' : undefined} style={{ ...fill, filter: IMG_FILTER }} onLoad={(e) => { onLoad(); probeOnce(e.currentTarget); }} onError={onLoad} />
        )}
        <FeedFxOverlay params={params} />
        {boxes ? <BoxOverlay placement={cell.placement} active={cell.region} imgRect={imgRect} /> : null}
      </div>
      {label ? (
        <div style={{ fontFamily: FX_FONT_MONO, fontSize: 10, color: '#9aa3ab', padding: '2px 0 4px', whiteSpace: 'nowrap', overflow: 'hidden' }}>
          {cell.camId} r{cell.region} sc{cell.placement[cell.region]?.scale ?? '-'} {cell.hist}{cell.daylit === false && cell.hist === 'day' ? '(no daylight frame)' : ''} · {cell.name.split(':').pop()?.trim()}
          {live ? ` · ${state}` : ''}
          {dbg ? <div>{dbg}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

export function RealLab() {
  const raw = useMemo(buildCells, []);
  const [cells, setCells] = useState<Cell[] | null>(null);
  useEffect(() => {
    void resolveFrames(raw).then((m) =>
      setCells(
        raw
          .map((c) => {
            const r = m.get(`${c.camId}|${c.hist}`);
            return { ...c, url: r?.url ?? '', daylit: r?.day ?? null };
          })
          .filter((c) => c.url || q.get('live') === '1'),
      ),
    );
  }, [raw]);
  if (!cells) return <div style={{ color: '#3bc6d6', fontFamily: FX_FONT_MONO, padding: 10 }}>resolving real frames…</div>;
  return <RealSheet cells={cells} />;
}

function RealSheet({ cells }: { cells: Cell[] }) {
  const kind = (q.get('kind') as Kind) ?? 'figure';
  const strength = num('s', 0.5);
  const live = q.get('live') === '1';
  const perfMode = q.get('perf') === '1';
  const width = num('w', perfMode ? 220 : 300);
  const aspect = q.get('aspect') === '16/9' ? 16 / 9 : q.get('aspect') === '4/3' ? 4 / 3 : live ? 655 / 480 : 320 / 260;
  const boxes = q.get('boxes') === '1';
  const variant = (q.get('variant') as 'thumb' | 'main') ?? 'main';
  const frozen = q.get('freeze') !== '0' && !perfMode;
  const [loaded, setLoaded] = useState(0);
  const [T0] = useState(() => Date.now());

  useEffect(() => setFxReducedMotion(q.get('reduced') === '1' ? true : null), []);
  const manifests = useMemo(
    () =>
      cells.map((c): MonsterManifestation | null =>
        kind === 'none' ? null : { kind, strength, regionIndex: c.region, startedAt: 0, durationMs: num('dur', DURATION), seed: c.seed },
      ),
    [cells, kind, strength],
  );
  // Frozen clock: every tile is shown at the same, chosen point of its own timeline.
  const offsets = useMemo(() => manifests.map((m) => (m ? phaseFor(kind, m) : 0)), [manifests, kind]);
  useEffect(() => {
    if (!frozen) return;
    setFxClock(() => T0);
    return () => setFxClock(null);
  }, [frozen, T0]);
  const [loopAt, setLoopAt] = useState(T0);
  useEffect(() => {
    if (frozen || kind === 'none') return;
    const id = window.setInterval(() => setLoopAt(Date.now()), num('dur', DURATION) + 600);
    return () => window.clearInterval(id);
  }, [frozen, kind]);

  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__real = {
      cells: perfMode ? Math.min(13, cells.length) : cells.length,
      loaded: () => loaded,
      sprites: () => loadedSpriteCount(),
      getFxPerfStats,
      resetFxPerfStats,
    };
  }, [cells.length, loaded]);

  const paramsFor = (c: Cell, i: number, v: 'thumb' | 'main'): FeedFxParams => {
    const m = manifests[i];
    return {
      cameraId: c.camId,
      seed: 7 + i,
      sourceMode: live ? 'live' : 'snapshot',
      gameStatus: 'ok',
      interference: num('i', 0),
      manifestation: m ? { ...m, startedAt: frozen ? T0 - offsets[i] : loopAt } : null,
      placement: c.placement,
      variant: v,
    };
  };
  const onLoad = () => setLoaded((n) => n + 1);

  if (perfMode) {
    // 1 main (~1000 px) + 12 bank tiles, every one with an active manifestation and the real clock.
    const main = cells[0];
    const bank = cells.slice(1, 13);
    return (
      <div style={{ background: '#050607', minHeight: '100vh', padding: 8, display: 'grid', gap: 8, gridTemplateColumns: '1000px 1fr' }}>
        {main ? <RealTile cell={main} params={paramsFor(main, 0, 'main')} width={1000} aspect={16 / 9} live={live} boxes={false} onLoad={onLoad} label={false} /> : null}
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(3, ${width}px)`, gap: 4, alignContent: 'start' }}>
          {bank.map((c, i) => (
            <RealTile key={c.key} cell={c} params={paramsFor(c, i + 1, 'thumb')} width={width} aspect={16 / 10} live={live && i < 2} boxes={false} onLoad={onLoad} label={false} />
          ))}
        </div>
      </div>
    );
  }

  const cols = num('cols', 4);
  return (
    <div style={{ background: '#050607', minHeight: '100vh', padding: 6, boxSizing: 'border-box' }}>
      <div style={{ fontFamily: FX_FONT_MONO, fontSize: 11, color: '#3bc6d6', padding: '0 0 4px' }}>
        REAL FOOTAGE · {kind} s{strength} · {live ? 'live HLS' : `snapshot ${q.get('pair') === '1' ? 'day|night' : (q.get('hist') ?? 'current')}`} · {cells.length} cells
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, ${width}px)`, gap: 6 }}>
        {cells.map((c, i) => (
          <RealTile key={c.key} cell={c} params={paramsFor(c, i, variant)} width={width} aspect={aspect} live={live} boxes={boxes} onLoad={onLoad} label />
        ))}
      </div>
    </div>
  );
}
