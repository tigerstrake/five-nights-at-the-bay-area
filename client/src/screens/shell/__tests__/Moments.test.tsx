// @vitest-environment jsdom
import React, { StrictMode } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonsterView } from '@fnab/shared';
import { hqById } from '../../../lib/data';
import { audio } from '../../../audio';
import { MonsterMoments } from '../Moments';

vi.mock('../../../audio', () => ({ audio: { play: vi.fn() } }));
vi.mock('../../../ui/chrome', () => ({ useReduceFlashing: () => true }));
const hq = hqById('hq-sf')!;
const view: MonsterView = {
  role: 'monster', t: 100_000, t0Epoch: 0, serverNow: 100_000, hqId: 'hq-sf', defenderCount: 1,
  phase: 'infiltration', phaseEndsAt: 180_000, ended: false, matchEndsAt: 200_000, events: [],
  spawnOptions: [], cameras: [], knownSensors: [], knownDoors: [], disturbances: [], scanPulses: [],
  powerLevel: 'high', containment: null,
  exposures: [], breach: null,
  self: {
    spawned: true, spawnChoice: null, moving: null, nodeId: hq.approaches[0].fromNode,
    stance: 'HUNT', targetApproachId: null, held: null, path: [],
    cooldowns: { HUNT: 0, HIDE: 0, FLANK: 0, ATTACK: 0, RETREAT: 0, SABOTAGE: 0, DECOY: 0 },
  },
};
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); vi.mocked(audio.play).mockClear(); });
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); });

describe('moment queue lifecycle', () => {
  it.each([false, true])('cancels queued sounds and display timers on unmount (StrictMode=%s)', strict => {
    const screen = (t: number, hops: number) => {
      const node = <MonsterMoments view={view} t={t} hq={hq} hopsToHq={hops} />;
      return strict ? <StrictMode>{node}</StrictMode> : node;
    };
    const ui = render(screen(100_000, 3));
    ui.rerender(screen(150_000, 0));
    expect(audio.play).toHaveBeenCalledExactlyOnceWith('monsterNear', { volume: 0.9 });
    expect(vi.getTimerCount()).toBe(1);
    ui.unmount();
    expect(vi.getTimerCount()).toBe(0);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(audio.play).toHaveBeenCalledTimes(1);
  });

  it('cancels the phase-change hold timer before a queued dawn sound can play', () => {
    const ui = render(<MonsterMoments view={{ ...view, phase: 'preparation' }} t={100_000} hq={hq} hopsToHq={3} />);
    ui.rerender(<MonsterMoments view={view} t={150_000} hq={hq} hopsToHq={3} />);
    expect(vi.getTimerCount()).toBe(1);
    expect(audio.play).not.toHaveBeenCalled();
    ui.unmount();
    expect(vi.getTimerCount()).toBe(0);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(audio.play).not.toHaveBeenCalled();
  });

  it('still pumps the next queued moment while mounted', () => {
    const ui = render(<MonsterMoments view={view} t={100_000} hq={hq} hopsToHq={3} />);
    ui.rerender(<MonsterMoments view={view} t={150_000} hq={hq} hopsToHq={0} />);
    act(() => { vi.advanceTimersByTime(2300); });
    expect(audio.play).toHaveBeenLastCalledWith('phaseChange', { volume: 0.9 });
    expect(ui.getByTestId('moment').getAttribute('data-moment')).toBe('dawn');
  });
});
