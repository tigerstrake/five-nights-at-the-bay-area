// Composites a MonsterManifestation into a feed overlay. Pure function of (manifestation, time,
// placement) except for per-frame grain/erosion randomness, so every client sees the same
// appearance at the same moment.
//
// On real footage the creature is graded to the spot it stands on (see ./grade.ts): rendered at the camera's own
// resolution, highlights clamped to the local light, lifted by haze/flare to the scene's black level, tinted by the
// scene's light colour, given the source's noise and (stills) JPEG blocking, grounded by a contact shadow in the
// multiplied ground colour, and sunk into foreground clutter. By day it is a dark, still shape; eye-shine only at night.
import type { MonsterManifestation, PlacementRegion } from '../index';
import { ctx2d, getGrainTiles, getSnowTiles, makeCanvas, tileFill } from '../core/noise';
import { clamp, gauss, mulberry32, rand01, range, smoothstep } from '../core/rng';
import { CREATURE_SEED, getFaceSprite, getFigureSprite, type EyePoint } from './creature';
import { cssRgb, gradeSprite, regionLight, spotGrade, type RGB, type SceneProbe, type SpotGrade } from './grade';
import { spriteFor } from './sprites';

export interface FrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ManifestDrawContext {
  base: CanvasRenderingContext2D;
  add: CanvasRenderingContext2D;
  frame: FrameRect;
  /** epoch ms, same clock as manifestation.startedAt */
  now: number;
  reduced: boolean;
  /** canvas px per CSS px-ish scale used to size jitter */
  px: number;
  frameIndex: number;
  /** mean scene luminance 0..1 if the source is readable (CORS / same-origin), else ~0.3 */
  sceneLum: number;
  /** sampled scene under the overlay (null when unreadable / not sampled yet → neutral grading) */
  scene?: SceneProbe | null;
  /** advances only when the source picture changes (video frame / sim frame); constant on stills */
  mediaFrame?: number;
  /** visible overlay area (canvas px); feet are kept inside it when the source is cropped (object-fit: cover) */
  visible?: FrameRect;
  /** simulated feed underneath (keeps its crisper, stylised look) */
  sim?: boolean;
  /**
   * Real Caltrans HLS video underneath. Placement boxes are measured on the 320x260 stills, which are the video frame
   * squeezed into the top STILL_PICTURE_H of the JPEG with the timestamp bar added below, so they are remapped.
   */
  video?: boolean;
}

/** Fraction of a Caltrans still's height that is picture (the rest is the burned-in timestamp bar). */
export const STILL_PICTURE_H = 0.923;

/** Placement box measured on a still, expressed in the matching live-video frame. */
export function stillToVideo(r: PlacementRegion): PlacementRegion {
  const k = 1 / STILL_PICTURE_H;
  return { ...r, y: r.y * k, h: Math.min(r.h * k, Math.max(0.01, 0.985 - r.y * k)), scale: r.scale * k };
}

export interface ManifestResult {
  /** extra interference to apply to the whole feed (0..1) */
  boost: number;
  /** horizontal bands (canvas px) that should tear this frame */
  tears: Array<[number, number]>;
  active: boolean;
}

/** Used when a camera has no placement regions. Boxes are where the FEET land (camera-research convention). */
export const DEFAULT_PLACEMENT: PlacementRegion = { x: 0.56, y: 0.66, w: 0.22, h: 0.12, scale: 0.2 };

const NONE: ManifestResult = { boost: 0, tears: [], active: false };


let scratch: HTMLCanvasElement | null = null;
let sctx: CanvasRenderingContext2D | null = null;
function getScratch(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  if (!scratch) {
    scratch = makeCanvas(256, 512);
    sctx = ctx2d(scratch);
  }
  const W = Math.ceil(w);
  const H = Math.ceil(h);
  if (scratch.width < W || scratch.height < H) {
    scratch.width = Math.max(scratch.width, W);
    scratch.height = Math.max(scratch.height, H);
  }
  sctx!.setTransform(1, 0, 0, 1, 0, 0);
  sctx!.globalCompositeOperation = 'source-over';
  sctx!.globalAlpha = 1;
  sctx!.clearRect(0, 0, W + 2, H + 2);
  return [scratch, sctx!];
}

