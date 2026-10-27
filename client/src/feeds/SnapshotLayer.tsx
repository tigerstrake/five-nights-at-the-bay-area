// Real Caltrans still with honest, smooth refresh: the next frame is fetched and decoded OFF-DOM, checked for the
// "Temporarily Unavailable" card, then revealed over the current one. A refetch that returns the SAME Caltrans frame
// (same Last-Modified) changes nothing on screen; a genuinely new frame is revealed with a short top-to-bottom
// "refresh" wipe (plain cross-fade with reduced motion) and reported to the parent as new.
//
// Polling follows the camera's own 5-minute cadence (see freshness.ts#nextPollDelay) instead of a blind 60 s timer,
// keeps running across errors (bounded retries, then the parent re-arms) and resumes immediately when the tab
// becomes visible again or when the still is re-activated after live video stops.
import { useEffect, useRef, useState } from 'react';
import { MAX_FRAME_AGE_MS, frameConsistency, measureFrameLight, timeOfDayAt } from '@fnab/shared';
import { bustUrl, looksUnavailable } from './sourceUtils';
import { nextPollDelay } from './freshness';
import { serverNow } from '../state/store';
import { feedLog } from './feedDebug';

const FADE_MS = 800;
const WIPE_MS = 900;
const RETRY_MS = 5_000;
/** One deadline for request + body + decode: a hanging Caltrans response must not stall the feed forever. */
const LOAD_DEADLINE_MS = 15_000;
const MAX_FAILS_INITIAL = 2;
const MAX_FAILS_AFTER_SHOWN = 3;
/** Requests within this window share one URL (bucketed cache-buster). */
const BUCKET_MS = 15_000;
const IMG_CLASS = 'absolute inset-0 h-full w-full object-cover [filter:grayscale(0.35)_contrast(1.08)_brightness(0.9)]';

interface Frame {
  id: number;
  src: string;
  /** Revealed with the refresh wipe (a genuinely new Caltrans frame after the first one). */
  wipe: boolean;
}

export interface SnapshotFrameInfo {
  /** Image time from Caltrans' Last-Modified (null if unreadable). */
  imageAt: number | null;
  /** A different Caltrans frame than the one already on screen (false for the first frame). */
  isNew: boolean;
}

export interface SnapshotLayerProps {
  /** Snapshot URL from the camera service (carries `?v=<image timestamp>`; changes when the server saw a new frame). */
  url: string;
  servedFrame?: 'current' | 'history';
  imageAt?: number | null;
  lat?: number;
  lon?: number;
  /** Fallback poll interval when the image time is unknown. */
  refreshMs: number;
  /** False while live video is covering the still (no polling, bandwidth saved). */
  active: boolean;
  alt: string;
  /** Use the top-to-bottom refresh wipe for new frames (off with reduced motion). */
  wipe: boolean;
  cameraId: string;
  variant: 'main' | 'thumb';
  /** Mark the newest still as the FX overlay's source (false while live video is the visible picture). */
  fxSource: boolean;
  onFrame: (info: SnapshotFrameInfo) => void;
  /** Local failure: the source cannot supply a usable picture -> parent falls back to the simulation. */
  onFail: (why: 'card' | 'black' | 'error' | 'time-mismatch') => void;
}

function FadeImg({ src, alt, wipe, top }: { src: string; alt: string; wipe: boolean; top: boolean }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const style: React.CSSProperties = wipe
    ? { clipPath: shown ? 'inset(0 0 0 0)' : 'inset(0 0 100% 0)', transition: `clip-path ${WIPE_MS}ms linear` }
    : { opacity: shown ? 1 : 0, transition: `opacity ${FADE_MS}ms ease-in-out` };
  return (
    <>
      <img
        crossOrigin="anonymous"
        src={src}
        alt={alt}
        draggable={false}
        className={IMG_CLASS}
        style={style}
        // The FX overlay distorts whatever element carries this flag: always the newest still, never an old one.
        data-fx-source={top ? '' : undefined}
      />
      {wipe && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 h-[2px] bg-white/60 shadow-[0_0_8px_rgba(255,255,255,0.7)]"
          style={{ top: shown ? '100%' : '0%', opacity: shown ? 0 : 1, transition: `top ${WIPE_MS}ms linear, opacity 200ms ease-in ${WIPE_MS - 150}ms` }}
        />
      )}
    </>
  );
}

