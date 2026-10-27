import { describe, expect, it, vi } from 'vitest';
import { encode } from 'jpeg-js';
import { CAMERAS, frameTimeOfDay } from '@fnab/shared';
import { lightPixels } from '../../shared/test/frameFixtures';
import { CaltransCameraService } from '../src/cameras';
import { analyzeJpeg } from '../src/cameras/classify';
import { D4_STATUS_URL, publishedHistory } from '../src/cameras/history';
import { fakeFetch, jpegResponse } from './cameraFixtures';

const NOW = Date.parse('2026-10-21T08:00Z'), MIN = 60_000;
const camera = { ...CAMERAS[0]!, imageUrl: 'https://cams.test/a.jpg', streamUrl: null };
const day = new Uint8Array(encode(lightPixels('day'), 95).data);
const night = new Uint8Array(encode(lightPixels('night'), 95).data);
const dusk = new Uint8Array(encode(lightPixels('dusk'), 95).data);
const lm = (age: number) => new Date(NOW - age * MIN).toUTCString();
function service(handler: (url: string) => Response | Promise<Response>, references?: string[], time = NOW) {
  const f = fakeFetch(handler);
  const svc = new CaltransCameraService({ cameras: [{ ...camera, referenceImageUrls: references }], mode: 'snapshot',
    now: () => time, fetch: f.fetch, log: () => {}, config: { minGapMs: 0, jitter: 0, timeoutMs: 20 } });
  return { svc, f };
}

