// Pure helpers deciding where real live video is shown (unit-tested).
import type { CameraSourceStatus } from '@fnab/shared';

/** Live thumbnails allowed on the visible bank page (plus the main monitor). Measured cheap: see docs/CAMERAS.md §7.7. */
export const LIVE_THUMB_BUDGET = 3;

/** The budget in effect: `?liveThumbs=N` (0..6) overrides it for QA / low-bandwidth players. */
export function liveThumbBudget(search: string = typeof location !== 'undefined' ? location.search : ''): number {
  const raw = new URLSearchParams(search).get('liveThumbs');
  const n = raw === null ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 6 ? n : LIVE_THUMB_BUDGET;
}

export function isLiveCapable(s: CameraSourceStatus | undefined): boolean {
  return !!s && s.mode === 'live' && !!s.streamUrl;
}

/**
 * Which thumbnails on the visible page may play live video: the first `budget` live-capable cameras in bank order,
 * excluding the one already on the main monitor (it plays there). Order-stable so tiles do not swap while watched.
 */
export function pickLiveThumbs(
  bankIds: readonly string[],
  statuses: Record<string, CameraSourceStatus | undefined>,
  mainId: string | undefined,
  budget = LIVE_THUMB_BUDGET,
): Set<string> {
  const out = new Set<string>();
  for (const id of bankIds) {
    if (out.size >= budget) break;
    if (id === mainId) continue;
    if (isLiveCapable(statuses[id])) out.add(id);
  }
  return out;
}

/**
 * Stable reorder that moves live-capable cameras ahead of stills *within a tier* (e.g. among cameras at the same
 * distance from HQ). Stills are never dropped, only placed after equally-ranked live cameras.
 */
export function liveFirst<T>(items: readonly T[], idOf: (t: T) => string, rank: (t: T) => number, statuses: Record<string, CameraSourceStatus | undefined>): T[] {
  return items
    .map((t, i) => ({ t, i, r: rank(t), live: isLiveCapable(statuses[idOf(t)]) ? 0 : 1 }))
    .sort((a, b) => a.r - b.r || a.live - b.live || a.i - b.i)
    .map((x) => x.t);
}

/** Default main-monitor camera: the first live-capable candidate, else the first candidate. */
export function preferLive<T>(candidates: readonly T[], idOf: (t: T) => string, statuses: Record<string, CameraSourceStatus | undefined>): T | undefined {
  return candidates.find((c) => isLiveCapable(statuses[idOf(c)])) ?? candidates[0];
}
