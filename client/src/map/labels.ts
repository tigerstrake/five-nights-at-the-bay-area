// Greedy label placement with collision avoidance, in screen pixels (resolution independent); results are
// returned in map units. Labels are placed by priority. Each tries its text variants (full name, then the
// short form) on a ring of 16 candidate positions around its anchor (preferred side first), then further
// out with a leader line. A candidate pays for overlapping placed labels (prohibitive), node / glyph
// obstacles, corridor lines it covers, and leaving the visible (inset-aware) viewport (never allowed).
// Optional labels that cannot be placed cleanly are dropped; required ones take the least bad spot.

export interface LabelRequest {
  id: string;
  /** Text candidates, preferred first (e.g. full name, short name). */
  texts: string[];
  /** Anchor in map units. */
  x: number;
  y: number;
  /** Clearance around the anchor, px. */
  r: number;
  /** Font size, px. */
  size: number;
  mono?: boolean;
  /** Font weight hint for width estimation (600+ is wider). */
  weight?: number;
  /** Letter spacing, px. */
  tracking?: number;
  /** Optional second line under the main text (e.g. a door state). */
  sub?: { text: string; size: number; mono?: boolean; tracking?: number; parts?: Array<{ text: string; color: string }> };
  /** Higher = placed first. */
  priority: number;
  /** Must be shown even if it overlaps something (otherwise it may be dropped). */
  required?: boolean;
  /** Preferred direction (radians, screen space, 0 = east, π/2 = south). */
  prefer?: number;
  /** Fixed placement centred on the anchor (shields, water / region labels): no alternatives. */
  fixed?: boolean;
  /** Fixed labels only: rotation in degrees (bridge names along a span). */
  rotate?: number;
  /** Fixed labels only: fallback anchor positions (map units), tried in order. */
  alts?: Array<{ x: number; y: number }>;
  /** Corridor ids this label may sit on without penalty (a shield on its own line). */
  ownSegments?: string;
  /** Penalise spots that sit nearer another anchor than this one (node names). */
  unambiguous?: boolean;
}

export interface PlacedLabel extends LabelRequest {
  /** Chosen text. */
  text: string;
  /** Index of the chosen text variant. */
  variant: number;
  /** Text anchor point (horizontal anchor, vertical centre of the first line) in map units. */
  lx: number;
  ly: number;
  anchor: 'start' | 'middle' | 'end';
  leader: boolean;
  /** Box in map units. */
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
  /** Cost multiplier (default 1). */
  weight?: number;
}

/** A line segment in map units that labels should avoid (corridors). */
export interface SegmentObstacle {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Half width in px. */
  hw: number;
  /** Owner id (labels with matching ownSegments ignore it). */
  owner?: string;
}

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// Average advance widths (em) measured for the bundled faces at UI sizes.
const EM = { sans: 0.555, sansBold: 0.585, mono: 0.6 };
export function textWidthPx(text: string, size: number, mono = false, tracking = 0, weight = 500): number {
  const em = mono ? EM.mono : weight >= 600 ? EM.sansBold : EM.sans;
  // narrow glyphs (i, l, t, punctuation, spaces) are common in place names
  let n = 0;
  for (const ch of text) n += /[iljtf.,'’\s|/!:;]/.test(ch) ? 0.55 : /[mwMW]/.test(ch) ? 1.45 : /[A-Z]/.test(ch) ? 1.18 : 1;
  return mono ? text.length * (size * em + tracking) : n * size * em + text.length * tracking;
}

const overlap = (a: Rect, b: Rect) => !(a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0);
const area = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

/** Does segment (px) intersect rect (px)? Liang–Barsky clip. */
function segHitsRect(x1: number, y1: number, x2: number, y2: number, r: Rect): boolean {
  let t0 = 0, t1 = 1;
  const dx = x2 - x1, dy = y2 - y1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1 - r.x0, r.x1 - x1, y1 - r.y0, r.y1 - y1];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i]! < 0) return false;
    } else {
      const t = q[i]! / p[i]!;
      if (p[i]! < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
    }
  }
  return true;
}

