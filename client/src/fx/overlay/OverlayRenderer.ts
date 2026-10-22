// Per-feed overlay renderer (Canvas 2D). Two stacked canvases:
//   base — normal blending: displaced source bands, monster, static, grain, scanlines, vignette
//   add  — CSS mix-blend-mode: screen: chromatic fringe, colour bleed, rolling bar, eye-shine
// Driven by the shared scheduler; never allocates a WebGL context.
import type { FeedFxParams, PlacementRegion } from '../index';
import { ctx2d, getGrainTiles, getInterlaceTile, getScanlineTile, getSnowTiles, makeCanvas, makeVignette, tileFill } from '../core/noise';
import { clamp, rand01, smoothstep } from '../core/rng';
import { fxNow, isReducedMotion } from '../core/settings';
import { drawSourceBand, drawSourceFull, findSourceElement, measureSource, type SourceEl, type SourceInfo } from '../core/source';
import { drawManifestation, type FrameRect } from '../monster/manifest';
import { SceneProber, sunElevationDeg } from '../monster/grade';

/** Timeline of the sabotage transition (ms after the status flips to 'sabotaged'). */
export const SABOTAGE_TEAR_MS = 450;
export const SABOTAGE_LOST_MS = 1300;

interface Tear {
  y: number;
  h: number;
  dx: number;
  until: number;
}

const FPS_THUMB = 20;
const FPS_MAIN = 30;

export class OverlayRenderer {
  readonly root: HTMLDivElement;
  private base: HTMLCanvasElement;
  private add: HTMLCanvasElement;
  private b: CanvasRenderingContext2D;
  private a: CanvasRenderingContext2D;
  private params: FeedFxParams;
  reducedOverride: boolean | null = null;

  private W = 0;
  private H = 0;
  private k = 1; // canvas px per CSS px
  private frameIndex = 0;
  private statusChangedAt: number;
  private lastPerf = 0;

  private sourceEl: SourceEl | null = null;
  private source: SourceInfo | null = null;
  private lastScan = -1e9;
  private lastMeasure = -1e9;
  private srcPlacementRaw: string | null = null;
  private prober = new SceneProber();
  private mediaFrame = 0;
  private lastMediaTime = -1;
  private lastMediaKey = '';
  private srcPlacement: PlacementRegion[] | null = null;

  private tears: Tear[] = [];
  private jitterUntil = 0;
  private interlaceUntil = 0;
  private interlaceDx = 0;
  private holdUntil = 0;

  private frameBuf: HTMLCanvasElement;
  private fctx: CanvasRenderingContext2D;
  private tmp: HTMLCanvasElement;
  private tctx: CanvasRenderingContext2D;
  private fringeR: HTMLCanvasElement;
  private fringeC: HTMLCanvasElement;
  private fringeKey = '';
  private fringeAt = 0;
  private vignette: HTMLCanvasElement | null = null;

  constructor(root: HTMLDivElement, base: HTMLCanvasElement, add: HTMLCanvasElement, params: FeedFxParams) {
    this.root = root;
    this.base = base;
    this.add = add;
    this.b = ctx2d(base);
    this.a = ctx2d(add);
    this.params = params;
    // mounted already-sabotaged feeds skip straight to SIGNAL LOST
    this.statusChangedAt = performance.now() - 1e6;
    this.frameBuf = makeCanvas(16, 16);
    this.fctx = ctx2d(this.frameBuf);
    this.tmp = makeCanvas(16, 16);
    this.tctx = ctx2d(this.tmp);
    this.fringeR = makeCanvas(8, 8);
    this.fringeC = makeCanvas(8, 8);
  }

  fps(): number {
    return this.params.variant === 'main' ? FPS_MAIN : FPS_THUMB;
  }

  setParams(p: FeedFxParams): void {
    if (p.gameStatus !== this.params.gameStatus) {
      this.statusChangedAt = performance.now();
      this.holdUntil = 0;
    }
    this.params = p;
  }

