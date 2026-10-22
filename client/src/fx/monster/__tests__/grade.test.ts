import { describe, expect, it } from 'vitest';
import { applyFilter, estimateShift, parseCssFilter, regionLight, sunElevationDeg, type RGB, type SceneProbe } from '../grade';
import { CAMERAS } from '@fnab/shared';

describe('sunElevationDeg (Bay Area)', () => {
  it('is high at local noon in October and below the horizon at 21:00 PDT', () => {
    // 2026-10-21 12:58 PDT ≈ solar noon in SF
    expect(sunElevationDeg(Date.parse('2026-10-21T19:58:00Z'))).toBeGreaterThan(38);
    expect(sunElevationDeg(Date.parse('2026-10-22T04:00:00Z'))).toBeLessThan(-15);
    // sunset ~18:25 PDT
    expect(Math.abs(sunElevationDeg(Date.parse('2026-10-22T01:25:00Z')))).toBeLessThan(3);
  });
});

describe('CSS filter mirroring', () => {
  it('parses the feed filters and applies them in order', () => {
    const ops = parseCssFilter('grayscale(0.35) contrast(1.08) brightness(0.9)');
    expect(ops.map((o) => o.fn)).toEqual(['grayscale', 'contrast', 'brightness']);
    const c = applyFilter(ops, [1, 0, 0] as RGB);
    // desaturated, still reddish
    expect(c[0]).toBeGreaterThan(c[1]);
    expect(c[1]).toBeGreaterThan(0.02);
    expect(parseCssFilter('none')).toEqual([]);
    expect(parseCssFilter('grayscale(30%)')[0].v).toBeCloseTo(0.3);
  });
});

describe('estimateShift', () => {
  it('recovers a whole-pixel translation of a textured frame', () => {
    const w = 40;
    const h = 30;
    const a = new Float32Array(w * h);
    const b = new Float32Array(w * h);
    const f = (x: number, y: number) => Math.sin(x * 0.7) * Math.cos(y * 0.45) + Math.sin(x * 0.13 + y * 0.31);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        a[y * w + x] = f(x, y);
        b[y * w + x] = f(x - 1, y + 1); // content moved +1 in x, -1 in y
      }
    const [dx, dy] = estimateShift(a, b, w, h);
    expect(dx).toBeCloseTo(1, 0);
    expect(dy).toBeCloseTo(-1, 0);
  });
});

describe('regionLight', () => {
  it('averages the probe inside a normalized rect', () => {
    const w = 10;
    const h = 10;
    const rgb = new Float32Array(w * h * 3);
    const lum = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const v = i % w < 5 ? 0.1 : 0.7;
      rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = v;
      lum[i] = v;
    }
    const probe = { w, h, rgb, lum } as unknown as SceneProbe;
    expect(regionLight(probe, 0, 0, 0.5, 0.5).ambientLum).toBeCloseTo(0.1, 2);
    expect(regionLight(probe, 0.5, 0, 1, 0.5).ambientLum).toBeCloseTo(0.7, 2);
  });
});

describe('curated placement boxes', () => {
  it('stay above the timestamp bar with plausible creature scales', () => {
    for (const c of CAMERAS) {
      for (const p of c.placement) {
        expect(p.y + p.h).toBeLessThanOrEqual(0.905);
        expect(p.scale).toBeGreaterThanOrEqual(0.05);
        // ~2.8 m creature: never a giant filling most of a CCTV frame
        expect(p.scale).toBeLessThanOrEqual(0.3);
        if (p.occlude !== undefined) expect(p.occlude).toBeLessThanOrEqual(0.6);
      }
    }
  });
});

describe('stillToVideo', () => {
  it('maps a still box (picture squeezed above the timestamp bar) onto the full video frame', async () => {
    const { stillToVideo, STILL_PICTURE_H } = await import('../manifest');
    const r = stillToVideo({ x: 0.2, y: 0.6, w: 0.1, h: 0.2, scale: 0.1 });
    expect(r.x).toBe(0.2);
    expect(r.y).toBeCloseTo(0.6 / STILL_PICTURE_H);
    expect(r.y + r.h).toBeLessThanOrEqual(0.986);
    expect(r.scale).toBeGreaterThan(0.1);
  });
});
