// Map container with mode switching. Modes are registered in MAP_MODES; the toggle renders when more than one
// mode exists. Tactical (SVG) is the default; Geographic (MapLibre) is code-split so it costs nothing until used.
// The chosen mode is remembered for the browser tab so it survives screen changes.
import { lazy, Suspense, useState, type ComponentType } from 'react';
import clsx from 'clsx';
import { TacticalMap } from './TacticalMap';
import { resolveTheme, type MapProps } from './layers';

export type { MapLayers, MarkKind, MapTheme, DoorState, MapProps } from './layers';

export interface MapMode {
  id: string;
  label: string;
  component: ComponentType<MapProps>;
}

const LazyGeo = lazy(() => import('./GeoMap'));

function GeoMapMode(props: MapProps) {
  return (
    <Suspense
      fallback={
        <div className="grid h-full w-full place-items-center bg-[#0c1014] font-mono text-[10px] uppercase tracking-widest text-dim">
          Loading map…
        </div>
      }
    >
      <LazyGeo {...props} />
    </Suspense>
  );
}

export const MAP_MODES: MapMode[] = [
  { id: 'tactical', label: 'Tactical', component: TacticalMap },
  { id: 'geo', label: 'Geographic', component: GeoMapMode },
];

const KEY = 'fnab.mapMode';
function initialMode(): string {
  try {
    const v = sessionStorage.getItem(KEY);
    if (v && MAP_MODES.some((m) => m.id === v)) return v;
  } catch {
    /* storage unavailable */
  }
  return MAP_MODES[0]!.id;
}

export function MapPanel(props: MapProps & { defaultMode?: string }) {
  const [modeId, setModeId] = useState(() => props.defaultMode ?? initialMode());
  const mode = MAP_MODES.find((m) => m.id === modeId) ?? MAP_MODES[0]!;
  const C = mode.component;
  const monster = resolveTheme(props) === 'monster';
  const choose = (id: string) => {
    setModeId(id);
    try {
      sessionStorage.setItem(KEY, id);
    } catch {
      /* ignore */
    }
  };
  return (
    <div className={clsx('relative h-full w-full', props.className)} data-map-mode={mode.id}>
      <C {...props} className={undefined} />
      {MAP_MODES.length > 1 && (
        <div
          className="absolute right-2 top-2 z-10 flex border bg-black/75"
          style={{ borderColor: monster ? '#3a2422' : '#25313a' }}
          role="tablist"
          aria-label="Map mode"
        >
          {MAP_MODES.map((m) => (
            <button
              key={m.id}
              role="tab"
              aria-selected={m.id === mode.id}
              onClick={() => choose(m.id)}
              data-testid={`map-mode-${m.id}`}
              className={clsx(
                'px-2 py-1 font-mono text-[10px] uppercase tracking-widest transition-colors',
                m.id === mode.id
                  ? monster
                    ? 'bg-[#2a0b10] text-[#ffb3bf]'
                    : 'bg-cyan-dim text-cyan'
                  : 'text-mute hover:text-text',
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
