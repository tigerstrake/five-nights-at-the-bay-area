// Small static tactical map (lobby HQ cards, loading screen): the same warped shoreline and route-toned
// corridors as the full map, without labels or interaction. The land fades out toward the frame so it sits
// on any background (a card, the countdown ring).
import { memo, useId, useMemo } from 'react';
import clsx from 'clsx';
import type { HqId } from '@fnab/shared';
import { DEFAULT_CONFIG, spawnCandidates } from '@fnab/shared';
import { graph, NETWORK } from '../lib/data';
import { LAND_PATH } from './shore.gen';
import { CORRIDORS } from './schematic';
import { PALETTES, ROUTE_WIDTH, routeTone } from './theme';

const PAD = 34;
const BOX = (() => {
  const pts = [...NETWORK.nodes.map((n) => n.tactical), ...NETWORK.headquarters.map((h) => h.tactical)];
  const minX = Math.min(...pts.map((p) => p.x)) - PAD;
  const minY = Math.min(...pts.map((p) => p.y)) - PAD;
  return { minX, minY, w: Math.max(...pts.map((p) => p.x)) + PAD - minX, h: Math.max(...pts.map((p) => p.y)) + PAD - minY };
})();
const CORRIDOR_LIST = [...CORRIDORS.values()].sort((a, b) => ROUTE_WIDTH[a.route.cls] - ROUTE_WIDTH[b.route.cls]);
const pos = (id: string) => graph.nodes.get(id)?.tactical ?? { x: 0, y: 0 };

export type MiniTone = 'cyan' | 'ok' | 'bone' | 'dim';

export const TacticalMini = memo(function TacticalMini({
  hqId,
  tone = 'cyan',
  showSpawns = true,
  showOtherHqs = true,
  className,
}: {
  hqId: HqId;
  tone?: MiniTone;
  showSpawns?: boolean;
  showOtherHqs?: boolean;
  className?: string;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const hq = graph.hqs.get(hqId);
  const spawns = useMemo(() => (showSpawns ? spawnCandidates(graph, hqId, DEFAULT_CONFIG.spawn) : []), [hqId, showSpawns]);
  if (!hq) return null;
  const P = PALETTES[tone === 'bone' ? 'monster' : 'defender'];
  const accent = { cyan: '#3bc6d6', ok: '#3ec47a', bone: '#d8cfbf', dim: '#8b949e' }[tone];
  const muted = tone === 'dim';
  const approachNodes = new Set(hq.approaches.map((a) => a.fromNode));
  const s = BOX.w / 220; // map units per "card pixel" so strokes read at card size
  const cx = BOX.minX + BOX.w / 2, cy = BOX.minY + BOX.h / 2;
  return (
    <svg
      viewBox={`${BOX.minX} ${BOX.minY} ${BOX.w} ${BOX.h}`}
      className={clsx('block h-full w-full', className)}
      preserveAspectRatio="xMidYMid meet"
      aria-label={`Map position of ${hq.name}`}
      role="img"
      data-testid="tactical-mini"
    >
      <defs>
        <radialGradient id={`${uid}-fade`} cx={cx} cy={cy} r={Math.max(BOX.w, BOX.h) * 0.62} gradientUnits="userSpaceOnUse">
          <stop offset="0.62" stopColor="#fff" />
          <stop offset="1" stopColor="#000" />
        </radialGradient>
        <mask id={`${uid}-m`} maskUnits="userSpaceOnUse" x={BOX.minX} y={BOX.minY} width={BOX.w} height={BOX.h}>
          <rect x={BOX.minX} y={BOX.minY} width={BOX.w} height={BOX.h} fill={`url(#${uid}-fade)`} />
        </mask>
      </defs>
      <g mask={`url(#${uid}-m)`}>
        <path d={LAND_PATH} fill="#ffffff" fillOpacity={0.045} fillRule="evenodd" />
        <path d={LAND_PATH} fill="none" stroke={P.shore} strokeOpacity={0.8} strokeWidth={s * 0.7} />
      </g>
      <g fill="none" strokeLinecap="round" strokeLinejoin="round" opacity={muted ? 0.55 : 0.9}>
        {CORRIDOR_LIST.map((c) => (
          <path
            key={c.id}
            d={c.d}
            stroke={muted ? '#4a545d' : routeTone(P, c.route)}
            strokeWidth={s * (c.route.cls === 'street' ? 0.8 : c.route.cls === 'state' ? 1.2 : 1.5)}
            strokeDasharray={c.kind === 'tunnel' ? `${s * 2} ${s * 1.5}` : undefined}
          />
        ))}
      </g>
      {spawns.map((id) => {
        const p = pos(id);
        return <circle key={id} cx={p.x} cy={p.y} r={s * 3.4} fill="none" stroke="#b3202f" strokeOpacity={0.7} strokeWidth={s} />;
      })}
      {NETWORK.nodes.map((n) => (
        <circle
          key={n.id}
          cx={n.tactical.x}
          cy={n.tactical.y}
          r={s * (approachNodes.has(n.id) ? 2.4 : 1.5)}
          fill={approachNodes.has(n.id) ? accent : '#0b0f12'}
          stroke={approachNodes.has(n.id) ? 'none' : '#7c8892'}
          strokeWidth={s * 0.8}
        />
      ))}
      {hq.approaches.map((a) => {
        const p = pos(a.fromNode);
        return <line key={a.id} x1={p.x} y1={p.y} x2={hq.tactical.x} y2={hq.tactical.y} stroke={accent} strokeOpacity={0.75} strokeWidth={s} strokeDasharray={`${s * 2} ${s * 1.6}`} />;
      })}
      {showOtherHqs &&
        NETWORK.headquarters
          .filter((h) => h.id !== hqId)
          .map((h) => (
            <rect
              key={h.id}
              x={h.tactical.x - s * 4}
              y={h.tactical.y - s * 4}
              width={s * 8}
              height={s * 8}
              transform={`rotate(45 ${h.tactical.x} ${h.tactical.y})`}
              fill="#0b0f12"
              stroke="#56606a"
              strokeWidth={s}
            />
          ))}
      <circle cx={hq.tactical.x} cy={hq.tactical.y} r={s * 15} fill={accent} fillOpacity={0.1} />
      <rect
        x={hq.tactical.x - s * 6.5}
        y={hq.tactical.y - s * 6.5}
        width={s * 13}
        height={s * 13}
        transform={`rotate(45 ${hq.tactical.x} ${hq.tactical.y})`}
        fill="#050607"
        stroke={accent}
        strokeWidth={s * 1.6}
      />
      <rect x={hq.tactical.x - s * 2.4} y={hq.tactical.y - s * 2.4} width={s * 4.8} height={s * 4.8} transform={`rotate(45 ${hq.tactical.x} ${hq.tactical.y})`} fill={accent} />
    </svg>
  );
});
