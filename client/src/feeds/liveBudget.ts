// Pure helpers deciding where real live video is shown (unit-tested).
import type { CameraSourceStatus } from '@fnab/shared';

/** Live thumbnails allowed on the visible bank page (plus the main monitor) on a low-end device. Measured cheap
 *  (~1.3% of a core and ~0.7 Mbit/s per tile): see docs/CAMERAS.md §7.7. */
export const LIVE_THUMB_BUDGET = 3;
/** Larger budgets for machines that can clearly afford them; most of the wall should move where Caltrans allows. */
const DEVICE_BUDGETS = { mid: 5, high: 8 } as const;
const MAX_OVERRIDE = 12;

interface DeviceHints {
  cores?: number;
  saveData?: boolean;
}

function deviceHints(): DeviceHints {
  if (typeof navigator === 'undefined') return {};
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return { cores: navigator.hardwareConcurrency, saveData: conn?.saveData };
}

/** Default budget for this device: 3 when saving data or on ≤2-core devices, 5 on 4–7 cores, 8 on ≥8 cores. */
export function deviceLiveThumbBudget({ cores, saveData }: DeviceHints = deviceHints()): number {
  if (saveData || !cores || cores <= 2) return LIVE_THUMB_BUDGET;
  return cores >= 8 ? DEVICE_BUDGETS.high : DEVICE_BUDGETS.mid;
}

/** The budget in effect: `?liveThumbs=N` (0..12) overrides it for QA / low-bandwidth players. */
export function liveThumbBudget(
  search: string = typeof location !== 'undefined' ? location.search : '',
  hints: DeviceHints = deviceHints(),
): number {
  const raw = new URLSearchParams(search).get('liveThumbs');
  const n = raw === null ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= MAX_OVERRIDE ? n : deviceLiveThumbBudget(hints);
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
