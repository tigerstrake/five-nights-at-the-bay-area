// Scene matching for monster compositing on real footage.
//
// SceneProber samples the picture under an overlay (snapshot <img>, HLS <video>, or our simulated canvas) into a small
// analysis grid, converted to what the player actually sees (the feed's CSS filter is applied in software), and
// derives the numbers the compositor needs: local light colour / black level around the feet, day vs night, fog,
// sharpness and sensor noise of the source, and (for video) global camera motion. Pixels are only read when the
// source is readable (blob/same-origin stills, MSE video, CORS-clean images); otherwise neutral defaults apply.
//
// gradeSprite renders a monster sprite at the SOURCE's resolution and pushes it through the same degradations the
// camera applied to everything else: highlight clamp to the local light, atmospheric veil, chroma of the scene,
// matched noise and (for stills) 8x8 JPEG blocking aligned to the image grid. Everything runs on small scratch
// canvases (tens of pixels), so the per-frame cost is a handful of drawImage calls.
import { ctx2d, getGrainTiles, makeCanvas, tileFill } from '../core/noise';
import { clamp, lerp, rand01, smoothstep } from '../core/rng';

export type RGB = [number, number, number];

export interface SceneProbe {
  /** bumps whenever the pixels were re-sampled */
  version: number;
  /** analysis grid */
  w: number;
  h: number;
  /** displayed-space RGB 0..1 (feed CSS filter applied), w*h*3 */
  rgb: Float32Array;
  /** displayed-space luminance 0..1, w*h */
  lum: Float32Array;
  mean: number;
  p05: number;
  p50: number;
  p95: number;
  meanRGB: RGB;
  /** 0 = night, 1 = full daylight */
  dayness: number;
  /** 0 = clear, 1 = thick fog / washed-out */
  fog: number;
  /** 0 = very soft, 1 = crisp at the source's native resolution */
  sharp: number;
  /** sensor noise std-dev in luminance units (≈ 0..0.12) */
  noise: number;
  nativeW: number;
  nativeH: number;
  /** video / animated canvas (vs a still JPEG) */
  animated: boolean;
  /** JPEG still: emulate 8x8 blocking on the creature */
  jpeg: boolean;
  /** cumulative global image motion since tracking (re)started, normalized frame units */
  motionX: number;
  motionY: number;
}

export interface FilterOp {
  fn: 'grayscale' | 'contrast' | 'brightness' | 'saturate' | 'sepia' | 'invert';
  v: number;
}

/** Parse a computed CSS `filter` value into the colour ops we can mirror (blur/drop-shadow are ignored). */
export function parseCssFilter(filter: string | null | undefined): FilterOp[] {
  const out: FilterOp[] = [];
  if (!filter || filter === 'none') return out;
  const re = /([a-z-]+)\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(filter))) {
    const fn = m[1] as FilterOp['fn'];
    if (!['grayscale', 'contrast', 'brightness', 'saturate', 'sepia', 'invert'].includes(fn)) continue;
    const raw = m[2].trim();
    let v = raw === '' ? 1 : parseFloat(raw);
    if (raw.endsWith('%')) v /= 100;
    if (Number.isFinite(v)) out.push({ fn, v });
  }
  return out;
}

