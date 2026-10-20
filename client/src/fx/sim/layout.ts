// Deterministic layout of a simulated CCTV scene, in resolution-independent units.
// Perspective model: road plane, camera looking down the carriageway.
//   screen x = vx·W + X·s·W / z        (X in lane widths, z ≥ 1 is distance; z = 1 at frame bottom)
//   screen y = hy·H + (1-hy)·H / z − h·s·W / z   (h = height above the road, lane widths)
import type { PlacementRegion } from '../index';
import { clamp, hashString, mulberry32, pick, range, type Rng } from '../core/rng';
import { simImageFor } from './simImages';

export type SimKind = 'freeway' | 'bridge' | 'tunnel' | 'downtown' | 'interchange' | 'toll';

export interface Lamp {
  X: number;
  z: number;
  h: number;
  arm: number; // lateral arm length (signed)
  color: 'sodium' | 'led';
  flicker: boolean;
}

export interface Lane {
  X: number;
  dir: 1 | -1; // 1 = departing (taillights), -1 = approaching (headlights)
  cars: number;
  speed: number;
  phase: number;
  seed: number;
}

export interface Building {
  side: -1 | 1;
  X: number;
  z0: number;
  z1: number;
  h: number;
  tone: number;
  seed: number;
}

export interface SimLayout {
  kind: SimKind;
  seed: number;
  hy: number;
  vx: number;
  s: number;
  roll: number;
  zMax: number;
  median: number;
  edgeL: number;
  edgeR: number;
  lanes: Lane[];
  lampsLeft: boolean;
  lamps: Lamp[];
  gantry: { z: number; h: number; signs: Array<{ X: number; w: number }>; canopy: boolean } | null;
  overpass: { z: number; h: number } | null;
  towers: { zs: number[]; top: number; X: number; bayLights: boolean } | null;
  portal: { z: number } | null;
  buildings: Building[];
  soundWall: { left: boolean; right: boolean; h: number };
  hills: number[];
  skyGlow: [number, number, number];
}

export function simSeed(cameraId: string, seed: number): number {
  return (hashString(cameraId) ^ Math.imul(seed | 0, 0x9e3779b1)) >>> 0;
}

export function simKindFor(tags: string[]): SimKind {
  const t = new Set(tags.map((x) => x.toLowerCase()));
  if (t.has('tunnel')) return 'tunnel';
  if (t.has('bridge')) return 'bridge';
  if (t.has('downtown') || t.has('city') || t.has('urban')) return 'downtown';
  if (t.has('toll')) return 'toll';
  if (t.has('interchange') || t.has('overpass')) return 'interchange';
  return 'freeway';
}

function lanesFor(rng: Rng, median: number, nA: number, nB: number, gap: number, baseSpeed: number): Lane[] {
  const lanes: Lane[] = [];
  for (let i = 0; i < nA; i++) {
    lanes.push({ X: median - gap - 0.5 - i, dir: -1, cars: 1 + Math.floor(rng() * 3.2), speed: baseSpeed * range(rng, 0.8, 1.15) * (1 - i * 0.05), phase: rng(), seed: Math.floor(rng() * 1e9) });
  }
  for (let i = 0; i < nB; i++) {
    lanes.push({ X: median + gap + 0.5 + i, dir: 1, cars: 1 + Math.floor(rng() * 3.2), speed: baseSpeed * range(rng, 0.8, 1.15) * (1 - i * 0.05), phase: rng(), seed: Math.floor(rng() * 1e9) });
  }
  return lanes;
}

const cache = new Map<string, SimLayout>();

