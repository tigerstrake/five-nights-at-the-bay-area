import type { TimeOfDay } from './sun';

export const MAX_FRAME_AGE_MS = 30 * 60_000;
export interface FrameLight {
  mean: number;
  skyMean: number;
  skySaturation: number;
  brightPointShare: number;
}

/** Display-space luminance (0..255), upper 35% sky proxy; exclude timestamp bar. */
export function measureFrameLight(data: ArrayLike<number>, width: number, height: number): FrameLight {
  const rows = Math.max(1, Math.floor(height * 0.9));
  const skyRows = Math.max(1, Math.floor(height * 0.35));
  let sum = 0, sky = 0, saturation = 0, points = 0;
  const lum = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    return 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
  };
  for (let y = 0; y < rows; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const v = lum(x, y);
    sum += v;
    if (y < skyRows) {
      sky += v;
      const max = Math.max(data[i]!, data[i + 1]!, data[i + 2]!);
      const min = Math.min(data[i]!, data[i + 1]!, data[i + 2]!);
      saturation += max ? (max - min) / max : 0;
    }
    // Small highlights against darker surroundings (headlamps/streetlights), not bright sky.
    if (v > 210 && x > 2 && x < width - 3 && y > 2 && y < rows - 3 &&
        (lum(x - 3, y) + lum(x + 3, y) + lum(x, y - 3) + lum(x, y + 3)) / 4 < 100) points++;
  }
  return { mean: sum / (rows * width), skyMean: sky / (skyRows * width),
    skySaturation: saturation / (skyRows * width), brightPointShare: points / (rows * width) };
}

/** Uncertain frames deliberately remain twilight, including tunnels and gain-boosted night footage. */
export function frameTimeOfDay(m: FrameLight): TimeOfDay {
  if (m.mean > 95 && m.skyMean > 125 && m.skySaturation < 0.65 && m.brightPointShare < 0.001) return 'day';
  if (m.mean < 65 && m.skyMean < 45 && m.skySaturation < 0.8 && m.brightPointShare >= 0.0002) return 'night';
  return 'dusk';
}

export function frameConsistency(m: FrameLight, timeOfDay: TimeOfDay, imageAt: number | null, now: number, maxAgeMs = MAX_FRAME_AGE_MS) {
  const frameAgeMs = imageAt === null ? null : Math.max(0, now - imageAt);
  const frameTime = frameTimeOfDay(m);
  const frozen = frameAgeMs !== null && frameAgeMs > maxAgeMs;
  const opposite = (timeOfDay === 'night' && frameTime === 'day') || (timeOfDay === 'day' && frameTime === 'night');
  return { frameTime, frameAgeMs, timeMismatch: frozen || opposite,
    reason: frozen ? 'real feed is frozen (over 30m old)' : opposite ? `real feed shows ${frameTime === 'day' ? 'daylight' : 'night'}` : null };
}
