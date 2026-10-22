import { useEffect, useRef } from 'react';
import type Hls from 'hls.js';
import { DEFAULT_WATCHDOG, StallWatchdog, type PlaybackSample, type WatchAction } from './stallWatchdog';
import { feedLog } from './feedDebug';

const SAMPLE_MS = 500;
/** Fatal hls.js errors tolerated (each answered with startLoad / recoverMediaError / reload) before giving up. */
const MAX_FATAL = 4;
const FATAL_RETRY_MS = 1000;
const HEALTHY_RESET_MS = 30_000;

export interface HlsState {
  /** Frames are advancing right now: the only state in which the UI may say LIVE. */
  advancing: boolean;
  /** Video has played at least once since this source was (re)attached. */
  started: boolean;
  /** How long the picture has not advanced (ms, rounded to 500 ms; 0 while advancing). */
  stalledMs: number;
}

export interface HlsCallbacks {
  onState: (s: HlsState) => void;
  /** Gave up (start timeout, ladder exhausted, unsupported): fall back to the still and retry live later. */
  onFail: (why: string) => void;
}

export interface HlsOptions {
  cameraId: string;
  variant: 'main' | 'thumb';
}

/** Live-edge settings for Caltrans/Wowza playlists: ~10 s segments, 3 per playlist (≈30 s window). */
export const HLS_CONFIG = {
  lowLatencyMode: false,
  // Sit ~1.5 segments behind the newest segment: enough runway for one late playlist refresh without stalling,
  // and well inside the 30 s window so the playhead never falls off the start of the playlist.
  liveSyncDuration: 15,
  liveMaxLatencyDuration: 28,
  maxLiveSyncPlaybackRate: 1.1,
  maxBufferLength: 20,
  maxMaxBufferLength: 30,
  backBufferLength: 6,
  maxBufferHole: 0.5,
  nudgeMaxRetry: 6,
  manifestLoadingTimeOut: 8000,
  manifestLoadingMaxRetry: 2,
  manifestLoadingRetryDelay: 1000,
  levelLoadingTimeOut: 8000,
  levelLoadingMaxRetry: 6,
  levelLoadingRetryDelay: 1000,
  levelLoadingMaxRetryTimeout: 8000,
  fragLoadingTimeOut: 15000,
  fragLoadingMaxRetry: 4,
  fragLoadingRetryDelay: 1000,
  fragLoadingMaxRetryTimeout: 8000,
} as const;

function bufferedEndAt(v: HTMLVideoElement): { end: number | null; nextStart: number | null } {
  const b = v.buffered;
  const t = v.currentTime;
  for (let i = 0; i < b.length; i++) {
    if (b.start(i) <= t + 0.25 && b.end(i) >= t) return { end: b.end(i), nextStart: i + 1 < b.length ? b.start(i + 1) : null };
    if (b.start(i) > t) return { end: null, nextStart: b.start(i) };
  }
  return { end: null, nextStart: null };
}

/**
 * Live HLS bound to a <video>: hls.js where MSE exists (it gives us live-sync, error events and a recovery API),
 * native HLS otherwise (Safari without MSE). A stall watchdog samples real progress (currentTime / decoded frames)
 * every 500 ms and walks a recovery ladder; the UI is told `advancing` so it never shows LIVE over a frozen frame.
 * Everything is destroyed when disabled or unmounted.
 */
