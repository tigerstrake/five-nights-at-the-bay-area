// Tactical map: a schematic "freeway transit map" of the Bay Area (the default map mode).
//
// Geometry (static, module level): the real Natural Earth shoreline warped into tactical space
// (shore.gen.ts), and every graph edge drawn as an octilinear corridor with its route identity
// (schematic.ts). Freeways keep one tone end to end and carry route shields; bridges become hollow spans
// where they actually cross water; tunnels are dashed with portals.
//
// Layers, bottom → top: water + land + shore → corridors → defended zone + threat heat → coverage →
// scan rings → sensor tripwires → attack paths + next hops + planned route → HQ spokes + gates + keep →
// nodes → sightings → last known / held → monster (rAF, along the corridor) → labels + shields + notes.
// Strokes are screen pixels (non-scaling); glyph and font sizes follow the measured pixels-per-unit, so the
// map reads the same in a 430 px console column and on a 4K wall.
//
// Performance: the base layer, node glyphs and label placement are memoised on primitive props, so a
// 10 Hz view update only re-renders the few dynamic layers that changed.
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import clsx from 'clsx';
import type { CameraGameStatus, HqId } from '@fnab/shared';
import { CAMERA_BY_ID, graph, NETWORK } from '../lib/data';
import { useGame } from '../state/store';
import { BRIDGE_SPANS, LAND_PATH } from './shore.gen';
import {
  CORRIDORS,
  corridorPoints,
  DIR_ANGLE,
  MAP_NOTES,
  nodeLabel,
  NODE_ROUTE_KEYS,
  pathPoints,
  pointsToD,
  SHIELD_SPOTS,
  type Corridor,
  type RouteInfo,
} from './schematic';
import {
  attackPathsFrom,
  BASE_BOX,
  doorLayout,
  HQ_SHORT,
  HQ_BY_ID,
  HQ_ZONES,
  hopsToHq,
  NODE_BY_ID,
  NODE_ROUTES,
  pos,
  projectAlong,
  type XY,
} from './derive';
import { placeLabels, type LabelRequest, type Obstacle, type PlacedLabel, type SegmentObstacle } from './labels';
import { resolveTheme, SENSOR_RADIUS_HOPS, type DoorState, type MapInset, type MapLayers, type MapProps, type MapTheme, type MarkKind } from './layers';
import { PALETTES, ROUTE_WIDTH, routeTone, SEM, type MapPalette } from './theme';
import { useMonsterMotion } from './useMonsterMotion';
import './map.css';
import { rootZoom } from '../hooks/useConsoleZoom';

export type { MapLayers, MarkKind, MapTheme, DoorState } from './layers';
export { monsterXY } from './derive';

const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const NS = 'non-scaling-stroke' as const;

type Vb = { x: number; y: number; w: number; h: number };
type MapLabel = PlacedLabel & { kind: string; route?: RouteInfo };

// ---------------------------------------------------------------------------------------------------------
// Static corridor drawing data (module level)

interface CorridorDraw {
  c: Corridor;
  /** Over-water spans (bridges). */
  spans: string[];
  /** Abutment ticks at span ends: point + heading. */
  abutments: Array<XY & { angle: number }>;
  /** Tunnels: solid approaches + dashed bore + portal points. */
  bore?: { approaches: string[]; tube: string; portals: Array<XY & { angle: number }> };
}

function headingAt(pts: XY[], i: number): number {
  const a = pts[Math.max(0, i - 1)]!, b = pts[Math.min(pts.length - 1, i + 1)]!;
  return Math.atan2(b.y - a.y, b.x - a.x);
}

const DRAW: CorridorDraw[] = [...CORRIDORS.values()].map((c) => {
  const out: CorridorDraw = { c, spans: [], abutments: [] };
  if (c.kind === 'bridge') {
    for (const [t0, t1] of BRIDGE_SPANS[c.id] ?? []) {
      const pts = corridorPoints(c.a, c.b, t0, t1);
      if (pts.length < 2) continue;
      out.spans.push(pointsToD(pts));
      out.abutments.push({ ...pts[0]!, angle: headingAt(pts, 0) }, { ...pts[pts.length - 1]!, angle: headingAt(pts, pts.length - 1) });
    }
  }
  if (c.kind === 'tunnel') {
    const a = corridorPoints(c.a, c.b, 0, 0.24), m = corridorPoints(c.a, c.b, 0.24, 0.76), b = corridorPoints(c.a, c.b, 0.76, 1);
    out.bore = {
      approaches: [pointsToD(a), pointsToD(b)],
      tube: pointsToD(m),
      portals: [
        { ...m[0]!, angle: headingAt(m, 0) },
        { ...m[m.length - 1]!, angle: headingAt(m, m.length - 1) },
      ],
    };
  }
  return out;
});
// streets first, then state, then the heavy routes on top
const CLASS_ORDER: Record<RouteInfo['cls'], number> = { street: 0, state: 1, us: 2, interstate: 3 };
DRAW.sort((p, q) => CLASS_ORDER[p.c.route.cls] - CLASS_ORDER[q.c.route.cls]);

const NODE_ANCHORS = NETWORK.nodes.map((n) => n.tactical);

/** Corridor segments for label avoidance (map units). */
const LINE_SEGMENTS: Array<{ x1: number; y1: number; x2: number; y2: number; owner: string; w: number }> = [];
for (const c of CORRIDORS.values()) {
  const step = Math.max(1, Math.floor(c.pts.length / 14));
  for (let i = 0; i < c.pts.length - 1; i += step) {
    const a = c.pts[i]!, b = c.pts[Math.min(c.pts.length - 1, i + step)]!;
    LINE_SEGMENTS.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, owner: c.id, w: ROUTE_WIDTH[c.route.cls] });
  }
}

// ---------------------------------------------------------------------------------------------------------
// Base: water, land, shore, corridors. Re-renders only on theme / scale changes.

const BaseLayer = memo(function BaseLayer({ theme, lod, u }: { theme: MapTheme; lod: number; u: number }) {
  const P = PALETTES[theme];
  const big = 6000;
  return (
    <g aria-hidden="true">
      <rect x={-big} y={-big} width={big * 2} height={big * 2} fill={P.water} />
      <path d={LAND_PATH} fill={P.land} fillRule="evenodd" />
      {/* one soft band + a hairline: enough to read the shore, no contour noise */}
      <path d={LAND_PATH} fill="none" stroke={P.shore} strokeOpacity={0.16} strokeWidth={5} vectorEffect={NS} strokeLinejoin="round" />
      <path d={LAND_PATH} fill="none" stroke={P.shore} strokeWidth={1} vectorEffect={NS} strokeLinejoin="round" />
      <CorridorsLayer P={P} lod={lod} u={u} />
    </g>
  );
});

function CorridorsLayer({ P, lod, u }: { P: MapPalette; lod: number; u: number }) {
  return (
    <g fill="none" strokeLinecap="round" strokeLinejoin="round">
      {DRAW.map(({ c, spans, abutments, bore }) => {
        const tone = routeTone(P, c.route);
        const w = ROUTE_WIDTH[c.route.cls] * lod;
        const title = <title>{`${c.routeName} · ${c.lengthKm} km`}</title>;
        if (bore) {
          return (
            <g key={c.id}>
              {title}
              {bore.approaches.map((d, i) => (
                <path key={i} d={d} stroke={tone} strokeWidth={w} vectorEffect={NS} />
              ))}
              <path d={bore.tube} stroke={tone} strokeOpacity={0.85} strokeWidth={w} strokeDasharray={`${1.4 * w} ${1.1 * w}`} strokeLinecap="butt" vectorEffect={NS} />
              {bore.portals.map((p, i) => (
                <Tick key={i} p={p} len={w * 2.2 + 3} stroke={tone} width={1.4 * lod} u={u} />
              ))}
            </g>
          );
        }
        return (
          <g key={c.id}>
            {title}
            <path d={c.d} stroke={tone} strokeWidth={w} vectorEffect={NS} />
            {spans.map((d, i) => (
              <g key={i}>
                <path d={d} stroke={tone} strokeWidth={w + 3.2 * lod} strokeLinecap="butt" vectorEffect={NS} />
                <path d={d} stroke={P.water} strokeWidth={Math.max(1, w - 0.9 * lod)} strokeLinecap="butt" vectorEffect={NS} />
              </g>
            ))}
            {abutments.map((p, i) => (
              <Tick key={`a${i}`} p={p} len={w + 7 * lod} stroke={tone} width={1.3 * lod} u={u} />
            ))}
          </g>
        );
      })}
    </g>
  );
}

/** A short tick across a line at point p (perpendicular to its heading). Length in px; u = map units per px. */
function Tick({ p, len, stroke, width, u }: { p: XY & { angle: number }; len: number; stroke: string; width: number; u: number }) {
  const h = (len / 2) * u;
  const nx = -Math.sin(p.angle) * h, ny = Math.cos(p.angle) * h;
  return <line x1={p.x - nx} y1={p.y - ny} x2={p.x + nx} y2={p.y + ny} stroke={stroke} strokeWidth={width} strokeLinecap="butt" vectorEffect={NS} />;
}

