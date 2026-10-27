// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { loadSimImages, simImageFor } from '../simImages';

afterEach(() => vi.unstubAllGlobals());

it('selects bundled night imagery only at night; day and dusk retain procedural scenes', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ images: [
    { file: 'freeway-night-01.jpg', tags: ['freeway', 'night'] },
  ] })));
  vi.stubGlobal('Image', class {
    onload: (() => void) | null = null;
    set src(_url: string) { queueMicrotask(() => this.onload?.()); }
  });
  await loadSimImages();
  expect(simImageFor(['freeway'], 'freeway', 1, 'night')?.file).toBe('freeway-night-01.jpg');
  expect(simImageFor(['freeway'], 'freeway', 1, 'day')).toBeNull();
  expect(simImageFor(['freeway'], 'freeway', 1, 'dusk')).toBeNull();
});
