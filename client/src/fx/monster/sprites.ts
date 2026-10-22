// Optional pre-rendered monster sprites from /assets/monster/manifest.json. Absent or invalid
// manifests are ignored silently and the procedural creature is used.
// On load each sprite is cleaned once (same-origin pixels): stray specks outside the main body are
// removed, closeups get feathered edges (so crop lines never show), and a pure-black copy is
// prepared for cast shadows.
import type { MonsterManifestation } from '../index';
import { boxBlur, ctx2d, makeCanvas } from '../core/noise';
import type { EyePoint } from './creature';
import { fxAssetsEnabled } from '../core/settings';

export interface ManifestSprite {
  file: string;
  img: HTMLCanvasElement;
  dark: HTMLCanvasElement;
  kind: MonsterManifestation['kind'];
  anchorX: number;
  anchorY: number;
  aspect: number;
  /** normalized focal point (the eyes) for closeups; the anchor otherwise */
  focusX: number;
  focusY: number;
  /** eye positions (normalized, r relative to height) for night eye-shine on full-body sprites */
  eyes: EyePoint[];
}

interface RawEntry {
  file?: unknown;
  kind?: unknown;
  anchor?: { x?: unknown; y?: unknown };
}

const KINDS = new Set(['shadow', 'silhouette', 'figure', 'closeup']);
/** Known seam artifacts (doubled head outline / jagged collar): used only if nothing else exists. */
const FLAWED = new Set(['figure-01.png', 'silhouette-02.png']);
const MAX_H = 640; // processing / drawing resolution cap
let sprites: ManifestSprite[] = [];
let started = false;

/** Keep only the largest 8-connected blob of alpha > thr (and anything touching it after a blur). */
function keepLargestBlob(alpha: Float32Array, w: number, h: number, thr = 0.08): Uint8Array {
  const label = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  let best = 0;
  let bestSize = 0;
  let next = 1;
  for (let i = 0; i < w * h; i++) {
    if (label[i] || alpha[i] <= thr) continue;
    const id = next++;
    let sp = 0;
    let size = 0;
    stack[sp++] = i;
    label[i] = id;
    while (sp) {
      const p = stack[--sp];
      size++;
      const x = p % w;
      const y = (p / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (!label[q] && alpha[q] > thr) {
            label[q] = id;
            stack[sp++] = q;
          }
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = id;
    }
  }
  const keep = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) keep[i] = label[i] === best ? 1 : 0;
  return keep;
}

/** Eye-shine points of a full-body sprite: bright top-hat peaks in the head, else an anatomical estimate. */
function findEyes(d: Uint8ClampedArray, w: number, h: number): EyePoint[] {
  let top = h;
  let bottom = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (d[(y * w + x) * 4 + 3] > 128) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
  if (bottom <= top) return [];
  const bodyH = bottom - top;
  const headB = Math.min(h, Math.round(top + bodyH * 0.12));
  let sx = 0;
  let sw = 0;
  for (let y = top; y < headB; y++)
    for (let x = 0; x < w; x++) {
      const a = d[(y * w + x) * 4 + 3] / 255;
      sx += x * a;
      sw += a;
    }
  const hx = sw > 0 ? sx / sw : w / 2;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < lum.length; i++) lum[i] = ((d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 765) * (d[i * 4 + 3] / 255);
  const fine = boxBlur(lum, w, h, 1, 1);
  const wide = boxBlur(lum, w, h, Math.max(3, Math.round(bodyH * 0.02)), 1);
  const peaks: Array<{ x: number; y: number; v: number }> = [];
  const r = bodyH * 0.08;
  for (let y = top; y < headB; y++)
    for (let x = Math.max(0, Math.round(hx - r)); x < Math.min(w, Math.round(hx + r)); x++) {
      const v = fine[y * w + x] - wide[y * w + x];
      if (v > 0.12) peaks.push({ x, y, v });
    }
  peaks.sort((a, b) => b.v - a.v);
  const out: Array<{ x: number; y: number }> = [];
  for (const pk of peaks) {
    if (out.every((o) => Math.hypot(o.x - pk.x, o.y - pk.y) > bodyH * 0.02)) out.push(pk);
    if (out.length === 2) break;
  }
  const er = 0.006;
  if (out.length === 2) return out.map((o) => ({ x: o.x / w, y: o.y / h, r: er }));
  const ey = (top + bodyH * 0.055) / h;
  const dx = (bodyH * 0.018) / w;
  return [
    { x: hx / w - dx, y: ey, r: er },
    { x: hx / w + dx, y: ey, r: er },
  ];
}