// ---------------------------------------------------------------------------------------------------------
// Nodes

interface NodeApi {
  click: (id: string) => void;
  hover: (id: string | null) => void;
  key: (id: string, e: ReactKeyboardEvent) => void;
}

const NodeGlyph = memo(function NodeGlyph(p: {
  id: string;
  name: string;
  x: number;
  y: number;
  u: number;
  theme: MapTheme;
  status: CameraGameStatus | 'none';
  marks: string;
  hl: string;
  sel: boolean;
  key2: boolean; // approach node of the shown HQ
  tabbable: boolean;
  interactive: boolean;
  api: NodeApi;
}) {
  const P = PALETTES[p.theme];
  const { x, y, u } = p;
  const marks = p.marks ? (p.marks.split(',') as MarkKind[]) : [];
  const has = (m: MarkKind) => marks.includes(m);
  const camC = P.cam[p.status];
  const sabotaged = p.status === 'sabotaged';
  const R = (p.key2 ? 5.4 : 4.6) * u;
  return (
    <g
      data-node={p.id}
      tabIndex={p.tabbable ? 0 : -1}
      role="button"
      aria-label={`${p.name}${p.status !== 'none' ? `, camera ${p.status}` : ''}`}
      onClick={p.interactive ? () => p.api.click(p.id) : undefined}
      onMouseEnter={() => p.api.hover(p.id)}
      onMouseLeave={() => p.api.hover(null)}
      onFocus={() => p.api.hover(p.id)}
      onBlur={() => p.api.hover(null)}
      onKeyDown={(e) => p.api.key(p.id, e)}
      style={{ cursor: p.interactive ? 'pointer' : 'default' }}
    >
      <circle cx={x} cy={y} r={14 * u} fill="transparent" />
      {p.hl && <circle cx={x} cy={y} r={10.5 * u} fill={p.hl} fillOpacity={0.16} stroke={p.hl} strokeOpacity={0.85} strokeWidth={1.3} vectorEffect={NS} />}
      {has('spawn') && (
        <>
          <circle cx={x} cy={y} r={9.5 * u} fill="none" stroke="#c0263f" strokeWidth={1.6} vectorEffect={NS} />
          <circle cx={x} cy={y} r={9.5 * u} fill="none" stroke="#e04a62" strokeWidth={1.2} vectorEffect={NS} className="fm-ripple fm-centered" />
        </>
      )}
      {has('scanPulse') && <circle cx={x} cy={y} r={12.5 * u} fill="none" stroke={SEM.cyan} strokeOpacity={0.85} strokeWidth={1} strokeDasharray="1.5 3" vectorEffect={NS} />}
      {has('exposure') && <circle cx={x} cy={y} r={10.5 * u} fill="none" stroke="#ff4d5e" strokeWidth={1.3} strokeDasharray="1 2.5" vectorEffect={NS} className="fm-pulse" />}
      {has('disturbance') && <circle cx={x} cy={y} r={11.5 * u} fill="none" stroke={SEM.warn} strokeWidth={1.4} vectorEffect={NS} className="fm-ripple fm-centered" />}
      {/* sensor: twin radar arcs */}
      {(has('sensor') || has('sensorOff') || has('knownSensor')) && (
        <g stroke={has('sensorOff') ? SEM.dim : has('knownSensor') ? SEM.warn : SEM.cyan} strokeWidth={1.6} fill="none" strokeDasharray={has('sensorOff') ? '1.5 2.5' : undefined}>
          <path vectorEffect={NS} d={arc(x, y, 8.6 * u, -140, -40)} />
          <path vectorEffect={NS} d={arc(x, y, 8.6 * u, 40, 140)} />
          <path vectorEffect={NS} strokeOpacity={0.5} d={arc(x, y, 12 * u, -125, -55)} />
          <path vectorEffect={NS} strokeOpacity={0.5} d={arc(x, y, 12 * u, 55, 125)} />
        </g>
      )}
      {/* station: dark disc + ring, camera pip inside */}
      <circle
        className="fm-body"
        cx={x}
        cy={y}
        r={R}
        fill={P.nodeFill}
        stroke={sabotaged ? (p.theme === 'monster' ? '#7a2a2e' : SEM.alert) : p.key2 ? P.nodeRingKey : P.nodeRing}
        strokeWidth={p.key2 ? 1.8 : 1.4}
        strokeDasharray={sabotaged ? '2 1.5' : undefined}
        vectorEffect={NS}
      />
      {sabotaged ? (
        <g stroke={p.theme === 'monster' ? '#9a3a3e' : '#ff5a63'} strokeWidth={1.4} strokeLinecap="round">
          <line vectorEffect={NS} x1={x - 2.3 * u} y1={y - 2.3 * u} x2={x + 2.3 * u} y2={y + 2.3 * u} />
          <line vectorEffect={NS} x1={x + 2.3 * u} y1={y - 2.3 * u} x2={x - 2.3 * u} y2={y + 2.3 * u} />
        </g>
      ) : p.status === 'repairing' ? (
        <>
          <circle cx={x} cy={y} r={2.1 * u} fill={camC} />
          <circle cx={x} cy={y} r={7.6 * u} fill="none" stroke={camC} strokeWidth={1.2} strokeDasharray={`${3.6 * u} ${2.8 * u}`} className="fm-spin-fast fm-centered" />
        </>
      ) : (
        <circle cx={x} cy={y} r={(p.status === 'none' ? 1.6 : 2.2) * u} fill={camC} />
      )}
      {/* trap: diamond to the upper right */}
      {(has('trap') || has('trapArming')) && (
        <rect
          x={x + 6.5 * u}
          y={y - 12.5 * u}
          width={6 * u}
          height={6 * u}
          fill={has('trap') ? SEM.alert : P.nodeFill}
          stroke={has('trap') ? '#ff8a93' : SEM.alert}
          strokeWidth={1.3}
          vectorEffect={NS}
          transform={`rotate(45 ${x + 9.5 * u} ${y - 9.5 * u})`}
          className={has('trapArming') ? 'fm-pulse-fast' : undefined}
        />
      )}
      {/* lure: triangle to the upper left */}
      {has('lure') && <path d={`M${x - 9.5 * u},${y - 14.5 * u} l${3.6 * u},${6.4 * u} l${-7.2 * u},0 z`} fill={SEM.warn} className="fm-pulse" />}
      {p.sel && (
        <g stroke={P.labelStrong} strokeWidth={1.3} fill="none">
          <circle vectorEffect={NS} cx={x} cy={y} r={9.8 * u} strokeOpacity={0.85} />
          {[0, 90, 180, 270].map((a) => {
            const c = Math.cos((a * Math.PI) / 180), s = Math.sin((a * Math.PI) / 180);
            return <line key={a} vectorEffect={NS} x1={x + c * 12.5 * u} y1={y + s * 12.5 * u} x2={x + c * 16.5 * u} y2={y + s * 16.5 * u} />;
          })}
        </g>
      )}
      <circle className="fm-focus" cx={x} cy={y} r={14 * u} fill="none" stroke={P.accent} strokeWidth={1.5} vectorEffect={NS} />
    </g>
  );
});

function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const t0 = (a0 * Math.PI) / 180, t1 = (a1 * Math.PI) / 180;
  const x0 = cx + Math.cos(t0) * r, y0 = cy + Math.sin(t0) * r;
  const x1 = cx + Math.cos(t1) * r, y1 = cy + Math.sin(t1) * r;
  return `M${x0},${y0} A${r},${r} 0 0 1 ${x1},${y1}`;
}

// ---------------------------------------------------------------------------------------------------------
// Route shields (Interstate shield, US badge, California spade-ish tab), drawn in px around a map point.

function shieldPath(cls: RouteInfo['cls'], w: number, h: number): string {
  const x = -w / 2, y = -h / 2;
  if (cls === 'interstate')
    return `M${x},${y + h * 0.12} Q${0},${y - h * 0.08} ${-x},${y + h * 0.12} L${-x},${y + h * 0.42} Q${-x},${y + h * 0.86} 0,${-y} Q${x},${y + h * 0.86} ${x},${y + h * 0.42} Z`;
  if (cls === 'us')
    return `M${x + w * 0.14},${y} L${-x - w * 0.14},${y} L${-x},${y + h * 0.2} L${-x},${y + h * 0.6} Q${-x},${-y} 0,${-y} Q${x},${-y} ${x},${y + h * 0.6} L${x},${y + h * 0.2} Z`;
  const r = h * 0.32;
  return `M${x + r},${y} L${-x - r},${y} Q${-x},${y} ${-x},${y + r} L${-x},${-y - r} Q${-x},${-y} ${-x - r},${-y} L${x + r},${-y} Q${x},${-y} ${x},${-y - r} L${x},${y + r} Q${x},${y} ${x + r},${y} Z`;
}

