// Procedural creature sprites. Generated once per (seed, variant) at a fixed resolution and cached:
// shapes are laid down with canvas paths, then processed per-pixel (blur → noise-thresholded alpha,
// rim light, mottled texture) so edges fray like something half-resolved by a bad sensor.
import { boxBlur, ctx2d, getFbmField, getFineField, makeCanvas, sampleField } from '../core/noise';
import { clamp, mulberry32, range, smoothstep, type Rng } from '../core/rng';

export interface EyePoint {
  /** normalized 0..1 within the sprite */
  x: number;
  y: number;
  /** radius relative to sprite height */
  r: number;
}

export interface FigureSprite {
  crisp: HTMLCanvasElement;
  soft: HTMLCanvasElement;
  /** pure black alpha, very soft; used for cast shadows */
  shadow: HTMLCanvasElement;
  eyes: EyePoint[];
  /** feet anchor (normalized x within sprite; y is 1) */
  anchorX: number;
  /** width / height */
  aspect: number;
}

export interface FaceSprite {
  face: HTMLCanvasElement;
  eyes: EyePoint[];
  aspect: number;
}

/** Body seed: the creature is the same thing everywhere; only pose varies with manifestation seed. */
export const CREATURE_SEED = 0x6d6f6e;

const FIG_H = 640;
const FIG_W = 300;

type P = [number, number];

function catmull(pts: P[], samples: number): P[] {
  const out: P[] = [];
  const n = pts.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(n - 1, i + 2)];
    for (let s = 0; s < samples; s++) {
      const t = s / samples;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  out.push(pts[n - 1]);
  return out;
}

/** Tapered limb along a smooth curve; widths are interpolated along the control points. */
function limb(ctx: CanvasRenderingContext2D, pts: P[], widths: number[]) {
  const path = catmull(pts, 10);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 0; i < path.length - 1; i++) {
    const f = (i / (path.length - 1)) * (widths.length - 1);
    const k = Math.floor(f);
    const w = widths[k] + (widths[Math.min(widths.length - 1, k + 1)] - widths[k]) * (f - k);
    ctx.lineWidth = Math.max(0.6, w);
    ctx.beginPath();
    ctx.moveTo(path[i][0], path[i][1]);
    ctx.lineTo(path[i + 1][0], path[i + 1][1]);
    ctx.stroke();
  }
}

interface BodyLayout {
  eyes: EyePoint[];
}

