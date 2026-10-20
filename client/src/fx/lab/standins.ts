// Procedurally painted "real photo" stand-ins (4:3, JPEG-compressed) for testing overlays over
// snapshot <img> elements. Not Caltrans imagery — drawn here so nothing is downloaded or committed.
import type { PlacementRegion } from '../index';
import { ctx2d, getGrainTiles, makeCanvas, tileFill } from '../core/noise';
import { mulberry32, range } from '../core/rng';

export interface Standin {
  id: string;
  label: string;
  url: string;
  placement: PlacementRegion[];
}

const W = 704;
const H = 480;

function persp(vx: number, hy: number) {
  return {
    x: (X: number, z: number) => vx + (X * 120) / z,
    y: (z: number, h = 0) => hy + (H - hy) / z - (h * 120) / z,
  };
}

function finish(c: HTMLCanvasElement, grain: number, label: string): string {
  const x = ctx2d(c);
  x.globalAlpha = grain;
  tileFill(x, getGrainTiles()[0], 0, 0, W, H, 1, 0, 0);
  x.globalAlpha = 1;
  // burned-in camera OSD like many DOT cameras
  x.font = '600 13px monospace';
  x.fillStyle = 'rgba(0,0,0,0.5)';
  x.fillRect(6, H - 24, x.measureText(label).width + 12, 18);
  x.fillStyle = '#f2f2f2';
  x.fillText(label, 12, H - 10);
  return c.toDataURL('image/jpeg', 0.42);
}

function dayFreeway(): Standin {
  const c = makeCanvas(W, H);
  const x = ctx2d(c);
  const rng = mulberry32(11);
  const hy = 170;
  const P = persp(330, hy);
  const sky = x.createLinearGradient(0, 0, 0, hy);
  sky.addColorStop(0, '#9fb3c6');
  sky.addColorStop(1, '#d6dde2');
  x.fillStyle = sky;
  x.fillRect(0, 0, W, hy);
  // hills
  x.fillStyle = '#7d8064';
  x.beginPath();
  x.moveTo(0, hy);
  for (let i = 0; i <= 30; i++) x.lineTo((i / 30) * W, hy - 25 - 30 * Math.sin(i * 0.35) * Math.sin(i * 0.12 + 1) - rng() * 6);
  x.lineTo(W, hy);
  x.fill();
  x.fillStyle = '#8a8a70';
  x.fillRect(0, hy, W, H - hy);
  // road
  x.fillStyle = '#6d6c69';
  x.beginPath();
  x.moveTo(P.x(-5.2, 0.7), P.y(0.7));
  x.lineTo(P.x(4.8, 0.7), P.y(0.7));
  x.lineTo(P.x(4.8, 90), P.y(90));
  x.lineTo(P.x(-5.2, 90), P.y(90));
  x.fill();
  x.fillStyle = '#b9b5a8';
  for (const X of [-3, -2, -1, 1, 2, 3]) {
    for (let z = 1; z < 80; z += 4) {
      x.beginPath();
      x.moveTo(P.x(X - 0.03, z), P.y(z));
      x.lineTo(P.x(X + 0.03, z), P.y(z));
      x.lineTo(P.x(X + 0.03, z + 1.3), P.y(z + 1.3));
      x.lineTo(P.x(X - 0.03, z + 1.3), P.y(z + 1.3));
      x.fill();
    }
  }
  // median
  x.fillStyle = '#a7a39a';
  x.beginPath();
  x.moveTo(P.x(-0.1, 0.7), P.y(0.7, 0));
  x.lineTo(P.x(-0.1, 0.7), P.y(0.7, 0.35));
  x.lineTo(P.x(-0.1, 90), P.y(90, 0.35));
  x.lineTo(P.x(-0.1, 90), P.y(90, 0));
  x.fill();
  // cars
  const cols = ['#e8e8e8', '#202020', '#7b8a99', '#a02b25', '#c9c9c9', '#384a6a'];
  for (let i = 0; i < 16; i++) {
    const X = (rng() < 0.5 ? -1 : 1) * (0.5 + Math.floor(rng() * 4));
    const z = 1.4 + Math.pow(rng(), 1.6) * 40;
    const u = 120 / z;
    const cx = P.x(X, z);
    const cy = P.y(z);
    x.fillStyle = 'rgba(0,0,0,0.35)';
    x.fillRect(cx - u * 0.45, cy - u * 0.05, u * 0.9, u * 0.12);
    x.fillStyle = cols[Math.floor(rng() * cols.length)];
    x.fillRect(cx - u * 0.4, cy - u * 0.55, u * 0.8, u * 0.5);
    x.fillStyle = 'rgba(40,50,60,0.8)';
    x.fillRect(cx - u * 0.3, cy - u * 0.72, u * 0.6, u * 0.2);
  }
  // overhead sign
  x.fillStyle = '#3c3c3c';
  x.fillRect(P.x(-5, 9), P.y(9, 5.2), P.x(5, 9) - P.x(-5, 9), 4);
  x.fillStyle = '#1d5c3a';
  x.fillRect(P.x(0.6, 9), P.y(9, 6.4), 46, 22);
  x.fillRect(P.x(2.6, 9), P.y(9, 6.4), 42, 22);
  return {
    id: 'day-freeway',
    label: 'I-880 N @ STAND-IN DAY',
    url: finish(c, 0.12, 'STAND-IN 01  DAY'),
    placement: [
      { x: 0.8, y: 0.45, w: 0.12, h: 0.42, scale: 0.36 },
      { x: 0.44, y: 0.36, w: 0.06, h: 0.12, scale: 0.12 },
      { x: 0.2, y: 0.42, w: 0.1, h: 0.22, scale: 0.2 },
    ],
  };
}

