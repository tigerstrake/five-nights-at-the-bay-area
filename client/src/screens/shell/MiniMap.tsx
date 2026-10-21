// Small static map of the whole network on tactical coords, focused on one HQ (lobby cards, loading screen).
import { memo, useMemo } from 'react';
import clsx from 'clsx';
import type { HqId } from '@fnab/shared';
import { DEFAULT_CONFIG, spawnCandidates } from '@fnab/shared';
import { NETWORK, graph, hqById } from '../../lib/data';

const PAD = 40;
const BOX = (() => {
  const pts = [...NETWORK.nodes.map((n) => n.tactical), ...NETWORK.headquarters.map((h) => h.tactical)];
  const minX = Math.min(...pts.map((p) => p.x)) - PAD;
  const minY = Math.min(...pts.map((p) => p.y)) - PAD;
  return { minX, minY, w: Math.max(...pts.map((p) => p.x)) + PAD - minX, h: Math.max(...pts.map((p) => p.y)) + PAD - minY };
})();

const pos = (id: string) => graph.nodes.get(id)?.tactical ?? { x: 0, y: 0 };

export const MiniMap = memo(function MiniMap({
  hqId,
  tone = 'cyan',
  showSpawns = true,
  showOtherHqs = true,
  className,
}: {
  hqId: HqId;
  tone?: 'cyan' | 'ok' | 'bone' | 'dim';
  showSpawns?: boolean;
  showOtherHqs?: boolean;
  className?: string;
}) {
  const hq = hqById(hqId);
  const spawns = useMemo(() => (showSpawns ? spawnCandidates(graph, hqId, DEFAULT_CONFIG.spawn) : []), [hqId, showSpawns]);
  const approachNodes = new Set(hq?.approaches.map((a) => a.fromNode));
  const accent = { cyan: '#3bc6d6', ok: '#3ec47a', bone: '#d8cfbf', dim: '#8b949e' }[tone];
  if (!hq) return null;
  const s = BOX.w / 220; // stroke scale so lines read at card size
  return (
    <svg
      viewBox={`${BOX.minX} ${BOX.minY} ${BOX.w} ${BOX.h}`}
      className={clsx('block h-full w-full', className)}
      preserveAspectRatio="xMidYMid meet"
      aria-label={`Map position of ${hq.name}`}
      role="img"
    >
      {NETWORK.edges.map((e) => {
        const a = pos(e.a);
        const b = pos(e.b);
        return (
          <line
            key={e.id}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke={e.kind === 'bridge' ? '#3b5b66' : '#39424b'}
            strokeWidth={s * (e.kind === 'freeway' ? 1.4 : 1.1)}
            strokeDasharray={e.kind === 'bridge' ? `${s * 3} ${s * 2}` : undefined}
          />
        );
      })}
      {spawns.map((id) => {
        const p = pos(id);
        return <circle key={id} cx={p.x} cy={p.y} r={s * 3.2} fill="none" stroke="#b3202f" strokeOpacity={0.55} strokeWidth={s * 1} />;
      })}
      {NETWORK.nodes.map((n) => (
        <circle key={n.id} cx={n.tactical.x} cy={n.tactical.y} r={s * (approachNodes.has(n.id) ? 2.6 : 1.6)} fill={approachNodes.has(n.id) ? accent : '#626c76'} />
      ))}
      {hq.approaches.map((a) => {
        const p = pos(a.fromNode);
        return (
          <line
            key={a.id}
            x1={p.x}
            y1={p.y}
            x2={hq.tactical.x}
            y2={hq.tactical.y}
            stroke={accent}
            strokeOpacity={0.7}
            strokeWidth={s * 1}
            strokeDasharray={`${s * 2} ${s * 2}`}
          />
        );
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
              fill="none"
              stroke="#4a535d"
              strokeWidth={s * 1}
            />
          ))}
      <circle cx={hq.tactical.x} cy={hq.tactical.y} r={s * 16} fill={accent} fillOpacity={0.08} />
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
    </svg>
  );
});
