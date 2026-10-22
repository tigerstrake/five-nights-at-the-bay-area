// Real-world camera health service for the curated Caltrans cameras.
//
// Its only job is to tell clients, per camera, what real imagery is trustworthy RIGHT NOW (HLS / snapshot /
// labelled simulation). It runs on its own timers, never touches the game engine, never throws into the game
// loop, and knows nothing about fictional in-game sabotage (that lives in the engine, see CameraGameStatus).
//
// Politeness: <= `concurrency` requests in flight, >= `minGapMs` between request starts, each camera re-checked
// about every `intervalMs` (Caltrans refreshes every 5 min), timeouts, exponential backoff for failing cameras and
// a per-host circuit breaker so a dead Caltrans domain costs a handful of requests, not one per camera.
//
// Status rule (see docs/CAMERAS.md §9):
//   live      HLS playlist + segment verified AND a good snapshot (thumbnails/fallback need the snapshot)
//   snapshot  good snapshot (and no verified stream, or mode=snapshot)
//   simulated anything else (labelled fallback); `reason` says why. `offline` is never emitted by this service.
import type { CameraRecord, CameraSourceStatus } from '@fnab/shared';
import type { CameraDiagnostics, CameraHealth, CameraMode, CameraService, ProbeDiagnostics } from './types';
import { MAX_IMAGE_BYTES, classifySnapshot, looksLikeTsSegment, parsePlaylist, type SnapshotVerdict } from './classify';

export interface CaltransConfig {
  /** Healthy re-check cadence per camera and per probe kind. */
  intervalMs: number;
  /** Per-request timeout (covers headers + body). */
  timeoutMs: number;
  /** Caps apply independently to master and media playlists before HLS parsing. */
  maxPlaylistBytes: number;
  maxPlaylistLines: number;
  /** Max requests in flight (global). */
  concurrency: number;
  /** Minimum spacing between request starts (no startup storm). */
  minGapMs: number;
  /** Consecutive soft failures before a good source is downgraded. Hard (content) evidence downgrades at once. */
  failThreshold: number;
  /** Consecutive stream successes needed to trust a stream that failed at curation time. */
  streamUpgradeSuccesses: number;
  /** Exponential backoff for failing snapshots / streams: base * 2^(fails-1), capped. */
  backoffBaseMs: number;
  backoffMaxMs: number;
  streamBackoffBaseMs: number;
  streamBackoffMaxMs: number;
  /** Last-Modified older than this = frozen camera. */
  staleMs: number;
  /** Caltrans' own snapshot cadence (5 min, each camera on its own phase). */
  imageCadenceMs: number;
  /** Probe this long after a camera's next frame is expected (the file appears ~15-35 s after its Last-Modified). */
  phaseMarginMs: number;
  /** Re-check interval while a camera's next frame is overdue (bounded to the window just after it was due). */
  overdueRecheckMs: number;
  /** +- fraction of random spread applied to healthy re-check times. */
  jitter: number;
  /** Suggested client snapshot refresh interval (sent in the status). */
  refreshMs: number;
  /** Consecutive transport failures on one host before its breaker opens. */
  breakerThreshold: number;
  breakerBaseMs: number;
  breakerMaxMs: number;
  /** How often the scheduler wakes up. */
  pumpMs: number;
  /** Coalesce status broadcasts. */
  notifyDelayMs: number;
  /** TEST HOOK (CAMERA_PROBE_ORIGIN): send every probe to this origin instead of Caltrans (e.g. an unroutable host). */
  probeOrigin: string | null;
}

export const DEFAULT_CALTRANS_CONFIG: CaltransConfig = {
  intervalMs: 300_000,
  timeoutMs: 8_000,
  maxPlaylistBytes: 262_144,
  maxPlaylistLines: 4096,
  concurrency: 3,
  minGapMs: 150,
  failThreshold: 2,
  streamUpgradeSuccesses: 2,
  backoffBaseMs: 30_000,
  backoffMaxMs: 600_000,
  streamBackoffBaseMs: 60_000,
  streamBackoffMaxMs: 900_000,
  staleMs: 15 * 60_000,
  imageCadenceMs: 5 * 60_000,
  phaseMarginMs: 40_000,
  overdueRecheckMs: 60_000,
  jitter: 0.1,
  refreshMs: 60_000,
  breakerThreshold: 6,
  breakerBaseMs: 30_000,
  breakerMaxMs: 300_000,
  pumpMs: 250,
  notifyDelayMs: 300,
  probeOrigin: null,
};

