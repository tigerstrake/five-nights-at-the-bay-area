// Stylised Bay Area geography in *tactical* space (0..1000, x east, y south — see docs/CAMERAS.md §5).
// The tactical node layout is hand-placed and strongly warped (SF sits far west, San Jose is squashed),
// so a projected real coastline would fold over itself. Instead the shoreline is hand-authored around the
// node layout: every bridge edge crosses water, every other edge stays on land (asserted in bay.test.ts).
// Points are smoothed with a closed Catmull-Rom spline into cubic Béziers at module load.

export type Pt = readonly [number, number];

/** One closed polygon: Pacific (west) + Golden Gate + Central / San Pablo / South Bay + Carquinez + Suisun. */
export const WATER: Pt[] = [
  // far ocean, north-west corner (well beyond any viewport)
  [-1400, -1400],
  [-320, -1400],
  // Pacific coast of Marin, north → south
  [-150, -420],
  [-40, -120],
  [12, 70],
  [40, 200],
  [60, 290],
  [76, 370],
  [98, 428],
  [126, 462],
  // Golden Gate north shore → Sausalito → Richardson Bay → Tiburon
  [160, 468],
  [182, 455],
  [186, 412],
  [168, 368],
  [150, 334],
  [164, 306],
  [198, 322],
  [222, 304],
  [208, 266],
  [196, 228],
  [206, 186],
  // San Pablo Bay: west + north shores
  [228, 128],
  [262, 94],
  [320, 80],
  [400, 74],
  [462, 76],
  [502, 86],
  // Carquinez Strait north bank → Suisun Bay
  [546, 98],
  [596, 112],
  [646, 132],
  [694, 158],
  [742, 168],
  [800, 160],
  [870, 150],
  [960, 160],
  [1060, 176],
  [1180, 182],
  [1320, 200],
  [1500, 214],
  [1700, 226],
  [1700, 238],
  [1500, 232],
  [1320, 226],
  [1180, 214],
  [1060, 212],
  [960, 216],
  [870, 210],
  [800, 212],
  [744, 204],
  [702, 194],
  [652, 172],
  [606, 146],
  [574, 132],
  [538, 132],
  // San Pablo Bay east shore (Pinole / Richmond)
  [508, 150],
  [486, 186],
  [458, 226],
  [418, 252],
  [372, 262],
  [338, 280],
  // Central Bay east shore (Richmond → Berkeley → Emeryville)
  [350, 302],
  [380, 322],
  [414, 342],
  [438, 374],
  [450, 412],
  [452, 446],
  [440, 472],
  [424, 494],
  // Oakland / Alameda → South Bay east shore
  [440, 514],
  [466, 538],
  [492, 564],
  [512, 594],
  [530, 626],
  [546, 660],
  [566, 698],
  [596, 728],
  [628, 750],
  [648, 772],
  [652, 798],
  [636, 824],
  [610, 842],
  [584, 846],
  [558, 832],
  // South Bay west shore (Menlo Park → Foster City → SFO → Hunters Point)
  [534, 812],
  [512, 786],
  [480, 760],
  [452, 734],
  [424, 712],
  [398, 694],
  [372, 676],
  [342, 656],
  [312, 632],
  [294, 604],
  [286, 572],
  [284, 548],
  // San Francisco north shore → Golden Gate south (Fort Point)
  [270, 530],
  [238, 524],
  [200, 527],
  [164, 533],
  [128, 530],
  [98, 527],
  [72, 534],
  // San Francisco / Peninsula Pacific coast, north → south
  [56, 566],
  [50, 626],
  [48, 700],
  [44, 790],
  [36, 880],
  [24, 960],
  [0, 1050],
  [-60, 1200],
  [-200, 1400],
  [-1400, 2400],
];

/** Islands drawn as land on top of the water. */
export const ISLANDS: Array<{ id: string; name: string; pts: Pt[] }> = [
  {
    id: 'ybi',
    name: 'Yerba Buena',
    pts: [
      [306, 512],
      [316, 500],
      [312, 486],
      [322, 482],
      [330, 494],
      [334, 512],
      [328, 530],
      [314, 534],
    ],
  },
  {
    id: 'angel',
    name: 'Angel Island',
    pts: [
      [232, 352],
      [246, 344],
      [258, 352],
      [256, 368],
      [242, 374],
      [230, 366],
    ],
  },
  {
    id: 'alcatraz',
    name: 'Alcatraz',
    pts: [
      [214, 486],
      [222, 482],
      [226, 488],
      [218, 493],
    ],
  },
];