/** Apply mirrored CSS colour filters to one 0..1 RGB triple (in place). */
export function applyFilter(ops: FilterOp[], c: RGB): RGB {
  let [r, g, b] = c;
  for (const o of ops) {
    if (o.fn === 'grayscale' || o.fn === 'saturate') {
      const a = o.fn === 'grayscale' ? clamp(o.v) : 1 - o.v;
      const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = r + (L - r) * a;
      g = g + (L - g) * a;
      b = b + (L - b) * a;
    } else if (o.fn === 'contrast') {
      r = (r - 0.5) * o.v + 0.5;
      g = (g - 0.5) * o.v + 0.5;
      b = (b - 0.5) * o.v + 0.5;
    } else if (o.fn === 'brightness') {
      r *= o.v;
      g *= o.v;
      b *= o.v;
    } else if (o.fn === 'invert') {
      const a = clamp(o.v);
      r = r + (1 - 2 * r) * a;
      g = g + (1 - 2 * g) * a;
      b = b + (1 - 2 * b) * a;
    } else if (o.fn === 'sepia') {
      const a = clamp(o.v);
      const sr = 0.393 * r + 0.769 * g + 0.189 * b;
      const sg = 0.349 * r + 0.686 * g + 0.168 * b;
      const sb = 0.272 * r + 0.534 * g + 0.131 * b;
      r = r + (sr - r) * a;
      g = g + (sg - g) * a;
      b = b + (sb - b) * a;
    }
    r = clamp(r);
    g = clamp(g);
    b = clamp(b);
  }
  c[0] = r;
  c[1] = g;
  c[2] = b;
  return c;
}

/** Approximate percentiles of values in [0, max] with a fixed histogram (O(n), no sorting). */
function percentiles(a: Float32Array, n: number, max: number, qs: number[]): number[] {
  const BINS = 512;
  const hist = new Uint32Array(BINS);
  const k = (BINS - 1) / max;
  for (let i = 0; i < n; i++) hist[Math.min(BINS - 1, Math.max(0, (a[i] * k) | 0))]++;
  const out: number[] = [];
  for (const q of qs) {
    const target = q * n;
    let acc = 0;
    let b = 0;
    for (; b < BINS; b++) {
      acc += hist[b];
      if (acc >= target) break;
    }
    out.push((b + 0.5) / k);
  }
  return out;
}

/** analysis width: native for 320 px stills (sharpness needs native pixels), half-ish for 655 px video */
const GRID_W = 320;

/** Solar elevation (degrees) at a lat/lon for an epoch time (NOAA approximation, ±0.5°). Bay Area by default. */
export function sunElevationDeg(epochMs: number, lat = 37.8, lon = -122.3): number {
  const d = new Date(epochMs);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const doy = (epochMs - start) / 86400000;
  const hrs = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
  const g = ((2 * Math.PI) / 365) * (doy - 1 + (hrs - 12) / 24);
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const tst = hrs * 60 + eqt + 4 * lon; // true solar time, minutes
  const ha = ((tst / 4 - 180) * Math.PI) / 180;
  const la = (lat * Math.PI) / 180;
  const cosZ = Math.sin(la) * Math.sin(decl) + Math.cos(la) * Math.cos(decl) * Math.cos(ha);
  return 90 - (Math.acos(clamp(cosZ, -1, 1)) * 180) / Math.PI;
}
const GRID_W_VIDEO = 160;
const MOTION_W = 80;
/** Probes across ALL overlays are spaced at least this far apart, so 13 feeds never sample in the same frame. */
const PROBE_SPACING_MS = 6;
let lastProbeAt = -1e9;

/** Global-motion estimate between two coarse luminance frames: integer SAD search ±R + parabolic sub-pixel fit. */
export function estimateShift(prev: Float32Array, cur: Float32Array, w: number, h: number, R = 2): [number, number] {
  const m = R + 1;
  const sad = (dx: number, dy: number) => {
    let s = 0;
    let n = 0;
    for (let y = m; y < h - m; y += 1) {
      const row = y * w;
      const row2 = (y + dy) * w;
      for (let x = m; x < w - m; x += 1) {
        s += Math.abs(cur[row + x] - prev[row2 + x + dx]);
        n++;
      }
    }
    return n ? s / n : 0;
  };
  let best = Infinity;
  let bx = 0;
  let by = 0;
  const grid: number[][] = [];
  for (let dy = -R; dy <= R; dy++) {
    const rowv: number[] = [];
    for (let dx = -R; dx <= R; dx++) {
      const v = sad(dx, dy);
      rowv.push(v);
      if (v < best) {
        best = v;
        bx = dx;
        by = dy;
      }
    }
    grid.push(rowv);
  }
  const at = (dx: number, dy: number) => grid[dy + R]?.[dx + R];
  const sub = (a: number | undefined, c: number, b: number | undefined) => {
    if (a === undefined || b === undefined) return 0;
    const d = a - 2 * c + b;
    return d > 1e-6 ? clamp((a - b) / (2 * d), -0.5, 0.5) : 0;
  };
  // the content moved by +shift when cur(x) ≈ prev(x + dx), i.e. shift = -dx
  return [-(bx + sub(at(bx - 1, by), best, at(bx + 1, by))), -(by + sub(at(bx, by - 1), best, at(bx, by + 1)))];
}

