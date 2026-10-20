import { MIX, STORAGE_KEYS } from './constants';

export type AudioStorage = Pick<Storage, 'getItem' | 'setItem'>;
export const clamp = (value: number, low = 0, high = 1, fallback = low): number =>
  Number.isNaN(value) ? fallback : Math.min(high, Math.max(low, value));

export function browserStorage(): AudioStorage | undefined {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage; }
  catch { return undefined; }
}

export function readSettings(storage?: AudioStorage): { volume: number; muted: boolean } {
  let volume: number = MIX.defaultVolume;
  let muted = false;
  try {
    const raw = storage?.getItem(STORAGE_KEYS.volume);
    if (raw != null && raw.trim() !== '') {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) volume = clamp(parsed);
    }
  } catch { /* Private browsing and embedded frames can deny storage. */ }
  try { muted = storage?.getItem(STORAGE_KEYS.muted) === 'true'; } catch { /* Optional persistence. */ }
  return { volume, muted };
}

export function writeSetting(storage: AudioStorage | undefined, key: string, value: string): void {
  try { storage?.setItem(key, value); } catch { /* Audio must work without storage. */ }
}

export class RepeatGate {
  private readonly previous = new Map<string, number>();
  accept(name: string, nowMs: number, intervalMs: number): boolean {
    const last = this.previous.get(name);
    if (last !== undefined && nowMs - last < intervalMs) return false;
    this.previous.set(name, nowMs);
    return true;
  }
  clear(): void { this.previous.clear(); }
}
