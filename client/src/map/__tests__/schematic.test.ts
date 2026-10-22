import { describe, expect, it } from 'vitest';
import { NETWORK } from '@fnab/shared';
import { BRIDGE_SPANS, LAND_RINGS, SHORE_LAYOUT_SIG } from '../shore.gen';
import { CORRIDORS, corridorPoints, NODE_LABEL, pathPoints, pointAlong, ROUTE_KEYS, SHIELD_SPOTS } from '../schematic';
import { placeLabels, type LabelRequest } from '../labels';
import anchors from '../tools/shore-anchors.json';

const POS = new Map(NETWORK.nodes.map((n) => [n.id, n.tactical]));
const ON_WATER = new Set(anchors.onWater);

function isLand(x: number, y: number): boolean {
  let inside = false;
  for (const r of LAND_RINGS)
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const xi = r[i]!, yi = r[i + 1]!, xj = r[j]!, yj = r[j + 1]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  return inside;
}
function signature(): string {
  const s = [...NETWORK.nodes.map((x) => `${x.id}@${x.tactical.x},${x.tactical.y}`), ...NETWORK.headquarters.map((h) => `${h.id}@${h.tactical.x},${h.tactical.y}`)].join(';');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}
const segDist = (p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) => {
  const vx = b.x - a.x, vy = b.y - a.y, l2 = vx * vx + vy * vy || 1e-9;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2));
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
};

describe('tactical corridors', () => {
  it('draws every edge, end to end, octilinearly', () => {
    expect(CORRIDORS.size).toBe(NETWORK.edges.length);
    for (const c of CORRIDORS.values()) {
      expect(c.corners[0]).toEqual(POS.get(c.a));
      expect(c.corners[c.corners.length - 1]).toEqual(POS.get(c.b));
      for (let i = 0; i < c.corners.length - 1; i++) {
        const a = c.corners[i]!, b = c.corners[i + 1]!;
        const ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
        const off = Math.abs(((ang % 45) + 45) % 45);
        expect(Math.min(off, 45 - off), `${c.id} leg ${i} at ${ang.toFixed(1)}°`).toBeLessThan(0.6);
      }
    }
  });

  it('keeps corridors clear of the stations they do not serve', () => {
    for (const c of CORRIDORS.values())
      for (const n of NETWORK.nodes) {
        if (n.id === c.a || n.id === c.b) continue;
        let d = Infinity;
        for (let i = 0; i < c.pts.length - 1; i++) d = Math.min(d, segDist(n.tactical, c.pts[i]!, c.pts[i + 1]!));
        expect(d, `${c.id} passes ${n.id}`).toBeGreaterThanOrEqual(18);
      }
  });

  it('walks along corridors in either direction', () => {
    for (const c of CORRIDORS.values()) {
      const a = POS.get(c.a)!, b = POS.get(c.b)!;
      const p0 = pointAlong(c.a, c.b, 0)!, p1 = pointAlong(c.a, c.b, 1)!, q0 = pointAlong(c.b, c.a, 0)!;
      expect(Math.hypot(p0.x - a.x, p0.y - a.y)).toBeLessThan(0.01);
      expect(Math.hypot(p1.x - b.x, p1.y - b.y)).toBeLessThan(0.01);
      expect(Math.hypot(q0.x - b.x, q0.y - b.y)).toBeLessThan(0.01);
      const mid = pointAlong(c.a, c.b, 0.5)!, midRev = pointAlong(c.b, c.a, 0.5)!;
      expect(Math.hypot(mid.x - midRev.x, mid.y - midRev.y)).toBeLessThan(0.5);
      expect(corridorPoints(c.b, c.a)[0]).toEqual(b);
    }
    const path = pathPoints(['n-sr37', 'n-san-rafael', 'n-marin-city']);
    expect(path[0]).toEqual(POS.get('n-sr37'));
    expect(path[path.length - 1]).toEqual(POS.get('n-marin-city'));
  });

  it('gives every node a map label and every numbered route a shield', () => {
    for (const n of NETWORK.nodes) expect(NODE_LABEL[n.id], n.id).toBeDefined();
    const routes = new Set([...CORRIDORS.values()].filter((c) => c.route.cls !== 'street').map((c) => c.route.key));
    for (const r of routes) expect(ROUTE_KEYS as readonly string[], r).toContain(r);
    for (const r of routes) expect(SHIELD_SPOTS.some((s) => s.route.key === r), `shield for ${r}`).toBe(true);
  });
});

