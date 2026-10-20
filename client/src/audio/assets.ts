import { MIX } from './constants';
import { AMBIENCE_KINDS, SFX_NAMES, STINGER_KINDS } from './types';

type AssetGroup = 'sfx' | 'stingers' | 'ambience';
type Manifest = Record<AssetGroup, Record<string, string>>;
const VALID_KEYS: Record<AssetGroup, readonly string[]> = {
  sfx: SFX_NAMES, stingers: STINGER_KINDS, ambience: AMBIENCE_KINDS.filter(kind => kind !== 'none'),
};
const emptyManifest = (): Manifest => ({ sfx: {}, stingers: {}, ambience: {} });

/** Missing manifests, invalid entries, codecs and individual files all fail closed
 * to the procedural palette. A pending one-shot is never replayed after download. */
export class AssetLibrary {
  private manifest = emptyManifest();
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly attempted = new Set<string>();
  private readonly controllers = new Set<AbortController>();
  private disposed = false;
  private readonly base: URL;

  constructor(private readonly context: AudioContext, private readonly fetcher: typeof fetch | undefined,
    private readonly changed: (group: AssetGroup, name?: string) => void) {
    this.base = new URL('/assets/audio/', typeof location === 'undefined' ? 'http://localhost/' : location.href);
  }

  private async request(url: URL): Promise<Response | undefined> {
    if (!this.fetcher || this.disposed) return undefined;
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), MIX.assetTimeoutMs);
    try {
      const response = await this.fetcher(url.href, { signal: controller.signal, credentials: 'same-origin' });
      if (!response.ok) return undefined;
      const bytes = Number(response.headers.get('content-length') ?? 0);
      if (bytes > MIX.maximumFileBytes) return undefined;
      // Read while the abort deadline is active, including a slow response body.
      const body = await response.arrayBuffer();
      if (body.byteLength > MIX.maximumFileBytes || this.disposed) return undefined;
      return new Response(body, { headers: response.headers });
    } catch { return undefined; }
    finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
    }
  }

  async loadManifest(): Promise<void> {
    try {
      const response = await this.request(new URL('manifest.json', this.base));
      if (!response || this.disposed) return;
      const raw: unknown = await response.json();
      if (!raw || typeof raw !== 'object') return;
      const result = emptyManifest();
      for (const group of ['sfx', 'stingers', 'ambience'] as const) {
        const entries: unknown = (raw as Record<string, unknown>)[group];
        if (!entries || typeof entries !== 'object') continue;
        for (const name of VALID_KEYS[group]) {
          const path: unknown = (entries as Record<string, unknown>)[name];
          if (typeof path !== 'string' || !path.trim()) continue;
          try {
            const url = new URL(path, this.base);
            if (url.origin === this.base.origin && (url.protocol === 'http:' || url.protocol === 'https:')) result[group][name] = url.href;
          } catch { /* One malformed entry must not invalidate other overrides. */ }
        }
      }
      if (!this.disposed) {
        this.manifest = result;
        this.changed('ambience');
      }
    } catch { /* Optional manifest may be absent or served as the SPA's HTML. */ }
  }

  get(group: AssetGroup, name: string): AudioBuffer | undefined {
    const key = `${group}:${name}`;
    const ready = this.buffers.get(key);
    if (!ready && !this.attempted.has(key) && this.manifest[group][name]) {
      this.attempted.add(key);
      void this.loadBuffer(group, name, this.manifest[group][name]);
    }
    return ready;
  }

  private async loadBuffer(group: AssetGroup, name: string, path: string): Promise<void> {
    try {
      const response = await this.request(new URL(path));
      if (!response || this.disposed) return;
      const buffer = await this.context.decodeAudioData(await response.arrayBuffer());
      const maximum = group === 'ambience' ? MIX.maximumAmbienceSeconds : MIX.maximumOverrideSeconds;
      if (this.disposed || buffer.duration <= 0 || buffer.duration > maximum) return;
      this.buffers.set(`${group}:${name}`, buffer);
      this.changed(group, name);
    } catch { /* Keep synthesis when a file or codec is unavailable. */ }
  }

  dispose(): void {
    this.disposed = true;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.buffers.clear();
    this.manifest = emptyManifest();
  }
}
