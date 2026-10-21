// Geographic map mode (MapLibre GL). One map instance per mount; state ticks never recreate it — every
// gameplay layer is a GeoJSON source updated with setData only when its content signature changes.
// Basemap: OpenFreeMap vector tiles restyled to the game palette (see geoStyle.ts for terms/attribution).
// Offline: the basemap source errors → a small note appears; markers, edges and all game layers keep working.
import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Map as MLMap, Marker, setWorkerUrl, type GeoJSONSource, type MapLayerMouseEvent, type MapSourceDataEvent } from 'maplibre-gl';
// MapLibre 6 resolves its worker relative to its own module URL, which Vite's dep pre-bundling breaks:
// hand it the emitted worker asset explicitly.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import type { Feature, FeatureCollection } from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { HqId } from '@fnab/shared';
import { graph, NETWORK } from '../lib/data';
import { useGame } from '../state/store';
import { approachShort, attackPathsFrom, HQ_BY_ID, HQ_SHORT, hopsToHq, NODE_BY_ID, type XY } from './derive';
import { buildStyle, type GameSource } from './geoStyle';
import { resolveTheme, SENSOR_RADIUS_HOPS, type MapLayers, type MapProps, type MapTheme } from './layers';
import { PALETTES, SEM } from './theme';
import { NodeTooltip } from './TacticalMap';
import { useMonsterMotion } from './useMonsterMotion';
import './map.css';

type LngLat = [number, number];
const fc = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
const pt = (c: LngLat, properties: Record<string, unknown> = {}): Feature => ({ type: 'Feature', properties, geometry: { type: 'Point', coordinates: c } });
const ln = (cs: LngLat[], properties: Record<string, unknown> = {}): Feature => ({ type: 'Feature', properties, geometry: { type: 'LineString', coordinates: cs } });

const ll = (id: string | null | undefined): LngLat => {
  const n = id ? NODE_BY_ID.get(id) : undefined;
  return n ? [n.lon, n.lat] : [-122.3, 37.7];
};

const EXTENT = (() => {
  const lons = [...NETWORK.nodes.map((n) => n.lon), ...NETWORK.headquarters.map((h) => h.lon)];
  const lats = [...NETWORK.nodes.map((n) => n.lat), ...NETWORK.headquarters.map((h) => h.lat)];
  return { w: Math.min(...lons), e: Math.max(...lons), s: Math.min(...lats), n: Math.max(...lats) };
})();
const FIT: [LngLat, LngLat] = [
  [EXTENT.w - 0.04, EXTENT.s - 0.03],
  [EXTENT.e + 0.04, EXTENT.n + 0.03],
];
const MAX_BOUNDS: [LngLat, LngLat] = [
  [EXTENT.w - 0.9, EXTENT.s - 0.6],
  [EXTENT.e + 0.9, EXTENT.n + 0.6],
];

setWorkerUrl(workerUrl);

const EDGES_FC = fc(
  NETWORK.edges.map((e) => ln([ll(e.a), ll(e.b)], { id: e.id, kind: e.kind, route: e.route, km: e.lengthKm })),
);

/** Rounded hull around an HQ and its approach nodes in a local metric frame (≈1.3 km margin). */
function zoneFeature(hqId: string): Feature | null {
  const h = HQ_BY_ID.get(hqId as HqId);
  if (!h) return null;
  const k = Math.cos((h.lat * Math.PI) / 180);
  const anchors: XY[] = [{ x: h.lon * k, y: h.lat }, ...h.approaches.map((a) => ({ x: ll(a.fromNode)[0] * k, y: ll(a.fromNode)[1] }))];
  const r = 0.012;
  const pts: XY[] = [];
  for (const a of anchors) for (let i = 0; i < 24; i++) pts.push({ x: a.x + Math.cos((i / 24) * 2 * Math.PI) * r, y: a.y + Math.sin((i / 24) * 2 * Math.PI) * r });
  pts.sort((p, q) => p.x - q.x || p.y - q.y);
  const cross = (o: XY, a: XY, b: XY) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo: XY[] = [], up: XY[] = [];
  for (const p of pts) {
    while (lo.length >= 2 && cross(lo[lo.length - 2]!, lo[lo.length - 1]!, p) <= 0) lo.pop();
    lo.push(p);
  }
  for (const p of [...pts].reverse()) {
    while (up.length >= 2 && cross(up[up.length - 2]!, up[up.length - 1]!, p) <= 0) up.pop();
    up.push(p);
  }
  const ring = [...lo.slice(0, -1), ...up.slice(0, -1)].map((p) => [p.x / k, p.y] as LngLat);
  ring.push(ring[0]!);
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
}

