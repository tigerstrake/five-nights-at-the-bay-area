import { describe, expect, it } from 'vitest';
import type { CameraSourceStatus } from '@fnab/shared';
import { CALTRANS_CADENCE_MS, nextLabel, nextPollDelay, stillFreshness, stillLabels } from '../freshness';
import { deviceLiveThumbBudget, liveFirst, liveThumbBudget, pickLiveThumbs, preferLive } from '../liveBudget';

const MIN = 60_000;
const NOW = 1_800_000_000_000;

describe('stillFreshness', () => {
  it('tracks age, time to the next Caltrans frame and cycle progress', () => {
    const f = stillFreshness(NOW - 2 * MIN, NOW);
    expect(f.state).toBe('fresh');
    expect(f.ageMs).toBe(2 * MIN);
    expect(f.nextInMs).toBe(3 * MIN);
    expect(f.progress).toBeCloseTo(0.4);
  });
  it('is due right after the cadence, late after a grace period, unknown without a time', () => {
    expect(stillFreshness(NOW - 5.5 * MIN, NOW).state).toBe('due');
    expect(stillFreshness(NOW - 9 * MIN, NOW).state).toBe('late');
    expect(stillFreshness(null, NOW).state).toBe('unknown');
    expect(stillFreshness(NOW + 5000, NOW).ageMs).toBe(0); // clock skew never yields a negative age
  });
});

describe('still labels', () => {
  it('main: "STILL" badge with "updated 2m ago · next ≈ 3m"', () => {
    const l = stillLabels(stillFreshness(NOW - 2 * MIN, NOW), 'main');
    expect(l.badge).toBe('STILL');
    expect(l.detail).toBe('updated 2m ago · next ≈ 3m');
    expect(l.title).toMatch(/still image \(not video\), captured 2m ago; next frame expected in about 3m/);
  });
  it('thumb: compact "STILL · 2m", no detail line', () => {
    const l = stillLabels(stillFreshness(NOW - 2 * MIN, NOW), 'thumb');
    expect(l.badge).toBe('STILL · 2m');
    expect(l.detail).toBeNull();
  });
  it('fresh frame, imminent frame, overdue and late camera', () => {
    expect(stillLabels(stillFreshness(NOW - 10_000, NOW), 'main').detail).toBe('updated just now · next ≈ 5m');
    expect(stillLabels(stillFreshness(NOW - 4.6 * MIN, NOW), 'main').detail).toBe('updated 5m ago · next < 1m');
    expect(stillLabels(stillFreshness(NOW - 6 * MIN, NOW), 'main').detail).toBe('updated 6m ago · next frame due');
    expect(stillLabels(stillFreshness(NOW - 20 * MIN, NOW), 'main').detail).toBe('updated 20m ago · camera slow to update');
  });
  it('appends why a live-capable camera shows a still', () => {
    const l = stillLabels(stillFreshness(NOW - MIN, NOW), 'main', 'live video dropped · retry in 30s');
    expect(l.detail).toBe('updated 1m ago · next ≈ 4m · live video dropped · retry in 30s');
    expect(l.title).toMatch(/Live video dropped/);
  });
  it('unknown image time still says it is a still', () => {
    const l = stillLabels(stillFreshness(null, NOW), 'main');
    expect(l.badge).toBe('STILL');
    expect(l.detail).toBe('still image');
    expect(stillLabels(stillFreshness(null, NOW), 'thumb').badge).toBe('STILL');
  });
  it('nextLabel rounds to minutes', () => {
    expect(nextLabel(30_000)).toBe('< 1m');
    expect(nextLabel(2.6 * MIN)).toBe('≈ 3m');
  });
});

describe('nextPollDelay (follow the camera cadence instead of polling blindly)', () => {
  it('waits until just after the next frame is expected', () => {
    const d = nextPollDelay(NOW - 2 * MIN, NOW, 60_000);
    expect(d).toBe(3 * MIN + 35_000);
  });
  it('polls briskly while overdue, then backs off for a late camera', () => {
    expect(nextPollDelay(NOW - CALTRANS_CADENCE_MS - 50_000, NOW, 60_000)).toBe(20_000);
    expect(nextPollDelay(NOW - 10 * MIN, NOW, 60_000)).toBe(60_000);
  });
  it('falls back to the server interval without an image time, never below 2 s', () => {
    expect(nextPollDelay(null, NOW, 60_000)).toBe(60_000);
    expect(nextPollDelay(NOW - CALTRANS_CADENCE_MS - 34_000, NOW, 60_000)).toBe(2_000);
  });
});

const st = (id: string, mode: CameraSourceStatus['mode'], stream = mode === 'live'): CameraSourceStatus => ({
  cameraId: id,
  mode,
  snapshotUrl: mode === 'simulated' ? null : `https://x/${id}.jpg`,
  streamUrl: stream ? `https://x/${id}.m3u8` : null,
  lastUpdated: 0,
  error: null,
});

describe('live budget and live-first defaults', () => {
  const statuses = { a: st('a', 'snapshot'), b: st('b', 'live'), c: st('c', 'live'), d: st('d', 'simulated'), e: st('e', 'live'), f: st('f', 'live') };
  it('picks at most N live-capable thumbs in bank order, skipping the main camera', () => {
    expect([...pickLiveThumbs(['a', 'b', 'c', 'd', 'e', 'f'], statuses, 'c', 3)]).toEqual(['b', 'e', 'f']);
    expect(pickLiveThumbs(['a', 'b'], statuses, undefined, 0).size).toBe(0);
  });
  it('a live status without a stream URL is not live-capable', () => {
    expect(pickLiveThumbs(['x'], { x: st('x', 'live', false) }, undefined).size).toBe(0);
  });
  it('preferLive takes the first live candidate, else the first', () => {
    expect(preferLive(['a', 'b', 'c'], (x) => x, statuses)).toBe('b');
    expect(preferLive(['a', 'd'], (x) => x, statuses)).toBe('a');
  });
  it('liveFirst only reorders within a rank and keeps every still', () => {
    const rank: Record<string, number> = { a: 1, b: 2, c: 1, d: 1, e: 0 };
    expect(liveFirst(['a', 'b', 'c', 'd', 'e'], (x) => x, (x) => rank[x]!, statuses)).toEqual(['e', 'c', 'a', 'd', 'b']);
  });
  it('liveThumbs query override is bounded', () => {
    const lowEnd = { cores: 2 };
    expect(liveThumbBudget('', lowEnd)).toBe(3);
    expect(liveThumbBudget('?liveThumbs=0', lowEnd)).toBe(0);
    expect(liveThumbBudget('?liveThumbs=12', lowEnd)).toBe(12);
    expect(liveThumbBudget('?liveThumbs=99', lowEnd)).toBe(3);
  });
  it('default budget scales with the device and respects data saver', () => {
    expect(deviceLiveThumbBudget({ cores: 2 })).toBe(3);
    expect(deviceLiveThumbBudget({ cores: 4 })).toBe(5);
    expect(deviceLiveThumbBudget({ cores: 10 })).toBe(8);
    expect(deviceLiveThumbBudget({ cores: 10, saveData: true })).toBe(3);
    expect(deviceLiveThumbBudget({})).toBe(3);
  });
});