function drawBody(ctx: CanvasRenderingContext2D, rng: Rng, tilt: number, W: number, H: number): BodyLayout {
  const u = H; // unit = sprite height
  const cx = W / 2 + range(rng, -0.004, 0.004) * u;
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';

  const shoulderY = 0.158 * u;
  const lShoulder: P = [cx - range(rng, 0.064, 0.074) * u, shoulderY + range(rng, 0.006, 0.016) * u];
  const rShoulder: P = [cx + range(rng, 0.062, 0.07) * u, shoulderY + range(rng, -0.004, 0.006) * u];
  const neckBase: P = [cx + range(rng, -0.003, 0.003) * u, 0.142 * u];

  // --- head + neck, rotated about the neck base (the tilt) -----------------------------------
  ctx.save();
  ctx.translate(neckBase[0], neckBase[1]);
  ctx.rotate(tilt);
  const headCY = -0.088 * u;
  const headRX = 0.0265 * u;
  const headRY = 0.044 * u;
  // long thin neck
  limb(ctx, [[0, 0.01 * u], [0, -0.03 * u], [0.002 * u, -0.055 * u]], [0.02 * u, 0.0145 * u, 0.013 * u]);
  // cranium (tall, narrow) + jaw that tapers to a point
  ctx.beginPath();
  ctx.ellipse(0, headCY, headRX, headRY, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-headRX * 0.92, headCY + headRY * 0.1);
  ctx.quadraticCurveTo(-headRX * 0.7, headCY + headRY * 1.15, 0, headCY + headRY * 1.32);
  ctx.quadraticCurveTo(headRX * 0.7, headCY + headRY * 1.15, headRX * 0.92, headCY + headRY * 0.1);
  ctx.closePath();
  ctx.fill();
  // eye positions in sprite space
  const eyeY = headCY + headRY * 0.12;
  const eyes: EyePoint[] = [];
  for (const s of [-1, 1]) {
    const ex = s * headRX * 0.42;
    const ey = eyeY + (s > 0 ? 0.0012 * u : 0);
    const gx = neckBase[0] + ex * Math.cos(tilt) - ey * Math.sin(tilt);
    const gy = neckBase[1] + ex * Math.sin(tilt) + ey * Math.cos(tilt);
    eyes.push({ x: gx / W, y: gy / H, r: (s > 0 ? 0.0036 : 0.0042) });
  }
  ctx.restore();

  // --- shoulders: narrow, sloped, slightly uneven ------------------------------------------------
  limb(ctx, [lShoulder, [cx - 0.03 * u, 0.146 * u], neckBase, [cx + 0.03 * u, 0.144 * u], rShoulder], [0.028 * u, 0.032 * u, 0.03 * u, 0.032 * u, 0.028 * u]);

  // --- torso: gaunt, ribcage then a waist that is far too thin ------------------------------------
  const waist = range(rng, 0.026, 0.031) * u;
  ctx.beginPath();
  ctx.moveTo(lShoulder[0] + 0.006 * u, lShoulder[1]);
  ctx.bezierCurveTo(cx - 0.062 * u, 0.24 * u, cx - 0.05 * u, 0.3 * u, cx - waist, 0.4 * u);
  ctx.bezierCurveTo(cx - waist * 1.05, 0.44 * u, cx - 0.042 * u, 0.47 * u, cx - 0.04 * u, 0.5 * u);
  ctx.lineTo(cx + 0.04 * u, 0.5 * u);
  ctx.bezierCurveTo(cx + 0.042 * u, 0.47 * u, cx + waist * 1.05, 0.44 * u, cx + waist, 0.4 * u);
  ctx.bezierCurveTo(cx + 0.048 * u, 0.3 * u, cx + 0.06 * u, 0.24 * u, rShoulder[0] - 0.006 * u, rShoulder[1]);
  ctx.closePath();
  ctx.fill();

  // --- legs: long, close together, knees barely bent --------------------------------------------
  const legSpread = range(rng, 0.018, 0.026) * u;
  for (const s of [-1, 1]) {
    const hip: P = [cx + s * 0.022 * u, 0.49 * u];
    const knee: P = [cx + s * (legSpread + 0.004 * u), 0.745 * u];
    const ankle: P = [cx + s * (legSpread - 0.002 * u), 0.972 * u];
    limb(ctx, [hip, [cx + s * 0.026 * u, 0.62 * u], knee, [cx + s * (legSpread + 0.002 * u), 0.86 * u], ankle], [0.036 * u, 0.026 * u, 0.019 * u, 0.014 * u, 0.011 * u]);
    // foot: thin wedge pointing slightly outward
    limb(ctx, [ankle, [ankle[0] + s * 0.012 * u, 0.99 * u], [ankle[0] + s * 0.02 * u, 0.997 * u]], [0.012 * u, 0.008 * u, 0.004 * u]);
  }

  // --- arms: hanging, absurdly long, fingers reaching past the knees ----------------------------
  for (const s of [-1, 1]) {
    const sh = s < 0 ? lShoulder : rShoulder;
    const len = range(rng, 0.97, 1.04);
    const elbow: P = [sh[0] + s * range(rng, 0.012, 0.02) * u, sh[1] + 0.25 * u * len];
    const wrist: P = [elbow[0] - s * range(rng, 0.0, 0.008) * u, sh[1] + 0.5 * u * len];
    limb(ctx, [sh, [sh[0] + s * 0.01 * u, sh[1] + 0.12 * u], elbow, [elbow[0], elbow[1] + 0.12 * u], wrist], [0.022 * u, 0.017 * u, 0.012 * u, 0.0105 * u, 0.0085 * u]);
    // narrow palm
    const palm: P = [wrist[0] + s * 0.002 * u, wrist[1] + 0.035 * u];
    limb(ctx, [wrist, palm], [0.011 * u, 0.012 * u]);
    // four long fingers, slightly splayed and curling inward at the tips
    for (let f = 0; f < 4; f++) {
      const spread = (f - 1.5) * 0.0055 * u;
      const fl = range(rng, 0.085, 0.11) * u * (f === 0 || f === 3 ? 0.86 : 1);
      const base: P = [palm[0] + spread * 0.6, palm[1] + 0.004 * u];
      const mid: P = [base[0] + spread * 0.9 + s * 0.002 * u, base[1] + fl * 0.55];
      const tip: P = [mid[0] - s * 0.004 * u + spread * 0.2, base[1] + fl];
      limb(ctx, [base, mid, tip], [0.0042 * u, 0.0032 * u, 0.0018 * u]);
    }
  }
  return { eyes };
}

function readAlpha(c: HTMLCanvasElement): Float32Array {
  const ctx = ctx2d(c, { willReadFrequently: true });
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const a = new Float32Array(c.width * c.height);
  for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3] / 255;
  return a;
}

const figureCache = new Map<string, FigureSprite>();