/** Screen-space door offsets around the HQ marker (px), spread so they never stack. */
function doorOffsets(hqId: string): Map<string, { dx: number; dy: number; angle: number }> {
  const h = HQ_BY_ID.get(hqId as HqId)!;
  const k = Math.cos((h.lat * Math.PI) / 180);
  const items = h.approaches
    .map((ap) => {
      const [lon, lat] = ll(ap.fromNode);
      return { id: ap.id, a: Math.atan2(-(lat - h.lat), (lon - h.lon) * k) };
    })
    .sort((x, y) => x.a - y.a);
  const SEP = (62 * Math.PI) / 180;
  for (let it = 0; it < 60; it++)
    for (let i = 1; i < items.length; i++) {
      const d = items[i]!.a - items[i - 1]!.a;
      if (d < SEP) {
        items[i - 1]!.a -= (SEP - d) / 2;
        items[i]!.a += (SEP - d) / 2;
      }
    }
  return new Map(items.map((i) => [i.id, { dx: Math.cos(i.a) * 30, dy: Math.sin(i.a) * 30, angle: i.a }]));
}

function doorInfo(p: MapLayers, id: string, theme: MapTheme) {
  const d = p.doors?.[id];
  const closed = d?.closed ?? p.doorClosed?.[id];
  const known = d !== undefined || closed !== undefined || theme === 'defender';
  return { closed: !!closed, jammed: !!d?.jammed, battering: !!d?.battering, known };
}

