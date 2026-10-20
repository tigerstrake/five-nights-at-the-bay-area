import { useRef, type CSSProperties } from 'react';
import { clamp, rand01 } from '../core/rng';
import { ctx2d, getGrainTiles, makeCanvas, makeVignette, tileFill } from '../core/noise';
import { FX_FONT_MONO, FX_FONT_SANS } from '../core/fonts';
import { CREATURE_SEED, getFigureSprite } from '../monster/creature';
import { spriteFor } from '../monster/sprites';
import { getCorridor, grainAndLines, seg, snow, tears, useCinematic, type CineFrame } from './common';
import { CinematicStyles } from './styles';

export interface ContainmentSequenceProps {
  hqName?: string;
  onDone?: () => void;
}

export const CONTAINMENT_DURATION_MS = 5600;

let scratch: HTMLCanvasElement | null = null;
let vig: HTMLCanvasElement | null = null;

function drawContainment(f: CineFrame) {
  const { ctx, W, H, t } = f;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  // signal settles out of static
  const settle = seg(t, 0, 900);
  ctx.globalAlpha = settle;
  ctx.drawImage(getCorridor(W, H, 'cyan'), 0, 0);
  ctx.globalAlpha = 1;

  // the creature, pinned in place and dissolving into the noise floor
  const spr = spriteFor('figure', 1);
  const fig = getFigureSprite(CREATURE_SEED, 0);
  const body: HTMLCanvasElement = spr ? spr.img : fig.crisp;
  const h = H * 0.6;
  const w = h * (spr ? spr.aspect : fig.aspect);
  const x = W * 0.52 - w / 2;
  const y = H * 0.79 - h;
  const dissolve = seg(t, 1500, 3800);
  if (dissolve < 1) {
    if (!scratch || scratch.width !== body.width || scratch.height !== body.height) scratch = makeCanvas(body.width, body.height);
    const s = ctx2d(scratch);
    s.globalCompositeOperation = 'copy';
    s.drawImage(body, 0, 0);
    s.globalCompositeOperation = 'destination-out';
    const tiles = getGrainTiles();
    for (let i = 0; i < 1 + Math.floor(dissolve * 6); i++) {
      s.globalAlpha = clamp(0.35 + dissolve * 0.65);
      tileFill(s, tiles[(f.fi + i) % tiles.length], 0, 0, scratch.width, scratch.height, 1 + i, rand01(f.fi, i) * 200, rand01(f.fi, i, 1) * 200);
    }
    s.globalAlpha = 1;
    s.globalCompositeOperation = 'source-over';
    const strain = f.reduced ? 0 : (1 - dissolve) * 3;
    const bands = 12;
    ctx.globalAlpha = settle * (1 - dissolve * 0.6);
    for (let b = 0; b < bands; b++) {
      const sy = (b / bands) * scratch.height;
      const sh = scratch.height / bands;
      const off = (rand01(f.fi >> 1, b, 5) - 0.5) * strain * (b % 3 === 0 ? 3 : 1);
      ctx.drawImage(scratch, 0, sy, scratch.width, sh, x + off, y + (b / bands) * h, w, h / bands + 0.5);
    }
    ctx.globalAlpha = 1;
  }
  // containment field: cyan bands sweeping over the subject, tightening
  const field = seg(t, 600, 1400) * (1 - seg(t, 4200, 5200));
  if (field > 0) {
    ctx.globalCompositeOperation = 'lighter';
    const cx = W * 0.52;
    for (let i = 0; i < 3; i++) {
      const ph = ((t / 1000) * (f.reduced ? 0.15 : 0.45) + i / 3) % 1;
      const yy = y + h * ph;
      const g = ctx.createLinearGradient(0, yy - 6, 0, yy + 6);
      g.addColorStop(0, 'rgba(60,200,214,0)');
      g.addColorStop(0.5, `rgba(60,200,214,${0.35 * field})`);
      g.addColorStop(1, 'rgba(60,200,214,0)');
      ctx.fillStyle = g;
      ctx.fillRect(cx - w * 1.1, yy - 6, w * 2.2, 12);
    }
    ctx.strokeStyle = `rgba(80,220,230,${0.45 * field})`;
    ctx.lineWidth = 1;
    const pad = w * (0.9 - 0.25 * seg(t, 800, 2600));
    const bx = cx - pad;
    const by = y - h * 0.06;
    const bw = pad * 2;
    const bh = h * 1.1;
    const c = Math.min(bw, bh) * 0.12;
    ctx.beginPath();
    for (const [px, py, dx, dy] of [
      [bx, by, 1, 1],
      [bx + bw, by, -1, 1],
      [bx, by + bh, 1, -1],
      [bx + bw, by + bh, -1, -1],
    ]) {
      ctx.moveTo(px + dx * c, py);
      ctx.lineTo(px, py);
      ctx.lineTo(px, py + dy * c);
    }
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  }
  if (t > 1500 && t < 1600) tears(f, 6, 0.05);
  snow(f, 0.9 * (1 - settle) + 0.08 + 0.12 * dissolve * (1 - dissolve) * 4 * 0.5);
  // calm cool grade toward the end
  const calm = seg(t, 3600, 5000);
  if (calm > 0) {
    ctx.fillStyle = `rgba(4,18,22,${0.55 * calm})`;
    ctx.fillRect(0, 0, W, H);
  }
  grainAndLines(f, 0.18, 0.14);
  if (!vig || vig.width !== W || vig.height !== H) vig = makeVignette(W, H, 1);
  ctx.drawImage(vig, 0, 0);
}