/** Gaunt elongated humanoid. `variant` 1 bakes a sharper head tilt (used for the "snap"). */
export function getFigureSprite(seed: number, variant: 0 | 1 = 0): FigureSprite {
  const key = `${seed >>> 0}:${variant}`;
  const hit = figureCache.get(key);
  if (hit) return hit;
  const rng = mulberry32(seed ^ 0x51f15e);
  const side = rng() < 0.5 ? -1 : 1;
  const baseTilt = range(rng, 0.09, 0.17) * side;
  const tilt = variant === 0 ? baseTilt : baseTilt + side * range(rng, 0.32, 0.42);
  const W = FIG_W;
  const H = FIG_H;
  const mask = makeCanvas(W, H);
  const mctx = ctx2d(mask, { willReadFrequently: true });
  const layout = drawBody(mctx, mulberry32(seed ^ 0xb0d1), tilt, W, H);
  const A0 = readAlpha(mask);
  const Ac = boxBlur(A0, W, H, 2, 2);
  const As = boxBlur(A0, W, H, 7, 2);
  const Ash = boxBlur(A0, W, H, 9, 3);
  const fb = getFbmField();
  const fine = getFineField();
  const ox = (seed % 97) * 3;
  const oy = (seed % 89) * 5;

  const crisp = makeCanvas(W, H);
  const soft = makeCanvas(W, H);
  const shadow = makeCanvas(W, H);
  const cImg = ctx2d(crisp).createImageData(W, H);
  const sImg = ctx2d(soft).createImageData(W, H);
  const hImg = ctx2d(shadow).createImageData(W, H);
  const cd = cImg.data;
  const sd = sImg.data;
  const hd = hImg.data;
  const lx = -2.4;
  const ly = -3.2; // light from upper-left, a few px away
  for (let y = 0; y < H; y++) {
    const vy = y / H;
    const footFade = smoothstep(1.0, 0.955, vy);
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const n = sampleField(fb, x * 1.6 + ox, y * 1.6 + oy);
      const nf = sampleField(fine, x + ox, y + oy);
      // --- crisp figure
      const thr = 0.5 + (n - 0.5) * 0.6 + (nf - 0.5) * 0.28;
      let a = smoothstep(thr - 0.09, thr + 0.09, Ac[i]) * footFade;
      if (a > 0.003) {
        const xi = Math.min(W - 1, Math.max(0, Math.round(x + lx)));
        const yi = Math.min(H - 1, Math.max(0, Math.round(y + ly)));
        const rim = clamp((Ac[i] - Ac[yi * W + xi]) * 2.6);
        let L = 0.03 + 0.03 * (1 - vy) + (n - 0.5) * 0.045 + (nf - 0.5) * 0.02;
        L += rim * 0.2;
        L = clamp(L);
        const o = i * 4;
        cd[o] = L * 255;
        cd[o + 1] = L * 247;
        cd[o + 2] = L * 240;
        cd[o + 3] = a * 255;
      }
      // --- soft, smoke-eroded silhouette
      const thr2 = 0.34 + (n - 0.5) * 0.9 + (nf - 0.5) * 0.3;
      a = smoothstep(thr2 - 0.22, thr2 + 0.22, As[i]) * smoothstep(1.02, 0.7, vy * (0.92 + n * 0.16));
      if (a > 0.003) {
        const o = i * 4;
        const L = 0.025 + (n - 0.5) * 0.03;
        sd[o] = L * 255;
        sd[o + 1] = L * 250;
        sd[o + 2] = L * 248;
        sd[o + 3] = a * 255;
      }
      // --- shadow
      a = clamp(Ash[i] * 1.4) * (0.75 + n * 0.5);
      if (a > 0.003) hd[i * 4 + 3] = clamp(a) * 255;
    }
  }
  ctx2d(crisp).putImageData(cImg, 0, 0);
  ctx2d(soft).putImageData(sImg, 0, 0);
  ctx2d(shadow).putImageData(hImg, 0, 0);
  const sprite: FigureSprite = { crisp, soft, shadow, eyes: layout.eyes, anchorX: 0.5, aspect: W / H };
  if (figureCache.size > 12) figureCache.delete(figureCache.keys().next().value as string);
  figureCache.set(key, sprite);
  return sprite;
}

// ---------------------------------------------------------------------------------------------
// Face (closeup): IR-lit, gaunt, deep sockets, a too-wide mouth. Grey-green monochrome.

const FACE_W = 360;
const FACE_H = 460;
const faceCache = new Map<number, FaceSprite>();

