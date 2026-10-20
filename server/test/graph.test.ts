import { describe, expect, it } from 'vitest';
import { Graph, NETWORK, CAMERAS, validateNetwork, edgeTravelMs, DEFAULT_CONFIG } from '@fnab/shared';
import { FIXTURE } from './fixtures';

describe('graph', () => {
  const g = new Graph(FIXTURE);
  it('neighbors / hops / edge lookup', () => {
    expect(g.neighbors('a').sort()).toEqual(['b', 'd', 's1']);
    expect(g.hops('s1', 'e')).toBe(3);
    expect(g.edgeBetween('c', 'e')?.id).toBe('e6');
    expect(g.edgeBetween('s1', 'c')).toBeNull();
    expect(g.hopsToHq('s1', 'hq-sf')).toBe(3);
    expect(g.within('a', 1).sort()).toEqual(['a', 'b', 'd', 's1']);
  });
  it('A* finds the cheapest path and respects infinite costs', () => {
    expect(g.shortestPath('s1', 'e')).toEqual(['s1', 'a', 'd', 'e']);
    const avoidD = g.aStar('s1', 'e', (_a, b, e) => (b === 'd' ? Infinity : e.lengthKm));
    expect(avoidD?.path).toEqual(['s1', 'a', 'b', 'c', 'e']);
    expect(g.aStar('s1', 'f', (_a, b, e) => (b === 'd' ? Infinity : e.lengthKm))).toBeNull();
  });
  it('travel time scales with length and clamps', () => {
    const e = { id: 'x', a: 'a', b: 'b', kind: 'freeway' as const, route: '', lengthKm: 1000 };
    expect(edgeTravelMs(e, DEFAULT_CONFIG.monster)).toBe(DEFAULT_CONFIG.monster.maxEdgeMs);
    const m = DEFAULT_CONFIG.monster;
    expect(edgeTravelMs({ ...e, lengthKm: 10 }, m)).toBe(Math.round(Math.max(m.minEdgeMs, m.baseEdgeMs + 10 * m.msPerKm)));
    expect(edgeTravelMs({ ...e, lengthKm: 10 }, m, 2)).toBe(2 * edgeTravelMs({ ...e, lengthKm: 10 }, m));
  });
});

describe('bundled network.json', () => {
  it('is valid and connected', () => {
    expect(validateNetwork(NETWORK, CAMERAS)).toEqual([]);
    const g = new Graph(NETWORK);
    expect(g.isConnected()).toBe(true);
    for (const hq of NETWORK.headquarters) expect(hq.approaches.length).toBeGreaterThanOrEqual(1);
    for (const s of NETWORK.spawnNodes) for (const hq of NETWORK.headquarters) expect(g.hopsToHq(s, hq.id)).toBeGreaterThanOrEqual(1);
  });
});
