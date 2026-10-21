import clsx from 'clsx';
import type { Headquarters, HqId, Region } from '@fnab/shared';
import { audio } from '../../audio';
import { nodeName, graph } from '../../lib/data';
import { hqArt, useImageOk, useUiAssets } from '../../ui/assets';
import { MiniMap } from './MiniMap';

export const REGION_LABEL: Record<Region, string> = {
  sf: 'San Francisco',
  'north-bay': 'North Bay',
  'east-bay': 'East Bay',
  peninsula: 'Peninsula',
  'south-bay': 'South Bay',
};

export function hqRegion(hq: Headquarters): string {
  const counts = new Map<Region, number>();
  for (const a of hq.approaches) {
    const r = graph.nodes.get(a.fromNode)?.region;
    if (r) counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return best ? REGION_LABEL[best] : 'Bay Area';
}

export function HqCard({
  hq,
  selected,
  disabled,
  onSelect,
}: {
  hq: Headquarters;
  selected: boolean;
  disabled?: boolean;
  onSelect?: (id: HqId) => void;
}) {
  const assets = useUiAssets();
  const art = hqArt(assets, hq.id);
  const artOk = useImageOk(art);
  return (
    <button
      type="button"
      data-testid={`hq-${hq.id}`}
      aria-pressed={selected}
      disabled={disabled}
      onClick={() => {
        if (selected || !onSelect) return;
        audio.play('uiClick', { volume: 0.5 });
        onSelect(hq.id);
      }}
      className={clsx(
        'group relative flex min-h-0 overflow-hidden border text-left transition-[border-color,background-color] duration-200',
        selected ? 'border-cyan/70 bg-[#0b1719]' : 'border-edge bg-panel/90',
        !selected && !disabled && 'hover:border-edge-hi hover:bg-panel-2/90',
        disabled && !selected && 'cursor-default',
        selected && 'fnab-brackets',
      )}
    >
      {artOk && (
        <img
          src={art}
          alt=""
          aria-hidden
          draggable={false}
          className={clsx(
            'pointer-events-none absolute inset-0 h-full w-full object-cover transition-opacity duration-300',
            selected ? 'opacity-40' : 'opacity-20 grayscale',
          )}
        />
      )}
      {artOk && (
        // Keep the title (top) and the door list (bottom) legible over the photograph.
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(10,12,14,0.85)_0%,rgba(10,12,14,0.1)_32%,rgba(10,12,14,0.15)_55%,rgba(10,12,14,0.92)_100%)]"
        />
      )}
      <div className="relative flex min-w-0 flex-1 flex-col">
        <div className="flex items-start justify-between gap-2 px-3 pt-3">
          <div className="min-w-0">
            <div className={clsx('font-display text-[15px] font-extrabold leading-tight', selected ? 'text-bright' : 'text-text')}>
              {hq.name}
            </div>
            <div className="mt-0.5 text-[11px] text-mute">{hqRegion(hq)}</div>
          </div>
          {selected ? (
            <span className="shrink-0 border border-cyan/60 bg-cyan-dim/60 px-1.5 py-px font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-[#b5f3fa]">
              Target
            </span>
          ) : (
            !disabled && (
              <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.14em] text-dim opacity-0 transition-opacity group-hover:opacity-100">
                Select
              </span>
            )
          )}
        </div>
        <div className="flex min-h-0 flex-1 gap-2 px-3 pb-3 pt-2">
          <ul className="mt-auto flex min-w-0 flex-1 flex-col gap-1.5">
            {hq.approaches.map((a) => (
              <li key={a.id} className="min-w-0 text-[11px] leading-tight">
                <span className={clsx('block truncate', selected ? 'text-text' : 'text-mute')} title={a.door}>
                  {a.door}
                </span>
                <span className="block truncate font-mono text-[10px] text-dim" title={nodeName(a.fromNode)}>
                  from {nodeName(a.fromNode)}
                </span>
              </li>
            ))}
          </ul>
          <div className="relative -mr-1 w-[46%] min-w-[84px] max-w-[240px] shrink-0">
            <MiniMap hqId={hq.id} tone={selected ? 'cyan' : 'dim'} showSpawns={selected} />
          </div>
        </div>
      </div>
    </button>
  );
}