export function getFaceSprite(seed: number): FaceSprite {
  const hit = faceCache.get(seed >>> 0);
  if (hit) return hit;
  const rng = mulberry32(seed ^ 0xfaced);
  const W = FACE_W;
  const H = FACE_H;
  const c = makeCanvas(W, H);
  const ctx = ctx2d(c);
  const img = ctx.createImageData(W, H);
  const d = img.data;
  const fb = getFbmField();
  const fine = getFineField();
  const tilt = range(rng, 0.06, 0.14) * (rng() < 0.5 ? -1 : 1);
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  const asym = range(rng, 0.012, 0.03);
  const sockR = range(rng, 0.15, 0.175);
  const mouthW = range(rng, 0.36, 0.43);
  const mouthY = range(rng, 0.46, 0.5);
  const ox = (seed % 53) * 7;
  const oy = (seed % 61) * 3;
  const sockets: Array<[number, number, number]> = [
    [-0.235, -0.14 + asym, sockR * 1.06],
    [0.235, -0.14, sockR],
  ];
  const g = (dx: number, dy: number) => Math.exp(-(dx * dx + dy * dy));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const n = sampleField(fb, x * 0.9 + ox, y * 0.9 + oy);
      const n2 = sampleField(fb, x * 0.9 + oy + 71, y * 0.9 + ox + 19);
      const nf = sampleField(fine, x * 1.3 + ox, y * 1.3 + oy);
      let u0 = (x / W) * 2 - 1 + (n - 0.5) * 0.07;
      let v0 = ((y / H) * 2 - 1) * (H / W) * 0.82 + (n2 - 0.5) * 0.07;
      const u = u0 * ct - v0 * st;
      const v = u0 * st + v0 * ct;
      u0 = u;
      v0 = v;
      const jaw = v > 0.1 ? 1 - (v - 0.1) * 0.62 : 1 - Math.max(0, -v - 0.55) * 0.35;
      const hx = u / (0.6 * Math.max(0.18, jaw));
      const hy = (v + 0.04) / 1.0;
      const dd = Math.sqrt(hx * hx + hy * hy);
      const mask = smoothstep(1.03, 0.78, dd);
      if (mask <= 0.002) continue;
      let L = 0.78 * (1 - 0.8 * dd * dd);
      L += 0.07 * g(u / 0.3, (v + 0.52) / 0.22); // forehead
      for (const [ex, ey, r] of sockets) {
        const du = (u - ex) / r;
        const dv = (v - ey) / (r * 0.74);
        const q = du * du + dv * dv;
        const sock = smoothstep(1.7, 0.3, q);
        L *= 1 - 0.95 * sock;
        L += 0.11 * g((u - ex) / 0.19, (v - (ey - r * 0.86)) / 0.035); // brow ridge
        L *= 1 - 0.35 * g((u - ex) / 0.16, (v - (ey + r * 0.95)) / 0.05); // bags under sockets
      }
      L += 0.09 * g(u / 0.045, (v - 0.02) / 0.17); // nose bridge
      for (const s of [-1, 1]) {
        L *= 1 - 0.82 * g((u - s * 0.042) / 0.022, (v - 0.2) / 0.034); // nasal slits
        L *= 1 - 0.55 * g((u - s * 0.35) / 0.12, (v - 0.27) / 0.17); // hollow cheeks
        L += 0.08 * g((u - s * 0.3) / 0.12, (v - 0.05) / 0.045); // cheekbones
        L *= 1 - 0.3 * g((u - s * 0.47) / 0.06, (v + 0.1) / 0.35); // temples
      }
      // mouth: thin, far too wide, corners lifted; slightly parted at the centre
      const my = mouthY - 0.075 * (u / mouthW) * (u / mouthW);
      const ext = smoothstep(mouthW + 0.06, mouthW - 0.04, Math.abs(u));
      const thick = 0.011 + 0.03 * Math.exp(-((u / 0.13) ** 2));
      const m = Math.exp(-(((v - my) / thick) ** 2)) * ext;
      L *= 1 - 0.93 * m;
      L += 0.06 * Math.exp(-(((v - (my - 0.05)) / 0.025) ** 2)) * ext; // upper lip catchlight
      L *= 1 - 0.25 * Math.exp(-(((v - (my + 0.06)) / 0.05) ** 2)) * ext;
      // skin: mottled, waxy
      L *= 0.82 + (n - 0.5) * 0.5 + (nf - 0.5) * 0.28;
      L = Math.pow(clamp(L), 1.35);
      const o = (y * W + x) * 4;
      d[o] = L * 214;
      d[o + 1] = L * 236;
      d[o + 2] = L * 220;
      d[o + 3] = mask * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // map socket centres back to sprite coords (inverse tilt + aspect)
  const eyes: EyePoint[] = sockets.map(([ex, ey, r]) => {
    const pv = ey + r * 0.05;
    const uu = ex * ct + pv * st;
    const vv = -ex * st + pv * ct;
    return { x: (uu + 1) / 2, y: (vv / ((H / W) * 0.82) + 1) / 2, r: 0.0075 };
  });
  const sprite: FaceSprite = { face: c, eyes, aspect: W / H };
  if (faceCache.size > 6) faceCache.delete(faceCache.keys().next().value as number);
  faceCache.set(seed >>> 0, sprite);
  return sprite;
}