function nightFreeway(): Standin {
  const c = makeCanvas(W, H);
  const x = ctx2d(c);
  const rng = mulberry32(23);
  const hy = 150;
  const P = persp(380, hy);
  const sky = x.createLinearGradient(0, 0, 0, hy);
  sky.addColorStop(0, '#05070b');
  sky.addColorStop(1, '#2b2622');
  x.fillStyle = sky;
  x.fillRect(0, 0, W, hy);
  x.fillStyle = '#0b0b0b';
  x.fillRect(0, hy, W, H - hy);
  x.fillStyle = '#1e1d1c';
  x.beginPath();
  x.moveTo(P.x(-6, 0.7), P.y(0.7));
  x.lineTo(P.x(5, 0.7), P.y(0.7));
  x.lineTo(P.x(5, 90), P.y(90));
  x.lineTo(P.x(-6, 90), P.y(90));
  x.fill();
  x.globalCompositeOperation = 'lighter';
  // light trails (long exposure)
  for (let i = 0; i < 9; i++) {
    const X = -0.5 - (i % 4);
    const head = i % 2 === 0;
    x.strokeStyle = head ? 'rgba(255,240,210,0.5)' : 'rgba(255,40,30,0.5)';
    const Xr = head ? X : 0.5 + (i % 4);
    x.lineWidth = 2;
    x.beginPath();
    const z0 = 1.5 + rng() * 6;
    const z1 = z0 + 6 + rng() * 18;
    x.moveTo(P.x(Xr, z0), P.y(z0, 0.3));
    x.lineTo(P.x(Xr, z1), P.y(z1, 0.3));
    x.stroke();
  }
  // sodium lamps
  for (let z = 3; z < 80; z += 10) {
    for (const X of [-6.2, 5.2]) {
      const px = P.x(X, z);
      const py = P.y(z, 5);
      const r = Math.max(3, 300 / z);
      const g = x.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, 'rgba(255,200,120,1)');
      g.addColorStop(0.2, 'rgba(255,150,60,0.5)');
      g.addColorStop(1, 'rgba(255,140,50,0)');
      x.fillStyle = g;
      x.fillRect(px - r, py - r, r * 2, r * 2);
      const pg = x.createRadialGradient(px, P.y(z), 0, px, P.y(z), r * 2);
      pg.addColorStop(0, 'rgba(255,150,60,0.12)');
      pg.addColorStop(1, 'rgba(255,150,60,0)');
      x.fillStyle = pg;
      x.fillRect(px - r * 2, P.y(z) - r, r * 4, r * 2);
    }
  }
  x.globalCompositeOperation = 'source-over';
  return {
    id: 'night-freeway',
    label: 'US-101 S @ STAND-IN NIGHT',
    url: finish(c, 0.3, 'STAND-IN 02  NIGHT'),
    placement: [
      { x: 0.72, y: 0.46, w: 0.14, h: 0.44, scale: 0.4 },
      { x: 0.5, y: 0.32, w: 0.06, h: 0.1, scale: 0.1 },
    ],
  };
}

