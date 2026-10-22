// Pure stall watchdog for a live HLS <video> (no DOM, injected clock; unit-tested).
//
// Why: Caltrans streams flap. A stream that stops producing segments, a bufferStalled hole or a native player that
// sits at the live edge leaves the <video> on its last frame without any fatal error. Only *progress* proves the
// feed is live, so the UI may call a feed LIVE only while `advancing` is true. When progress stops the watchdog walks
// a recovery ladder (nudge -> restart loading -> recover media -> reload source -> give up); every rung fires once
// per stall episode, and any real progress resets the episode.

export interface PlaybackSample {
  now: number;
  currentTime: number;
  /** getVideoPlaybackQuality().totalVideoFrames, when available. */
  frames: number | null;
  paused: boolean;
  /** HTMLMediaElement.readyState. */
  readyState: number;
  /** End of the buffered range that contains currentTime (s), or null. */
  bufferedEnd: number | null;
  /** End of the seekable range (live edge) in seconds, or null. */
  seekableEnd: number | null;
  /** Tab hidden: browsers may legitimately suspend video, so nothing counts as a stall. */
  hidden: boolean;
}

export type WatchAction =
  | 'none'
  /** Call play() (autoplay hiccup / paused by the browser). */
  | 'play'
  /** Small seek forward over a buffer hole, or to the live edge when far behind. */
  | 'nudge'
  /** Jump close to the live edge (we drifted too far behind real time). */
  | 'seek-live'
  /** hls.js startLoad() (playlist/fragment loading stopped). */
  | 'restart-load'
  /** hls.js recoverMediaError() (decoder/MSE wedged). */
  | 'recover-media'
  /** Tear down and load the source again. */
  | 'reload-source'
  /** Give up: the caller falls back to the snapshot and retries live later. */
  | 'fail';

export interface WatchdogConfig {
  /** No progress for this long -> not live any more (badge changes). */
  frozenMs: number;
  /** Ladder: no-progress duration at which each rung fires (ms, ascending). */
  ladder: Array<{ atMs: number; action: Exclude<WatchAction, 'none' | 'play' | 'seek-live'> }>;
  /** Give up if the first frame never advances within this time. */
  startTimeoutMs: number;
  /** Reload the source once if nothing started after this long. */
  startReloadMs: number;
  /** currentTime must advance at least this much (s) to count as progress. */
  minAdvanceS: number;
  /** Behind the live edge by more than this (s) -> seek-live (native players; hls.js has its own live sync). */
  maxLatencyS: number;
  /** Where seek-live lands, seconds behind the live edge. */
  targetLatencyS: number;
}

export const DEFAULT_WATCHDOG: WatchdogConfig = {
  frozenMs: 2_500,
  // Caltrans/Wowza outages measured 30-110 s (playlist requests time out, then the stream restarts with a new media
  // sequence), so after the cheap rungs keep reloading every 10 s for a while: playback resumes within ~10 s of the
  // stream coming back instead of after a full retry backoff. The still is already on screen from 6 s on.
  ladder: [
    { atMs: 3_000, action: 'nudge' },
    { atMs: 6_000, action: 'restart-load' },
    { atMs: 10_000, action: 'recover-media' },
    { atMs: 15_000, action: 'reload-source' },
    { atMs: 25_000, action: 'reload-source' },
    { atMs: 35_000, action: 'reload-source' },
    { atMs: 45_000, action: 'reload-source' },
    { atMs: 55_000, action: 'reload-source' },
    { atMs: 65_000, action: 'reload-source' },
    { atMs: 75_000, action: 'reload-source' },
    { atMs: 90_000, action: 'fail' },
  ],
  startTimeoutMs: 20_000,
  startReloadMs: 10_000,
  minAdvanceS: 0.04,
  maxLatencyS: 45,
  targetLatencyS: 16,
};

export interface WatchVerdict {
  /** Frames are advancing right now (the only condition under which a feed may be shown as LIVE). */
  advancing: boolean;
  /** Has the video ever advanced since (re)start? */
  started: boolean;
  /** How long playback has not advanced (0 while advancing). */
  stalledMs: number;
  action: WatchAction;
}

export interface WatchStats {
  /** Stall episodes longer than `frozenMs`. */
  stalls: number;
  /** Episodes that ended with progress again (recovered without giving up). */
  recoveries: number;
  /** Durations (ms) of finished stall episodes. */
  stallDurations: number[];
  /** Ladder actions taken, in order. */
  actions: WatchAction[];
}

