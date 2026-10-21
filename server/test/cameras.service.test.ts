import { describe, expect, it, vi } from 'vitest';
import { CAMERAS, type CameraRecord } from '@fnab/shared';
import {
  CaltransCameraService,
  SimulationCameraService,
  cameraConfigFromEnv,
  createCameraService,
  parseCameraMode,
  type CaltransConfig,
} from '../src/cameras';
import { cardJpeg, fakeFetch, hlsHandler, jpegResponse, padTo, sceneJpeg, type Handler } from './cameraFixtures';

const T0 = Date.parse('2026-10-20T20:00:00Z');
const MIN = 60_000;

function rec(id: string, o: { stream?: boolean; playable?: boolean | null } = {}): CameraRecord {
  return {
    id,
    caltransIndex: id,
    name: id,
    route: 'I-80',
    direction: null,
    county: 'x',
    nearbyPlace: 'x',
    lat: 0,
    lon: 0,
    imageUrl: `https://cams.test/${id}.jpg`,
    streamUrl: o.stream ? `https://stream.test/${id}/playlist.m3u8` : null,
    imageUpdateFrequencyMin: 5,
    inService: true,
    verified: { checkedAt: '', imageHttp: 200, streamHttp: null, imageCors: true, streamCors: true, streamPlayable: o.playable ?? null },
    placement: [],
    tags: [],
  };
}

const A = rec('a', { stream: true, playable: true }); // curated playable stream
const B = rec('b', { stream: true, playable: false }); // listed but 404 at curation
const C = rec('c'); // no stream published

const CFG: Partial<CaltransConfig> = { minGapMs: 0, jitter: 0, notifyDelayMs: 0, timeoutMs: 5000 };

function setup(handler: Handler, o: { mode?: 'auto' | 'live' | 'snapshot'; cameras?: CameraRecord[]; config?: Partial<CaltransConfig> } = {}) {
  const clock = { t: T0 };
  const ff = fakeFetch(handler);
  const logs: string[] = [];
  const svc = new CaltransCameraService({
    cameras: o.cameras ?? [A, B, C],
    mode: o.mode ?? 'auto',
    config: { ...CFG, ...o.config },
    fetch: ff.fetch,
    now: () => clock.t,
    random: () => 0.5,
    log: (m) => logs.push(m),
  });
  const lm = () => new Date(clock.t - 2 * MIN).toUTCString();
  return { svc, clock, ff, logs, lm, advance: (ms: number) => (clock.t += ms) };
}

/** Healthy Caltrans: good JPEGs everywhere, stream for `a` only. */
function healthy(lm: () => string, over: { snap?: (url: string) => Response | null; hls?: (url: string) => Response | null } = {}): Handler {
  return (url) => {
    if (url.endsWith('.jpg')) return over.snap?.(url) ?? jpegResponse(sceneJpeg(), lm());
    if (url.includes('stream.test')) {
      const o = over.hls?.(url);
      if (o) return o;
      return url.includes('/a/') || url.includes('chunklist') || url.endsWith('.ts') ? (hlsHandler(url) ?? new Response('', { status: 404 })) : new Response('nope', { status: 404 });
    }
    return new Response('', { status: 404 });
  };
}

const modes = (svc: CaltransCameraService) => Object.fromEntries(svc.getStatuses().map((s) => [s.cameraId, s.mode]));