export function useHls(url: string | null, enabled: boolean, cb: HlsCallbacks, opts: HlsOptions) {
  const ref = useRef<HTMLVideoElement>(null);
  const cbRef = useRef(cb);
  cbRef.current = cb;
  const { cameraId, variant } = opts;

  useEffect(() => {
    const video = ref.current;
    if (!video || !url || !enabled) return;
    const log = (ev: string, detail?: string) => feedLog(cameraId, variant, ev, detail);
    let HlsCtor: typeof Hls | null = null;
    let hls: Hls | null = null;
    let dead = false;
    let fatal = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let healthySince: number | null = null;
    let lastKey = '';
    const wd = new StallWatchdog();
    const emit = (s: HlsState) => {
      const key = `${s.advancing}|${s.started}|${s.stalledMs}`;
      if (key === lastKey || dead) return;
      lastKey = key;
      cbRef.current.onState(s);
    };
    const fail = (why: string) => {
      if (dead) return;
      log('fail', why);
      emit({ advancing: false, started: false, stalledMs: 0 });
      dead = true;
      clearTimeout(retryTimer);
      detach();
      cbRef.current.onFail(why);
    };
    const play = () => void video.play().catch(() => undefined);

    const detach = () => {
      if (hls) {
        hls.destroy();
        hls = null;
      }
      video.removeAttribute('src');
      video.load();
    };
    const recoverFatal = (why: string, recover: () => void) => {
      if (dead) return;
      healthySince = null;
      if (++fatal > MAX_FATAL) return fail(why);
      if (retryTimer !== undefined) return;
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        if (!dead) recover();
      }, FATAL_RETRY_MS * 2 ** (fatal - 1));
    };
    const attach = () => {
      if (HlsCtor) {
        const h = new HlsCtor({ ...HLS_CONFIG });
        hls = h;
        h.on(HlsCtor.Events.ERROR, (_e, data) => {
          if (dead || h !== hls) return;
          log(data.fatal ? 'hls-fatal' : 'hls-error', `${data.type}/${data.details}`);
          if (!data.fatal) return;
          recoverFatal(`hls.js fatal ${data.details}`, () => {
            if (h !== hls) return;
            if (data.type === HlsCtor!.ErrorTypes.NETWORK_ERROR) h.startLoad();
            else if (data.type === HlsCtor!.ErrorTypes.MEDIA_ERROR) h.recoverMediaError();
            else reload('fatal ' + data.details);
          });
        });
        h.loadSource(url);
        h.attachMedia(video);
      } else {
        video.src = url;
      }
      play();
    };
    const reload = (why: string) => {
      if (dead || retryTimer !== undefined) return;
      log('reload', why);
      healthySince = null;
      detach();
      attach();
      wd.resetBaseline();
    };
    const onVideoError = () => {
      // Native playback has no recovery API. Keep a bounded budget across source reloads.
      if (HlsCtor || dead) return;
      log('video-error', String(video.error?.code ?? ''));
      recoverFatal('native video error', () => reload('native video error'));
    };
    video.addEventListener('error', onVideoError);

    const seekLive = (why: string) => {
      const live = hls?.liveSyncPosition ?? (video.seekable.length ? video.seekable.end(video.seekable.length - 1) - DEFAULT_WATCHDOG.targetLatencyS : null);
      if (live != null && Number.isFinite(live) && live > video.currentTime + 1) {
        log('seek-live', `${why} ${video.currentTime.toFixed(1)}->${live.toFixed(1)}`);
        video.currentTime = live;
      }
    };
    const run = (a: WatchAction) => {
      if (a === 'none') return;
      log('watchdog', a);
      switch (a) {
        case 'play':
          return play();
        case 'nudge': {
          const { nextStart } = bufferedEndAt(video);
          if (nextStart !== null && nextStart > video.currentTime) video.currentTime = nextStart + 0.1; // hop a buffer hole
          else seekLive('nudge');
          hls?.startLoad(-1);
          return play();
        }
        case 'seek-live':
          return seekLive('latency');
        case 'restart-load':
          if (hls) {
            hls.stopLoad();
            hls.startLoad(-1);
          } else seekLive('restart');
          return play();
        case 'recover-media':
          if (hls) hls.recoverMediaError();
          else reload('recover');
          return play();
        case 'reload-source':
          return reload('watchdog');
        case 'fail':
          return fail('stalled');
      }
    };
    const tick = () => {
      if (dead) return;
      const q = video.getVideoPlaybackQuality?.();
      const { end } = bufferedEndAt(video);
      const s: PlaybackSample = {
        now: Date.now(),
        currentTime: video.currentTime,
        frames: q ? q.totalVideoFrames : null,
        paused: video.paused,
        readyState: video.readyState,
        bufferedEnd: end,
        seekableEnd: video.seekable.length ? video.seekable.end(video.seekable.length - 1) : null,
        hidden: document.hidden,
      };
      const v = wd.sample(s);
      // Replenish the budget only after continuous playback progress, never on reload or a brief frame.
      if (v.advancing && v.stalledMs === 0 && !s.hidden && !s.paused && retryTimer === undefined) {
        healthySince ??= s.now;
        if (s.now - healthySince >= HEALTHY_RESET_MS) fatal = 0;
      } else healthySince = null;
      run(v.action);
      emit({ advancing: v.advancing, started: v.started, stalledMs: v.advancing ? 0 : Math.round(v.stalledMs / 500) * 500 });
    };
    const onVisible = () => {
      if (document.hidden || dead) return;
      // Browsers pause background video; coming back, jump to the live edge instead of replaying stale buffer.
      wd.rebase(Date.now());
      seekLive('visible');
      play();
    };
    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(tick, SAMPLE_MS);

    void import('hls.js')
      .then(({ default: Ctor }) => {
        if (dead) return;
        if (Ctor.isSupported()) HlsCtor = Ctor;
        else if (!video.canPlayType('application/vnd.apple.mpegurl')) return fail('HLS unsupported');
        log('attach', HlsCtor ? 'hls.js' : 'native');
        attach();
      })
      .catch(() => {
        if (dead) return;
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
          log('attach', 'native');
          attach();
        } else fail('hls.js failed to load');
      });

    return () => {
      dead = true;
      clearTimeout(retryTimer);
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      video.removeEventListener('error', onVideoError);
      const st = wd.stats;
      if (st.stalls || st.actions.length) log('stats', `stalls=${st.stalls} recovered=${st.recoveries} actions=${st.actions.join(',')}`);
      detach();
    };
  }, [url, enabled, cameraId, variant]);
  return ref;
}
