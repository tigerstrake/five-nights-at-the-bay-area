// Pure classification of Caltrans snapshot / HLS responses. No IO, no clock (callers pass `now`), so it is
// unit-tested on synthetic buffers. Thresholds were calibrated on real frames (docs/CAMERAS.md §3.3, §7):
//   real frames   : mean 44-161, std 15-86, hf/std 0.04-0.47, white fraction <= 0.30
//   "Unavailable" : 13.4-13.5 KB, mean 239, std 57, white fraction 0.93
//   black / blank : mean 11 std 1 (black) · 2.7 KB, 99% white (overexposed/blank)
import { decode as decodeJpeg } from 'jpeg-js';

export interface PixelMetrics {
  width: number;
  height: number;
  /** Mean luminance 0..255 over the image excluding the burned-in timestamp bar. */
  mean: number;
  /** Luminance standard deviation. */
  std: number;
  /** Mean absolute neighbour difference (horizontal + vertical): high-frequency energy. */
  hf: number;
  /** hf / std: natural images stay under ~0.5, TV snow is ~0.8-1.2. */
  hfRatio: number;
  /** Fraction of pixels with luminance > 235. */
  whiteFrac: number;
  /** Fraction of pixels with luminance < 16. */
  blackFrac: number;
}

export type SnapshotFailKind =
  | 'network'
  | 'timeout'
  | 'http'
  | 'content-type'
  | 'not-jpeg'
  | 'too-small'
  | 'too-large'
  | 'decode'
  | 'placeholder'
  | 'blank'
  | 'black'
  | 'uniform'
  | 'snow'
  | 'stale';

export type SnapshotVerdict =
  | { ok: true; imageAt: number | null; bytes: number; metrics: PixelMetrics | null }
  | {
      ok: false;
      kind: SnapshotFailKind;
      /** Hard evidence (the content itself is bad) downgrades immediately; soft evidence (transport) needs N strikes. */
      hard: boolean;
      reason: string;
      /** The host did not answer at all (counts towards the per-host circuit breaker). */
      transport: boolean;
    };

export interface ClassifyInput {
  /** `null` = no HTTP response (transport failure). */
  status: number | null;
  contentType: string | null;
  body: Uint8Array | null;
  lastModified: string | null;
  /** The response `Date` header, used as the reference clock for staleness when present. */
  serverDate: string | null;
  now: number;
  /** Treat Last-Modified older than this as a frozen camera. */
  staleMs: number;
  /** Network error name/message when `status === null`. */
  error?: string | null;
}

export const PLACEHOLDER_MIN_BYTES = 13_000;
export const PLACEHOLDER_MAX_BYTES = 14_100;
export const MIN_IMAGE_BYTES = 1_000;
export const MAX_IMAGE_BYTES = 1_500_000;

/** Decode (cheaply) and measure. Returns null if the bytes are not a decodable, reasonably small JPEG. */
export function analyzeJpeg(bytes: Uint8Array): PixelMetrics | null {
  let img: { width: number; height: number; data: Uint8Array };
  try {
    img = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 4, maxMemoryUsageInMB: 128 }) as never;
  } catch {
    return null;
  }
  const { width: w, height: h, data } = img;
  if (!w || !h) return null;
  // The bottom ~10% of every Caltrans frame is a burned-in timestamp bar (white text on dark): ignore it.
  const rows = Math.max(2, Math.floor(h * 0.9));
  const lum = new Float32Array(w * rows);
  let sum = 0;
  let sum2 = 0;
  let white = 0;
  let black = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
      lum[y * w + x] = v;
      sum += v;
      sum2 += v * v;
      if (v > 235) white++;
      if (v < 16) black++;
    }
  }
  const n = lum.length;
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  let diff = 0;
  let count = 0;
  for (let y = 1; y < rows; y++) {
    for (let x = 1; x < w; x++) {
      const v = lum[y * w + x]!;
      diff += Math.abs(v - lum[y * w + x - 1]!) + Math.abs(v - lum[(y - 1) * w + x]!);
      count += 2;
    }
  }
  const hf = count ? diff / count : 0;
  return { width: w, height: h, mean, std, hf, hfRatio: hf / Math.max(std, 1), whiteFrac: white / n, blackFrac: black / n };
}

