import { describe, expect, it } from 'vitest';
import { NETWORK } from '@fnab/shared';
import { isWater } from '../bay';

const pos = new Map(NETWORK.nodes.map((n) => [n.id, n.tactical]));
/** Nodes that sit on a bridge deck / island and may be drawn over water. */
const ON_SPAN = new Set(['n-rsr-bridge', 'n-bay-bridge-east', 'n-bay-bridge-west', 'n-sm-bridge', 'n-dumbarton']);

function samples(a: { x: number; y: number }, b: { x: number; y: number }, n = 40) {
  return Array.from({ length: n - 1 }, (_, i) => {
    const t = (i + 1) / n;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  });
}

describe('tactical bay geometry', () => {
  it('keeps land nodes and HQs on land', () => {
    const wet = NETWORK.nodes.filter((n) => !ON_SPAN.has(n.id) && isWater(n.tactical.x, n.tactical.y)).map((n) => n.id);
    expect(wet).toEqual([]);
    const wetHq = NETWORK.headquarters.filter((h) => isWater(h.tactical.x, h.tactical.y)).map((h) => h.id);
    expect(wetHq).toEqual([]);
  });
  it('every bridge crosses water and no road does', () => {
    const dryBridges: string[] = [];
    const wetRoads: string[] = [];
    for (const e of NETWORK.edges) {
      const pts = samples(pos.get(e.a)!, pos.get(e.b)!);
      const wet = pts.filter((p) => isWater(p.x, p.y)).length;
      if (e.kind === 'bridge' && wet === 0) dryBridges.push(e.id);
      if (e.kind !== 'bridge' && wet > 0) wetRoads.push(e.id);
    }
    expect(dryBridges).toEqual([]);
    expect(wetRoads).toEqual([]);
  });
  it('HQ approach spokes stay on land', () => {
    const wet: string[] = [];
    for (const h of NETWORK.headquarters)
      for (const a of h.approaches) if (samples(h.tactical, pos.get(a.fromNode)!).some((p) => isWater(p.x, p.y))) wet.push(a.id);
    expect(wet).toEqual([]);
  });
});
