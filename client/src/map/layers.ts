// The props contract shared by every map mode (TacticalMap, GeoMap). Additive only: screens written against
// the wave-1 contract keep working; the newer optional props make the maps richer when supplied.
import type { CameraGameStatus, HqId } from '@fnab/shared';

export type MarkKind =
  'sensor' | 'sensorOff' | 'trap' | 'trapArming' | 'lure' | 'knownSensor' | 'disturbance' | 'scanPulse' | 'exposure' | 'spawn';

export type MapTheme = 'defender' | 'monster';

export interface DoorState {
  closed: boolean;
  /** 0..1 door heat. */
  heat?: number;
  jammed?: boolean;
  battering?: boolean;
}

export interface MapSighting {
  id: number;
  nodeId: string;
  /** 0 = just now, 1 = about to expire (fraction of the sighting lifetime). */
  age: number;
  confidence: number;
  flagged: boolean;
  source: string;
}

export interface MapLayers {
  hqId?: HqId | null;
  /** Show every HQ (lobby selection). */
  allHqs?: boolean;
  onHqClick?: (id: HqId) => void;
  /** Fictional game status per *node id*. */
  cameraStatus?: Record<string, CameraGameStatus>;
  marks?: Record<string, MarkKind[]>;
  sightings?: MapSighting[];
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

  // ---- wave 2 additions (all optional) ----
  /** Visual theme. Defaults to 'monster' when a `monster` prop is passed (even null), else 'defender'. */
  theme?: MapTheme;
  /** Richer door state per approach id (heat / jammed / battering). Falls back to `doorClosed`. */
  doors?: Record<string, DoorState>;
  /** Defender threat level 0..1 — drawn as heat around the HQ. */
  threat?: number;
  /** Breach progress 0..1 for `breachApproachId`. */
  breachProgress?: number;
  /** Containment progress 0..1 while `held`. */
  containmentProgress?: number | null;
  /** Monster view: draw the shortest attack path to every door (default true in the monster theme). */
  attackPaths?: boolean;
  /** Draw camera coverage halos for working cameras (default true). */
  coverage?: boolean;
  /** Called when the pointer / keyboard focus enters or leaves a node. */
  onNodeHover?: (nodeId: string | null) => void;
  /** Extra tooltip lines per node id (e.g. "Sensor pinged 4s ago"). */
  nodeNotes?: Record<string, string[]>;
  /** Hide the built-in map key button (for screens that draw their own legend). */
  noLegend?: boolean;
  /** Hide the tactical zoom controls (they show by default when the map is interactive). */
  noZoom?: boolean;
}

export type MapProps = MapLayers & { className?: string };

export function resolveTheme(p: MapLayers): MapTheme {
  if (p.theme) return p.theme;
  return p.monster !== undefined ? 'monster' : 'defender';
}

/** Sensors report movement on their own node and adjacent nodes (docs/MECHANICS.md). Display only. */
export const SENSOR_RADIUS_HOPS = 1;
