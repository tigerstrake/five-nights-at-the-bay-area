import { useEffect, useRef } from 'react';
import type Hls from 'hls.js';

const START_TIMEOUT_MS = 15_000;
const STALL_TIMEOUT_MS = 12_000;

export interface HlsCallbacks {
  /** Video frames are actually advancing. Only then may the UI call the feed LIVE. */
  onPlaying: () => void;
  /** Unrecoverable (2 fatal errors, start timeout, long stall, unsupported): fall back to the snapshot. */
  onFail: () => void;
}

/**
 * hls.js (lazy-loaded) / native HLS player bound to a <video>. Tuned for a ~30 s behind-live traffic camera:
 * no low-latency mode, tiny buffer, short timeouts. Destroys everything when disabled or unmounted.
 */
export function useHls(url: string | null, enabled: boolean, cb: HlsCallbacks) {
  const ref = useRef<HTMLVideoElement>(null);
  const cbRef = useRef(cb);
  cbRef.current = cb;

  useEffect(() => {
    const video = ref.current;
    if (!video || !url || !enabled) return;
    let hls: Hls | null = null;
    let dead = false;
    let fatalCount = 0;
    let stall: ReturnType<typeof setTimeout> | null = null;
    const fail = () => {
      if (dead) return;
      dead = true;
      cbRef.current.onFail();
    };
    const startTimer = setTimeout(fail, START_TIMEOUT_MS);
    const onPlaying = () => {
      clearTimeout(startTimer);
      if (stall) clearTimeout(stall);
      stall = null;
      if (!dead) cbRef.current.onPlaying();
    };
    const onWaiting = () => {
      if (!stall) stall = setTimeout(fail, STALL_TIMEOUT_MS);
    };
    video.addEventListener('playing', onPlaying);
    video.addEventListener('waiting', onWaiting);

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      video.addEventListener('error', fail);
      void video.play().catch(() => undefined);
    } else {
      void import('hls.js')
        .then(({ default: HlsCtor }) => {
          if (dead) return;
          if (!HlsCtor.isSupported()) return fail();
          hls = new HlsCtor({
            lowLatencyMode: false,
            maxBufferLength: 8,
            maxMaxBufferLength: 12,
            backBufferLength: 0,
            manifestLoadingTimeOut: 8000,
            manifestLoadingMaxRetry: 1,
            levelLoadingTimeOut: 8000,
            levelLoadingMaxRetry: 1,
            fragLoadingTimeOut: 12000,
            fragLoadingMaxRetry: 1,
          });
          hls.on(HlsCtor.Events.ERROR, (_e, data) => {
            if (!data.fatal) return;
            fatalCount++;
            if (fatalCount >= 2) return fail();
            if (data.type === HlsCtor.ErrorTypes.NETWORK_ERROR) hls?.startLoad();
            else if (data.type === HlsCtor.ErrorTypes.MEDIA_ERROR) hls?.recoverMediaError();
            else fail();
          });
          hls.loadSource(url);
          hls.attachMedia(video);
          void video.play().catch(() => undefined);
        })
        .catch(fail);
    }
    return () => {
      dead = true;
      clearTimeout(startTimer);
      if (stall) clearTimeout(stall);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('error', fail);
      hls?.destroy();
      video.removeAttribute('src');
      video.load();
    };
  }, [url, enabled]);
  return ref;
}
