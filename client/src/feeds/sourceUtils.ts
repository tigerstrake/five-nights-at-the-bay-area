// Pure helpers for real-camera feeds (unit-tested; no DOM).

export { ageLabel, ageShort } from './freshness';

/** Add a cache-busting param that is identical for every client within the same refresh bucket. */
export function bustUrl(url: string, bucket: number): string {
  return url + (url.includes('?') ? '&' : '?') + 'r=' + bucket;
}

/**
 * Detects Caltrans' "Temporarily Unavailable" card (white, dark-blue text) or a black "no video" frame from
 * RGBA pixels (a small downscale is enough). Mirrors the server's pixel heuristics so a bad refresh never
 * replaces a good frame, even before the server's next probe.
 */
export function looksUnavailable(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): 'card' | 'black' | null {
  const rows = Math.max(1, Math.floor(height * 0.9)); // ignore the burned-in timestamp bar
  let white = 0;
  let black = 0;
  let sum = 0;
  let sum2 = 0;
  const n = rows * width;
  for (let i = 0; i < n; i++) {
    const v = 0.299 * rgba[i * 4]! + 0.587 * rgba[i * 4 + 1]! + 0.114 * rgba[i * 4 + 2]!;
    sum += v;
    sum2 += v * v;
    if (v > 235) white++;
    if (v < 16) black++;
  }
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  if (white / n >= 0.85) return 'card';
  if (black / n >= 0.9 || (mean < 14 && std < 12)) return 'black';
  return null;
}
