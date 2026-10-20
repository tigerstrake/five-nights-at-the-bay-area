// Renders a SimLayout as a low-resolution night CCTV picture: a baked static layer (sky, road,
// structures, lamp pools) plus per-frame traffic, lamp flicker, sensor noise and macroblocking.
import { ctx2d, getGrainTiles, makeCanvas, tileFill } from '../core/noise';
import { clamp, mulberry32, rand01, range } from '../core/rng';
import type { PlacementRegion } from '../index';
import type { SimLayout } from './layout';

type RGB = [number, number, number];
const rgba = (c: RGB, a: number) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${clamp(a)})`;

const SODIUM: RGB = [255, 158, 62];
const LED: RGB = [214, 226, 255];

// ---------------------------------------------------------------------------------------------
// glow sprites (shared)
let glows: Record<string, HTMLCanvasElement> | null = null;
function glow(name: 'head' | 'tail' | 'amber' | 'sodium' | 'led' | 'red' | 'white'): HTMLCanvasElement {
  if (!glows) {
    glows = {};
    const defs: Record<string, RGB> = {
      head: [255, 244, 222],
      tail: [255, 36, 24],
      amber: [255, 150, 30],
      sodium: SODIUM,
      led: LED,
      red: [255, 30, 20],
      white: [255, 255, 255],
    };
    for (const [k, c] of Object.entries(defs)) {
      const cv = makeCanvas(64, 64);
      const x = ctx2d(cv);
      const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, `rgba(255,255,255,1)`);
      g.addColorStop(0.08, rgba(c, 1));
      g.addColorStop(0.25, rgba(c, 0.45));
      g.addColorStop(0.55, rgba(c, 0.12));
      g.addColorStop(1, rgba(c, 0));
      x.fillStyle = g;
      x.fillRect(0, 0, 64, 64);
      glows[k] = cv;
    }
  }
  return glows[name];
}

function drawGlow(ctx: CanvasRenderingContext2D, name: Parameters<typeof glow>[0], x: number, y: number, r: number, a: number) {
  if (a <= 0.01 || r <= 0.2) return;
  ctx.globalAlpha = clamp(a);
  ctx.drawImage(glow(name), x - r, y - r, r * 2, r * 2);
}

export class SimScene {
  readonly L: SimLayout;
  W = 0;
  H = 0;
  private staticLayer: HTMLCanvasElement | null = null;
  private image: HTMLImageElement | null = null;
  private tiny: HTMLCanvasElement;
  private tctx: CanvasRenderingContext2D;
  private frame = 0;

  constructor(layout: SimLayout) {
    this.L = layout;
    this.tiny = makeCanvas(8, 8);
    this.tctx = ctx2d(this.tiny);
  }

  setImage(img: HTMLImageElement | null) {
    this.image = img;
    this.staticLayer = null;
  }

  hasImage(): boolean {
    return !!this.image;
  }

  /** Map placement given relative to the sample image into canvas-normalized coordinates (cover fit). */
  mapImagePlacement(regions: PlacementRegion[]): PlacementRegion[] {
    if (!this.image || !this.W) return regions;
    const iw = this.image.naturalWidth;
    const ih = this.image.naturalHeight;
    const sc = Math.max(this.W / iw, this.H / ih);
    const ox = (this.W - iw * sc) / 2;
    const oy = (this.H - ih * sc) / 2;
    return regions.map((r) => ({
      x: (ox + r.x * iw * sc) / this.W,
      y: (oy + r.y * ih * sc) / this.H,
      w: (r.w * iw * sc) / this.W,
      h: (r.h * ih * sc) / this.H,
      scale: (r.scale * ih * sc) / this.H,
    }));
  }

  resize(W: number, H: number) {
    if (W === this.W && H === this.H) return;
    this.W = W;
    this.H = H;
    this.staticLayer = null;
    this.tiny.width = Math.max(1, Math.ceil(W / 8));
    this.tiny.height = Math.max(1, Math.ceil(H / 8));
  }

  // projection ---------------------------------------------------------------------------------
  px(X: number, z: number) {
    return this.L.vx * this.W + (X * this.L.s * this.W) / z;
  }
  py(z: number, h = 0) {
    return this.L.hy * this.H + ((1 - this.L.hy) * this.H) / z - (h * this.L.s * this.W) / z;
  }
  unit(z: number) {
    return (this.L.s * this.W) / z;
  }

  private quad(ctx: CanvasRenderingContext2D, X0: number, X1: number, z0: number, z1: number, h0 = 0, h1 = 0) {
    ctx.beginPath();
    ctx.moveTo(this.px(X0, z0), this.py(z0, h0));
    ctx.lineTo(this.px(X1, z0), this.py(z0, h1));
    ctx.lineTo(this.px(X1, z1), this.py(z1, h1));
    ctx.lineTo(this.px(X0, z1), this.py(z1, h0));
    ctx.closePath();
  }

  /** vertical wall running along z at lateral X from height 0..h */
  private wall(ctx: CanvasRenderingContext2D, X: number, z0: number, z1: number, hb: number, ht: number) {
    ctx.beginPath();
    ctx.moveTo(this.px(X, z0), this.py(z0, hb));
    ctx.lineTo(this.px(X, z0), this.py(z0, ht));
    ctx.lineTo(this.px(X, z1), this.py(z1, ht));
    ctx.lineTo(this.px(X, z1), this.py(z1, hb));
    ctx.closePath();
  }

  // static layer -------------------------------------------------------------------------------
  private buildStatic(): HTMLCanvasElement {
    const { W, H, L } = this;
    const c = makeCanvas(W, H);
    const ctx = ctx2d(c);
    const rng = mulberry32(L.seed ^ 0x57a7);
    const hyP = L.hy * H;
    const zFar = L.zMax;

    if (this.image) {
      const iw = this.image.naturalWidth;
      const ih = this.image.naturalHeight;
      const sc = Math.max(W / iw, H / ih);
      ctx.drawImage(this.image, (W - iw * sc) / 2, (H - ih * sc) / 2, iw * sc, ih * sc);
      ctx.fillStyle = 'rgba(0,0,0,0.1)';
      ctx.fillRect(0, 0, W, H);
      return c;
    }

    // sky with sodium skyglow at the horizon
    const sky = ctx.createLinearGradient(0, 0, 0, hyP + 2);
    sky.addColorStop(0, '#07090d');
    sky.addColorStop(0.55, '#0f1115');
    sky.addColorStop(1, rgba(L.skyGlow, 1));
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, hyP + 2);
    // haze band
    const hz = ctx.createLinearGradient(0, hyP - H * 0.08, 0, hyP + H * 0.02);
    hz.addColorStop(0, 'rgba(90,70,55,0)');
    hz.addColorStop(1, 'rgba(90,70,55,0.25)');
    ctx.fillStyle = hz;
    ctx.fillRect(0, hyP - H * 0.08, W, H * 0.1);

    // distant hills with scattered house lights
    if (L.kind !== 'downtown') {
      ctx.fillStyle = '#0b0c0f';
      ctx.beginPath();
      ctx.moveTo(0, hyP + 1);
      const n = L.hills.length;
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * W;
        ctx.lineTo(x, hyP - L.hills[i] * H * 0.075 - H * 0.004);
      }
      ctx.lineTo(W, hyP + 1);
      ctx.closePath();
      ctx.fill();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 70; i++) {
        const xi = rng() * W;
        const hi = L.hills[Math.min(n - 1, Math.floor((xi / W) * (n - 1)))];
        const yi = hyP - rng() * hi * H * 0.07;
        drawGlow(ctx, rng() < 0.8 ? 'sodium' : 'led', xi, yi, 0.8 + rng() * 1.2, 0.35 + rng() * 0.4);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    } else {
      this.drawSkyline(ctx, rng);
    }

    // ground beyond the road (verge / water)
    const ground = ctx.createLinearGradient(0, hyP, 0, H);
    if (L.kind === 'bridge') {
      ground.addColorStop(0, '#0b0e13');
      ground.addColorStop(1, '#040609');
    } else {
      ground.addColorStop(0, '#111210');
      ground.addColorStop(1, '#070807');
    }
    ctx.fillStyle = ground;
    ctx.fillRect(0, hyP, W, H - hyP);
    if (L.kind === 'bridge') {
      // shimmering city reflections on the bay (baked base; flicker added per frame)
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 40; i++) {
        const x = rng() * W;
        const y = hyP + Math.pow(rng(), 2) * (H - hyP) * 0.5 + 1;
        ctx.fillStyle = rgba(rng() < 0.7 ? SODIUM : LED, 0.06 + rng() * 0.1);
        ctx.fillRect(x, y, 2 + rng() * 10, 1);
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    // road surface
    const z1 = 0.6;
    ctx.fillStyle = '#18191b';
    this.quad(ctx, L.edgeL - 0.3, L.edgeR + 0.3, z1, zFar);
    ctx.fill();
    // subtle asphalt banding (tyre tracks)
    for (const lane of L.lanes) {
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      for (const o of [-0.22, 0.22]) {
        this.quad(ctx, lane.X + o - 0.07, lane.X + o + 0.07, z1, zFar);
        ctx.fill();
      }
    }

    // lamp light pools on the road
    ctx.globalCompositeOperation = 'lighter';
    for (const lamp of L.lamps) {
      const col = lamp.color === 'led' ? LED : SODIUM;
      const gx = this.px(lamp.X + lamp.arm, lamp.z);
      const gy = this.py(lamp.z);
      const r = this.unit(lamp.z) * 2.6;
      ctx.save();
      ctx.translate(gx, gy);
      ctx.scale(1, 0.32);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
      g.addColorStop(0, rgba(col, 0.2));
      g.addColorStop(1, rgba(col, 0));
      ctx.fillStyle = g;
      ctx.fillRect(-r, -r, r * 2, r * 2);
      ctx.restore();
    }
    ctx.globalCompositeOperation = 'source-over';

    // lane markings
    const dash = (X: number, w: number, solid: boolean, color: string) => {
      ctx.fillStyle = color;
      if (solid) {
        this.quad(ctx, X - w, X + w, z1, zFar);
        ctx.fill();
        return;
      }
      for (let z = 0.8 + rng() * 2; z < zFar; z += 4) {
        this.quad(ctx, X - w, X + w, z, z + 1.3);
        ctx.fill();
      }
    };
    for (const lane of L.lanes) {
      const isEdgeLane = lane.X === Math.max(...L.lanes.map((l) => l.X)) || lane.X === Math.min(...L.lanes.map((l) => l.X));
      if (!isEdgeLane) dash(lane.X + (lane.dir > 0 ? 0.5 : -0.5), 0.025, false, 'rgba(190,186,170,0.55)');
    }
    dash(L.edgeL + 0.45, 0.035, true, 'rgba(200,196,180,0.45)');
    dash(L.edgeR - 0.45, 0.035, true, 'rgba(200,196,180,0.45)');

    // median barrier (jersey barrier) unless downtown
    if (L.kind !== 'downtown') {
      ctx.fillStyle = '#3b3833';
      this.wall(ctx, L.median, z1, zFar, 0, 0.32);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,190,120,0.08)';
      this.wall(ctx, L.median, z1, zFar, 0.22, 0.32);
      ctx.fill();
    } else {
      dash(L.median - 0.04, 0.02, true, 'rgba(210,170,60,0.5)');
      dash(L.median + 0.04, 0.02, true, 'rgba(210,170,60,0.5)');
    }

    // sound walls / railings / buildings
    if (L.soundWall.left) {
      const g = ctx.createLinearGradient(this.px(L.edgeL - 0.3, 1), 0, this.px(L.edgeL - 0.3, 30), 0);
      g.addColorStop(0, '#2a2824');
      g.addColorStop(1, '#141412');
      ctx.fillStyle = g;
      this.wall(ctx, L.edgeL - 0.3, z1, zFar, 0, L.soundWall.h);
      ctx.fill();
    }
    if (L.soundWall.right) {
      const g = ctx.createLinearGradient(this.px(L.edgeR + 0.3, 1), 0, this.px(L.edgeR + 0.3, 30), 0);
      g.addColorStop(0, '#2b2925');
      g.addColorStop(1, '#151513');
      ctx.fillStyle = g;
      this.wall(ctx, L.edgeR + 0.3, z1, zFar, 0, L.soundWall.h);
      ctx.fill();
      // panel seams
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 1;
      for (let z = 1; z < 30; z += 1.6) {
        ctx.beginPath();
        ctx.moveTo(this.px(L.edgeR + 0.3, z), this.py(z, 0));
        ctx.lineTo(this.px(L.edgeR + 0.3, z), this.py(z, L.soundWall.h));
        ctx.stroke();
      }
    }
    if (!L.soundWall.left && L.kind !== 'downtown') this.treeLine(ctx, rng, L.edgeL - 1.2, -1);
    if (!L.soundWall.right && L.kind !== 'downtown' && L.kind !== 'bridge') this.treeLine(ctx, rng, L.edgeR + 1.2, 1);
    if (L.kind === 'bridge') {
      for (const X of [L.edgeL - 0.3, L.edgeR + 0.3]) {
        ctx.fillStyle = '#2a2a2c';
        this.wall(ctx, X, z1, zFar, 0, 0.4);
        ctx.fill();
        ctx.strokeStyle = 'rgba(150,150,150,0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let z = 1; z < zFar; z *= 1.08) {
          const x = this.px(X, z);
          const y = this.py(z, 1.0);
          if (z === 1) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }
    for (const b of L.buildings) this.building(ctx, b);

    // structures
    if (L.towers) this.drawTowers(ctx);
    if (L.portal) this.drawPortal(ctx, rng);
    if (L.overpass) this.drawOverpass(ctx);

    // lamp poles (heads are drawn per frame for flicker)
    for (const lamp of L.lamps) {
      const u = this.unit(lamp.z);
      const x = this.px(lamp.X, lamp.z);
      ctx.strokeStyle = '#26272a';
      ctx.lineWidth = Math.max(0.6, u * 0.06);
      ctx.beginPath();
      ctx.moveTo(x, this.py(lamp.z, 0));
      ctx.lineTo(x, this.py(lamp.z, lamp.h));
      ctx.lineTo(this.px(lamp.X + lamp.arm, lamp.z), this.py(lamp.z, lamp.h + 0.15));
      ctx.stroke();
    }
    if (L.gantry) this.drawGantry(ctx, rng);

    // the camera's own housing edge sometimes intrudes at a corner
    if (rng() < 0.3) {
      const g = ctx.createRadialGradient(W * (rng() < 0.5 ? 0 : 1), H, 0, W * 0.5, H, W * 0.5);
      g.addColorStop(0, 'rgba(0,0,0,0.6)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    return c;
  }

  private treeLine(ctx: CanvasRenderingContext2D, rng: () => number, X: number, side: number) {
    ctx.fillStyle = '#0a0c0a';
    for (let z = 1.2; z < 50; z += range(rng, 0.8, 2.2)) {
      const u = this.unit(z);
      const x = this.px(X + side * rng() * 1.5, z);
      const h = range(rng, 2.5, 6);
      const y0 = this.py(z, 0);
      const y1 = this.py(z, h);
      ctx.beginPath();
      ctx.ellipse(x, (y0 + y1) / 2, u * range(rng, 0.8, 1.6), (y0 - y1) / 2, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private building(ctx: CanvasRenderingContext2D, b: SimLayout['buildings'][number]) {
    const rng = mulberry32(b.seed);
    const tone = 14 + b.tone * 10;
    ctx.fillStyle = `rgb(${tone},${tone + 1},${tone + 4})`;
    this.wall(ctx, b.X, b.z0, b.z1, 0, b.h);
    ctx.fill();
    // windows
    const warm: RGB = [255, 196, 120];
    const cool: RGB = [170, 200, 255];
    for (let h = 1.2; h < b.h - 0.6; h += 1.15) {
      for (let z = b.z0 + 0.3; z < b.z1 - 0.4; z += 0.9) {
        if (rng() > 0.28) continue;
        ctx.fillStyle = rgba(rng() < 0.7 ? warm : cool, 0.25 + rng() * 0.45);
        this.wall(ctx, b.X, z, z + 0.45, h, h + 0.55);
        ctx.fill();
      }
    }
    // storefront glow at street level
    ctx.fillStyle = rgba(warm, 0.08 + rng() * 0.1);
    this.wall(ctx, b.X, b.z0, b.z1, 0, 1.2);
    ctx.fill();
  }

  private drawSkyline(ctx: CanvasRenderingContext2D, rng: () => number) {
    const { W, H } = this;
    const hyP = this.L.hy * H;
    let x = -5;
    while (x < W) {
      const w = range(rng, W * 0.02, W * 0.07);
      const h = range(rng, H * 0.04, H * 0.22) * (Math.abs(x / W - this.L.vx) < 0.2 ? 1.4 : 1);
      const tone = 9 + rng() * 8;
      ctx.fillStyle = `rgb(${tone},${tone},${tone + 3})`;
      ctx.fillRect(x, hyP - h, w, h + 2);
      ctx.globalCompositeOperation = 'lighter';
      for (let wy = hyP - h + 3; wy < hyP; wy += 3) {
        for (let wx = x + 2; wx < x + w - 2; wx += 3) {
          if (rng() < 0.2) {
            ctx.fillStyle = rgba(rng() < 0.75 ? [255, 200, 130] : [180, 205, 255], 0.2 + rng() * 0.4);
            ctx.fillRect(wx, wy, 1, 1);
          }
        }
      }
      ctx.globalCompositeOperation = 'source-over';
      x += w + (rng() < 0.3 ? range(rng, 0, W * 0.02) : 0);
    }
  }

  private drawGantry(ctx: CanvasRenderingContext2D, rng: () => number) {
    const g = this.L.gantry!;
    const L = this.L;
    const u = this.unit(g.z);
    const xL = this.px(L.edgeL - 0.2, g.z);
    const xR = this.px(L.edgeR + 0.2, g.z);
    const yTop = this.py(g.z, g.h + 0.9);
    const yBot = this.py(g.z, g.h);
    ctx.fillStyle = '#1c1d1f';
    // posts
    ctx.fillRect(xL - u * 0.08, yBot, u * 0.16, this.py(g.z) - yBot);
    ctx.fillRect(xR - u * 0.08, yBot, u * 0.16, this.py(g.z) - yBot);
    // truss
    ctx.fillRect(xL, yTop, xR - xL, u * 0.12);
    ctx.fillRect(xL, yBot - u * 0.12, xR - xL, u * 0.12);
    ctx.strokeStyle = '#1c1d1f';
    ctx.lineWidth = Math.max(0.5, u * 0.04);
    ctx.beginPath();
    for (let x = xL; x < xR; x += u * 0.5) {
      ctx.moveTo(x, yTop);
      ctx.lineTo(x + u * 0.25, yBot);
      ctx.lineTo(x + u * 0.5, yTop);
    }
    ctx.stroke();
    if (g.canopy) {
      // toll canopy: slab with per-lane signal lights
      ctx.fillStyle = '#26272a';
      ctx.fillRect(xL, yTop - u * 0.7, xR - xL, u * 0.8);
      ctx.fillStyle = 'rgba(255,220,170,0.18)';
      ctx.fillRect(xL, yBot - u * 0.05, xR - xL, u * 0.05);
      return;
    }
    for (const s of g.signs) {
      const x0 = this.px(s.X, g.z);
      const x1 = this.px(s.X + s.w, g.z);
      const y0 = this.py(g.z, g.h + 1.5);
      const y1 = this.py(g.z, g.h + 0.15);
      ctx.fillStyle = '#123a26';
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.strokeStyle = 'rgba(220,230,220,0.55)';
      ctx.lineWidth = Math.max(0.5, u * 0.025);
      ctx.strokeRect(x0 + u * 0.05, y0 + u * 0.05, x1 - x0 - u * 0.1, y1 - y0 - u * 0.1);
      // illegible legend
      ctx.fillStyle = 'rgba(225,232,225,0.6)';
      const lines = 2 + Math.floor(rng() * 2);
      for (let i = 0; i < lines; i++) {
        const lw = (x1 - x0) * range(rng, 0.35, 0.75);
        ctx.fillRect(x0 + (x1 - x0 - lw) / 2, y0 + (y1 - y0) * (0.25 + i * 0.22), lw, Math.max(1, u * 0.12));
      }
      // shield
      ctx.fillStyle = 'rgba(230,230,230,0.55)';
      ctx.fillRect(x0 + (x1 - x0) * 0.08, y0 + (y1 - y0) * 0.2, u * 0.25, u * 0.28);
    }
  }

  private drawOverpass(ctx: CanvasRenderingContext2D) {
    const o = this.L.overpass!;
    const { W } = this;
    const u = this.unit(o.z);
    const yTop = this.py(o.z, o.h + 1.0);
    const yBot = this.py(o.z, o.h);
    const g = ctx.createLinearGradient(0, yTop, 0, yBot);
    g.addColorStop(0, '#2e2c28');
    g.addColorStop(1, '#1b1a18');
    ctx.fillStyle = g;
    ctx.fillRect(0, yTop, W, yBot - yTop);
    ctx.fillStyle = '#3a3731';
    ctx.fillRect(0, yTop - u * 0.25, W, u * 0.25);
    // pillars
    ctx.fillStyle = '#211f1c';
    for (const X of [this.L.edgeL - 0.5, this.L.median, this.L.edgeR + 0.5]) {
      const x = this.px(X, o.z);
      ctx.fillRect(x - u * 0.3, yBot, u * 0.6, this.py(o.z) - yBot);
    }
    // underside shadow
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    this.quad(ctx, this.L.edgeL - 1, this.L.edgeR + 1, o.z - 0.6, o.z + 0.8);
    ctx.fill();
  }

  private drawTowers(ctx: CanvasRenderingContext2D) {
    const T = this.L.towers!;
    const L = this.L;
    const halfX = Math.max(Math.abs(L.edgeL), Math.abs(L.edgeR)) + T.X;
    const cableColor = 'rgba(120,110,105,0.75)';
    // main cables + suspenders on both sides
    const z0 = T.zs[0];
    const span2 = (T.zs[1] - T.zs[0]) / 2;
    const cableH = (z: number) => {
      if (z <= z0) {
        const half = z0 - 0.3;
        const u = (z - (z0 - half)) / half; // 0 at camera mid-span .. 1 at tower
        return 1.6 + (T.top - 1.6) * u * u;
      }
      const u = (z - (z0 + span2)) / span2;
      return 1.6 + (T.top - 1.6) * u * u;
    };
    for (const side of [-1, 1]) {
      const X = (side < 0 ? L.edgeL : L.edgeR) + side * T.X;
      ctx.strokeStyle = cableColor;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      let first = true;
      for (let z = 0.75; z < T.zs[1]; z *= 1.03) {
        const x = this.px(X, z);
        const y = this.py(z, cableH(z));
        if (first) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        first = false;
      }
      ctx.stroke();
      ctx.strokeStyle = 'rgba(110,100,95,0.35)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      for (let z = 0.9; z < T.zs[1]; z += z < 4 ? 0.35 : 1.2) {
        const x = this.px(X, z);
        ctx.moveTo(x, this.py(z, cableH(z)));
        ctx.lineTo(x, this.py(z, 0.4));
      }
      ctx.stroke();
      if (T.bayLights) {
        ctx.globalCompositeOperation = 'lighter';
        for (let z = 0.9; z < T.zs[1]; z += 0.9) {
          drawGlow(ctx, 'white', this.px(X, z), this.py(z, cableH(z) * 0.5), 1.2, 0.3);
        }
        ctx.globalCompositeOperation = 'source-over';
      }
    }
    // towers (two legs + portal beams), lit from below by the deck
    for (const zt of T.zs) {
      const u = this.unit(zt);
      for (const side of [-1, 1]) {
        const X = (side < 0 ? L.edgeL : L.edgeR) + side * T.X;
        const x = this.px(X, zt);
        const yB = this.py(zt, 0);
        const yT = this.py(zt, T.top + 2);
        const g = ctx.createLinearGradient(0, yB, 0, yT);
        g.addColorStop(0, '#4a3a33');
        g.addColorStop(0.25, '#2a221f');
        g.addColorStop(1, '#151213');
        ctx.fillStyle = g;
        ctx.fillRect(x - u * 0.45, yT, u * 0.9, yB - yT);
      }
      const xl = this.px(L.edgeL - T.X, zt);
      const xr = this.px(L.edgeR + T.X, zt);
      ctx.fillStyle = '#1d1819';
      for (const h of [T.top * 0.45, T.top * 0.7, T.top * 0.92]) {
        const y = this.py(zt, h);
        ctx.fillRect(xl, y, xr - xl, u * 0.9);
      }
      ctx.fillStyle = '#211b1b';
      ctx.fillRect(xl, this.py(zt, 0.25 * T.top), xr - xl, u * 0.6);
    }
  }

  private drawPortal(ctx: CanvasRenderingContext2D, rng: () => number) {
    const P = this.L.portal!;
    const L = this.L;
    const { W } = this;
    const z = P.z;
    const u = this.unit(z);
    const yG = this.py(z, 0);
    const yTop = this.py(z, 6.5);
    // hillside above the portal
    ctx.fillStyle = '#0a0c0a';
    ctx.beginPath();
    ctx.moveTo(0, yTop + u);
    for (let i = 0; i <= 20; i++) {
      const x = (i / 20) * W;
      ctx.lineTo(x, yTop - u * (2 + 6 * Math.sin((i / 20) * Math.PI)) - rng() * u * 1.2);
    }
    ctx.lineTo(W, yG);
    ctx.lineTo(0, yG);
    ctx.closePath();
    ctx.fill();
    // portal face
    const xL = this.px(L.edgeL - 2, z);
    const xR = this.px(L.edgeR + 2, z);
    const g = ctx.createLinearGradient(0, yTop, 0, yG);
    g.addColorStop(0, '#2a2723');
    g.addColorStop(1, '#3a342c');
    ctx.fillStyle = g;
    ctx.fillRect(xL, yTop, xR - xL, yG - yTop);
    // openings: one bore per direction
    const bores: Array<[number, number]> = [
      [L.edgeL - 0.1, L.median - 0.25],
      [L.median + 0.25, L.edgeR + 0.1],
    ];
    for (const [a, b] of bores) {
      const x0 = this.px(a, z);
      const x1 = this.px(b, z);
      const yo = this.py(z, 4.6);
      const r = (x1 - x0) / 2;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x0, yG);
      ctx.lineTo(x0, yo + r * 0.35);
      ctx.quadraticCurveTo(x0, yo - r * 0.2, x0 + r, yo - r * 0.25);
      ctx.quadraticCurveTo(x1, yo - r * 0.2, x1, yo + r * 0.35);
      ctx.lineTo(x1, yG);
      ctx.closePath();
      ctx.clip();
      // interior: warm sodium glow receding to a hot vanishing point
      const ix = this.px((a + b) / 2, 60);
      const iy = this.py(60, 2);
      const ig = ctx.createRadialGradient(ix, iy, 0, ix, iy, (x1 - x0) * 0.9);
      ig.addColorStop(0, 'rgba(255,190,110,0.95)');
      ig.addColorStop(0.25, 'rgba(150,95,45,0.8)');
      ig.addColorStop(1, 'rgba(40,28,18,1)');
      ctx.fillStyle = ig;
      ctx.fillRect(x0, yo - r, x1 - x0, yG - yo + r);
      // ceiling light rows
      ctx.globalCompositeOperation = 'lighter';
      for (let zz = z + 0.5; zz < 70; zz *= 1.06) {
        for (const X of [a + 0.4, b - 0.4]) {
          drawGlow(ctx, 'sodium', this.px(X, zz), this.py(zz, 4.2), Math.max(0.7, this.unit(zz) * 0.25), 0.6);
        }
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.restore();
    }
    // portal header lights
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 6; i++) {
      const x = xL + ((i + 0.5) / 6) * (xR - xL);
      drawGlow(ctx, 'sodium', x, this.py(z, 5.6), u * 0.35, 0.5);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  // per frame ----------------------------------------------------------------------------------
  render(ctx: CanvasRenderingContext2D, now: number) {
    const { W, H, L } = this;
    if (!this.staticLayer) this.staticLayer = this.buildStatic();
    this.frame++;
    const t = now / 1000;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.save();
    if (!this.image) {
      ctx.translate(W / 2, H / 2);
      ctx.rotate(L.roll);
      ctx.scale(1.03, 1.03);
      ctx.translate(-W / 2, -H / 2);
    }
    ctx.drawImage(this.staticLayer, 0, 0);
    if (!this.image) this.drawDynamic(ctx, t);
    ctx.restore();
    this.drawSensor(ctx, t);
  }

  private drawDynamic(ctx: CanvasRenderingContext2D, t: number) {
    const L = this.L;
    ctx.globalCompositeOperation = 'lighter';
    // lamp heads (one may buzz/flicker)
    for (let i = 0; i < L.lamps.length; i++) {
      const lamp = L.lamps[i];
      let a = 0.85;
      if (lamp.flicker) {
        const slot = Math.floor(t * 6);
        a = rand01(L.seed, slot, i) < 0.3 ? 0.25 : 0.85;
      }
      const u = this.unit(lamp.z);
      const x = this.px(lamp.X + lamp.arm, lamp.z);
      const y = this.py(lamp.z, lamp.h + 0.1);
      drawGlow(ctx, lamp.color === 'led' ? 'led' : 'sodium', x, y, Math.max(1.6, u * 0.9), a);
      drawGlow(ctx, lamp.color === 'led' ? 'led' : 'sodium', x, y, Math.max(3, u * 3), a * 0.18);
    }
    // aviation lights on towers (slow blink ~0.5 Hz)
    if (L.towers) {
      const on = Math.floor(t * 1) % 2 === 0;
      for (const zt of L.towers.zs) {
        for (const X of [L.edgeL - L.towers.X, L.edgeR + L.towers.X]) {
          drawGlow(ctx, 'red', this.px(X, zt), this.py(zt, L.towers.top + 2.2), Math.max(1.5, this.unit(zt) * 0.6), on ? 0.9 : 0.15);
        }
      }
      // water shimmer
      for (let i = 0; i < 18; i++) {
        const x = rand01(L.seed, i, 5) * this.W;
        const y = L.hy * this.H + Math.pow(rand01(L.seed, i, 6), 2) * this.H * 0.3 + 2;
        const a = 0.08 * (0.5 + 0.5 * Math.sin(t * (2 + i * 0.37) + i));
        ctx.globalAlpha = a;
        ctx.fillStyle = 'rgb(255,170,90)';
        ctx.fillRect(x, y, 3 + rand01(L.seed, i, 7) * 8, 1);
      }
    }
    // gantry sign lights
    if (L.gantry && !L.gantry.canopy) {
      for (const s of L.gantry.signs) {
        for (let k = 0; k < 3; k++) {
          const X = s.X + ((k + 0.5) / 3) * s.w;
          drawGlow(ctx, 'led', this.px(X, L.gantry.z), this.py(L.gantry.z, L.gantry.h + 0.05), Math.max(1, this.unit(L.gantry.z) * 0.15), 0.5);
        }
      }
    }
    if (L.gantry?.canopy) {
      for (const lane of L.lanes) {
        const green = rand01(lane.seed, Math.floor(t / 4)) < 0.75;
        drawGlow(ctx, green ? 'led' : 'red', this.px(lane.X, L.gantry.z), this.py(L.gantry.z, L.gantry.h + 0.4), Math.max(1.2, this.unit(L.gantry.z) * 0.3), 0.9);
      }
    }
    // traffic
    ctx.globalAlpha = 1;
    const zMin = 0.75;
    const R = L.zMax - zMin;
    const cars: Array<{ z: number; lane: (typeof L.lanes)[number]; truck: boolean; j: number }> = [];
    for (const lane of L.lanes) {
      for (let j = 0; j < lane.cars; j++) {
        const ph = (lane.phase + j / lane.cars + rand01(lane.seed, j) * 0.18) * R;
        const d = (t * lane.speed + ph) % R;
        const z = lane.dir > 0 ? zMin + d : L.zMax - d;
        if (L.portal && z > L.portal.z + 0.3 && z > 40) continue;
        cars.push({ z, lane, truck: rand01(lane.seed, j, 9) < 0.15, j });
      }
    }
    cars.sort((a, b) => b.z - a.z); // far to near
    for (const c of cars) this.drawVehicle(ctx, c.z, c.lane, c.truck, c.j, t);
    // overpass traffic (crossing horizontally)
    if (L.overpass) {
      const o = L.overpass;
      const y = this.py(o.z, o.h + 0.5);
      for (let j = 0; j < 4; j++) {
        const dir = j % 2 === 0 ? 1 : -1;
        const sp = this.W * 0.22;
        const x = (((t * sp * dir + rand01(L.seed, j, 44) * this.W * 2) % (this.W * 2)) + this.W * 2) % (this.W * 2) - this.W * 0.5;
        const u = this.unit(o.z);
        ctx.globalCompositeOperation = 'lighter';
        drawGlow(ctx, dir > 0 ? 'head' : 'tail', x, y, Math.max(1.4, u * 0.25), 0.9);
        drawGlow(ctx, dir > 0 ? 'head' : 'tail', x + u * 0.3 * -dir, y, Math.max(1.4, u * 0.22), 0.6);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  private drawVehicle(ctx: CanvasRenderingContext2D, z: number, lane: SimLayout['lanes'][number], truck: boolean, j: number, t: number) {
    const u = this.unit(z);
    const fog = clamp(1.25 - z / this.L.zMax);
    const half = 0.32;
    const yG = this.py(z, 0);
    const xC = this.px(lane.X, z);
    const lh = truck ? 0.4 : 0.28;
    // body (dark occluder), only meaningful up close
    if (z < 14) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 0.92 * fog;
      const bh = (truck ? 1.25 : 0.55) * u;
      const bw = 0.82 * u;
      ctx.fillStyle = truck ? '#232426' : '#121315';
      ctx.fillRect(xC - bw / 2, yG - bh - u * 0.08, bw, bh);
      if (!truck) {
        ctx.fillStyle = '#0c0d0e';
        ctx.fillRect(xC - bw * 0.34, yG - bh - u * 0.3, bw * 0.68, u * 0.26);
      }
      // headlight spill on the road ahead of approaching cars
      if (lane.dir < 0) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.save();
        ctx.translate(xC, yG + u * 0.5);
        ctx.scale(1, 0.35);
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, u * 1.6);
        g.addColorStop(0, 'rgba(255,240,210,0.22)');
        g.addColorStop(1, 'rgba(255,240,210,0)');
        ctx.fillStyle = g;
        ctx.globalAlpha = fog;
        ctx.fillRect(-u * 1.6, -u * 1.6, u * 3.2, u * 3.2);
        ctx.restore();
      }
    }
    ctx.globalCompositeOperation = 'lighter';
    const brake = lane.dir > 0 && rand01(lane.seed, j, Math.floor(t / 3)) < 0.15;
    const kind = lane.dir < 0 ? 'head' : 'tail';
    const r = Math.max(0.9, u * (lane.dir < 0 ? 0.32 : 0.2)) * (brake ? 1.35 : 1);
    const a = (lane.dir < 0 ? 1 : brake ? 1 : 0.8) * fog;
    for (const s of [-1, 1]) {
      const x = xC + s * half * u;
      const y = yG - lh * u;
      drawGlow(ctx, kind, x, y, r * (z < 3 ? 2.6 : 1.6), a);
      // wet-road reflection streak
      ctx.globalAlpha = 0.18 * a;
      ctx.fillStyle = lane.dir < 0 ? 'rgb(255,235,200)' : 'rgb(255,50,30)';
      ctx.fillRect(x - r * 0.35, y + r * 0.4, r * 0.7, r * 6);
    }
    if (z < 3 && lane.dir < 0) {
      // horizontal lens flare from a close pair of headlights
      ctx.globalAlpha = 0.18 * a;
      ctx.fillStyle = 'rgb(255,240,215)';
      ctx.fillRect(xC - u * 2.2, yG - lh * u - 0.5, u * 4.4, 1.2);
    }
    if (truck) {
      for (const s of [-1, 1]) drawGlow(ctx, 'amber', xC + s * 0.4 * u, yG - 1.32 * u, Math.max(0.7, u * 0.09), 0.8 * fog);
    }
    ctx.globalAlpha = 1;
  }

  /** sensor noise, compression blockiness, slight colour grading */
  private drawSensor(ctx: CanvasRenderingContext2D, t: number) {
    const { W, H } = this;
    const fi = this.frame;
    // grade: lift blacks a touch and push a cold cast into shadows
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(14,20,24,0.12)';
    ctx.fillRect(0, 0, W, H);
    // sensor noise
    const tiles = getGrainTiles();
    ctx.globalAlpha = 0.16;
    tileFill(ctx, tiles[(fi * 7) % tiles.length], 0, 0, W, H, 1, rand01(fi, 61) * 200, rand01(fi, 62) * 200);
    ctx.globalAlpha = 1;
    // macroblocking: a few 8×8 blocks replaced by their DC colour, clustered and drifting
    const tc = this.tctx;
    tc.imageSmoothingEnabled = true;
    tc.globalCompositeOperation = 'copy';
    tc.drawImage(ctx.canvas, 0, 0, this.tiny.width, this.tiny.height);
    ctx.imageSmoothingEnabled = false;
    const bw = this.tiny.width;
    const bh = this.tiny.height;
    const count = Math.floor(bw * bh * (0.03 + 0.03 * (0.5 + 0.5 * Math.sin(t * 0.7))));
    for (let i = 0; i < count; i++) {
      const cx = Math.floor(rand01(fi >> 1, i, 71) * bw);
      const cy = Math.floor(rand01(fi >> 1, i, 72) * bh);
      const sz = rand01(i, 73) < 0.25 ? 2 : 1;
      ctx.globalAlpha = 0.55;
      ctx.drawImage(this.tiny, cx, cy, sz, sz, cx * 8, cy * 8, sz * 8, sz * 8);
    }
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = true;
  }
}
