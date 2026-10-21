// UI art manifest (/assets/ui/manifest.json). Every key is optional: screens must look complete without art.
// Known keys: keyart, keyartSmall, defeat, victory, hq (one image for all HQs, or a map HqId → image).
import { useEffect, useState } from 'react';
import type { HqId } from '@fnab/shared';

export interface UiAssets {
  keyart?: string;
  keyartSmall?: string;
  defeat?: string;
  victory?: string;
  hq?: string | Partial<Record<HqId, string>>;
}

const BASE = '/assets/ui/';
const DEFAULTS: UiAssets = { keyart: BASE + 'keyart.jpg', keyartSmall: BASE + 'keyart-small.jpg' };

let cache: UiAssets | null = null;
let pending: Promise<UiAssets> | null = null;
const listeners = new Set<(a: UiAssets) => void>();

function resolvePath(p: unknown): string | undefined {
  if (typeof p !== 'string' || !p) return undefined;
  if (/^https?:/i.test(p)) return undefined; // same-origin art only
  return p.startsWith('/') ? p : BASE + p;
}

export function loadUiAssets(): Promise<UiAssets> {
  if (cache) return Promise.resolve(cache);
  if (pending) return pending;
  pending = fetch(BASE + 'manifest.json', { cache: 'no-cache' })
    .then((r): Promise<Record<string, unknown>> | Record<string, unknown> => (r.ok ? (r.json() as Promise<Record<string, unknown>>) : {}))
    .catch((): Record<string, unknown> => ({}))
    .then((m: Record<string, unknown>) => {
      const out: UiAssets = { ...DEFAULTS };
      for (const k of ['keyart', 'keyartSmall', 'defeat', 'victory'] as const) {
        const v = resolvePath(m[k]);
        if (v) out[k] = v;
      }
      const hq = m.hq;
      if (typeof hq === 'string') out.hq = resolvePath(hq);
      else if (hq && typeof hq === 'object') {
        const map: Partial<Record<HqId, string>> = {};
        for (const [id, p] of Object.entries(hq as Record<string, unknown>)) {
          const v = resolvePath(p);
          if (v) map[id as HqId] = v;
        }
        out.hq = map;
      }
      cache = out;
      listeners.forEach((l) => l(out));
      return out;
    });
  return pending;
}

export function useUiAssets(): UiAssets {
  const [a, setA] = useState<UiAssets>(() => cache ?? DEFAULTS);
  useEffect(() => {
    listeners.add(setA);
    void loadUiAssets().then(setA);
    return () => void listeners.delete(setA);
  }, []);
  return a;
}

export function hqArt(a: UiAssets, id: HqId): string | undefined {
  if (!a.hq) return undefined;
  return typeof a.hq === 'string' ? a.hq : a.hq[id];
}

/** Image that silently disappears if the file is missing or fails to decode. */
export function useImageOk(src: string | undefined): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    setOk(false);
    if (!src) return;
    const img = new Image();
    img.onload = () => setOk(true);
    img.onerror = () => setOk(false);
    img.src = src;
  }, [src]);
  return ok;
}
