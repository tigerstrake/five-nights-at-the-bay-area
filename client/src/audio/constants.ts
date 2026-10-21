export const MIX = {
  defaultVolume: 0.8,
  ambience: 0.72, sfx: 0.8, ui: 0.48, stinger: 0.8,
  masterSmoothing: 0.035, tensionSmoothing: 0.7, roomFade: 1.2,
  maximumVoices: 28, maximumRoomBeds: 4, voiceFade: 0.025, schedulerMs: 100,
  minimumGain: 0.0001, sourceLead: 0.008,
  noiseSeconds: 4, impulseSeconds: 2.6, impulseDecay: 3.4,
  compressorThreshold: -12, compressorKnee: 12, compressorRatio: 5,
  compressorAttack: 0.006, compressorRelease: 0.22,
  limiterThreshold: -4, limiterRelease: 0.12,
  masterHighpassHz: 22, masterLowpassHz: 8500,
  defaultRepeatMs: 100, stingerRepeatMs: 1500,
  maximumOverrideSeconds: 30, maximumAmbienceSeconds: 120,
  maximumFileBytes: 20 * 1024 * 1024, assetTimeoutMs: 8000,
} as const;

export const STORAGE_KEYS = {
  volume: 'fnab.audio.volume', muted: 'fnab.audio.muted',
} as const;

export const ATMOSPHERE = {
  droneHz: [39, 39.23, 58.5] as const, droneGain: 0.05,
  droneLfoHz: 0.085, droneLfoDepth: 0.018,
  bedGain: 0.026, bedCutoff: 290,
  heartbeatBaseHz: 0.63, heartbeatRiseHz: 1.35,
  heartbeatTone: 46, heartbeatDuration: 0.19, heartbeatDoubleDelay: 0.17,
  whineHz: 2730, whineGain: 0.012, whineThreshold: 0.58,
  crackleThreshold: 0.62, crackleBaseSeconds: 0.28, crackleRandomSeconds: 1.1,
  distantBaseSeconds: 21, distantRandomSeconds: 17, distantTensionReduction: 17,
  relayBaseSeconds: 4, relayRandomSeconds: 8,
} as const;
