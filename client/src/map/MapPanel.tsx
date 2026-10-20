// Map container with mode switching. Modes are registered in MAP_MODES; the toggle only renders when more
// than one mode exists (the maps agent adds a MapLibre `GeoMap` mode taking the same MapLayers props).
import { useState, type ComponentType } from 'react';
import clsx from 'clsx';
import { TacticalMap, type MapLayers } from './TacticalMap';

export interface MapMode {
  id: string;
  label: string;
  component: ComponentType<MapLayers & { className?: string }>;
}

export const MAP_MODES: MapMode[] = [{ id: 'tactical', label: 'Tactical', component: TacticalMap }];

export function MapPanel(props: MapLayers & { className?: string }) {
  const [modeId, setModeId] = useState(MAP_MODES[0]!.id);
  const mode = MAP_MODES.find((m) => m.id === modeId) ?? MAP_MODES[0]!;
  const C = mode.component;
  return (
    <div className={clsx('relative h-full w-full', props.className)}>
      <C {...props} />
      {MAP_MODES.length > 1 && (
        <div className="absolute right-2 top-2 flex border border-edge bg-black/70">
          {MAP_MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => setModeId(m.id)}
              className={clsx(
                'px-2 py-1 font-mono text-[10px] uppercase tracking-widest',
                m.id === mode.id ? 'bg-cyan-dim text-cyan' : 'text-mute hover:text-text',
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