const tintCache = new WeakMap<HTMLCanvasElement | HTMLImageElement, { r: HTMLCanvasElement; c: HTMLCanvasElement }>();
export function tinted(src: HTMLCanvasElement | HTMLImageElement) {
  let t = tintCache.get(src);
  if (t) return t;
  const w = src instanceof HTMLImageElement ? src.naturalWidth : src.width;
  const h = src instanceof HTMLImageElement ? src.naturalHeight : src.height;
  const mk = (col: string) => {
    const c = makeCanvas(w, h);
    const x = ctx2d(c);
    x.drawImage(src, 0, 0);
    x.globalCompositeOperation = 'multiply';
    x.fillStyle = col;
    x.fillRect(0, 0, w, h);
    x.globalCompositeOperation = 'destination-in';
    x.drawImage(src, 0, 0);
    return c;
  };
  t = { r: mk('#ff2a1a'), c: mk('#00d8ff') };
  tintCache.set(src, t);
  return t;
}

/** Render `src` scaled into the scratch buffer at reduced resolution, eroded by grain. */
function prepare(
  src: CanvasImageSource,
  w: number,
  h: number,
  softness: number,
  erosion: number,
  frameIndex: number,
): [HTMLCanvasElement, number, number] {
  const sw = Math.max(2, Math.ceil(w * softness));
  const sh = Math.max(2, Math.ceil(h * softness));
  const [c, x] = getScratch(sw, sh);
  x.imageSmoothingEnabled = true;
  x.imageSmoothingQuality = 'high';
  x.drawImage(src, 0, 0, sw, sh);
  if (erosion > 0.01) {
    const tiles = getGrainTiles();
    x.globalCompositeOperation = 'destination-out';
    x.globalAlpha = clamp(erosion);
    const t = tiles[frameIndex % tiles.length];
    tileFill(x, t, 0, 0, sw, sh, 1 + (frameIndex % 2), rand01(frameIndex, 7) * 300, rand01(frameIndex, 11) * 300);
    x.globalAlpha = 1;
    x.globalCompositeOperation = 'source-over';
  }
  return [c, sw, sh];
}

/** Draw a prepared scratch image into dst, optionally sliced into jittered horizontal bands. */
function blit(
  dst: CanvasRenderingContext2D,
  src: HTMLCanvasElement,
  sw: number,
  sh: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  bands: number,
  jitter: number,
  frameIndex: number,
  seed: number,
) {
  if (bands <= 1 || jitter < 0.25) {
    dst.drawImage(src, 0, 0, sw, sh, dx, dy, dw, dh);
    return;
  }
  for (let b = 0; b < bands; b++) {
    const y0 = (b / bands) * sh;
    const y1 = ((b + 1) / bands) * sh;
    const r = rand01(seed, frameIndex, b);
    const off = (r - 0.5) * 2 * jitter * (r > 0.92 ? 3 : 1);
    dst.drawImage(src, 0, y0, sw, y1 - y0, dx + off, dy + (y0 / sh) * dh, dw, ((y1 - y0) / sh) * dh + 0.5);
  }
}

