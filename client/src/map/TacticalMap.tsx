// Stylised SVG tactical map over node `tactical` coordinates (the default map mode).
//
// Layers, bottom → top: land + terrain + hand-authored Bay water with bathymetric contours (static, memoised)
// → region / water labels → graph edges (bridges as double-rail spans) → defended zone + threat heat →
// camera coverage halos → scan rings / highlights → sensor tripwires → attack paths + planned route →
// HQ spokes + doors → nodes → sightings → last known / held → monster (rAF-interpolated) → labels
// (collision-placed with leader lines). Stroke widths are screen pixels (non-scaling) and glyph / font sizes
// are derived from the measured pixels-per-unit, so the map reads the same at 1280×720 and on a 4K wall.
//
// Performance: static geometry is module-level; the base layer and every node glyph are memoised on
// primitive props, so a 10 Hz view update only touches the few dynamic layers that actually changed.
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import clsx from 'clsx';
import type { CameraGameStatus, HqId } from '@fnab/shared';
import { CAMERA_BY_ID, graph, NETWORK } from '../lib/data';
import { useGame } from '../state/store';
import { ISLAND_PATHS, REGION_LABELS, RIDGE_PATHS, WATER_PATH } from './bay';
import {
  approachShort,
  attackPathsFrom,
  BASE_BOX,
  doorLayout,
  HQ_SHORT,
  edgeKey,
  HQ_BY_ID,
  HQ_ZONES,
  hopsToHq,
  NODE_BY_ID,
  NODE_ROUTES,
  pos,
  type XY,
} from './derive';
import { placeLabels, textWidthPx, type LabelRequest, type Obstacle } from './labels';
import { resolveTheme, SENSOR_RADIUS_HOPS, type DoorState, type MapLayers, type MapProps, type MapTheme, type MarkKind } from './layers';
import { PALETTES, SEM, type MapPalette } from './theme';
import { useMonsterMotion } from './useMonsterMotion';
import './map.css';

export type { MapLayers, MarkKind, MapTheme, DoorState } from './layers';
export { monsterXY } from './derive';

const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const NS = 'non-scaling-stroke' as const;

type Vb = { x: number; y: number; w: number; h: number };

// ---------------------------------------------------------------------------------------------------------
// Static base: land, terrain, water, coast, labels, edges. Re-renders only on theme / zoom-scale changes.

const BaseLayer = memo(function BaseLayer({ theme, u, uid, hqId }: { theme: MapTheme; u: number; uid: string; hqId: string | null }) {
  const P = PALETTES[theme];
  const big = 6000;
  return (
    <g aria-hidden="true">
      <rect x={-big} y={-big} width={big * 2} height={big * 2} fill={P.land} />
      <rect x={-big} y={-big} width={big * 2} height={big * 2} fill={`url(#${uid}-grid)`} />
      {RIDGE_PATHS.map((r) => (
        <g key={r.id} fill="none" stroke={P.ridge} strokeWidth={1} vectorEffect={NS}>
          {[1, 0.72, 0.46, 0.22].map((s) => (
            <path key={s} d={r.d} vectorEffect={NS} transform={`translate(${r.cx * (1 - s)} ${r.cy * (1 - s)}) scale(${s})`} />
          ))}
        </g>
      ))}
      {/* water + bathymetric contours: paired strokes (contour colour, then water colour 2px thinner) clipped
          to the water leave thin lines at fixed pixel offsets from the shore */}
      <path d={WATER_PATH} fill={P.water} />
      <g clipPath={`url(#${uid}-wclip)`} fill="none">
        {[54, 34, 20, 9].map((d) => (
          <g key={d}>
            <path d={WATER_PATH} stroke={P.contour} strokeWidth={d * 2 + 1} vectorEffect={NS} />
            <path d={WATER_PATH} stroke={P.water} strokeWidth={d * 2 - 1} vectorEffect={NS} />
          </g>
        ))}
        <path d={WATER_PATH} stroke={P.coast} strokeOpacity={0.12} strokeWidth={8} vectorEffect={NS} />
      </g>
      <path d={WATER_PATH} fill="none" stroke={P.coast} strokeWidth={1.1} vectorEffect={NS} />
      {ISLAND_PATHS.map((i) => (
        <path key={i.id} d={i.d} fill={P.landEdge} stroke={P.coast} strokeWidth={0.9} vectorEffect={NS} />
      ))}
      {REGION_LABELS.filter((l) => !l.hideFor || l.hideFor !== hqId).map((l) => (
        <text
          key={l.id}
          x={l.rotate ? l.x : clampLabelX(l, u)}
          y={l.y}
          className={l.kind === 'region' ? 'fm-region' : 'fm-water'}
          fill={l.kind === 'region' ? P.regionLabel : P.waterLabel}
          fontSize={(l.kind === 'region' ? 10.5 : 10) * u}
          letterSpacing={(l.kind === 'region' ? 3.2 : 1.2) * u}
          textAnchor="middle"
          dominantBaseline="central"
          transform={l.rotate ? `rotate(${l.rotate} ${l.x} ${l.y})` : undefined}
        >
          {l.text}
        </text>
      ))}
      <EdgesLayer P={P} u={u} />
    </g>
  );
});

/** Keep horizontal region labels inside the base extent at any scale. */
function clampLabelX(l: (typeof REGION_LABELS)[number], u: number): number {
  const hw = (textWidthPx(l.text, l.kind === 'region' ? 10.5 : 10, false, l.kind === 'region' ? 3.2 : 1.2) * u) / 2 + 6 * u;
  return Math.min(Math.max(l.x, BASE_BOX.x + hw), BASE_BOX.x + BASE_BOX.w - hw);
}

