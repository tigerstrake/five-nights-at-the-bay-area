// MapLibre style for the geographic mode. Basemap: OpenFreeMap vector tiles (OpenMapTiles schema) —
// free, no API key, commercial use allowed, attribution required ("OpenFreeMap © OpenMapTiles Data from
// OpenStreetMap"; https://openfreemap.org, https://openfreemap.org/tos/). Restyled to near-black / graphite with
// faint cyan (defender) or bone (monster) motorways. Every gameplay layer is a local GeoJSON source, so the
// map keeps working with no network: only the basemap layers go blank.
import type { StyleSpecification, LayerSpecification, ExpressionSpecification } from 'maplibre-gl';
import type { MapTheme } from './layers';
import { PALETTES, SEM } from './theme';
import { ROUTE_KEYS } from './schematic';

export const OFM_TILEJSON = 'https://tiles.openfreemap.org/planet';
export const OFM_GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
export const OFM_ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">&copy; OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

export const GAME_SOURCES = [
  'g-edges',
  'g-zone',
  'g-heat',
  'g-nodes',
  'g-rings',
  'g-trip',
  'g-attack',
  'g-hops',
  'g-path',
  'g-spokes',
  'g-doors',
  'g-sight',
  'g-marks',
] as const;
export type GameSource = (typeof GAME_SOURCES)[number];

const EMPTY = { type: 'FeatureCollection' as const, features: [] };

interface GeoPalette {
  bg: string;
  water: string;
  coast: string;
  landuse: string;
  park: string;
  building: string;
  minor: string;
  major: string;
  motorway: string;
  motorwayGlow: string;
  place: string;
  placeHalo: string;
  waterName: string;
}

export const GEO_PALETTES: Record<MapTheme, GeoPalette> = {
  defender: {
    bg: '#11181d',
    water: '#03070a',
    coast: 'rgba(122, 182, 198, 0.36)',
    landuse: '#0f1418',
    park: '#0c1312',
    building: '#12181c',
    minor: '#151b1f',
    major: '#1d262c',
    motorway: 'rgba(59, 198, 214, 0.2)',
    motorwayGlow: 'rgba(59, 198, 214, 0.06)',
    place: '#46525a',
    placeHalo: '#050708',
    waterName: 'rgba(91, 205, 220, 0.35)',
  },
  monster: {
    bg: '#150f0c',
    water: '#040101',
    coast: 'rgba(214, 192, 162, 0.32)',
    landuse: '#140e0d',
    park: '#120d0b',
    building: '#181110',
    minor: '#1a1211',
    major: '#241918',
    motorway: 'rgba(214, 196, 166, 0.16)',
    motorwayGlow: 'rgba(214, 196, 166, 0.05)',
    place: '#5e5148',
    placeHalo: '#070404',
    waterName: 'rgba(214, 196, 166, 0.3)',
  },
};

const z = (stops: Array<[number, number]>): ExpressionSpecification =>
  ['interpolate', ['exponential', 1.5], ['zoom'], ...stops.flat()] as unknown as ExpressionSpecification;

const isPoly: ExpressionSpecification = ['match', ['geometry-type'], ['MultiPolygon', 'Polygon'], true, false];
const isLine: ExpressionSpecification = ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false];