/** Classify decoded pixels. Returns the failure kind, or null when the frame looks like a real picture. */
export function classifyPixels(m: PixelMetrics, bytes: number): { kind: SnapshotFailKind; reason: string } | null {
  const inCardBand = bytes >= PLACEHOLDER_MIN_BYTES && bytes <= PLACEHOLDER_MAX_BYTES;
  if ((inCardBand && m.whiteFrac >= 0.5) || (m.whiteFrac >= 0.85 && m.std >= 25)) {
    return { kind: 'placeholder', reason: "Caltrans 'Temporarily Unavailable' card" };
  }
  if (m.whiteFrac >= 0.9 || (m.mean >= 240 && m.std < 20)) return { kind: 'blank', reason: 'blank / washed-out frame' };
  if (m.blackFrac >= 0.9 || (m.mean < 14 && m.std < 12)) return { kind: 'black', reason: 'black frame (no video)' };
  if (m.std < 8) return { kind: 'uniform', reason: 'near-uniform frame (no picture)' };
  if (m.hfRatio > 0.65 && m.hf > 20) return { kind: 'snow', reason: 'static / noise frame' };
  return null;
}

function fail(kind: SnapshotFailKind, reason: string, hard: boolean, transport = false): SnapshotVerdict {
  return { ok: false, kind, reason, hard, transport };
}

export function classifySnapshot(i: ClassifyInput): SnapshotVerdict {
  if (i.status === null) {
    const timeout = /timeout|abort/i.test(i.error ?? '');
    return fail(timeout ? 'timeout' : 'network', timeout ? 'snapshot request timed out' : `snapshot unreachable (${i.error ?? 'network error'})`, false, true);
  }
  if (i.status < 200 || i.status >= 300) return fail('http', `snapshot HTTP ${i.status}`, false);
  if (!/^image\//i.test(i.contentType ?? '')) return fail('content-type', `unexpected content-type ${i.contentType ?? 'none'}`, true);
  const body = i.body;
  if (!body || body.length < MIN_IMAGE_BYTES) return fail('too-small', `snapshot body too small (${body?.length ?? 0} B)`, true);
  if (body.length > MAX_IMAGE_BYTES) return fail('too-large', `snapshot body too large (${body.length} B)`, true);
  if (body[0] !== 0xff || body[1] !== 0xd8) return fail('not-jpeg', 'snapshot is not a JPEG', true);

  const metrics = analyzeJpeg(body);
  if (!metrics) {
    // A card-sized body we cannot decode is still most likely the placeholder.
    if (body.length >= PLACEHOLDER_MIN_BYTES && body.length <= PLACEHOLDER_MAX_BYTES) {
      return fail('placeholder', "Caltrans 'Temporarily Unavailable' card (size match, undecodable)", true);
    }
    return fail('decode', 'snapshot JPEG could not be decoded', true);
  }
  const bad = classifyPixels(metrics, body.length);
  if (bad) return fail(bad.kind, bad.reason, true);

  let imageAt: number | null = null;
  if (i.lastModified) {
    const t = Date.parse(i.lastModified);
    if (Number.isFinite(t)) {
      imageAt = t;
      const ref = i.serverDate ? Date.parse(i.serverDate) : NaN;
      const refNow = Number.isFinite(ref) ? ref : i.now;
      if (refNow - t > i.staleMs) {
        const mins = Math.round((refNow - t) / 60_000);
        return fail('stale', `snapshot frozen (last updated ${mins} min ago)`, true);
      }
    }
  }
  return { ok: true, imageAt, bytes: body.length, metrics };
}

// ───────────────────────────────────────── HLS ─────────────────────────────────────────

export interface ParsedPlaylist {
  kind: 'master' | 'media' | 'invalid';
  /** master: first variant URI; media: segment URIs (in order). */
  uris: string[];
  ended: boolean;
}

export function parsePlaylist(text: string): ParsedPlaylist {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (lines[0] !== '#EXTM3U') return { kind: 'invalid', uris: [], ended: false };
  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
    const uris: string[] = [];
    for (let k = 0; k < lines.length; k++) {
      if (lines[k]!.startsWith('#EXT-X-STREAM-INF')) {
        const next = lines.slice(k + 1).find((l) => l && !l.startsWith('#'));
        if (next) uris.push(next);
      }
    }
    return { kind: uris.length ? 'master' : 'invalid', uris, ended: false };
  }
  const uris: string[] = [];
  for (let k = 0; k < lines.length; k++) {
    if (lines[k]!.startsWith('#EXTINF')) {
      const next = lines.slice(k + 1).find((l) => l && !l.startsWith('#'));
      if (next) uris.push(next);
    }
  }
  return { kind: uris.length ? 'media' : 'invalid', uris, ended: lines.includes('#EXT-X-ENDLIST') };
}

/** MPEG-TS packets start with the sync byte 0x47. */
export function looksLikeTsSegment(bytes: Uint8Array): boolean {
  return bytes.length >= 188 && bytes[0] === 0x47;
}