export interface CaltransServiceOptions {
  cameras: CameraRecord[];
  /** `auto`/`live`: HLS where verified, else snapshot, else simulated. `live` shows ONLY verified-live cameras as real
   *  (others simulated). `snapshot`: stills only, streams never probed. */
  mode: Exclude<CameraMode, 'simulation'>;
  config?: Partial<CaltransConfig>;
  fetch?: typeof fetch;
  now?: () => number;
  random?: () => number;
  log?: (msg: string) => void;
}

type Kind = 'snapshot' | 'stream';
type ProbeState = 'unknown' | 'good' | 'bad';

interface Probe {
  state: ProbeState;
  fails: number;
  successes: number;
  lastCheckAt: number | null;
  nextAt: number;
  running: boolean;
  last: string | null;
  /** Human-readable reason of the latest failure (null while good). */
  reason: string | null;
}

interface Cam {
  rec: CameraRecord;
  snap: Probe;
  stream: Probe | null;
  imageAt: number | null;
  lastOkSnapAt: number | null;
  published: CameraSourceStatus;
  sig: string;
}

interface Host {
  /** Distinct cameras whose requests got no answer since the host last answered (dead-stream retries of ONE camera
   *  must not trip the breaker for a host that serves working streams). */
  streakCams: Set<string>;
  streak: number;
  opens: number;
  openUntil: number;
  inflight: number;
}

const newProbe = (nextAt: number): Probe => ({ state: 'unknown', fails: 0, successes: 0, lastCheckAt: null, nextAt, running: false, last: null, reason: null });

interface RawResponse {
  status: number | null;
  headers: Headers | null;
  body: Uint8Array | null;
  text?: string;
  error: string | null;
}

export class CaltransCameraService implements CameraService {
  readonly mode: CameraMode;
  private readonly cfg: CaltransConfig;
  private readonly fetchImpl: () => typeof fetch;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly log: (msg: string) => void;
  private readonly cams = new Map<string, Cam>();
  private readonly hosts = new Map<string, Host>();
  private readonly listeners = new Set<(s: CameraSourceStatus[]) => void>();
  private readonly aborts = new Set<AbortController>();
  private readonly running = new Set<Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private dirty = false;
  private lastStartAt = 0;
  private lastCheckAt: number | null = null;
  private checks = 0;

  constructor(private readonly opts: CaltransServiceOptions) {
    this.mode = opts.mode;
    this.cfg = { ...DEFAULT_CALTRANS_CONFIG, ...(opts.config ?? {}) };
    const f = opts.fetch;
    this.fetchImpl = () => f ?? globalThis.fetch;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.log = opts.log ?? ((m) => console.log(m));
    const t = this.now();
    for (const rec of opts.cameras) {
      const listed = !!rec.streamUrl && opts.mode !== 'snapshot';
      const cam: Cam = {
        rec,
        snap: newProbe(t),
        stream: listed ? newProbe(t) : null,
        imageAt: null,
        lastOkSnapAt: null,
        published: null as never,
        sig: '',
      };
      if (!rec.imageUrl) {
        cam.snap.state = 'bad';
        cam.snap.reason = 'no snapshot URL published for this camera';
        cam.snap.nextAt = Infinity;
      }
      cam.published = this.derive(cam);
      cam.sig = this.signature(cam.published);
      this.cams.set(rec.id, cam);
    }
  }

