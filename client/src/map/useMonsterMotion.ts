// Smooth monster motion between 10 Hz server snapshots without React re-renders: the latest snapshot is
// recorded on render, and a rAF loop extrapolates along the current edge (rate estimated from successive
// samples, capped) and eases the drawn point toward it. Writes go straight to the element's transform.
import { useEffect, useRef, type RefObject } from 'react';
import type { MapLayers } from './layers';
import type { XY } from './derive';

type Monster = NonNullable<MapLayers['monster']>;

export function useMonsterMotion(
  monster: MapLayers['monster'],
  project: (from: string, to: string | null, progress: number) => XY | null,
  ref: RefObject<SVGGElement | null>,
  /** Optional per-frame callback (e.g. GeoMap moves a marker). */
  onFrame?: (p: XY) => void,
) {
  const st = useRef({ key: '', p: 0, t: 0, rate: 0, from: '', to: null as string | null, disp: null as XY | null });
  const projRef = useRef(project);
  projRef.current = project;
  const frameRef = useRef(onFrame);
  frameRef.current = onFrame;

  // Record the newest sample (runs on every render; cheap).
  const m: Monster | null | undefined = monster;
  const s = st.current;
  const now = performance.now();
  if (m?.moving) {
    const key = `${m.moving.from}>${m.moving.to}`;
    const p = m.moving.progress;
    if (key === s.key) {
      if (p !== s.p) {
        const dt = now - s.t;
        if (dt > 20 && p > s.p) {
          const r = (p - s.p) / dt;
          s.rate = s.rate ? s.rate * 0.6 + r * 0.4 : r;
        }
        s.p = p;
        s.t = now;
      }
    } else {
      s.key = key;
      s.p = p;
      s.t = now;
      s.from = m.moving.from;
      s.to = m.moving.to;
    }
  } else if (m?.nodeId) {
    const key = m.nodeId;
    if (key !== s.key) {
      s.key = key;
      s.from = m.nodeId;
      s.to = null;
      s.p = 0;
      s.t = now;
    }
  } else {
    s.key = '';
    s.disp = null;
  }

  useEffect(() => {
    if (!m) return;
    const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let last = performance.now();
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const t = performance.now();
      const dt = Math.min(100, t - last);
      last = t;
      const q = st.current;
      if (!q.key) return;
      let target: XY | null;
      if (q.to) {
        const ahead = Math.min(400, t - q.t); // never extrapolate more than 0.4 s past a snapshot
        target = projRef.current(q.from, q.to, Math.min(1, q.p + q.rate * ahead));
      } else target = projRef.current(q.from, null, 0);
      if (!target) return;
      if (!q.disp || reduce) q.disp = { ...target };
      else {
        const dx = target.x - q.disp.x, dy = target.y - q.disp.y;
        // big jumps (reconnect, teleport) snap
        if (Math.hypot(dx, dy) > 400) q.disp = { ...target };
        else {
          const a = 1 - Math.exp(-dt / 110);
          q.disp.x += dx * a;
          q.disp.y += dy * a;
        }
      }
      ref.current?.setAttribute('transform', `translate(${q.disp.x.toFixed(2)} ${q.disp.y.toFixed(2)})`);
      frameRef.current?.(q.disp);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!m]);
}
