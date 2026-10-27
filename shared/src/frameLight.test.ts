import { describe, expect, it } from 'vitest';
import { frameConsistency, frameTimeOfDay, measureFrameLight, MAX_FRAME_AGE_MS } from './frameLight';

import { lightPixels } from '../test/frameFixtures';

describe('time-of-day pixel classifier', () => {
  const measure = (mode: Parameters<typeof lightPixels>[0]) => {
    const p = lightPixels(mode); return measureFrameLight(p.data, p.width, p.height);
  };
  it('recognises clear daylight and dark sky with sparse point lights', () => {
    expect(frameTimeOfDay(measure('day'))).toBe('day');
    expect(frameTimeOfDay(measure('night'))).toBe('night');
    expect(measure('night').brightPointShare).toBeGreaterThan(0.0002);
  });
  it('does not call a floodlit road daylight, or flag ambiguous/saturated frames', () => {
    for (const mode of ['dusk', 'floodlit', 'saturated'] as const) {
      expect(frameTimeOfDay(measure(mode))).toBe('dusk');
      for (const tod of ['day', 'dusk', 'night'] as const) expect(frameConsistency(measure(mode), tod, 1000, 2000).timeMismatch).toBe(false);
    }
  });
  it('only flags opposite clear lighting outside twilight', () => {
    expect(frameConsistency(measure('day'), 'night', null, 2000).timeMismatch).toBe(true);
    expect(frameConsistency(measure('night'), 'day', null, 2000).timeMismatch).toBe(true);
    expect(frameConsistency(measure('day'), 'dusk', null, 2000).timeMismatch).toBe(false);
    expect(frameConsistency(measure('night'), 'dusk', null, 2000).timeMismatch).toBe(false);
  });
  it('uses capture age even for ambiguous frames, with a strict 30 minute boundary', () => {
    expect(frameConsistency(measure('dusk'), 'night', 0, MAX_FRAME_AGE_MS).timeMismatch).toBe(false);
    expect(frameConsistency(measure('dusk'), 'night', 0, MAX_FRAME_AGE_MS + 1).timeMismatch).toBe(true);
    expect(frameConsistency(measure('dusk'), 'night', null, MAX_FRAME_AGE_MS + 1).frameAgeMs).toBeNull();
  });
});
