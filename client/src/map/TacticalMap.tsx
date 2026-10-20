// Stylised SVG tactical map over node `tactical` coordinates. A geographic MapLibre `GeoMap` can slot in
// beside it later via MapPanel (same props contract: MapLayers).
import { useMemo, useState } from 'react';
import clsx from 'clsx';
import type { CameraGameStatus, HqId } from '@fnab/shared';
import { graph, NETWORK } from '../lib/data';

export type MarkKind =
  'sensor' | 'sensorOff' | 'trap' | 'trapArming' | 'lure' | 'knownSensor' | 'disturbance' | 'scanPulse' | 'exposure' | 'spawn';

export interface MapLayers {
  hqId?: HqId | null;
  /** Show every HQ (lobby selection). */
  allHqs?: boolean;
  onHqClick?: (id: HqId) => void;
  cameraStatus?: Record<string, CameraGameStatus>;
  marks?: Record<string, MarkKind[]>;
  sightings?: Array<{ id: number; nodeId: string; age: number; confidence: number; flagged: boolean; source: string }>;
  lastKnown?: string | null;
  held?: string | null;
  monster?: { nodeId: string | null; moving: { from: string; to: string; progress: number } | null } | null;
  path?: string[];
  highlight?: Set<string>;
  highlightTone?: 'cyan' | 'monster' | 'warn';
  rings?: Array<{ nodeId: string; hops: number; tone: 'cyan' | 'alert' | 'warn' }>;
  breachApproachId?: string | null;
  doorClosed?: Record<string, boolean>;
  selectedNode?: string | null;
  onNodeClick?: (nodeId: string) => void;
  cursorHint?: string;
}

const PAD = 50;

function bbox() {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const n of NETWORK.nodes) {
    xs.push(n.tactical.x);
    ys.push(n.tactical.y);
  }
  for (const h of NETWORK.headquarters) {
    xs.push(h.tactical.x);
    ys.push(h.tactical.y);
  }
  const minX = Math.min(...xs) - PAD;
  const minY = Math.min(...ys) - PAD;
  return { minX, minY, w: Math.max(...xs) + PAD - minX, h: Math.max(...ys) + PAD - minY };
}

function pos(id: string) {
  return graph.nodes.get(id)?.tactical ?? { x: 0, y: 0 };
}

export function monsterXY(m: NonNullable<MapLayers['monster']>): { x: number; y: number } | null {
  if (m.moving) {
    const a = pos(m.moving.from);
    const b = pos(m.moving.to);
    return { x: a.x + (b.x - a.x) * m.moving.progress, y: a.y + (b.y - a.y) * m.moving.progress };
  }
  return m.nodeId ? pos(m.nodeId) : null;
}

