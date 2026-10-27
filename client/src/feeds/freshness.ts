// Pure freshness model for Caltrans stills (unit-tested; no DOM).
//
// Caltrans replaces each camera's JPEG every 5 minutes, each camera on its own phase (docs/CAMERAS.md §3.4). A still
// is real imagery, but on a CCTV wall it reads as "frozen video" unless it says what it is. These helpers turn the
// image's own timestamp into honest labels ("STILL · updated 2m ago · next ≈ 3m") and decide when to poll next.

export const CALTRANS_CADENCE_MS = 5 * 60_000;
/** Caltrans' file appears ~15-35 s after its Last-Modified time (measured 2026-10-20); poll just after that. */
export const POLL_MARGIN_MS = 35_000;
/** While a frame is overdue, ask again this often for the first OVERDUE_FAST_MS, then every OVERDUE_SLOW_MS. */
export const OVERDUE_FAST_EVERY_MS = 20_000;
export const OVERDUE_FAST_MS = 2 * 60_000;
export const OVERDUE_SLOW_EVERY_MS = 60_000;
/** Frame older than cadence + this = the camera itself is late (Caltrans side), say so. */
export const LATE_AFTER_MS = 3 * 60_000;

export type StillState = 'unknown' | 'fresh' | 'due' | 'late';

export interface StillFreshness {
  state: StillState;
  /** Age of the image content (ms), null when unknown. */
  ageMs: number | null;
  /** Time until the next Caltrans frame is expected (ms, >= 0), null when unknown or overdue. */
  nextInMs: number | null;
  /** 0..1 through the current refresh cycle (for a countdown bar); 1 when due/late. */
  progress: number;
}

export function stillFreshness(imageAt: number | null | undefined, now: number, cadenceMs = CALTRANS_CADENCE_MS): StillFreshness {
  if (imageAt == null || !Number.isFinite(imageAt)) return { state: 'unknown', ageMs: null, nextInMs: null, progress: 0 };
  const ageMs = Math.max(0, now - imageAt);
  if (ageMs < cadenceMs) return { state: 'fresh', ageMs, nextInMs: cadenceMs - ageMs, progress: ageMs / cadenceMs };
  if (ageMs < cadenceMs + LATE_AFTER_MS) return { state: 'due', ageMs, nextInMs: null, progress: 1 };
  return { state: 'late', ageMs, nextInMs: null, progress: 1 };
}

/** "just now" / "4m ago" / "2h ago" for an image's age. */
export function ageLabel(ageMs: number): string {
  const s = Math.max(0, Math.round(ageMs / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

/** Compact variant for thumbnails: "4m". */
export function ageShort(ageMs: number): string {
  const s = Math.max(0, Math.round(ageMs / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/** "≈ 3m" / "< 1m" until the next frame. */
export function nextLabel(ms: number): string {
  if (ms < 60_000) return '< 1m';
  return `≈ ${Math.round(ms / 60_000)}m`;
}

export interface StillLabels {
  /** Badge word(s). */
  badge: string;
  /** Secondary OSD line on the main monitor (null on thumbs). */
  detail: string | null;
  /** Full sentence for the tooltip / screen readers. */
  title: string;
}

/**
 * Labels for a real Caltrans still. `liveNote` explains why a live-capable camera is showing a still right now
 * ("live video reconnecting", "pick for live video").
 */
export function stillLabels(f: StillFreshness, variant: 'main' | 'thumb', liveNote?: string | null, servedFrame?: 'current' | 'history'): StillLabels {
  const age = f.ageMs === null ? null : variant === 'main' ? ageLabel(f.ageMs) : ageShort(f.ageMs);
  if (servedFrame === 'history') {
    const label = f.ageMs === null ? 'capture time unknown' : ageLabel(f.ageMs);
    return { badge: `STILL · ${label} (recent frame)`, detail: variant === 'main' ? 'Recent Caltrans frame · current still mismatches time of day' : null,
      title: `Caltrans CCTV still image (not video), captured ${label}. Recent frame from this camera; current still mismatches time of day.` };
  }
  const next =
    f.state === 'fresh' && f.nextInMs !== null
      ? `next ${nextLabel(f.nextInMs)}`
      : f.state === 'due'
        ? 'next frame due'
        : f.state === 'late'
          ? 'camera slow to update'
          : null;
  const badge = variant === 'thumb' ? (age ? `STILL · ${age}` : 'STILL') : 'STILL';
  const parts = [age ? `updated ${age}` : 'still image', next, liveNote ?? null].filter(Boolean) as string[];
  const detail = variant === 'main' ? parts.join(' · ') : null;
  const ageSentence = f.ageMs === null ? '' : `, captured ${ageLabel(f.ageMs)}`;
  const nextSentence =
    f.state === 'fresh' && f.nextInMs !== null
      ? `; next frame expected in ${nextLabel(f.nextInMs).replace('≈ ', 'about ')}`
      : f.state === 'due'
        ? '; next frame is due now'
        : f.state === 'late'
          ? '; this camera has not published a new frame for a while'
          : '';
  const title = `Caltrans CCTV still image (not video)${ageSentence}${nextSentence}. Caltrans updates this camera every 5 minutes.${liveNote ? ` ${liveNote[0]!.toUpperCase()}${liveNote.slice(1)}.` : ''}`;
  return { badge, detail, title };
}

/**
 * When to fetch the next still (ms from now). Instead of polling blindly every minute, wait until just after the
 * next frame is expected (image time + 5 min + margin), then poll briskly while it is overdue and back off if the
 * camera is late. `imageAt` unknown -> `fallbackMs`.
 */
export function nextPollDelay(imageAt: number | null | undefined, now: number, fallbackMs: number, cadenceMs = CALTRANS_CADENCE_MS): number {
  if (imageAt == null || !Number.isFinite(imageAt)) return fallbackMs;
  const due = imageAt + cadenceMs + POLL_MARGIN_MS;
  if (now < due) return Math.max(2_000, Math.min(cadenceMs + POLL_MARGIN_MS, due - now));
  const overdue = now - due;
  return overdue < OVERDUE_FAST_MS ? OVERDUE_FAST_EVERY_MS : OVERDUE_SLOW_EVERY_MS;
}