/** Soft terrain masses (hills) — rendered as faint hatched blobs. */
export const RIDGES: Array<{ id: string; pts: Pt[] }> = [
  // Marin headlands / Mt Tamalpais
  { id: 'tam', pts: [[60, 300], [90, 232], [120, 222], [138, 260], [128, 330], [92, 360], [66, 350]] },
  // Berkeley / Oakland hills
  { id: 'berkeley', pts: [[510, 330], [560, 300], [600, 330], [610, 390], [590, 470], [560, 500], [535, 460], [520, 400]] },
  // Mt Diablo foothills
  { id: 'diablo', pts: [[740, 360], [790, 340], [830, 380], [830, 470], [790, 520], [752, 470]] },
  // Santa Cruz mountains / Peninsula ridge
  { id: 'santacruz', pts: [[60, 830], [100, 770], [150, 830], [180, 900], [160, 980], [100, 1010], [56, 940]] },
  // San Bruno mountain
  { id: 'sanbruno', pts: [[120, 680], [150, 664], [175, 680], [168, 706], [134, 710]] },
];

export interface RegionLabel {
  id: string;
  text: string;
  x: number;
  y: number;
  kind: 'region' | 'water';
  /** Degrees. */
  rotate?: number;
  /** Hidden while this HQ is the focused one (its own name labels the area). */
  hideFor?: string;
}

export const REGION_LABELS: RegionLabel[] = [
  { id: 'north-bay', text: 'NORTH BAY', x: 160, y: 112, kind: 'region' },
  { id: 'east-bay', text: 'EAST BAY', x: 612, y: 250, kind: 'region' },
  { id: 'sf', text: 'SAN FRANCISCO', x: 160, y: 652, kind: 'region', hideFor: 'hq-sf' },
  { id: 'peninsula', text: 'PENINSULA', x: 222, y: 776, kind: 'region' },
  { id: 'south-bay', text: 'SOUTH BAY', x: 600, y: 990, kind: 'region' },
  { id: 'san-pablo-bay', text: 'San Pablo Bay', x: 352, y: 168, kind: 'water' },
  { id: 'sf-bay', text: 'San Francisco Bay', x: 360, y: 620, kind: 'water', rotate: 38 },
  { id: 'pacific', text: 'Pacific Ocean', x: 4, y: 760, kind: 'water', rotate: -90 },
  { id: 'carquinez', text: 'Carquinez Str.', x: 650, y: 165, kind: 'water', rotate: 22 },
];

/** Closed Catmull-Rom → cubic Bézier SVG path. */
export function smoothClosedPath(pts: readonly Pt[], tension = 0.5): string {
  const n = pts.length;
  if (n < 3) return '';
  const p = (i: number) => pts[((i % n) + n) % n]!;
  let d = `M${p(0)[0].toFixed(1)},${p(0)[1].toFixed(1)}`;
  const t = tension / 3;
  for (let i = 0; i < n; i++) {
    const p0 = p(i - 1), p1 = p(i), p2 = p(i + 1), p3 = p(i + 2);
    const c1x = p1[0] + (p2[0] - p0[0]) * t;
    const c1y = p1[1] + (p2[1] - p0[1]) * t;
    const c2x = p2[0] - (p3[0] - p1[0]) * t;
    const c2y = p2[1] - (p3[1] - p1[1]) * t;
    d += `C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d + 'Z';
}

/** Even-odd point-in-polygon on the raw (unsmoothed) outline. */
export function pointInPolygon(x: number, y: number, poly: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function isWater(x: number, y: number): boolean {
  if (!pointInPolygon(x, y, WATER)) return false;
  return !ISLANDS.some((i) => pointInPolygon(x, y, i.pts));
}

export const WATER_PATH = smoothClosedPath(WATER, 0.45);
export const ISLAND_PATHS = ISLANDS.map((i) => ({ id: i.id, name: i.name, d: smoothClosedPath(i.pts, 0.6) }));
export const RIDGE_PATHS = RIDGES.map((r) => ({
  id: r.id,
  d: smoothClosedPath(r.pts, 0.7),
  cx: r.pts.reduce((s, p) => s + p[0], 0) / r.pts.length,
  cy: r.pts.reduce((s, p) => s + p[1], 0) / r.pts.length,
}));
