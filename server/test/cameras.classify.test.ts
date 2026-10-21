import { describe, expect, it } from 'vitest';
import {
  analyzeJpeg,
  classifyPixels,
  classifySnapshot,
  looksLikeTsSegment,
  parsePlaylist,
  PLACEHOLDER_MIN_BYTES,
  type ClassifyInput,
  type PixelMetrics,
} from '../src/cameras/classify';
import { blackJpeg, cardJpeg, grayJpeg, padTo, sceneJpeg, snowJpeg, whiteJpeg, MASTER, MEDIA, tsSegment } from './cameraFixtures';

const NOW = Date.parse('2026-10-20T20:00:00Z');
const fresh = new Date(NOW - 2 * 60_000).toUTCString();

function input(over: Partial<ClassifyInput> & { body?: Uint8Array | null }): ClassifyInput {
  return { status: 200, contentType: 'image/jpeg', body: sceneJpeg(), lastModified: fresh, serverDate: new Date(NOW).toUTCString(), now: NOW, staleMs: 15 * 60_000, ...over };
}
const kindOf = (v: ReturnType<typeof classifySnapshot>) => (v.ok ? 'ok' : v.kind);

describe('pixel metrics', () => {
  it('measures a plausible scene as a real picture', () => {
    const m = analyzeJpeg(sceneJpeg())!;
    expect(m.mean).toBeGreaterThan(60);
    expect(m.std).toBeGreaterThan(20);
    expect(m.hfRatio).toBeLessThan(0.5);
    expect(classifyPixels(m, 30_000)).toBeNull();
  });
  it('returns null for garbage bytes', () => {
    expect(analyzeJpeg(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
  it('flags the white "Temporarily Unavailable"-style card by pixels alone', () => {
    const m = analyzeJpeg(cardJpeg())!;
    expect(m.whiteFrac).toBeGreaterThan(0.8);
    expect(classifyPixels(m, 20_000)?.kind).toBe('placeholder');
  });
  it('uses the 13.3-13.7 KB size band as corroboration, but not alone', () => {
    const half: PixelMetrics = { width: 320, height: 260, mean: 190, std: 60, hf: 6, hfRatio: 0.1, whiteFrac: 0.6, blackFrac: 0.05 };
    expect(classifyPixels(half, 13_450)?.kind).toBe('placeholder');
    expect(classifyPixels(half, 40_000)).toBeNull(); // bright real frame of another size is fine
    const real: PixelMetrics = { ...half, whiteFrac: 0.1, mean: 130 };
    expect(classifyPixels(real, 13_450)).toBeNull(); // a real hazy frame that happens to be 13.4 KB
  });
  it('flags black, blank, near-uniform and snow frames', () => {
    expect(classifyPixels(analyzeJpeg(blackJpeg())!, 3000)?.kind).toBe('black');
    expect(classifyPixels(analyzeJpeg(whiteJpeg())!, 3000)?.kind).toBe('blank');
    expect(classifyPixels(analyzeJpeg(grayJpeg())!, 3000)?.kind).toBe('uniform');
    expect(classifyPixels(analyzeJpeg(snowJpeg())!, 60_000)?.kind).toBe('snow');
  });
  it('keeps real dark night frames (very dark but with structure)', () => {
    const night: PixelMetrics = { width: 320, height: 260, mean: 44, std: 15, hf: 1.8, hfRatio: 0.12, whiteFrac: 0, blackFrac: 0.01 };
    expect(classifyPixels(night, 34_000)).toBeNull();
  });
});

describe('classifySnapshot', () => {
  it('accepts a fresh good JPEG and reports Last-Modified as image time', () => {
    const v = classifySnapshot(input({}));
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.imageAt).toBe(Date.parse(fresh));
  });
  it('rejects the placeholder card (hard evidence)', () => {
    const v = classifySnapshot(input({ body: padTo(cardJpeg(), 13_450) }));
    expect(v).toMatchObject({ ok: false, kind: 'placeholder', hard: true });
  });
  it('treats an undecodable body in the card size band as the placeholder', () => {
    const junk = new Uint8Array(PLACEHOLDER_MIN_BYTES + 200);
    junk[0] = 0xff;
    junk[1] = 0xd8;
    expect(kindOf(classifySnapshot(input({ body: junk })))).toBe('placeholder');
  });
  it('rejects black, snow and uniform frames', () => {
    expect(kindOf(classifySnapshot(input({ body: padTo(blackJpeg(), 3000) })))).toBe('black');
    expect(kindOf(classifySnapshot(input({ body: snowJpeg() })))).toBe('snow');
    expect(kindOf(classifySnapshot(input({ body: padTo(grayJpeg(), 3000) })))).toBe('uniform');
  });
  it('classifies HTTP and transport failures as soft', () => {
    expect(classifySnapshot(input({ status: 500 }))).toMatchObject({ ok: false, kind: 'http', hard: false, transport: false });
    expect(classifySnapshot(input({ status: null, body: null, error: 'timeout' }))).toMatchObject({ kind: 'timeout', hard: false, transport: true });
    expect(classifySnapshot(input({ status: null, body: null, error: 'ECONNREFUSED' }))).toMatchObject({ kind: 'network', transport: true });
  });
  it('rejects wrong content-type, non-JPEG and tiny bodies', () => {
    expect(kindOf(classifySnapshot(input({ contentType: 'text/html' })))).toBe('content-type');
    expect(kindOf(classifySnapshot(input({ body: new Uint8Array(5000).fill(1) })))).toBe('not-jpeg');
    expect(kindOf(classifySnapshot(input({ body: new Uint8Array(10) })))).toBe('too-small');
  });
  it('rejects frozen cameras using the server Date as reference', () => {
    const old = new Date(NOW - 40 * 60_000).toUTCString();
    expect(kindOf(classifySnapshot(input({ lastModified: old })))).toBe('stale');
    // A skewed local clock must not matter when the server's Date says the frame is fresh.
    expect(kindOf(classifySnapshot(input({ lastModified: old, now: NOW - 3_600_000 })))).toBe('stale');
    expect(kindOf(classifySnapshot(input({ now: NOW + 3_600_000 })))).toBe('ok');
  });
});

describe('hls helpers', () => {
  it('parses master and media playlists', () => {
    expect(parsePlaylist(MASTER)).toMatchObject({ kind: 'master', uris: ['chunklist_1.m3u8'] });
    expect(parsePlaylist(MEDIA)).toMatchObject({ kind: 'media', uris: ['seg_1.ts', 'seg_2.ts'], ended: false });
    expect(parsePlaylist(MEDIA + '#EXT-X-ENDLIST\n').ended).toBe(true);
    expect(parsePlaylist('<html>nope</html>').kind).toBe('invalid');
    expect(parsePlaylist('#EXTM3U\n#EXT-X-VERSION:3\n').kind).toBe('invalid');
  });
  it('recognises MPEG-TS sync bytes', () => {
    expect(looksLikeTsSegment(tsSegment())).toBe(true);
    expect(looksLikeTsSegment(new Uint8Array(188))).toBe(false);
  });
});