function EdgesLayer({ P, u }: { P: MapPalette; u: number }) {
  return (
    <g>
      {NETWORK.edges.map((e) => {
        const a = pos(e.a);
        const b = pos(e.b);
        const title = <title>{`${e.route} · ${e.lengthKm} km`}</title>;
        if (e.kind === 'bridge') {
          // span: soft glow, light casing, dark deck, dashed centre line, pier ticks
          const dx = b.x - a.x, dy = b.y - a.y;
          const len = Math.hypot(dx, dy) || 1;
          const nx = -dy / len, ny = dx / len;
          const piers = Math.max(2, Math.floor((len / u) / 22));
          const tick = 4.5 * u;
          return (
            <g key={e.id}>
              {title}
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={P.bridge} strokeOpacity={0.12} strokeWidth={11} vectorEffect={NS} strokeLinecap="round" />
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={P.bridge} strokeOpacity={0.75} strokeWidth={5} vectorEffect={NS} />
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={P.bridgeDeck} strokeWidth={2.6} vectorEffect={NS} />
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={P.bridge} strokeOpacity={0.55} strokeWidth={0.8} strokeDasharray="4 4" vectorEffect={NS} />
              {Array.from({ length: piers - 1 }, (_, i) => {
                const t = (i + 1) / piers;
                const cx = a.x + dx * t, cy = a.y + dy * t;
                return (
                  <line
                    key={i}
                    x1={cx - nx * tick}
                    y1={cy - ny * tick}
                    x2={cx + nx * tick}
                    y2={cy + ny * tick}
                    stroke={P.bridge}
                    strokeOpacity={0.45}
                    strokeWidth={1}
                    vectorEffect={NS}
                  />
                );
              })}
            </g>
          );
        }
        if (e.kind === 'tunnel') {
          return (
            <g key={e.id}>
              {title}
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={P.tunnel} strokeWidth={2.4} strokeDasharray="2 4" strokeLinecap="round" vectorEffect={NS} />
            </g>
          );
        }
        return (
          <line
            key={e.id}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke={e.kind === 'surface' ? P.roadSurface : P.road}
            strokeWidth={e.kind === 'surface' ? 1.6 : 2.4}
            strokeLinecap="round"
            vectorEffect={NS}
          >
            {title}
          </line>
        );
      })}
    </g>
  );
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
  key2: boolean; // approach / key node
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
      <circle cx={x} cy={y} r={15 * u} fill="transparent" />
      {p.hl && (
        <circle cx={x} cy={y} r={11.5 * u} fill={p.hl} fillOpacity={0.14} stroke={p.hl} strokeOpacity={0.75} strokeWidth={1.2} vectorEffect={NS} />
      )}
      {has('spawn') && (
        <>
          <circle cx={x} cy={y} r={10 * u} fill="none" stroke="#c0263f" strokeWidth={1.6} vectorEffect={NS} />
          <circle cx={x} cy={y} r={10 * u} fill="none" stroke="#e04a62" strokeWidth={1.2} vectorEffect={NS} className="fm-ripple fm-centered" />
        </>
      )}
      {has('scanPulse') && (
        <circle cx={x} cy={y} r={13 * u} fill="none" stroke={SEM.cyan} strokeOpacity={0.8} strokeWidth={1} strokeDasharray="1.5 3" vectorEffect={NS} />
      )}
      {has('exposure') && (
        <circle cx={x} cy={y} r={11 * u} fill="none" stroke="#ff4d5e" strokeWidth={1.3} strokeDasharray="1 2.5" vectorEffect={NS} className="fm-pulse" />
      )}
      {has('disturbance') && (
        <circle cx={x} cy={y} r={12 * u} fill="none" stroke={SEM.warn} strokeWidth={1.4} vectorEffect={NS} className="fm-ripple fm-centered" />
      )}
      {/* sensor: twin radar arcs */}
      {(has('sensor') || has('sensorOff') || has('knownSensor')) && (
        <g
          stroke={has('sensorOff') ? SEM.dim : has('knownSensor') ? SEM.warn : SEM.cyan}
          strokeWidth={1.6}
          fill="none"
          strokeDasharray={has('sensorOff') ? '1.5 2.5' : undefined}
        >
          <path vectorEffect={NS} d={arc(x, y, 9 * u, -140, -40)} />
          <path vectorEffect={NS} d={arc(x, y, 9 * u, 40, 140)} />
          <path vectorEffect={NS} strokeOpacity={0.5} d={arc(x, y, 12.5 * u, -125, -55)} />
          <path vectorEffect={NS} strokeOpacity={0.5} d={arc(x, y, 12.5 * u, 55, 125)} />
        </g>
      )}
      {/* node body + camera pip */}
      <circle
        className="fm-body"
        cx={x}
        cy={y}
        r={(p.key2 ? 6.2 : 5.4) * u}
        fill={P.nodeFill}
        stroke={sabotaged ? (p.theme === 'monster' ? '#7a2a2e' : SEM.alert) : p.key2 ? P.nodeRingKey : P.nodeRing}
        strokeWidth={p.key2 ? 1.6 : 1.2}
        strokeDasharray={sabotaged ? '2 1.5' : undefined}
        vectorEffect={NS}
      />
      {sabotaged ? (
        <g stroke={p.theme === 'monster' ? '#9a3a3e' : '#ff5a63'} strokeWidth={1.4} vectorEffect={NS} strokeLinecap="round">
          <line vectorEffect={NS} x1={x - 2.6 * u} y1={y - 2.6 * u} x2={x + 2.6 * u} y2={y + 2.6 * u} />
          <line vectorEffect={NS} x1={x + 2.6 * u} y1={y - 2.6 * u} x2={x - 2.6 * u} y2={y + 2.6 * u} />
        </g>
      ) : p.status === 'repairing' ? (
        <>
          <circle cx={x} cy={y} r={2.4 * u} fill={camC} />
          <circle
            cx={x}
            cy={y}
            r={8 * u}
            fill="none"
            stroke={camC}
            strokeWidth={1.2}
            strokeDasharray={`${4 * u} ${3 * u}`}
            className="fm-spin-fast fm-centered"
          />
        </>
      ) : (
        <circle cx={x} cy={y} r={2.6 * u} fill={camC} />
      )}
      {/* trap: diamond to the upper right */}
      {(has('trap') || has('trapArming')) && (
        <rect
          x={x + 7 * u}
          y={y - 13 * u}
          width={6 * u}
          height={6 * u}
          fill={has('trap') ? SEM.alert : 'none'}
          stroke={has('trap') ? '#ff8a93' : SEM.alert}
          strokeWidth={1.3}
          vectorEffect={NS}
          transform={`rotate(45 ${x + 10 * u} ${y - 10 * u})`}
          className={has('trapArming') ? 'fm-pulse-fast' : undefined}
        />
      )}
      {/* lure: triangle to the upper left */}
      {has('lure') && (
        <path
          d={`M${x - 10 * u},${y - 15 * u} l${3.6 * u},${6.4 * u} l${-7.2 * u},0 z`}
          fill={SEM.warn}
          className="fm-pulse"
        />
      )}
      {p.sel && (
        <g stroke={P.labelStrong} strokeWidth={1.3} vectorEffect={NS} fill="none">
          <circle vectorEffect={NS} cx={x} cy={y} r={10.5 * u} strokeOpacity={0.8} />
          {[0, 90, 180, 270].map((a) => {
            const c = Math.cos((a * Math.PI) / 180), s = Math.sin((a * Math.PI) / 180);
            return <line key={a} vectorEffect={NS} x1={x + c * 13 * u} y1={y + s * 13 * u} x2={x + c * 17 * u} y2={y + s * 17 * u} />;
          })}
        </g>
      )}
      <circle className="fm-focus" cx={x} cy={y} r={15 * u} fill="none" stroke={P.accent} strokeWidth={1.5} vectorEffect={NS} />
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

function polyline(ids: string[]): string {
  return ids.map((id, i) => `${i ? 'L' : 'M'}${pos(id).x},${pos(id).y}`).join('');
}

function doorStateOf(p: MapLayers, approachId: string, theme: MapTheme): (DoorState & { known: boolean }) {
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
      const r = el.getBoundingClientRect();
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
  const k0 = Math.min(W / BASE_BOX.w, H / BASE_BOX.h);
  const k = k0 * view.z;
  const vb: Vb = { x: view.cx - W / k / 2, y: view.cy - H / k / 2, w: W / k, h: H / k };
  // quantise the unit size so memoised layers only re-render on meaningful scale changes
  const u = Math.round((1 / k) * 200) / 200;

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
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      setView((v) => {
        const kk = k0 * v.z;
        const wx = v.cx - W / kk / 2 + mx / kk;
        const wy = v.cy - H / kk / 2 + my / kk;
        const z2 = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.z * Math.exp(-e.deltaY * 0.0016)));
        const k2 = k0 * z2;
        return clampView(z2, wx - mx / k2 + W / k2 / 2, wy - my / k2 + H / k2 / 2);
      });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [k0, W, H, clampView, zoomable]);

  // keep the view valid when the panel resizes
  useEffect(() => setView((v) => clampView(v.z, v.cx, v.cy)), [clampView]);

  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean; id: number } | null>(null);
  const suppressClick = useRef(false);
  const onPointerDown = (e: React.PointerEvent) => {
    if (!zoomable || e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy, moved: false, id: e.pointerId };
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
    setView((v) => clampView(v.z, d.cx - dx / k, d.cy - dy / k));
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
  const pathD = useMemo(() => (props.path && props.path.length > 1 ? polyline(props.path) : ''), [pathKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- monster motion ----
  const project = useCallback((from: string, to: string | null, p: number): XY | null => {
    const a = pos(from);
    if (!to) return a;
    const b = pos(to);
    return { x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p };
  }, []);
  useMonsterMotion(props.monster, project, monsterRef);

  // ---- labels ----
  const spawnNodes = useMemo(
    () => Object.entries(props.marks ?? {}).filter(([, m]) => m.includes('spawn')).map(([n]) => n),
    [props.marks],
  );
  const doorKey = hqs
    .flatMap((h) => h.approaches.map((a) => {
      const d = doorStateOf(props, a.id, theme);
      return `${a.id}:${d.closed ? 1 : 0}${d.jammed ? 'j' : ''}${d.known ? 'k' : ''}${props.breachApproachId === a.id ? 'b' : ''}:${hopsByApproach.get(a.id) ?? ''}`;
    }))
    .join(',');
  const showAllNames = k * 1 >= 0.78;
  // labels grow slightly on big displays (glyphs stay put)
  const fs = Math.min(1.3, Math.max(1, k / 0.9));
  const placed = useMemo(() => {
    const reqs: LabelRequest[] = [];
    const obstacles: Obstacle[] = NETWORK.nodes.map((n) => ({ x: n.tactical.x, y: n.tactical.y, r: 8 }));
    for (const l of REGION_LABELS)
      if (l.kind === 'region' && !(l.hideFor && l.hideFor === props.hqId && !props.allHqs)) obstacles.push({ x: l.x, y: l.y, r: 0, w: textWidthPx(l.text, 10.5, false, 3.2), h: 12 });
    for (const h of hqs) {
      obstacles.push({ x: h.tactical.x, y: h.tactical.y, r: 15 });
      const focus = props.hqId === h.id;
      reqs.push({
        id: `hq-${h.id}`,
        text: k >= 0.75 || props.allHqs ? h.name : (HQ_SHORT[h.id] ?? h.name),
        x: h.tactical.x,
        y: h.tactical.y,
        r: 14,
        size: focus ? 11.5 : 10.5,
        priority: focus ? 100 : 95,
        required: true,
        prefer: Math.PI / 2,
      });
      if (props.allHqs) continue;
      const doors = doorLayout(h.id, u);
      for (const ap of h.approaches) {
        const dp = doors.get(ap.id)!;
        obstacles.push({ x: dp.x, y: dp.y, r: 6 });
        const d = doorStateOf(props, ap.id, theme);
        const breach = props.breachApproachId === ap.id;
        // open (defender) / unknown (monster) is the default state: the glyph shows it, the label stays short
        const state = breach ? ' BREACH' : d.jammed ? ' JAMMED' : d.closed && d.known ? ' SEALED' : '';
        const hops = hopsByApproach.get(ap.id);
        const text = `${approachShort(ap).toUpperCase()}${state}${hops !== undefined ? ` · ${hops}H` : ''}`;
        reqs.push({ id: `door-${ap.id}`, text, x: dp.x, y: dp.y, r: 7, size: 9, mono: true, priority: 90, required: true, prefer: dp.angle });
      }
    }
    const nodeLabel = (id: string, priority: number, required: boolean, size = 10) => {
      const n = NODE_BY_ID.get(id);
      if (!n) return;
      let prefer = -Math.PI / 2;
      if (activeHq && approachNodes.has(id)) prefer = Math.atan2(n.tactical.y - activeHq.tactical.y, n.tactical.x - activeHq.tactical.x);
      reqs.push({ id: `n-${id}`, text: n.name, x: n.tactical.x, y: n.tactical.y, r: 9, size, priority, required, prefer });
    };
    if (props.lastKnown) reqs.push({ id: 'lk', text: 'LAST KNOWN', x: pos(props.lastKnown).x, y: pos(props.lastKnown).y, r: 14, size: 9, mono: true, priority: 85, required: true, prefer: Math.PI / 2 });
    if (props.held) reqs.push({ id: 'held', text: props.containmentProgress != null ? 'CONTAINED' : 'TRAPPED', x: pos(props.held).x, y: pos(props.held).y, r: 18, size: 9.5, mono: true, priority: 86, required: true, prefer: Math.PI / 2 });
    const seen = new Set<string>();
    const add = (id: string | null | undefined, pr: number, req: boolean, sz?: number) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      nodeLabel(id, pr, req, sz);
    };
    add(props.selectedNode, 80, true, 10.5);
    if (monsterFrom && theme === 'monster') add(monsterOrigin, 75, true, 10.5);
    // approach cameras are named by their door labels; spell them out only once there is room
    if (!props.allHqs && k >= 0.9) for (const n of approachNodes) add(n, 60, false);
    if (theme === 'monster') for (const n of spawnNodes) add(n, 55, false);
    add(props.lastKnown, 58, false);
    add(props.held, 58, false);
    if (showAllNames) for (const n of NETWORK.nodes) add(n.id, 10, false, 9.5);
    for (const r of reqs) r.size *= fs;
    return placeLabels(reqs, obstacles, k, vb);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    Math.round(k * 100),
    Math.round(vb.x),
    Math.round(vb.y),
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
    showAllNames,
  ]);

  // ---- tooltip ----
  const tipNode = hover;
  const tip = tipNode ? NODE_BY_ID.get(tipNode) : undefined;

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
    () => (
      <>
        {coverageOn && (
          <g pointerEvents="none">
            {NETWORK.nodes.map((n) => {
              const s = camStatus[n.id];
              if (s === 'ok') return <circle key={n.id} cx={n.tactical.x} cy={n.tactical.y} r={Math.max(24, 22 * u)} fill={`url(#${uid}-cov)`} />;
              if (s === 'sabotaged' && theme === 'defender')
                return (
                  <circle key={n.id} cx={n.tactical.x} cy={n.tactical.y} r={16 * u} fill="#c8323a" fillOpacity={0.07} stroke="#c8323a" strokeOpacity={0.5} strokeWidth={1} strokeDasharray="2 3" vectorEffect={NS} />
                );
              return null;
            })}
          </g>
        )}
      </>
    ),
    [statusSig, coverageOn, theme, u, uid], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const labelEls = useMemo(
    () => (
      <>
        <g pointerEvents="none">
          {placed.map((l) => {
            const isHq = l.id.startsWith('hq-');
            const isDoor = l.id.startsWith('door-');
            const strong = isHq ? props.hqId === l.id.slice(3) : l.id === `n-${props.selectedNode}` || l.id === `n-${monsterOrigin}`;
            let fill = strong ? P.labelStrong : l.priority <= 10 ? P.label : P.label;
            let opacity = l.priority <= 10 ? 0.7 : 1;
            if (isHq) fill = strong ? P.hq : '#9aa3ab';
            if (isDoor) {
              const t = l.text;
              fill = t.includes('BREACH') ? '#ff6b74' : t.includes('JAMMED') ? SEM.warn : t.includes('SEALED') ? '#7fe0a8' : theme === 'monster' ? '#b5a088' : '#b0bac1';
              opacity = 1;
            }
            if (l.id === 'lk' || l.id === 'held') fill = '#ff6b74';
            // leader: nearest point on the label box to the anchor
            let leader: XY | null = null;
            if (l.leader) {
              leader = { x: Math.min(Math.max(l.x, l.box.x), l.box.x + l.box.w), y: Math.min(Math.max(l.y, l.box.y), l.box.y + l.box.h) };
            }
            const ang = leader ? Math.atan2(leader.y - l.y, leader.x - l.x) : 0;
            return (
              <g key={l.id} opacity={opacity}>
                {leader && (
                  <line
                    x1={l.x + Math.cos(ang) * l.r * u}
                    y1={l.y + Math.sin(ang) * l.r * u}
                    x2={leader.x}
                    y2={leader.y}
                    stroke={fill}
                    strokeOpacity={0.7}
                    strokeWidth={0.9}
                    vectorEffect={NS}
                  />
                )}
                <text
                  x={l.lx}
                  y={l.ly}
                  fontSize={l.size * u}
                  fill={fill}
                  textAnchor={l.anchor}
                  dominantBaseline="central"
                  fontWeight={isHq ? 600 : strong ? 600 : 500}
                  className={l.mono ? 'fm-mono' : undefined}
                  letterSpacing={l.mono ? 0.4 * u : undefined}
                  style={{ paintOrder: 'stroke', stroke: P.halo, strokeWidth: 3.2 * u, strokeLinejoin: 'round' }}
                >
                  {l.text}
                </text>
              </g>
            );
          })}
        </g>
      </>
    ),
    [placed, theme, props.hqId, props.selectedNode, monsterOrigin, u], // eslint-disable-line react-hooks/exhaustive-deps
  );

  return (
    <div
      ref={rootRef}
      data-testid="tactical-map"
      data-theme={theme}
      className={clsx('fm-root relative h-full w-full overflow-hidden', props.onNodeClick && 'cursor-crosshair', props.className)}
      style={{ background: P.land }}
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
          <pattern id={`${uid}-grid`} width={40} height={40} patternUnits="userSpaceOnUse">
            <circle cx={20} cy={20} r={0.9} fill={P.grid} />
          </pattern>
          <pattern id={`${uid}-hatch`} width={7} height={7} patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
            <line x1={0} y1={0} x2={0} y2={7} stroke={P.ridge} strokeWidth={1.4} />
          </pattern>
          <clipPath id={`${uid}-wclip`}>
            <path d={WATER_PATH} />
          </clipPath>
          <radialGradient id={`${uid}-mglow`}>
            <stop offset="0%" stopColor="#ff3b55" stopOpacity="0.6" />
            <stop offset="40%" stopColor="#c0263f" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#c0263f" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={`${uid}-cov`}>
            <stop offset="0%" stopColor={theme === 'monster' ? '#e8d8bf' : '#3ec4a0'} stopOpacity={theme === 'monster' ? 0.13 : 0.15} />
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

        <BaseLayer theme={theme} u={u} uid={uid} hqId={props.allHqs ? null : (props.hqId ?? null)} />

        {/* defended zone + threat heat */}
        {!props.allHqs &&
          hqs.map((h) => (
            <g key={`zone-${h.id}`} pointerEvents="none">
              {threat > 0.05 && (
                <circle
                  cx={h.tactical.x}
                  cy={h.tactical.y}
                  r={50 + 70 * threat}
                  fill={`url(#${uid}-heat)`}
                  opacity={0.2 + 0.6 * threat}
                  className={threat >= 0.8 ? 'fm-pulse' : undefined}
                />
              )}
              <path
                d={HQ_ZONES.get(h.id as HqId)}
                fill={P.zone}
                stroke={P.hq}
                strokeOpacity={0.28}
                strokeWidth={1}
                strokeDasharray="5 4"
                vectorEffect={NS}
              />
            </g>
          ))}

        {coverageEls}

        {/* scan rings */}
        {ringNodes.map((r) => {
          const c = r.tone === 'cyan' ? SEM.cyan : r.tone === 'alert' ? SEM.alert : SEM.warn;
          const o = pos(r.nodeId);
          const reach = Math.max(...r.set.map((n) => Math.hypot(pos(n).x - o.x, pos(n).y - o.y)), 40) + 18 * u;
          return (
            <g key={`ring-${r.nodeId}-${r.tone}`} pointerEvents="none">
              <circle cx={o.x} cy={o.y} r={reach} fill={c} fillOpacity={0.05} stroke={c} strokeOpacity={0.9} strokeWidth={1.4} vectorEffect={NS} className="fm-scan-out fm-centered" />
              {r.set.map((n) => (
                <circle key={n} cx={pos(n).x} cy={pos(n).y} r={14 * u} fill={c} fillOpacity={0.1} stroke={c} strokeOpacity={0.5} strokeWidth={1} strokeDasharray="3 3" vectorEffect={NS} />
              ))}
              {r.set
                .filter((n) => n !== r.nodeId && graph.neighbors(r.nodeId).includes(n))
                .map((n) => (
                  <line key={`l${n}`} x1={o.x} y1={o.y} x2={pos(n).x} y2={pos(n).y} stroke={c} strokeOpacity={0.5} strokeWidth={1.4} vectorEffect={NS} />
                ))}
            </g>
          );
        })}

        {/* sensor tripwires (sensor radius = own node + neighbours) */}
        {sensorNodes.map(({ n, tone }) => (
          <g key={`trip-${n}`} pointerEvents="none" stroke={tone} strokeOpacity={0.4} strokeWidth={1.2} fill="none">
            {graph.within(n, SENSOR_RADIUS_HOPS)
              .filter((m) => m !== n)
              .map((m) => {
                const a = pos(n), b = pos(m);
                const mx = a.x + (b.x - a.x) * 0.7, my = a.y + (b.y - a.y) * 0.7;
                return (
                  <g key={m}>
                    <line x1={a.x} y1={a.y} x2={mx} y2={my} strokeDasharray="1 3" vectorEffect={NS} />
                    <circle cx={b.x} cy={b.y} r={8.5 * u} strokeOpacity={0.3} vectorEffect={NS} />
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
          const d = (a.path.length > 1 ? polyline(a.path) : `M${pos(a.path[0]!).x},${pos(a.path[0]!).y}`) + `L${dp.x},${dp.y}`;
          return (
            <path key={`atk-${a.approachId}`} d={d} fill="none" stroke={P.attack} strokeOpacity={0.38} strokeWidth={1.3} strokeDasharray="5 4" vectorEffect={NS} pointerEvents="none" />
          );
        })}

        {/* reachable next hops (monster move mode) */}
        {nextHops.map((n) => {
          const a = pos(monsterOrigin), b = pos(n);
          const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
          const s0 = Math.min(0.4, (12 * u) / len);
          const s1 = Math.max(s0 + 0.05, 1 - (14 * u) / len);
          return (
            <line
              key={`hop-${n}`}
              x1={a.x + (b.x - a.x) * s0}
              y1={a.y + (b.y - a.y) * s0}
              x2={a.x + (b.x - a.x) * s1}
              y2={a.y + (b.y - a.y) * s1}
              stroke={hlColor}
              strokeOpacity={0.6}
              strokeWidth={1.6}
              vectorEffect={NS}
              markerEnd={`url(#${uid}-chev)`}
              pointerEvents="none"
            />
          );
        })}

        {/* planned route */}
        {pathD && (
          <g pointerEvents="none">
            <path d={pathD} fill="none" stroke={P.route} strokeOpacity={0.18} strokeWidth={9} strokeLinecap="round" strokeLinejoin="round" vectorEffect={NS} />
            <path d={pathD} fill="none" stroke={P.route} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" strokeDasharray="8 4" vectorEffect={NS} className="fm-flow" />
          </g>
        )}

        {/* HQs: spokes, doors, marker */}
        {hqs.map((h) => {
          const focus = props.hqId === h.id;
          const clickable = !!props.onHqClick;
          return (
            <g key={h.id}>
              {h.approaches.map((ap) => {
                const p = pos(ap.fromNode);
                const dp = doorLayout(h.id, u).get(ap.id)!;
                const breach = props.breachApproachId === ap.id;
                const d = doorStateOf(props, ap.id, theme);
                const showDoor = focus && !props.allHqs;
                const col = breach ? '#ff4d5e' : d.jammed ? SEM.warn : d.closed ? SEM.ok : d.known ? P.nodeRingKey : SEM.dim;
                const ang = (dp.angle * 180) / Math.PI;
                return (
                  <g key={ap.id} pointerEvents={showDoor ? 'auto' : 'none'}>
                    {showDoor && (
                      <line x1={h.tactical.x} y1={h.tactical.y} x2={dp.x} y2={dp.y} stroke={col} strokeOpacity={0.5} strokeWidth={1.2} vectorEffect={NS} />
                    )}
                    <line
                      x1={showDoor ? dp.x : h.tactical.x}
                      y1={showDoor ? dp.y : h.tactical.y}
                      x2={p.x}
                      y2={p.y}
                      stroke={breach ? '#ff4d5e' : focus ? P.hq : SEM.dim}
                      strokeOpacity={breach ? 0.95 : focus ? 0.45 : 0.4}
                      strokeWidth={breach ? 2.6 : 1.2}
                      strokeDasharray={breach ? undefined : '3 3'}
                      vectorEffect={NS}
                      className={breach ? 'fm-pulse-fast' : undefined}
                    />
                    {breach && props.breachProgress !== undefined && (
                      <line
                        x1={p.x}
                        y1={p.y}
                        x2={p.x + (dp.x - p.x) * props.breachProgress}
                        y2={p.y + (dp.y - p.y) * props.breachProgress}
                        stroke="#ff8a93"
                        strokeWidth={4}
                        vectorEffect={NS}
                      />
                    )}
                    {showDoor && (
                      <g transform={`rotate(${ang + 90} ${dp.x} ${dp.y})`}>
                        <title>{`${ap.door} · ${ap.label}`}</title>
                        <rect x={dp.x - 7 * u} y={dp.y - 3 * u} width={14 * u} height={6 * u} fill={P.nodeFill} stroke={col} strokeWidth={1.3} vectorEffect={NS} className={breach || d.battering ? 'fm-pulse-fast' : undefined} />
                        {d.closed ? (
                          <rect x={dp.x - 5 * u} y={dp.y - 1.2 * u} width={10 * u} height={2.4 * u} fill={col} />
                        ) : (
                          <>
                            <rect x={dp.x - 5 * u} y={dp.y - 1.2 * u} width={3 * u} height={2.4 * u} fill={col} />
                            <rect x={dp.x + 2 * u} y={dp.y - 1.2 * u} width={3 * u} height={2.4 * u} fill={col} />
                          </>
                        )}
                        {d.heat !== undefined && d.heat > 0.02 && (
                          <rect
                            x={dp.x - 7 * u}
                            y={dp.y + 4.5 * u}
                            width={14 * u * Math.min(1, d.heat)}
                            height={1.6 * u}
                            fill={d.heat > 0.75 ? SEM.alert : d.heat > 0.45 ? SEM.warn : SEM.cyan}
                          />
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
                <circle cx={h.tactical.x} cy={h.tactical.y} r={22 * u} fill="transparent" />
                {focus && (
                  <rect
                    x={h.tactical.x - 15 * u}
                    y={h.tactical.y - 15 * u}
                    width={30 * u}
                    height={30 * u}
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
                  x={h.tactical.x - 9.5 * u}
                  y={h.tactical.y - 9.5 * u}
                  width={19 * u}
                  height={19 * u}
                  fill={focus ? P.hqFill : '#101418'}
                  stroke={focus ? P.hq : '#6b7680'}
                  strokeWidth={focus ? 2 : 1.3}
                  vectorEffect={NS}
                  transform={`rotate(45 ${h.tactical.x} ${h.tactical.y})`}
                />
                <rect
                  x={h.tactical.x - 3.2 * u}
                  y={h.tactical.y - 3.2 * u}
                  width={6.4 * u}
                  height={6.4 * u}
                  fill={focus ? P.hq : '#6b7680'}
                  transform={`rotate(45 ${h.tactical.x} ${h.tactical.y})`}
                />
                <circle className="fm-hq-focus" cx={h.tactical.x} cy={h.tactical.y} r={20 * u} fill="none" stroke={P.accent} strokeWidth={1.5} vectorEffect={NS} />
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
            const r = (sensor ? 20 : 9 + 6 * s.confidence) * u;
            return (
              <g key={s.id} opacity={fade}>
                <g className="fm-sight-in fm-centered">
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={r}
                    fill={s.flagged || sensor ? 'none' : c}
                    fillOpacity={0.12}
                    stroke={c}
                    strokeWidth={s.age < 0.15 ? 2 : 1.4}
                    strokeDasharray={s.flagged ? '2 3' : sensor ? '5 4' : undefined}
                    vectorEffect={NS}
                  />
                  {!sensor && !s.flagged && (
                    <g stroke={c} strokeWidth={1.2} vectorEffect={NS}>
                      <line vectorEffect={NS} x1={p.x - r - 4 * u} y1={p.y} x2={p.x - r + 2 * u} y2={p.y} />
                      <line vectorEffect={NS} x1={p.x + r - 2 * u} y1={p.y} x2={p.x + r + 4 * u} y2={p.y} />
                      <line vectorEffect={NS} x1={p.x} y1={p.y - r - 4 * u} x2={p.x} y2={p.y - r + 2 * u} />
                      <line vectorEffect={NS} x1={p.x} y1={p.y + r - 2 * u} x2={p.x} y2={p.y + r + 4 * u} />
                    </g>
                  )}
                </g>
                {s.age < 0.05 && !s.flagged && (
                  <circle cx={p.x} cy={p.y} r={r} fill="none" stroke={c} strokeWidth={1.5} vectorEffect={NS} className="fm-shock fm-centered" />
                )}
                {s.flagged && (
                  <text x={p.x + r + 3 * u} y={p.y + r} fill="#9aa5ad" fontSize={8.5 * u} className="fm-mono" textDecoration="line-through">
                    FALSE
                  </text>
                )}
              </g>
            );
          })}
        </g>

        {/* last known: corner-bracket reticle */}
        {props.lastKnown && (
          <g pointerEvents="none" stroke="#ff4d5e" strokeWidth={1.6} fill="none">
            {(() => {
              const p = pos(props.lastKnown);
              const s = 13 * u, l = 5 * u;
              return (
                <g className="fm-pulse">
                  {[
                    [-1, -1],
                    [1, -1],
                    [1, 1],
                    [-1, 1],
                  ].map(([sx, sy]) => (
                    <path
                      key={`${sx}${sy}`}
                      vectorEffect={NS}
                      d={`M${p.x + sx! * s},${p.y + sy! * (s - l)} L${p.x + sx! * s},${p.y + sy! * s} L${p.x + sx! * (s - l)},${p.y + sy! * s}`}
                    />
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
              const r = 19 * u;
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
            <circle r={48 * u} fill={`url(#${uid}-mglow)`} className="fm-breathe fm-centered" />
            <circle r={11 * u} fill="none" stroke="#ff4d64" strokeOpacity={0.55} strokeWidth={1} vectorEffect={NS} className="fm-ripple fm-centered" />
            <circle r={6.5 * u} fill="#e0304c" stroke="#ffd0d7" strokeWidth={1.6} vectorEffect={NS} />
            <ellipse rx={1.2 * u} ry={3.6 * u} fill="#1a0306" />
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
              ? 'radial-gradient(ellipse at 50% 45%, transparent 55%, rgba(12,2,3,0.55) 100%)'
              : 'radial-gradient(ellipse at 50% 45%, transparent 58%, rgba(0,3,5,0.5) 100%)',
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
          props={props}
          sourceMode={tip.cameraId ? sources[tip.cameraId]?.mode : undefined}
        />
      )}

      {props.cursorHint && (
        <div className="pointer-events-none absolute left-2 top-2 border border-edge bg-black/70 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-cyan">
          {props.cursorHint}
        </div>
      )}

      {!props.noLegend && <div className="absolute bottom-2 left-2 flex flex-col items-start gap-1">
        {legend && <Legend theme={theme} />}
        <div className="fm-ctl">
          <button type="button" onClick={() => setLegend((v) => !v)} aria-pressed={legend} title="Map key" data-testid="map-legend-toggle" style={{ width: 'auto', padding: '0 8px', fontSize: 10, letterSpacing: '0.08em' }}>
            {legend ? 'Hide key' : 'Key'}
          </button>
        </div>
      </div>}

      {zoomable && (
        <div className="fm-ctl absolute bottom-2 right-2" data-testid="map-zoom">
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

export function NodeTooltip(p: {
  id: string;
  theme: MapTheme;
  x: number;
  y: number;
  W: number;
  H: number;
  props: MapLayers;
  sourceMode?: string;
}) {
  const n = NODE_BY_ID.get(p.id);
  if (!n) return null;
  const cam = n.cameraId ? CAMERA_BY_ID.get(n.cameraId) : undefined;
  const status = p.props.cameraStatus?.[p.id];
  const marks = p.props.marks?.[p.id] ?? [];
  const sights = (p.props.sightings ?? []).filter((s) => s.nodeId === p.id);
  const hops = p.props.hqId ? hopsToHq(p.id, p.props.hqId) : null;
  const notes = p.props.nodeNotes?.[p.id] ?? [];
  const right = p.x < p.W - 280;
  const below = p.y < p.H * 0.55;
  const style: React.CSSProperties = {
    left: right ? p.x + 18 : undefined,
    right: right ? undefined : p.W - p.x + 18,
    top: below ? p.y + 10 : undefined,
    bottom: below ? undefined : p.H - p.y + 10,
  };
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
  return (
    <div className="fm-tip" data-theme={p.theme} style={style} role="tooltip" data-testid="map-tooltip">
      <h4>{n.name}</h4>
      <div className="fm-tip-sub">{[cam?.route, ...(NODE_ROUTES.get(n.id) ?? [])].filter((v, i, a) => v && a.indexOf(v) === i).slice(0, 3).join(' / ')}</div>
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
            <dd style={{ color: p.sourceMode === 'offline' ? '#ff8a93' : p.sourceMode === 'simulated' ? SEM.warn : undefined }}>
              {SOURCE_TEXT[p.sourceMode] ?? p.sourceMode}
            </dd>
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
    <svg width="14" height="14" viewBox="-7 -7 14 14" aria-hidden>
      <circle r="5" fill={P.nodeFill} stroke={ring ?? P.nodeRing} strokeWidth="1.2" />
      <circle r="2.4" fill={c} />
    </svg>
  );
  const Sym = ({ children }: { children: React.ReactNode }) => (
    <svg width="14" height="14" viewBox="-7 -7 14 14" aria-hidden>
      {children}
    </svg>
  );
  const rows: Array<[React.ReactNode, string]> =
    theme === 'defender'
      ? [
          [<Dot c={P.cam.ok} />, 'Camera online'],
          [<Dot c={P.cam.static} />, 'Interference'],
          [<Sym><circle r="5" fill="none" stroke={SEM.alert} strokeDasharray="2 1.5" /><path d="M-2.4,-2.4L2.4,2.4M2.4,-2.4L-2.4,2.4" stroke="#ff5a63" /></Sym>, 'Feed tampered'],
          [<Sym><path d={arc(0, 0, 5, -140, -40)} stroke={SEM.cyan} fill="none" strokeWidth="1.5" /><path d={arc(0, 0, 5, 40, 140)} stroke={SEM.cyan} fill="none" strokeWidth="1.5" /></Sym>, 'Motion sensor'],
          [<Sym><rect x="-3" y="-3" width="6" height="6" fill={SEM.alert} transform="rotate(45)" /></Sym>, 'Trap'],
          [<Sym><circle r="5" fill="none" stroke="#ff3b4c" strokeWidth="1.4" /></Sym>, 'Sighting (fades)'],
          [<Sym><path d="M-5,-2V-5H-2M2,-5H5V-2M5,2V5H2M-2,5H-5V2" fill="none" stroke="#ff4d5e" strokeWidth="1.4" /></Sym>, 'Last known'],
          [<Sym><line x1="-6" y1="0" x2="6" y2="0" stroke={P.bridge} strokeWidth="4" /><line x1="-6" y1="0" x2="6" y2="0" stroke={P.bridgeDeck} strokeWidth="2" /></Sym>, 'Bridge'],
        ]
      : [
          [<Dot c={P.cam.ok} />, 'Working camera (watching)'],
          [<Sym><circle r="5" fill="none" stroke="#7a2a2e" strokeDasharray="2 1.5" /><path d="M-2.4,-2.4L2.4,2.4M2.4,-2.4L-2.4,2.4" stroke="#9a3a3e" /></Sym>, 'Blinded camera'],
          [<Sym><path d={arc(0, 0, 5, -140, -40)} stroke={SEM.warn} fill="none" strokeWidth="1.5" /><path d={arc(0, 0, 5, 40, 140)} stroke={SEM.warn} fill="none" strokeWidth="1.5" /></Sym>, 'Known sensor'],
          [<Sym><line x1="-6" y1="0" x2="6" y2="0" stroke={P.route} strokeWidth="2" strokeDasharray="3 2" /></Sym>, 'Planned route'],
          [<Sym><line x1="-6" y1="0" x2="6" y2="0" stroke={P.attack} strokeOpacity="0.6" strokeDasharray="3 2" /></Sym>, 'Attack path to a door'],
          [<Sym><circle r="5" fill="none" stroke="#ff4d5e" strokeDasharray="1 2" /></Sym>, 'You may have been seen'],
          [<Sym><circle r="5" fill="none" stroke={SEM.cyan} strokeDasharray="1 2" /></Sym>, 'Scan felt here'],
          [<Sym><circle r="5" fill="none" stroke={SEM.warn} /></Sym>, 'Disturbance'],
        ];
  return (
    <div className="fm-legend" data-theme={theme} data-testid="map-legend">
      {rows.map(([icon, text]) => (
        <div key={text} className="fm-legend-row">
          {icon}
          <span>{text}</span>
        </div>
      ))}
    </div>
  );
}
