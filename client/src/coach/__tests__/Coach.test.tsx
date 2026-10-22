// @vitest-environment jsdom
import React, { createRef } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonsterView } from '@fnab/shared';
import { CoachLayer } from '../Coach';
import { monsterHints } from '../rules';
import { hqById } from '../../lib/data';
import { MonsterMoments } from '../../screens/shell/Moments';

vi.mock('../../audio', () => ({ audio: { play: vi.fn() } }));
vi.mock('../../ui/chrome', () => ({ useReduceFlashing: () => true }));
vi.mock('../store', () => ({
  useHintsOn: () => true,
  useCoachPrefs: () => ({ seen: [] }),
  coach: { markSeen: vi.fn() },
}));

const hq = hqById('hq-sf')!;
const view: MonsterView = {
  role: 'monster', t: 100_000, t0Epoch: 0, serverNow: 100_000, hqId: 'hq-sf', defenderCount: 1,
  phase: 'infiltration', phaseEndsAt: 180_000, matchEndsAt: 300_000, ended: false, events: [],
  knownDoors: [], spawnOptions: [], cameras: [], knownSensors: [], disturbances: [], scanPulses: [],
  exposures: [], powerLevel: 'high', breach: null, containment: null,
  self: {
    spawned: true, spawnChoice: null, nodeId: hq.approaches[0]!.fromNode, moving: null, path: [],
    stance: 'ATTACK', targetApproachId: null, held: null,
    cooldowns: { HUNT: 0, HIDE: 0, FLANK: 0, ATTACK: 0, RETREAT: 0, SABOTAGE: 0, DECOY: 0 },
  },
};

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(100_000); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('coach placement beside moments', () => {
  it.each([1, 1.5])('keeps the sealed-door hint clear of the moment banner after avoiding the command row (zoom=%s)', zoom => {
    vi.stubGlobal('innerHeight', 800 * zoom);
    // jsdom has no layout: supply measured panel/card bounds in a compact console.
    const sizes: Record<string, [number, number, number, number]> = {
      root: [0, 0, 1000, 800], safe: [0, 0, 1000, 80],
      'monster-breach': [100, 600, 600, 60], 'coach-hint': [0, 0, 292, 160],
      moment: [0, 300, 800, 100], 'command-row': [0, 500, 800, 40],
    };
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const [x, y, w, h] = sizes[this.dataset.testid ?? ''] ?? [0, 0, 0, 0];
      return new DOMRect(x * zoom, y * zoom, w * zoom, h * zoom);
    });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return sizes[this.dataset.testid ?? '']?.[2] ?? 0;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return sizes[this.dataset.testid ?? '']?.[3] ?? 0;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockReturnValue(document.body);
    const rootRef = createRef<HTMLDivElement>();
    const screen = (v: MonsterView) => (
      <div ref={rootRef} data-testid="root">
        <div data-testid="safe" data-coach-safe />
        <div data-testid="monster-breach" />
        <MonsterMoments view={v} t={v.t} hq={hq} hopsToHq={3} />
        <div data-testid="command-row" data-coach-avoid />
        <CoachLayer role="monster" rootRef={rootRef} hints={monsterHints({
          view: v, t: v.t, hq, hopsToHq: 0, watchedHere: false, commanded: true, seen: new Set(),
        })} />
      </div>
    );
    const ui = render(screen(view));
    ui.rerender(screen({ ...view, breach: { approachId: hq.approaches[0]!.id, progress: 0.4, stalled: true } }));
    act(() => { vi.advanceTimersByTime(1500); });
    const hint = ui.getByTestId('coach-hint');
    expect(hint.dataset.hint).toBe('m-sealed');
    expect(ui.getByTestId('moment').dataset.moment).toMatch(/^breach:/);
    const top = Number.parseFloat(hint.style.top);
    expect(top).toBeGreaterThanOrEqual(84); // Below the safe header.
    expect(top + 160).toBeLessThanOrEqual(290); // 10px clear of the centre banner.
    expect(top + 160).toBeLessThanOrEqual(490); // Also clear of the command row.

    act(() => { vi.advanceTimersByTime(1000); });
    expect(ui.queryByTestId('moment')).toBeNull();
    expect(Number.parseFloat(hint.style.top)).toBe(330); // Reclaims space when the banner retires.
  });
});