/** Samples one source element; owned by an OverlayRenderer. */
export class SceneProber {
  probe: SceneProbe | null = null;
  readable = true;
  private canvas: HTMLCanvasElement | null = null;
  private at = -1e9;
  private key = '';
  private filterOps: FilterOp[] = [];
  private filterEl: Element | null = null;
  private prevMotion: Float32Array | null = null;
  private motionX = 0;
  private motionY = 0;
  private version = 0;

  reset(): void {
    this.probe = null;
    this.readable = true;
    this.at = -1e9;
    this.key = '';
    this.filterEl = null;
    this.prevMotion = null;
    this.motionX = 0;
    this.motionY = 0;
  }

  /** Forget accumulated motion (no manifestation on screen). */
  resetMotion(): void {
    this.motionX = 0;
    this.motionY = 0;
    if (this.probe) {
      this.probe.motionX = 0;
      this.probe.motionY = 0;
    }
  }

  /**
   * Re-sample if due. `active` = a manifestation is (about to be) drawn: video is then sampled at ~5 Hz for
   * motion and light changes; otherwise every few seconds, and stills only when their frame changes.
   */
  /**
   * `daylight`: 0..1 if known for this picture (sun position at capture time, or a lab hint), else null. Caltrans
   * night frames are gain-boosted and floodlit roads look bright, so the image alone cannot tell day from night.
   */
  daylight: number | null = null;

  update(el: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement, nativeW: number, nativeH: number, perf: number, active: boolean): SceneProbe | null {
    if (!this.readable || !nativeW || !nativeH) return this.probe;
    const animated = !(el instanceof HTMLImageElement);
    const key = el instanceof HTMLImageElement ? el.currentSrc || el.src : '';
    const every = animated ? (active ? 200 : 2500) : active ? 4000 : 15000;
    if (this.probe && key === this.key && perf - this.at < every) return this.probe;
    const now = typeof performance !== 'undefined' ? performance.now() : perf;
    if (now - lastProbeAt < PROBE_SPACING_MS && now >= lastProbeAt) return this.probe;
    lastProbeAt = now;
    this.at = perf;
    if (el !== this.filterEl) {
      this.filterEl = el;
      try {
        this.filterOps = parseCssFilter(getComputedStyle(el).filter);
      } catch {
        this.filterOps = [];
      }
      this.prevMotion = null;
      this.motionX = this.motionY = 0;
    }
    const gw = Math.min(animated ? GRID_W_VIDEO : GRID_W, nativeW);
    const gh = Math.max(8, Math.round((gw * nativeH) / nativeW));
    try {
      this.canvas ??= makeCanvas(gw, gh);
      if (this.canvas.width !== gw || this.canvas.height !== gh) {
        this.canvas.width = gw;
        this.canvas.height = gh;
      }
      const x = ctx2d(this.canvas, { willReadFrequently: true });
      x.imageSmoothingEnabled = true;
      x.imageSmoothingQuality = 'medium';
      x.drawImage(el, 0, 0, gw, gh);
      const d = x.getImageData(0, 0, gw, gh).data;
      this.key = key;
      this.probe = this.analyse(d, gw, gh, nativeW, nativeH, animated, !animated);
    } catch {
      // tainted canvas (no CORS) or not decodable yet
      if (!this.probe) this.readable = false;
      this.canvas = null;
    }
    return this.probe;
  }

