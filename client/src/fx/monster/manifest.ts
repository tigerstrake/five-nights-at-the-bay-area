// Composites a MonsterManifestation into a feed overlay. Pure function of (manifestation, time,
// placement) except for per-frame grain/erosion randomness, so every client sees the same
// appearance at the same moment.
import type { MonsterManifestation, PlacementRegion } from '../index';
import { ctx2d, getGrainTiles, getSnowTiles, makeCanvas, tileFill } from '../core/noise';
import { clamp, gauss, mulberry32, rand01, range, smoothstep } from '../core/rng';
import { CREATURE_SEED, getFaceSprite, getFigureSprite, type EyePoint } from './creature';
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
}

export interface ManifestResult {
  /** extra interference to apply to the whole feed (0..1) */
  boost: number;
  /** horizontal bands (canvas px) that should tear this frame */
  tears: Array<[number, number]>;
  active: boolean;
}

/** Used when a camera has no placement regions. Boxes are where the FEET land (camera-research convention). */
export const DEFAULT_PLACEMENT: PlacementRegion = { x: 0.56, y: 0.66, w: 0.22, h: 0.12, scale: 0.32 };

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

function eyeGlow(add: CanvasRenderingContext2D, x: number, y: number, r: number, alpha: number, bloom: number) {
  if (alpha <= 0.01) return;
  const core = Math.max(0.7, r);
  const g = add.createRadialGradient(x, y, 0, x, y, core * 2.2);
  g.addColorStop(0, `rgba(236,244,232,${clamp(alpha)})`);
  g.addColorStop(0.45, `rgba(200,220,205,${clamp(alpha * 0.55)})`);
  g.addColorStop(1, 'rgba(160,190,170,0)');
  add.fillStyle = g;
  add.fillRect(x - core * 2.2, y - core * 2.2, core * 4.4, core * 4.4);
  if (bloom > 0) {
    const R = core * bloom;
    const b = add.createRadialGradient(x, y, 0, x, y, R);
    b.addColorStop(0, `rgba(190,215,200,${clamp(alpha * 0.22)})`);
    b.addColorStop(1, 'rgba(190,215,200,0)');
    add.fillStyle = b;
    add.fillRect(x - R, y - R, R * 2, R * 2);
  }
}

interface Layout {
  footX: number;
  footY: number;
  figH: number;
  r: PlacementRegion;
}

