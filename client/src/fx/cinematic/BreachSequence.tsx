import { useRef, type CSSProperties } from 'react';
import { clamp, lerp, rand01 } from '../core/rng';
import { makeVignette } from '../core/noise';
import { FX_FONT_MONO, FX_FONT_SANS } from '../core/fonts';
import { CREATURE_SEED, getFaceSprite, getFigureSprite } from '../monster/creature';
import { tinted } from '../monster/manifest';
import { spriteFor } from '../monster/sprites';
import { ease, getCorridor, grainAndLines, seg, snow, tears, useCinematic, type CineFrame } from './common';
import { CinematicStyles } from './styles';

export interface BreachSequenceProps {
  hqName: string;
  onDone?: () => void;
}

/** Total length of the breach cinematic (onDone fires at this point; the last frame holds). */
export const BREACH_DURATION_MS = 6600;

// timeline (ms)
const T_STATIC = 380;
const T_FAR_END = 1500;
const T_MID = 1580;
const T_NEAR = 2120;
const T_LUNGE = 2500;
const T_RIP = 3550;
const T_RED = 3800;

let vig: { key: string; c: HTMLCanvasElement } | null = null;
function vignette(W: number, H: number) {
  const key = `${W}x${H}`;
  if (!vig || vig.key !== key) vig = { key, c: makeVignette(W, H, 1.1) };
  return vig.c;
}