export class StallWatchdog {
  private readonly cfg: WatchdogConfig;
  private startedAt: number | null = null;
  private lastProgressAt: number | null = null;
  private lastCt = -1;
  private lastFrames: number | null = null;
  private everAdvanced = false;
  private fired = new Set<number>();
  private startReloaded = false;
  private inStall = false;
  private lastSeekLiveAt = -Infinity;
  readonly stats: WatchStats = { stalls: 0, recoveries: 0, stallDurations: [], actions: [] };

  constructor(cfg: Partial<WatchdogConfig> = {}) {
    this.cfg = { ...DEFAULT_WATCHDOG, ...cfg };
  }

  /** Restart the stall clock and the progress baseline (the tab became visible again). */
  rebase(now: number): void {
    this.lastProgressAt = now;
    this.resetBaseline();
  }

  /**
   * After a source reload: currentTime / frame counters restart, so the next sample must not be credited as progress,
   * but the stall clock keeps running (the picture is still not advancing; the ladder continues).
   */
  resetBaseline(): void {
    this.lastCt = -1;
    this.lastFrames = null;
  }

  sample(s: PlaybackSample): WatchVerdict {
    const c = this.cfg;
    if (this.startedAt === null) this.startedAt = s.now;
    if (this.lastProgressAt === null) this.lastProgressAt = s.now;
    if (s.hidden) {
      // Hidden tabs may pause video on purpose: never count that as a stall; re-baseline on return.
      this.rebase(s.now);
      return this.verdict(false, 0, 'none');
    }
    const ctMoved = this.lastCt >= 0 && s.currentTime - this.lastCt >= c.minAdvanceS;
    const framesMoved = this.lastFrames !== null && s.frames !== null && s.frames > this.lastFrames;
    // A backwards jump (seek / reload) is a rebase, not progress.
    const rewound = this.lastCt >= 0 && s.currentTime < this.lastCt - 0.5;
    const progressed = !rewound && (ctMoved || framesMoved) && !s.paused;
    this.lastCt = s.currentTime;
    this.lastFrames = s.frames;

    if (progressed) {
      if (this.inStall) {
        this.stats.recoveries++;
        this.stats.stallDurations.push(s.now - this.lastProgressAt);
      }
      this.inStall = false;
      this.everAdvanced = true;
      this.lastProgressAt = s.now;
      this.fired.clear();
      // Drifted far behind real time (e.g. after the tab was throttled): jump back near the edge.
      if (s.seekableEnd !== null && s.seekableEnd - s.currentTime > c.maxLatencyS && s.now - this.lastSeekLiveAt > 10_000) {
        this.lastSeekLiveAt = s.now;
        return this.act(true, 0, 'seek-live');
      }
      return this.verdict(true, 0, 'none');
    }

    const stalledMs = s.now - this.lastProgressAt;
    if (!this.everAdvanced) {
      // Start phase: one reload, then give up.
      const since = s.now - this.startedAt;
      if (since >= c.startTimeoutMs) return this.act(false, stalledMs, 'fail');
      if (since >= c.startReloadMs && !this.startReloaded) {
        this.startReloaded = true;
        return this.act(false, stalledMs, 'reload-source');
      }
      if (s.paused && s.readyState >= 2) return this.verdict(false, stalledMs, 'play');
      return this.verdict(false, stalledMs, 'none');
    }

    if (stalledMs >= c.frozenMs && !this.inStall) {
      this.inStall = true;
      this.stats.stalls++;
    }
    if (s.paused && stalledMs >= 1_000 && !this.fired.has(-1)) {
      this.fired.add(-1);
      return this.act(false, stalledMs, 'play');
    }
    for (let i = c.ladder.length - 1; i >= 0; i--) {
      const rung = c.ladder[i]!;
      if (stalledMs >= rung.atMs) {
        if (this.fired.has(i)) break;
        // Fire the highest rung reached (skipping lower ones that were never reached, e.g. after a long hidden gap).
        for (let j = 0; j <= i; j++) this.fired.add(j);
        if (rung.action === 'fail') this.stats.stallDurations.push(stalledMs);
        return this.act(false, stalledMs, rung.action);
      }
    }
    // Short hiccups (< frozenMs) still count as advancing so a segment boundary does not flicker the badge.
    return this.verdict(stalledMs < c.frozenMs, stalledMs, 'none');
  }

  private act(advancing: boolean, stalledMs: number, action: WatchAction): WatchVerdict {
    this.stats.actions.push(action);
    return this.verdict(advancing, stalledMs, action);
  }

  private verdict(advancing: boolean, stalledMs: number, action: WatchAction): WatchVerdict {
    return { advancing: advancing && this.everAdvanced, started: this.everAdvanced, stalledMs, action };
  }
}

/** Backoff before trying live video again after a local give-up: 30 s, 60 s, 120 s ... capped. */
export function liveRetryDelay(failures: number, baseMs = 30_000, maxMs = 300_000): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, failures - 1));
}
