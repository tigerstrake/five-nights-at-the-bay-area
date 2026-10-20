import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetLibrary } from '../assets';
import { MIX } from '../constants';
import { FakeAudioContext } from './fake-context';

const libraries: AssetLibrary[] = [];
const manifest = (value: unknown): Response => new Response(JSON.stringify(value));
const make = (fetcher: typeof fetch, changed = vi.fn(), context = new FakeAudioContext()): AssetLibrary => {
  const library = new AssetLibrary(context.asContext(), fetcher, changed);
  libraries.push(library);
  return library;
};
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  libraries.splice(0).forEach(library => library.dispose());
  vi.useRealTimers();
});

describe('optional audio assets', () => {
  it.each([new Response('', { status: 404 }), new Response('<html>SPA fallback</html>')])
    ('silently keeps synthesis for an absent or invalid manifest', async response => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      const changed = vi.fn();
      const library = make(fetcher, changed);
      await expect(library.loadManifest()).resolves.toBeUndefined();
      expect(library.get('sfx', 'cameraSwitch')).toBeUndefined();
      expect(changed).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

  it('loads only known same-origin names, on demand, and decodes each file once', async () => {
    const context = new FakeAudioContext();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(manifest({ sfx: {
        cameraSwitch: 'camera.ogg', doorClose: 'https://example.com/door.ogg',
        trapArm: 'http://[', uiClick: 'click.wav', notAName: 'other.wav',
      } }))
      .mockImplementation(async () => new Response(new Uint8Array([1, 2, 3])));
    const changed = vi.fn();
    const library = make(fetcher, changed, context);
    await library.loadManifest();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(library.get('sfx', 'doorClose')).toBeUndefined();
    expect(library.get('sfx', 'notAName')).toBeUndefined();
    expect(library.get('sfx', 'trapArm')).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(library.get('sfx', 'cameraSwitch')).toBeUndefined();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith('sfx', 'cameraSwitch'));
    expect(fetcher.mock.calls[1][0]).toBe('http://localhost/assets/audio/camera.ogg');
    expect(library.get('sfx', 'cameraSwitch')?.duration).toBe(1);
    library.get('sfx', 'cameraSwitch');
    expect(context.decodeAudioData).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(2);
    // A bad adjacent URL did not suppress this valid override.
    expect(library.get('sfx', 'uiClick')).toBeUndefined();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith('sfx', 'uiClick'));
  });

  it.each(['stingers', 'ambience'] as const)('supports %s overrides', async group => {
    const name = group === 'stingers' ? 'victory' : 'defender';
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(manifest({ [group]: { [name]: `${name}.wav` } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1])));
    const changed = vi.fn();
    const library = make(fetcher, changed);
    await library.loadManifest();
    expect(library.get(group, name)).toBeUndefined();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(group, name));
    expect(library.get(group, name)?.duration).toBe(1);
  });

  it('does not retry failed decodes on repeated plays', async () => {
    const context = new FakeAudioContext();
    context.decodeAudioData.mockRejectedValue(new Error('unsupported codec'));
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(manifest({ sfx: { cameraSwitch: 'bad.ogg' } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1])));
    const library = make(fetcher, vi.fn(), context);
    await library.loadManifest();
    library.get('sfx', 'cameraSwitch');
    await vi.waitFor(() => expect(context.decodeAudioData).toHaveBeenCalledOnce());
    expect(library.get('sfx', 'cameraSwitch')).toBeUndefined();
    expect(library.get('sfx', 'cameraSwitch')).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('aborts unfinished file loads on disposal and never installs stale buffers', async () => {
    let finish: (response: Response) => void = () => {};
    const context = new FakeAudioContext();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(manifest({ sfx: { cameraSwitch: 'pending.ogg' } }))
      .mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const changed = vi.fn();
    const library = make(fetcher, changed, context);
    await library.loadManifest();
    library.get('sfx', 'cameraSwitch');
    const signal = fetcher.mock.calls[1][1]?.signal;
    library.dispose();
    expect(signal?.aborted).toBe(true);
    finish(new Response(new Uint8Array([1])));
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
    expect(context.decodeAudioData).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalledWith('sfx', 'cameraSwitch');
  });

  it('times out an unresponsive optional file', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(manifest({ sfx: { cameraSwitch: 'slow.ogg' } }))
      .mockImplementation((_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }));
    const library = make(fetcher);
    await library.loadManifest();
    library.get('sfx', 'cameraSwitch');
    await vi.advanceTimersByTimeAsync(MIX.assetTimeoutMs);
    expect(fetcher.mock.calls[1][1]?.signal?.aborted).toBe(true);
    expect(library.get('sfx', 'cameraSwitch')).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
