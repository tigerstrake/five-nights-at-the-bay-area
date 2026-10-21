// Greedy label placement with collision avoidance. Works in screen pixels (so it is resolution independent)
// and returns positions in map units. Each label tries a ring of candidate offsets around its anchor, nearest
// first; far placements get a leader line. Lower-priority labels that cannot be placed cleanly are dropped.

export interface LabelRequest {
  id: string;
  text: string;
  /** Anchor in map units. */
  x: number;
  y: number;
  /** Clearance around the anchor, px. */
  r: number;
  /** Font size, px. */
  size: number;
  mono?: boolean;
  /** Higher = placed first. */
  priority: number;
  /** Must be shown even if it overlaps something (otherwise it may be dropped). */
  required?: boolean;
  /** Preferred direction (radians, screen space, 0 = east, π/2 = south). */
  prefer?: number;
  /** Letter spacing, px. */
  tracking?: number;
}

export interface PlacedLabel extends LabelRequest {
  /** Text anchor point (start of text box, baseline-ish centre) in map units. */
  lx: number;
  ly: number;
  anchor: 'start' | 'middle' | 'end';
  leader: boolean;
  /** Box in map units (for debugging / backgrounds). */
  box: { x: number; y: number; w: number; h: number };
}

export interface Obstacle {
  x: number;
  y: number;
  /** Radius in px. */
  r: number;
  /** Optional box size in px (centred on x/y) instead of a radius. */
  w?: number;
  h?: number;
}

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function textWidthPx(text: string, size: number, mono = false, tracking = 0): number {
  // Inter ≈ 0.56em per glyph on average; IBM Plex Mono = 0.6em.
  return text.length * (size * (mono ? 0.6 : 0.56) + tracking);
}

const overlap = (a: Rect, b: Rect) => !(a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0);
const area = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

/**
 * @param k   pixels per map unit
 * @param bounds visible area in map units (labels are kept inside it)
 */
export function placeLabels(
  reqs: LabelRequest[],
  obstacles: Obstacle[],
  k: number,
  bounds: { x: number; y: number; w: number; h: number },
): PlacedLabel[] {
  const placed: Rect[] = [];
  const obs: Rect[] = obstacles.map((o) => {
    const x = o.x * k, y = o.y * k;
    const hw = o.w !== undefined ? o.w / 2 : o.r, hh = o.h !== undefined ? o.h / 2 : o.r;
    return { x0: x - hw, y0: y - hh, x1: x + hw, y1: y + hh };
  });
  const B = { x0: bounds.x * k + 2, y0: bounds.y * k + 2, x1: (bounds.x + bounds.w) * k - 2, y1: (bounds.y + bounds.h) * k - 2 };
  const out: PlacedLabel[] = [];
  const sorted = [...reqs].sort((a, b) => b.priority - a.priority);
  const PAD = 2;
  const dirs = 16;

  for (const q of sorted) {
    const w = textWidthPx(q.text, q.size, q.mono, q.tracking) + PAD * 2;
    const h = q.size * 1.25 + PAD;
    const ax = q.x * k, ay = q.y * k;
    let best: { rect: Rect; cost: number; lx: number; ly: number; anchor: PlacedLabel['anchor']; leader: boolean } | null = null;
    const rings = [q.r + 3, q.r + 3 + h * 1.2, q.r + 3 + h * 2.6];
    for (let ri = 0; ri < rings.length; ri++) {
      const d = rings[ri]!;
      for (let i = 0; i < dirs; i++) {
        const base = q.prefer ?? -Math.PI / 2; // default: above
        // alternate around the preferred direction: 0, +1, -1, +2, -2 ...
        const step = Math.ceil(i / 2) * (i % 2 ? 1 : -1);
        const ang = base + (step * 2 * Math.PI) / dirs;
        const cx = ax + Math.cos(ang) * d;
        const cy = ay + Math.sin(ang) * d;
        const c = Math.cos(ang);
        // box attaches to the candidate point on its near side
        const anchor: PlacedLabel['anchor'] = c > 0.38 ? 'start' : c < -0.38 ? 'end' : 'middle';
        const x0 = anchor === 'start' ? cx : anchor === 'end' ? cx - w : cx - w / 2;
        const s = Math.sin(ang);
        const y0 = s > 0.38 ? cy : s < -0.38 ? cy - h : cy - h / 2;
        const rect = { x0, y0, x1: x0 + w, y1: y0 + h };
        let cost = ri * 40 + Math.abs(step) * 2;
        if (rect.x0 < B.x0 || rect.y0 < B.y0 || rect.x1 > B.x1 || rect.y1 > B.y1) cost += 5000;
        for (const p of placed) if (overlap(rect, p)) cost += 1000 + area(rect, p);
        for (const o of obs) if (overlap(rect, o)) cost += 300 + area(rect, o) * 0.5;
        if (!best || cost < best.cost) {
          const lx = anchor === 'start' ? x0 + PAD : anchor === 'end' ? x0 + w - PAD : x0 + w / 2;
          best = { rect, cost, lx, ly: y0 + h / 2, anchor, leader: ri > 0 };
        }
        if (cost < 1 + ri * 40) break;
      }
      if (best && best.cost < 300) break;
    }
    if (!best) continue;
    if (best.cost >= 300 && !q.required) continue;
    placed.push(best.rect);
    out.push({
      ...q,
      lx: best.lx / k,
      ly: best.ly / k,
      anchor: best.anchor,
      leader: best.leader,
      box: { x: best.rect.x0 / k, y: best.rect.y0 / k, w: (best.rect.x1 - best.rect.x0) / k, h: (best.rect.y1 - best.rect.y0) / k },
    });
  }
  return out;
}
