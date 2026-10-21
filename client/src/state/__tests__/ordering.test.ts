import { describe, expect, it } from 'vitest';
import type { MatchResult, PlayerView } from '@fnab/shared';
import { matchNow, normalizeResult, normalizeView, SeenIds } from '../store';

const ev = (id: number, t: number) => ({ id, t, kind: 'info' as const, text: `e${id}`, severity: 'info' as const });

describe('opaque event ids', () => {
  it('orders events and sightings by t, never by id', () => {
    const v = { role: 'defender', events: [ev(900, 30), ev(3, 10), ev(77, 20)], sightings: [{ id: 5, t: 9 }, { id: 1, t: 2 }] } as unknown as PlayerView;
    const n = normalizeView(v) as unknown as { events: Array<{ id: number }>; sightings: Array<{ id: number }> };
    expect(n.events.map((e) => e.id)).toEqual([3, 77, 900]);
    expect(n.sightings.map((s) => s.id)).toEqual([1, 5]);
    // already ordered: same object back (no extra renders)
    const sorted = { role: 'monster', events: [ev(9, 1), ev(2, 2)] } as unknown as PlayerView;
    expect(normalizeView(sorted)).toBe(sorted);
  });
  it('orders the results timeline by t', () => {
    const r = { timeline: [ev(2, 50), ev(1, 40)], monsterPath: [] } as unknown as MatchResult;
    expect(normalizeResult(r).timeline.map((e) => e.id)).toEqual([1, 2]);
  });
  it('detects new ids with a bounded seen-set', () => {
    const s = new SeenIds<number>(3);
    expect([10, 2, 10, 7].map((id) => s.add(id))).toEqual([true, true, false, true]);
    s.add(99); // evicts the oldest (10)
    expect(s.size).toBe(3);
    expect(s.has(10)).toBe(false);
    expect(s.has(99)).toBe(true);
  });
  it('freezes the night clock while paused for reconnection', () => {
    expect(matchNow({ t: 1234, t0Epoch: 0, ended: false, pausedForReconnect: true })).toBe(1234);
  });
});