const layer: CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%' };

/** Quieter defender-win cinematic: the subject is pinned by the containment field and dissolves. */
export function ContainmentSequence({ hqName, onDone }: ContainmentSequenceProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useCinematic(canvasRef, drawContainment, CONTAINMENT_DURATION_MS, onDone, 640);
  return (
    <div role="alertdialog" aria-label="Subject contained" className="fx-cine" style={{ position: 'fixed', inset: 0, zIndex: 9999, background: '#000', overflow: 'hidden' }}>
      <CinematicStyles />
      <canvas ref={canvasRef} style={{ ...layer, display: 'block' }} />
      <div style={{ ...layer, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', paddingBottom: '12vh', gap: '0.9rem', pointerEvents: 'none', textAlign: 'center' }}>
        <div className="fx-cine-rule" style={{ animationDelay: '3300ms', width: 'min(440px, 60vw)', height: 1, background: 'rgba(59,198,214,0.6)' }} />
        <h1 className="fx-cine-title" style={{ animationDelay: '3400ms', margin: 0, fontFamily: FX_FONT_SANS, fontWeight: 600, fontSize: 'clamp(22px, 4.2vw, 60px)', color: '#d9f3f5', textShadow: '0 0 0.7em rgba(59,198,214,0.45)', lineHeight: 1 }}>
          SUBJECT CONTAINED
        </h1>
        {hqName ? (
          <div className="fx-cine-fade" style={{ animationDelay: '3900ms', fontFamily: FX_FONT_MONO, fontSize: 'clamp(11px, 1.5vw, 20px)', letterSpacing: '0.38em', color: '#3bc6d6', textTransform: 'uppercase' }}>
            {hqName} — secure
          </div>
        ) : null}
        <div style={{ fontFamily: FX_FONT_MONO, fontSize: 'clamp(10px, 0.95vw, 12px)', letterSpacing: '0.28em', color: 'rgba(120,200,205,0.75)', display: 'flex', gap: '2.2em', marginTop: '0.4rem' }}>
          <span className="fx-cine-type" style={{ animationDelay: '4300ms' }}>FIELD STABLE</span>
          <span className="fx-cine-type" style={{ animationDelay: '4600ms' }}>FEEDS NOMINAL</span>
        </div>
      </div>
    </div>
  );
}
