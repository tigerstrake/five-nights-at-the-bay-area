// Map palettes. Defender: clinical control-room cyan/green on cold graphite. Monster: bone and blood on
// a warm, near-black ground. Shared semantic colours (alert, warn, ok) match the design tokens in index.css.
import type { MapTheme } from './layers';

export interface MapPalette {
  land: string;
  landEdge: string;
  water: string;
  coast: string;
  contour: string;
  ridge: string;
  regionLabel: string;
  waterLabel: string;
  grid: string;
  road: string;
  roadSurface: string;
  bridge: string;
  bridgeDeck: string;
  tunnel: string;
  nodeFill: string;
  nodeRing: string;
  nodeRingKey: string;
  label: string;
  labelStrong: string;
  halo: string;
  accent: string;
  accentHi: string;
  route: string;
  attack: string;
  hq: string;
  hqFill: string;
  zone: string;
  cam: Record<'ok' | 'sabotaged' | 'repairing' | 'static' | 'blackout' | 'none', string>;
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

export const PALETTES: Record<MapTheme, MapPalette> = {
  defender: {
    land: '#0d1317',
    landEdge: '#111a1f',
    water: '#020406',
    coast: 'rgba(91, 205, 220, 0.42)',
    contour: 'rgba(59, 198, 214, 0.13)',
    ridge: 'rgba(130, 160, 170, 0.1)',
    regionLabel: 'rgba(150, 175, 185, 0.26)',
    waterLabel: 'rgba(91, 205, 220, 0.28)',
    grid: 'rgba(120, 150, 160, 0.06)',
    road: '#2b3740',
    roadSurface: '#24303a',
    bridge: '#4fb3c1',
    bridgeDeck: '#061014',
    tunnel: '#46535d',
    nodeFill: '#070a0c',
    nodeRing: '#34424c',
    nodeRingKey: '#8fa2ad',
    label: '#8d9aa3',
    labelStrong: '#e6eef2',
    halo: '#04070a',
    accent: '#3bc6d6',
    accentHi: '#9ff1fa',
    route: '#3bc6d6',
    attack: '#e04a62',
    hq: '#3ec47a',
    hqFill: '#0c2419',
    zone: 'rgba(62, 196, 122, 0.06)',
    cam: { ok: '#3ec47a', sabotaged: '#e0414b', repairing: '#3bc6d6', static: '#d49a2a', blackout: '#2a3138', none: '#4a555e' },
  },
  monster: {
    land: '#110c0b',
    landEdge: '#171010',
    water: '#030101',
    coast: 'rgba(214, 196, 166, 0.34)',
    contour: 'rgba(214, 196, 166, 0.09)',
    ridge: 'rgba(200, 170, 150, 0.085)',
    regionLabel: 'rgba(214, 196, 166, 0.2)',
    waterLabel: 'rgba(214, 196, 166, 0.22)',
    grid: 'rgba(214, 196, 166, 0.04)',
    road: '#3a2c2b',
    roadSurface: '#302423',
    bridge: '#cdbb9c',
    bridgeDeck: '#120a09',
    tunnel: '#4d3d3a',
    nodeFill: '#0a0606',
    nodeRing: '#4a3634',
    nodeRingKey: '#b5a088',
    label: '#a8968a',
    labelStrong: '#f4e8dc',
    halo: '#060303',
    accent: '#e04a62',
    accentHi: '#ffb3bf',
    route: '#ff4d64',
    attack: '#e04a62',
    hq: '#e8d8bf',
    hqFill: '#1d1110',
    zone: 'rgba(232, 216, 191, 0.045)',
    cam: { ok: '#d9c9a8', sabotaged: '#5a1a1e', repairing: '#d49a2a', static: '#8a6a3a', blackout: '#2a1f1e', none: '#4d3d3a' },
  },
};