export default function GeoMap(props: MapProps) {
  const theme = resolveTheme(props);
  const P = PALETTES[theme];
  const rootRef = useRef<HTMLDivElement>(null);
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const readyRef = useRef(false);
  const sigs = useRef<Partial<Record<GameSource, string>>>({});
  const pending = useRef<Partial<Record<GameSource, FeatureCollection>>>({});
  const markers = useRef<{ hq: Marker[]; labels: Map<string, { m: Marker; el: HTMLDivElement }>; doors: Marker[]; monster: Marker | null }>({
    hq: [],
    labels: new Map(),
    doors: [],
    monster: null,
  });
  const [basemap, setBasemap] = useState<'loading' | 'ok' | 'down'>('loading');
  const [hover, setHover] = useState<string | null>(null);
  const [edgeTip, setEdgeTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const [, setCam] = useState(0);
  const [size, setSize] = useState({ w: 600, h: 500 });
  const [zoomed, setZoomed] = useState(false);
  const sources = useGame((s) => s.cameraStatuses);
  const latest = useRef(props);
  latest.current = props;
  const hoverRef = useRef<string | null>(null);

  // ---- create the map once ----
  useEffect(() => {
    if (!mapEl.current) return;
    const map = new MLMap({
      container: mapEl.current,
      style: buildStyle(theme),
      bounds: FIT,
      fitBoundsOptions: { padding: 24 },
      maxBounds: MAX_BOUNDS,
      minZoom: 7.5,
      maxZoom: 16,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      attributionControl: { compact: true },
      fadeDuration: 0,
    });
    map.touchZoomRotate.disableRotation();
    mapRef.current = map;
    if (import.meta.env.DEV) (window as unknown as { __fnabGeo?: MLMap }).__fnabGeo = map;
    const onReady = () => {
      readyRef.current = true;
      for (const [k, v] of Object.entries(pending.current)) (map.getSource(k) as GeoJSONSource | undefined)?.setData(v!);
      pending.current = {};
    };
    map.on('style.load', onReady);
    if (map.isStyleLoaded()) onReady();
    let tilesSeen = false;
    map.on('sourcedata', (e: MapSourceDataEvent) => {
      if (e.sourceId === 'ofm' && e.tile) tilesSeen = true;
    });
    map.on('idle', () => {
      try {
        if (tilesSeen && map.isSourceLoaded('ofm')) setBasemap('ok');
      } catch {
        /* source missing */
      }
    });
    map.on('error', (e: unknown) => {
      const msg = String((e as { error?: Error }).error?.message ?? '');
      if (import.meta.env.DEV) console.warn('[GeoMap]', msg);
      if ((e as { sourceId?: string }).sourceId === 'ofm' || msg.includes('openfreemap')) setBasemap((b) => (b === 'ok' ? b : 'down'));
    });
    const timer = setTimeout(() => setBasemap((b) => (b === 'loading' ? 'down' : b)), 12_000);
    map.on('move', () => setCam((c) => c + 1));
    const onZoom = () => setZoomed(map.getZoom() >= 10.4);
    map.on('zoom', onZoom);
    map.once('load', onZoom);
    // interaction
    map.on('mousemove', 'g-node-hit', (e: MapLayerMouseEvent) => {
      const id = e.features?.[0]?.properties?.id as string | undefined;
      if (id && id !== hoverRef.current) {
        hoverRef.current = id;
        setHover(id);
        latest.current.onNodeHover?.(id);
      }
      map.getCanvas().style.cursor = latest.current.onNodeClick ? 'pointer' : 'default';
    });
    map.on('mouseleave', 'g-node-hit', () => {
      hoverRef.current = null;
      setHover(null);
      latest.current.onNodeHover?.(null);
      map.getCanvas().style.cursor = '';
    });
    map.on('click', 'g-node-hit', (e: MapLayerMouseEvent) => {
      const id = e.features?.[0]?.properties?.id as string | undefined;
      if (id) latest.current.onNodeClick?.(id);
    });
    map.on('mousemove', 'g-edge-hit', (e: MapLayerMouseEvent) => {
      if (hoverRef.current) return setEdgeTip(null);
      const f = e.features?.[0]?.properties;
      if (f) setEdgeTip({ x: e.point.x, y: e.point.y, text: `${f.route} · ${f.km} km` });
    });
    map.on('mouseleave', 'g-edge-hit', () => setEdgeTip(null));

    const ro = new ResizeObserver(() => {
      map.resize();
      const r = rootRef.current?.getBoundingClientRect();
      if (r) setSize({ w: r.width, h: r.height });
    });
    if (rootRef.current) ro.observe(rootRef.current);
    return () => {
      clearTimeout(timer);
      ro.disconnect();
      markers.current.hq.forEach((m) => m.remove());
      markers.current.doors.forEach((m) => m.remove());
      markers.current.labels.forEach((l) => l.m.remove());
      markers.current.monster?.remove();
      markers.current = { hq: [], labels: new Map(), doors: [], monster: null };
      readyRef.current = false;
      sigs.current = {};
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // theme switch: diff the style in place (no new context), then re-push data
  const themeRef = useRef(theme);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || themeRef.current === theme) return;
    themeRef.current = theme;
    map.setStyle(buildStyle(theme), { diff: true });
    sigs.current = {};
  }, [theme]);

  const push = (src: GameSource, data: FeatureCollection, sig: string) => {
    if (sigs.current[src] === sig) return;
    sigs.current[src] = sig;
    const map = mapRef.current;
    const s = map && readyRef.current ? (map.getSource(src) as GeoJSONSource | undefined) : undefined;
    if (s) s.setData(data);
    else pending.current[src] = data;
  };

  // ---- derived layer data (cheap; pushed only on change) ----
  const hqs = props.allHqs ? NETWORK.headquarters : NETWORK.headquarters.filter((h) => h.id === props.hqId);
  const approachNodes = useMemo(() => new Set(hqs.flatMap((h) => h.approaches.map((a) => a.fromNode))), [props.allHqs, props.hqId]); // eslint-disable-line react-hooks/exhaustive-deps
  const hlColor = { cyan: SEM.cyan, monster: '#e04a62', warn: SEM.warn }[props.highlightTone ?? 'cyan'];
  const monsterOrigin = props.monster ? (props.monster.moving?.to ?? props.monster.nodeId) : null;

  useEffect(() => {
    push('g-edges', EDGES_FC, 'static');
  });

  // nodes
  {
    const st = props.cameraStatus ?? {};
    let sig = `${hlColor}|${hover}|`;
    const feats: Feature[] = NETWORK.nodes.map((n) => {
      const marks = props.marks?.[n.id] ?? [];
      const ring = marks.includes('spawn')
        ? '#e04a62'
        : marks.includes('sensor')
          ? SEM.cyan
          : marks.includes('knownSensor')
            ? SEM.warn
            : marks.includes('sensorOff')
              ? SEM.dim
              : '';
      const f = {
        id: n.id,
        name: n.name,
        status: st[n.id] ?? 'none',
        hl: props.highlight?.has(n.id) ? hlColor : '',
        sel: props.selectedNode === n.id,
        hover: hover === n.id,
        ap: approachNodes.has(n.id),
        ring,
        ringR: marks.includes('spawn') ? 10 : 9.5,
      };
      sig += `${f.status}${f.hl ? 1 : 0}${f.sel ? 1 : 0}${f.ap ? 1 : 0}${ring},`;
      return pt(ll(n.id), f);
    });
    push('g-nodes', fc(feats), sig);
  }

  // marks (traps NE, lures NW, centre rings), last known, held
  {
    const feats: Feature[] = [];
    let sig = '';
    for (const [n, marks] of Object.entries(props.marks ?? {})) {
      for (const m of marks) {
        sig += `${n}:${m},`;
        const c = ll(n);
        if (m === 'trap' || m === 'trapArming')
          feats.push(pt(c, { slot: 'ne', r: 3.6, c: SEM.alert, fo: m === 'trap' ? 1 : 0, sw: 1.4, so: 1 }));
        else if (m === 'lure') feats.push(pt(c, { slot: 'nw', r: 3.4, c: SEM.warn, fo: 1, sw: 0, so: 0 }));
        else if (m === 'exposure') feats.push(pt(c, { slot: 'c', r: 12, c: '#ff4d5e', fo: 0.05, sw: 1.2, so: 0.8 }));
        else if (m === 'disturbance') feats.push(pt(c, { slot: 'c', r: 15, c: SEM.warn, fo: 0.08, sw: 1.4, so: 0.8 }));
        else if (m === 'scanPulse') feats.push(pt(c, { slot: 'c', r: 14, c: SEM.cyan, fo: 0.04, sw: 1, so: 0.7 }));
      }
    }
    if (props.lastKnown) {
      sig += `lk:${props.lastKnown}`;
      feats.push(pt(ll(props.lastKnown), { slot: 'c', r: 15, c: '#ff4d5e', fo: 0.12, sw: 1.8, so: 0.95 }));
    }
    if (props.held) {
      sig += `held:${props.held}:${props.containmentProgress ?? ''}`;
      feats.push(pt(ll(props.held), { slot: 'c', r: 20, c: '#ff4d5e', fo: 0.12, sw: 2.4, so: 1 }));
      if (props.containmentProgress != null)
        feats.push(pt(ll(props.held), { slot: 'c', r: 25, c: SEM.ok, fo: 0, sw: 1 + 2.5 * props.containmentProgress, so: 0.9 }));
    }
    push('g-marks', fc(feats), sig);
  }

  // sightings
  {
    const feats: Feature[] = [];
    let sig = '';
    for (const s of props.sightings ?? []) {
      const o = Math.max(0.12, Math.pow(Math.max(0, 1 - s.age), 1.4));
      const sensor = s.source === 'sensor';
      const fresh = s.age < 0.03;
      feats.push(
        pt(ll(s.nodeId), {
          r: (sensor ? 20 : 9 + 6 * s.confidence) * (fresh ? 1.5 : 1),
          c: s.flagged ? '#7d8890' : sensor ? SEM.warn : '#ff3b4c',
          o: Math.round(o * 20) / 20,
          sw: fresh ? 2.4 : 1.4,
        }),
      );
      sig += `${s.id}:${Math.round(o * 20)}:${s.flagged ? 1 : 0}:${fresh ? 1 : 0},`;
    }
    push('g-sight', fc(feats), sig);
  }

  // rings + sensor tripwires
  {
    const rf: Feature[] = [];
    let rs = '';
    for (const r of props.rings ?? []) {
      const c = r.tone === 'cyan' ? SEM.cyan : r.tone === 'alert' ? SEM.alert : SEM.warn;
      for (const n of graph.within(r.nodeId, r.hops)) rf.push(pt(ll(n), { c }));
      rs += `${r.nodeId}:${r.hops}:${r.tone},`;
    }
    push('g-rings', fc(rf), rs);
    const tf: Feature[] = [];
    let ts = '';
    for (const [n, marks] of Object.entries(props.marks ?? {})) {
      const tone = marks.includes('sensor') ? SEM.cyan : marks.includes('knownSensor') ? SEM.warn : null;
      if (!tone) continue;
      ts += `${n}:${tone},`;
      for (const m of graph.within(n, SENSOR_RADIUS_HOPS)) {
        if (m === n) continue;
        const a = ll(n), b = ll(m);
        tf.push(ln([a, [a[0] + (b[0] - a[0]) * 0.7, a[1] + (b[1] - a[1]) * 0.7]], { c: tone }));
      }
    }
    push('g-trip', fc(tf), ts);
  }

  // routes: planned path, attack paths, next hops
  {
    const path = props.path ?? [];
    push('g-path', fc(path.length > 1 ? [ln(path.map(ll))] : []), path.join('>'));
    const atk = theme === 'monster' && props.attackPaths !== false && props.monster ? attackPathsFrom(monsterOrigin, props.hqId) : [];
    const h = props.hqId ? HQ_BY_ID.get(props.hqId) : undefined;
    push(
      'g-attack',
      fc(atk.map((a) => ln([...a.path.map(ll), h ? ([h.lon, h.lat] as LngLat) : ll(a.path.at(-1))]))),
      atk.map((a) => a.path.join('>')).join('|'),
    );
    const hops =
      theme === 'monster' && props.monster && props.highlight && props.highlightTone === 'monster' && monsterOrigin
        ? graph.neighbors(monsterOrigin).filter((n) => props.highlight!.has(n))
        : [];
    push(
      'g-hops',
      fc(hops.map((n) => {
        const a = ll(monsterOrigin), b = ll(n);
        return ln([a, [a[0] + (b[0] - a[0]) * 0.6, a[1] + (b[1] - a[1]) * 0.6]], { c: hlColor });
      })),
      `${monsterOrigin}:${hops.join(',')}`,
    );
  }

  // HQ zone, heat, spokes
  {
    const focus = props.allHqs ? null : props.hqId ?? null;
    const z = focus ? zoneFeature(focus) : null;
    push('g-zone', fc(z ? [z] : []), `${focus}`);
    let threat = props.threat ?? 0;
    if (props.threat === undefined && props.hqId)
      for (const s of props.sightings ?? [])
        if (!s.flagged) threat = Math.max(threat, (1 - s.age) * Math.max(0, 1 - hopsToHq(s.nodeId, props.hqId) / 4));
    const h = focus ? HQ_BY_ID.get(focus) : undefined;
    const tq = Math.round(threat * 10) / 10;
    push('g-heat', fc(h && tq > 0 ? [pt([h.lon, h.lat], { r: 40 + 60 * tq, o: 0.15 + 0.45 * tq })] : []), `${focus}:${tq}`);
    const spokes: Feature[] = [];
    let ss = '';
    for (const hq of hqs)
      for (const ap of hq.approaches) {
        const breach = props.breachApproachId === ap.id;
        const f = props.hqId === hq.id;
        spokes.push(
          ln([[hq.lon, hq.lat], ll(ap.fromNode)], { c: breach ? '#ff4d5e' : f ? P.hq : SEM.dim, o: breach ? 0.95 : f ? 0.5 : 0.35, w: breach ? 2.6 : 1.2 }),
        );
        ss += `${ap.id}${breach ? 'b' : ''}${f ? 'f' : ''},`;
      }
    push('g-spokes', fc(spokes), ss + theme);
  }

  // ---- DOM markers: HQs (+ doors) and node labels ----
  const hqSig = `${props.allHqs ? 'all' : props.hqId}|${props.hqId}|${!!props.onHqClick}|${theme}`;
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    markers.current.hq.forEach((m) => m.remove());
    markers.current.hq = [];
    for (const h of hqs) {
      const focus = props.hqId === h.id;
      const el = document.createElement('div');
      el.className = 'fm-geo-hq';
      el.dataset.hq = h.id;
      el.dataset.click = latest.current.onHqClick ? '1' : '0';
      el.style.color = focus ? P.hq : '#7b858d';
      el.style.setProperty('--fm-hq-fill', focus ? P.hqFill : '#101418');
      el.innerHTML = `<div class="fm-geo-hq-d"></div><div class="fm-geo-hq-n"></div>`;
      (el.lastChild as HTMLElement).textContent = props.allHqs ? h.name : (HQ_SHORT[h.id] ?? h.name);
      el.title = h.name;
      if (latest.current.onHqClick) {
        el.tabIndex = 0;
        el.setAttribute('role', 'button');
        el.setAttribute('aria-label', `Select ${h.name}`);
        const go = () => latest.current.onHqClick?.(h.id as HqId);
        el.addEventListener('click', go);
        el.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && go());
      }
      markers.current.hq.push(new Marker({ element: el }).setLngLat([h.lon, h.lat]).addTo(map));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hqSig]);

  const doorSig = props.allHqs || !props.hqId
    ? 'none'
    : HQ_BY_ID.get(props.hqId)!
        .approaches.map((a) => {
          const d = doorInfo(props, a.id, theme);
          return `${a.id}${d.closed ? 1 : 0}${d.jammed ? 'j' : ''}${d.battering ? 'x' : ''}${d.known ? 'k' : ''}${props.breachApproachId === a.id ? 'b' : ''}`;
        })
        .join(',') + theme;
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    markers.current.doors.forEach((m) => m.remove());
    markers.current.doors = [];
    if (props.allHqs || !props.hqId) return;
    const h = HQ_BY_ID.get(props.hqId)!;
    const offs = doorOffsets(h.id);
    for (const ap of h.approaches) {
      const o = offs.get(ap.id)!;
      const d = doorInfo(props, ap.id, theme);
      const breach = props.breachApproachId === ap.id;
      const col = breach ? '#ff4d5e' : d.jammed ? SEM.warn : d.closed ? SEM.ok : d.known ? P.nodeRingKey : SEM.dim;
      const state = breach ? ' BREACH' : d.jammed ? ' JAMMED' : d.closed && d.known ? ' SEALED' : '';
      const el = document.createElement('div');
      el.style.cssText = 'position:relative;width:0;height:0;pointer-events:none';
      const gate = document.createElement('div');
      gate.title = `${ap.door} · ${ap.label}`;
      gate.style.cssText = `position:absolute;left:${o.dx - 7}px;top:${o.dy - 3}px;width:14px;height:6px;border:1.3px solid ${col};background:${d.closed ? col : '#06080a'};transform:rotate(${(o.angle * 180) / Math.PI + 90}deg);box-shadow:0 0 8px ${col}55`;
      const lab = document.createElement('div');
      lab.className = 'fm-geo-door';
      const right = Math.cos(o.angle) >= -0.2;
      lab.style.cssText = `position:absolute;top:${o.dy + Math.sin(o.angle) * 10 - 5}px;${right ? `left:${o.dx + 10}px` : `right:${-o.dx + 10}px`};color:${col}`;
      lab.textContent = `${approachShort(ap).toUpperCase()}${state}`;
      el.append(gate, lab);
      markers.current.doors.push(new Marker({ element: el }).setLngLat([h.lon, h.lat]).addTo(map));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doorSig, props.hqId, props.allHqs]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const L = markers.current.labels;
    if (L.size === 0)
      for (const n of NETWORK.nodes) {
        const el = document.createElement('div');
        el.className = 'fm-geo-label';
        el.textContent = n.name;
        L.set(n.id, { el, m: new Marker({ element: el, anchor: 'bottom', offset: [0, -11] }).setLngLat(ll(n.id)).addTo(map) });
      }
  }, []);
  // label visibility: key nodes always, the rest once zoomed in
  for (const [id, { el }] of markers.current.labels) {
    const key = id === props.selectedNode || id === props.lastKnown || id === props.held || id === monsterOrigin;
    const show = key || zoomed;
    if (el.style.display !== (show ? '' : 'none')) el.style.display = show ? '' : 'none';
    const strong = id === props.selectedNode || id === monsterOrigin;
    el.classList.toggle('fm-strong', strong);
  }

  // ---- monster marker (DOM, moved per animation frame) ----
  const dummy = useRef<SVGGElement>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (props.monster && !markers.current.monster) {
      const el = document.createElement('div');
      el.className = 'fm-geo-monster';
      markers.current.monster = new Marker({ element: el }).setLngLat(ll(monsterOrigin)).addTo(map);
    }
    if (!props.monster && markers.current.monster) {
      markers.current.monster.remove();
      markers.current.monster = null;
    }
  });
  useMonsterMotion(
    props.monster,
    (from, to, p) => {
      const a = ll(from);
      if (!to) return { x: a[0], y: a[1] };
      const b = ll(to);
      return { x: a[0] + (b[0] - a[0]) * p, y: a[1] + (b[1] - a[1]) * p };
    },
    dummy,
    (q) => markers.current.monster?.setLngLat([q.x, q.y]),
  );

  // ---- tooltip position ----
  const map = mapRef.current;
  const tipXY = hover && map ? map.project(ll(hover)) : null;

  return (
    <div
      ref={rootRef}
      className={clsx('fm-geo relative h-full w-full overflow-hidden', props.className)}
      data-testid="geo-map"
      data-theme={theme}
      data-basemap={basemap}
      data-zoomed={zoomed ? '1' : '0'}
      style={{ background: theme === 'monster' ? '#100b0a' : '#0c1014' }}
    >
      <div ref={mapEl} style={{ position: 'absolute', inset: 0 }} />
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            theme === 'monster'
              ? 'radial-gradient(ellipse at 50% 45%, transparent 55%, rgba(12,2,3,0.5) 100%)'
              : 'radial-gradient(ellipse at 50% 45%, transparent 58%, rgba(0,3,5,0.45) 100%)',
        }}
      />
      {tipXY && hover && (
        <div className="fm-root pointer-events-none absolute inset-0">
          <NodeTooltip
            id={hover}
            theme={theme}
            x={tipXY.x}
            y={tipXY.y}
            W={size.w}
            H={size.h}
            props={props}
            sourceMode={NODE_BY_ID.get(hover)?.cameraId ? sources[NODE_BY_ID.get(hover)!.cameraId!]?.mode : undefined}
          />
        </div>
      )}
      {edgeTip && !hover && (
        <div className="fm-tip" style={{ left: edgeTip.x + 12, top: edgeTip.y + 12, minWidth: 0 }}>
          <span className="fm-tip-sub" style={{ color: '#c9d2d8' }}>
            {edgeTip.text}
          </span>
        </div>
      )}
      {props.cursorHint && (
        <div className="pointer-events-none absolute left-2 top-2 border border-edge bg-black/70 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-cyan">
          {props.cursorHint}
        </div>
      )}
      {basemap === 'down' && (
        <div
          className="pointer-events-none absolute bottom-2 left-2 border px-2 py-1 font-mono text-[10px] text-mute"
          style={{ borderColor: '#2a3138', background: 'rgba(4,6,8,0.85)' }}
          data-testid="basemap-unavailable"
        >
          Basemap unavailable (tile server unreachable). Cameras and routes still update.
        </div>
      )}
      <div className="fm-ctl absolute right-2 top-10">
        <button type="button" aria-label="Zoom in" onClick={() => mapRef.current?.zoomIn()}>
          +
        </button>
        <button type="button" aria-label="Zoom out" onClick={() => mapRef.current?.zoomOut()}>
          −
        </button>
        <button type="button" aria-label="Reset view" title="Fit whole Bay" style={{ fontSize: 11 }} onClick={() => mapRef.current?.fitBounds(FIT, { padding: 24 })}>
          ⤢
        </button>
      </div>
    </div>
  );
}