function basemapLayers(t: MapTheme): LayerSpecification[] {
  const G = GEO_PALETTES[t];
  return [
    { id: 'bg', type: 'background', paint: { 'background-color': G.bg } },
    {
      id: 'bm-landuse',
      type: 'fill',
      source: 'ofm',
      'source-layer': 'landuse',
      filter: ['all', isPoly, ['match', ['get', 'class'], ['residential', 'suburb', 'neighbourhood', 'commercial', 'industrial'], true, false]],
      paint: { 'fill-color': G.landuse, 'fill-opacity': 0.9 },
    },
    {
      id: 'bm-park',
      type: 'fill',
      source: 'ofm',
      'source-layer': 'landcover',
      filter: ['all', isPoly, ['match', ['get', 'class'], ['wood', 'grass', 'scrub'], true, false]],
      paint: { 'fill-color': G.park, 'fill-opacity': 0.8 },
    },
    {
      id: 'bm-water',
      type: 'fill',
      source: 'ofm',
      'source-layer': 'water',
      filter: ['all', isPoly, ['!=', ['get', 'brunnel'], 'tunnel']],
      paint: { 'fill-color': G.water, 'fill-antialias': true, 'fill-outline-color': G.coast },
    },
    {
      id: 'bm-coast',
      type: 'line',
      source: 'ofm',
      'source-layer': 'water',
      filter: ['all', isPoly, ['!=', ['get', 'brunnel'], 'tunnel']],
      paint: { 'line-color': G.coast, 'line-width': z([[8, 0.5], [13, 1.1]]), 'line-blur': 0.4 },
    },
    {
      id: 'bm-building',
      type: 'fill',
      source: 'ofm',
      'source-layer': 'building',
      minzoom: 13,
      paint: { 'fill-color': G.building, 'fill-opacity': z([[13, 0], [14.5, 0.9]]) },
    },
    {
      id: 'bm-road-minor',
      type: 'line',
      source: 'ofm',
      'source-layer': 'transportation',
      minzoom: 11,
      filter: ['all', isLine, ['match', ['get', 'class'], ['minor', 'service', 'street'], true, false]],
      paint: { 'line-color': G.minor, 'line-width': z([[11, 0.4], [16, 3]]) },
    },
    {
      id: 'bm-road-major',
      type: 'line',
      source: 'ofm',
      'source-layer': 'transportation',
      minzoom: 8,
      filter: ['all', isLine, ['match', ['get', 'class'], ['primary', 'secondary', 'tertiary', 'trunk'], true, false]],
      paint: { 'line-color': G.major, 'line-width': z([[8, 0.4], [16, 4]]) },
    },
    {
      id: 'bm-motorway-glow',
      type: 'line',
      source: 'ofm',
      'source-layer': 'transportation',
      filter: ['all', isLine, ['==', ['get', 'class'], 'motorway']],
      paint: { 'line-color': G.motorwayGlow, 'line-width': z([[8, 3], [16, 14]]), 'line-blur': 2 },
    },
    {
      id: 'bm-motorway',
      type: 'line',
      source: 'ofm',
      'source-layer': 'transportation',
      filter: ['all', isLine, ['==', ['get', 'class'], 'motorway']],
      paint: { 'line-color': G.motorway, 'line-width': z([[8, 0.6], [16, 2.6]]) },
    },
    ...(['line', 'point'] as const).map(
      (pl): LayerSpecification => ({
        id: `bm-water-name-${pl}`,
        type: 'symbol',
        source: 'ofm',
        'source-layer': 'water_name',
        filter: pl === 'line' ? isLine : ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false],
        layout: {
          'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
          'text-font': ['Noto Sans Italic'],
          'text-size': 11,
          'text-letter-spacing': 0.12,
          'symbol-placement': pl,
        },
        paint: { 'text-color': G.waterName, 'text-halo-color': G.placeHalo, 'text-halo-width': 1.2 },
      }),
    ),
    {
      id: 'bm-place',
      type: 'symbol',
      source: 'ofm',
      'source-layer': 'place',
      filter: ['match', ['get', 'class'], ['city', 'town'], true, false],
      layout: {
        'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
        'text-font': ['Noto Sans Regular'],
        'text-size': ['match', ['get', 'class'], 'city', 12, 10.5],
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.18,
        'text-max-width': 8,
        'text-padding': 6,
      },
      paint: { 'text-color': G.place, 'text-halo-color': G.placeHalo, 'text-halo-width': 1.4 },
    },
  ];
}