function processSprite(img: HTMLImageElement, kind: ManifestSprite['kind']): { img: HTMLCanvasElement; dark: HTMLCanvasElement; focus: [number, number] | null; eyes: EyePoint[] } {
  const sc = Math.min(1, MAX_H / img.naturalHeight);
  const w = Math.max(1, Math.round(img.naturalWidth * sc));
  const h = Math.max(1, Math.round(img.naturalHeight * sc));
  const c = makeCanvas(w, h);
  const x = ctx2d(c, { willReadFrequently: true });
  x.drawImage(img, 0, 0, w, h);
  const id = x.getImageData(0, 0, w, h);
  const d = id.data;
  const a = new Float32Array(w * h);
  for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3] / 255;
  // protect soft fringes around the main body: grow the kept mask a little
  const keep = keepLargestBlob(boxBlur(a, w, h, 2, 1), w, h, kind === 'shadow' ? 0.03 : 0.06);
  const keepSoft = boxBlur(Float32Array.from(keep), w, h, 3, 1);
  let feather: Float32Array | null = null;
  if (kind === 'closeup') {
    // soften every edge (incl. hard crop lines) so it emerges from darkness
    const r = Math.round(Math.min(w, h) * 0.05);
    const blurred = boxBlur(a, w, h, r, 2);
    feather = new Float32Array(w * h);
    for (let i = 0; i < a.length; i++) {
      const px = i % w;
      const py = (i / w) | 0;
      // also fade toward the sprite's own borders, where generated crops end
      const bx = Math.min(px, w - 1 - px) / (w * 0.08);
      const by = Math.min(py, h - 1 - py) / (h * 0.08);
      const border = Math.min(1, bx, by);
      feather[i] = Math.min(1, Math.max(0, (blurred[i] - 0.25) / 0.6)) * border;
    }
  }
  const dark = makeCanvas(w, h);
  const dx = ctx2d(dark);
  const dd = dx.createImageData(w, h);
  for (let i = 0; i < a.length; i++) {
    let al = a[i] * Math.min(1, keepSoft[i] * 1.6);
    if (feather) al *= feather[i];
    d[i * 4 + 3] = al * 255;
    dd.data[i * 4 + 3] = al * 255;
  }
  // focal point: the head is the top of the body mass; inside it, eye-shine is a sharp local
  // brightness peak (top-hat), unlike broad lit skin on the shoulders.
  let focus: [number, number] | null = null;
  if (kind === 'closeup') {
    let top = h;
    let bottom = 0;
    for (let i = 0; i < a.length; i++) {
      if (d[i * 4 + 3] > 128) {
        const y = (i / w) | 0;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
    const headBottom = top + (bottom - top) * 0.32;
    let sx = 0;
    let sw = 0;
    for (let y = top; y < headBottom; y++) {
      for (let x2 = 0; x2 < w; x2++) {
        const al = d[(y * w + x2) * 4 + 3] / 255;
        sx += x2 * al;
        sw += al;
      }
    }
    const hx = sw > 0 ? sx / sw : w / 2;
    const hy = (top + headBottom) / 2;
    focus = [hx / w, hy / h];
    const lum = new Float32Array(w * h);
    for (let i = 0; i < lum.length; i++) lum[i] = ((d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 765) * (d[i * 4 + 3] / 255);
    const fine = boxBlur(lum, w, h, 1, 1);
    const wide = boxBlur(lum, w, h, Math.max(4, Math.round(w * 0.03)), 1);
    let best = -1;
    let bi = -1;
    const r = (bottom - top) * 0.3;
    for (let y = Math.max(0, Math.round(top)); y < Math.min(h, headBottom + r * 0.3); y++) {
      for (let x2 = 0; x2 < w; x2++) {
        if (Math.abs(x2 - hx) > r) continue;
        const i = y * w + x2;
        const v = fine[i] - wide[i];
        if (v > best) {
          best = v;
          bi = i;
        }
      }
    }
    if (bi >= 0 && best > 0.15) focus = [(bi % w) / w, Math.floor(bi / w) / h];
  }
  const eyes = kind === 'closeup' || kind === 'shadow' ? [] : findEyes(d, w, h);
  x.putImageData(id, 0, 0);
  dx.putImageData(dd, 0, 0);
  return { img: c, dark, focus, eyes };
}

// process one sprite per task so a load never blocks a frame for long
const queue: Array<() => void> = [];
let pumping = false;
const idle = (fn: () => void) => {
  queue.push(fn);
  if (pumping) return;
  pumping = true;
  const pump = () => {
    const f = queue.shift();
    if (!f) {
      pumping = false;
      return;
    }
    f();
    window.setTimeout(pump, 24);
  };
  window.setTimeout(pump, 0);
};

export function loadMonsterSprites(base = '/assets/monster/'): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  fetch(`${base}manifest.json`, { headers: { Accept: 'application/json' } })
    .then((r) => {
      if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return null;
      return r.json() as Promise<{ sprites?: RawEntry[] }>;
    })
    .then((m) => {
      if (!m || !Array.isArray(m.sprites)) return;
      for (const e of m.sprites) {
        if (typeof e.file !== 'string' || typeof e.kind !== 'string' || !KINDS.has(e.kind)) continue;
        const kind = e.kind as ManifestSprite['kind'];
        const file = e.file;
        const anchorX = typeof e.anchor?.x === 'number' ? e.anchor.x : 0.5;
        const anchorY = typeof e.anchor?.y === 'number' ? e.anchor.y : 1;
        const img = new Image();
        img.decoding = 'async';
        img.onload = () =>
          idle(() => {
            try {
              const p = processSprite(img, kind);
              sprites.push({ img: p.img, dark: p.dark, file, kind, anchorX, anchorY, aspect: p.img.width / Math.max(1, p.img.height), focusX: p.focus?.[0] ?? anchorX, focusY: p.focus?.[1] ?? anchorY, eyes: p.eyes });
            } catch {
              /* unusable sprite: ignore */
            }
          });
        img.src = new URL(e.file, new URL(base, window.location.href)).href;
      }
    })
    .catch(() => {
      sprites = [];
    });
}

/** A loaded sprite for this kind (figure sprites also serve shadow/silhouette), or null → procedural. */
export function spriteFor(kind: MonsterManifestation['kind'], seed: number): ManifestSprite | null {
  if (!fxAssetsEnabled() || !sprites.length) return null;
  const good = sprites.filter((s) => !FLAWED.has(s.file.split('/').pop() ?? ''));
  const pools = [good, sprites];
  let list: ManifestSprite[] = [];
  for (const pool of pools) {
    list = pool.filter((s) => s.kind === kind);
    if (!list.length && kind !== 'closeup') list = pool.filter((s) => s.kind === 'figure' || s.kind === 'silhouette');
    if (list.length) break;
  }
  if (!list.length) return null;
  list.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return list[(seed >>> 0) % list.length];
}

/** Number of sprites processed so far (lab / tests wait on this). */
export function loadedSpriteCount(): number {
  return sprites.length;
}
