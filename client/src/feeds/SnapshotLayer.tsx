// Real Caltrans snapshot with smooth refresh: the next frame is fetched and decoded OFF-DOM, checked for the
// "Temporarily Unavailable" card, then cross-faded over the current one (no flicker, no blank flash).
import { useEffect, useRef, useState } from 'react';
import { bustUrl, looksUnavailable } from './sourceUtils';
import { serverNow } from '../state/store';

const FADE_MS = 800;
const RETRY_MS = 5_000;
const IMG_CLASS = 'absolute inset-0 h-full w-full object-cover [filter:grayscale(0.35)_contrast(1.08)_brightness(0.9)]';

interface Frame {
  id: number;
  src: string;
}

export interface SnapshotLayerProps {
  /** Snapshot URL from the camera service (already carries `?v=<image timestamp>`). */
  url: string;
  /** Poll interval for new frames, aligned to buckets so all clients request the same URL. */
  refreshMs: number;
  /** False while a live video is covering the snapshot (no polling, bandwidth saved). */
  active: boolean;
  alt: string;
  /** A frame was shown. `imageAt` = true image time when Caltrans' Last-Modified was readable. */
  onFrame: (imageAt: number | null) => void;
  /** Local failure: the source cannot supply a usable picture -> parent falls back to the simulation. */
  onFail: (why: 'card' | 'black' | 'error') => void;
}

function FadeImg({ src, alt }: { src: string; alt: string }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <img
      crossOrigin="anonymous"
      src={src}
      alt={alt}
      draggable={false}
      className={IMG_CLASS}
      style={{ opacity: shown ? 1 : 0, transition: `opacity ${FADE_MS}ms ease-in-out` }}
    />
  );
}

export function SnapshotLayer(p: SnapshotLayerProps) {
  const [frames, setFrames] = useState<Frame[]>([]);
  const cb = useRef(p);
  cb.current = p;
  const state = useRef({ seq: 0, lastKey: '', fails: 0, shown: 0, urls: new Set<string>(), unmounted: false });

  useEffect(() => {
    let cancelled = false;
    const ctl = new AbortController();
    const st = state.current;

    let inflight = '';
    const load = async (target: string) => {
      // `lastKey` only records frames that were actually shown, so an aborted run (React StrictMode remount,
      // dependency change) is retried by the next run instead of being skipped.
      if (target === st.lastKey || target === inflight) return;
      inflight = target;
      try {
        const res = await fetch(target, { mode: 'cors', cache: 'no-store', credentials: 'omit', signal: ctl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        const img = new Image();
        img.src = objectUrl;
        await img.decode();
        // Pixel check on a tiny downscale (blob is same-origin, canvas is never tainted).
        const c = document.createElement('canvas');
        c.width = 40;
        c.height = 32;
        const g = c.getContext('2d', { willReadFrequently: true });
        let bad: 'card' | 'black' | null = null;
        if (g) {
          g.drawImage(img, 0, 0, c.width, c.height);
          bad = looksUnavailable(g.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
        }
        if (cancelled) return URL.revokeObjectURL(objectUrl);
        if (bad) {
          URL.revokeObjectURL(objectUrl);
          return cb.current.onFail(bad);
        }
        st.lastKey = target;
        st.fails = 0;
        st.shown++;
        st.urls.add(objectUrl);
        const lm = res.headers.get('last-modified');
        const at = lm ? Date.parse(lm) : NaN;
        const frame = { id: ++st.seq, src: objectUrl };
        const drop = (f: Frame) => {
          URL.revokeObjectURL(f.src);
          st.urls.delete(f.src);
        };
        setFrames((prev) => {
          prev.slice(0, -1).forEach(drop);
          return [...prev.slice(-1), frame];
        });
        cb.current.onFrame(Number.isFinite(at) ? at : null);
        // Once the new frame is fully faded in, drop the old one (even if this effect run was superseded).
        setTimeout(() => {
          if (st.unmounted) return;
          setFrames((prev) => {
            prev.filter((f) => f.id < frame.id).forEach(drop);
            return prev.filter((f) => f.id >= frame.id);
          });
        }, FADE_MS + 150);
      } catch (e) {
        if (cancelled || (e as Error).name === 'AbortError') return;
        st.fails++;
        if (st.fails >= (st.shown ? 3 : 2)) return cb.current.onFail('error');
        inflight = '';
        setTimeout(() => !cancelled && void load(target), RETRY_MS);
      } finally {
        if (inflight === target) inflight = '';
      }
    };

    // Load the server-announced URL right away (also fires whenever the server publishes a newer frame).
    void load(p.url);
    let timer: ReturnType<typeof setInterval> | null = null;
    if (p.active) {
      timer = setInterval(() => {
        if (document.hidden) return;
        void load(bustUrl(p.url, Math.floor(serverNow() / p.refreshMs)));
      }, p.refreshMs);
    }
    return () => {
      cancelled = true;
      ctl.abort();
      if (timer) clearInterval(timer);
    };
  }, [p.url, p.refreshMs, p.active]);

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
      {frames.map((f) => (
        <FadeImg key={f.id} src={f.src} alt={p.alt} />
      ))}
    </>
  );
}