export function TacticalMap(props: MapLayers & { className?: string }) {
  const box = useMemo(bbox, []);
  const [hover, setHover] = useState<string | null>(null);
  const hqs = props.allHqs ? NETWORK.headquarters : NETWORK.headquarters.filter((h) => h.id === props.hqId);
  const approachNodes = new Set(hqs.flatMap((h) => h.approaches.map((a) => a.fromNode)));
  const pathEdges = new Set<string>();
  if (props.path) for (let i = 1; i < props.path.length; i++) pathEdges.add([props.path[i - 1], props.path[i]].sort().join('|'));
  const mxy = props.monster ? monsterXY(props.monster) : null;
  const hlTone = props.highlightTone ?? 'cyan';
  const hlColor = { cyan: '#3bc6d6', monster: '#e04a62', warn: '#d49a2a' }[hlTone];

  // ring sets
  const ringNodes = (props.rings ?? []).map((r) => ({ ...r, set: new Set(graph.within(r.nodeId, r.hops)) }));

  return (
    <div className={clsx('relative h-full w-full', props.onNodeClick && 'cursor-crosshair', props.className)}>
      <svg
        viewBox={`${box.minX} ${box.minY} ${box.w} ${box.h}`}
        className="h-full w-full"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Tactical map"
      >
        <defs>
          <pattern id="tgrid" width="50" height="50" patternUnits="userSpaceOnUse">
            <path d="M 50 0 L 0 0 0 50" fill="none" stroke="#1a1f24" strokeWidth="1" />
          </pattern>
          <radialGradient id="mglow">
            <stop offset="0%" stopColor="#e04a62" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#e04a62" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect x={box.minX} y={box.minY} width={box.w} height={box.h} fill="url(#tgrid)" />

        {/* scan / range rings (as node halos) */}
        {ringNodes.map((r, i) =>
          [...r.set].map((n) => {
            const p = pos(n);
            const c = r.tone === 'cyan' ? '#3bc6d6' : r.tone === 'alert' ? '#c8323a' : '#d49a2a';
            return (
              <circle
                key={`ring${i}-${n}`}
                cx={p.x}
                cy={p.y}
                r={26}
                fill={c}
                opacity={0.08}
                stroke={c}
                strokeOpacity={0.35}
                strokeDasharray="4 4"
              />
            );
          }),
        )}

        {/* edges */}
        {NETWORK.edges.map((e) => {
          const a = pos(e.a);
          const b = pos(e.b);
          const onPath = pathEdges.has([e.a, e.b].sort().join('|'));
          return (
            <line
              key={e.id}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={onPath ? '#e04a62' : e.kind === 'bridge' ? '#2f5d66' : '#2a3138'}
              strokeWidth={onPath ? 4 : e.kind === 'bridge' ? 3 : 2.5}
              strokeDasharray={e.kind === 'bridge' && !onPath ? '8 5' : undefined}
              opacity={onPath ? 0.95 : 1}
            >
              <title>{`${e.route} · ${e.lengthKm} km`}</title>
            </line>
          );
        })}

        {/* HQs */}
        {hqs.map((h) => (
          <g
            key={h.id}
            onClick={props.onHqClick ? () => props.onHqClick!(h.id) : undefined}
            className={props.onHqClick ? 'cursor-pointer' : undefined}
          >
            {h.approaches.map((ap) => {
              const p = pos(ap.fromNode);
              const breach = props.breachApproachId === ap.id;
              const closed = props.doorClosed?.[ap.id];
              return (
                <g key={ap.id}>
                  <line
                    x1={h.tactical.x}
                    y1={h.tactical.y}
                    x2={p.x}
                    y2={p.y}
                    stroke={breach ? '#c8323a' : closed ? '#3ec47a' : '#5d6670'}
                    strokeWidth={breach ? 3 : 1.5}
                    strokeDasharray="3 4"
                  />
                  {props.hqId === h.id && !props.allHqs && (
                    <text
                      x={(h.tactical.x + p.x) / 2}
                      y={(h.tactical.y + p.y) / 2 - 4}
                      fill={breach ? '#ff8a93' : closed ? '#7fe0a8' : '#8b949e'}
                      fontSize="13"
                      fontFamily="IBM Plex Mono"
                      textAnchor="middle"
                    >
                      {ap.door.replace('Door ', '')}
                    </text>
                  )}
                </g>
              );
            })}
            <rect
              x={h.tactical.x - 16}
              y={h.tactical.y - 16}
              width={32}
              height={32}
              fill={props.hqId === h.id ? '#0f2a20' : '#14181c'}
              stroke={props.hqId === h.id ? '#3ec47a' : '#5d6670'}
              strokeWidth={props.hqId === h.id ? 3 : 1.5}
              transform={`rotate(45 ${h.tactical.x} ${h.tactical.y})`}
            />
            <text
              x={h.tactical.x}
              y={h.tactical.y + 5}
              fill={props.hqId === h.id ? '#7fe0a8' : '#8b949e'}
              fontSize="13"
              fontWeight="600"
              fontFamily="IBM Plex Mono"
              textAnchor="middle"
            >
              HQ
            </text>
            <text
              x={h.tactical.x}
              y={h.tactical.y + 40}
              fill={props.hqId === h.id ? '#a6f0c6' : '#8b949e'}
              fontSize="15"
              fontFamily="Inter"
              textAnchor="middle"
            >
              {h.name}
            </text>
          </g>
        ))}

        {/* nodes */}
        {NETWORK.nodes.map((n) => {
          const p = n.tactical;
          const cam = props.cameraStatus?.[n.id];
          const marks = props.marks?.[n.id] ?? [];
          const hl = props.highlight?.has(n.id);
          const sel = props.selectedNode === n.id;
          const isAp = approachNodes.has(n.id);
          const camColor = !cam
            ? '#5d6670'
            : cam === 'ok'
              ? '#3ec47a'
              : cam === 'repairing'
                ? '#3bc6d6'
                : cam === 'static'
                  ? '#d49a2a'
                  : '#c8323a';
          const showLabel = sel || hover === n.id || (isAp && !props.allHqs) || props.lastKnown === n.id || props.held === n.id;
          return (
            <g
              key={n.id}
              data-node={n.id}
              onClick={props.onNodeClick ? () => props.onNodeClick!(n.id) : undefined}
              onMouseEnter={() => setHover(n.id)}
              onMouseLeave={() => setHover((h) => (h === n.id ? null : h))}
              className={props.onNodeClick ? 'cursor-pointer' : undefined}
            >
              <circle cx={p.x} cy={p.y} r={22} fill="transparent" />
              {hl && <circle cx={p.x} cy={p.y} r={17} fill={hlColor} opacity={0.12} stroke={hlColor} strokeOpacity={0.6} />}
              {sel && <circle cx={p.x} cy={p.y} r={20} fill="none" stroke="#f1f4f6" strokeWidth={1.5} strokeDasharray="3 3" />}
              <circle cx={p.x} cy={p.y} r={9} fill="#0b0e10" stroke={isAp ? '#8b949e' : '#36404a'} strokeWidth={isAp ? 2 : 1.5} />
              <circle cx={p.x} cy={p.y} r={4} fill={camColor} />
              {marks.includes('sensor') && <circle cx={p.x} cy={p.y} r={14} fill="none" stroke="#3bc6d6" strokeWidth={2} />}
              {marks.includes('sensorOff') && (
                <circle cx={p.x} cy={p.y} r={14} fill="none" stroke="#5d6670" strokeWidth={2} strokeDasharray="2 3" />
              )}
              {marks.includes('knownSensor') && (
                <circle cx={p.x} cy={p.y} r={14} fill="none" stroke="#d49a2a" strokeWidth={2} strokeDasharray="5 3" />
              )}
              {(marks.includes('trap') || marks.includes('trapArming')) && (
                <rect
                  x={p.x + 8}
                  y={p.y - 18}
                  width={10}
                  height={10}
                  fill={marks.includes('trap') ? '#c8323a' : 'none'}
                  stroke="#c8323a"
                  strokeWidth={2}
                  transform={`rotate(45 ${p.x + 13} ${p.y - 13})`}
                />
              )}
              {marks.includes('lure') && <path d={`M ${p.x - 18} ${p.y - 8} l 6 -10 l 6 10 z`} fill="#d49a2a" />}
              {marks.includes('disturbance') && (
                <circle cx={p.x} cy={p.y} r={18} fill="none" stroke="#d49a2a" strokeWidth={1.5}>
                  <animate attributeName="r" values="10;26;10" dur="2s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="1;0;1" dur="2s" repeatCount="indefinite" />
                </circle>
              )}
              {marks.includes('scanPulse') && (
                <circle cx={p.x} cy={p.y} r={24} fill="none" stroke="#3bc6d6" strokeWidth={1} strokeDasharray="2 4" />
              )}
              {marks.includes('exposure') && (
                <circle cx={p.x} cy={p.y} r={16} fill="none" stroke="#c8323a" strokeWidth={1.5} strokeDasharray="1 3" />
              )}
              {marks.includes('spawn') && <circle cx={p.x} cy={p.y} r={15} fill="none" stroke="#a3243a" strokeWidth={2} />}
              {showLabel && (
                <text
                  x={p.x}
                  y={p.y - 26}
                  fill={sel ? '#f1f4f6' : '#9aa3ab'}
                  fontSize="14"
                  fontFamily="Inter"
                  textAnchor="middle"
                  style={{ paintOrder: 'stroke', stroke: '#050607', strokeWidth: 4 }}
                >
                  {n.name}
                </text>
              )}
              <title>{`${n.name}${cam ? ` · CAM ${cam.toUpperCase()}` : ''}`}</title>
            </g>
          );
        })}

        {/* sightings */}
        {(props.sightings ?? []).map((s) => {
          const p = pos(s.nodeId);
          const fade = Math.max(0.15, 1 - s.age);
          const c = s.flagged ? '#5d6670' : s.source === 'sensor' ? '#d49a2a' : '#c8323a';
          return (
            <g key={s.id} opacity={fade}>
              <circle
                cx={p.x}
                cy={p.y}
                r={s.source === 'sensor' ? 30 : 12 + 10 * s.confidence}
                fill="none"
                stroke={c}
                strokeWidth={2}
                strokeDasharray={s.flagged ? '2 4' : s.source === 'sensor' ? '6 6' : undefined}
              />
              {s.flagged && (
                <text x={p.x + 16} y={p.y + 22} fill="#8b949e" fontSize="12" fontFamily="IBM Plex Mono">
                  FALSE
                </text>
              )}
            </g>
          );
        })}
        {props.lastKnown && (
          <g>
            <circle cx={pos(props.lastKnown).x} cy={pos(props.lastKnown).y} r={13} fill="#c8323a" opacity={0.25}>
              <animate attributeName="opacity" values="0.35;0.1;0.35" dur="1.6s" repeatCount="indefinite" />
            </circle>
            <text
              x={pos(props.lastKnown).x}
              y={pos(props.lastKnown).y + 34}
              fill="#ff8a93"
              fontSize="12"
              fontFamily="IBM Plex Mono"
              textAnchor="middle"
            >
              LAST KNOWN
            </text>
          </g>
        )}
        {props.held && (
          <g>
            <circle cx={pos(props.held).x} cy={pos(props.held).y} r={24} fill="none" stroke="#c8323a" strokeWidth={3}>
              <animate attributeName="r" values="18;30;18" dur="1s" repeatCount="indefinite" />
            </circle>
          </g>
        )}

        {/* monster (monster view only) */}
        {mxy && (
          <g pointerEvents="none">
            <circle cx={mxy.x} cy={mxy.y} r={40} fill="url(#mglow)" />
            <circle cx={mxy.x} cy={mxy.y} r={10} fill="#e04a62" stroke="#ffd0d7" strokeWidth={2} />
          </g>
        )}
      </svg>
      {props.cursorHint && (
        <div className="pointer-events-none absolute left-2 top-2 border border-edge bg-black/70 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-cyan">
          {props.cursorHint}
        </div>
      )}
    </div>
  );
}