export function getSimLayout(cameraId: string, seed: number, tags: string[]): SimLayout {
  const key = `${cameraId}|${seed}|${tags.join(',')}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const sd = simSeed(cameraId, seed);
  const rng = mulberry32(sd);
  const kind = simKindFor(tags);
  const hy = range(rng, 0.3, 0.4);
  const vx = range(rng, 0.4, 0.6);
  const s = range(rng, 0.15, 0.19);
  const roll = range(rng, -0.012, 0.012);
  const zMax = 80;
  const nA = kind === 'toll' ? 5 : 2 + Math.floor(rng() * 3);
  const nB = kind === 'toll' ? 4 : 2 + Math.floor(rng() * 3);
  const median = range(rng, -0.8, 0.6) + (nA - nB) * 0.3;
  const gap = kind === 'downtown' ? 0.15 : 0.45;
  const edgeL = median - gap - nA - 0.6;
  const edgeR = median + gap + nB + 0.6;
  const lanes = lanesFor(rng, median, nA, nB, gap, kind === 'downtown' ? 4 : range(rng, 6, 8.5));

  const lamps: Lamp[] = [];
  const color = kind === 'downtown' || (kind === 'bridge' && rng() < 0.5) ? 'led' : 'sodium';
  const spacing = kind === 'bridge' ? 7 : kind === 'downtown' ? 9 : 13;
  const lampsLeft = rng() < 0.5;
  for (let z = range(rng, 2.5, 6); z < zMax; z += spacing) {
    if (kind === 'bridge' || kind === 'downtown') {
      lamps.push({ X: edgeL - 0.25, z, h: 4.2, arm: 0.9, color, flicker: rng() < 0.06 });
      lamps.push({ X: edgeR + 0.25, z: z + spacing * 0.5, h: 4.2, arm: -0.9, color, flicker: rng() < 0.06 });
    } else {
      lamps.push({ X: median, z, h: 4.8, arm: 1.1, color, flicker: rng() < 0.08 });
      lamps.push({ X: median, z, h: 4.8, arm: -1.1, color, flicker: false });
    }
  }

  let gantry: SimLayout['gantry'] = null;
  if (kind === 'freeway' || kind === 'toll' || (kind === 'interchange' && rng() < 0.5)) {
    const z = range(rng, 5.5, 11);
    const signs: Array<{ X: number; w: number }> = [];
    if (kind !== 'toll') {
      const n = 1 + Math.floor(rng() * 2.5);
      for (let i = 0; i < n; i++) signs.push({ X: median + gap + 0.6 + i * 1.9 + range(rng, 0, 0.3), w: range(rng, 1.5, 2.1) });
      if (rng() < 0.6) signs.push({ X: median - gap - 2.4, w: range(rng, 1.6, 2.2) });
    }
    gantry = { z, h: range(rng, 4.6, 5.4), signs, canopy: kind === 'toll' };
  }
  const overpass = kind === 'interchange' ? { z: range(rng, 9, 16), h: range(rng, 4.2, 5) } : null;
  const towers = kind === 'bridge' ? { zs: [range(rng, 9, 15)], top: range(rng, 34, 44), X: 0.7, bayLights: rng() < 0.5 } : null;
  if (towers) towers.zs.push(towers.zs[0] + range(rng, 34, 44));
  const portal = kind === 'tunnel' ? { z: range(rng, 8, 13) } : null;

  const buildings: Building[] = [];
  if (kind === 'downtown') {
    for (const side of [-1, 1] as const) {
      let z = range(rng, 1.2, 2.5);
      while (z < 60) {
        const len = range(rng, 3, 9);
        buildings.push({ side, X: side < 0 ? edgeL - 1.4 : edgeR + 1.4, z0: z, z1: z + len, h: range(rng, 6, 26), tone: rng(), seed: Math.floor(rng() * 1e9) });
        z += len + (rng() < 0.2 ? range(rng, 1, 3) : 0.05);
      }
    }
  }
  const soundWall = {
    left: kind === 'freeway' || kind === 'interchange' ? rng() < 0.55 : false,
    right: kind === 'freeway' || kind === 'interchange' ? rng() < 0.7 : false,
    h: range(rng, 1.6, 2.6),
  };
  const hills: number[] = [];
  let hv = rng();
  for (let i = 0; i < 48; i++) {
    hv = clamp(hv + (rng() - 0.5) * 0.35);
    hills.push(hv);
  }
  const skyGlow = pick(rng, [
    [58, 42, 30],
    [46, 38, 34],
    [40, 36, 40],
    [52, 40, 28],
  ] as Array<[number, number, number]>);
  const layout: SimLayout = { kind, seed: sd, hy, vx, s, roll, zMax, median, edgeL, edgeR, lanes, lampsLeft, lamps, gantry, overpass, towers, portal, buildings, soundWall, hills, skyGlow };
  cache.set(key, layout);
  return layout;
}

/**
 * Plausible monster placement regions for a simulated scene (same normalized format as
 * CameraRecord.placement). Use these instead of the real camera's regions while the
 * SimulatedFeed is shown, so the creature stands on the simulated road rather than in the sky.
 */
export function getSimulatedPlacement(cameraId: string, seed: number, tags: string[], aspect = 16 / 9): PlacementRegion[] {
  const L = getSimLayout(cameraId, seed, tags);
  // When a bundled sample image is used for this scene, its hand-placed regions win.
  // (SimulatedFeed also publishes the exact regions for its current frame to FeedFxOverlay.)
  const img = simImageFor(tags, L.kind, L.seed);
  if (img?.placement) return img.placement;
  const x = (X: number, z: number) => L.vx + (X * L.s) / z;
  const y = (z: number, h = 0) => L.hy + (1 - L.hy) / z - (h * L.s * aspect) / z;
  const figH = 1.05; // creature height in lane widths
  /** feet box on the ground (or on a structure at height h) around lateral X at distance z */
  const reg = (X: number, z: number, h = 0, w = 0.6): PlacementRegion => {
    const cx = x(X, z);
    const half = (w * L.s) / z;
    const y0 = y(z * 1.04, h);
    const y1 = y(z * 0.96, h);
    return {
      x: clamp(cx - half, 0, 0.98),
      y: clamp(y0, 0, 0.98),
      w: clamp(half * 2, 0.01, 1),
      h: clamp(y1 - y0, 0.005, 0.3),
      scale: clamp((figH * L.s * aspect) / z, 0.03, 0.9),
    };
  };
  const out: PlacementRegion[] = [];
  out.push(reg(L.edgeR + 0.3, 2.2)); // near right shoulder
  out.push(reg(L.median, 6)); // standing on the median
  out.push(reg(L.edgeL - 0.2, 4)); // left shoulder
  out.push(reg((L.median + L.edgeR) / 2, 18, 0, 1.2)); // far in the lanes
  if (L.gantry && !L.gantry.canopy) out.push(reg(L.median + 1.2, L.gantry.z, L.gantry.h + 0.35, 0.4)); // on the sign gantry
  if (L.portal) out.push(reg(L.median - 1.2, L.portal.z + 0.5, 0, 0.5)); // in the tunnel mouth
  if (L.towers) out.push(reg(L.edgeR + 0.4, L.towers.zs[0] - 0.5, 0, 0.4)); // at the tower base
  if (L.overpass) out.push(reg(L.median + 1.5, L.overpass.z, L.overpass.h + 0.3, 1.5)); // on the overpass rail
  return out;
}