  private analyse(d: Uint8ClampedArray, w: number, h: number, nativeW: number, nativeH: number, animated: boolean, jpeg: boolean): SceneProbe {
    const n = w * h;
    const rgb = new Float32Array(n * 3);
    const lum = new Float32Array(n);
    const c: RGB = [0, 0, 0];
    const ops = this.filterOps;
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let sl = 0;
    // ignore the burned-in timestamp bar (bottom ~9%) of Caltrans stills for the global statistics
    const statRows = Math.floor(h * 0.9);
    for (let i = 0; i < n; i++) {
      c[0] = d[i * 4] / 255;
      c[1] = d[i * 4 + 1] / 255;
      c[2] = d[i * 4 + 2] / 255;
      if (ops.length) applyFilter(ops, c);
      rgb[i * 3] = c[0];
      rgb[i * 3 + 1] = c[1];
      rgb[i * 3 + 2] = c[2];
      const L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      lum[i] = L;
      if (i < statRows * w) {
        sr += c[0];
        sg += c[1];
        sb += c[2];
        sl += L;
      }
    }
    const ns = Math.max(1, statRows * w);
    const [p05, p50, p95] = percentiles(lum, statRows * w, 1, [0.05, 0.5, 0.95]);
    const mean = sl / ns;

    // sharpness: on strong edges, a 1-px step vs. half a 2-px step (1 = edges are one pixel wide, 0.5 = smeared);
    // rows 15-90% only, so burned-in OSD text and the timestamp bar do not count as scene detail
    const r0 = Math.floor(h * 0.15);
    const d1 = new Float32Array(w * (statRows - r0));
    const d2 = new Float32Array(w * (statRows - r0));
    let m1 = 0;
    for (let y = r0; y < statRows; y++)
      for (let x = 1; x < w - 2; x++) {
        const i = y * w + x;
        const a1 = Math.abs(lum[i + 1] - lum[i]);
        const a2 = Math.abs(lum[i + 2] - lum[i]) * 0.5;
        // only edges strong enough to be structure, not noise
        if (Math.abs(lum[i + 2] - lum[i - 1]) > 0.12) {
          d1[m1] = a1;
          d2[m1] = a2;
          m1++;
        }
      }
    let sharp = 0.6;
    if (m1 > 50) {
      let s1 = 0;
      let s2 = 0;
      for (let i = 0; i < m1; i++) {
        s1 += d1[i];
        s2 += d2[i];
      }
      const ratio = s2 > 1e-5 ? s1 / s2 : 1;
      // ratio ≈ 2 for one-pixel steps, ≈ 1 for edges smeared over 3+ px
      sharp = clamp((ratio - 1.05) / 0.6);
    }
    const lap = new Float32Array((w - 2) * (statRows - 2));
    let k = 0;
    for (let y = 1; y < statRows - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        lap[k++] = Math.abs(4 * lum[i] - lum[i - 1] - lum[i + 1] - lum[i - w] - lum[i + w]);
      }
    // analysis grid averages native pixels together; scale back to native-pixel noise
    const down = Math.max(1, nativeW / w);
    const noise = clamp((percentiles(lap, k, 1, [0.5])[0] / 3) * Math.sqrt(down), 0, 0.12);

    // day needs a bright picture AND a bright upper frame (sky / distance): a floodlit road under a black sky is night
    let top = 0;
    const topRows = Math.max(1, Math.floor(h * 0.4));
    for (let i = 0; i < topRows * w; i++) top += lum[i];
    top /= topRows * w;
    const imageDay = smoothstep(0.13, 0.3, p50) * smoothstep(0.12, 0.28, top);
    // when the light at capture time is known it decides; a dark picture by day still reads as night (tunnel, dusk)
    const dayness = this.daylight === null ? imageDay : Math.min(this.daylight, smoothstep(0.07, 0.2, p50));
    const contrast = p95 - p05;
    const fog = smoothstep(0.55, 0.22, contrast) * smoothstep(0.22, 0.42, mean);

    // global motion (video only), on a coarse luminance copy
    if (animated) {
      const mw = MOTION_W;
      const mh = Math.max(8, Math.round((h * MOTION_W) / w));
      const cur = new Float32Array(mw * mh);
      const sx = w / mw;
      const sy = h / mh;
      for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) cur[y * mw + x] = lum[Math.floor(y * sy) * w + Math.floor(x * sx)];
      if (this.prevMotion && this.prevMotion.length === cur.length) {
        const [dx, dy] = estimateShift(this.prevMotion, cur, mw, mh);
        // sub-noise shifts are compression shimmer, not motion; big jumps are a cut / PTZ move: follow but cap
        if (Math.abs(dx) > 0.15 || Math.abs(dy) > 0.15) {
          this.motionX = clamp(this.motionX + dx / mw, -0.25, 0.25);
          this.motionY = clamp(this.motionY + dy / mh, -0.25, 0.25);
        }
      }
      this.prevMotion = cur;
    }

