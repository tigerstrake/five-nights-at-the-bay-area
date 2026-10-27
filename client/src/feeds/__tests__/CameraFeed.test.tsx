// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { CAMERAS, type CameraSourceStatus } from '@fnab/shared';
import { CameraFeed } from '../CameraFeed';
import { setMotionSetting } from '../motion';

const state = vi.hoisted(() => ({ cameraStatuses: {} as Record<string, CameraSourceStatus>, clockOffset: 0 }));
vi.mock('../../state/store', () => ({ useGame: (selector: (s: typeof state) => unknown) => selector(state), serverNow: () => Date.parse('2026-10-21T08:00Z') }));
vi.mock('../../hooks/useNow', () => ({ useNow: () => Date.parse('2026-10-21T08:00Z') }));
vi.mock('../useHls', () => ({ useHls: () => ({ current: null }) }));
vi.mock('../SnapshotLayer', () => ({ SnapshotLayer: () => <div data-testid="real-still" /> }));
vi.mock('../../fx', () => ({
  FeedFxOverlay: () => null, isReducedMotion: () => false, getSimulatedPlacement: () => [],
  SimulatedFeed: ({ timeOfDay, proceduralOnly }: { timeOfDay: string; proceduralOnly: boolean }) =>
    <div data-testid="simulation" data-time-of-day={timeOfDay} data-procedural={String(proceduralOnly)}>SIMULATED FEED</div>,
}));
const c = CAMERAS[0]!;
const props = { cameraId: c.id, nodeId: 'test', variant: 'main' as const, status: 'ok' as const, interference: 0,
  manifestation: null, t0Epoch: 0 };
const NOW = Date.parse('2026-10-21T08:00Z');
beforeEach(() => {
  localStorage.clear();
  state.cameraStatuses[c.id] = { cameraId: c.id, mode: 'snapshot', snapshotUrl: 'https://cams.test/a.jpg', streamUrl: null,
    lastUpdated: NOW, error: null, imageAt: NOW - 2 * 60_000 };
});
afterEach(cleanup);

describe('honest feed badges and motion controls', () => {
  it('defaults to labelled simulated motion on the main monitor; real still is one click away', () => {
    const r = render(<CameraFeed {...props} />);
    expect(r.getByTestId('feed-source-badge').getAttribute('data-source-mode')).toBe('simulated');
    expect(r.getByText('SIMULATED FEED')).toBeTruthy();
    expect(r.getByTestId('simulation').getAttribute('data-time-of-day')).toBe('night');
    expect(r.getByTestId('simulation').getAttribute('data-procedural')).toBe('true');
    fireEvent.click(r.getByTestId('simulated-motion-toggle'));
    expect(r.getByTestId('feed-source-badge').textContent).toBe('STILL');
    expect(r.getByTestId('feed-freshness').textContent).toContain('updated 2m ago');
    expect(r.queryByTestId('simulation')).toBeNull();
  });
  it('never replaces a real still on thumbnails or with the setting disabled', () => {
    const r = render(<CameraFeed {...props} variant="thumb" />);
    expect(r.getByTestId('feed-source-badge').textContent).toBe('STILL · 2m');
    expect(r.queryByTestId('simulated-motion-toggle')).toBeNull();
    setMotionSetting(false);
    r.rerender(<CameraFeed {...props} />);
    expect(r.queryByTestId('simulation')).toBeNull();
    expect(r.queryByTestId('simulated-motion-toggle')).toBeNull();
  });
  it('immediately shows real footage during a sighting and leaves it selected afterward', () => {
    const r = render(<CameraFeed {...props} />);
    r.rerender(<CameraFeed {...props} alert />);
    expect(r.getByTestId('feed-source-badge').textContent).toBe('STILL');
    expect(r.queryByTestId('simulation')).toBeNull();
    expect((r.getByTestId('simulated-motion-toggle') as HTMLButtonElement).disabled).toBe(true);
    r.rerender(<CameraFeed {...props} />);
    expect(r.queryByTestId('simulation')).toBeNull();
  });
  it('also protects manifestations even without an alert prop', () => {
    const r = render(<CameraFeed {...props} manifestation={{ kind: 'figure', strength: 1, regionIndex: 0, startedAtT: 0, durationMs: 1000, seed: 1 }} />);
    expect(r.queryByTestId('simulation')).toBeNull();
    expect(r.getByTestId('feed-source-badge').getAttribute('data-source-mode')).toBe('snapshot');
  });
  it('labels a recent frame with its age and origin rather than claiming a new current frame', () => {
    setMotionSetting(false);
    state.cameraStatuses[c.id] = { ...state.cameraStatuses[c.id]!, servedFrame: 'history', timeMismatch: true, imageAt: NOW - 25 * 60_000 };
    const r = render(<CameraFeed {...props} />);
    expect(r.getByTestId('feed-source-badge').textContent).toBe('STILL · 25m ago (recent frame)');
    expect(r.getByTestId('feed-freshness').textContent).toContain('Recent Caltrans frame');
    expect(r.queryByTestId('still-countdown')).toBeNull();
  });
  it('shows a simulated fallback and the server explanation persistently', () => {
    state.cameraStatuses[c.id] = { ...state.cameraStatuses[c.id]!, mode: 'simulated', snapshotUrl: null,
      simulatedReason: 'real feed shows daylight; simulated night view' };
    const r = render(<CameraFeed {...props} />);
    expect(r.getByTestId('feed-source-badge').textContent).toBe('SIMULATED');
    expect(r.getByTestId('feed-simulated-reason').textContent).toContain('real feed shows daylight');
    expect(r.queryByTestId('real-still')).toBeNull();
  });
});