function Shield({ l, P, u }: { l: MapLabel; P: MapPalette; u: number }) {
  const info = l.route!;
  const tone = routeTone(P, info);
  const h = l.size * 1.45, w = Math.max(h * 1.06, l.text.length * l.size * 0.62 + l.size * 0.8);
  return (
    <g transform={`translate(${l.lx} ${l.ly}) scale(${u})`} pointerEvents="none">
      <path d={shieldPath(info.cls, w, h)} fill={P.shieldFill} stroke={tone} strokeWidth={1.2} />
      <text
        y={info.cls === 'interstate' ? h * 0.06 : 0.5}
        textAnchor="middle"
        dominantBaseline="central"
        className="fm-shield"
        fontSize={l.size}
        fill={P.shieldText}
      >
        {l.text}
      </text>
    </g>
  );
}

// ---------------------------------------------------------------------------------------------------------

function doorStateOf(p: MapLayers, approachId: string, theme: MapTheme): DoorState & { known: boolean } {
  const d = p.doors?.[approachId];
  if (d) return { ...d, known: true };
  const c = p.doorClosed?.[approachId];
  if (c !== undefined) return { closed: c, known: true };
  return { closed: false, known: theme === 'defender' };
}

function useSize(ref: React.RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      // Layout pixels (not getBoundingClientRect): the App may apply CSS `zoom` on large screens.
      const r = { width: el.clientWidth, height: el.clientHeight };
      setSize((s) => (Math.abs(s.w - r.width) < 1 && Math.abs(s.h - r.height) < 1 ? s : { w: r.width, h: r.height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

export function TacticalMap(props: MapProps) {
  const theme = resolveTheme(props);
  const P = PALETTES[theme];
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const rootRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const monsterRef = useRef<SVGGElement>(null);
  const size = useSize(rootRef);
  const W = size.w || 640;
  const H = size.h || 520;
  const [hover, setHover] = useState<string | null>(null);
  const [legend, setLegend] = useState(false);
  const [view, setView] = useState({ z: 1, cx: BASE_BOX.x + BASE_BOX.w / 2, cy: BASE_BOX.y + BASE_BOX.h / 2 });
  const sources = useGame((s) => s.cameraStatuses);

  // ---- viewport ----
  // Fit the network into the panel minus any overlay insets; (fx, fy) is the screen point the view centre maps to.
  const ins = props.inset ?? {};
  const iL = ins.left ?? 0, iR = ins.right ?? 0, iT = ins.top ?? 0, iB = ins.bottom ?? 0;
  const fitW = Math.max(W * 0.5, W - iL - iR), fitH = Math.max(H * 0.5, H - iT - iB);
  const fx = (iL * (W - fitW)) / (iL + iR || 1) + fitW / 2;
  const fy = (iT * (H - fitH)) / (iT + iB || 1) + fitH / 2;
  const k0 = Math.min(fitW / BASE_BOX.w, fitH / BASE_BOX.h);
  const k = k0 * view.z;
  const vb: Vb = { x: view.cx - fx / k, y: view.cy - fy / k, w: W / k, h: H / k };
  // quantise the unit size so memoised layers only re-render on meaningful scale changes
  const u = Math.round((1 / k) * 200) / 200;
  // level of detail: hairline routes on tiny maps, full weight from ~0.45 px/unit up
  const lod = Math.round(Math.min(1.15, Math.max(0.55, k / 0.5)) * 20) / 20;

  const clampView = useCallback(
    (z: number, cx: number, cy: number) => {
      const zz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
      const kk = k0 * zz;
      const hw = W / kk / 2, hh = H / kk / 2;
      const minCx = Math.min(BASE_BOX.x + hw, BASE_BOX.x + BASE_BOX.w / 2);
      const maxCx = Math.max(BASE_BOX.x + BASE_BOX.w - hw, BASE_BOX.x + BASE_BOX.w / 2);
      const minCy = Math.min(BASE_BOX.y + hh, BASE_BOX.y + BASE_BOX.h / 2);
      const maxCy = Math.max(BASE_BOX.y + BASE_BOX.h - hh, BASE_BOX.y + BASE_BOX.h / 2);
      return { z: zz, cx: Math.min(maxCx, Math.max(minCx, cx)), cy: Math.min(maxCy, Math.max(minCy, cy)) };
    },
    [k0, W, H],
  );
  const zoomable = !props.noZoom;

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !zoomable) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      const zf = rootZoom(svg);
      const mx = (e.clientX - r.left) / zf, my = (e.clientY - r.top) / zf;
      setView((v) => {
        const kk = k0 * v.z;
        const wx = v.cx - fx / kk + mx / kk;
        const wy = v.cy - fy / kk + my / kk;
        const z2 = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.z * Math.exp(-e.deltaY * 0.0016)));
        const k2 = k0 * z2;
        return clampView(z2, wx - mx / k2 + fx / k2, wy - my / k2 + fy / k2);
      });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [k0, fx, fy, clampView, zoomable]);

  // keep the view valid when the panel resizes
  useEffect(() => setView((v) => clampView(v.z, v.cx, v.cy)), [clampView]);

  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean; id: number; zf: number } | null>(null);
  const suppressClick = useRef(false);
  const onPointerDown = (e: React.PointerEvent) => {
    if (!zoomable || e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy, moved: false, id: e.pointerId, zf: rootZoom(svgRef.current) };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 5) return;
    if (!d.moved) {
      d.moved = true;
      svgRef.current?.setPointerCapture(d.id);
    }
    setView((v) => clampView(v.z, d.cx - dx / d.zf / k, d.cy - dy / d.zf / k));
  };
  const onPointerUp = () => {
    if (drag.current?.moved) {
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false), 0);
    }
    drag.current = null;
  };

  // ---- derived props ----
  const hqs = props.allHqs ? NETWORK.headquarters : NETWORK.headquarters.filter((h) => h.id === props.hqId);
  const activeHq = props.hqId ? HQ_BY_ID.get(props.hqId) : undefined;
  const approachNodes = useMemo(() => new Set(hqs.flatMap((h) => h.approaches.map((a) => a.fromNode))), [props.allHqs, props.hqId]); // eslint-disable-line react-hooks/exhaustive-deps
  const approachOf = useMemo(() => {
    const m = new Map<string, { hq: string; ap: (typeof hqs)[number]['approaches'][number] }>();
    if (!props.allHqs) for (const h of hqs) for (const ap of h.approaches) m.set(ap.fromNode, { hq: h.id, ap });
    return m;
  }, [props.allHqs, props.hqId]); // eslint-disable-line react-hooks/exhaustive-deps
  const hlTone = props.highlightTone ?? 'cyan';
  const hlColor = { cyan: SEM.cyan, monster: '#e04a62', warn: SEM.warn }[hlTone];
  const monsterOrigin = props.monster ? (props.monster.moving?.to ?? props.monster.nodeId) : null;
  const monsterFrom = props.monster ? (props.monster.moving ? props.monster.moving.from : props.monster.nodeId) : null;

  // stable callbacks for memoised nodes
  const [focusNode, setFocusNode] = useState<string | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const api = useMemo<NodeApi>(
    () => ({
      click: (id) => {
        if (suppressClick.current) {
          suppressClick.current = false;
          return;
        }
        latest.current.onNodeClick?.(id);
      },
      hover: (id) => {
        setHover((h) => (id === null ? null : id === h ? h : id));
        latest.current.onNodeHover?.(id);
      },
      key: (id, e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          latest.current.onNodeClick?.(id);
          return;
        }
        const dir = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
        if (!dir) return;
        e.preventDefault();
        const here = pos(id);
        const neigh = new Set(graph.neighbors(id));
        let best: string | null = null;
        let bestScore = Infinity;
        for (const n of NETWORK.nodes) {
          if (n.id === id) continue;
          const dx = n.tactical.x - here.x, dy = n.tactical.y - here.y;
          const dist = Math.hypot(dx, dy);
          const cos = (dx * dir[0]! + dy * dir[1]!) / dist;
          if (cos < 0.35) continue;
          const score = (dist / (cos * cos)) * (neigh.has(n.id) ? 0.7 : 1);
          if (score < bestScore) {
            bestScore = score;
            best = n.id;
          }
        }
        if (best) setFocusNode(best);
      },
    }),
    [],
  );
  useEffect(() => {
    if (!focusNode) return;
    const el = rootRef.current?.querySelector<SVGGElement>(`[data-node="${focusNode}"]`);
    el?.focus();
  }, [focusNode]);
  const tabNode = focusNode ?? props.selectedNode ?? [...approachNodes][0] ?? NETWORK.nodes[0]!.id;

  // ---- local threat fallback (fresh sightings near HQ) ----
  const threat = useMemo(() => {
    if (props.threat !== undefined) return props.threat;
    if (!props.hqId || !props.sightings?.length) return 0;
    let t = 0;
    for (const s of props.sightings) {
      if (s.flagged) continue;
      const h = hopsToHq(s.nodeId, props.hqId);
      t = Math.max(t, (1 - s.age) * Math.max(0, 1 - h / 4));
    }
    return t;
  }, [props.threat, props.hqId, props.sightings]);

  // ---- attack paths (monster) ----
  const attackPaths = useMemo(
    () => (theme === 'monster' && props.attackPaths !== false && props.monster ? attackPathsFrom(monsterOrigin, props.hqId) : []),
    [theme, props.attackPaths, !!props.monster, monsterOrigin, props.hqId], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const hopsByApproach = new Map(attackPaths.map((a) => [a.approachId, a.path.length - 1 + (props.monster?.moving ? 1 : 0)]));

  const pathKey = (props.path ?? []).join('>');
  const pathD = useMemo(() => (props.path && props.path.length > 1 ? pointsToD(pathPoints(props.path)) : ''), [pathKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- monster motion (along the corridor geometry) ----
  const project = useCallback((from: string, to: string | null, p: number): XY | null => projectAlong(from, to, p), []);
  useMonsterMotion(props.monster, project, monsterRef);

  // ---- labels ----
  const spawnNodes = useMemo(() => Object.entries(props.marks ?? {}).filter(([, m]) => m.includes('spawn')).map(([n]) => n), [props.marks]);
  const doorKey = hqs
    .flatMap((h) =>
      h.approaches.map((a) => {
        const d = doorStateOf(props, a.id, theme);
        return `${a.id}:${d.closed ? 1 : 0}${d.jammed ? 'j' : ''}${d.known ? 'k' : ''}${props.breachApproachId === a.id ? 'b' : ''}:${hopsByApproach.get(a.id) ?? ''}`;
      }),
    )
    .join(',');
  // type grows gently with the panel (glyphs stay put); never below 9.5 px
  const fs = Math.min(1.32, Math.max(0.94, k / 0.56));
  const labelsOn = k >= 0.24;
  const placed = useMemo<MapLabel[]>(() => {
    if (!labelsOn) return [];
    const reqs: Array<LabelRequest & { kind: string; route?: RouteInfo }> = [];
    const obstacles: Obstacle[] = NETWORK.nodes.map((n) => ({ x: n.tactical.x, y: n.tactical.y, r: 7 }));
    const segments: SegmentObstacle[] = LINE_SEGMENTS.map((s) => ({ ...s, hw: s.w / 2 + 0.5 }));
    for (const h of hqs) {
      obstacles.push({ x: h.tactical.x, y: h.tactical.y, r: 14 });
      const focus = props.hqId === h.id;
      reqs.push({
        id: `hq-${h.id}`,
        kind: 'hq',
        texts: props.allHqs || k >= 0.9 ? [h.name, HQ_SHORT[h.id] ?? h.name] : [HQ_SHORT[h.id] ?? h.name],
        x: h.tactical.x,
        y: h.tactical.y,
        r: 13,
        size: (focus ? 12 : 11) * fs,
        weight: 700,
        priority: focus ? 100 : 95,
        required: true,
        prefer: hqLabelSide(h.id),
      });
      if (props.allHqs) continue;
      const doors = doorLayout(h.id, u);
      for (const ap of h.approaches) {
        const dp = doors.get(ap.id)!;
        obstacles.push({ x: dp.x, y: dp.y, r: 5 });
        // spoke: keep labels off it
        const p = pos(ap.fromNode);
        segments.push({ x1: dp.x, y1: dp.y, x2: p.x, y2: p.y, hw: 1.5, owner: `spoke-${ap.id}` });
      }
    }
    // node labels: every camera is named. A second line carries what is happening at that camera:
    // last known / trapped, and for an approach camera its gate state (sealed / jammed / breach) and,
    // for the monster, the hops left to that gate.
    const subOf = (id: string) => {
      const parts: Array<{ text: string; color: string }> = [];
      if (id === props.held) parts.push({ text: props.containmentProgress != null ? 'contained' : 'trapped', color: '#ff6b74' });
      else if (id === props.lastKnown) parts.push({ text: 'last known', color: '#ff6b74' });
      const a = approachOf.get(id);
      if (a) {
        const d = doorStateOf(props, a.ap.id, theme);
        const breach = props.breachApproachId === a.ap.id;
        const hops = hopsByApproach.get(a.ap.id);
        if (hops !== undefined) parts.push({ text: hops === 0 ? 'at the gate' : `${hops} hop${hops === 1 ? '' : 's'}`, color: theme === 'monster' ? '#c9a27a' : '#8fa0a9' });
        if (breach) parts.push({ text: 'breach', color: '#ff6b74' });
        else if (d.jammed) parts.push({ text: 'jammed', color: SEM.warn });
        else if (d.closed && d.known) parts.push({ text: 'sealed', color: theme === 'monster' ? '#e8d8bf' : '#7fe0a8' });
      }
      if (!parts.length) return undefined;
      return { text: parts.map((p) => p.text).join(' · '), parts, size: 8.6 * fs, mono: true, tracking: 0.2 };
    };
    for (const n of NETWORK.nodes) {
      const spec = nodeLabel(n.id);
      const strong = n.id === props.selectedNode || (theme === 'monster' && n.id === monsterOrigin);
      const key = approachNodes.has(n.id);
      reqs.push({
        id: `n-${n.id}`,
        kind: 'node',
        texts: spec.short ? [spec.text, spec.short] : [spec.text],
        x: n.tactical.x,
        y: n.tactical.y,
        r: key ? 8.5 : 7.5,
        size: (strong ? 11 : 10.2) * fs,
        weight: strong || key ? 600 : 500,
        // stations with something to say (selected, approach gates, last known / trapped) claim space first
        priority: strong ? 80 : n.id === props.held || n.id === props.lastKnown ? 76 : key ? 70 : spawnNodes.includes(n.id) ? 60 : 50 - (n.region === 'north-bay' ? 1 : 0),
        required: true,
        prefer: DIR_ANGLE(spec.dir),
        sub: subOf(n.id),
        unambiguous: true,
      });
    }
    for (const sg of props.sightings ?? [])
      if (sg.flagged)
        reqs.push({ id: `false-${sg.id}`, kind: 'false', texts: ['false'], x: pos(sg.nodeId).x, y: pos(sg.nodeId).y, r: 13, size: 8.4 * fs, mono: true, priority: 30, prefer: Math.PI / 4 });
    // shields sit on their own line; notes fill the open water / land
    if (k >= 0.33)
      SHIELD_SPOTS.forEach((s, i) =>
        reqs.push({
          id: `sh-${i}`,
          kind: 'shield',
          route: s.route,
          texts: [s.route.num!],
          x: s.x,
          y: s.y,
          r: 0,
          size: 8.2 * Math.min(1.2, fs),
          weight: 800,
          priority: 20 - i * 0.01,
          fixed: true,
          ownSegments: [s.edge, ...s.alts.map((a) => a.edge)].join('|'),
          alts: s.alts,
        }),
      );
    for (const note of MAP_NOTES) {
      if (note.kind === 'region' && k < 0.45) continue;
      reqs.push({
        id: note.id,
        kind: note.kind,
        texts: [note.text],
        x: note.x,
        y: note.y,
        r: 0,
        size: (note.kind === 'region' ? 9.5 : note.kind === 'bridge' ? 9 : 10) * fs,
        tracking: note.kind === 'region' ? 2.2 : 0.3,
        weight: note.kind === 'region' ? 700 : 500,
        priority: 10 + note.priority,
        fixed: true,
        rotate: note.rotate,
      });
    }
    // on-map controls (zoom stack, key button, cursor hint) are no-go areas for labels
    const ctl = (px: number, py: number, w: number, h: number) => obstacles.push({ x: vb.x + (px + w / 2) / k, y: vb.y + (py + h / 2) / k, r: 0, w, h, weight: 40 });
    if (zoomable) ctl(W - 38, iT, 38, 86);
    if (!props.noLegend) ctl(0, H - 36, 52, 36);
    if (props.cursorHint) ctl(0, 0, Math.min(W, props.cursorHint.length * 7.2 + 30), 30);
    const viewBox = { x: vb.x + iL / k, y: vb.y + iT / k, w: vb.w - (iL + iR) / k, h: vb.h - (iT + iB) / k };
    // only name what is on screen (zoomed in, off-screen stations must not crowd the edges)
    const m = 2 / k;
    const visible = (x: number, y: number) => x >= viewBox.x - m && x <= viewBox.x + viewBox.w + m && y >= viewBox.y - m && y <= viewBox.y + viewBox.h + m;
    const onScreen = reqs.filter((q) => visible(q.x, q.y) || (q.alts ?? []).some((a) => visible(a.x, a.y)));
    return placeLabels(onScreen, obstacles, k, viewBox, segments, NODE_ANCHORS) as MapLabel[];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    Math.round(k * 100),
    Math.round(vb.x),
    Math.round(vb.y),
    W,
    H,
    !!props.cursorHint,
    iL,
    iR,
    iT,
    iB,
    props.hqId,
    props.allHqs,
    props.selectedNode,
    props.lastKnown,
    props.held,
    props.containmentProgress != null,
    spawnNodes.join(','),
    doorKey,
    theme,
    monsterOrigin,
    labelsOn,
  ]);

  // ---- tooltip ----
  const tip = hover ? NODE_BY_ID.get(hover) : undefined;

  const camStatus = props.cameraStatus ?? {};
  const marksOf = (id: string) => (props.marks?.[id] ?? []).join(',');
  const ringNodes = (props.rings ?? []).map((r) => ({ ...r, set: graph.within(r.nodeId, r.hops) }));
  const sensorNodes = Object.entries(props.marks ?? {})
    .filter(([, m]) => m.includes('sensor') || m.includes('knownSensor'))
    .map(([n, m]) => ({ n, tone: m.includes('sensor') ? SEM.cyan : SEM.warn }));
  const coverageOn = props.coverage !== false && Object.keys(camStatus).length > 0;
  const nextHops =
    theme === 'monster' && props.monster && props.highlight && hlTone === 'monster' && monsterOrigin
      ? graph.neighbors(monsterOrigin).filter((n) => props.highlight!.has(n))
      : [];

  // memoised dynamic layers that change far less often than the 10 Hz view
  const statusSig = NETWORK.nodes.map((n) => camStatus[n.id] ?? '').join(',');
  const coverageEls = useMemo(
    () =>
      coverageOn ? (
        <g pointerEvents="none">
          {NETWORK.nodes.map((n) => {
            const s = camStatus[n.id];
            if (s === 'ok') return <circle key={n.id} cx={n.tactical.x} cy={n.tactical.y} r={Math.max(20, 19 * u)} fill={`url(#${uid}-cov)`} />;
            if (s === 'sabotaged' && theme === 'defender')
              return (
                <circle key={n.id} cx={n.tactical.x} cy={n.tactical.y} r={15 * u} fill="#c8323a" fillOpacity={0.08} stroke="#c8323a" strokeOpacity={0.55} strokeWidth={1} strokeDasharray="2 3" vectorEffect={NS} />
              );
            return null;
          })}
        </g>
      ) : null,
    [statusSig, coverageOn, theme, u, uid], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const labelEls = useMemo(
    () => (
      <g pointerEvents="none">
        {placed.map((l) => {
          if (l.kind === 'shield') return <Shield key={l.id} l={l} P={P} u={u} />;
          if (l.kind === 'water' || l.kind === 'bridge' || l.kind === 'region') {
            return (
              <text
                key={l.id}
                x={l.lx}
                y={l.ly}
                fontSize={l.size * u}
                letterSpacing={(l.tracking ?? 0) * u}
                textAnchor="middle"
                dominantBaseline="central"
                className={l.kind === 'region' ? 'fm-region' : 'fm-water'}
                fill={l.kind === 'region' ? P.regionLabel : P.waterLabel}
                transform={l.rotate ? `rotate(${l.rotate} ${l.lx} ${l.ly})` : undefined}
                style={l.kind === 'bridge' ? { paintOrder: 'stroke', stroke: P.water, strokeWidth: 3 * u } : undefined}
              >
                {l.kind === 'region' ? l.text.toUpperCase() : l.text}
              </text>
            );
          }
          const isHq = l.kind === 'hq';
          const isTag = l.kind === 'tag' || l.kind === 'false';
          const nodeId = l.id.startsWith('n-') ? l.id.slice(2) : null;
          const strong = isHq ? props.hqId === l.id.slice(3) : nodeId === props.selectedNode || (theme === 'monster' && nodeId === monsterOrigin);
          const key = nodeId ? approachNodes.has(nodeId) : false;
          let fill = strong ? P.labelStrong : key ? P.labelStrong : P.label;
          if (isHq) fill = strong ? P.hq : P.hqIdle;
          if (isTag) fill = l.kind === 'false' ? '#9aa5ad' : '#ff6b74';
          let leader: XY | null = null;
          if (l.leader) leader = { x: Math.min(Math.max(l.x, l.box.x), l.box.x + l.box.w), y: Math.min(Math.max(l.y, l.box.y), l.box.y + l.box.h) };
          const ang = leader ? Math.atan2(leader.y - l.y, leader.x - l.x) : 0;
          const halo = { paintOrder: 'stroke' as const, stroke: P.halo, strokeWidth: 3.2 * u, strokeLinejoin: 'round' as const };
          const subColor = l.sub ? (theme === 'monster' ? '#c9a27a' : '#8fa0a9') : undefined;
          return (
            <g key={l.id}>
              {leader && (
                <line x1={l.x + Math.cos(ang) * (l.r - 1) * u} y1={l.y + Math.sin(ang) * (l.r - 1) * u} x2={leader.x} y2={leader.y} stroke={fill} strokeOpacity={0.7} strokeWidth={1} vectorEffect={NS} style={{ paintOrder: 'stroke' }} />
              )}
              <text
                x={l.lx}
                y={l.ly}
                fontSize={l.size * u}
                fill={fill}
                textAnchor={l.anchor}
                dominantBaseline="central"
                fontWeight={l.weight ?? 500}
                className={clsx(l.mono && 'fm-mono', isHq && 'fm-hq-label')}
                textDecoration={l.kind === 'false' ? 'line-through' : undefined}
                letterSpacing={l.tracking ? l.tracking * u : undefined}
                style={halo}
              >
                {isTag ? l.text.toUpperCase() : l.text}
              </text>
              {l.sub && (
                <text
                  x={l.lx}
                  y={l.ly + (l.size * 0.62 + l.sub.size * 0.72) * u}
                  fontSize={l.sub.size * u}
                  fill={subColor}
                  textAnchor={l.anchor}
                  dominantBaseline="central"
                  className="fm-mono"
                  letterSpacing={(l.sub.tracking ?? 0) * u}
                  style={halo}
                >
                  {(l.sub.parts ?? [{ text: l.sub.text, color: subColor! }]).map((pt, i) => (
                    <tspan key={i} fill={pt.color}>
                      {i ? ` · ${pt.text}` : pt.text}
                    </tspan>
                  ))}
                </text>
              )}
            </g>
          );
        })}
      </g>
    ),
    [placed, theme, props.hqId, props.selectedNode, monsterOrigin, u], // eslint-disable-line react-hooks/exhaustive-deps
  );

  return (
    <div
      ref={rootRef}
      data-testid="tactical-map"
      data-theme={theme}
      className={clsx('fm-root relative h-full w-full overflow-hidden', props.onNodeClick && 'cursor-crosshair', props.className)}
      style={{ background: P.water }}
    >
      <svg
        ref={svgRef}
        viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
        width="100%"
        height="100%"
        className="absolute inset-0 block"
        preserveAspectRatio="xMidYMid meet"
        role="group"
        aria-label="Tactical map. Arrow keys move between cameras, Enter selects."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <defs>
          <radialGradient id={`${uid}-mglow`}>
            <stop offset="0%" stopColor="#ff3b55" stopOpacity="0.6" />
            <stop offset="40%" stopColor="#c0263f" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#c0263f" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={`${uid}-cov`}>
            <stop offset="0%" stopColor={theme === 'monster' ? '#e8d8bf' : '#3ec4a0'} stopOpacity={theme === 'monster' ? 0.12 : 0.14} />
            <stop offset="100%" stopColor={theme === 'monster' ? '#e8d8bf' : '#3ec4a0'} stopOpacity="0" />
          </radialGradient>
          <radialGradient id={`${uid}-heat`}>
            <stop offset="0%" stopColor="#ff3b46" stopOpacity="0.55" />
            <stop offset="45%" stopColor="#d4542a" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#d49a2a" stopOpacity="0" />
          </radialGradient>
          <marker id={`${uid}-chev`} viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
            <path d="M1,1 L8,5 L1,9" fill="none" stroke={hlColor} strokeWidth="1.8" />
          </marker>
        </defs>

        <BaseLayer theme={theme} lod={lod} u={u} />

        {/* defended zone + threat heat */}
        {!props.allHqs &&
          hqs.map((h) => (
            <g key={`zone-${h.id}`} pointerEvents="none">
              {threat > 0.05 && (
                <circle cx={h.tactical.x} cy={h.tactical.y} r={50 + 70 * threat} fill={`url(#${uid}-heat)`} opacity={0.2 + 0.6 * threat} className={threat >= 0.8 ? 'fm-pulse' : undefined} />
              )}
              <path d={HQ_ZONES.get(h.id as HqId)} fill={P.zone} stroke={P.hq} strokeOpacity={0.3} strokeWidth={1} strokeDasharray="4 4" vectorEffect={NS} />
            </g>
          ))}

        {coverageEls}

        {/* scan rings: pulse + the covered corridors */}
        {ringNodes.map((r) => {
          const c = r.tone === 'cyan' ? SEM.cyan : r.tone === 'alert' ? SEM.alert : SEM.warn;
          const o = pos(r.nodeId);
          const inSet = new Set(r.set);
          const reach = Math.max(...r.set.map((n) => Math.hypot(pos(n).x - o.x, pos(n).y - o.y)), 40) + 16 * u;
          return (
            <g key={`ring-${r.nodeId}-${r.tone}`} pointerEvents="none">
              <circle cx={o.x} cy={o.y} r={reach} fill={c} fillOpacity={0.05} stroke={c} strokeOpacity={0.9} strokeWidth={1.4} vectorEffect={NS} className="fm-scan-out fm-centered" />
              {[...CORRIDORS.values()]
                .filter((cc) => inSet.has(cc.a) && inSet.has(cc.b))
                .map((cc) => (
                  <path key={cc.id} d={cc.d} fill="none" stroke={c} strokeOpacity={0.5} strokeWidth={2.2} strokeLinecap="round" vectorEffect={NS} />
                ))}
              {r.set.map((n) => (
                <circle key={n} cx={pos(n).x} cy={pos(n).y} r={13 * u} fill={c} fillOpacity={0.1} stroke={c} strokeOpacity={0.55} strokeWidth={1} strokeDasharray="3 3" vectorEffect={NS} />
              ))}
            </g>
          );
        })}

        {/* sensor tripwires (sensor radius = own node + neighbours), along the corridors */}
        {sensorNodes.map(({ n, tone }) => (
          <g key={`trip-${n}`} pointerEvents="none" stroke={tone} strokeOpacity={0.55} strokeWidth={1.4} fill="none">
            {graph
              .within(n, SENSOR_RADIUS_HOPS)
              .filter((m) => m !== n)
              .map((m) => {
                const b = pos(m);
                return (
                  <g key={m}>
                    <path d={pointsToD(corridorPoints(n, m, 0.08, 0.72))} strokeDasharray="1 3" vectorEffect={NS} strokeLinecap="round" />
                    <circle cx={b.x} cy={b.y} r={8 * u} strokeOpacity={0.35} vectorEffect={NS} />
                  </g>
                );
              })}
          </g>
        ))}

        {/* attack paths (monster) */}
        {attackPaths.map((a) => {
          const h = activeHq;
          const ap = h?.approaches.find((x) => x.id === a.approachId);
          if (!h || !ap) return null;
          const dp = doorLayout(h.id, u).get(ap.id)!;
          const pts = a.path.length > 1 ? pathPoints(a.path) : [pos(a.path[0]!)];
          const d = pointsToD([...pts, dp]);
          return <path key={`atk-${a.approachId}`} d={d} fill="none" stroke={P.attack} strokeOpacity={0.42} strokeWidth={1.4} strokeDasharray="5 4" strokeLinejoin="round" vectorEffect={NS} pointerEvents="none" />;
        })}

        {/* reachable next hops (monster move mode): chevrons along each corridor */}
        {nextHops.map((n) => {
          const hit = CORRIDORS.size ? corridorPoints(monsterOrigin!, n, 0.16, 0.8) : [];
          if (hit.length < 2) return null;
          return (
            <path
              key={`hop-${n}`}
              d={pointsToD(hit)}
              fill="none"
              stroke={hlColor}
              strokeOpacity={0.75}
              strokeWidth={1.8}
              strokeLinecap="round"
              vectorEffect={NS}
              markerEnd={`url(#${uid}-chev)`}
              pointerEvents="none"
            />
          );
        })}

        {/* planned route */}
        {pathD && (
          <g pointerEvents="none">
            <path d={pathD} fill="none" stroke={P.path} strokeOpacity={0.2} strokeWidth={10} strokeLinecap="round" strokeLinejoin="round" vectorEffect={NS} />
            <path d={pathD} fill="none" stroke={P.path} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" strokeDasharray="8 4" vectorEffect={NS} className="fm-flow" />
          </g>
        )}

        {/* HQs: spokes, gates, keep */}
        {hqs.map((h) => {
          const focus = props.hqId === h.id;
          const clickable = !!props.onHqClick;
          const doors = doorLayout(h.id, u);
          return (
            <g key={h.id}>
              {h.approaches.map((ap) => {
                const p = pos(ap.fromNode);
                const dp = doors.get(ap.id)!;
                const breach = props.breachApproachId === ap.id;
                const d = doorStateOf(props, ap.id, theme);
                const showDoor = focus && !props.allHqs;
                const col = breach ? '#ff4d5e' : d.jammed ? SEM.warn : d.closed ? SEM.ok : d.known ? P.nodeRingKey : SEM.dim;
                const ang = (dp.angle * 180) / Math.PI;
                return (
                  <g key={ap.id} pointerEvents={showDoor ? 'auto' : 'none'}>
                    <line
                      x1={showDoor ? dp.x : h.tactical.x}
                      y1={showDoor ? dp.y : h.tactical.y}
                      x2={p.x}
                      y2={p.y}
                      stroke={breach ? '#ff4d5e' : focus ? P.hq : SEM.dim}
                      strokeOpacity={breach ? 0.95 : focus ? 0.55 : 0.4}
                      strokeWidth={breach ? 2.4 : 1.3}
                      strokeDasharray={breach ? undefined : '2 3'}
                      vectorEffect={NS}
                      className={breach ? 'fm-pulse-fast' : undefined}
                    />
                    {breach && props.breachProgress !== undefined && (
                      <line x1={p.x} y1={p.y} x2={p.x + (dp.x - p.x) * props.breachProgress} y2={p.y + (dp.y - p.y) * props.breachProgress} stroke="#ff8a93" strokeWidth={4} vectorEffect={NS} />
                    )}
                    {showDoor && (
                      <g transform={`rotate(${ang + 90} ${dp.x} ${dp.y})`}>
                        <title>{`${ap.door} · ${ap.label}`}</title>
                        <rect x={dp.x - 6.5 * u} y={dp.y - 2.6 * u} width={13 * u} height={5.2 * u} fill={P.nodeFill} stroke={col} strokeWidth={1.3} vectorEffect={NS} className={breach || d.battering ? 'fm-pulse-fast' : undefined} />
                        {d.closed ? (
                          <rect x={dp.x - 4.6 * u} y={dp.y - 1.1 * u} width={9.2 * u} height={2.2 * u} fill={col} />
                        ) : (
                          <>
                            <rect x={dp.x - 4.6 * u} y={dp.y - 1.1 * u} width={2.8 * u} height={2.2 * u} fill={col} />
                            <rect x={dp.x + 1.8 * u} y={dp.y - 1.1 * u} width={2.8 * u} height={2.2 * u} fill={col} />
                          </>
                        )}
                        {d.heat !== undefined && d.heat > 0.02 && (
                          <rect x={dp.x - 6.5 * u} y={dp.y + 4 * u} width={13 * u * Math.min(1, d.heat)} height={1.5 * u} fill={d.heat > 0.75 ? SEM.alert : d.heat > 0.45 ? SEM.warn : SEM.cyan} />
                        )}
                      </g>
                    )}
                  </g>
                );
              })}
              <g
                className={clsx('fm-hq', clickable && 'cursor-pointer')}
                data-hq={h.id}
                tabIndex={clickable ? 0 : undefined}
                role={clickable ? 'button' : undefined}
                aria-label={clickable ? `Select ${h.name}` : undefined}
                onClick={clickable ? () => props.onHqClick!(h.id as HqId) : undefined}
                onKeyDown={
                  clickable
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          props.onHqClick!(h.id as HqId);
                        }
                      }
                    : undefined
                }
              >
                <circle cx={h.tactical.x} cy={h.tactical.y} r={20 * u} fill="transparent" />
                {focus && (
                  <rect
                    x={h.tactical.x - 13 * u}
                    y={h.tactical.y - 13 * u}
                    width={26 * u}
                    height={26 * u}
                    fill="none"
                    stroke={P.hq}
                    strokeOpacity={0.5}
                    strokeWidth={1}
                    vectorEffect={NS}
                    transform={`rotate(45 ${h.tactical.x} ${h.tactical.y})`}
                    className="fm-pulse"
                  />
                )}
                <rect
                  x={h.tactical.x - 8.5 * u}
                  y={h.tactical.y - 8.5 * u}
                  width={17 * u}
                  height={17 * u}
                  fill={focus ? P.hqFill : P.nodeFill}
                  stroke={focus ? P.hq : P.hqIdle}
                  strokeWidth={focus ? 2 : 1.3}
                  vectorEffect={NS}
                  transform={`rotate(45 ${h.tactical.x} ${h.tactical.y})`}
                />
                <rect x={h.tactical.x - 3 * u} y={h.tactical.y - 3 * u} width={6 * u} height={6 * u} fill={focus ? P.hq : P.hqIdle} transform={`rotate(45 ${h.tactical.x} ${h.tactical.y})`} />
                <circle className="fm-hq-focus" cx={h.tactical.x} cy={h.tactical.y} r={18 * u} fill="none" stroke={P.accent} strokeWidth={1.5} vectorEffect={NS} />
                <title>{h.name}</title>
              </g>
            </g>
          );
        })}

        {/* nodes */}
        {NETWORK.nodes.map((n) => (
          <NodeGlyph
            key={n.id}
            id={n.id}
            name={n.name}
            x={n.tactical.x}
            y={n.tactical.y}
            u={u}
            theme={theme}
            status={camStatus[n.id] ?? 'none'}
            marks={marksOf(n.id)}
            hl={props.highlight?.has(n.id) ? hlColor : ''}
            sel={props.selectedNode === n.id}
            key2={approachNodes.has(n.id)}
            tabbable={tabNode === n.id}
            interactive={!!props.onNodeClick}
            api={api}
          />
        ))}

        {/* sightings */}
        <g pointerEvents="none">
          {(props.sightings ?? []).map((s) => {
            const p = pos(s.nodeId);
            const fade = Math.max(0.12, Math.pow(Math.max(0, 1 - s.age), 1.4));
            const sensor = s.source === 'sensor';
            const c = s.flagged ? '#7d8890' : sensor ? SEM.warn : '#ff3b4c';
            const r = (sensor ? 19 : 9 + 6 * s.confidence) * u;
            return (
              <g key={s.id} opacity={fade}>
                <g className="fm-sight-in fm-centered">
                  <circle cx={p.x} cy={p.y} r={r} fill={s.flagged || sensor ? 'none' : c} fillOpacity={0.12} stroke={c} strokeWidth={s.age < 0.15 ? 2 : 1.4} strokeDasharray={s.flagged ? '2 3' : sensor ? '5 4' : undefined} vectorEffect={NS} />
                  {!sensor && !s.flagged && (
                    <g stroke={c} strokeWidth={1.2}>
                      <line vectorEffect={NS} x1={p.x - r - 4 * u} y1={p.y} x2={p.x - r + 2 * u} y2={p.y} />
                      <line vectorEffect={NS} x1={p.x + r - 2 * u} y1={p.y} x2={p.x + r + 4 * u} y2={p.y} />
                      <line vectorEffect={NS} x1={p.x} y1={p.y - r - 4 * u} x2={p.x} y2={p.y - r + 2 * u} />
                      <line vectorEffect={NS} x1={p.x} y1={p.y + r - 2 * u} x2={p.x} y2={p.y + r + 4 * u} />
                    </g>
                  )}
                </g>
                {s.age < 0.05 && !s.flagged && <circle cx={p.x} cy={p.y} r={r} fill="none" stroke={c} strokeWidth={1.5} vectorEffect={NS} className="fm-shock fm-centered" />}
              </g>
            );
          })}
        </g>

        {/* last known: corner-bracket reticle */}
        {props.lastKnown && (
          <g pointerEvents="none" stroke="#ff4d5e" strokeWidth={1.6} fill="none">
            {(() => {
              const p = pos(props.lastKnown);
              const s = 12.5 * u, l = 5 * u;
              return (
                <g className="fm-pulse">
                  {[
                    [-1, -1],
                    [1, -1],
                    [1, 1],
                    [-1, 1],
                  ].map(([sx, sy]) => (
                    <path key={`${sx}${sy}`} vectorEffect={NS} d={`M${p.x + sx! * s},${p.y + sy! * (s - l)} L${p.x + sx! * s},${p.y + sy! * s} L${p.x + sx! * (s - l)},${p.y + sy! * s}`} />
                  ))}
                </g>
              );
            })()}
          </g>
        )}

        {/* held / containment */}
        {props.held && (
          <g pointerEvents="none">
            {(() => {
              const p = pos(props.held);
              const r = 18 * u;
              const circ = 2 * Math.PI * r;
              return (
                <>
                  <circle cx={p.x} cy={p.y} r={r} fill="#c8323a" fillOpacity={0.1} stroke="#ff4d5e" strokeWidth={1.8} strokeDasharray={`${6 * u} ${4 * u}`} className="fm-spin fm-centered" />
                  {props.containmentProgress != null && (
                    <circle
                      cx={p.x}
                      cy={p.y}
                      r={r + 5 * u}
                      fill="none"
                      stroke={SEM.ok}
                      strokeWidth={3}
                      vectorEffect={NS}
                      strokeDasharray={`${(circ + 31.4 * u) * props.containmentProgress} ${circ * 2}`}
                      transform={`rotate(-90 ${p.x} ${p.y})`}
                    />
                  )}
                </>
              );
            })()}
          </g>
        )}

        {/* monster */}
        {props.monster && (props.monster.nodeId || props.monster.moving) && (
          <g ref={monsterRef} pointerEvents="none">
            <circle r={44 * u} fill={`url(#${uid}-mglow)`} className="fm-breathe fm-centered" />
            <circle r={10.5 * u} fill="none" stroke="#ff4d64" strokeOpacity={0.55} strokeWidth={1} vectorEffect={NS} className="fm-ripple fm-centered" />
            <circle r={6.2 * u} fill="#e0304c" stroke="#ffd0d7" strokeWidth={1.6} vectorEffect={NS} />
            <ellipse rx={1.15 * u} ry={3.4 * u} fill="#1a0306" />
          </g>
        )}

        {labelEls}
      </svg>

      {/* vignette */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            theme === 'monster'
              ? 'radial-gradient(ellipse at 50% 45%, transparent 60%, rgba(10,2,2,0.5) 100%)'
              : 'radial-gradient(ellipse at 50% 45%, transparent 62%, rgba(0,3,5,0.45) 100%)',
        }}
      />

      {tip && (
        <NodeTooltip
          id={tip.id}
          theme={theme}
          x={(tip.tactical.x - vb.x) * k}
          y={(tip.tactical.y - vb.y) * k}
          W={W}
          H={H}
          inset={props.inset}
          props={props}
          sourceMode={tip.cameraId ? sources[tip.cameraId]?.mode : undefined}
        />
      )}

      {props.cursorHint && (
        <div className="pointer-events-none absolute left-2 top-2 border border-edge bg-black/70 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-cyan">{props.cursorHint}</div>
      )}

      {!props.noLegend && (
        <div className="absolute bottom-2 left-2 flex flex-col items-start gap-1">
          {legend && <Legend theme={theme} />}
          <div className="fm-ctl">
            <button
              type="button"
              onClick={() => setLegend((v) => !v)}
              aria-pressed={legend}
              title="Map key"
              data-testid="map-legend-toggle"
              style={{ width: 'auto', padding: '0 8px', fontSize: 10, letterSpacing: '0.08em' }}
            >
              {legend ? 'Hide key' : 'Key'}
            </button>
          </div>
        </div>
      )}

      {zoomable && (
        // top-right under the mode toggle, as in the geographic mode
        <div className="fm-ctl absolute right-2" style={{ top: iT + 6 }} data-testid="map-zoom">
          <button type="button" aria-label="Zoom in" onClick={() => setView((v) => clampView(v.z * 1.4, v.cx, v.cy))}>
            +
          </button>
          <button type="button" aria-label="Zoom out" onClick={() => setView((v) => clampView(v.z / 1.4, v.cx, v.cy))}>
            −
          </button>
          <button
            type="button"
            aria-label="Reset view"
            title="Fit whole Bay"
            onClick={() => setView(clampView(1, BASE_BOX.x + BASE_BOX.w / 2, BASE_BOX.y + BASE_BOX.h / 2))}
            style={{ fontSize: 11 }}
          >
            ⤢
          </button>
        </div>
      )}
    </div>
  );
}