describe('mode selection', () => {
  it('defaults to auto and rejects unknown values to simulation', () => {
    expect(parseCameraMode(undefined)).toBe('auto');
    expect(parseCameraMode('')).toBe('auto');
    expect(parseCameraMode('LIVE')).toBe('live');
    expect(parseCameraMode('snapshot')).toBe('snapshot');
    expect(parseCameraMode('simulation')).toBe('simulation');
    expect(parseCameraMode('bogus')).toBe('simulation');
  });
  it('simulation mode is fully offline', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    try {
      const svc = createCameraService('simulation', CAMERAS, () => undefined);
      expect(svc).toBeInstanceOf(SimulationCameraService);
      await svc.start();
      expect(svc.getStatuses().every((s) => s.mode === 'simulated' && !s.snapshotUrl && !s.streamUrl)).toBe(true);
      svc.stop();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('auto/live/snapshot build the Caltrans service', () => {
    for (const m of ['auto', 'live', 'snapshot'] as const) {
      const svc = createCameraService(m, CAMERAS, () => undefined);
      expect(svc).toBeInstanceOf(CaltransCameraService);
      expect(svc.mode).toBe(m);
    }
  });
  it('reads tunables from the environment', () => {
    expect(cameraConfigFromEnv({ CAMERA_TIMEOUT_MS: '1500', CAMERA_PROBE_ORIGIN: 'http://10.255.255.1', CAMERA_CONCURRENCY: 'x' })).toEqual({
      timeoutMs: 1500,
      probeOrigin: 'http://10.255.255.1',
    });
  });
});

describe('status derivation', () => {
  it('10 caps streaming master and media playlist bytes, cancels the body and bounds lines before parsing', async () => {
    for (const media of [false, true]) {
      let cancelled = false;
      const oversized = new Response(new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new Uint8Array(128).fill(65)); },
        cancel() { cancelled = true; },
      }));
      const { svc, lm, ff } = setup(() => new Response('', { status: 500 }), {
        cameras: [A], config: { maxPlaylistBytes: 256, maxPlaylistLines: 10 },
      });
      ff.set(healthy(lm, { hls: u => u.endsWith(media ? 'chunklist_1.m3u8' : 'playlist.m3u8') ? oversized : hlsHandler(u) }));
      await svc.tick();
      expect(cancelled).toBe(true);
      expect(svc.getStatus('a')).toMatchObject({ mode: 'snapshot', streamUrl: null, reason: expect.stringContaining('byte limit') });
    }
    const { svc, lm, ff } = setup(() => new Response('', { status: 500 }), { cameras: [A], config: { maxPlaylistLines: 5 } });
    ff.set(healthy(lm, { hls: u => u.endsWith('playlist.m3u8') ? new Response('#EXTM3U\n' + '# comment\n'.repeat(10)) : hlsHandler(u) }));
    await svc.tick();
    expect(svc.getStatus('a')).toMatchObject({ mode: 'snapshot', reason: expect.stringContaining('line limit') });
  });

  it('starts simulated ("checking") and never claims real imagery before a probe', () => {
    const { svc } = setup(() => new Response('', { status: 500 }));
    for (const s of svc.getStatuses()) {
      expect(s.mode).toBe('simulated');
      expect(s.snapshotUrl).toBeNull();
      expect(s.streamUrl).toBeNull();
      expect(s.reason).toMatch(/checking/);
    }
  });

  it('promotes: live (stream+snapshot), snapshot (stale-stream cam, no-stream cam)', async () => {
    const { svc, lm, ff } = setup((u) => healthy(lm)(u));
    const h = healthy(lm);
    ff.set(h);
    await svc.tick();
    const st = Object.fromEntries(svc.getStatuses().map((s) => [s.cameraId, s]));
    expect(st.a!.mode).toBe('live');
    expect(st.a!.streamUrl).toBe(A.streamUrl);
    expect(st.a!.snapshotUrl).toMatch(/^https:\/\/cams\.test\/a\.jpg\?v=\d+$/);
    expect(st.a!.imageAt).toBe(Math.floor((T0 - 2 * MIN) / 1000) * 1000);
    expect(st.a!.refreshMs).toBe(60_000);
    expect(st.a!.reason).toMatch(/HLS/);
    expect(st.c!.mode).toBe('snapshot');
    expect(st.c!.streamUrl).toBeNull();
    // b has a listed stream that 404s and was not curated playable: snapshot, with the stream reason recorded.
    expect(st.b!.mode).toBe('snapshot');
    expect(st.b!.reason).toMatch(/HTTP 404/);
  });

  it('does not re-request anything before a camera is due (round-robin cadence)', async () => {
    const { svc, lm, ff, advance } = setup((u) => healthy(lm)(u));
    ff.set(healthy(lm));
    await svc.tick();
    const n = ff.calls.length;
    await svc.tick();
    advance(20_000);
    await svc.tick();
    expect(ff.calls.length).toBe(n);
    advance(6 * MIN); // past the 5-minute cadence
    await svc.tick();
    expect(ff.calls.length).toBeGreaterThan(n);
    const snaps = ff.calls.filter((c) => c.url.endsWith('.jpg')).length;
    expect(snaps).toBe(6); // 3 cameras x 2 sweeps, once each
  });

  it('hard content failures (placeholder) downgrade at once and recover on the next good frame', async () => {
    const { svc, lm, ff, advance } = setup((u) => healthy(lm)(u));
    ff.set(healthy(lm));
    await svc.tick();
    expect(modes(svc).c).toBe('snapshot');
    ff.set(healthy(lm, { snap: (u) => (u.includes('/c.') ? jpegResponse(padTo(cardJpeg(), 13_450), lm()) : null) }));
    advance(6 * MIN);
    await svc.tick();
    const c = svc.getStatus('c')!;
    expect(c.mode).toBe('simulated');
    expect(c.snapshotUrl).toBeNull();
    expect(c.reason).toMatch(/Temporarily Unavailable/);
    ff.set(healthy(lm));
    advance(31 * MIN);
    await svc.tick();
    expect(modes(svc).c).toBe('snapshot');
  });

  it('is flapping-tolerant: soft failures need N consecutive strikes, one success restores', async () => {
    const { svc, lm, ff, advance } = setup((u) => healthy(lm)(u), { cameras: [C] });
    ff.set(healthy(lm));
    await svc.tick();
    expect(modes(svc).c).toBe('snapshot');
    const down = healthy(lm, { snap: () => new Response('boom', { status: 503 }) });
    ff.set(down);
    advance(6 * MIN);
    await svc.tick(); // strike 1: still snapshot
    expect(modes(svc).c).toBe('snapshot');
    ff.set(healthy(lm));
    advance(6 * MIN);
    await svc.tick(); // success resets the strike counter
    expect(modes(svc).c).toBe('snapshot');
    ff.set(down);
    advance(6 * MIN);
    await svc.tick(); // strike 1 again
    advance(6 * MIN);
    await svc.tick(); // strike 2: downgrade
    expect(svc.getStatus('c')).toMatchObject({ mode: 'simulated', reason: expect.stringMatching(/HTTP 503/) });
    ff.set(healthy(lm));
    advance(11 * MIN);
    await svc.tick(); // success upgrades immediately
    expect(modes(svc).c).toBe('snapshot');
  });

  it('HLS: curated stream downgrades after N failures and upgrades on one success', async () => {
    const { svc, lm, ff, advance } = setup((u) => healthy(lm)(u), { cameras: [A] });
    ff.set(healthy(lm));
    await svc.tick();
    expect(modes(svc).a).toBe('live');
    const dead = healthy(lm, { hls: () => new Response('', { status: 404 }) });
    ff.set(dead);
    advance(6 * MIN);
    await svc.tick();
    expect(modes(svc).a).toBe('live'); // strike 1
    advance(6 * MIN);
    await svc.tick();
    expect(modes(svc).a).toBe('snapshot'); // strike 2: falls back to snapshot, snapshot unaffected
    expect(svc.getStatus('a')!.streamUrl).toBeNull();
    ff.set(healthy(lm));
    advance(16 * MIN);
    await svc.tick();
    expect(modes(svc).a).toBe('live');
  });

  it('HLS: a stream not verified at curation needs consecutive successes before it is offered', async () => {
    const { svc, lm, ff, advance } = setup((u) => healthy(lm)(u), { cameras: [B] });
    const ok = healthy(lm, { hls: (u) => hlsHandler(u) });
    ff.set(ok);
    await svc.tick();
    expect(modes(svc).b).toBe('snapshot'); // first success: not yet trusted
    advance(MIN); // confirm re-check scheduled at backoffBase (30 s)
    await svc.tick();
    expect(modes(svc).b).toBe('live');
  });

  it('rejects broken HLS: bad segment, ended playlist, html playlist', async () => {
    for (const hls of [
      (u: string) => (u.endsWith('.ts') ? new Response(new Uint8Array(188), { status: 206 }) : hlsHandler(u)),
      (u: string) => (u.endsWith('chunklist_1.m3u8') ? new Response('#EXTM3U\n#EXTINF:1,\ns.ts\n#EXT-X-ENDLIST\n') : hlsHandler(u)),
      (u: string) => (u.endsWith('playlist.m3u8') ? new Response('<html>captive portal</html>') : hlsHandler(u)),
    ]) {
      const { svc, lm, ff } = setup((u) => healthy(lm)(u), { cameras: [A] });
      ff.set(healthy(lm, { hls }));
      await svc.tick();
      expect(modes(svc).a).toBe('snapshot');
    }
  });

  it('asks for a single TS packet with a Range header instead of downloading the segment', async () => {
    const { svc, lm, ff } = setup((u) => healthy(lm)(u), { cameras: [A] });
    ff.set(healthy(lm));
    await svc.tick();
    const seg = ff.calls.find((c) => c.url.endsWith('.ts'));
    expect(seg?.range).toBe('bytes=0-187');
  });

  it('modes: snapshot never probes streams; live shows only verified-live cameras as real', async () => {
    const snap = setup((u) => healthy(() => new Date(T0).toUTCString())(u), { mode: 'snapshot' });
    snap.ff.set(healthy(snap.lm));
    await snap.svc.tick();
    expect(snap.ff.calls.some((c) => c.url.includes('stream.test'))).toBe(false);
    expect(Object.values(modes(snap.svc))).toEqual(['snapshot', 'snapshot', 'snapshot']);

    const live = setup((u) => healthy(() => '')(u), { mode: 'live' });
    live.ff.set(healthy(live.lm));
    await live.svc.tick();
    expect(modes(live.svc)).toEqual({ a: 'live', b: 'simulated', c: 'simulated' });
    expect(live.svc.getStatus('c')!.reason).toMatch(/live-only/);
  });

  it('notifies subscribers once with coalesced statuses and supports unsubscribe', async () => {
    const { svc, lm, ff } = setup((u) => healthy(lm)(u));
    ff.set(healthy(lm));
    const seen: number[] = [];
    const off = svc.subscribe((s) => seen.push(s.filter((x) => x.mode !== 'simulated').length));
    await svc.tick();
    expect(seen).toEqual([3]);
    off();
    expect(seen.length).toBe(1);
  });

  it('exposes health and diagnostics', async () => {
    const { svc, lm, ff } = setup((u) => healthy(lm)(u));
    ff.set(healthy(lm));
    await svc.tick();
    const h = svc.getHealth();
    expect(h.counts).toEqual({ live: 1, snapshot: 2, simulated: 0, offline: 0 });
    expect(h.checks).toBeGreaterThanOrEqual(5);
    const d = svc.getDiagnostics().find((x) => x.cameraId === 'b')!;
    expect(d.stream?.state).toBe('bad'); // listed stream 404s, so it is not offered
    expect(d.snapshot.state).toBe('good');
  });
});

