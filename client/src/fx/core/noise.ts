// Precomputed noise resources shared by every FX surface (generated once, lazily).
import { mulberry32, gauss, clamp } from './rng';

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function ctx2d(c: HTMLCanvasElement, opts?: CanvasRenderingContext2DSettings): CanvasRenderingContext2D {
  const ctx = c.getContext('2d', opts);
  if (!ctx) throw new Error('2d context unavailable');
  return ctx;
}

// ---------------------------------------------------------------------------------------------
// Scalar noise fields (Float32, tileable) for one-time sprite generation.

export interface NoiseField {
  size: number;
  data: Float32Array;
}

/** Tileable value noise with `cells` lattice cells per side, smoothstep-interpolated, 0..1. */
export function valueNoise(size: number, cells: number, seed: number): NoiseField {
  const rng = mulberry32(seed);
  const lattice = new Float32Array(cells * cells);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rng();
  const data = new Float32Array(size * size);
  const step = cells / size;
  for (let y = 0; y < size; y++) {
    const fy = y * step;
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    const sy = ty * ty * (3 - 2 * ty);
    const r0 = (y0 % cells) * cells;
    const r1 = ((y0 + 1) % cells) * cells;
    for (let x = 0; x < size; x++) {
      const fx = x * step;
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const sx = tx * tx * (3 - 2 * tx);
      const c0 = x0 % cells;
      const c1 = (x0 + 1) % cells;
      const a = lattice[r0 + c0] + (lattice[r0 + c1] - lattice[r0 + c0]) * sx;
      const b = lattice[r1 + c0] + (lattice[r1 + c1] - lattice[r1 + c0]) * sx;
      data[y * size + x] = a + (b - a) * sy;
    }
  }
  return { size, data };
}

/** Tileable fBm, normalized to roughly 0..1. */
export function fbm(size: number, seed: number, baseCells = 4, octaves = 5): NoiseField {
  const out = new Float32Array(size * size);
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const cells = Math.min(size, baseCells << o);
    const n = valueNoise(size, cells, seed * 31 + o * 977);
    for (let i = 0; i < out.length; i++) out[i] += n.data[i] * amp;
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return { size, data: out };
}

export function sampleField(f: NoiseField, x: number, y: number): number {
  const s = f.size;
  const xi = ((Math.floor(x) % s) + s) % s;
  const yi = ((Math.floor(y) % s) + s) % s;
  return f.data[yi * s + xi];
}

let sharedFbm: NoiseField | null = null;
let sharedFine: NoiseField | null = null;
/** Shared 256² fBm field (coarse organic variation). */
export function getFbmField(): NoiseField {
  return (sharedFbm ??= fbm(256, 1337, 4, 5));
}
/** Shared 256² high-frequency field. */
export function getFineField(): NoiseField {
  return (sharedFine ??= fbm(256, 4242, 32, 3));
}

// ---------------------------------------------------------------------------------------------
// Canvas tiles drawn every frame.

const GRAIN_TILES = 6;
const GRAIN_SIZE = 192;
let grain: HTMLCanvasElement[] | null = null;

/** Luminance-symmetric sensor grain: white & black specks with alpha ∝ deviation. */
export function getGrainTiles(): HTMLCanvasElement[] {
  if (grain) return grain;
  grain = [];
  for (let t = 0; t < GRAIN_TILES; t++) {
    const c = makeCanvas(GRAIN_SIZE, GRAIN_SIZE);
    const ctx = ctx2d(c);
    const img = ctx.createImageData(GRAIN_SIZE, GRAIN_SIZE);
    const rng = mulberry32(9001 + t * 17);
    const d = img.data;
    for (let i = 0; i < GRAIN_SIZE * GRAIN_SIZE; i++) {
      const g = gauss(rng) * 0.5;
      const v = g > 0 ? 255 : 0;
      d[i * 4] = v;
      d[i * 4 + 1] = v;
      d[i * 4 + 2] = v;
      d[i * 4 + 3] = clamp(Math.abs(g) * 0.9) * 255;
    }
    ctx.putImageData(img, 0, 0);
    grain.push(c);
  }
  return grain;
}

const SNOW_TILES = 4;
const SNOW_W = 384;
const SNOW_H = 256;
let snow: HTMLCanvasElement[] | null = null;