/** Which side of its keep an HQ name goes (away from its approach cameras). */
function hqLabelSide(id: string): number {
  return { 'hq-sf': Math.PI, 'hq-oakland': 0, 'hq-stanford': (3 * Math.PI) / 4, 'hq-sanjose': Math.PI / 2 }[id] ?? Math.PI / 2;
}

// ---------------------------------------------------------------------------------------------------------

const STATUS_TEXT: Record<CameraGameStatus, string> = {
  ok: 'Online',
  sabotaged: 'Feed tampered',
  repairing: 'Repair in progress',
  static: 'Interference',
  blackout: 'Blackout (power)',
};
const SOURCE_TEXT: Record<string, string> = {
  live: 'Live video',
  snapshot: 'Live snapshots',
  simulated: 'Simulated feed',
  offline: 'Source offline',
};
const MARK_TEXT: Record<MarkKind, [string, string]> = {
  sensor: ['Motion sensor armed', SEM.cyan],
  sensorOff: ['Sensor disabled', SEM.dim],
  trap: ['Trap live', SEM.alert],
  trapArming: ['Trap arming', SEM.alert],
  lure: ['Lure sounding', SEM.warn],
  knownSensor: ['Their sensor is here', SEM.warn],
  disturbance: ['Disturbance heard', SEM.warn],
  scanPulse: ['They scanned here', SEM.cyan],
  exposure: ['You may have been seen', '#ff4d5e'],
  spawn: ['Spawn point', '#e04a62'],
};

