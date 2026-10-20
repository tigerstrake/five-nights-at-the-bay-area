import { useRef, type CSSProperties } from 'react';
import { FX_FONT_MONO } from '../core/fonts';
import { rand01 } from '../core/rng';
import { seg, snow, useCinematic, type CineFrame } from './common';

export interface SignalLostTransitionProps {
  /** default 900 ms */
  durationMs?: number;
  onDone?: () => void;
  /** position: fixed full-screen instead of filling the (relative) parent */
  fixed?: boolean;
  /** optional caption, e.g. "SIGNAL LOST" */
  label?: string;
}

/** Generic transition: tear → snow → CRT collapse to a line → black. */
export function SignalLostTransition({ durationMs = 900, onDone, fixed, label }: SignalLostTransitionProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const D = durationMs;
  const draw = (f: CineFrame) => {
    const { ctx, W, H, t } = f;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, W, H);
    const a = seg(t, 0, D * 0.15);
    const collapse = seg(t, D * 0.5, D * 0.85);
    const fade = seg(t, D * 0.85, D);
    ctx.fillStyle = `rgba(0,0,0,${0.4 + 0.6 * a})`;
    ctx.fillRect(0, 0, W, H);
    // static, squeezing vertically into a bright line
    const h = Math.max(2, H * (1 - collapse * collapse));
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, (H - h) / 2, W, h);
    ctx.clip();
    snow(f, 0.85 * a * (1 - fade));
    if (!f.reduced) {
      for (let i = 0; i < 4; i++) {
        ctx.fillStyle = `rgba(230,235,240,${0.15 * rand01(f.fi, i)})`;
        ctx.fillRect(0, rand01(f.fi, i, 2) * H, W, 2);
      }
    }
    ctx.restore();
    if (collapse > 0 && fade < 1) {
      const lw = W * (1 - fade);
      const g = ctx.createLinearGradient((W - lw) / 2, 0, (W + lw) / 2, 0);
      g.addColorStop(0, 'rgba(220,230,235,0)');
      g.addColorStop(0.5, `rgba(235,240,245,${0.8 * collapse * (1 - fade)})`);
      g.addColorStop(1, 'rgba(220,230,235,0)');
      ctx.fillStyle = g;
      ctx.fillRect((W - lw) / 2, H / 2 - 1, lw, 2);
    }
  };
  useCinematic(canvasRef, draw, D, onDone, 480);
  const style: CSSProperties = { position: fixed ? 'fixed' : 'absolute', inset: 0, zIndex: fixed ? 9998 : undefined, pointerEvents: 'none', overflow: 'hidden' };
  return (
    <div style={style} aria-hidden={label ? undefined : true}>
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }} />
      {label ? (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontFamily: FX_FONT_MONO, letterSpacing: '0.3em', fontSize: 'clamp(10px, 1.4vw, 16px)', color: '#cfd5da' }}>{label}</div>
      ) : null}
    </div>
  );
}