function layoutFor(m: MonsterManifestation, placement: PlacementRegion[], f: FrameRect): Layout {
  const list = placement.length ? placement : [DEFAULT_PLACEMENT];
  const n = list.length;
  const r = list[(((m.regionIndex | 0) % n) + n) % n];
  const rng = mulberry32(m.seed ^ 0x9137);
  // the box is the ground area where the feet land
  const ux = range(rng, 0.15, 0.85);
  const uy = range(rng, 0.25, 1.0);
  return {
    footX: f.x + (r.x + r.w * ux) * f.w,
    footY: f.y + (r.y + r.h * uy) * f.h,
    figH: clamp(r.scale, 0.03, 0.95) * f.h * range(rng, 0.94, 1.06),
    r,
  };
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

function drawEyes(add: CanvasRenderingContext2D, eyes: EyePoint[], x: number, y: number, w: number, h: number, alpha: number, bloom: number, frameIndex: number, seed: number) {
  eyes.forEach((e, i) => {
    const flick = 0.75 + 0.25 * rand01(seed, Math.floor(frameIndex / 3), i);
    eyeGlow(add, x + e.x * w, y + e.y * h, Math.max(0.8, e.r * h), alpha * flick, bloom);
  });
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
  const L = layoutFor(m, placement, frame);
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
  const alpha = (0.26 + 0.4 * s) * env;

  // broad darkening that drifts with it
  const R = L.figH * 0.9;
  const g = base.createRadialGradient(fx, fy - R * 0.2, 0, fx, fy - R * 0.2, R);
  g.addColorStop(0, `rgba(0,0,0,${0.2 * s * env + 0.05 * env})`);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  base.fillStyle = g;
  base.fillRect(fx - R, fy - R * 1.2, R * 2, R * 2);

  const [c, sw, sh] = prepare(src, w, h, 0.5, 0.25 + 0.2 * (1 - s), dc.frameIndex);
  base.save();
  base.globalAlpha = alpha;
  base.translate(fx, fy);
  base.transform(1, 0, shear, 1, 0, 0);
  base.scale(1, squash);
  base.drawImage(c, 0, 0, sw, sh, -w * (spr ? spr.anchorX : fig.anchorX), -h, w, h);
  base.restore();
  return { boost: 0.08 * s * env, tears: [], active: env > 0.05 };
}

function drawSilhouette(m: MonsterManifestation, t: number, s: number, placement: PlacementRegion[], dc: ManifestDrawContext): ManifestResult {
  const { base, frame } = dc;
  const L = layoutFor(m, placement, frame);
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

  let alpha: number;
  if (inFlash) alpha = 0.55 + 0.4 * s;
  else if (since < 160) alpha = (0.55 + 0.4 * s) * (dc.reduced ? 1 - since / 160 : 0.35 * (1 - since / 160));
  else alpha = 0.03 + 0.05 * s; // barely-there residue, lost under grain
  if (dc.reduced && inFlash) alpha *= 0.85;

  if (inFlash) staticHalo(dc.add, x + w / 2, y + h * 0.5, w * 1.5, h * 0.75, (0.25 + 0.35 * s) * (dc.reduced ? 0.6 : 1), dc.frameIndex);
  const [c, sw, sh] = prepare(src, w, h, 0.45, inFlash ? 0.35 : 0.65, dc.frameIndex);
  base.globalAlpha = clamp(alpha);
  const jitter = dc.reduced ? 0 : (inFlash ? 3.5 : 1.2) * dc.px;
  blit(base, c, sw, sh, x, y, w, h, inFlash ? 9 : 4, jitter, dc.frameIndex, m.seed);
  base.globalAlpha = 1;
  if (inFlash) {
    // the shape is negative space in its own interference
    dc.add.globalCompositeOperation = 'destination-out';
    dc.add.drawImage(c, 0, 0, sw, sh, x, y, w, h);
    dc.add.globalCompositeOperation = 'source-over';
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
  const L = layoutFor(m, placement, frame);
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
  const x = L.footX - w * ax;
  const y = L.footY - h;

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

  // contact shadow grounds it in the scene
  const cg = base.createRadialGradient(L.footX, L.footY, 0, L.footX, L.footY, w * 0.9);
  cg.addColorStop(0, `rgba(0,0,0,${0.42 * alpha})`);
  cg.addColorStop(1, 'rgba(0,0,0,0)');
  base.save();
  base.translate(L.footX, L.footY);
  base.scale(1, 0.12);
  base.translate(-L.footX, -L.footY);
  base.fillStyle = cg;
  base.fillRect(L.footX - w, L.footY - w, w * 2, w * 2);
  base.restore();

  // soft halo for low-strength (less resolved) appearances
  if (clarity < 0.98) {
    const [c2, sw2, sh2] = prepare(spr ? spr.img : fig.soft, w, h, 0.4, 0.5, dc.frameIndex + 1);
    base.globalAlpha = alpha * (1 - clarity) * 0.9;
    base.drawImage(c2, 0, 0, sw2, sh2, x - w * 0.03, y - h * 0.01, w * 1.06, h * 1.01);
  }
  if (spr) {
    // painted sprites are lit for a neutral scene; sink them into the dark first
    const [cd, swd, shd] = prepare(spr.dark, w, h, 0.5, 0.2, dc.frameIndex + 2);
    // darker scenes swallow more of the sprite's painted lighting
    base.globalAlpha = alpha * (0.72 - 0.5 * clamp(dc.sceneLum * 1.6));
    base.drawImage(cd, 0, 0, swd, shd, x, y, w, h);
  }
  const [c, sw, sh] = prepare(src, w, h, dc.px > 1.2 ? 0.62 : 0.8, 0.1 + (1 - clarity) * 0.55, dc.frameIndex);
  base.globalAlpha = alpha * (0.55 + 0.45 * clarity) * (spr ? 0.82 : 1);
  const jitter = dc.reduced ? 0 : glitchIn || glitchOut || nearSnap ? 5 * dc.px : 0;
  blit(base, c, sw, sh, x, y, w, h, jitter ? 10 : 1, jitter, dc.frameIndex, m.seed);
  base.globalAlpha = 1;

  if (!spr) {
    const eyeA = smoothstep(0.15, 0.6, s) * env * 0.85 * (1 - 0.6 * clamp(dc.sceneLum * 1.5));
    drawEyes(add, fig.eyes, x, y, w, h, eyeA, 5, dc.frameIndex, m.seed);
  }
  const tears: Array<[number, number]> = [];
  if ((glitchIn || glitchOut || nearSnap) && !dc.reduced) {
    for (let i = 0; i < 3; i++) tears.push([y + h * rand01(m.seed, dc.frameIndex, i + 5), h * (0.04 + 0.1 * rand01(m.seed, dc.frameIndex, i + 9))]);
  }
  const boost = glitchIn || glitchOut || nearSnap ? 0.45 + 0.3 * s : 0.12 + 0.18 * s;
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
  // lens blocked: the frame goes dark around it
  const blk = base.createRadialGradient(frame.x + frame.w / 2, frame.y + frame.h / 2, frame.h * 0.15, frame.x + frame.w / 2, frame.y + frame.h / 2, Math.hypot(frame.w, frame.h) * 0.6);
  blk.addColorStop(0, `rgba(0,0,0,${0.8 * env})`);
  blk.addColorStop(1, `rgba(0,0,0,${0.96 * env})`);
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

  const [c, sw, sh] = prepare(src, fw, fh, 0.42, 0.18 + 0.3 * (1 - s), dc.frameIndex);
  base.globalAlpha = clamp(alpha);
  const jitter = dc.reduced ? 1 * dc.px : (6 + 10 * (1 - s * 0.5)) * dc.px;
  blit(base, c, sw, sh, x, y, fw, fh, dc.reduced ? 1 : 22, jitter, Math.floor(dc.frameIndex / (dc.reduced ? 1 : 1)), m.seed);
  base.globalAlpha = 1;

  // chromatic split on the additive layer
  if (!dc.reduced) {
    const tint = tinted(src);
    const off = (4 + 6 * rand01(m.seed, dc.frameIndex, 4)) * dc.px;
    add.globalAlpha = 0.18 * alpha;
    add.drawImage(tint.r, x + off, y, fw, fh);
    add.drawImage(tint.c, x - off, y + off * 0.3, fw, fh);
    add.globalAlpha = 1;
  }
  if (face) drawEyes(add, face.eyes, x, y, fw, fh, 0.8 * env, 5, dc.frameIndex, m.seed);
  const tears: Array<[number, number]> = [];
  if (!dc.reduced) {
    const n = 2 + Math.floor(rand01(m.seed, dc.frameIndex, 31) * 3);
    for (let i = 0; i < n; i++) tears.push([frame.y + frame.h * rand01(m.seed, dc.frameIndex, 40 + i), frame.h * (0.02 + 0.08 * rand01(m.seed, dc.frameIndex, 50 + i))]);
  }
  void gauss;
  return { boost: 0.65 + 0.25 * s, tears, active: env > 0.02 };
}