    return {
      version: ++this.version,
      w,
      h,
      rgb,
      lum,
      mean,
      p05,
      p50,
      p95,
      meanRGB: [sr / ns, sg / ns, sb / ns],
      dayness,
      fog,
      sharp,
      noise,
      nativeW,
      nativeH,
      animated,
      jpeg,
      motionX: this.motionX,
      motionY: this.motionY,
    };
  }
}

export interface RegionLight {
  /** mean displayed colour around the spot */
  ambient: RGB;
  ambientLum: number;
  /** dark level (≈10th percentile luminance) around the spot */
  black: number;
  /** bright level (≈90th percentile) */
  bright: number;
}

const NEUTRAL: RegionLight = { ambient: [0.32, 0.33, 0.34], ambientLum: 0.33, black: 0.08, bright: 0.6 };
const regionCache = new WeakMap<SceneProbe, Map<string, RegionLight>>();

/** Light around a normalized image rect (cached per probe version). */
export function regionLight(p: SceneProbe | null | undefined, x0: number, y0: number, x1: number, y1: number): RegionLight {
  if (!p) return NEUTRAL;
  const q = (v: number) => Math.round(clamp(v) * 48);
  const key = `${q(x0)},${q(y0)},${q(x1)},${q(y1)}`;
  let m = regionCache.get(p);
  if (!m) {
    m = new Map();
    regionCache.set(p, m);
  }
  const hit = m.get(key);
  if (hit) return hit;
  const gx0 = Math.max(0, Math.floor(clamp(x0) * p.w));
  const gx1 = Math.min(p.w, Math.max(gx0 + 1, Math.ceil(clamp(x1) * p.w)));
  // stay out of the timestamp bar
  const gy0 = Math.max(0, Math.floor(clamp(y0) * p.h));
  const gy1 = Math.min(Math.floor(p.h * 0.9), Math.max(gy0 + 1, Math.ceil(clamp(y1) * p.h)));
  const vals: number[] = [];
  let r = 0;
  let g = 0;
  let b = 0;
  for (let y = gy0; y < gy1; y++)
    for (let x = gx0; x < gx1; x++) {
      const i = y * p.w + x;
      r += p.rgb[i * 3];
      g += p.rgb[i * 3 + 1];
      b += p.rgb[i * 3 + 2];
      vals.push(p.lum[i]);
    }
  let out: RegionLight;
  if (!vals.length) out = NEUTRAL;
  else {
    vals.sort((a, c) => a - c);
    const nn = vals.length;
    const amb: RGB = [r / nn, g / nn, b / nn];
    out = {
      ambient: amb,
      ambientLum: 0.2126 * amb[0] + 0.7152 * amb[1] + 0.0722 * amb[2],
      black: vals[Math.floor(nn * 0.1)],
      bright: vals[Math.floor(nn * 0.9)],
    };
  }
  if (m.size > 64) m.clear();
  m.set(key, out);
  return out;
}

export const cssRgb = (c: RGB, k = 1, a = 1) =>
  `rgba(${Math.round(clamp(c[0] * k) * 255)},${Math.round(clamp(c[1] * k) * 255)},${Math.round(clamp(c[2] * k) * 255)},${clamp(a)})`;

