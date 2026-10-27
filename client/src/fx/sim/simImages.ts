// Optional bundled sample imagery from /assets/sim/manifest.json
// ({ "images": [{ "file": "freeway-night-01.jpg", "tags": ["freeway"], "placement"?: [...] }] }).
// Missing → procedural scene. Always labelled SIMULATED by SimulatedFeed.
import type { PlacementRegion } from '../index';
import { fxAssetsEnabled } from '../core/settings';

export interface SimImage {
  img: HTMLImageElement;
  file: string;
  tags: string[];
  placement: PlacementRegion[] | null;
}

/** feet (x, y) + figure height (fraction of frame) → feet box (where the feet may land) */
const R = (x: number, y: number, scale: number, w = Math.max(0.03, scale * 0.35)): PlacementRegion => ({ x: x - w / 2, y: y - 0.025, w, h: 0.035, scale });

/** Hand-placed regions for the bundled sample images (by file name). */
const KNOWN: Record<string, PlacementRegion[]> = {
  'bridge-night-01.jpg': [R(0.62, 0.6, 0.18), R(0.36, 0.44, 0.07), R(0.85, 0.88, 0.32)],
  'bridge-night-02.jpg': [R(0.55, 0.46, 0.1), R(0.42, 0.8, 0.3), R(0.72, 0.52, 0.14)],
  'downtown-01.jpg': [R(0.87, 0.93, 0.3), R(0.62, 0.36, 0.07), R(0.14, 0.64, 0.17), R(0.37, 0.245, 0.07)],
  'foggy-01.jpg': [R(0.26, 0.76, 0.22), R(0.48, 0.62, 0.15), R(0.4, 0.38, 0.06)],
  'freeway-night-01.jpg': [R(0.86, 0.9, 0.28), R(0.38, 0.245, 0.075), R(0.55, 0.46, 0.1)],
  'freeway-night-02.jpg': [R(0.26, 0.78, 0.22), R(0.48, 0.62, 0.15), R(0.9, 0.78, 0.25)],
  'freeway-night-03.jpg': [R(0.82, 0.76, 0.24), R(0.5, 0.84, 0.3), R(0.6, 0.43, 0.12), R(0.35, 0.33, 0.05)],
  'interchange-01.jpg': [R(0.55, 0.63, 0.14), R(0.62, 0.37, 0.1), R(0.92, 0.88, 0.3)],
  'interchange-02.jpg': [R(0.56, 0.84, 0.28), R(0.45, 0.61, 0.16), R(0.3, 0.39, 0.06)],
  'tunnel-01.jpg': [R(0.5, 0.52, 0.1), R(0.6, 0.76, 0.2), R(0.3, 0.82, 0.24)],
};

let images: SimImage[] = [];
let loaded = false;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function parsePlacement(v: unknown): PlacementRegion[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.filter(
    (r): r is PlacementRegion =>
      !!r && typeof r === 'object' && ['x', 'y', 'w', 'h', 'scale'].every((k) => typeof (r as Record<string, unknown>)[k] === 'number'),
  );
  return out.length ? out : null;
}

export function loadSimImages(base = '/assets/sim/'): Promise<void> {
  if (loading) return loading;
  if (typeof window === 'undefined') return Promise.resolve();
  loading = fetch(`${base}manifest.json`, { headers: { Accept: 'application/json' } })
    .then((r) => (r.ok && (r.headers.get('content-type') ?? '').includes('json') ? (r.json() as Promise<{ images?: Array<Record<string, unknown>> }>) : null))
    .then(async (m) => {
      if (!m || !Array.isArray(m.images)) return;
      const res = await Promise.all(
        m.images.map(
          (e) =>
            new Promise<SimImage | null>((resolve) => {
              if (typeof e.file !== 'string') return resolve(null);
              const file = e.file;
              const img = new Image();
              img.onload = () =>
                resolve({
                  img,
                  file,
                  tags: Array.isArray(e.tags) ? e.tags.filter((t): t is string => typeof t === 'string') : [],
                  placement: parsePlacement(e.placement) ?? KNOWN[file.split('/').pop() ?? ''] ?? null,
                });
              img.onerror = () => resolve(null);
              img.src = new URL(file, new URL(base, window.location.href)).href;
            }),
        ),
      );
      images = res.filter((x): x is SimImage => !!x);
    })
    .catch(() => {
      images = [];
    })
    .finally(() => {
      loaded = true;
      listeners.forEach((l) => l());
    });
  return loading;
}

export function simImagesLoaded(): boolean {
  return loaded;
}

export function onSimImagesLoaded(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Deterministic image choice for a scene; prefers images whose first tag matches the scene kind. */
export function simImageFor(tags: string[], kind: string, seed: number, timeOfDay: 'day' | 'dusk' | 'night' = 'night'): SimImage | null {
  if (timeOfDay !== 'night' || !images.length || !fxAssetsEnabled()) return null;
  const want = new Set(tags.map((t) => t.toLowerCase()));
  let pool = images.filter((i) => i.tags[0] === kind);
  if (!pool.length) pool = images.filter((i) => i.tags.some((t) => want.has(t)));
  if (!pool.length) pool = images.filter((i) => i.tags.includes('freeway'));
  if (!pool.length) return null;
  return pool[seed % pool.length];
}
