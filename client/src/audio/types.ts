export const SFX_NAMES = [
  'uiClick', 'uiHover', 'cameraSwitch', 'staticBurst', 'doorClose', 'doorOpen',
  'doorBlocked', 'trapArm', 'trapTrigger', 'alarm', 'scanPing', 'sensorPing',
  'repairStart', 'repairDone', 'powerLow', 'powerOut', 'sabotage', 'decoy',
  'monsterDistant', 'monsterNear', 'monsterScreech', 'commandIssued',
  'abilityReady', 'countdownTick', 'matchStart', 'phaseChange',
] as const;
export type SfxName = typeof SFX_NAMES[number];
export const AMBIENCE_KINDS = ['none', 'lobby', 'defender', 'monster'] as const;
export type AmbienceKind = typeof AMBIENCE_KINDS[number];
export const STINGER_KINDS = ['victory', 'defeat', 'breach', 'contained'] as const;
export type StingerKind = typeof STINGER_KINDS[number];
export type BusName = 'ambience' | 'sfx' | 'ui' | 'stinger';
export interface PlayOptions { volume?: number; pan?: number }

export interface AudioEngine {
  /** Call directly from a user gesture. No sound is queued before unlock. */
  unlock(): Promise<void>;
  isUnlocked(): boolean;
  setMasterVolume(v: number): void;
  getMasterVolume(): number;
  setMuted(muted: boolean): void;
  isMuted(): boolean;
  play(name: SfxName, opts?: PlayOptions): void;
  setTension(level: number): void;
  setAmbience(kind: AmbienceKind): void;
  playStinger(kind: StingerKind): void;
  subscribe(listener: () => void): () => void;
}

export interface ManagedAudioEngine extends AudioEngine {
  /** Release sources, graph, scheduler and context, e.g. when unmounting a lab. */
  dispose(): void;
}
