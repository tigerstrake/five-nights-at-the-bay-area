import { describe, expect, it } from 'vitest';
import { sunElevationDeg, timeOfDayAt } from './sun';

describe('shared solar position', () => {
  it('places Bay Area midday above and midnight below the horizon', () => {
    expect(sunElevationDeg(Date.parse('2026-06-21T20:00Z'))).toBeGreaterThan(70);
    expect(sunElevationDeg(Date.parse('2026-06-21T08:00Z'))).toBeLessThan(-20);
    expect(timeOfDayAt(Date.parse('2026-10-21T20:00Z'))).toBe('day');
    expect(timeOfDayAt(Date.parse('2026-10-21T08:00Z'))).toBe('night');
  });
  it('retains a wide dawn/dusk band and is independent of the runtime timezone', () => {
    expect(timeOfDayAt(Date.parse('2026-10-21T01:30Z'))).toBe('dusk');
    expect(timeOfDayAt(Date.parse('2026-10-21T14:20Z'))).toBe('dusk');
    expect(sunElevationDeg(Date.parse('2026-03-20T12:00Z'), 0, 0)).toBeGreaterThan(87);
    expect(sunElevationDeg(Date.parse('2026-03-20T12:00Z'), 0, 180)).toBeLessThan(-87);
  });
  it('handles leap day and year boundaries without discontinuities', () => {
    for (const iso of ['2028-02-29T23:59:59Z', '2026-12-31T23:59:59Z']) {
      const t = Date.parse(iso);
      expect(Math.abs(sunElevationDeg(t + 2000) - sunElevationDeg(t))).toBeLessThan(0.5);
    }
  });
});
