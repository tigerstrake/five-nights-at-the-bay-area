// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHls } from '../useHls';

const driver = vi.hoisted(() => ({ native: true, instances: [] as any[] }));
vi.mock('hls.js', () => ({
  default: class {
    static isSupported() { return !driver.native; }
    static Events = { ERROR: 'error' };
    static ErrorTypes = { NETWORK_ERROR: 'network', MEDIA_ERROR: 'media' };
    error!: (event: string, data: unknown) => void;
    constructor() { driver.instances.push(this); }
    on(_event: string, cb: typeof this.error) { this.error = cb; }
    loadSource = vi.fn(); attachMedia = vi.fn(); destroy = vi.fn();
    startLoad = vi.fn(); stopLoad = vi.fn(); recoverMediaError = vi.fn();
  },
}));

function Player({ onFail }: { onFail: (why: string) => void }) {
  const ref = useHls('/stream.m3u8', true, { onState: vi.fn(), onFail }, { cameraId: 'test', variant: 'main' });
  return <video ref={ref} />;
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  driver.native = true; driver.instances.length = 0;
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably');
  vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockReturnValue(false);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
});
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

async function setup() {
  const src = vi.spyOn(HTMLMediaElement.prototype, 'src', 'set');
  const onFail = vi.fn();
  const ui = render(<Player onFail={onFail} />);
  await act(async () => { await vi.dynamicImportSettled(); });
  const video = ui.container.querySelector('video')!;
  const error = () => act(() => { video.dispatchEvent(new Event('error')); });
  const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
  const progress = (ms: number) => {
    for (let t = 0; t < ms; t += 500) {
      video.currentTime += 0.5;
      advance(500);
    }
  };
  return { ...ui, src, onFail, error, advance, progress };
}

describe('HLS fatal retry budget', () => {
  it('bounds native HLS errors across reloads and spaces every retry', async () => {
    const h = await setup();
    expect(h.src).toHaveBeenCalledTimes(1);
    for (const [i, delay] of [1000, 2000, 4000, 8000].entries()) {
      h.error();
      h.advance(delay - 1);
      expect(h.src).toHaveBeenCalledTimes(i + 1);
      h.advance(1);
      expect(h.src).toHaveBeenCalledTimes(i + 2);
    }
    h.error();
    expect(h.onFail).toHaveBeenCalledExactlyOnceWith('native video error');
    h.advance(60_000);
    expect(h.src).toHaveBeenCalledTimes(5);
    expect(h.onFail).toHaveBeenCalledTimes(1);
  });

  it('coalesces a native error storm and cancels pending retries on fallback', async () => {
    const h = await setup();
    for (let i = 0; i < 50; i++) h.error();
    expect(h.onFail).toHaveBeenCalledTimes(1);
    h.advance(60_000);
    expect(h.src).toHaveBeenCalledTimes(1);
  });

  it('resets the fatal budget only after sustained healthy playback', async () => {
    const h = await setup();
    for (const delay of [1000, 2000, 4000, 8000]) { h.error(); h.advance(delay); }
    h.progress(31_000);
    expect(h.onFail).not.toHaveBeenCalled();
    h.error(); h.advance(1000);
    expect(h.onFail).not.toHaveBeenCalled();
    // A short recovery cannot replenish that new budget.
    h.progress(5000);
    for (const delay of [2000, 4000, 8000]) { h.error(); h.advance(delay); }
    h.error();
    expect(h.onFail).toHaveBeenCalledTimes(1);
  });

  it('cancels a native retry when unmounted', async () => {
    const h = await setup();
    h.error(); h.unmount(); h.advance(60_000);
    expect(h.src).toHaveBeenCalledTimes(1);
    expect(h.onFail).not.toHaveBeenCalled();
  });

  it('also bounds hls.js fatal reloads without resetting their budget', async () => {
    driver.native = false;
    const h = await setup();
    for (const delay of [1000, 2000, 4000, 8000]) {
      act(() => driver.instances.at(-1).error('error', { fatal: true, type: 'other', details: 'decoder' }));
      h.advance(delay);
    }
    expect(driver.instances).toHaveLength(5);
    act(() => driver.instances.at(-1).error('error', { fatal: true, type: 'other', details: 'decoder' }));
    expect(h.onFail).toHaveBeenCalledExactlyOnceWith('hls.js fatal decoder');
    h.advance(60_000);
    expect(driver.instances).toHaveLength(5);
  });
});