export interface GradeOptions {
  /** displayed size of the sprite (canvas px) */
  w: number;
  h: number;
  /** render resolution, scratch px per display px (≤ 1) */
  res: number;
  /** grain erosion (apparition instability), 0..1 */
  erosion: number;
  /** flat colour fill first (shadows: the multiplied ground colour) */
  tint?: RGB | null;
  /** clamp highlights to this colour (sprite never brighter than the local light) */
  clampTo: RGB | null;
  /** veil (scattered ambient light / haze) colour + alpha */
  veil: RGB | null;
  veilAlpha: number;
  /** scene chroma strength 0..1 (light colour + chroma subsampling) */
  chroma: number;
  chromaColor: RGB | null;
  /** matched sensor noise (grain alpha 0..1) */
  noise: number;
  /** JPEG 8x8 blocking blend 0..1 and the block size in scratch px; grid origin offset in scratch px */
  block: number;
  blockPx: number;
  blockOx: number;
  blockOy: number;
  /** fraction of the figure hidden from the feet up (foreground clutter), plus the always-on ground contact fade */
  occlude: number;
  /** seed for noise placement: frozen on stills, per video frame on live */
  noiseSeed: number;
  erosionSeed: number;
}

let gs: HTMLCanvasElement | null = null;
let gctx: CanvasRenderingContext2D | null = null;
let bs: HTMLCanvasElement | null = null;
let bctx: CanvasRenderingContext2D | null = null;
let ms: HTMLCanvasElement | null = null;
let mctx: CanvasRenderingContext2D | null = null;

function ensure(c: HTMLCanvasElement | null, w: number, h: number): HTMLCanvasElement {
  const cv = c ?? makeCanvas(Math.max(8, w), Math.max(8, h));
  if (cv.width < w || cv.height < h) {
    cv.width = Math.max(cv.width, w);
    cv.height = Math.max(cv.height, h);
  }
  return cv;
}

/**
 * Render `src` (sprite) into a shared scratch canvas at reduced resolution and grade it to the scene.
 * Returns the scratch and the used size; draw it with drawImage(c, 0, 0, sw, sh, x, y, w, h).
 */
