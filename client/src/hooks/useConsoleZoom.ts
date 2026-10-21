// On very large CSS viewports (e.g. 2560×1440 at 1×) every screen is laid out for ~1680×1000 and scaled up
// with CSS `zoom`, so type and hit targets stay readable. Applied once at the App root (all screens agree).
import { useEffect, useState } from 'react';

const DESIGN_W = 1680;
const DESIGN_H = 1000;
const MIN_ZOOM = 1.15;
const MAX_ZOOM = 1.6;

export interface ConsoleZoom {
  zoom: number;
  w: number;
  h: number;
}

function calc(): ConsoleZoom {
  if (typeof window === 'undefined') return { zoom: 1, w: 0, h: 0 };
  const z = Math.min(window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H);
  return { zoom: z >= MIN_ZOOM ? Math.min(MAX_ZOOM, Math.round(z * 20) / 20) : 1, w: window.innerWidth, h: window.innerHeight };
}

export function useConsoleZoom(): ConsoleZoom {
  const [z, setZ] = useState(calc);
  useEffect(() => {
    const on = () =>
      setZ((prev) => {
        const next = calc();
        return next.zoom === prev.zoom && next.w === prev.w && next.h === prev.h ? prev : next;
      });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return z;
}

/** Current root zoom factor (1 when unzoomed): divide client/viewport pixel deltas by it inside the app. */
export function rootZoom(el: Element | null): number {
  if (!el) return 1;
  const r = el.getBoundingClientRect();
  const w = (el as HTMLElement).offsetWidth ?? (el as SVGGraphicsElement & { clientWidth: number }).clientWidth;
  return w > 0 && r.width > 0 ? r.width / w : 1;
}