  // ───────────────────────────────────── CameraService ─────────────────────────────────────

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.schedulePump(0);
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.timer = this.notifyTimer = null;
    for (const a of this.aborts) a.abort();
    this.aborts.clear();
    this.listeners.clear();
  }

  getStatuses(): CameraSourceStatus[] {
    return [...this.cams.values()].map((c) => this.withLive(c));
  }

  getStatus(cameraId: string): CameraSourceStatus | null {
    const c = this.cams.get(cameraId);
    return c ? this.withLive(c) : null;
  }

  subscribe(listener: (s: CameraSourceStatus[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getHealth(): CameraHealth {
    const counts = { live: 0, snapshot: 0, simulated: 0, offline: 0 };
    for (const c of this.cams.values()) counts[c.published.mode]++;
    const t = this.now();
    return {
      mode: this.mode,
      running: this.started,
      total: this.cams.size,
      counts,
      lastCheckAt: this.lastCheckAt,
      checks: this.checks,
      inflight: this.running.size,
      hosts: [...this.hosts.entries()].map(([host, h]) => ({
        host,
        breakerOpen: h.openUntil > t,
        openUntil: h.openUntil > t ? h.openUntil : null,
        failStreak: h.streak,
      })),
    };
  }

  getDiagnostics(): CameraDiagnostics[] {
    const diag = (p: Probe): ProbeDiagnostics => ({
      state: p.state,
      fails: p.fails,
      successes: p.successes,
      lastCheckAt: p.lastCheckAt,
      nextCheckAt: Number.isFinite(p.nextAt) ? p.nextAt : null,
      last: p.last,
    });
    return [...this.cams.values()].map((c) => ({
      cameraId: c.rec.id,
      snapshot: diag(c.snap),
      stream: c.stream ? diag(c.stream) : null,
      curatedStreamPlayable: c.rec.verified.streamPlayable === true,
    }));
  }

  // ───────────────────────────────────── scheduling ─────────────────────────────────────

  /**
   * Start every due probe (respecting concurrency, spacing and breakers) and wait for them to finish.
   * The background loop only calls `pump()`; tests call this with an injected clock.
   */
  async tick(): Promise<void> {
    for (let guard = 0; guard < 10_000; guard++) {
      const started = this.pump(true);
      if (!started && this.running.size === 0) break;
      if (this.running.size) await Promise.race(this.running);
    }
    await Promise.allSettled([...this.running]);
    this.flushNotify();
  }

  private schedulePump(delay: number): void {
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.pump(false);
      } catch (e) {
        this.log(`[cameras] scheduler error: ${(e as Error).message}`);
      }
      this.schedulePump(this.cfg.pumpMs);
    }, delay);
    this.timer.unref?.();
  }

  /** Start due probes. Returns the number started. The background loop starts one per wake-up (spacing). */
  private pump(ignoreGap: boolean): number {
    let started = 0;
    while (this.running.size < this.cfg.concurrency) {
      const t = this.now();
      if (!ignoreGap && t - this.lastStartAt < this.cfg.minGapMs) break;
      const next = this.pickDue(t);
      if (!next) break;
      this.launch(next.cam, next.kind);
      this.lastStartAt = t;
      started++;
      if (!ignoreGap) break;
    }
    return started;
  }

  private pickDue(t: number): { cam: Cam; kind: Kind } | null {
    let best: { cam: Cam; kind: Kind; at: number } | null = null;
    for (const cam of this.cams.values()) {
      for (const kind of ['snapshot', 'stream'] as const) {
        const p = kind === 'snapshot' ? cam.snap : cam.stream;
        if (!p || p.running || p.nextAt > t) continue;
        const host = this.hostOf(kind === 'snapshot' ? cam.rec.imageUrl : cam.rec.streamUrl);
        if (host) {
          const h = this.hosts.get(host);
          if (h && h.openUntil > t) continue; // breaker open
          if (h && h.streak >= this.cfg.breakerThreshold && h.inflight > 0) continue; // half-open: one trial at a time
        }
        if (!best || p.nextAt < best.at) best = { cam, kind, at: p.nextAt };
      }
    }
    return best ? { cam: best.cam, kind: best.kind } : null;
  }

  private launch(cam: Cam, kind: Kind): void {
    const probe = (kind === 'snapshot' ? cam.snap : cam.stream)!;
    probe.running = true;
    const host = this.hostOf(kind === 'snapshot' ? cam.rec.imageUrl : cam.rec.streamUrl);
    const h = host ? this.host(host) : null;
    if (h) h.inflight++;
    const job = (async () => {
      try {
        if (kind === 'snapshot') await this.runSnapshot(cam);
        else await this.runStream(cam);
      } catch (e) {
        // Last line of defence: a probe bug must never escape into the game process.
        this.log(`[cameras] ${cam.rec.id} ${kind} probe crashed: ${(e as Error).message}`);
        this.applyFailure(cam, kind, { hard: false, transport: false, reason: 'internal probe error', last: 'crash' });
      } finally {
        probe.running = false;
        if (h) h.inflight--;
        this.checks++;
        this.lastCheckAt = this.now();
        this.refresh(cam);
      }
    })();
    this.running.add(job);
    void job.finally(() => this.running.delete(job));
  }

  // ───────────────────────────────────── probes ─────────────────────────────────────

  private async runSnapshot(cam: Cam): Promise<void> {
    const url = cam.rec.imageUrl!;
    const res = await this.get(url, { binary: true });
    const verdict: SnapshotVerdict = classifySnapshot({
      status: res.status,
      contentType: res.headers?.get('content-type') ?? null,
      body: res.body,
      lastModified: res.headers?.get('last-modified') ?? null,
      serverDate: res.headers?.get('date') ?? null,
      now: this.now(),
      staleMs: this.cfg.staleMs,
      error: res.error,
    });
    this.noteHost(this.hostOf(url), verdict.ok ? false : verdict.transport, cam.rec.id);
    if (verdict.ok) {
      cam.imageAt = verdict.imageAt ?? this.now();
      cam.lastOkSnapAt = this.now();
      this.applySuccess(cam, 'snapshot', `ok ${verdict.bytes} B`);
    } else {
      this.applyFailure(cam, 'snapshot', { hard: verdict.hard, transport: verdict.transport, reason: verdict.reason, last: verdict.kind });
    }
  }

  private async runStream(cam: Cam): Promise<void> {
    const url = cam.rec.streamUrl!;
    const fail = (reason: string, last: string, hard: boolean, transport = false) => {
      this.noteHost(this.hostOf(url), transport, cam.rec.id);
      this.applyFailure(cam, 'stream', { hard, transport, reason, last });
    };
    const top = await this.get(url, { text: true });
    if (top.status === null) {
      if (/playlist exceeds/.test(top.error ?? '')) return fail(top.error!, 'oversize-playlist', true);
      const timeout = /timeout|abort/i.test(top.error ?? '');
      return fail(timeout ? 'stream playlist request timed out' : `stream unreachable (${top.error ?? 'network error'})`, timeout ? 'timeout' : 'network', false, true);
    }
    if (top.status !== 200) return fail(`stream playlist HTTP ${top.status}`, `http-${top.status}`, false);
    let pl = parsePlaylist(top.text ?? '');
    let mediaUrl = url;
    if (pl.kind === 'master') {
      mediaUrl = new URL(pl.uris[0]!, url).toString();
      const media = await this.get(mediaUrl, { text: true });
      if (/playlist exceeds/.test(media.error ?? '')) return fail(media.error!, 'oversize-playlist', true);
      if (media.status === null) return fail('stream media playlist unreachable', 'network', false, true);
      if (media.status !== 200) return fail(`stream media playlist HTTP ${media.status}`, `http-${media.status}`, false);
      pl = parsePlaylist(media.text ?? '');
    }
    if (pl.kind !== 'media') return fail('stream playlist is not a valid HLS media playlist', 'invalid-playlist', true);
    if (pl.ended) return fail('stream playlist has ended', 'ended', true);
    const seg = new URL(pl.uris[pl.uris.length - 1]!, mediaUrl).toString();
    const segRes = await this.get(seg, { binary: true, range: '0-187', maxBytes: 188 });
    if (segRes.status === null) return fail('stream segment unreachable', 'network', false, true);
    if (segRes.status !== 200 && segRes.status !== 206) return fail(`stream segment HTTP ${segRes.status}`, `segment-http-${segRes.status}`, false);
    if (!segRes.body || !looksLikeTsSegment(segRes.body)) return fail('stream segment is not MPEG-TS', 'bad-segment', true);
    this.noteHost(this.hostOf(url), false, cam.rec.id);
    this.applySuccess(cam, 'stream', 'playlist + segment ok');
  }

  /** One GET with timeout. Never throws. */
  private async get(url: string, o: { binary?: boolean; text?: boolean; range?: string; maxBytes?: number }): Promise<RawResponse> {
    const ctl = new AbortController();
    this.aborts.add(ctl);
    const timer = setTimeout(() => ctl.abort(new Error('timeout')), this.cfg.timeoutMs);
    try {
      const target = this.cfg.probeOrigin ? this.cfg.probeOrigin.replace(/\/$/, '') + new URL(url).pathname + new URL(url).search : url;
      const headers: Record<string, string> = { accept: o.text ? 'application/vnd.apple.mpegurl,*/*' : 'image/jpeg,*/*', 'user-agent': 'FiveNightsAtTheBayArea/0.1 (camera health check; polite, 5-min cadence)' };
      if (o.range) headers.range = `bytes=${o.range}`;
      const res = await this.fetchImpl()(target, { signal: ctl.signal, headers, redirect: 'follow' });
      if (o.text) {
        const body = await readLimited(res, this.cfg.maxPlaylistBytes + 1);
        if (body.byteLength > this.cfg.maxPlaylistBytes) {
          ctl.abort();
          return { status: null, headers: res.headers, body: null, error: 'playlist exceeds byte limit' };
        }
        const text = new TextDecoder().decode(body);
        if (text.split(/\r\n|\r|\n/).length > this.cfg.maxPlaylistLines)
          return { status: null, headers: res.headers, body: null, error: 'playlist exceeds line limit' };
        return { status: res.status, headers: res.headers, body: null, text, error: null };
      }
      const limit = o.maxBytes ?? MAX_IMAGE_BYTES + 1;
      const body = await readLimited(res, limit);
      return { status: res.status, headers: res.headers, body, error: null };
    } catch (e) {
      const err = e as Error;
      const name = ctl.signal.aborted ? 'timeout' : (err.cause as Error | undefined)?.message ?? err.message ?? String(e);
      return { status: null, headers: null, body: null, error: name };
    } finally {
      clearTimeout(timer);
      this.aborts.delete(ctl);
    }
  }

  // ───────────────────────────────────── state machine ─────────────────────────────────────

  private applySuccess(cam: Cam, kind: Kind, last: string): void {
    const t = this.now();
    const p = (kind === 'snapshot' ? cam.snap : cam.stream)!;
    p.lastCheckAt = t;
    p.fails = 0;
    p.successes++;
    p.last = last;
    p.reason = null;
    if (kind === 'snapshot') {
      p.state = 'good';
      p.nextAt = this.nextSnapshotAt(cam, t);
    } else {
      // Streams that were verified playable at curation are trusted at once; others must prove it repeatedly.
      const need = cam.rec.verified.streamPlayable === true ? 1 : this.cfg.streamUpgradeSuccesses;
      if (p.state === 'good' || p.successes >= need) {
        p.state = 'good';
        p.nextAt = t + this.spread(this.cfg.intervalMs);
      } else {
        p.nextAt = t + this.cfg.backoffBaseMs; // confirm soon
      }
    }
  }

  /**
   * Phase-aligned snapshot schedule: each Caltrans camera publishes every 5 minutes on its own phase, so probe just
   * after the next frame is due instead of at a random point (which left `imageAt` and the `?v=` URL up to a full
   * interval behind the real frame). Same request budget: one probe per camera per frame. While a frame is overdue
   * (Caltrans late) re-check a few times at `overdueRecheckMs`; long-stale cameras fall back to the normal interval
   * until the stale rule flags them.
   */
  private nextSnapshotAt(cam: Cam, t: number): number {
    const c = this.cfg;
    const fallback = t + this.spread(c.intervalMs);
    if (cam.imageAt === null) return fallback;
    const expected = cam.imageAt + c.imageCadenceMs + c.phaseMarginMs * (1 + (this.random() * 2 - 1) * c.jitter);
    const wait = expected - t;
    if (wait > 2_000) return wait <= c.intervalMs * 1.5 ? expected : fallback;
    // Overdue: the camera has not published its next frame yet.
    return -wait < 3 * c.overdueRecheckMs ? t + c.overdueRecheckMs : fallback;
  }

  private applyFailure(cam: Cam, kind: Kind, f: { hard: boolean; transport: boolean; reason: string; last: string }): void {
    const t = this.now();
    const p = (kind === 'snapshot' ? cam.snap : cam.stream)!;
    p.lastCheckAt = t;
    p.fails++;
    p.successes = 0;
    p.last = f.last;
    p.reason = f.reason;
    // Hard evidence (the picture itself is bad) downgrades immediately; soft evidence (HTTP hiccup, timeout) needs
    // `failThreshold` consecutive strikes before a good source is dropped, so flapping does not flicker the UI.
    if (p.state !== 'good' || f.hard || p.fails >= this.cfg.failThreshold) p.state = 'bad';
    const base = kind === 'snapshot' ? this.cfg.backoffBaseMs : this.cfg.streamBackoffBaseMs;
    const max = kind === 'snapshot' ? this.cfg.backoffMaxMs : this.cfg.streamBackoffMaxMs;
    p.nextAt = t + this.spread(Math.min(base * 2 ** (p.fails - 1), max));
  }

  // ───────────────────────────────────── circuit breaker ─────────────────────────────────────

  private host(name: string): Host {
    let h = this.hosts.get(name);
    if (!h) this.hosts.set(name, (h = { streakCams: new Set(), streak: 0, opens: 0, openUntil: 0, inflight: 0 }));
    return h;
  }

  private hostOf(url: string | null): string | null {
    if (!url) return null;
    try {
      return new URL(url).host;
    } catch {
      return null;
    }
  }

  /** `transport` = the host did not answer at all. Any HTTP response (even 404) proves the host is up. */
  private noteHost(host: string | null, transport: boolean, camId: string): void {
    if (!host) return;
    const h = this.host(host);
    const t = this.now();
    if (!transport) {
      if (h.streak >= this.cfg.breakerThreshold) this.log(`[cameras] ${host} reachable again`);
      h.streakCams.clear();
      h.streak = 0;
      h.opens = 0;
      h.openUntil = 0;
      return;
    }
    h.streakCams.add(camId);
    h.streak = h.streakCams.size;
    if (h.streak >= this.cfg.breakerThreshold) {
      const wait = Math.min(this.cfg.breakerBaseMs * 2 ** h.opens, this.cfg.breakerMaxMs);
      h.opens++;
      const first = h.openUntil <= t && h.opens === 1;
      h.openUntil = t + wait;
      if (first) this.log(`[cameras] ${host} unreachable (${h.streak} transport failures): pausing probes, falling back to simulated`);
      // Domain-level evidence: everything served from this host is unusable until it answers again.
      for (const cam of this.cams.values()) {
        if (this.hostOf(cam.rec.imageUrl) === host) this.markHostDown(cam, 'snapshot', host, h.openUntil);
        if (cam.stream && this.hostOf(cam.rec.streamUrl) === host) this.markHostDown(cam, 'stream', host, h.openUntil);
      }
    }
  }

  private markHostDown(cam: Cam, kind: Kind, host: string, until: number): void {
    const p = (kind === 'snapshot' ? cam.snap : cam.stream)!;
    if (p.running) return; // its own completion will record the result
    p.state = 'bad';
    p.reason = `${host} unreachable`;
    p.last = 'host-down';
    p.nextAt = Math.max(p.nextAt, until);
    this.refresh(cam);
  }

  // ───────────────────────────────────── derived status ─────────────────────────────────────

  private spread(ms: number): number {
    return ms * (1 + (this.random() * 2 - 1) * this.cfg.jitter);
  }

  private derive(cam: Cam): CameraSourceStatus {
    const rec = cam.rec;
    const base = { cameraId: rec.id, lastUpdated: cam.snap.lastCheckAt ?? cam.stream?.lastCheckAt ?? this.now(), refreshMs: this.cfg.refreshMs };
    const snapGood = cam.snap.state === 'good' && !!rec.imageUrl;
    const streamGood = !!cam.stream && cam.stream.state === 'good';
    const snapUrl = snapGood ? stamp(rec.imageUrl!, cam.imageAt ?? cam.lastOkSnapAt ?? this.now()) : null;
    if (snapGood && streamGood) {
      return { ...base, mode: 'live', snapshotUrl: snapUrl, streamUrl: rec.streamUrl, error: null, imageAt: cam.imageAt, reason: 'HLS stream verified playable; snapshot good' };
    }
    if (snapGood && this.mode === 'live') {
      const why = cam.stream ? (cam.stream.reason ?? 'stream not yet verified') : 'Caltrans publishes no stream for this camera';
      return { ...base, mode: 'simulated', snapshotUrl: null, streamUrl: null, error: null, imageAt: null, reason: `live-only mode: ${why}` };
    }
    if (snapGood) {
      const why = this.mode === 'snapshot' ? 'snapshot mode' : cam.stream ? (cam.stream.reason ?? 'stream not yet verified') : 'no stream published';
      return { ...base, mode: 'snapshot', snapshotUrl: snapUrl, streamUrl: null, error: null, imageAt: cam.imageAt, reason: `snapshot good (${why})` };
    }
    const never = cam.snap.state === 'unknown';
    return {
      ...base,
      mode: 'simulated',
      snapshotUrl: null,
      streamUrl: null,
      error: cam.snap.last && !never ? cam.snap.last : null,
      imageAt: null,
      reason: never ? 'checking Caltrans source…' : (cam.snap.reason ?? 'source unavailable'),
    };
  }

  private signature(s: CameraSourceStatus): string {
    return [s.mode, s.snapshotUrl, s.streamUrl, s.reason, s.imageAt].join('|');
  }

  private withLive(c: Cam): CameraSourceStatus {
    return { ...c.published, lastUpdated: c.snap.lastCheckAt ?? c.stream?.lastCheckAt ?? c.published.lastUpdated };
  }

  private refresh(cam: Cam): void {
    const next = this.derive(cam);
    const sig = this.signature(next);
    if (sig === cam.sig) {
      cam.published = next;
      return;
    }
    if (next.mode !== cam.published.mode) this.log(`[cameras] ${cam.rec.id}: ${cam.published.mode} -> ${next.mode} (${next.reason})`);
    cam.published = next;
    cam.sig = sig;
    this.dirty = true;
    if (this.started && !this.notifyTimer) {
      this.notifyTimer = setTimeout(() => {
        this.notifyTimer = null;
        this.flushNotify();
      }, this.cfg.notifyDelayMs);
      this.notifyTimer.unref?.();
    }
  }

  private flushNotify(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const all = this.getStatuses();
    for (const l of [...this.listeners]) {
      try {
        l(all);
      } catch (e) {
        this.log(`[cameras] listener error: ${(e as Error).message}`);
      }
    }
  }
}

/** Cache-busting version aligned to the image's own timestamp (all clients share one URL per Caltrans frame). */
function stamp(url: string, at: number): string {
  return url + (url.includes('?') ? '&' : '?') + 'v=' + Math.floor(at / 1000);
}

/** Read at most `limit` bytes of a body, then cancel the rest (a Range-ignoring server cannot cost us a segment). */
async function readLimited(res: Response, limit: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  if (total >= limit) void reader.cancel().catch(() => undefined);
  const out = new Uint8Array(Math.min(total, limit));
  let o = 0;
  for (const c of chunks) {
    const part = c.subarray(0, out.length - o);
    out.set(part, o);
    o += part.length;
  }
  return out;
}
