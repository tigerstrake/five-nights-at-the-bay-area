// Finds the imagery element rendered underneath an overlay (snapshot <img>, <video>, or our
// SimulatedFeed <canvas>) so distortions can re-draw displaced copies of it. Cross-origin images
// are only drawn (which merely taints the canvas) — pixels are never read back.

export type SourceEl = HTMLImageElement | HTMLVideoElement | HTMLCanvasElement;

export interface SourceInfo {
  el: SourceEl;
  nw: number;
  nh: number;
  /** Where the full source image lands, in overlay canvas pixels. */
  dx: number;
  dy: number;
  dw: number;
  dh: number;
  /** True when the source changes over time (video / simulated canvas). */
  animated: boolean;
}

function naturalSize(el: SourceEl): [number, number] {
  if (el instanceof HTMLImageElement) return el.complete ? [el.naturalWidth, el.naturalHeight] : [0, 0];
  if (el instanceof HTMLVideoElement) return el.readyState >= 2 ? [el.videoWidth, el.videoHeight] : [0, 0];
  return [el.width, el.height];
}

export function findSourceElement(overlayRoot: HTMLElement): SourceEl | null {
  const parent = overlayRoot.parentElement;
  if (!parent) return null;
  const marked = parent.querySelector<SourceEl>('[data-fx-source]');
  if (marked && !overlayRoot.contains(marked)) return marked;
  const candidates = parent.querySelectorAll<SourceEl>('img, video, canvas');
  for (const c of candidates) {
    if (overlayRoot.contains(c) || c.hasAttribute('data-fx-own')) continue;
    return c;
  }
  return null;
}

/** Measure where the source's full image is drawn, relative to the overlay, in canvas px. */
export function measureSource(el: SourceEl, overlayRoot: HTMLElement, canvasScale: number): SourceInfo | null {
  const [nw, nh] = naturalSize(el);
  if (!nw || !nh) return null;
  const o = overlayRoot.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  const fit = getComputedStyle(el).objectFit || 'fill';
  let w = r.width;
  let h = r.height;
  let x = r.left;
  let y = r.top;
  if (fit === 'cover' || fit === 'contain' || fit === 'scale-down') {
    const sCover = Math.max(r.width / nw, r.height / nh);
    const sContain = Math.min(r.width / nw, r.height / nh);
    const s = fit === 'cover' ? sCover : fit === 'contain' ? sContain : Math.min(1, sContain);
    w = nw * s;
    h = nh * s;
    x = r.left + (r.width - w) / 2;
    y = r.top + (r.height - h) / 2;
  } else if (fit === 'none') {
    w = nw;
    h = nh;
    x = r.left + (r.width - w) / 2;
    y = r.top + (r.height - h) / 2;
  }
  return {
    el,
    nw,
    nh,
    dx: (x - o.left) * canvasScale,
    dy: (y - o.top) * canvasScale,
    dw: w * canvasScale,
    dh: h * canvasScale,
    animated: !(el instanceof HTMLImageElement),
  };
}

/** Draw the horizontal band [y, y+h) of the source (canvas px) shifted horizontally by `shift`. */
export function drawSourceBand(
  ctx: CanvasRenderingContext2D,
  s: SourceInfo,
  y: number,
  h: number,
  shift: number,
  srcYOffset = 0,
): void {
  const y0 = Math.max(y, s.dy);
  const y1 = Math.min(y + h, s.dy + s.dh);
  if (y1 - y0 < 0.5) return;
  const ky = s.nh / s.dh;
  let sy = (y0 - s.dy + srcYOffset) * ky;
  let sh = (y1 - y0) * ky;
  sy = Math.max(0, Math.min(s.nh - 1, sy));
  sh = Math.max(0.5, Math.min(s.nh - sy, sh));
  try {
    ctx.drawImage(s.el, 0, sy, s.nw, sh, s.dx + shift, y0, s.dw, y1 - y0);
  } catch {
    /* source not decodable this frame */
  }
}

export function drawSourceFull(ctx: CanvasRenderingContext2D, s: SourceInfo, ox = 0, oy = 0): void {
  try {
    ctx.drawImage(s.el, s.dx + ox, s.dy + oy, s.dw, s.dh);
  } catch {
    /* ignore */
  }
}