describe('warped shoreline', () => {
  it('was built for the current tactical layout (re-run tools/build-shore.mjs)', () => {
    expect(SHORE_LAYOUT_SIG).toBe(signature());
  });

  it('keeps land stations and HQs on land and mid-span cameras on the water', () => {
    for (const n of NETWORK.nodes) expect(isLand(n.tactical.x, n.tactical.y), n.id).toBe(!ON_WATER.has(n.id));
    for (const h of NETWORK.headquarters) expect(isLand(h.tactical.x, h.tactical.y), h.id).toBe(true);
  });

  it('every bridge spans water and no road or tunnel does', () => {
    for (const c of CORRIDORS.values()) {
      const samples = Array.from({ length: 59 }, (_, i) => pointAlong(c.a, c.b, (i + 1) / 60)!);
      const wet = samples.filter((p) => !isLand(p.x, p.y)).length;
      if (c.kind === 'bridge') {
        expect(wet, `${c.id} crosses water`).toBeGreaterThan(0);
        expect(BRIDGE_SPANS[c.id]?.length, `${c.id} spans`).toBeGreaterThan(0);
      } else expect(wet, `${c.id} stays on land`).toBe(0);
    }
  });

  it('opens the Golden Gate: the Pacific reaches the Bay between Marin and San Francisco', () => {
    // a horizontal walk through the strait from the ocean side to the bay must stay wet
    const gg = POS.get('n-gg-north')!, oc = POS.get('n-octavia')!;
    const y = (gg.y + oc.y) / 2;
    for (let x = gg.x - 40; x <= gg.x + 50; x += 5) if (Math.abs(x - gg.x) > 8) expect(isLand(x, y), `strait at ${x},${y}`).toBe(false);
  });
});

describe('label placement', () => {
  it('names every station without overlaps at the smallest console size', () => {
    // 1280×720 defender column: ~378 × 462 px for the whole network (k ≈ 0.44 px per unit)
    const k = 0.44;
    const reqs: LabelRequest[] = NETWORK.nodes.map((n) => ({
      id: n.id,
      texts: NODE_LABEL[n.id]!.short ? [NODE_LABEL[n.id]!.text, NODE_LABEL[n.id]!.short!] : [NODE_LABEL[n.id]!.text],
      x: n.tactical.x,
      y: n.tactical.y,
      r: 7.5,
      size: 9.6,
      priority: 50,
      required: true,
      prefer: (NODE_LABEL[n.id]!.dir * Math.PI) / 4,
      unambiguous: true,
    }));
    const segs = [...CORRIDORS.values()].flatMap((c) =>
      c.pts.slice(0, -1).map((p, i) => ({ x1: p.x, y1: p.y, x2: c.pts[i + 1]!.x, y2: c.pts[i + 1]!.y, hw: 2, owner: c.id })),
    );
    const bounds = { x: 98, y: 14, w: 794, h: 1004 };
    const out = placeLabels(reqs, NETWORK.nodes.map((n) => ({ x: n.tactical.x, y: n.tactical.y, r: 7 })), k, bounds, segs, NETWORK.nodes.map((n) => n.tactical));
    expect(out.length).toBe(NETWORK.nodes.length);
    for (let i = 0; i < out.length; i++)
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i]!.box, b = out[j]!.box;
        const hit = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(hit, `${out[i]!.id} / ${out[j]!.id}`).toBe(false);
      }
    for (const l of out) {
      expect(l.box.x).toBeGreaterThanOrEqual(bounds.x);
      expect(l.box.x + l.box.w).toBeLessThanOrEqual(bounds.x + bounds.w);
    }
  });
});