export function boxSize(q: LabelRequest, text: string): { w: number; h: number } {
  // horizontal padding keeps neighbouring names from reading as one string
  const PAD = q.fixed ? 1.5 : 3.5;
  let w = textWidthPx(text, q.size, q.mono, q.tracking, q.weight);
  let h = q.size * 1.18;
  if (q.sub) {
    w = Math.max(w, textWidthPx(q.sub.text, q.sub.size, q.sub.mono, q.sub.tracking));
    h += q.sub.size * 1.25;
  }
  return { w: w + PAD * 2, h: h + PAD };
}

/**
 * @param k      pixels per map unit
 * @param bounds visible area in map units (labels are kept inside it)
 */
export function placeLabels(
  reqs: LabelRequest[],
  obstacles: Obstacle[],
  k: number,
  bounds: { x: number; y: number; w: number; h: number },
  segments: SegmentObstacle[] = [],
  /** Anchors that labels must not appear to belong to (other nodes), map units. */
  anchors: Array<{ x: number; y: number }> = [],
): PlacedLabel[] {
  const anc = anchors.map((a) => ({ x: a.x * k, y: a.y * k }));
  const rectDist = (r: Rect, x: number, y: number) => Math.hypot(Math.max(r.x0 - x, 0, x - r.x1), Math.max(r.y0 - y, 0, y - r.y1));
  const placed: Rect[] = [];
  const obs = obstacles.map((o) => {
    const x = o.x * k, y = o.y * k;
    const hw = o.w !== undefined ? o.w / 2 : o.r, hh = o.h !== undefined ? o.h / 2 : o.r;
    return { x0: x - hw, y0: y - hh, x1: x + hw, y1: y + hh, cx: x, cy: y, wt: o.weight ?? 1 };
  });
  const segs = segments.map((s) => ({ x1: s.x1 * k, y1: s.y1 * k, x2: s.x2 * k, y2: s.y2 * k, hw: s.hw, owner: s.owner }));
  const B = { x0: bounds.x * k + 3, y0: bounds.y * k + 3, x1: (bounds.x + bounds.w) * k - 3, y1: (bounds.y + bounds.h) * k - 3 };
  const out: PlacedLabel[] = [];
  const sorted = [...reqs].sort((a, b) => b.priority - a.priority);
  const DIRS = 16;

  const scoreRect = (rect: Rect, q: LabelRequest, ax: number, ay: number) => {
    let cost = 0;
    if (rect.x0 < B.x0 || rect.y0 < B.y0 || rect.x1 > B.x1 || rect.y1 > B.y1) cost += 100000;
    for (const p of placed) if (overlap(rect, p)) cost += 2000 + area(rect, p) * 4;
    for (const o of obs) {
      // the label's own anchor glyph is handled by the clearance ring
      if (Math.abs(o.cx - ax) < 0.5 && Math.abs(o.cy - ay) < 0.5) continue;
      if (overlap(rect, o)) cost += (260 + area(rect, o) * 0.6) * o.wt;
    }
    // each corridor the box covers costs once (text has a halo, so crossing a line is tolerable)
    let lastOwner: string | undefined = '\0';
    for (const s of segs) {
      if (s.owner === lastOwner) continue;
      if (q.ownSegments && s.owner && q.ownSegments.includes(s.owner)) continue;
      const r = { x0: rect.x0 - s.hw, y0: rect.y0 - s.hw, x1: rect.x1 + s.hw, y1: rect.y1 + s.hw };
      if (segHitsRect(s.x1, s.y1, s.x2, s.y2, r)) {
        cost += 34;
        lastOwner = s.owner;
      }
    }
    return cost;
  };

  for (const q of sorted) {
    const ax = q.x * k, ay = q.y * k;
    if (q.fixed) {
      const { w, h } = boxSize(q, q.texts[0]!);
      const rot = ((q.rotate ?? 0) * Math.PI) / 180;
      // rotated box → its axis-aligned bounds
      const bw = Math.abs(w * Math.cos(rot)) + Math.abs(h * Math.sin(rot));
      const bh = Math.abs(w * Math.sin(rot)) + Math.abs(h * Math.cos(rot));
      let done = false;
      for (const at of [{ x: q.x, y: q.y }, ...(q.alts ?? [])]) {
        const px = at.x * k, py = at.y * k;
        const rect = { x0: px - bw / 2, y0: py - bh / 2, x1: px + bw / 2, y1: py + bh / 2 };
        const cost = scoreRect(rect, { ...q, ownSegments: q.ownSegments ?? '*none*' }, NaN, NaN);
        if (cost >= 250 && !q.required) continue;
        placed.push(rect);
        out.push({
          ...q,
          x: at.x,
          y: at.y,
          text: q.texts[0]!,
          variant: 0,
          lx: at.x,
          ly: at.y,
          anchor: 'middle',
          leader: false,
          box: { x: rect.x0 / k, y: rect.y0 / k, w: bw / k, h: bh / k },
        });
        done = true;
        break;
      }
      void done;
      continue;
    }
    let best: { rect: Rect; cost: number; lx: number; ly: number; anchor: PlacedLabel['anchor']; leader: boolean; text: string; variant: number } | null = null;
    for (let ti = 0; ti < q.texts.length; ti++) {
      const text = q.texts[ti]!;
      const { w, h } = boxSize(q, text);
      const mainH = q.size * 1.18;
      const rings = [q.r + 2, q.r + 2 + Math.min(h, 14) * 1.1, q.r + 2 + Math.min(h, 14) * 2.4];
      for (let ri = 0; ri < rings.length; ri++) {
        const d = rings[ri]!;
        for (let i = 0; i < DIRS; i++) {
          const base = q.prefer ?? -Math.PI / 2;
          const step = Math.ceil(i / 2) * (i % 2 ? 1 : -1); // 0, +1, -1, +2, -2 …
          const ang = base + (step * 2 * Math.PI) / DIRS;
          const c = Math.cos(ang), s = Math.sin(ang);
          const cx = ax + c * d, cy = ay + s * d;
          const anchor: PlacedLabel['anchor'] = c > 0.38 ? 'start' : c < -0.38 ? 'end' : 'middle';
          const x0 = anchor === 'start' ? cx : anchor === 'end' ? cx - w : cx - w / 2;
          // vertical: beside the anchor the first line is centred on it; above / below the box hangs off it
          const y0 = s > 0.38 ? cy : s < -0.38 ? cy - h : cy - mainH / 2;
          const rect = { x0, y0, x1: x0 + w, y1: y0 + h };
          let cost = ti * 9 + ri * 32 + Math.abs(step) * 2.2 + scoreRect(rect, q, ax, ay);
          if (q.unambiguous && anc.length) {
            // a name must read as belonging to its own station: nearer to it than to any other
            const own = rectDist(rect, ax, ay);
            for (const a of anc) {
              if (Math.abs(a.x - ax) < 0.5 && Math.abs(a.y - ay) < 0.5) continue;
              const d = rectDist(rect, a.x, a.y);
              if (d < own + 1) {
                cost += 170;
                break;
              }
            }
          }
          if (!best || cost < best.cost) {
            const lx = anchor === 'start' ? x0 + 3.5 : anchor === 'end' ? x0 + w - 3.5 : x0 + w / 2;
            best = { rect, cost, lx, ly: y0 + mainH / 2 + 0.5, anchor, leader: ri > 0, text, variant: ti };
          }
        }
        if (best && best.cost < ti * 9 + ri * 32 + 12) break;
      }
      if (best && best.cost < 40) break;
    }
    if (!best) continue;
    if (best.cost >= 2000 && !q.required) continue;
    if (best.cost >= 100000) {
      // nothing fits inside the viewport: clamp the box in rather than lose a required label
      const r = best.rect;
      const dx = Math.max(0, B.x0 - r.x0) - Math.max(0, r.x1 - B.x1);
      const dy = Math.max(0, B.y0 - r.y0) - Math.max(0, r.y1 - B.y1);
      best.rect = { x0: r.x0 + dx, y0: r.y0 + dy, x1: r.x1 + dx, y1: r.y1 + dy };
      best.lx += dx;
      best.ly += dy;
      best.leader = true;
    }
    placed.push(best.rect);
    out.push({
      ...q,
      text: best.text,
      variant: best.variant,
      lx: best.lx / k,
      ly: best.ly / k,
      anchor: best.anchor,
      leader: best.leader,
      box: { x: best.rect.x0 / k, y: best.rect.y0 / k, w: (best.rect.x1 - best.rect.x0) / k, h: (best.rect.y1 - best.rect.y0) / k },
    });
  }
  return out;
}