function dayBridge(): Standin {
  const c = makeCanvas(W, H);
  const x = ctx2d(c);
  const hy = 200;
  const P = persp(350, hy);
  const sky = x.createLinearGradient(0, 0, 0, hy);
  sky.addColorStop(0, '#6f93b8');
  sky.addColorStop(1, '#c4d2de');
  x.fillStyle = sky;
  x.fillRect(0, 0, W, hy);
  x.fillStyle = '#4f6475';
  x.fillRect(0, hy, W, H - hy);
  x.fillStyle = '#5d5d5f';
  x.beginPath();
  x.moveTo(P.x(-4, 0.7), P.y(0.7));
  x.lineTo(P.x(4, 0.7), P.y(0.7));
  x.lineTo(P.x(4, 90), P.y(90));
  x.lineTo(P.x(-4, 90), P.y(90));
  x.fill();
  // towers
  for (const z of [12, 46]) {
    for (const X of [-4.6, 4.6]) {
      const u = 120 / z;
      x.fillStyle = '#8e8f92';
      x.fillRect(P.x(X, z) - u * 0.4, P.y(z, 38), u * 0.8, P.y(z) - P.y(z, 38));
    }
    x.fillRect(P.x(-4.6, z), P.y(z, 30), P.x(4.6, z) - P.x(-4.6, z), 120 / z);
  }
  x.strokeStyle = 'rgba(70,70,75,0.9)';
  x.lineWidth = 2;
  for (const X of [-4.6, 4.6]) {
    x.beginPath();
    for (let z = 0.8; z < 46; z *= 1.04) {
      const zz = z <= 12 ? (z - 0.5) / 11.5 : (z - 29) / 17;
      const h = 2 + 36 * zz * zz;
      if (z === 0.8) x.moveTo(P.x(X, z), P.y(z, h));
      else x.lineTo(P.x(X, z), P.y(z, h));
    }
    x.stroke();
  }
  const rng = mulberry32(5);
  for (let i = 0; i < 10; i++) {
    const X = (rng() < 0.5 ? -1 : 1) * (0.5 + Math.floor(rng() * 3));
    const z = 1.5 + rng() * 30;
    const u = 120 / z;
    x.fillStyle = ['#ddd', '#333', '#865', '#557'][i % 4];
    x.fillRect(P.x(X, z) - u * 0.4, P.y(z) - u * 0.5, u * 0.8, u * 0.45);
  }
  return {
    id: 'day-bridge',
    label: 'BRIDGE @ STAND-IN DAY',
    url: finish(c, 0.1, 'STAND-IN 03  BRIDGE'),
    placement: [
      { x: 0.12, y: 0.42, w: 0.1, h: 0.3, scale: 0.26 },
      { x: 0.66, y: 0.38, w: 0.08, h: 0.2, scale: 0.16 },
    ],
  };
}

function fogInterchange(): Standin {
  const c = makeCanvas(W, H);
  const x = ctx2d(c);
  const hy = 190;
  const P = persp(360, hy);
  x.fillStyle = '#9a9c9c';
  x.fillRect(0, 0, W, H);
  x.fillStyle = '#7d7f7e';
  x.beginPath();
  x.moveTo(P.x(-5, 0.7), P.y(0.7));
  x.lineTo(P.x(5, 0.7), P.y(0.7));
  x.lineTo(P.x(5, 90), P.y(90));
  x.lineTo(P.x(-5, 90), P.y(90));
  x.fill();
  // overpass
  x.fillStyle = '#6c6e6d';
  x.fillRect(0, P.y(10, 6), W, P.y(10, 5) - P.y(10, 6));
  for (const X of [-5, 0, 5]) x.fillRect(P.x(X, 10) - 6, P.y(10, 5), 12, P.y(10) - P.y(10, 5));
  // fog
  const fog = x.createLinearGradient(0, 0, 0, H);
  fog.addColorStop(0, 'rgba(180,182,182,0.9)');
  fog.addColorStop(0.5, 'rgba(170,172,172,0.6)');
  fog.addColorStop(1, 'rgba(160,162,162,0.15)');
  x.fillStyle = fog;
  x.fillRect(0, 0, W, H);
  const rng = mulberry32(7);
  for (let i = 0; i < 8; i++) {
    const X = (rng() < 0.5 ? -1 : 1) * (0.5 + Math.floor(rng() * 4));
    const z = 1.3 + rng() * 12;
    const u = 120 / z;
    x.fillStyle = `rgba(60,62,64,${range(rng, 0.4, 0.9)})`;
    x.fillRect(P.x(X, z) - u * 0.4, P.y(z) - u * 0.5, u * 0.8, u * 0.45);
  }
  return {
    id: 'fog-interchange',
    label: 'I-280 @ STAND-IN FOG',
    url: finish(c, 0.16, 'STAND-IN 04  FOG'),
    placement: [
      { x: 0.46, y: 0.3, w: 0.12, h: 0.2, scale: 0.17 },
      { x: 0.82, y: 0.5, w: 0.1, h: 0.4, scale: 0.38 },
    ],
  };
}

/** old-style "figure box" → feet box (feet on the box bottom) */
function feet(r: PlacementRegion): PlacementRegion {
  return { x: r.x, y: r.y + r.h - 0.04, w: r.w, h: 0.05, scale: r.scale };
}

let cached: Standin[] | null = null;
export function getStandins(): Standin[] {
  return (cached ??= [dayFreeway(), nightFreeway(), dayBridge(), fogInterchange()].map((s) => ({ ...s, placement: s.placement.map(feet) })));
}
