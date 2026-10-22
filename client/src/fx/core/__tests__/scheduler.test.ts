import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let frame: FrameRequestCallback | undefined;
let remove: (() => void) | undefined;
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('window', { location: { search: '?e2e' } });
  vi.stubGlobal('document', { hidden: false, addEventListener: vi.fn() });
  vi.stubGlobal('requestAnimationFrame', vi.fn((cb: FrameRequestCallback) => { frame = cb; return 1; }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => { remove?.(); remove = undefined; frame = undefined; vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('render-lite test build boundary', () => {
  it('ignores ?e2e in production without explicit test-build enablement', async () => {
    vi.stubEnv('PROD', true); vi.stubEnv('DEV', false); vi.stubEnv('VITE_FNAB_TEST_HOOKS', '');
    const { isRenderLite } = await import('../settings');
    expect(isRenderLite()).toBe(false);
    const { addFxTask } = await import('../scheduler');
    const render = vi.fn();
    remove = addFxTask({ el: {} as Element, fps: () => 60, render });
    frame!(1000); frame!(1017); frame!(1034);
    expect(render).toHaveBeenCalledTimes(3);
  });

  it('repaints gameplay changes at a bounded cadence in explicitly enabled test builds', async () => {
    vi.stubEnv('VITE_FNAB_TEST_HOOKS', '1');
    const { isRenderLite } = await import('../settings');
    expect(isRenderLite()).toBe(true);
    const { addFxTask } = await import('../scheduler');
    let state = 'normal';
    const paint = vi.fn();
    remove = addFxTask({ el: {} as Element, fps: () => 60, render: () => paint(state) });
    frame!(1000);
    for (const next of ['monster', 'blackout', 'sabotaged']) {
      state = next;
      frame!(1001 + paint.mock.calls.length * 250);
      expect(paint).toHaveBeenLastCalledWith(next);
    }
    const count = paint.mock.calls.length;
    frame!(1752);
    expect(paint).toHaveBeenCalledTimes(count);
  });

  it('honors fx=full even in a test build', async () => {
    vi.stubEnv('VITE_FNAB_TEST_HOOKS', '1');
    window.location.search = '?e2e&fx=full';
    const { isRenderLite } = await import('../settings');
    expect(isRenderLite()).toBe(false);
  });
});
