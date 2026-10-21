import { describe, expect, it } from 'vitest';
import { ageLabel, ageShort, bustUrl, looksUnavailable } from '../sourceUtils';

const MIN = 60_000;

function rgba(w: number, h: number, f: (x: number, y: number) => [number, number, number]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = f(x, y);
      const i = (y * w + x) * 4;
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = 255;
    }
  return d;
}

describe('age labels', () => {
  it('formats snapshot age', () => {
    expect(ageLabel(10_000)).toBe('just now');
    expect(ageLabel(4 * MIN)).toBe('4m ago');
    expect(ageLabel(4 * MIN + 20_000)).toBe('4m ago');
    expect(ageLabel(59 * MIN)).toBe('59m ago');
    expect(ageLabel(3 * 60 * MIN)).toBe('3h ago');
    expect(ageLabel(-5000)).toBe('just now');
    expect(ageShort(4 * MIN)).toBe('4m');
    expect(ageShort(20_000)).toBe('now');
  });
});

describe('bustUrl', () => {
  it('appends with the right separator and is stable within a bucket', () => {
    expect(bustUrl('https://x/a.jpg', 7)).toBe('https://x/a.jpg?r=7');
    expect(bustUrl('https://x/a.jpg?v=123', 7)).toBe('https://x/a.jpg?v=123&r=7');
  });
});

describe('looksUnavailable', () => {
  it('flags the white "Temporarily Unavailable" style card', () => {
    const card = rgba(40, 32, (x, y) => ((y > 8 && y < 12 && x > 5 && x < 35) || y > 29 ? [20, 30, 90] : [255, 255, 255]));
    expect(looksUnavailable(card, 40, 32)).toBe('card');
  });
  it('flags black frames', () => {
    expect(looksUnavailable(rgba(40, 32, () => [6, 6, 6]), 40, 32)).toBe('black');
  });
  it('accepts a normal scene, a dark night scene and a bright overcast scene', () => {
    const scene = rgba(40, 32, (x, y) => [60 + y * 3 + (x % 7) * 6, 70 + y * 2, 80]);
    expect(looksUnavailable(scene, 40, 32)).toBeNull();
    const night = rgba(40, 32, (x, y) => [30 + ((x * y) % 20), 30 + (x % 9), 40]);
    expect(looksUnavailable(night, 40, 32)).toBeNull();
    const overcast = rgba(40, 32, (x, y) => [200 + (x % 5) * 6, 205 + (y % 4) * 5, 210]);
    expect(looksUnavailable(overcast, 40, 32)).toBeNull();
  });
});