describe('adapter real-frame selection', () => {
  it('classifies JPEG-decoded day and night pixels', () => {
    expect(frameTimeOfDay(analyzeJpeg(day)!.light!)).toBe('day');
    expect(frameTimeOfDay(analyzeJpeg(night)!.light!)).toBe('night');
  });
  it('probes history only on mismatch and chooses the newest matching capture, regardless of slot order', async () => {
    const refs = ['https://cams.test/1.jpg', 'https://cams.test/2.jpg', 'https://cams.test/3.jpg', 'https://cams.test/4.jpg'];
    const { svc, f } = service(u => u === camera.imageUrl ? jpegResponse(day, lm(1)) :
      u === refs[0] ? jpegResponse(night, lm(25)) : u === refs[1] ? jpegResponse(day, lm(2)) :
      u === refs[2] ? jpegResponse(night, lm(10)) : jpegResponse(night, lm(40)), refs);
    await svc.tick();
    expect(svc.getStatus(camera.id)).toMatchObject({ mode: 'snapshot', timeOfDay: 'night', timeMismatch: true,
      servedFrame: 'history', snapshotUrl: expect.stringContaining('/3.jpg?v='), frameAgeMs: 10 * MIN, imageAt: NOW - 10 * MIN });
    expect(f.calls).toHaveLength(5);
    const healthy = service(() => jpegResponse(night, lm(1)), refs);
    await healthy.svc.tick();
    expect(healthy.f.calls).toHaveLength(1);
    expect(healthy.svc.getStatus(camera.id)).toMatchObject({ mode: 'snapshot', timeMismatch: false, servedFrame: 'current' });
  });
  it('falls back honestly for wrong lighting, stale, undated, ambiguous and unavailable history', async () => {
    for (const history of [() => jpegResponse(day, lm(2)), () => jpegResponse(night, lm(31)),
      () => jpegResponse(night, ''), () => jpegResponse(dusk, lm(2)), () => new Response('', { status: 404 })]) {
      const { svc } = service(u => u === camera.imageUrl ? jpegResponse(day, lm(1)) : history(), ['https://cams.test/old.jpg']);
      await svc.tick();
      expect(svc.getStatus(camera.id)).toMatchObject({ mode: 'simulated', timeMismatch: true, snapshotUrl: null,
        simulatedReason: 'real feed shows daylight; simulated night view' });
    }
  });
  it('uses wall clock, not a stale response Date, for frozen cameras', async () => {
    const { svc } = service(() => jpegResponse(night, lm(31)), []);
    await svc.tick();
    expect(svc.getStatus(camera.id)).toMatchObject({ mode: 'simulated', timeMismatch: true,
      simulatedReason: expect.stringContaining('frozen'), frameAgeMs: 31 * MIN });
  });
  it('rejects night during daytime and serves procedural day fallback', async () => {
    const time = Date.parse('2026-10-21T20:00Z');
    const { svc } = service(() => jpegResponse(night, new Date(time).toUTCString()), [], time);
    await svc.tick();
    expect(svc.getStatus(camera.id)).toMatchObject({ timeOfDay: 'day', mode: 'simulated',
      simulatedReason: 'real feed shows night; simulated day view' });
  });
  it('reads exact published reference fields and checks camera identity; shares cached metadata', async () => {
    const data = { data: [{ cctv: { index: camera.caltransIndex, imageData: { static: {
      currentImageURL: camera.imageUrl, referenceImage1: 'https://cams.test/a1UpdateAgo.jpg',
      referenceImage12: 'https://cams.test/a12UpdateAgo.jpg',
    } } } }] };
    expect(publishedHistory(data, { ...camera, caltransIndex: 'other' })).toEqual([]);
    expect(publishedHistory(data, { ...camera, imageUrl: 'https://cams.test/other.jpg' })).toEqual([]);
    const { svc, f } = service(u => u === D4_STATUS_URL ? Response.json(data) :
      u === camera.imageUrl ? jpegResponse(day, lm(1)) : jpegResponse(night, lm(5)));
    await svc.tick();
    expect(f.calls.filter(c => c.url === D4_STATUS_URL)).toHaveLength(1);
    expect(svc.getStatus(camera.id)).toMatchObject({ servedFrame: 'history', mode: 'snapshot' });
  });
  it('tolerates broken metadata and fetch failure without guessing URLs or changing cameras', async () => {
    const { svc, f } = service(u => u === camera.imageUrl ? jpegResponse(day, lm(1)) : new Response('bad json'));
    await expect(svc.tick()).resolves.toBeUndefined();
    expect(svc.getStatus(camera.id)!.mode).toBe('simulated');
    expect(f.calls).toHaveLength(2);
  });

  it('expires selected history between probes, including while a transport failure is tolerated', async () => {
    let now = NOW;
    const f = fakeFetch(u => u === camera.imageUrl ? jpegResponse(day, lm(1)) : jpegResponse(night, lm(29)));
    const svc = new CaltransCameraService({ cameras: [{ ...camera, referenceImageUrls: ['https://cams.test/recent.jpg'] }],
      mode: 'snapshot', fetch: f.fetch, now: () => now, log: () => {}, config: { minGapMs: 0, jitter: 0 } });
    await svc.tick();
    expect(svc.getStatus(camera.id)!.mode).toBe('snapshot');
    now += MIN;
    expect(svc.getStatus(camera.id)!.mode).toBe('snapshot'); // exactly 30 minutes
    now++;
    expect(svc.getStatus(camera.id)).toMatchObject({ mode: 'simulated', timeMismatch: true,
      simulatedReason: expect.stringContaining('frozen'), snapshotUrl: null });
    f.set(() => new Response('', { status: 503 }));
    now += 5 * MIN;
    await svc.tick();
    expect(svc.getStatus(camera.id)!.mode).toBe('simulated');
  });

  it('keeps mismatch retries behind snapshot backoff and times out unavailable history', async () => {
    let now = NOW;
    const f = fakeFetch((u, init) => u === camera.imageUrl ? jpegResponse(day, lm(1)) :
      new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))));
    const svc = new CaltransCameraService({ cameras: [{ ...camera, referenceImageUrls: ['https://cams.test/timeout.jpg'] }],
      mode: 'snapshot', fetch: f.fetch, now: () => now, log: () => {}, config: { minGapMs: 0, jitter: 0, timeoutMs: 5 } });
    await svc.tick();
    expect(svc.getStatus(camera.id)!.mode).toBe('simulated');
    expect(f.calls).toHaveLength(2);
    await svc.tick();
    expect(f.calls).toHaveLength(2);
    now += 30_000;
    await svc.tick();
    expect(f.calls).toHaveLength(4);
    expect(svc.getDiagnostics()[0]!.snapshot.nextCheckAt).toBe(now + 60_000);
  });

  it('paces history requests and stops queued work when the service stops', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const starts: number[] = [];
    const f = fakeFetch(u => {
      starts.push(Date.now());
      return u === camera.imageUrl ? jpegResponse(day, lm(1)) : jpegResponse(night, lm(2));
    });
    const svc = new CaltransCameraService({ cameras: [{ ...camera, referenceImageUrls: ['https://cams.test/1.jpg', 'https://cams.test/2.jpg'] }],
      mode: 'snapshot', fetch: f.fetch, log: () => {}, config: { minGapMs: 150, pumpMs: 25, jitter: 0 } });
    try {
      await svc.start();
      await vi.advanceTimersByTimeAsync(160);
      expect(starts).toHaveLength(2);
      expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(150);
      svc.stop();
      await vi.advanceTimersByTimeAsync(1000);
      expect(starts).toHaveLength(2);
    } finally { svc.stop(); vi.useRealTimers(); }
  });
});
