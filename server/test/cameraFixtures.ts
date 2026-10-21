// Synthetic JPEGs + a scripted fake Caltrans for camera tests. No real network anywhere.
import { encode } from 'jpeg-js';

const W = 320;
const H = 260;

function make(f: (x: number, y: number) => [number, number, number], quality = 90): Uint8Array {
  const data = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b] = f(x, y);
      const i = (y * W + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return new Uint8Array(encode({ data, width: W, height: H }, quality).data);
}

function rng(seed = 1) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Plausible road scene: gradient + blocks + mild texture. */
export function sceneJpeg(seed = 1): Uint8Array {
  const r = rng(seed);
  return make((x, y) => {
    const v = 60 + y * 0.3 + 40 * Math.sin(x / 17) + (x > 100 && x < 180 && y > 120 && y < 200 ? 60 : 0) + r() * 6;
    return [v, v * 0.95, v * 0.9];
  });
}
export const blackJpeg = (): Uint8Array => make((x, y) => [8 + ((x * y) % 3), 8, 8], 100);
export const grayJpeg = (): Uint8Array => make((x, y) => [128 + ((x + y) % 2), 128, 128], 100);
export const whiteJpeg = (): Uint8Array => make((x, y) => [250 - ((x + y) % 3), 250, 250], 100);
export function snowJpeg(seed = 7): Uint8Array {
  const r = rng(seed);
  return make(() => {
    const v = r() * 255;
    return [v, v, v];
  });
}
/** White card with dark-blue text blocks, like Caltrans' "Temporarily Unavailable" image. */
export const cardJpeg = (): Uint8Array =>
  make((x, y) => ((y > 40 && y < 60 && x > 40 && x < 280) || (y > 100 && y < 115 && x > 60 && x < 260) || y > 235 ? [20, 30, 90] : [255, 255, 255]));

export function padTo(bytes: Uint8Array, size: number): Uint8Array {
  // JPEG decoders ignore trailing bytes after EOI, so padding keeps the image valid.
  const out = new Uint8Array(Math.max(size, bytes.length));
  out.set(bytes);
  return out;
}

// ─────────────────────────── scripted fake Caltrans ───────────────────────────

type Body = ConstructorParameters<typeof Response>[0];
export type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

export function jpegResponse(body: Uint8Array, lastModified: string, status = 200, contentType = 'image/jpeg'): Response {
  return new Response(body as unknown as Body, { status, headers: { 'content-type': contentType, 'last-modified': lastModified, date: lastModified } });
}

export const MASTER = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=107910,RESOLUTION=320x240\nchunklist_1.m3u8\n';
export const MEDIA = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:11\n#EXTINF:10.2,\nseg_1.ts\n#EXTINF:10.2,\nseg_2.ts\n';

export function tsSegment(): Uint8Array {
  const b = new Uint8Array(188);
  b[0] = 0x47;
  return b;
}

export function hlsHandler(url: string): Response | null {
  if (url.endsWith('playlist.m3u8')) return new Response(MASTER, { status: 200 });
  if (url.endsWith('chunklist_1.m3u8')) return new Response(MEDIA, { status: 200 });
  if (url.endsWith('.ts')) return new Response(tsSegment() as unknown as Body, { status: 206 });
  return null;
}

/** Fetch mock whose behaviour per URL can be swapped between ticks; records every request. */
export function fakeFetch(fn: Handler) {
  const calls: Array<{ url: string; range: string | null }> = [];
  let handler = fn;
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const h = init?.headers as Record<string, string> | undefined;
    calls.push({ url, range: h?.range ?? null });
    return handler(url, init);
  }) as typeof fetch;
  return { fetch: f, calls, set: (next: Handler) => (handler = next) };
}
