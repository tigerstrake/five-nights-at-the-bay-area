// Public interface of the audio module (owner: Audio agent). Foundation consumes these exports as declared.
// STUB: silent implementation until the audio agent replaces it.

export type SfxName =
  | 'uiClick'
  | 'uiHover'
  | 'cameraSwitch'
  | 'staticBurst'
  | 'doorClose'
  | 'doorOpen'
  | 'doorBlocked'
  | 'trapArm'
  | 'trapTrigger'
  | 'alarm'
  | 'scanPing'
  | 'sensorPing'
  | 'repairStart'
  | 'repairDone'
  | 'powerLow'
  | 'powerOut'
  | 'sabotage'
  | 'decoy'
  | 'monsterDistant'
  | 'monsterNear'
  | 'monsterScreech'
  | 'commandIssued'
  | 'abilityReady'
  | 'countdownTick'
  | 'matchStart'
  | 'phaseChange';

export type AmbienceKind = 'none' | 'lobby' | 'defender' | 'monster';
export type StingerKind = 'victory' | 'defeat' | 'breach' | 'contained';

export interface AudioEngine {
  /** Must be called from a user gesture handler; nothing plays before this resolves. */
  unlock(): Promise<void>;
  isUnlocked(): boolean;
  setMasterVolume(v: number): void; // 0..1, persisted
  getMasterVolume(): number;
  setMuted(muted: boolean): void; // persisted
  isMuted(): boolean;
  play(name: SfxName, opts?: { volume?: number; pan?: number }): void;
  /** 0..1 — drives drones, heartbeat, interference layers. Smoothly interpolated. */
  setTension(level: number): void;
  setAmbience(kind: AmbienceKind): void;
  playStinger(kind: StingerKind): void;
  /** Subscribe to volume/mute changes (for UI). Returns unsubscribe. */
  subscribe(listener: () => void): () => void;
}

const listeners = new Set<() => void>();
let volume = 0.8;
let muted = false;

export const audio: AudioEngine = {
  async unlock() {},
  isUnlocked: () => false,
  setMasterVolume(v) {
    volume = Math.max(0, Math.min(1, v));
    listeners.forEach((l) => l());
  },
  getMasterVolume: () => volume,
  setMuted(m) {
    muted = m;
    listeners.forEach((l) => l());
  },
  isMuted: () => muted,
  play() {},
  setTension() {},
  setAmbience() {},
  playStinger() {},
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
