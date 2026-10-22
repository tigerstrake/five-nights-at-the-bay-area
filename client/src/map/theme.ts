// Map palettes. Defender: clinical control-room cyan/green on cold graphite. Monster: bone and blood on a
// warm near-black. Freeways get their own low-chroma tones (so I-880 reads as one line from Oakland to San
// Jose) that stay well below the saturated gameplay colours (alert red, warn amber, ok green, scan cyan).
import type { MapTheme } from './layers';
import { ROUTE_KEYS, type RouteInfo } from './schematic';

export interface MapPalette {
  land: string;
  water: string;
  shore: string;
  waterLabel: string;
  regionLabel: string;
  casing: string;
  street: string;
  route: Record<string, string>;
  nodeFill: string;
  nodeRing: string;
  nodeRingKey: string;
  label: string;
  labelStrong: string;
  halo: string;
  accent: string;
  accentHi: string;
  /** Planned-route colour. */
  path: string;
  attack: string;
  hq: string;
  hqFill: string;
  hqIdle: string;
  zone: string;
  shieldFill: string;
  shieldText: string;
  cam: Record<'ok' | 'sabotaged' | 'repairing' | 'static' | 'blackout' | 'none', string>;
  // legacy names kept for GeoMap / older call sites
  coast: string;
  bridge: string;
  bridgeDeck: string;
  tunnel: string;
  road: string;
  roadSurface: string;
}

const shared = {
  alert: '#c8323a',
  alertHi: '#ff6b74',
  warn: '#d49a2a',
  ok: '#3ec47a',
  cyan: '#3bc6d6',
  dim: '#5d6670',
};
export const SEM = shared;

// Defender route tones (ROUTE_KEYS order): distinct hues, low chroma, similar lightness.
const DEF_TONES = [
  '#7f9cba', // I-80     steel blue
  '#bba783', // US-101   sand
  '#85ae98', // I-880    sage
  '#a397c0', // I-280    lavender
  '#6faab4', // I-580    teal
  '#c09878', // I-680    clay
  '#a7b37d', // SR-24    olive
  '#7bb3a9', // SR-92    sea
  '#ba90a3', // SR-84    mauve
  '#aba27f', // SR-37    khaki
  '#9c9188', // I-780    taupe
  '#8fa5ad', // I-980    grey teal
  '#8e98a1', // SR-82    grey (El Camino)
];

function mix(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return '#' + pa.map((v, i) => Math.round(v + (pb[i]! - v) * t).toString(16).padStart(2, '0')).join('');
}

const tones = (list: string[]) => Object.fromEntries(ROUTE_KEYS.map((k, i) => [k, list[i] ?? list[list.length - 1]!]));

// Monster: the same identities pulled toward bone and dimmed, so the warm UI stays monochrome-ish.
const MON_TONES = DEF_TONES.map((c) => mix(mix(c, '#d8c6a8', 0.42), '#1a1110', 0.1));

export const PALETTES: Record<MapTheme, MapPalette> = {
  defender: {
    land: '#121a1f',
    water: '#03070a',
    shore: 'rgba(122, 182, 198, 0.46)',
    waterLabel: 'rgba(118, 170, 186, 0.5)',
    regionLabel: 'rgba(150, 172, 182, 0.24)',
    casing: '#121a1f',
    street: '#4d5961',
    route: tones(DEF_TONES),
    nodeFill: '#0a0e11',
    nodeRing: '#8796a0',
    nodeRingKey: '#d7e2e7',
    label: '#9fadb5',
    labelStrong: '#eef3f5',
    halo: '#0a0f12',
    accent: '#3bc6d6',
    accentHi: '#9ff1fa',
    path: '#3bc6d6',
    attack: '#e04a62',
    hq: '#3ec47a',
    hqFill: '#0b2117',
    hqIdle: '#6f7b84',
    zone: 'rgba(62, 196, 122, 0.05)',
    shieldFill: '#0e1417',
    shieldText: '#dde6ea',
    cam: { ok: '#3ec47a', sabotaged: '#e0414b', repairing: '#3bc6d6', static: '#d49a2a', blackout: '#2a3138', none: '#56626b' },
    coast: 'rgba(122, 182, 198, 0.34)',
    bridge: '#7f9cba',
    bridgeDeck: '#061014',
    tunnel: '#46535d',
    road: '#2b3740',
    roadSurface: '#24303a',
  },
  monster: {
    land: '#17100d',
    water: '#040101',
    shore: 'rgba(214, 192, 162, 0.36)',
    waterLabel: 'rgba(214, 192, 162, 0.42)',
    regionLabel: 'rgba(214, 196, 166, 0.2)',
    casing: '#17100d',
    street: '#544540',
    route: tones(MON_TONES),
    nodeFill: '#0b0707',
    nodeRing: '#8a7869',
    nodeRingKey: '#efe1cc',
    label: '#ab9a8c',
    labelStrong: '#f6eadc',
    halo: '#0c0807',
    accent: '#e04a62',
    accentHi: '#ffb3bf',
    path: '#ff4d64',
    attack: '#e04a62',
    hq: '#e8d8bf',
    hqFill: '#22130f',
    hqIdle: '#7a6a60',
    zone: 'rgba(232, 216, 191, 0.04)',
    shieldFill: '#120c0b',
    shieldText: '#efe3d2',
    cam: { ok: '#d9c9a8', sabotaged: '#5a1a1e', repairing: '#d49a2a', static: '#8a6a3a', blackout: '#2a1f1e', none: '#4d3d3a' },
    coast: 'rgba(214, 192, 162, 0.28)',
    bridge: '#cdbb9c',
    bridgeDeck: '#120a09',
    tunnel: '#4d3d3a',
    road: '#3a2c2b',
    roadSurface: '#302423',
  },
};

export function routeTone(P: MapPalette, r: RouteInfo): string {
  return r.cls === 'street' ? P.street : (P.route[r.key] ?? P.street);
}

/** Stroke width (px) per route class. */
export const ROUTE_WIDTH: Record<RouteInfo['cls'], number> = { interstate: 4, us: 4, state: 3, street: 1.7 };