/** Opaque analog "snow" (horizontally smeared, slightly blue-gray), for static washes. */
export function getSnowTiles(): HTMLCanvasElement[] {
  if (snow) return snow;
  snow = [];
  for (let t = 0; t < SNOW_TILES; t++) {
    const c = makeCanvas(SNOW_W, SNOW_H);
    const ctx = ctx2d(c);
    const img = ctx.createImageData(SNOW_W, SNOW_H);
    const rng = mulberry32(777 + t * 101);
    const d = img.data;
    for (let y = 0; y < SNOW_H; y++) {
      let prev = rng();
      const lineGain = 0.75 + rng() * 0.5;
      for (let x = 0; x < SNOW_W; x++) {
        const r = rng();
        prev = prev * 0.3 + r * 0.7; // slight horizontal smear like analog bandwidth limits
        let v = Math.pow(prev, 1.35) * lineGain;
        if (r > 0.985) v = 1; // sparkle
        v = clamp(v);
        const i = (y * SNOW_W + x) * 4;
        d[i] = v * 222;
        d[i + 1] = v * 226;
        d[i + 2] = v * 232;
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    snow.push(c);
  }
  return snow;
}

/** Fill a rect with a tile at a pixel offset and scale, using drawImage tiling (no patterns). */
export function tileFill(
  ctx: CanvasRenderingContext2D,
  tile: HTMLCanvasElement,
  x: number,
  y: number,
  w: number,
  h: number,
  scale: number,
  ox: number,
  oy: number,
): void {
  const tw = tile.width * scale;
  const th = tile.height * scale;
  const sx = x - (((ox % tw) + tw) % tw);
  const sy = y - (((oy % th) + th) % th);
  for (let yy = sy; yy < y + h; yy += th) {
    for (let xx = sx; xx < x + w; xx += tw) {
      ctx.drawImage(tile, xx, yy, tw, th);
    }
  }
}

const scanCache = new Map<string, HTMLCanvasElement>();
/** Scanline tile (512 wide, many periods tall) so a full-frame fill is a handful of draws. */
export function getScanlineTile(period: number, alpha: number): HTMLCanvasElement {
  const key = `${period}:${alpha.toFixed(3)}`;
  let c = scanCache.get(key);
  if (c) return c;
  const reps = Math.max(1, Math.floor(256 / period));
  c = makeCanvas(512, period * reps);
  const ctx = ctx2d(c);
  ctx.fillStyle = `rgba(0,0,0,${alpha})`;
  const lh = Math.max(1, Math.floor(period / 2));
  for (let i = 0; i < reps; i++) ctx.fillRect(0, i * period, 512, lh);
  if (scanCache.size > 64) scanCache.clear();
  scanCache.set(key, c);
  return c;
}

/** Alternate-line mask (opaque even rows) used for interlace combing; 512×256. */
let interlaceTile: HTMLCanvasElement | null = null;
export function getInterlaceTile(): HTMLCanvasElement {
  if (interlaceTile) return interlaceTile;
  interlaceTile = makeCanvas(512, 256);
  const ctx = ctx2d(interlaceTile);
  ctx.fillStyle = '#fff';
  for (let y = 0; y < 256; y += 2) ctx.fillRect(0, y, 512, 1);
  return interlaceTile;
}

/** Radial vignette baked at a given size. */
export function makeVignette(w: number, h: number, strength: number): HTMLCanvasElement {
  const c = makeCanvas(w, h);
  const ctx = ctx2d(c);
  const r = Math.hypot(w, h) / 2;
  const g = ctx.createRadialGradient(w / 2, h / 2, r * 0.35, w / 2, h / 2, r);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(0.55, `rgba(0,0,0,${0.18 * strength})`);
  g.addColorStop(1, `rgba(0,0,0,${0.78 * strength})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // slight top/bottom lens falloff typical of cheap CCTV optics
  const lg = ctx.createLinearGradient(0, 0, 0, h);
  lg.addColorStop(0, `rgba(0,0,0,${0.16 * strength})`);
  lg.addColorStop(0.18, 'rgba(0,0,0,0)');
  lg.addColorStop(0.85, 'rgba(0,0,0,0)');
  lg.addColorStop(1, `rgba(0,0,0,${0.2 * strength})`);
  ctx.fillStyle = lg;
  ctx.fillRect(0, 0, w, h);
  return c;
}

// ---------------------------------------------------------------------------------------------
// Separable box blur on a Float32 alpha buffer (used at sprite generation time).

export function boxBlur(src: Float32Array, w: number, h: number, r: number, passes = 2): Float32Array {
  if (r < 1) return src.slice();
  let a = src.slice();
  let b = new Float32Array(a.length);
  const ri = Math.round(r);
  const norm = 1 / (ri * 2 + 1);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = 0;
      for (let k = -ri; k <= ri; k++) acc += a[row + Math.min(w - 1, Math.max(0, k))];
      for (let x = 0; x < w; x++) {
        b[row + x] = acc * norm;
        const add = a[row + Math.min(w - 1, x + ri + 1)];
        const sub = a[row + Math.max(0, x - ri)];
        acc += add - sub;
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -ri; k <= ri; k++) acc += b[Math.min(h - 1, Math.max(0, k)) * w + x];
      for (let y = 0; y < h; y++) {
        a[y * w + x] = acc * norm;
        const add = b[Math.min(h - 1, y + ri + 1) * w + x];
        const sub = b[Math.max(0, y - ri) * w + x];
        acc += add - sub;
      }
    }
    const t = a;
    a = t;
    b = b.length === a.length ? b : new Float32Array(a.length);
  }
  return a;
}