describe('backoff', () => {
  it('doubles the retry delay per consecutive failure up to the cap', async () => {
    const { svc, lm, ff, clock } = setup((u) => healthy(lm)(u), { cameras: [C], config: { backoffBaseMs: 30_000, backoffMaxMs: 240_000 } });
    ff.set(() => new Response('', { status: 500 }));
    const gaps: number[] = [];
    for (let i = 0; i < 6; i++) {
      const before = clock.t;
      await svc.tick();
      const next = svc.getDiagnostics()[0]!.snapshot.nextCheckAt!;
      gaps.push((next - before) / 1000);
      clock.t = next;
    }
    expect(gaps).toEqual([30, 60, 120, 240, 240, 240]);
  });
});

describe('Caltrans domain unreachable', () => {
  const real = CAMERAS;

  it('falls back to simulated, stops hammering (circuit breaker), never throws, and recovers', async () => {
    let up = false;
    const lmNow = () => new Date(T0 - MIN).toUTCString();
    const ctx = setup(
      (url) => {
        if (!up) throw new TypeError('fetch failed');
        return url.endsWith('.jpg') ? jpegResponse(sceneJpeg(), lmNow()) : (hlsHandler(url) ?? new Response('', { status: 404 }));
      },
      { cameras: real },
    );
    await expect(ctx.svc.start()).resolves.toBeUndefined();
    ctx.svc.stop(); // drive manually with tick() below
    await ctx.svc.tick();
    const requests = ctx.ff.calls.length;
    expect(requests).toBeLessThanOrEqual(12); // breakers stop it near the threshold, nowhere near 36+19 probes
    const st = ctx.svc.getStatuses();
    expect(st).toHaveLength(real.length);
    expect(st.every((s) => s.mode === 'simulated' && !s.snapshotUrl && !s.streamUrl)).toBe(true);
    expect(st.some((s) => /unreachable/.test(s.reason ?? ''))).toBe(true);
    expect(ctx.svc.getHealth().hosts.some((h) => h.breakerOpen)).toBe(true);
    // Still silent a little later.
    ctx.advance(10_000);
    await ctx.svc.tick();
    expect(ctx.ff.calls.length).toBe(requests);
    // Breaker expires: exactly one trial request per host at a time; domain back -> recovery.
    up = true;
    ctx.advance(10 * MIN);
    for (let i = 0; i < 6; i++) {
      await ctx.svc.tick();
      ctx.advance(2 * MIN);
    }
    const after = ctx.svc.getStatuses();
    expect(after.filter((s) => s.mode !== 'simulated').length).toBeGreaterThan(real.length - 3);
    expect(ctx.svc.getHealth().hosts.every((h) => !h.breakerOpen)).toBe(true);
  });

  it('timeouts mark cameras simulated with a timeout reason', async () => {
    const ctx = setup(
      (_u, init) => new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted')))),
      { cameras: [C], config: { timeoutMs: 20 } },
    );
    await ctx.svc.tick();
    const s = ctx.svc.getStatus('c')!;
    expect(s.mode).toBe('simulated');
    expect(s.reason).toMatch(/timed out/);
  });

  it('a camera answering 404/500 does not trip the host breaker (host is reachable)', async () => {
    const many = Array.from({ length: 10 }, (_, i) => rec(`x${i}`));
    const ctx = setup(() => new Response('', { status: 500 }), { cameras: many });
    await ctx.svc.tick();
    expect(ctx.ff.calls.length).toBe(10);
    expect(ctx.svc.getHealth().hosts.every((h) => !h.breakerOpen)).toBe(true);
  });

  it('CAMERA_PROBE_ORIGIN redirects every probe to the override host (outage test hook)', async () => {
    const ctx = setup(() => new Response('', { status: 500 }), { cameras: [A], config: { probeOrigin: 'http://10.255.255.1:81' } });
    await ctx.svc.tick();
    expect(ctx.ff.calls.length).toBeGreaterThan(0);
    expect(ctx.ff.calls.every((c) => c.url.startsWith('http://10.255.255.1:81/'))).toBe(true);
    // The public URL handed to clients is still the real one once good.
  });
});

