import { AmbienceDirector } from './ambience';
import { AssetLibrary } from './assets';
import { MIX, STORAGE_KEYS } from './constants';
import { renderDesign, SOUND_DESIGNS } from './sfx';
import { browserStorage, clamp, readSettings, RepeatGate, writeSetting, type AudioStorage } from './state';
import { STINGER_DESIGNS } from './stingers';
import { createGraph, smooth, SynthResources, Voice, type AudioGraph } from './synthesis';
import { AMBIENCE_KINDS, type AmbienceKind, type BusName, type ManagedAudioEngine } from './types';

export interface AudioEngineOptions {
  /** Dependency seams for tests and embedded clients; never invoked until unlock. */
  createContext?: () => AudioContext | undefined;
  storage?: AudioStorage | null;
  fetcher?: typeof fetch | null;
}

function browserContext(): AudioContext | undefined {
  const host = globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext };
  const Constructor = host.AudioContext ?? host.webkitAudioContext;
  return Constructor ? new Constructor({ latencyHint: 'interactive' }) : undefined;
}

export function createAudioEngine(options: AudioEngineOptions = {}): ManagedAudioEngine {
  const storage = options.storage === null ? undefined : options.storage ?? browserStorage();
  let { volume, muted } = readSettings(storage);
  const listeners = new Set<() => void>();
  const gate = new RepeatGate();
  const active = new Set<Voice>();
  let context: AudioContext | undefined;
  let resources: SynthResources | undefined;
  let graph: AudioGraph | undefined;
  let ambience: AmbienceDirector | undefined;
  let assets: AssetLibrary | undefined;
  let scheduler: ReturnType<typeof setInterval> | undefined;
  let ready = false;
  let epoch = 0;
  let selectedAmbience: AmbienceKind = 'none';
  let pendingUnlock: Promise<void> | undefined;

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* A UI observer cannot interrupt audio state. */ }
    }
  };
  const updateMaster = (): void => {
    if (context && graph) smooth(graph.master.gain, muted ? 0 : volume, context.currentTime, MIX.masterSmoothing);
  };
  const voice = (bus: BusName, duration: number, level = 1, pan = 0, wet = 0): Voice | undefined => {
    if (!resources || !graph || !ready || context?.state !== 'running') return undefined;
    if (active.size >= MIX.maximumVoices) {
      active.values().next().value?.stop();
      return undefined;
    }
    const created = new Voice(resources, graph.buses[bus], duration, level, pan, wet, finished => active.delete(finished));
    active.add(created);
    return created;
  };
  const dispose = (): void => {
    epoch++;
    ready = false;
    pendingUnlock = undefined;
    if (scheduler !== undefined) clearInterval(scheduler);
    scheduler = undefined;
    assets?.dispose();
    assets = undefined;
    ambience?.dispose();
    ambience = undefined;
    for (const playing of active) playing.dispose();
    active.clear();
    graph?.dispose();
    graph = undefined;
    resources = undefined;
    if (context && context.state !== 'closed') void context.close().catch(() => {});
    context = undefined;
    selectedAmbience = 'none';
    gate.clear();
  };

  const engine: ManagedAudioEngine = {
    unlock() {
      if (pendingUnlock) return pendingUnlock;
      // Context construction AND resume occur synchronously within the gesture.
      let resumed: Promise<void>;
      try {
        if (!context || context.state === 'closed') {
          if (context) dispose();
          context = (options.createContext ?? browserContext)();
          if (!context) return Promise.resolve();
        }
        resumed = context.state === 'running' ? Promise.resolve() : context.resume();
      } catch { return Promise.resolve(); }
      const generation = epoch;
      pendingUnlock = resumed.then(() => {
        if (epoch !== generation || !context || context.state !== 'running') return;
        if (!graph) {
          resources = new SynthResources(context);
          graph = createGraph(context, resources, muted ? 0 : volume);
          ambience = new AmbienceDirector(resources, graph,
            (duration, level, pan, wet) => voice('ambience', duration, level, pan, wet));
          const fetcher = options.fetcher === null ? undefined : options.fetcher ?? globalThis.fetch?.bind(globalThis);
          assets = new AssetLibrary(context, fetcher, (group, name) => {
            if (group === 'ambience' && selectedAmbience !== 'none' && (!name || name === selectedAmbience)) {
              ambience?.setKind(selectedAmbience, assets?.get('ambience', selectedAmbience));
            }
          });
          scheduler = setInterval(() => ambience?.tick(), MIX.schedulerMs);
          void assets.loadManifest();
        }
        ready = true;
      }).catch(() => {
        // Unsupported/denied Web Audio stays silent and unlock can be retried.
        if (!ready && epoch === generation) dispose();
      }).finally(() => {
        if (epoch === generation) pendingUnlock = undefined;
      });
      return pendingUnlock;
    },
    isUnlocked: () => ready && context?.state === 'running',
    setMasterVolume(value) {
      const next = clamp(value, 0, 1, volume);
      if (next === volume) return;
      volume = next;
      writeSetting(storage, STORAGE_KEYS.volume, String(volume));
      updateMaster();
      notify();
    },
    getMasterVolume: () => volume,
    setMuted(value) {
      if (value === muted) return;
      muted = value;
      writeSetting(storage, STORAGE_KEYS.muted, String(muted));
      updateMaster();
      notify();
    },
    isMuted: () => muted,
    play(name, opts = {}) {
      if (!ready || context?.state !== 'running') return;
      const design = SOUND_DESIGNS[name];
      const level = clamp(opts.volume ?? 1);
      if (!design || muted || volume === 0 || level === 0) return;
      if (!gate.accept(name, context.currentTime * 1000, design.repeatMs ?? MIX.defaultRepeatMs)) return;
      const sample = assets?.get('sfx', name);
      const playing = voice(design.bus ?? 'sfx', sample?.duration ?? design.duration, level, clamp(opts.pan ?? 0, -1, 1), sample ? 0 : design.wet);
      if (!playing) return;
      if (sample) playing.sample(sample);
      else renderDesign(playing, design);
    },
    setTension(level) {
      if (ready) ambience?.setTension(clamp(level));
    },
    setAmbience(kind) {
      if (!ready || !AMBIENCE_KINDS.includes(kind)) return;
      selectedAmbience = kind;
      ambience?.setKind(kind, kind === 'none' ? undefined : assets?.get('ambience', kind));
    },
    playStinger(kind) {
      if (!ready || context?.state !== 'running' || muted || volume === 0) return;
      const design = STINGER_DESIGNS[kind];
      if (!design || !gate.accept(`stinger:${kind}`, context.currentTime * 1000, MIX.stingerRepeatMs)) return;
      const sample = assets?.get('stingers', kind);
      const playing = voice('stinger', sample?.duration ?? design.duration, 1, 0, sample ? 0 : design.wet);
      if (!playing) return;
      if (sample) playing.sample(sample);
      else renderDesign(playing, design);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose,
  };
  return engine;
}

export const audio = createAudioEngine();