function gameLayers(t: MapTheme): LayerSpecification[] {
  const P = PALETTES[t];
  const camColor: ExpressionSpecification = [
    'match',
    ['get', 'status'],
    'ok',
    P.cam.ok,
    'sabotaged',
    P.cam.sabotaged,
    'repairing',
    P.cam.repairing,
    'static',
    P.cam.static,
    'blackout',
    P.cam.blackout,
    P.cam.none,
  ];
  const covColor = t === 'monster' ? '#e8d8bf' : '#3ec4a0';
  const tone = ['match', ['get', 'rk'], ...ROUTE_KEYS.flatMap((k) => [k, P.route[k]!]), P.street] as unknown as ExpressionSpecification;
  const width = ['match', ['get', 'cls'], 'interstate', 3.4, 'us', 3.4, 'state', 2.6, 1.5] as unknown as ExpressionSpecification;
  return [
    {
      id: 'g-heat',
      type: 'circle',
      source: 'g-heat',
      paint: {
        'circle-color': '#ff3b46',
        'circle-radius': [
          'interpolate',
          ['exponential', 1.5],
          ['zoom'],
          8,
          ['*', ['get', 'r'], 0.6],
          12,
          ['*', ['get', 'r'], 1.6],
          15,
          ['*', ['get', 'r'], 3],
        ] as unknown as ExpressionSpecification,
        'circle-blur': 1,
        'circle-opacity': ['get', 'o'],
      },
    },
    {
      id: 'g-zone-fill',
      type: 'fill',
      source: 'g-zone',
      paint: { 'fill-color': P.hq, 'fill-opacity': 0.05 },
    },
    {
      id: 'g-zone-line',
      type: 'line',
      source: 'g-zone',
      paint: { 'line-color': P.hq, 'line-opacity': 0.35, 'line-width': 1, 'line-dasharray': [4, 3] },
    },
    {
      id: 'g-coverage',
      type: 'circle',
      source: 'g-nodes',
      filter: ['==', ['get', 'status'], 'ok'],
      paint: {
        'circle-color': covColor,
        'circle-radius': z([[8, 14], [12, 34], [15, 70]]),
        'circle-blur': 1,
        'circle-opacity': t === 'monster' ? 0.13 : 0.16,
      },
    },
    {
      id: 'g-deadzone',
      type: 'circle',
      source: 'g-nodes',
      filter: ['==', ['get', 'status'], 'sabotaged'],
      paint: {
        'circle-color': SEM.alert,
        'circle-radius': z([[8, 10], [12, 20], [15, 36]]),
        'circle-opacity': t === 'monster' ? 0 : 0.08,
        'circle-stroke-color': SEM.alert,
        'circle-stroke-width': 1,
        'circle-stroke-opacity': t === 'monster' ? 0 : 0.45,
      },
    },
    // edges: one tone per route (as on the tactical map); bridges hollow, tunnels dashed
    {
      id: 'g-edge-road',
      type: 'line',
      source: 'g-edges',
      filter: ['match', ['get', 'kind'], ['freeway', 'surface'], true, false],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': tone, 'line-width': width, 'line-opacity': 0.95 },
    },
    {
      id: 'g-edge-tunnel',
      type: 'line',
      source: 'g-edges',
      filter: ['==', ['get', 'kind'], 'tunnel'],
      paint: { 'line-color': tone, 'line-width': width, 'line-dasharray': [1.4, 1.1] },
    },
    {
      id: 'g-edge-bridge-casing',
      type: 'line',
      source: 'g-edges',
      filter: ['==', ['get', 'kind'], 'bridge'],
      paint: { 'line-color': tone, 'line-width': ['+', width, 3.2] as unknown as ExpressionSpecification },
    },
    {
      id: 'g-edge-bridge-deck',
      type: 'line',
      source: 'g-edges',
      filter: ['==', ['get', 'kind'], 'bridge'],
      paint: { 'line-color': GEO_PALETTES[t].water, 'line-width': ['-', width, 0.9] as unknown as ExpressionSpecification },
    },
    {
      id: 'g-edge-hit',
      type: 'line',
      source: 'g-edges',
      paint: { 'line-color': '#000', 'line-width': 10, 'line-opacity': 0.01 },
    },
    // rings / tripwires / routes
    {
      id: 'g-rings',
      type: 'circle',
      source: 'g-rings',
      paint: {
        'circle-color': ['get', 'c'],
        'circle-opacity': 0.1,
        'circle-radius': 15,
        'circle-stroke-color': ['get', 'c'],
        'circle-stroke-width': 1,
        'circle-stroke-opacity': 0.6,
      },
    },
    {
      id: 'g-trip',
      type: 'line',
      source: 'g-trip',
      paint: { 'line-color': ['get', 'c'], 'line-opacity': 0.45, 'line-width': 1.2, 'line-dasharray': [1, 3] },
    },
    {
      id: 'g-attack',
      type: 'line',
      source: 'g-attack',
      paint: { 'line-color': P.attack, 'line-opacity': 0.4, 'line-width': 1.3, 'line-dasharray': [5, 4] },
    },
    {
      id: 'g-hops',
      type: 'line',
      source: 'g-hops',
      paint: { 'line-color': ['get', 'c'], 'line-opacity': 0.7, 'line-width': 2 },
    },
    {
      id: 'g-path-glow',
      type: 'line',
      source: 'g-path',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': P.path, 'line-opacity': 0.2, 'line-width': 9, 'line-blur': 2 },
    },
    {
      id: 'g-path',
      type: 'line',
      source: 'g-path',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': P.path, 'line-width': 2.4, 'line-dasharray': [3, 1.6] },
    },
    {
      id: 'g-spokes',
      type: 'line',
      source: 'g-spokes',
      paint: {
        'line-color': ['get', 'c'],
        'line-opacity': ['get', 'o'],
        'line-width': ['get', 'w'],
        'line-dasharray': [2, 2],
      },
    },
    // nodes
    {
      id: 'g-node-hl',
      type: 'circle',
      source: 'g-nodes',
      filter: ['!=', ['get', 'hl'], ''],
      paint: {
        'circle-radius': 11.5,
        'circle-color': ['get', 'hl'],
        'circle-opacity': 0.14,
        'circle-stroke-color': ['get', 'hl'],
        'circle-stroke-width': 1.2,
        'circle-stroke-opacity': 0.8,
      },
    },
    {
      id: 'g-node-ring',
      type: 'circle',
      source: 'g-nodes',
      filter: ['!=', ['get', 'ring'], ''],
      paint: {
        'circle-radius': ['get', 'ringR'],
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': ['get', 'ring'],
        'circle-stroke-width': 1.6,
        'circle-stroke-opacity': 0.9,
      },
    },
    {
      id: 'g-node-body',
      type: 'circle',
      source: 'g-nodes',
      paint: {
        'circle-radius': ['case', ['get', 'ap'], 6.4, 5.6],
        'circle-color': P.nodeFill,
        'circle-stroke-color': ['case', ['==', ['get', 'status'], 'sabotaged'], t === 'monster' ? '#7a2a2e' : SEM.alert, ['get', 'ap'], P.nodeRingKey, P.nodeRing],
        'circle-stroke-width': ['case', ['get', 'ap'], 1.6, 1.2],
      },
    },
    {
      id: 'g-node-pip',
      type: 'circle',
      source: 'g-nodes',
      paint: { 'circle-radius': ['case', ['==', ['get', 'status'], 'sabotaged'], 3.4, 2.7], 'circle-color': camColor },
    },
    {
      id: 'g-node-sel',
      type: 'circle',
      source: 'g-nodes',
      filter: ['any', ['get', 'sel'], ['get', 'hover']],
      paint: {
        'circle-radius': ['case', ['get', 'sel'], 11, 13],
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': ['case', ['get', 'sel'], P.labelStrong, P.accent],
        'circle-stroke-width': 1.4,
        'circle-stroke-opacity': 0.9,
      },
    },
    {
      id: 'g-marks',
      type: 'circle',
      source: 'g-marks',
      filter: ['==', ['get', 'slot'], 'c'],
      paint: {
        'circle-radius': ['get', 'r'],
        'circle-color': ['get', 'c'],
        'circle-opacity': ['get', 'fo'],
        'circle-stroke-color': ['get', 'c'],
        'circle-stroke-width': ['get', 'sw'],
        'circle-stroke-opacity': ['get', 'so'],
      },
    },
    {
      id: 'g-marks-ne',
      type: 'circle',
      source: 'g-marks',
      filter: ['==', ['get', 'slot'], 'ne'],
      paint: {
        'circle-radius': ['get', 'r'],
        'circle-color': ['get', 'c'],
        'circle-opacity': ['get', 'fo'],
        'circle-translate': [9, -9],
        'circle-stroke-color': ['get', 'c'],
        'circle-stroke-width': ['get', 'sw'],
        'circle-stroke-opacity': ['get', 'so'],
      },
    },
    {
      id: 'g-marks-nw',
      type: 'circle',
      source: 'g-marks',
      filter: ['==', ['get', 'slot'], 'nw'],
      paint: {
        'circle-radius': ['get', 'r'],
        'circle-color': ['get', 'c'],
        'circle-opacity': ['get', 'fo'],
        'circle-translate': [-9, -9],
        'circle-stroke-color': ['get', 'c'],
        'circle-stroke-width': ['get', 'sw'],
        'circle-stroke-opacity': ['get', 'so'],
      },
    },
    {
      id: 'g-doors',
      type: 'circle',
      source: 'g-doors',
      paint: {
        'circle-radius': 4.6,
        'circle-color': ['case', ['get', 'closed'], ['get', 'c'], P.nodeFill],
        'circle-stroke-color': ['get', 'c'],
        'circle-stroke-width': 1.6,
      },
    },
    {
      id: 'g-sight',
      type: 'circle',
      source: 'g-sight',
      paint: {
        'circle-radius': ['get', 'r'],
        'circle-color': ['get', 'c'],
        'circle-opacity': ['*', ['get', 'o'], 0.14],
        'circle-stroke-color': ['get', 'c'],
        'circle-stroke-width': ['get', 'sw'],
        'circle-stroke-opacity': ['get', 'o'],
      },
    },
    {
      id: 'g-node-hit',
      type: 'circle',
      source: 'g-nodes',
      paint: { 'circle-radius': 14, 'circle-color': '#000', 'circle-opacity': 0.01 },
    },
  ];
}

export function buildStyle(theme: MapTheme, withBasemap = true): StyleSpecification {
  const sources: StyleSpecification['sources'] = {};
  if (withBasemap) sources.ofm = { type: 'vector', url: OFM_TILEJSON, attribution: OFM_ATTRIBUTION };
  for (const s of GAME_SOURCES) sources[s] = { type: 'geojson', data: EMPTY };
  const base = basemapLayers(theme);
  return {
    version: 8,
    glyphs: OFM_GLYPHS,
    sources,
    layers: [...(withBasemap ? base : base.slice(0, 1)), ...gameLayers(theme)],
  };
}