export function gradeSprite(src: CanvasImageSource, o: GradeOptions): [HTMLCanvasElement, number, number] {
  const sw = Math.max(2, Math.ceil(o.w * o.res));
  const sh = Math.max(2, Math.ceil(o.h * o.res));
  gs = ensure(gs, sw + 2, sh + 2);
  gctx ??= ctx2d(gs);
  const x = gctx;
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.globalAlpha = 1;
  x.globalCompositeOperation = 'source-over';
  x.clearRect(0, 0, gs.width, gs.height);
  x.imageSmoothingEnabled = true;
  x.imageSmoothingQuality = 'high';
  x.drawImage(src, 0, 0, sw, sh);
  // mask copy (alpha reference) for the blend-mode passes below
  ms = ensure(ms, sw, sh);
  mctx ??= ctx2d(ms);
  mctx.setTransform(1, 0, 0, 1, 0, 0);
  mctx.globalCompositeOperation = 'copy';
  mctx.globalAlpha = 1;
  mctx.drawImage(gs, 0, 0, sw, sh, 0, 0, sw, sh);
  mctx.globalCompositeOperation = 'source-over';

  if (o.tint) {
    x.globalCompositeOperation = 'source-atop';
    x.fillStyle = cssRgb(o.tint);
    x.fillRect(0, 0, sw, sh);
  }
  let needMask = false;
  if (o.clampTo) {
    // painted highlights (eyes, sheen) can never be brighter than the light that falls here
    x.globalCompositeOperation = 'darken';
    x.fillStyle = cssRgb(o.clampTo);
    x.fillRect(0, 0, sw, sh);
    needMask = true;
  }
  if (o.chroma > 0.01 && o.chromaColor) {
    // take on the hue/saturation of the scene light (sodium orange, LED white, green grass bounce)
    x.globalCompositeOperation = 'color';
    x.globalAlpha = clamp(o.chroma);
    x.fillStyle = cssRgb(o.chromaColor);
    x.fillRect(0, 0, sw, sh);
    x.globalAlpha = 1;
    needMask = true;
  }
  if (needMask) {
    x.globalCompositeOperation = 'destination-in';
    x.drawImage(ms, 0, 0, sw, sh, 0, 0, sw, sh);
  }
  if (o.veil && o.veilAlpha > 0.01) {
    // atmospheric veil: dark things far away / in haze are lifted towards the ambient light
    x.globalCompositeOperation = 'source-atop';
    x.globalAlpha = clamp(o.veilAlpha, 0, 0.92);
    x.fillStyle = cssRgb(o.veil);
    x.fillRect(0, 0, sw, sh);
    x.globalAlpha = 1;
  }
  if (o.noise > 0.01) {
    const tiles = getGrainTiles();
    x.globalCompositeOperation = 'source-atop';
    x.globalAlpha = clamp(o.noise);
    tileFill(x, tiles[Math.abs(o.noiseSeed) % tiles.length], 0, 0, sw, sh, 1, rand01(o.noiseSeed, 3) * 190, rand01(o.noiseSeed, 4) * 190);
    x.globalAlpha = 1;
  }
  if (o.block > 0.01 && o.blockPx >= 2) {
    // JPEG: 8x8 DCT blocks flatten fine detail; align the block grid with the image's own grid
    const bp = o.blockPx;
    const bw = Math.ceil((sw + o.blockOx) / bp) + 1;
    const bh = Math.ceil((sh + o.blockOy) / bp) + 1;
    bs = ensure(bs, bw, bh);
    bctx ??= ctx2d(bs);
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.globalCompositeOperation = 'source-over';
    bctx.clearRect(0, 0, bs.width, bs.height);
    bctx.imageSmoothingEnabled = true;
    bctx.imageSmoothingQuality = 'medium';
    bctx.drawImage(gs, 0, 0, sw, sh, o.blockOx / bp, o.blockOy / bp, sw / bp, sh / bp);
    x.globalCompositeOperation = 'source-atop';
    x.globalAlpha = clamp(o.block);
    x.imageSmoothingEnabled = false;
    x.drawImage(bs, 0, 0, bw, bh, -o.blockOx, -o.blockOy, bw * bp, bh * bp);
    x.imageSmoothingEnabled = true;
    x.globalAlpha = 1;
  }
  if (o.erosion > 0.01) {
    const tiles = getGrainTiles();
    x.globalCompositeOperation = 'destination-out';
    x.globalAlpha = clamp(o.erosion);
    tileFill(x, tiles[Math.abs(o.erosionSeed) % tiles.length], 0, 0, sw, sh, 1 + (Math.abs(o.erosionSeed) % 2), rand01(o.erosionSeed, 7) * 300, rand01(o.erosionSeed, 11) * 300);
    x.globalAlpha = 1;
  }
  // feet sink into the ground texture; clutter (shrubs / guardrail) hides more where the placement says so
  const occ = clamp(o.occlude, 0, 0.6);
  const hide = Math.max(0.03, occ); // fraction of height removed at the bottom
  const ramp = 0.03 + occ * 0.2; // soft edge above it
  const y0 = sh * (1 - hide - ramp);
  const y1 = sh * (1 - hide);
  const g = x.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, `rgba(0,0,0,${occ > 0 ? 1 : 0.6})`);
  x.globalCompositeOperation = 'destination-out';
  x.fillStyle = g;
  x.fillRect(0, y0, sw, sh - y0 + 1);
  x.globalCompositeOperation = 'source-over';
  return [gs, sw, sh];
}

/** Derived grading for a creature standing at a spot, from the scene probe. */
export interface SpotGrade {
  light: RegionLight;
  dayness: number;
  fog: number;
  /** scratch px per display px for the figure */
  res: number;
  clampTo: RGB;
  veil: RGB;
  veilAlpha: number;
  chroma: number;
  noise: number;
  block: number;
  blockPx: number;
  blockOx: number;
  blockOy: number;
  /** ground colour of a cast / contact shadow (multiplied ground) */
  shadowColor: RGB;
}

