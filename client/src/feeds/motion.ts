import { useSyncExternalStore } from 'react';

const KEY = 'fnab-simulated-motion';
const listeners = new Set<() => void>();
export function motionSetting(): boolean {
  try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; }
}
export function setMotionSetting(value: boolean) {
  try { localStorage.setItem(KEY, value ? 'on' : 'off'); } catch { /* private browsing */ }
  listeners.forEach(fn => fn());
}
export function useMotionSetting() {
  return useSyncExternalStore(fn => {
    listeners.add(fn);
    window.addEventListener('storage', fn);
    return () => { listeners.delete(fn); window.removeEventListener('storage', fn); };
  }, motionSetting, () => true);
}

export function motionForFrame(main: boolean, stillOnly: boolean, enabled: boolean, requested: boolean, sighting: boolean): boolean {
  return main && stillOnly && enabled && requested && !sighting;
}