describe('background loop', () => {
  it('start() returns immediately and probes in the background with spacing, stop() halts it', async () => {
    vi.useFakeTimers();
    try {
      const lm = () => new Date(Date.now() - MIN).toUTCString();
      const ff = fakeFetch(healthy(lm));
      const svc = new CaltransCameraService({ cameras: [A, B, C], mode: 'auto', fetch: ff.fetch, log: () => undefined, config: { notifyDelayMs: 10, minGapMs: 150 } });
      const seen: number[] = [];
      svc.subscribe((s) => seen.push(s.filter((x) => x.mode !== 'simulated').length));
      await svc.start();
      expect(ff.calls.length).toBe(0); // nothing synchronous: no startup storm
      await vi.advanceTimersByTimeAsync(300);
      expect(ff.calls.length).toBeGreaterThan(0);
      expect(ff.calls.length).toBeLessThan(7); // paced (one probe per wake-up), not the whole 7-request sweep at once
      await vi.advanceTimersByTimeAsync(5000);
      expect(Object.values(modes(svc))).toEqual(['live', 'snapshot', 'snapshot']);
      expect(seen.length).toBeGreaterThan(0);
      svc.stop();
      const n = ff.calls.length;
      await vi.advanceTimersByTimeAsync(20 * MIN);
      expect(ff.calls.length).toBe(n);
    } finally {
      vi.useRealTimers();
    }
  });
});
