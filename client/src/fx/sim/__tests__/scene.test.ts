import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSimLayout } from '../layout';
import { SimScene } from '../scene';

const drawing = vi.hoisted(() => {
  const fills: string[] = [];
  const stops: string[] = [];
  const radial = vi.fn(() => ({ addColorStop: (_offset: number, color: string) => stops.push(color) }));
  const ctx = new Proxy({} as CanvasRenderingContext2D, {
    get: (target, key) => {
      if (key === 'createRadialGradient') return radial;
      if (key === 'createLinearGradient') return () => ({ addColorStop: (_offset: number, color: string) => stops.push(color) });
      if (key === 'fillRect') return () => fills.push(String(target.fillStyle));
      return Reflect.get(target, key) ?? (() => {});
    },
  });
  return { ctx, fills, stops, radial };
});
vi.mock('../../core/noise', () => ({
  ctx2d: () => drawing.ctx,
  makeCanvas: (width: number, height: number) => ({ width, height }),
  getGrainTiles: () => [{}], tileFill: () => {},
}));

beforeEach(() => { drawing.fills.length = 0; drawing.stops.length = 0; drawing.radial.mockClear(); });

describe('procedural daylight renderer', () => {
  const layout = () => ({ ...getSimLayout('day-scene', 123, ['freeway']), gantry: null, portal: null, towers: null, overpass: null });
  it('draws a daylight sky and asphalt with vehicle bodies, without light glow sprites', () => {
    const scene = new SimScene(layout());
    scene.setTimeOfDay('day');
    scene.resize(320, 240);
    scene.render(drawing.ctx, 1_000);
    expect(drawing.stops).toContain('#6dadd2');
    expect(drawing.radial).not.toHaveBeenCalled();
    expect(drawing.fills.some(c => ['#b9c3c7', '#314757', '#864c43', '#d2c8b5'].includes(c))).toBe(true);
  });
  it('adds a warm horizon and low sun glare at dusk', () => {
    const scene = new SimScene({ ...layout(), lamps: [] });
    scene.setTimeOfDay('dusk');
    scene.resize(320, 240);
    scene.render(drawing.ctx, 1_000);
    expect(drawing.stops).toContain('#e5a16e');
    expect(drawing.stops).toContain('rgba(255,228,163,0.9)');
  });
  it('drops a night image when the current light changes to daytime', () => {
    const scene = new SimScene(layout());
    scene.setImage({ naturalWidth: 320, naturalHeight: 240 } as HTMLImageElement);
    expect(scene.hasImage()).toBe(true);
    scene.setTimeOfDay('day');
    expect(scene.hasImage()).toBe(false);
  });
});
