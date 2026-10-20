// Shared plumbing for full-screen cinematics: low-res canvas (gritty, cheap), timeline clock,
// procedural HQ security corridor, and static/tear helpers.
import { useEffect, useRef } from 'react';
import { ctx2d, getGrainTiles, getScanlineTile, getSnowTiles, makeCanvas, makeVignette, tileFill } from '../core/noise';
import { clamp, mulberry32, rand01 } from '../core/rng';
import { addFxTask } from '../core/scheduler';
import { isReducedMotion } from '../core/settings';

export interface CineFrame {
  ctx: CanvasRenderingContext2D;
  W: number;
  H: number;
  /** ms since start */
  t: number;
  fi: number;
  reduced: boolean;
}

/** Drive a canvas with a timeline. Calls onDone once after durationMs (timer-based, so it fires even if hidden). */
export function useCinematic(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  draw: (f: CineFrame) => void,
  durationMs: number,
  onDone?: () => void,
  internalWidth = 640,
) {
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = ctx2d(canvas);
    const start = performance.now();
    let fi = 0;
    const measure = () => {
      const r = canvas.getBoundingClientRect();
      const W = Math.max(64, Math.min(internalWidth, Math.round(r.width)));
      const H = Math.max(36, Math.round((W * r.height) / Math.max(1, r.width)));
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(canvas);
    const remove = addFxTask({
      el: canvas,
      fps: () => 60,
      render: (now) => {
        fi++;
        drawRef.current({ ctx, W: canvas.width, H: canvas.height, t: now - start, fi, reduced: isReducedMotion() });
      },
    });
    const timer = window.setTimeout(() => doneRef.current?.(), durationMs);
    return () => {
      remove();
      ro.disconnect();
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

// ---------------------------------------------------------------------------------------------

const corridorCache = new Map<string, HTMLCanvasElement>();

/** A dim fluorescent security corridor seen from a ceiling camera, door at the far end. */
export function getCorridor(W: number, H: number, tint: 'neutral' | 'cyan' = 'neutral'): HTMLCanvasElement {
  const key = `${W}x${H}:${tint}`;
  const hit = corridorCache.get(key);
  if (hit) return hit;
  const c = makeCanvas(W, H);
  const x = ctx2d(c);
  const rng = mulberry32(0xc0221d);
  const vx = W * 0.52;
  const vy = H * 0.42;
  const farW = W * 0.11;
  const farH = H * 0.2;
  const fx0 = vx - farW / 2;
  const fx1 = vx + farW / 2;
  const fy0 = vy - farH / 2;
  const fy1 = vy + farH / 2;
  x.fillStyle = '#0b0c0d';
  x.fillRect(0, 0, W, H);
  const poly = (pts: number[][], fill: string | CanvasGradient) => {
    x.beginPath();
    x.moveTo(pts[0][0], pts[0][1]);
    for (const p of pts.slice(1)) x.lineTo(p[0], p[1]);
    x.closePath();
    x.fillStyle = fill;
    x.fill();
  };
  // floor
  const fg = x.createLinearGradient(0, fy1, 0, H);
  fg.addColorStop(0, '#2a2d2b');
  fg.addColorStop(1, '#161817');
  poly([[fx0, fy1], [fx1, fy1], [W * 1.05, H], [-W * 0.05, H]], fg);
  // ceiling
  const cg = x.createLinearGradient(0, 0, 0, fy0);
  cg.addColorStop(0, '#151718');
  cg.addColorStop(1, '#2a2d2e');
  poly([[-W * 0.05, 0], [W * 1.05, 0], [fx1, fy0], [fx0, fy0]], cg);
  // walls
  const wl = x.createLinearGradient(0, 0, fx0, 0);
  wl.addColorStop(0, '#363b39');
  wl.addColorStop(1, '#222524');
  poly([[-W * 0.05, 0], [fx0, fy0], [fx0, fy1], [-W * 0.05, H]], wl);
  const wr = x.createLinearGradient(W, 0, fx1, 0);
  wr.addColorStop(0, '#323735');
  wr.addColorStop(1, '#1f2221');
  poly([[W * 1.05, 0], [fx1, fy0], [fx1, fy1], [W * 1.05, H]], wr);
  // end wall + door
  x.fillStyle = '#1e2120';
  x.fillRect(fx0, fy0, farW, farH);
  x.fillStyle = '#080909';
  x.fillRect(vx - farW * 0.2, fy0 + farH * 0.25, farW * 0.4, farH * 0.75);
  x.fillStyle = 'rgba(200,40,30,0.8)';
  x.fillRect(vx - farW * 0.06, fy0 + farH * 0.12, farW * 0.12, farH * 0.05); // exit sign
  // fluorescent panels receding along the ceiling; a couple dead
  for (let i = 0; i < 9; i++) {
    const d = Math.pow(0.72, i);
    const cx = vx;
    const cy = fy0 - (fy0 - -H * 0.15) * d;
    const pw = W * 0.18 * d + farW * 0.1;
    const ph = H * 0.035 * d + 1;
    const dead = i === 3 || rng() < 0.12;
    x.fillStyle = dead ? '#1e2120' : 'rgba(220,235,228,0.85)';
    x.fillRect(cx - pw / 2, cy, pw, ph);
    if (!dead) {
      const g = x.createRadialGradient(cx, cy + ph, 0, cx, cy + ph, pw * 1.4);
      g.addColorStop(0, 'rgba(170,200,190,0.28)');
      g.addColorStop(1, 'rgba(170,200,190,0)');
      x.fillStyle = g;
      x.fillRect(cx - pw * 1.4, cy - pw * 0.5, pw * 2.8, pw * 2);
      // floor reflection
      const fy = fy1 + (H - fy1) * (1 - d) * 0.9;
      const rg = x.createRadialGradient(cx, fy, 0, cx, fy, pw * 0.7);
      rg.addColorStop(0, 'rgba(160,190,180,0.16)');
      rg.addColorStop(1, 'rgba(160,190,180,0)');
      x.fillStyle = rg;
      x.fillRect(cx - pw, fy - pw * 0.3, pw * 2, pw * 0.6);
    }
  }
  // wall doors / panels
  for (let i = 1; i < 6; i++) {
    const d = Math.pow(0.7, i);
    for (const side of [-1, 1]) {
      const ex = side < 0 ? fx0 - (fx0 + W * 0.05) * d : fx1 + (W * 1.05 - fx1) * d;
      const top = fy0 - (fy0) * d * 0.8;
      const bot = fy1 + (H - fy1) * d * 0.85;
      x.strokeStyle = 'rgba(0,0,0,0.45)';
      x.lineWidth = Math.max(1, 3 * d);
      x.beginPath();
      x.moveTo(ex, top);
      x.lineTo(ex, bot);
      x.stroke();
    }
  }
  if (tint === 'cyan') {
    x.globalCompositeOperation = 'multiply';
    x.fillStyle = '#9fd8d8';
    x.fillRect(0, 0, W, H);
    x.globalCompositeOperation = 'source-over';
  }
  x.drawImage(makeVignette(W, H, 1), 0, 0);
  corridorCache.set(key, c);
  return c;
}

export function snow(f: CineFrame, alpha: number) {
  if (alpha <= 0.005) return;
  const tiles = getSnowTiles();
  f.ctx.globalAlpha = clamp(alpha);
  tileFill(f.ctx, tiles[f.fi % tiles.length], 0, 0, f.W, f.H, Math.max(1, f.W / 700), rand01(f.fi, 3) * 500, rand01(f.fi, 4) * 500);
  f.ctx.globalAlpha = 1;
}

export function grainAndLines(f: CineFrame, grain = 0.2, lines = 0.14) {
  const tiles = getGrainTiles();
  f.ctx.globalAlpha = grain;
  tileFill(f.ctx, tiles[f.fi % tiles.length], 0, 0, f.W, f.H, 1, rand01(f.fi, 8) * 300, rand01(f.fi, 9) * 300);
  f.ctx.globalAlpha = 1;
  tileFill(f.ctx, getScanlineTile(2, lines), 0, 0, f.W, f.H, 1, 0, 0);
}

let tearBuf: HTMLCanvasElement | null = null;
/** Re-draw random horizontal bands of the current frame displaced sideways. */
export function tears(f: CineFrame, count: number, maxShift: number) {
  if (count <= 0 || f.reduced) return;
  if (!tearBuf) tearBuf = makeCanvas(f.W, f.H);
  if (tearBuf.width !== f.W || tearBuf.height !== f.H) {
    tearBuf.width = f.W;
    tearBuf.height = f.H;
  }
  const tb = ctx2d(tearBuf);
  tb.globalCompositeOperation = 'copy';
  tb.drawImage(f.ctx.canvas, 0, 0);
  for (let i = 0; i < count; i++) {
    const y = rand01(f.fi, i, 1) * f.H;
    const h = (0.01 + 0.07 * rand01(f.fi, i, 2)) * f.H;
    const dx = (rand01(f.fi, i, 3) - 0.5) * 2 * maxShift * f.W;
    f.ctx.fillStyle = '#000';
    f.ctx.fillRect(0, y, f.W, h);
    f.ctx.drawImage(tearBuf, 0, y, f.W, h, dx, y, f.W, h);
  }
}

export const ease = {
  inCubic: (x: number) => x * x * x,
  outCubic: (x: number) => 1 - Math.pow(1 - x, 3),
  inOut: (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
};

export const seg = (t: number, a: number, b: number) => clamp((t - a) / (b - a));