export function SnapshotLayer(p: SnapshotLayerProps) {
  const [frames, setFrames] = useState<Frame[]>([]);
  const cb = useRef(p);
  cb.current = p;
  const state = useRef({
    seq: 0,
    /** Last-Modified of the frame on screen ('' unknown). */
    shownLm: '',
    imageAt: null as number | null,
    fails: 0,
    shown: 0,
    urls: new Set<string>(),
    unmounted: false,
  });

  useEffect(() => {
    let cancelled = false;
    const st = state.current;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (ms: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (cancelled) return;
        if (document.hidden) return; // resumed by the visibility listener
        void load(bustUrl(p.url, Math.floor(serverNow() / BUCKET_MS)));
      }, ms);
    };
    const scheduleNext = () => {
      if (!p.active || p.servedFrame === 'history') return;
      schedule(nextPollDelay(st.imageAt, serverNow(), p.refreshMs));
    };

    // At most ONE request is outstanding per feed.
    let inflight: AbortController | null = null;
    const fail = (): void => {
      st.fails++;
      feedLog(p.cameraId, p.variant, 'still-error', String(st.fails));
      // Bounded: after a few consecutive failures the parent falls back (and re-arms this layer later).
      if (st.fails >= (st.shown ? MAX_FAILS_AFTER_SHOWN : MAX_FAILS_INITIAL)) return cb.current.onFail('error');
      schedule(RETRY_MS);
    };
    const load = async (target: string): Promise<void> => {
      if (inflight) return;
      const ctl = new AbortController();
      inflight = ctl;
      let timedOut = false;
      const deadline = setTimeout(() => {
        timedOut = true;
        ctl.abort();
      }, LOAD_DEADLINE_MS);
      let objectUrl: string | null = null;
      let failed = false;
      try {
        const abortable = <T,>(work: Promise<T>): Promise<T> =>
          new Promise<T>((resolve, reject) => {
            const onAbort = () => reject(new DOMException('aborted', 'AbortError'));
            if (ctl.signal.aborted) return onAbort();
            ctl.signal.addEventListener('abort', onAbort, { once: true });
            work.then(resolve, reject).finally(() => ctl.signal.removeEventListener('abort', onAbort));
          });
        const res = await fetch(target, { mode: 'cors', cache: 'no-store', credentials: 'omit', signal: ctl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const lm = res.headers.get('last-modified') ?? '';
        const parsed = lm ? Date.parse(lm) : NaN;
        const at = Number.isFinite(parsed) ? parsed : null;
        if (at !== null && serverNow() - at > MAX_FRAME_AGE_MS) {
          void res.body?.cancel().catch(() => undefined);
          cb.current.onFail('time-mismatch');
          return;
        }
        if (lm && lm === st.shownLm) {
          // Same Caltrans frame as on screen: nothing to show, just wait for the next one.
          void res.body?.cancel().catch(() => undefined);
          st.fails = 0;
          return;
        }
        const blob = await abortable(res.blob());
        objectUrl = URL.createObjectURL(blob);
        const img = new Image();
        img.src = objectUrl;
        await abortable(img.decode());
        // Pixel check on a tiny downscale (blob is same-origin, canvas is never tainted).
        const c = document.createElement('canvas');
        c.width = 40;
        c.height = 32;
        const g = c.getContext('2d', { willReadFrequently: true });
        let bad: 'card' | 'black' | 'time-mismatch' | null = null;
        if (g) {
          g.drawImage(img, 0, 0, c.width, c.height);
          const pixels = g.getImageData(0, 0, c.width, c.height).data;
          bad = looksUnavailable(pixels, c.width, c.height);
          const light = measureFrameLight(pixels, c.width, c.height);
          const tod = timeOfDayAt(serverNow(), p.lat, p.lon);
          if (frameConsistency(light, tod, at, serverNow()).timeMismatch ||
              (p.servedFrame === 'history' && (at === null || at !== p.imageAt))) bad = 'time-mismatch';
        }
        c.width = c.height = 0;
        if (cancelled || bad) {
          URL.revokeObjectURL(objectUrl);
          if (!cancelled && bad) cb.current.onFail(bad);
          return;
        }
        const isNew = st.shown > 0;
        st.shownLm = lm;
        st.imageAt = at;
        st.fails = 0;
        st.shown++;
        st.urls.add(objectUrl);
        const frame: Frame = { id: ++st.seq, src: objectUrl, wipe: isNew && cb.current.wipe };
        const drop = (f: Frame) => {
          URL.revokeObjectURL(f.src);
          st.urls.delete(f.src);
        };
        setFrames((prev) => {
          prev.slice(0, -1).forEach(drop);
          return [...prev.slice(-1), frame];
        });
        feedLog(p.cameraId, p.variant, isNew ? 'still-new' : 'still-first', lm);
        cb.current.onFrame({ imageAt: at, isNew });
        // Once the new frame is fully revealed, drop the old one (even if this effect run was superseded).
        setTimeout(() => {
          if (st.unmounted) return;
          setFrames((prev) => {
            prev.filter((f) => f.id < frame.id).forEach(drop);
            return prev.filter((f) => f.id >= frame.id);
          });
        }, Math.max(FADE_MS, WIPE_MS) + 150);
      } catch (e) {
        if (objectUrl && !st.urls.has(objectUrl)) URL.revokeObjectURL(objectUrl);
        if (cancelled || ((e as Error).name === 'AbortError' && !timedOut)) return;
        failed = true;
        fail();
      } finally {
        clearTimeout(deadline);
        if (inflight === ctl) inflight = null;
        // Every outcome except a failure (which schedules its own retry) re-arms the cadence timer.
        if (!cancelled && !failed) scheduleNext();
      }
    };

    // First frame (or a newer frame the server announced) right away; afterwards follow the camera's cadence.
    // Re-activated after live video, or a frame is overdue: fetch now instead of waiting a full interval.
    // The server's `?v=` names the frame it last saw; if that is the frame already on screen there is nothing to fetch.
    const announced = Number(/[?&]v=(\d+)/.exec(p.url)?.[1] ?? NaN) * 1000;
    const alreadyShown = st.imageAt !== null && Math.abs(announced - st.imageAt) < 1000;
    if (!st.shown) void load(p.url);
    else if (p.active && !alreadyShown) void load(bustUrl(p.url, Math.floor(serverNow() / BUCKET_MS)));
    else scheduleNext();
    const onVisible = () => {
      if (document.hidden || cancelled || !p.active || p.servedFrame === 'history') return;
      if (!timer || nextPollDelay(st.imageAt, serverNow(), p.refreshMs) <= 2_000) void load(bustUrl(p.url, Math.floor(serverNow() / BUCKET_MS)));
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      inflight?.abort();
      inflight = null;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [p.url, p.refreshMs, p.active, p.cameraId, p.variant, p.servedFrame, p.imageAt, p.lat, p.lon]);

  // Revoke everything on unmount.
  useEffect(() => {
    const st = state.current;
    const urls = st.urls;
    st.unmounted = false;
    return () => {
      st.unmounted = true;
      for (const u of urls) URL.revokeObjectURL(u);
      urls.clear();
    };
  }, []);

  return (
    <>
      {frames.map((f, i) => (
        <FadeImg key={f.id} src={f.src} alt={p.alt} wipe={f.wipe} top={p.fxSource && i === frames.length - 1} />
      ))}
    </>
  );
}