export function NodeTooltip(p: { id: string; theme: MapTheme; x: number; y: number; W: number; H: number; props: MapLayers; sourceMode?: string; inset?: MapInset }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    setBox((b) => (b && b.w === w && b.h === h ? b : { w, h }));
  });
  const n = NODE_BY_ID.get(p.id);
  if (!n) return null;
  const cam = n.cameraId ? CAMERA_BY_ID.get(n.cameraId) : undefined;
  const status = p.props.cameraStatus?.[p.id];
  const marks = p.props.marks?.[p.id] ?? [];
  const sights = (p.props.sightings ?? []).filter((s) => s.nodeId === p.id);
  const hops = p.props.hqId ? hopsToHq(p.id, p.props.hqId) : null;
  const notes = p.props.nodeNotes?.[p.id] ?? [];
  // Place beside the node (right, then left), below / above by half; then clamp into the visible area
  // (minus the screen's overlay insets) so the card never runs off an edge.
  const M = 6, GAP = 16;
  const L = (p.inset?.left ?? 0) + M, R = p.W - (p.inset?.right ?? 0) - M, T = (p.inset?.top ?? 0) + M, B = p.H - (p.inset?.bottom ?? 0) - M;
  const bw = box?.w ?? 220, bh = box?.h ?? 120;
  let left = p.x + GAP;
  if (left + bw > R) left = p.x - GAP - bw;
  if (left < L) left = Math.max(L, Math.min(R - bw, p.x - bw / 2));
  let top = p.y < (T + B) / 2 ? p.y + 10 : p.y - 10 - bh;
  // when centred horizontally over the node, keep it clear vertically
  if (left < p.x && left + bw > p.x) top = p.y < (T + B) / 2 ? p.y + GAP : p.y - GAP - bh;
  top = Math.max(T, Math.min(B - bh, top));
  left = Math.max(L, Math.min(R - bw, left));
  const style: React.CSSProperties = { left, top, visibility: box ? 'visible' : 'hidden' };
  const statusColor = status
    ? status === 'ok'
      ? p.theme === 'monster'
        ? '#e8d8bf'
        : SEM.ok
      : status === 'sabotaged'
        ? '#ff6b74'
        : status === 'repairing'
          ? SEM.cyan
          : SEM.warn
    : undefined;
  const routes = [cam?.route, ...(NODE_ROUTE_KEYS.get(n.id) ?? []), ...(NODE_ROUTES.get(n.id) ?? [])].filter((v, i, a) => v && a.indexOf(v) === i).slice(0, 3);
  return (
    <div ref={ref} className="fm-tip" data-theme={p.theme} style={style} role="tooltip" data-testid="map-tooltip">
      <h4>{n.name}</h4>
      <div className="fm-tip-sub">{routes.join(' / ')}</div>
      <dl>
        {status && (
          <>
            <dt>{p.theme === 'monster' ? 'Their camera' : 'Camera'}</dt>
            <dd style={{ color: statusColor }}>{p.theme === 'monster' && status === 'sabotaged' ? 'Blinded' : STATUS_TEXT[status]}</dd>
          </>
        )}
        {p.sourceMode && (
          <>
            <dt>Source</dt>
            <dd style={{ color: p.sourceMode === 'offline' ? '#ff8a93' : p.sourceMode === 'simulated' ? SEM.warn : undefined }}>{SOURCE_TEXT[p.sourceMode] ?? p.sourceMode}</dd>
          </>
        )}
        {cam && (
          <>
            <dt>Caltrans</dt>
            <dd>{cam.caltransIndex}</dd>
          </>
        )}
        {hops !== null && (
          <>
            <dt>To HQ</dt>
            <dd>{hops === 0 ? 'At a door' : `${hops} hop${hops === 1 ? '' : 's'}`}</dd>
          </>
        )}
      </dl>
      {(marks.length > 0 || sights.length > 0 || notes.length > 0) && (
        <ul>
          {marks.map((m) => (
            <li key={m} style={{ color: MARK_TEXT[m][1] }}>
              <span style={{ color: '#c9d2d8' }}>{MARK_TEXT[m][0]}</span>
            </li>
          ))}
          {sights.slice(-3).map((s) => (
            <li key={s.id} style={{ color: s.flagged ? '#7d8890' : '#ff4d5e' }}>
              <span style={{ color: '#c9d2d8' }}>
                {s.flagged ? 'False sighting' : `Sighting (${s.source})`} · {Math.round(s.confidence * 100)}%
              </span>
            </li>
          ))}
          {notes.map((t) => (
            <li key={t} style={{ color: SEM.dim }}>
              <span style={{ color: '#c9d2d8' }}>{t}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Legend({ theme }: { theme: MapTheme }) {
  const P = PALETTES[theme];
  const Dot = ({ c, ring }: { c: string; ring?: string }) => (
    <svg width="16" height="14" viewBox="-8 -7 16 14" aria-hidden>
      <circle r="4.6" fill={P.nodeFill} stroke={ring ?? P.nodeRing} strokeWidth="1.3" />
      <circle r="2.1" fill={c} />
    </svg>
  );
  const Sym = ({ children }: { children: React.ReactNode }) => (
    <svg width="16" height="14" viewBox="-8 -7 16 14" aria-hidden>
      {children}
    </svg>
  );
  const tone = P.route['I-80']!;
  const lines: Array<[React.ReactNode, string]> = [
    [
      <Sym>
        <line x1="-8" y1="0" x2="8" y2="0" stroke={tone} strokeWidth="3.4" />
      </Sym>,
      'Freeway (one tone per route)',
    ],
    [
      <Sym>
        <line x1="-8" y1="0" x2="8" y2="0" stroke={tone} strokeWidth="6.4" />
        <line x1="-8" y1="0" x2="8" y2="0" stroke={P.water} strokeWidth="2.6" />
      </Sym>,
      'Bridge span',
    ],
    [
      <Sym>
        <line x1="-8" y1="0" x2="8" y2="0" stroke={tone} strokeWidth="3.4" strokeDasharray="4 3" />
      </Sym>,
      'Tunnel',
    ],
  ];
  const rows: Array<[React.ReactNode, string]> =
    theme === 'defender'
      ? [
          [<Dot c={P.cam.ok} />, 'Camera online'],
          [<Dot c={P.cam.static} />, 'Interference'],
          [
            <Sym>
              <circle r="4.6" fill="none" stroke={SEM.alert} strokeDasharray="2 1.5" />
              <path d="M-2.3,-2.3L2.3,2.3M2.3,-2.3L-2.3,2.3" stroke="#ff5a63" />
            </Sym>,
            'Feed tampered',
          ],
          [
            <Sym>
              <path d={arc(0, 0, 5, -140, -40)} stroke={SEM.cyan} fill="none" strokeWidth="1.5" />
              <path d={arc(0, 0, 5, 40, 140)} stroke={SEM.cyan} fill="none" strokeWidth="1.5" />
            </Sym>,
            'Motion sensor',
          ],
          [
            <Sym>
              <rect x="-3" y="-3" width="6" height="6" fill={SEM.alert} transform="rotate(45)" />
            </Sym>,
            'Trap',
          ],
          [
            <Sym>
              <circle r="5" fill="none" stroke="#ff3b4c" strokeWidth="1.4" />
            </Sym>,
            'Sighting (fades)',
          ],
          [
            <Sym>
              <path d="M-5,-2V-5H-2M2,-5H5V-2M5,2V5H2M-2,5H-5V2" fill="none" stroke="#ff4d5e" strokeWidth="1.4" />
            </Sym>,
            'Last known',
          ],
          [
            <Sym>
              <rect x="-5" y="-2" width="10" height="4" fill={P.nodeFill} stroke={SEM.ok} />
              <rect x="-3.5" y="-0.8" width="7" height="1.6" fill={SEM.ok} />
            </Sym>,
            'HQ gate (sealed)',
          ],
          ...lines,
        ]
      : [
          [<Dot c={P.cam.ok} />, 'Working camera (watching)'],
          [
            <Sym>
              <circle r="4.6" fill="none" stroke="#7a2a2e" strokeDasharray="2 1.5" />
              <path d="M-2.3,-2.3L2.3,2.3M2.3,-2.3L-2.3,2.3" stroke="#9a3a3e" />
            </Sym>,
            'Blinded camera',
          ],
          [
            <Sym>
              <path d={arc(0, 0, 5, -140, -40)} stroke={SEM.warn} fill="none" strokeWidth="1.5" />
              <path d={arc(0, 0, 5, 40, 140)} stroke={SEM.warn} fill="none" strokeWidth="1.5" />
            </Sym>,
            'Known sensor',
          ],
          [
            <Sym>
              <line x1="-7" y1="0" x2="7" y2="0" stroke={P.path} strokeWidth="2" strokeDasharray="3 2" />
            </Sym>,
            'Planned route',
          ],
          [
            <Sym>
              <line x1="-7" y1="0" x2="7" y2="0" stroke={P.attack} strokeOpacity="0.6" strokeDasharray="3 2" />
            </Sym>,
            'Attack path to a gate',
          ],
          [
            <Sym>
              <circle r="5" fill="none" stroke="#ff4d5e" strokeDasharray="1 2" />
            </Sym>,
            'You may have been seen',
          ],
          [
            <Sym>
              <circle r="5" fill="none" stroke={SEM.cyan} strokeDasharray="1 2" />
            </Sym>,
            'Scan felt here',
          ],
          [
            <Sym>
              <circle r="5" fill="none" stroke={SEM.warn} />
            </Sym>,
            'Disturbance',
          ],
          ...lines,
        ];
  return (
    <div className="fm-legend" data-theme={theme} data-testid="map-legend">
      {rows.map(([icon, text]) => (
        <div key={text} className="fm-legend-row">
          {icon}
          <span>{text}</span>
        </div>
      ))}
      <div className="fm-legend-credit">Not to scale. Shoreline from Natural Earth (public domain).</div>
    </div>
  );
}