function drawFigure(f: CineFrame, figH: number, feetY: number, alpha: number, snapped: boolean, eyes: number) {
  const spr = spriteFor('figure', 1);
  const fig = getFigureSprite(CREATURE_SEED, snapped ? 1 : 0);
  const src: HTMLCanvasElement = spr ? spr.img : fig.crisp;
  const aspect = spr ? spr.aspect : fig.aspect;
  const h = figH;
  const w = h * aspect;
  const x = f.W * 0.52 - w / 2;
  const y = feetY - h;
  const { ctx } = f;
  const jitter = f.reduced ? 0 : 2;
  const bands = 8;
  const layers: Array<[HTMLCanvasElement, number]> = spr ? [[spr.dark, 0.55], [src, 0.85]] : [[src, 1]];
  for (const [img, k] of layers) {
    ctx.globalAlpha = clamp(alpha * k);
    for (let b = 0; b < bands; b++) {
      const sy = (b / bands) * img.height;
      const sh = img.height / bands;
      const off = (rand01(f.fi >> 1, b, 7) - 0.5) * jitter * (h / f.H) * 4;
      ctx.drawImage(img, 0, sy, img.width, sh, x + off, y + (b / bands) * h, w, h / bands + 0.5);
    }
  }
  ctx.globalAlpha = 1;
  if (eyes > 0 && !spr) {
    ctx.globalCompositeOperation = 'lighter';
    for (const e of fig.eyes) {
      const ex = x + e.x * w;
      const ey = y + e.y * h;
      const r = Math.max(1, e.r * h * 2.4);
      const g = ctx.createRadialGradient(ex, ey, 0, ex, ey, r * 3);
      g.addColorStop(0, `rgba(235,245,235,${eyes})`);
      g.addColorStop(1, 'rgba(200,220,210,0)');
      ctx.fillStyle = g;
      ctx.fillRect(ex - r * 3, ey - r * 3, r * 6, r * 6);
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}

function drawFace(f: CineFrame, scale: number, alpha: number, distortion: number) {
  const spr = spriteFor('closeup', 0);
  const face = getFaceSprite(CREATURE_SEED);
  const { ctx, W, H } = f;
  // painted closeups are framed on their eyes and need more zoom to fill the frame
  const fh = H * scale * (spr ? 1.35 : 1);
  const fw = fh * (spr ? spr.aspect : face.aspect);
  const fx = spr ? spr.focusX : 0.5;
  const fy = spr ? spr.focusY : 0.5;
  const cx = W * 0.5 + (0.5 - fx) * fw + (f.reduced ? 0 : Math.sin(f.t / 70) * distortion * W * 0.004);
  const cy = H * (spr ? 0.42 : 0.47) + (0.5 - fy) * fh;
  const x = cx - fw / 2;
  const y = cy - fh / 2;
  const src: HTMLCanvasElement = spr ? spr.img : face.face;
  const bands = f.reduced ? 1 : 26;
  ctx.globalAlpha = clamp(alpha);
  for (let b = 0; b < bands; b++) {
    const sy = (b / bands) * src.height;
    const sh = src.height / bands;
    const r = rand01(f.fi, b, 13);
    const off = f.reduced ? 0 : (r - 0.5) * distortion * W * (r > 0.9 ? 0.12 : 0.025);
    ctx.drawImage(src, 0, sy, src.width, sh, x + off, y + (b / bands) * fh, fw, fh / bands + 0.6);
  }
  // chromatic split
  if (!f.reduced && distortion > 0) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = clamp(alpha * 0.22 * distortion);
    const off = W * 0.008 * (1 + distortion);
    const tint = tinted(src);
    ctx.drawImage(tint.r, x + off, y, fw, fh);
    ctx.drawImage(tint.c, x - off, y, fw, fh);
    ctx.globalCompositeOperation = 'source-over';
  }
  // eye shine (painted closeups have their own)
  ctx.globalCompositeOperation = 'lighter';
  for (const e of spr ? [] : face.eyes) {
    const ex = x + e.x * fw;
    const ey = y + e.y * fh;
    const r = fh * 0.012;
    const g = ctx.createRadialGradient(ex, ey, 0, ex, ey, r * 6);
    g.addColorStop(0, `rgba(240,250,240,${0.95 * alpha})`);
    g.addColorStop(0.2, `rgba(200,225,210,${0.35 * alpha})`);
    g.addColorStop(1, 'rgba(180,210,200,0)');
    ctx.globalAlpha = 1;
    ctx.fillStyle = g;
    ctx.fillRect(ex - r * 6, ey - r * 6, r * 12, r * 12);
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}

function drawBreachFrame(f: CineFrame) {
  const { ctx, W, H, t } = f;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  if (t < T_STATIC) {
    snow(f, 0.95 * ease.outCubic(t / T_STATIC));
    if (!f.reduced) {
      for (let i = 0; i < 5; i++) {
        ctx.fillStyle = `rgba(230,235,240,${0.15 + 0.3 * rand01(f.fi, i, 1)})`;
        ctx.fillRect(0, rand01(f.fi, i, 2) * H, W, 1 + rand01(f.fi, i, 3) * 3);
      }
    }
  } else if (t < T_RIP) {
    // the HQ corridor camera
    const flick = f.reduced ? 1 : 0.88 + 0.12 * Math.sin(t / 190) * Math.sin(t / 330);
    ctx.globalAlpha = flick;
    ctx.drawImage(getCorridor(W, H), 0, 0);
    ctx.globalAlpha = 1;
    let snowA = 0.25;
    if (t < T_FAR_END) {
      const k = seg(t, T_STATIC, 1400);
      drawFigure(f, H * 0.3, H * 0.535, seg(t, 620, 1400) * 0.85, false, 0.35 * k);
      snowA = 0.95 - 0.6 * k;
    } else if (t < T_NEAR) {
      drawFigure(f, H * 0.64, H * 0.8, 0.95, false, 0.5);
      snowA = 0.35;
      if (t < T_MID) tears(f, 10, 0.12);
    } else if (t < T_LUNGE) {
      drawFigure(f, H * 1.3, H * 1.16, 1, true, 0.75);
      snowA = 0.3;
      if (t < T_NEAR + 80) tears(f, 12, 0.14);
    } else {
      const k = seg(t, T_LUNGE, T_RIP - 100);
      const scale = f.reduced ? 1.25 : lerp(0.95, 2.3, ease.inCubic(k));
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(0, 0, W, H);
      drawFace(f, scale, f.reduced ? seg(t, T_LUNGE, T_LUNGE + 400) : 1, 0.4 + 1.2 * k);
      // vertical hold slip (≤ 2/s)
      if (!f.reduced && Math.floor((t - T_LUNGE) / 450) % 2 === 1 && (t - T_LUNGE) % 450 < 70) {
        ctx.drawImage(ctx.canvas, 0, 0, W, H, 0, -H * 0.12, W, H);
      }
      tears(f, 2 + Math.floor(k * 8), 0.04 + 0.12 * k);
      snowA = 0.2 + 0.25 * k;
    }
    // emergency lighting creeping in
    const red = seg(t, T_NEAR, T_RIP) * 0.3;
    if (red > 0) {
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = `rgba(255,${Math.round(255 - 170 * red)},${Math.round(255 - 180 * red)},1)`;
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';
    }
    snow(f, snowA);
  } else if (t < T_RED) {
    const k = seg(t, T_RIP, T_RED);
    drawFace(f, 2.3, 1 - k, 1.6);
    tears(f, 14, 0.25);
    ctx.fillStyle = `rgba(0,0,0,${k})`;
    ctx.fillRect(0, 0, W, H);
    snow(f, 0.15 * (1 - k));
  } else {
    // red alarm wash — slow pulse (0.8 Hz), steady when reduced motion
    const k = seg(t, T_RED, T_RED + 600);
    const pulse = f.reduced ? 0.85 : 0.72 + 0.28 * (0.5 + 0.5 * Math.sin(((t - T_RED) / 1000) * Math.PI * 2 * 0.8 - Math.PI / 2));
    const g = ctx.createRadialGradient(W / 2, H * 0.45, 0, W / 2, H * 0.45, Math.hypot(W, H) * 0.6);
    g.addColorStop(0, `rgba(150,14,20,${0.85 * k * pulse})`);
    g.addColorStop(0.6, `rgba(70,4,8,${0.9 * k * pulse})`);
    g.addColorStop(1, `rgba(12,0,0,${k})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // the face lingers as an afterimage
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = 0.5 * k;
    const cu = spriteFor('closeup', 0);
    const face = getFaceSprite(CREATURE_SEED);
    const img: HTMLCanvasElement = cu ? cu.img : face.face;
    const asp = cu ? cu.aspect : face.aspect;
    const fh = H * (cu ? 2.1 : 1.5);
    const fx = cu ? cu.focusX : 0.5;
    const fy = cu ? cu.focusY : 0.5;
    ctx.drawImage(img, W / 2 - fx * fh * asp, H * 0.42 - fy * fh, fh * asp, fh);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    snow(f, 0.05);
  }
  grainAndLines(f, 0.22, 0.16);
  ctx.drawImage(vignette(W, H), 0, 0);
}

const layer: CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%' };

/** Full-screen cinematic played on a monster breach (~6.6 s). Calls onDone at the end; the final frame holds. */
export function BreachSequence({ hqName, onDone }: BreachSequenceProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useCinematic(canvasRef, drawBreachFrame, BREACH_DURATION_MS, onDone, 640);
  const d = (ms: number) => `${ms}ms`;
  return (
    <div role="alertdialog" aria-label={`Security breach at ${hqName}`} className="fx-cine" style={{ position: 'fixed', inset: 0, zIndex: 9999, background: '#000', overflow: 'hidden' }}>
      <CinematicStyles />
      <canvas ref={canvasRef} style={{ ...layer, display: 'block', imageRendering: 'auto' }} />
      <div style={{ ...layer, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1.2rem', pointerEvents: 'none', padding: '0 16px', textAlign: 'center' }}>
        <div className="fx-cine-rule" style={{ animationDelay: d(T_RED + 150), width: 'min(560px, 70vw)', height: 1, background: 'rgba(224,74,98,0.7)' }} />
        <h1
          className="fx-cine-title"
          style={{
            animationDelay: d(T_RED + 200),
            margin: 0,
            fontFamily: FX_FONT_SANS,
            fontWeight: 700,
            fontSize: 'clamp(22px, 5.4vw, 84px)',
            color: '#f4e9ea',
            textShadow: '0.04em 0 0 rgba(255,40,50,0.55), -0.04em 0 0 rgba(0,200,255,0.25), 0 0 0.6em rgba(200,30,40,0.6)',
            lineHeight: 1,
          }}
        >
          SECURITY BREACH
        </h1>
        <div
          className="fx-cine-fade"
          style={{ animationDelay: d(T_RED + 650), fontFamily: FX_FONT_MONO, fontWeight: 500, fontSize: 'clamp(13px, 1.9vw, 26px)', letterSpacing: '0.42em', color: '#e04a62', textTransform: 'uppercase' }}
        >
          — {hqName}
        </div>
        <div className="fx-cine-rule" style={{ animationDelay: d(T_RED + 300), width: 'min(560px, 70vw)', height: 1, background: 'rgba(224,74,98,0.7)' }} />
        <div style={{ fontFamily: FX_FONT_MONO, fontSize: 'clamp(10px, 1vw, 13px)', letterSpacing: '0.3em', color: 'rgba(230,120,130,0.85)', display: 'grid', gap: '0.5em', marginTop: '0.6rem' }}>
          <span className="fx-cine-type" style={{ animationDelay: d(T_RED + 1100) }}>PERIMETER COMPROMISED</span>
          <span className="fx-cine-type" style={{ animationDelay: d(T_RED + 1500) }}>ALL FEEDS LOST</span>
          <span className="fx-cine-type" style={{ animationDelay: d(T_RED + 1900), color: 'rgba(255,170,175,0.95)' }}>CONTAINMENT FAILED</span>
        </div>
      </div>
    </div>
  );
}