  resize(cssW: number, cssH: number): void {
    const main = this.params.variant === 'main';
    const dpr = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, main ? 1.5 : 1);
    const maxW = main ? 1600 : 520;
    let k = dpr;
    if (cssW * k > maxW) k = maxW / Math.max(1, cssW);
    const W = Math.max(2, Math.round(cssW * k));
    const H = Math.max(2, Math.round(cssH * k));
    if (W === this.W && H === this.H) return;
    this.W = W;
    this.H = H;
    this.k = k;
    for (const c of [this.base, this.add, this.frameBuf, this.tmp]) {
      c.width = W;
      c.height = H;
    }
    this.fringeR.width = this.fringeC.width = Math.max(2, Math.round(W / 2));
    this.fringeR.height = this.fringeC.height = Math.max(2, Math.round(H / 2));
    this.fringeKey = '';
    this.vignette = makeVignette(W, H, 0.85);
    this.lastMeasure = -1e9;
  }

  private reduced(): boolean {
    return this.reducedOverride ?? isReducedMotion();
  }

  private updateSource(perf: number) {
    if (perf - this.lastScan > 1000 || (this.sourceEl && !this.sourceEl.isConnected)) {
      this.lastScan = perf;
      const el = findSourceElement(this.root);
      if (el !== this.sourceEl) {
        this.sourceEl = el;
        this.source = null;
        this.lastMeasure = -1e9;
        this.fringeKey = '';
        this.prober.reset();
      }
    }
    if (this.sourceEl && (perf - this.lastMeasure > 500 || !this.source)) {
      this.lastMeasure = perf;
      this.source = measureSource(this.sourceEl, this.root, this.k);
      const raw = this.sourceEl.getAttribute('data-fx-placement');
      if (raw !== this.srcPlacementRaw) {
        this.srcPlacementRaw = raw;
        try {
          const v = raw ? (JSON.parse(raw) as PlacementRegion[]) : null;
          this.srcPlacement = Array.isArray(v) && v.length ? v : null;
        } catch {
          this.srcPlacement = null;
        }
      }
    } else if (!this.sourceEl) {
      this.srcPlacement = null;
      this.srcPlacementRaw = null;
    }
  }

  render(perf: number): void {
    const W = this.W;
    const H = this.H;
    if (W < 4 || H < 4) return;
    const dt = this.lastPerf ? Math.min(0.25, (perf - this.lastPerf) / 1000) : 1 / this.fps();
    this.lastPerf = perf;
    const p = this.params;
    const reduced = this.reduced();
    const statusAge = perf - this.statusChangedAt;
    // frame hold: leave the previous frame on screen
    if (perf < this.holdUntil) return;

    this.frameIndex++;
    const fi = this.frameIndex;
    const b = this.b;
    const a = this.a;
    b.setTransform(1, 0, 0, 1, 0, 0);
    a.setTransform(1, 0, 0, 1, 0, 0);
    b.globalCompositeOperation = 'source-over';
    a.globalCompositeOperation = 'source-over';
    b.globalAlpha = 1;
    a.globalAlpha = 1;
    b.clearRect(0, 0, W, H);
    a.clearRect(0, 0, W, H);
    this.updateSource(perf);
    const src = this.source;
    const frame: FrameRect = src ? { x: src.dx, y: src.dy, w: src.dw, h: src.dh } : { x: 0, y: 0, w: W, h: H };
    const t = perf / 1000;

    if (p.sourceMode === 'offline') {
      this.drawDeadFrame('#07080a', 0.07, t, fi);
      this.finish(0.2, t, fi, reduced);
      return;
    }
    if (p.gameStatus === 'blackout') {
      this.drawDeadFrame('#000', 0.025, t, fi);
      this.drawScanlines(0.06);
      return;
    }
    if (p.gameStatus === 'sabotaged' && statusAge >= SABOTAGE_LOST_MS) {
      this.drawDeadFrame('#020203', 0.09, t, fi);
      this.drawRollingBar(t, 0.6, true);
      this.finish(0.4, t, fi, reduced);
      return;
    }

    // --- monster ------------------------------------------------------------------------------
    const scene = this.sampleScene(perf, !!p.manifestation);
    const mres = drawManifestation(p.manifestation, this.srcPlacement ?? p.placement, {
      base: b,
      add: a,
      frame,
      now: fxNow(),
      reduced,
      px: this.k * Math.max(1, W / (this.k * 640)),
      frameIndex: fi,
      sceneLum: scene?.mean ?? 0.3,
      scene,
      mediaFrame: this.mediaFrame,
      visible: { x: 0, y: 0, w: W, h: H },
      sim: p.sourceMode === 'simulated',
      video: p.sourceMode !== 'simulated' && src?.el instanceof HTMLVideoElement,
    });

    let I = clamp(p.interference);
    I = Math.max(I, mres.boost);
    let snow = 0;
    let repairRoll = -1;
    if (p.gameStatus === 'static') {
      I = Math.max(I, 0.6);
      snow = 0.8;
    } else if (p.gameStatus === 'sabotaged') {
      if (statusAge < SABOTAGE_TEAR_MS) {
        I = 1;
        snow = 0.7 * smoothstep(0, SABOTAGE_TEAR_MS, statusAge);
      } else {
        I = 1;
        snow = 0.96;
      }
    } else if (p.gameStatus === 'repairing') {
      const q = clamp(p.repairProgress ?? 0);
      I = Math.max(I, 0.55 * (1 - q));
      snow = 0.08 + 0.6 * Math.pow(1 - q, 1.4);
      if (q < 0.97) repairRoll = q;
    }
    const sab = p.gameStatus === 'sabotaged';

    // --- schedule distortion events ----------------------------------------------------------
    const rm = reduced ? 0.35 : 1;
    const tearRate = (0.12 + 7 * I * I) * (sab ? 4 : 1) * (reduced ? 0.4 : 1);
    if (Math.random() < tearRate * dt) {
      const n = 1 + Math.floor(Math.random() * (1 + I * 3));
      for (let i = 0; i < n; i++) {
        const big = Math.random() < I * 0.4;
        this.tears.push({
          y: Math.random() * H,
          h: H * (0.006 + (big ? 0.12 : 0.04) * Math.random() * (0.3 + I)),
          dx: (Math.random() < 0.5 ? -1 : 1) * W * (0.003 + (big ? 0.09 : 0.025) * I * Math.random()) * rm,
          until: perf + 40 + Math.random() * (60 + 160 * I),
        });
      }
    }
    for (const [ty, th] of mres.tears) {
      this.tears.push({ y: ty, h: Math.max(2, th), dx: (Math.random() - 0.5) * W * 0.05 * rm, until: perf + 50 });
    }
    this.tears = this.tears.filter((tr) => tr.until > perf);
    if (!reduced) {
      if (I > 0.3 && perf > this.jitterUntil && Math.random() < 0.5 * I * dt) this.jitterUntil = perf + 120 + Math.random() * 260;
      if (I > 0.4 && perf > this.interlaceUntil && Math.random() < 0.6 * I * dt) {
        this.interlaceUntil = perf + 150 + Math.random() * 280;
        this.interlaceDx = (2 + Math.random() * 4) * this.k * (Math.random() < 0.5 ? -1 : 1);
      }
    }
    const jitter = perf < this.jitterUntil;
    const interlace = perf < this.interlaceUntil;
    const needFrame = !!src && (this.tears.length > 0 || jitter || interlace || repairRoll >= 0);

    // --- displaced copies of (source + monster) -------------------------------------------------
    if (needFrame && src) {
      const f = this.fctx;
      f.globalCompositeOperation = 'copy';
      f.globalAlpha = 1;
      f.fillStyle = '#000';
      f.fillRect(0, 0, W, H);
      f.globalCompositeOperation = 'source-over';
      drawSourceFull(f, src);
      f.drawImage(this.base, 0, 0);
      const fb = this.frameBuf;
      if (repairRoll >= 0) {
        const q = repairRoll;
        const speed = H * (0.25 + 1.6 * Math.pow(1 - q, 1.6));
        const off = (t * speed) % H;
        const wob = reduced ? 0 : Math.sin(t * 11) * 3 * this.k * (1 - q);
        b.globalCompositeOperation = 'copy';
        b.drawImage(fb, wob, off - H);
        b.globalCompositeOperation = 'source-over';
        b.drawImage(fb, wob, off);
        // vertical blanking bar rolling through
        const barH = H * 0.07;
        const by = off - barH;
        b.fillStyle = '#000';
        b.fillRect(0, by, W, barH);
        const g = b.createLinearGradient(0, by - barH * 0.6, 0, by);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(1, 'rgba(0,0,0,0.6)');
        b.fillStyle = g;
        b.fillRect(0, by - barH * 0.6, W, barH * 0.6);
        a.fillStyle = 'rgba(255,255,255,0.10)';
        a.fillRect(0, off - 2 * this.k, W, 2 * this.k);
      }
      if (jitter) {
        const rows = this.params.variant === 'main' ? 72 : 36;
        const rh = H / rows;
        const amp = 2.2 * this.k * (0.5 + I);
        for (let r = 0; r < rows; r++) {
          const dx = (rand01(fi, r, 3) - 0.5) * 2 * amp;
          b.clearRect(0, r * rh, W, rh + 1);
          b.drawImage(fb, 0, r * rh, W, rh + 1, dx, r * rh, W, rh + 1);
        }
      }
      for (const tr of this.tears) {
        const y = Math.max(0, tr.y);
        const h = Math.min(H - y, tr.h);
        if (h < 1) continue;
        b.fillStyle = '#030303';
        b.fillRect(0, y, W, h);
        b.drawImage(fb, 0, y, W, h, tr.dx, y, W, h);
        // the bright sync edge of a tear
        if (Math.abs(tr.dx) > W * 0.01) {
          a.fillStyle = `rgba(230,235,240,${0.08 + 0.18 * I})`;
          a.fillRect(0, y, W, Math.max(1, this.k));
        }
      }
      if (interlace) {
        const tc = this.tctx;
        tc.globalCompositeOperation = 'copy';
        tc.drawImage(fb, this.interlaceDx, 0);
        tc.globalCompositeOperation = 'destination-in';
        tileFill(tc, getInterlaceTile(), 0, 0, W, H, Math.max(1, Math.round(this.k)), 0, 0);
        tc.globalCompositeOperation = 'source-over';
        b.globalAlpha = 0.55;
        b.drawImage(this.tmp, 0, 0);
        b.globalAlpha = 1;
      }
    } else if (!src && this.tears.length && p.manifestation) {
      // no source available: tear just the monster layer
      const f = this.fctx;
      f.globalCompositeOperation = 'copy';
      f.drawImage(this.base, 0, 0);
      f.globalCompositeOperation = 'source-over';
      for (const tr of this.tears) {
        b.clearRect(0, tr.y, W, tr.h);
        b.drawImage(this.frameBuf, 0, tr.y, W, tr.h, tr.dx, tr.y, W, tr.h);
      }
    }

    // --- static wash ------------------------------------------------------------------------------
    if (snow > 0.01) this.drawSnow(snow, t, fi, p.gameStatus === 'static', reduced);
    else if (I > 0.5) this.drawSnow((I - 0.5) * 0.4, t, fi, false, reduced);

    // sabotage: bright tear storm edge lines on the additive layer
    if (sab && statusAge < SABOTAGE_TEAR_MS && !reduced) {
      for (let i = 0; i < 6; i++) {
        const y = rand01(fi, i, 91) * H;
        a.fillStyle = `rgba(220,228,235,${0.1 + 0.2 * rand01(fi, i, 92)})`;
        a.fillRect(0, y, W, (1 + rand01(fi, i, 93) * 3) * this.k);
      }
    }

    // --- chromatic fringe / colour bleed ---------------------------------------------------------
    if (src && !sab) this.drawFringe(src, I, perf, reduced);

    // --- luminance pumping (AGC hunting), well below 3 Hz ---------------------------------------
    if (I > 0.05) {
      const freq = reduced ? 0.25 : 0.7;
      const amp = I * (reduced ? 0.06 : 0.2);
      const wave = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * freq) * Math.sin(t * 1.7 + 0.6);
      b.fillStyle = `rgba(0,0,0,${clamp(amp * wave)})`;
      b.fillRect(0, 0, W, H);
      a.fillStyle = `rgba(255,255,255,${clamp(amp * 0.25 * (1 - wave))})`;
      a.fillRect(0, 0, W, H);
    }

    this.drawRollingBar(t, I, false);
    this.finish(I, t, fi, reduced);

    // --- frame hold (freeze for a moment) -----------------------------------------------------
    if (!reduced && I > 0.35 && p.gameStatus !== 'sabotaged' && Math.random() < 0.22 * I * dt) {
      this.holdUntil = perf + 90 + Math.random() * 230;
      if (src?.animated) {
        b.globalCompositeOperation = 'destination-over';
        drawSourceFull(b, src);
        b.globalCompositeOperation = 'source-over';
      }
    }
  }

  /**
   * Scene probe of the source picture (only when pixels are readable: blob / same-origin stills, MSE video, our
   * simulated canvas). Also advances `mediaFrame` when the picture itself changes, so the creature's matched noise
   * and shimmer follow real video frames and stay frozen on a still.
   */
  private sampleScene(perf: number, active: boolean) {
    const src = this.source;
    if (!src) return null;
    const el = src.el;
    if (el instanceof HTMLVideoElement) {
      if (el.currentTime !== this.lastMediaTime) {
        this.lastMediaTime = el.currentTime;
        this.mediaFrame++;
      }
    } else if (el instanceof HTMLImageElement) {
      const key = el.currentSrc || el.src;
      if (key !== this.lastMediaKey) {
        this.lastMediaKey = key;
        this.mediaFrame++;
      }
    } else {
      this.mediaFrame = this.frameIndex;
    }
    if (!active) this.prober.resetMotion();
    // Real feeds are current (stills ≤ 5 min, video ~30 s behind): the sun decides day vs night. A source may carry
    // an explicit hint (data-fx-daylight, 0..1; the FX lab uses it for archived frames). Simulated scenes: image only.
    const hint = el.getAttribute('data-fx-daylight');
    const h = hint !== null && hint !== '' ? Number(hint) : NaN;
    this.prober.daylight = Number.isFinite(h)
      ? clamp(h)
      : this.params.sourceMode === 'simulated'
        ? null
        : smoothstep(-6, 4, sunElevationDeg(fxNow()));
    return this.prober.update(el, src.nw, src.nh, perf, active);
  }

  /** grain + scanlines + vignette, always last so everything sits inside the image */
  private finish(I: number, t: number, fi: number, reduced: boolean) {
    const b = this.b;
    const tiles = getGrainTiles();
    const gs = clamp(this.W / 720, 1, 2.4);
    b.globalAlpha = clamp(0.13 + 0.2 * I);
    tileFill(b, tiles[fi % tiles.length], 0, 0, this.W, this.H, gs, rand01(fi, 1) * 400, rand01(fi, 2) * 400);
    b.globalAlpha = 1;
    this.drawScanlines(0.11 + 0.08 * I);
    if (this.vignette) b.drawImage(this.vignette, 0, 0);
    void t;
    void reduced;
  }

  private drawScanlines(alpha: number) {
    const period = Math.max(2, Math.round(this.H / 270));
    tileFill(this.b, getScanlineTile(period, Math.round(clamp(alpha) * 50) / 50), 0, 0, this.W, this.H, 1, 0, 0);
  }

  private drawDeadFrame(bg: string, snowAlpha: number, t: number, fi: number) {
    const b = this.b;
    b.fillStyle = bg;
    b.fillRect(0, 0, this.W, this.H);
    if (snowAlpha > 0) {
      const tiles = getSnowTiles();
      b.globalAlpha = snowAlpha;
      tileFill(b, tiles[fi % tiles.length], 0, 0, this.W, this.H, clamp(this.W / 900, 1, 1.6), rand01(fi, 5) * 500, rand01(fi, 6) * 500);
      b.globalAlpha = 1;
    }
    void t;
  }

  private drawSnow(alpha: number, t: number, fi: number, remnants: boolean, reduced: boolean) {
    const b = this.b;
    const tiles = getSnowTiles();
    const tile = tiles[fi % tiles.length];
    const sc = clamp(this.W / 900, 1, 1.6);
    const ox = rand01(fi, 21) * 600;
    const oy = rand01(fi, 22) * 600;
    if (!remnants) {
      b.globalAlpha = clamp(alpha);
      tileFill(b, tile, 0, 0, this.W, this.H, sc, ox, oy);
      b.globalAlpha = 1;
      return;
    }
    // static with signal remnants: horizontal bands where the picture bleeds through,
    // plus a slow "attempting sync" breath (≤ 0.6 Hz)
    const strips = this.params.variant === 'main' ? 30 : 16;
    const sh = this.H / strips;
    const breath = reduced ? 0 : 0.12 * Math.max(0, Math.sin(t * 2.2)) ** 6;
    for (let i = 0; i < strips; i++) {
      const y = i * sh;
      const w1 = Math.sin(i * 0.55 + t * 1.3) * Math.sin(i * 0.21 - t * 0.7);
      const rem = Math.max(0, w1) ** 3;
      const al = clamp(alpha - 0.42 * rem - breath + 0.06 * (rand01(fi, i, 23) - 0.5));
      b.globalAlpha = al;
      b.save();
      b.beginPath();
      b.rect(0, y, this.W, sh + 1);
      b.clip();
      tileFill(b, tile, 0, y, this.W, sh + 1, sc, ox + i * 37, oy);
      b.restore();
    }
    b.globalAlpha = 1;
  }

  private drawFringe(src: SourceInfo, I: number, perf: number, reduced: boolean) {
    const key = `${src.nw}x${src.nh}:${Math.round(src.dx)},${Math.round(src.dy)},${Math.round(src.dw)}:${src.el instanceof HTMLImageElement ? src.el.currentSrc : ''}`;
    if (key !== this.fringeKey || (src.animated && perf - this.fringeAt > 90)) {
      this.fringeKey = key;
      this.fringeAt = perf;
      const fw = this.fringeR.width;
      const fh = this.fringeR.height;
      const sx = fw / this.W;
      for (const [c, col] of [
        [this.fringeR, '#ff2010'],
        [this.fringeC, '#00c8ff'],
      ] as const) {
        const x = ctx2d(c);
        x.globalCompositeOperation = 'copy';
        x.fillStyle = '#000';
        x.fillRect(0, 0, fw, fh);
        x.globalCompositeOperation = 'source-over';
        try {
          x.drawImage(src.el, src.dx * sx, src.dy * sx, src.dw * sx, src.dh * sx);
        } catch {
          /* ignore */
        }
        x.globalCompositeOperation = 'multiply';
        x.fillStyle = col;
        x.fillRect(0, 0, fw, fh);
        x.globalCompositeOperation = 'source-over';
      }
    }
    // compose into tmp, then knock out wherever the base layer already covers the picture
    // (monster, static, black bands) so the fringe never re-adds the underlying image on top.
    const t = this.tctx;
    t.globalCompositeOperation = 'copy';
    t.globalAlpha = 1;
    t.clearRect(0, 0, this.W, this.H);
    t.globalCompositeOperation = 'source-over';
    const off = (1.1 + (reduced ? 2 : 6) * I) * this.k;
    t.globalAlpha = clamp(0.13 + 0.2 * I);
    t.drawImage(this.fringeR, off, 0, this.W, this.H);
    t.drawImage(this.fringeC, -off * 0.8, 0, this.W, this.H);
    if (I > 0.45 && !reduced) {
      // colour bleed: a smeared red ghost trailing to the right
      t.globalAlpha = clamp((I - 0.45) * 0.35);
      t.drawImage(this.fringeR, off * 3.5, 0, this.W * 1.01, this.H);
    }
    t.globalAlpha = 1;
    t.globalCompositeOperation = 'destination-out';
    t.drawImage(this.base, 0, 0);
    t.globalCompositeOperation = 'source-over';
    this.a.drawImage(this.tmp, 0, 0);
  }

  private drawRollingBar(t: number, I: number, dead: boolean) {
    const H = this.H;
    const W = this.W;
    const period = 9 - 4 * I;
    const pos = ((t / period) % 1) * (H * 1.4) - H * 0.2;
    const bh = H * 0.22;
    const g = this.a.createLinearGradient(0, pos - bh, 0, pos + bh);
    const al = (dead ? 0.05 : 0.025) + 0.07 * I;
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, `rgba(255,255,255,${al})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    this.a.fillStyle = g;
    this.a.fillRect(0, pos - bh, W, bh * 2);
    const g2 = this.b.createLinearGradient(0, pos + bh * 0.6, 0, pos + bh * 1.6);
    g2.addColorStop(0, 'rgba(0,0,0,0)');
    g2.addColorStop(0.5, `rgba(0,0,0,${al * 1.2})`);
    g2.addColorStop(1, 'rgba(0,0,0,0)');
    this.b.fillStyle = g2;
    this.b.fillRect(0, pos + bh * 0.6, W, bh);
  }
}
