// Global FX settings (reduced motion). Read every frame by renderers, so changes apply live.

let override: boolean | null = null;
const listeners = new Set<() => void>();
let mq: MediaQueryList | null = null;

function media(): MediaQueryList | null {
  if (mq || typeof window === 'undefined' || !window.matchMedia) return mq;
  mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  mq.addEventListener?.('change', () => listeners.forEach((l) => l()));
  return mq;
}

/** True when flashing/jitter should be reduced (OS preference unless overridden). */
export function isReducedMotion(): boolean {
  if (override !== null) return override;
  return media()?.matches ?? false;
}

/** Force reduced motion on/off; `null` follows the OS `prefers-reduced-motion` setting. */
export function setFxReducedMotion(value: boolean | null): void {
  override = value;
  listeners.forEach((l) => l());
}

export function subscribeFxSettings(fn: () => void): () => void {
  listeners.add(fn);
  media();
  return () => listeners.delete(fn);
}

let assetsEnabled = true;
/** Disable optional PNG assets (monster sprites / sim images) to force the procedural fallbacks. */
export function setFxAssetsEnabled(v: boolean): void {
  assetsEnabled = v;
}
export function fxAssetsEnabled(): boolean {
  return assetsEnabled;
}