/**
 * Grade for a figure whose display rect is (x, y, w, h) inside `frame`, with feet at (fx, fy). `scale` is the
 * placement scale (small = far away = more haze). Works without a probe (neutral, legacy-looking defaults).
 */
export function spotGrade(
  p: SceneProbe | null | undefined,
  frame: { x: number; y: number; w: number; h: number },
  fx: number,
  fy: number,
  w: number,
  h: number,
  scale: number,
  sim: boolean,
  /** manifestation strength: a clearer sighting keeps more contrast against its surroundings */
  strength = 0.6,
): SpotGrade {
  const nx = (v: number) => (v - frame.x) / Math.max(1, frame.w);
  const ny = (v: number) => (v - frame.y) / Math.max(1, frame.h);
  const light = regionLight(p, nx(fx - w * 0.9), ny(fy - h * 0.85), nx(fx + w * 0.9), ny(fy + h * 0.12));
  const dayness = p ? p.dayness : 0.5;
  const fog = p ? p.fog : 0;
  // resolution: never more detail than the camera resolved at that spot
  const nativePerDisplay = p ? p.nativeH / Math.max(1, frame.h) : 0.7;
  const sharp = p ? p.sharp : 0.7;
  const res = clamp(nativePerDisplay * lerp(0.6, 1.0, sharp), 0.12, sim ? 0.85 : 1);
  const amb = light.ambient;
  const aL = Math.max(0.02, light.ambientLum);
  // the darkest a dark object can look here is the scene's own black level (flare, haze, AGC)
  const far = smoothstep(0.16, 0.05, scale);
  // (flare + haze set a floor for the whole picture: use the scene's own black point, not the local shadows)
  const blackPoint = p ? p.p05 : light.black;
  // at night it is darker than the dark around it (it reflects nothing): a void against lit asphalt
  const veilAlpha = clamp((blackPoint / aL) * lerp(0.35, 0.62, dayness) + fog * 0.3 + far * 0.15 * (0.4 + 0.6 * dayness), 0, 0.75);
  // ...but never so much that a clear sighting dissolves into the dark ground around it (the sprite body is ~0.07)
  const minContrast = lerp(0.15, 0.42, clamp(strength));
  const veilCap = aL > 0.09 ? clamp((aL * (1 - minContrast) - 0.07) / (aL - 0.07)) : 0;
  // highlights: by day painted eye-shine / sheen must not glow; at night allow a little rim under lights
  const k = lerp(1.15, 0.78, dayness);
  const clampTo: RGB = [amb[0] * k, amb[1] * k, amb[2] * k];
  const sat = Math.max(amb[0], amb[1], amb[2]) - Math.min(amb[0], amb[1], amb[2]);
  const chroma = clamp(0.2 + sat * 1.5, 0, 0.6);
  const noise = p ? clamp(p.noise * 2.2, 0, 0.3) : 0.06;
  let block = 0;
  let blockPx = 0;
  let blockOx = 0;
  let blockOy = 0;
  if (p && p.jpeg) {
    block = clamp(0.32 - 0.1 * sharp + 0.12 * (1 - dayness), 0.15, 0.45);
    // 8 native px in scratch px
    blockPx = (8 * res * frame.h) / p.nativeH;
    const xN = (nx(fx - w / 2) * p.nativeW) % 8;
    const yN = (ny(fy - h) * p.nativeH) % 8;
    blockOx = (((xN + 8) % 8) * res * frame.w) / p.nativeW;
    blockOy = (((yN + 8) % 8) * res * frame.h) / p.nativeH;
  }
  const shadowColor: RGB = [amb[0] * 0.3, amb[1] * 0.3, amb[2] * 0.3];
  return { light, dayness, fog, res, clampTo, veil: amb, veilAlpha: Math.min(veilAlpha, veilCap), chroma, noise, block, blockPx, blockOx, blockOy, shadowColor };
}
