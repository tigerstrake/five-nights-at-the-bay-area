import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAudioEngine } from '../engine';
import { MIX, STORAGE_KEYS } from '../constants';
import { AMBIENCE_KINDS, SFX_NAMES, STINGER_KINDS, type ManagedAudioEngine } from '../types';
import { clamp, readSettings, RepeatGate, type AudioStorage } from '../state';
import { FakeAudioContext } from './fake-context';

const engines: ManagedAudioEngine[] = [];
const make = (options: Parameters<typeof createAudioEngine>[0] = {}): ManagedAudioEngine => {
  const engine = createAudioEngine({ storage: null, fetcher: null, ...options });
  engines.push(engine);
  return engine;
};
const memoryStorage = (initial: Record<string, string> = {}): AudioStorage => {
  const data = new Map(Object.entries(initial));
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  engines.splice(0).forEach(engine => engine.dispose());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('safe state and persistence', () => {
  it('clamps volume, handles nonfinite inputs and round-trips mute and volume', () => {
    const storage = memoryStorage();
    const engine = make({ storage });
    engine.setMasterVolume(7);
    expect(engine.getMasterVolume()).toBe(1);
    engine.setMasterVolume(-4);
    expect(engine.getMasterVolume()).toBe(0);
    engine.setMasterVolume(0.37);
    engine.setMasterVolume(NaN);
    expect(engine.getMasterVolume()).toBe(0.37);
    engine.setMuted(true);
    const restored = make({ storage });
    expect(restored.getMasterVolume()).toBe(0.37);
    expect(restored.isMuted()).toBe(true);
    expect(clamp(Infinity)).toBe(1);
    expect(clamp(-Infinity)).toBe(0);
    expect(clamp(NaN)).toBe(0);
    expect(clamp(9, -1, 1)).toBe(1);
  });

  it('survives failing reads and writes while notifying listeners', () => {
    const storage = { getItem: vi.fn(() => { throw new Error('denied'); }), setItem: vi.fn(() => { throw new Error('quota'); }) };
    const engine = make({ storage });
    expect(storage.getItem).toHaveBeenCalledTimes(2);
    expect(engine.getMasterVolume()).toBe(MIX.defaultVolume);
    const changed = vi.fn();
    engine.subscribe(changed);
    expect(() => { engine.setMasterVolume(0.2); engine.setMuted(true); }).not.toThrow();
    expect(changed).toHaveBeenCalledTimes(2);
    expect(engine.getMasterVolume()).toBe(0.2);
    expect(engine.isMuted()).toBe(true);
  });

  it('handles a denied localStorage getter and corrupt stored values', () => {
    vi.stubGlobal('localStorage', undefined);
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => { throw new Error('unavailable'); },
    });
    const engine = createAudioEngine({ fetcher: null });
    engines.push(engine);
    expect(engine.getMasterVolume()).toBe(MIX.defaultVolume);
    expect(readSettings(memoryStorage({ [STORAGE_KEYS.volume]: 'invalid', [STORAGE_KEYS.muted]: 'garbage' })))
      .toEqual({ volume: MIX.defaultVolume, muted: false });
    expect(readSettings(memoryStorage({ [STORAGE_KEYS.volume]: '9' })).volume).toBe(1);
    expect(readSettings(memoryStorage({ [STORAGE_KEYS.volume]: '' })).volume).toBe(MIX.defaultVolume);
  });

  it('notifies on actual changes, supports unsubscribe, and isolates throwing subscribers', () => {
    const engine = make();
    const listener = vi.fn();
    engine.subscribe(() => { throw new Error('view failed'); });
    const unsubscribe = engine.subscribe(listener);
    engine.setMasterVolume(0.8);
    engine.setMuted(false);
    expect(listener).not.toHaveBeenCalled();
    engine.setMasterVolume(0.4);
    engine.setMuted(true);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    unsubscribe();
    engine.setMuted(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('unlock and playback gating', () => {
  it('does not construct a context, fetch, retain room state or schedule sounds before unlock', async () => {
    const context = new FakeAudioContext();
    const factory = vi.fn(() => context.asContext());
    const fetcher = vi.fn<typeof fetch>();
    const engine = make({ createContext: factory, fetcher });
    SFX_NAMES.forEach(name => engine.play(name));
    STINGER_KINDS.forEach(name => engine.playStinger(name));
    engine.setTension(1);
    engine.setAmbience('monster');
    expect(engine.isUnlocked()).toBe(false);
    expect(factory).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const unlocking = engine.unlock();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(context.resume).toHaveBeenCalledTimes(1);
    await unlocking;
    expect(engine.isUnlocked()).toBe(true);
    const baseline = context.starts;
    context.advance(40);
    vi.advanceTimersByTime(200);
    expect(context.starts).toBe(baseline);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not throw or claim unlock in SSR without AudioContext', async () => {
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', undefined);
    const engine = make();
    await expect(engine.unlock()).resolves.toBeUndefined();
    expect(engine.isUnlocked()).toBe(false);
    expect(() => { engine.play('alarm'); engine.playStinger('breach'); engine.setAmbience('defender'); }).not.toThrow();
  });

  it('coalesces unlock, resumes a suspended context, and retries a denied resume', async () => {
    const context = new FakeAudioContext();
    const factory = vi.fn(() => context.asContext());
    const engine = make({ createContext: factory });
    const first = engine.unlock();
    expect(engine.unlock()).toBe(first);
    await first;
    context.state = 'suspended';
    expect(engine.isUnlocked()).toBe(false);
    const before = context.starts;
    engine.play('alarm');
    expect(context.starts).toBe(before);
    await engine.unlock();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(context.resume).toHaveBeenCalledTimes(2);
    expect(engine.isUnlocked()).toBe(true);

    const denied = new FakeAudioContext();
    denied.resume.mockRejectedValueOnce(new Error('gesture denied'));
    const retry = make({ createContext: () => denied.asContext() });
    await expect(retry.unlock()).resolves.toBeUndefined();
    expect(retry.isUnlocked()).toBe(false);
    await retry.unlock();
    expect(retry.isUnlocked()).toBe(true);
  });

  it('limits repeats independently by name without queuing or counting pre-unlock calls', async () => {
    const context = new FakeAudioContext();
    const engine = make({ createContext: () => context.asContext() });
    engine.play('uiHover');
    await engine.unlock();
    const base = context.starts;
    engine.play('uiHover');
    const first = context.starts;
    expect(first).toBeGreaterThan(base);
    engine.play('uiHover');
    expect(context.starts).toBe(first);
    context.advance(0.059);
    engine.play('uiHover');
    expect(context.starts).toBe(first);
    context.advance(0.002);
    engine.play('uiHover');
    expect(context.starts).toBeGreaterThan(first);
    const second = context.starts;
    engine.play('uiClick');
    expect(context.starts).toBeGreaterThan(second);
    engine.setMuted(true);
    engine.play('alarm');
    const muted = context.starts;
    engine.setMuted(false);
    engine.play('alarm');
    expect(context.starts).toBeGreaterThan(muted);
  });

  it('supports monotonic rate-gate boundaries and reset', () => {
    const gate = new RepeatGate();
    expect(gate.accept('a', 0, 60)).toBe(true);
    expect(gate.accept('a', 59, 60)).toBe(false);
    expect(gate.accept('b', 59, 60)).toBe(true);
    expect(gate.accept('a', 60, 60)).toBe(true);
    gate.clear();
    expect(gate.accept('a', 61, 60)).toBe(true);
  });
});

describe('resource lifetime', () => {
  it('exercises the whole palette and returns transient nodes to baseline', async () => {
    const context = new FakeAudioContext();
    const engine = make({ createContext: () => context.asContext() });
    await engine.unlock();
    const baseline = context.live;
    for (const name of SFX_NAMES) {
      engine.play(name, { volume: 0.6, pan: -0.25 });
      context.advance(10);
      expect(context.live, name).toBe(baseline);
    }
    for (const name of STINGER_KINDS) {
      engine.playStinger(name);
      context.advance(12);
      expect(context.live, name).toBe(baseline);
    }
    expect(vi.getTimerCount()).toBe(1);
    engine.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(context.live).toBe(1); // Only the fake destination is outside the owned graph.
    expect(context.close).toHaveBeenCalledOnce();
  });

  it('bounds voices and crossfades, then releases every bed on disposal', async () => {
    const context = new FakeAudioContext();
    const engine = make({ createContext: () => context.asContext() });
    await engine.unlock();
    for (let i = 0; i < 100; i++) {
      engine.setAmbience(AMBIENCE_KINDS[1 + i % 3]);
      engine.setTension(i / 99);
    }
    const baseline = context.starts;
    for (let i = 0; i < 200; i++) {
      engine.play(SFX_NAMES[i % SFX_NAMES.length]);
      context.currentTime += 0.01;
    }
    expect(context.starts - baseline).toBeLessThan(250);
    engine.setAmbience('none');
    context.advance(10);
    engine.dispose();
    expect(context.live).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runs a ten-minute threat schedule with bounded live nodes', async () => {
    const context = new FakeAudioContext();
    const engine = make({ createContext: () => context.asContext() });
    await engine.unlock();
    engine.setAmbience('defender');
    engine.setTension(1);
    for (let second = 0; second < 600; second++) {
      context.advance(1);
      vi.advanceTimersByTime(100);
      expect(context.live).toBeLessThan(260);
    }
    engine.setAmbience('none');
    context.advance(10);
    engine.dispose();
    expect(context.live).toBe(1);
  });
});