let halo: HTMLCanvasElement | null = null;
/** Local signal disturbance around the creature: radially-masked static on the additive layer. */
function staticHalo(add: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, alpha: number, frameIndex: number) {
  if (alpha <= 0.01) return;
  const w = Math.max(4, Math.ceil(rx * 2));
  const h = Math.max(4, Math.ceil(ry * 2));
  halo ??= makeCanvas(w, h);
  if (halo.width < w || halo.height < h) {
    halo.width = Math.max(halo.width, w);
    halo.height = Math.max(halo.height, h);
  }
  const x = ctx2d(halo);
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.globalCompositeOperation = 'copy';
  x.globalAlpha = 1;
  const tiles = getSnowTiles();
  x.drawImage(tiles[frameIndex % tiles.length], rand01(frameIndex, 81) * 120, rand01(frameIndex, 82) * 80, w, h, 0, 0, w, h);
  x.globalCompositeOperation = 'destination-in';
  x.translate(w / 2, h / 2);
  x.scale(1, h / w);
  const g = x.createRadialGradient(0, 0, 0, 0, 0, w / 2);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(0.55, 'rgba(0,0,0,0.6)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g;
  x.fillRect(-w / 2, -w / 2, w, w);
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.globalCompositeOperation = 'source-over';
  add.globalAlpha = clamp(alpha);
  add.drawImage(halo, 0, 0, w, h, cx - w / 2, cy - h / 2, w, h);
  add.globalAlpha = 1;
}

function eyeGlow(add: CanvasRenderingContext2D, x: number, y: number, r: number, alpha: number, bloom: number, tint: RGB = [0.86, 0.92, 0.88]) {
  if (alpha <= 0.01) return;
  const core = Math.max(0.7, r);
  const [cr, cg, cb] = tint.map((v) => Math.round(clamp(v) * 255));
  const g = add.createRadialGradient(x, y, 0, x, y, core * 2.2);
  g.addColorStop(0, `rgba(${Math.min(255, cr + 30)},${Math.min(255, cg + 30)},${Math.min(255, cb + 30)},${clamp(alpha)})`);
  g.addColorStop(0.45, `rgba(${cr},${cg},${cb},${clamp(alpha * 0.55)})`);
  g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
  add.fillStyle = g;
  add.fillRect(x - core * 2.2, y - core * 2.2, core * 4.4, core * 4.4);
  if (bloom > 0) {
    const R = core * bloom;
    const b = add.createRadialGradient(x, y, 0, x, y, R);
    b.addColorStop(0, `rgba(${cr},${cg},${cb},${clamp(alpha * 0.3)})`);
    b.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
    add.fillStyle = b;
    add.fillRect(x - R, y - R, R * 2, R * 2);
  }
}

/** Eye-shine reflects the light that hits it: tapetum green-white, pulled toward the scene's light colour. */
function eyeTint(G: SpotGrade | null): RGB {
  const base: RGB = [0.8, 0.9, 0.82];
  if (!G) return base;
  const a = G.light.ambient;
  const m = Math.max(0.05, a[0], a[1], a[2]);
  return [base[0] * 0.6 + (a[0] / m) * 0.4, base[1] * 0.6 + (a[1] / m) * 0.4, base[2] * 0.6 + (a[2] / m) * 0.4];
}

interface Layout {
  footX: number;
  footY: number;
  figH: number;
  r: PlacementRegion;
}

function layoutFor(m: MonsterManifestation, placement: PlacementRegion[], f: FrameRect, dc?: ManifestDrawContext): Layout {
  const list = placement.length ? placement : [DEFAULT_PLACEMENT];
  const n = list.length;
  const r0 = list[(((m.regionIndex | 0) % n) + n) % n];
  const r = dc?.video ? stillToVideo(r0) : r0;
  const rng = mulberry32(m.seed ^ 0x9137);
  // the box is the ground area where the feet land
  let ux = range(rng, 0.15, 0.85);
  let uy = range(rng, 0.25, 1.0);
  const figH = clamp(r.scale, 0.03, 0.95) * f.h * range(rng, 0.94, 1.06);
  // A cropped source (object-fit: cover in a wider tile) can hide part of the box: keep the feet on screen,
  // inside the visible part of the box when there is one.
  const v = dc?.visible;
  if (v) {
    const bx0 = f.x + r.x * f.w;
    const bw = r.w * f.w;
    const by0 = f.y + r.y * f.h;
    const bh = r.h * f.h;
    const vx0 = v.x + v.w * 0.03;
    const vx1 = v.x + v.w * 0.97;
    const vy1 = v.y + v.h * 0.97;
    if (bw > 0) ux = clamp(ux, clamp((vx0 - bx0) / bw), clamp((vx1 - bx0) / bw));
    if (bh > 0 && by0 + bh * uy > vy1) uy = clamp((vy1 - by0) / bh, 0, 1);
  }
  let footX = f.x + (r.x + r.w * ux) * f.w;
  let footY = f.y + (r.y + r.h * uy) * f.h;
  if (v) {
    footY = Math.min(footY, v.y + v.h * 0.97);
    footX = clamp(footX, v.x + v.w * 0.02, v.x + v.w * 0.98);
  }
  // follow the picture when the camera moves (live video: sway, PTZ drift)
  const sc = dc?.scene;
  if (sc && sc.animated) {
    footX += sc.motionX * f.w;
    footY += sc.motionY * f.h;
  }
  return { footX, footY, figH, r };
}

/** Deterministic silhouette flash schedule: [startMs, lengthMs][] */
export function silhouetteFlashes(m: MonsterManifestation): Array<[number, number]> {
  const rng = mulberry32(m.seed ^ 0x5111);
  const s = clamp(m.strength);
  const count = Math.max(1, Math.round(2 + s * 4));
  const out: Array<[number, number]> = [];
  const span = m.durationMs * 0.84;
  const minGap = 380;
  for (let i = 0; i < count; i++) {
    const base = m.durationMs * 0.08 + (span * (i + range(rng, 0.15, 0.85))) / count;
    const frames = 1 + Math.floor(rng() * (2 + s));
    const len = Math.min(3, frames) * 70;
    const prev = out[out.length - 1];
    if (prev && base - (prev[0] + prev[1]) < minGap) continue;
    out.push([base, len]);
  }
  return out;
}

function figureSprites(m: MonsterManifestation) {
  return {
    a: getFigureSprite(CREATURE_SEED + (m.seed & 3), 0),
    b: getFigureSprite(CREATURE_SEED + (m.seed & 3), 1),
  };
}

function drawEyes(add: CanvasRenderingContext2D, eyes: EyePoint[], x: number, y: number, w: number, h: number, alpha: number, bloom: number, now: number, seed: number, tint?: RGB, minR = 1.3) {
  eyes.forEach((e, i) => {
    // slow, smooth shimmer (well under 3 Hz); never a hard on/off
    const flick = 0.82 + 0.18 * Math.sin(now / 370 + seed * 0.7 + i * 1.9) * Math.sin(now / 910 + i);
    eyeGlow(add, x + e.x * w, y + e.y * h, Math.max(minR, e.r * h * 2), alpha * flick, bloom, tint);
  });
}

/** Per-frame seeds: sensor noise follows the picture (frozen on stills, per frame on video). */
function seeds(m: MonsterManifestation, dc: ManifestDrawContext) {
  const mf = dc.mediaFrame ?? dc.frameIndex;
  return { noiseSeed: (m.seed ^ (mf * 2654435761)) >>> 0, erosionSeed: dc.frameIndex };
}

/** Sub-pixel shimmer locked to new video frames (compression / sensor), in canvas px. */
function frameShimmer(m: MonsterManifestation, dc: ManifestDrawContext, f: FrameRect): [number, number] {
  const sc = dc.scene;
  if (!sc || !sc.animated || dc.reduced) return [0, 0];
  const mf = dc.mediaFrame ?? 0;
  const k = (0.35 * f.h) / Math.max(1, sc.nativeH);
  return [(rand01(m.seed, mf, 71) - 0.5) * k, (rand01(m.seed, mf, 72) - 0.5) * k];
}

function grade(dc: ManifestDrawContext, L: Layout, w: number, h: number, s: number): SpotGrade {
  return spotGrade(dc.scene, dc.frame, L.footX, L.footY, w, h, L.r.scale, !!dc.sim, s);
}

export function drawManifestation(
  m: MonsterManifestation | null,
  placement: PlacementRegion[],
  dc: ManifestDrawContext,
): ManifestResult {
  if (!m) return NONE;
  const t = dc.now - m.startedAt;
  if (t < 0 || t > m.durationMs || m.durationMs <= 0) return NONE;
  const p = t / m.durationMs;
  const s = clamp(m.strength);
  switch (m.kind) {
    case 'shadow':
      return drawShadow(m, p, s, placement, dc);
    case 'silhouette':
      return drawSilhouette(m, t, s, placement, dc);
    case 'figure':
      return drawFigure(m, t, p, s, placement, dc);
    case 'closeup':
      return drawCloseup(m, t, p, s, dc);
    default:
      return NONE;
  }
}

// ---------------------------------------------------------------------------------------------

function drawShadow(m: MonsterManifestation, p: number, s: number, placement: PlacementRegion[], dc: ManifestDrawContext): ManifestResult {
  const { base, frame } = dc;
  const L = layoutFor(m, placement, frame, dc);
  const env = smoothstep(0, 0.22, p) * (1 - smoothstep(0.78, 1, p));
  const rng = mulberry32(m.seed ^ 0x5ad0);
  const dir = rng() < 0.5 ? -1 : 1;
  const spr = spriteFor('shadow', m.seed);
  const fig = figureSprites(m).a;
  const src = spr ? spr.dark : fig.shadow;
  const aspect = spr ? spr.aspect : fig.aspect;
  // The shadow creeps sideways across its region while lengthening — nothing casts it.
  const crawl = (p - 0.5) * L.r.w * frame.w * 0.9 * dir;
  const fx = L.footX + crawl;
  const fy = L.footY;
  // long, low-sun shadow: stretched further than the thing that should be casting it
  const h = L.figH * (1.55 + 0.35 * p);
  const w = h * aspect * 0.8;
  const shear = dir * (0.95 + 0.25 * Math.sin(p * Math.PI)) * -1;
  const squash = 0.46 + 0.05 * Math.sin(p * Math.PI * 2 + 1);
  const G = spotGrade(dc.scene, frame, fx, fy, w * 1.4, h * squash * 1.5, L.r.scale, !!dc.sim);
  // A shadow is the ground, darker: strongest on lit ground by day, barely there on unlit asphalt at night.
  const lit = clamp(G.light.ambientLum * 2.2);
  const alpha = (0.26 + 0.4 * s) * env * (0.55 + 0.45 * lit);

  // broad darkening that drifts with it (multiplied ground colour, not black)
  const R = L.figH * 0.9;
  const g = base.createRadialGradient(fx, fy - R * 0.2, 0, fx, fy - R * 0.2, R);
  g.addColorStop(0, cssRgb(G.shadowColor, 1, (0.2 * s + 0.05) * env));
  g.addColorStop(1, cssRgb(G.shadowColor, 1, 0));
  base.fillStyle = g;
  base.fillRect(fx - R, fy - R * 1.2, R * 2, R * 2);

  const sd = seeds(m, dc);
  const [c, sw, sh] = gradeSprite(src, {
    w,
    h,
    res: Math.min(0.5, G.res),
    erosion: 0.25 + 0.2 * (1 - s),
    tint: G.shadowColor,
    clampTo: null,
    veil: null,
    veilAlpha: 0,
    chroma: 0,
    chromaColor: null,
    noise: G.noise * 0.6,
    block: G.block * 0.6,
    blockPx: G.blockPx * (Math.min(0.5, G.res) / Math.max(0.01, G.res)),
    blockOx: 0,
    blockOy: 0,
    occlude: 0,
    noiseSeed: sd.noiseSeed,
    erosionSeed: sd.erosionSeed,
  });
  base.save();
  base.globalAlpha = clamp(alpha);
  base.translate(fx, fy);
  base.transform(1, 0, shear, 1, 0, 0);
  base.scale(1, squash);
  base.drawImage(c, 0, 0, sw, sh, -w * (spr ? spr.anchorX : fig.anchorX), -h, w, h);
  base.restore();
  return { boost: 0.08 * s * env, tears: [], active: env > 0.05 };
}

function drawSilhouette(m: MonsterManifestation, t: number, s: number, placement: PlacementRegion[], dc: ManifestDrawContext): ManifestResult {
  const { base, frame } = dc;
  const L = layoutFor(m, placement, frame, dc);
  const flashes = silhouetteFlashes(m);
  let k = -1;
  let inFlash = false;
  let since = Infinity;
  for (let i = 0; i < flashes.length; i++) {
    const [st, len] = flashes[i];
    if (t >= st && t < st + len) {
      k = i;
      inFlash = true;
      since = 0;
      break;
    }
    if (t >= st + len) {
      k = i;
      since = t - (st + len);
    }
  }
  const spr = spriteFor('silhouette', m.seed);
  const fig = figureSprites(m).a;
  const src = spr ? spr.img : fig.soft;
  const aspect = spr ? spr.aspect : fig.aspect;
  const step = Math.max(0, k);
  // it gets a little closer every time it is seen
  const grow = 1 + step * 0.07;
  const drift = (rand01(m.seed, step, 3) - 0.5) * L.r.w * frame.w * 0.6;
  const h = L.figH * grow;
  const w = h * aspect;
  const x = L.footX + drift - w * 0.5;
  const y = L.footY + step * L.figH * 0.03 - h;
  const G = spotGrade(dc.scene, frame, x + w / 2, y + h, w, h, L.r.scale, !!dc.sim, s * 0.8);
  const day = G.dayness;

  let alpha: number;
  if (inFlash) alpha = 0.55 + 0.4 * s;
  else if (since < 160) alpha = (0.55 + 0.4 * s) * (dc.reduced ? 1 - since / 160 : 0.35 * (1 - since / 160));
  else alpha = 0.03 + 0.05 * s; // barely-there residue, lost under grain
  if (dc.reduced && inFlash) alpha *= 0.85;

  // the local signal disturbance is a glow-free smear by day, brighter static at night
  if (inFlash) staticHalo(dc.add, x + w / 2, y + h * 0.5, w * 1.5, h * 0.75, (0.25 + 0.35 * s) * (dc.reduced ? 0.6 : 1) * (0.35 + 0.65 * (1 - day)), dc.frameIndex);
  const sd = seeds(m, dc);
  const res = Math.min(0.45, G.res);
  const [c, sw, sh] = gradeSprite(src, {
    w,
    h,
    res,
    erosion: inFlash ? 0.35 : 0.65,
    clampTo: G.clampTo,
    veil: G.veil,
    veilAlpha: G.veilAlpha,
    chroma: G.chroma,
    chromaColor: G.light.ambient,
    noise: G.noise,
    block: G.block,
    blockPx: G.blockPx * (res / Math.max(0.01, G.res)),
    blockOx: G.blockOx * (res / Math.max(0.01, G.res)),
    blockOy: G.blockOy * (res / Math.max(0.01, G.res)),
    occlude: L.r.occlude ?? 0,
    noiseSeed: sd.noiseSeed,
    erosionSeed: sd.erosionSeed,
  });
  const [jx, jy] = frameShimmer(m, dc, frame);
  base.globalAlpha = clamp(alpha);
  const jitter = dc.reduced ? 0 : (inFlash ? 3.5 : 1.2) * dc.px;
  blit(base, c, sw, sh, x + jx, y + jy, w, h, inFlash ? 9 : 4, jitter, dc.frameIndex, m.seed);
  base.globalAlpha = 1;
  if (inFlash) {
    // the shape is negative space in its own interference
    dc.add.globalCompositeOperation = 'destination-out';
    dc.add.drawImage(c, 0, 0, sw, sh, x, y, w, h);
    dc.add.globalCompositeOperation = 'source-over';
    // at night the flash catches its eyes
    const eyes = spr ? spr.eyes : fig.eyes;
    const eyeA = 0.6 * (1 - day) * (1 - day) * smoothstep(0.2, 0.7, s);
    if (eyeA > 0.02) drawEyes(dc.add, eyes, x, y, w, h, eyeA, 4, dc.now, m.seed, eyeTint(G), Math.max(1.3, frame.h / 420));
  }
  const tears: Array<[number, number]> = [];
  if (inFlash && !dc.reduced) {
    tears.push([y + h * rand01(m.seed, dc.frameIndex, 1) * 0.6, h * 0.12]);
    tears.push([y + h * (0.5 + 0.5 * rand01(m.seed, dc.frameIndex, 2)), h * 0.06]);
  }
  return { boost: inFlash ? 0.3 + 0.25 * s : 0.06 * s, tears, active: true };
}

function drawFigure(m: MonsterManifestation, t: number, p: number, s: number, placement: PlacementRegion[], dc: ManifestDrawContext): ManifestResult {
  const { base, add, frame } = dc;
  const L = layoutFor(m, placement, frame, dc);
  const rng = mulberry32(m.seed ^ 0xf16e);
  const snapAt = range(rng, 0.42, 0.68) * m.durationMs;
  const sprites = figureSprites(m);
  const snapped = s >= 0.3 && t > snapAt;
  const fig = snapped ? sprites.b : sprites.a;
  const spr = spriteFor('figure', m.seed);
  const src = spr ? spr.img : fig.crisp;
  const aspect = spr ? spr.aspect : fig.aspect;
  const ax = spr ? spr.anchorX : fig.anchorX;
  const h = L.figH;
  const w = h * aspect;
  const [jx, jy] = frameShimmer(m, dc, frame);
  const x = L.footX - w * ax + jx;
  const y = L.footY - h + jy;
  const G = grade(dc, L, w, h, s);
  const day = G.dayness;

  const inDur = 300;
  const outDur = Math.min(260, m.durationMs * 0.12);
  const glitchIn = t < inDur;
  const glitchOut = t > m.durationMs - outDur;
  const nearSnap = snapped && t - snapAt < 140;
  let env = 1;
  if (glitchIn) {
    // resolves out of the noise in 2-frame chunks
    const fi = Math.floor(t / 70);
    env = dc.reduced ? t / inDur : (fi % 2 === 0 ? 0.25 : 0.8) * (t / inDur) + 0.15;
  } else if (glitchOut) {
    const q = (m.durationMs - t) / outDur;
    env = dc.reduced ? q : q * (Math.floor(t / 70) % 2 === 0 ? 1 : 0.45);
  }
  const clarity = 0.5 + 0.5 * s;
  const alpha = (0.7 + 0.3 * s) * env;

  // contact shadow grounds it in the scene: the ground under it, darker (soft, wider than the feet)
  const lit = clamp(G.light.ambientLum * 2.4);
  const cw = w * 0.75;
  const cg = base.createRadialGradient(L.footX, L.footY, 0, L.footX, L.footY, cw);
  cg.addColorStop(0, cssRgb(G.shadowColor, 1, (0.25 + 0.35 * lit) * alpha));
  cg.addColorStop(0.55, cssRgb(G.shadowColor, 1, (0.1 + 0.15 * lit) * alpha));
  cg.addColorStop(1, cssRgb(G.shadowColor, 1, 0));
  base.save();
  base.translate(L.footX, L.footY);
  base.scale(1, 0.14);
  base.translate(-L.footX, -L.footY);
  base.fillStyle = cg;
  base.fillRect(L.footX - cw, L.footY - cw, cw * 2, cw * 2);
  base.restore();

  const sd = seeds(m, dc);
  const occlude = L.r.occlude ?? 0;
  const common = {
    w,
    h,
    clampTo: G.clampTo,
    veil: G.veil,
    veilAlpha: G.veilAlpha,
    chroma: G.chroma,
    chromaColor: G.light.ambient,
    noise: G.noise,
    occlude,
    noiseSeed: sd.noiseSeed,
  };
  // soft halo for low-strength (less resolved) appearances; a faint smudge by day
  if (clarity < 0.98) {
    const r2 = Math.min(0.4, G.res);
    const [c2, sw2, sh2] = gradeSprite(spr ? spr.img : fig.soft, { ...common, res: r2, erosion: 0.5, block: 0, blockPx: 0, blockOx: 0, blockOy: 0, erosionSeed: sd.erosionSeed + 1 });
    base.globalAlpha = alpha * (1 - clarity) * 0.9 * (1 - 0.45 * day);
    base.drawImage(c2, 0, 0, sw2, sh2, x - w * 0.03, y - h * 0.01, w * 1.06, h * 1.01);
  }
  const res = Math.min(G.res, dc.px > 1.2 ? 0.62 : 0.8);
  const rk = res / Math.max(0.01, G.res);
  const [c, sw, sh] = gradeSprite(src, {
    ...common,
    res,
    erosion: 0.1 + (1 - clarity) * 0.55,
    block: G.block,
    blockPx: G.blockPx * rk,
    blockOx: G.blockOx * rk,
    blockOy: G.blockOy * rk,
    erosionSeed: sd.erosionSeed,
  });
  base.globalAlpha = alpha * (0.55 + 0.45 * clarity) * (spr ? 0.92 : 1);
  const jitter = dc.reduced ? 0 : glitchIn || glitchOut || nearSnap ? 5 * dc.px : 0;
  blit(base, c, sw, sh, x, y, w, h, jitter ? 10 : 1, jitter, dc.frameIndex, m.seed);
  base.globalAlpha = 1;

  // eye-shine: night only (headlights / sodium light bouncing off it); by day it is just a dark, still shape
  const night = (1 - day) * (1 - day);
  const eyeA = smoothstep(0.15, 0.6, s) * env * night;
  if (eyeA > 0.02) drawEyes(add, spr ? spr.eyes : fig.eyes, x, y, w, h, eyeA, 7, dc.now, m.seed, eyeTint(G), Math.max(1.3, frame.h / 420));
  const tears: Array<[number, number]> = [];
  if ((glitchIn || glitchOut || nearSnap) && !dc.reduced) {
    for (let i = 0; i < 3; i++) tears.push([y + h * rand01(m.seed, dc.frameIndex, i + 5), h * (0.04 + 0.1 * rand01(m.seed, dc.frameIndex, i + 9))]);
  }
  // by day it barely disturbs the signal: the horror is that the picture stays clean
  const boost = glitchIn || glitchOut || nearSnap ? 0.45 + 0.3 * s : (0.12 + 0.18 * s) * (1 - 0.4 * day);
  return { boost, tears, active: true };
}

function drawCloseup(m: MonsterManifestation, t: number, p: number, s: number, dc: ManifestDrawContext): ManifestResult {
  const { base, add, frame } = dc;
  const rng = mulberry32(m.seed ^ 0xc105e);
  const env = smoothstep(0, Math.min(0.08, 180 / m.durationMs), p) * (1 - smoothstep(0.9, 1, p));
  const spr = spriteFor('closeup', m.seed);
  const face = spr ? null : getFaceSprite(CREATURE_SEED + (m.seed & 1));
  const src = spr ? spr.img : face!.face;
  const aspect = spr ? spr.aspect : face!.aspect;
  const sc = dc.scene;
  const day = sc ? sc.dayness : 0.5;
  const light = regionLight(sc, 0, 0, 1, 1);
  // lens blocked: the frame goes dark around it (daylight still wraps round the edges)
  const blk = base.createRadialGradient(frame.x + frame.w / 2, frame.y + frame.h / 2, frame.h * 0.15, frame.x + frame.w / 2, frame.y + frame.h / 2, Math.hypot(frame.w, frame.h) * 0.6);
  blk.addColorStop(0, `rgba(0,0,0,${(0.8 - 0.12 * day) * env})`);
  blk.addColorStop(1, `rgba(0,0,0,${(0.96 - 0.1 * day) * env})`);
  base.fillStyle = blk;
  base.fillRect(frame.x, frame.y, frame.w, frame.h);

  const push = 1 + 0.16 * smoothstep(0, 1, p);
  // painted closeups are framed on their eyes; the procedural face is framed on its centre
  const fh = frame.h * (spr ? range(rng, 1.55, 1.8) : range(rng, 1.22, 1.4)) * push;
  const fw = fh * aspect;
  const fxN = spr ? spr.focusX : 0.5;
  const fyN = spr ? spr.focusY : 0.5;
  const tx = frame.x + frame.w * (0.5 + range(rng, -0.1, 0.1)) + Math.sin(t / 900) * frame.w * 0.006;
  const ty = frame.y + frame.h * (spr ? range(rng, 0.36, 0.44) : 0.5 + range(rng, -0.02, 0.1));
  const cx = tx + (0.5 - fxN) * fw;
  const cy = ty + (0.5 - fyN) * fh;
  // vertical hold slips (≤ 2 per second)
  const slipSlot = Math.floor(t / 500);
  const slip = !dc.reduced && rand01(m.seed, slipSlot, 77) > 0.6 && t % 500 < 90 ? (rand01(m.seed, slipSlot, 78) - 0.3) * frame.h * 0.18 : 0;
  const x = cx - fw / 2;
  const y = cy - fh / 2 + slip;
  // smooth luminance flicker (well under 3 Hz)
  const flick = 0.82 + 0.18 * Math.sin(t / 260 + m.seed) * Math.sin(t / 410);
  const alpha = (0.5 + 0.5 * s) * env * flick;

  // too close to focus: the camera's own resolution and noise, the scene's light colour
  const nativePerDisplay = sc ? sc.nativeH / Math.max(1, frame.h) : 0.42;
  const res = clamp(nativePerDisplay * 1.25, 0.2, 0.42);
  const sd = seeds(m, dc);
  const [c, sw, sh] = gradeSprite(src, {
    w: fw,
    h: fh,
    res,
    erosion: 0.18 + 0.3 * (1 - s),
    // by day the painted eyes may not out-shine the daylight around the lens; at night they can
    clampTo: day > 0.5 ? [light.ambient[0] * 1.4, light.ambient[1] * 1.4, light.ambient[2] * 1.4] : null,
    veil: null,
    veilAlpha: 0,
    chroma: sc ? 0.3 : 0,
    chromaColor: light.ambient,
    noise: sc ? clamp(sc.noise * 1.5, 0, 0.18) : 0,
    block: sc && sc.jpeg ? 0.25 : 0,
    blockPx: sc ? (8 * res * frame.h) / sc.nativeH : 0,
    blockOx: 0,
    blockOy: 0,
    occlude: 0,
    noiseSeed: sd.noiseSeed,
    erosionSeed: sd.erosionSeed,
  });
  base.globalAlpha = clamp(alpha);
  const jitter = dc.reduced ? 1 * dc.px : (6 + 10 * (1 - s * 0.5)) * dc.px;
  blit(base, c, sw, sh, x, y, fw, fh, dc.reduced ? 1 : 22, jitter, dc.frameIndex, m.seed);
  base.globalAlpha = 1;

  // chromatic split on the additive layer
  if (!dc.reduced) {
    const tint = tinted(src);
    const off = (4 + 6 * rand01(m.seed, dc.frameIndex, 4)) * dc.px;
    add.globalAlpha = 0.18 * alpha * (1 - 0.4 * day);
    add.drawImage(tint.r, x + off, y, fw, fh);
    add.drawImage(tint.c, x - off, y + off * 0.3, fw, fh);
    add.globalAlpha = 1;
  }
  if (face) drawEyes(add, face.eyes, x, y, fw, fh, 0.8 * env * (1 - 0.5 * day), 5, dc.now, m.seed);
  const tears: Array<[number, number]> = [];
  if (!dc.reduced) {
    const n = 2 + Math.floor(rand01(m.seed, dc.frameIndex, 31) * 3);
    for (let i = 0; i < n; i++) tears.push([frame.y + frame.h * rand01(m.seed, dc.frameIndex, 40 + i), frame.h * (0.02 + 0.08 * rand01(m.seed, dc.frameIndex, 50 + i))]);
  }
  void gauss;
  return { boost: 0.65 + 0.25 * s, tears, active: env > 0.02 };
}
