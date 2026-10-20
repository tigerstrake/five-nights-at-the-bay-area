import type { Noise, Tone, Voice } from './synthesis';
import type { BusName, SfxName } from './types';

export interface SoundDesign {
  duration: number;
  wet: number;
  bus?: BusName;
  repeatMs?: number;
  tones?: readonly Tone[];
  noises?: readonly Noise[];
  creature?: 'distant' | 'near' | 'screech';
}

/** Levels are deliberately conservative: several defenders can trigger systems at once. */
export const SOUND_DESIGNS: Record<SfxName, SoundDesign> = {
  uiClick: { duration: 0.07, wet: 0, bus: 'ui', repeatMs: 45,
    tones: [{ hz: 1120, endHz: 740, duration: 0.035, peak: 0.065 }],
    noises: [{ duration: 0.018, peak: 0.035, filter: { type: 'highpass', hz: 1800 } }] },
  uiHover: { duration: 0.04, wet: 0, bus: 'ui', repeatMs: 60,
    tones: [{ hz: 1460, duration: 0.028, peak: 0.022 }] },
  cameraSwitch: { duration: 0.23, wet: 0.05, repeatMs: 90,
    tones: [{ hz: 185, endHz: 80, duration: 0.035, peak: 0.13, wave: 'triangle' }],
    noises: [
      { duration: 0.018, peak: 0.22, filter: { type: 'bandpass', hz: 2100, q: 1.3 } },
      { at: 0.035, duration: 0.13, peak: 0.12, filter: { type: 'highpass', hz: 1300 } },
      { at: 0.16, duration: 0.022, peak: 0.05, filter: { type: 'bandpass', hz: 900 } },
    ] },
  staticBurst: { duration: 0.5, wet: 0.07, repeatMs: 160,
    noises: [
      { duration: 0.42, peak: 0.18, filter: { type: 'bandpass', hz: 2400, endHz: 550, q: 0.6 } },
      { at: 0.08, duration: 0.06, peak: 0.19, filter: { type: 'highpass', hz: 3200 } },
      { at: 0.29, duration: 0.035, peak: 0.12 },
    ] },
  doorClose: { duration: 1.35, wet: 0.27, repeatMs: 280,
    tones: [
      { hz: 94, endHz: 47, duration: 0.85, peak: 0.13, wave: 'sawtooth', attack: 0.08, filter: { type: 'lowpass', hz: 230 } },
      { at: 0.73, hz: 63, endHz: 29, duration: 0.52, peak: 0.3 },
      { at: 0.74, hz: 347, endHz: 310, duration: 0.3, peak: 0.065, wave: 'triangle' },
    ], noises: [
      { duration: 0.8, peak: 0.15, attack: 0.12, filter: { type: 'bandpass', hz: 640, endHz: 240, q: 2 } },
      { at: 0.73, duration: 0.22, peak: 0.28, color: 'brown', filter: { type: 'lowpass', hz: 1500 } },
    ] },
  doorOpen: { duration: 1.3, wet: 0.2, repeatMs: 280,
    tones: [
      { hz: 42, endHz: 112, duration: 0.95, peak: 0.11, wave: 'sawtooth', attack: 0.11, filter: { type: 'lowpass', hz: 330 } },
      { hz: 190, endHz: 140, duration: 0.12, peak: 0.11, wave: 'triangle' },
    ], noises: [
      { duration: 0.14, peak: 0.2, filter: { type: 'bandpass', hz: 800, q: 1.6 } },
      { at: 0.08, duration: 1.1, peak: 0.13, attack: 0.15, filter: { type: 'bandpass', hz: 400, endHz: 1700, q: 1.6 } },
    ] },
  doorBlocked: { duration: 0.55, wet: 0.22, repeatMs: 230,
    tones: [
      { hz: 87, endHz: 49, duration: 0.37, peak: 0.24 },
      { hz: 267, duration: 0.23, peak: 0.06, wave: 'triangle' },
    ], noises: [{ duration: 0.16, peak: 0.23, color: 'brown', filter: { type: 'lowpass', hz: 850 } }] },
  trapArm: { duration: 0.9, wet: 0.12, repeatMs: 220,
    tones: [
      { hz: 130, endHz: 360, duration: 0.52, peak: 0.055, wave: 'triangle' },
      { at: 0.58, hz: 980, duration: 0.18, peak: 0.085 },
    ], noises: [
      { duration: 0.06, peak: 0.16, filter: { type: 'bandpass', hz: 2100, q: 2 } },
      { at: 0.52, duration: 0.065, peak: 0.2, filter: { type: 'bandpass', hz: 1100, q: 2 } },
    ] },
  trapTrigger: { duration: 1.1, wet: 0.3, repeatMs: 300,
    tones: [
      { hz: 310, endHz: 76, duration: 0.3, peak: 0.19, wave: 'sawtooth', filter: { type: 'lowpass', hz: 2100 } },
      { hz: 58, endHz: 31, duration: 0.8, peak: 0.27 },
      { at: 0.14, hz: 1540, endHz: 560, duration: 0.65, peak: 0.05, wave: 'triangle' },
    ], noises: [{ duration: 0.32, peak: 0.28, filter: { type: 'bandpass', hz: 1800, endHz: 500, q: 2.5 } }] },
  alarm: { duration: 2.15, wet: 0.14, repeatMs: 1800,
    tones: [
      { hz: 440, endHz: 550, duration: 0.48, peak: 0.12, wave: 'triangle', attack: 0.05, release: 0.15 },
      { at: 0.68, hz: 440, endHz: 550, duration: 0.48, peak: 0.12, wave: 'triangle', attack: 0.05, release: 0.15 },
      { at: 1.36, hz: 440, endHz: 550, duration: 0.48, peak: 0.12, wave: 'triangle', attack: 0.05, release: 0.15 },
    ] },
  scanPing: { duration: 1.4, wet: 0.48, repeatMs: 350,
    tones: [
      { hz: 1450, endHz: 620, duration: 1.15, peak: 0.15, attack: 0.012 },
      { at: 0.14, hz: 1462, endHz: 625, duration: 0.9, peak: 0.045 },
    ] },
  sensorPing: { duration: 0.65, wet: 0.21, repeatMs: 200,
    tones: [
      { hz: 870, duration: 0.16, peak: 0.1 },
      { at: 0.19, hz: 1160, duration: 0.32, peak: 0.12 },
    ] },
  repairStart: { duration: 0.7, wet: 0.06, repeatMs: 220,
    tones: [
      { hz: 240, endHz: 580, duration: 0.4, peak: 0.065, wave: 'triangle' },
      { at: 0.36, hz: 710, duration: 0.2, peak: 0.08 },
    ], noises: [{ duration: 0.07, peak: 0.1, filter: { type: 'bandpass', hz: 1400 } }] },
  repairDone: { duration: 1, wet: 0.19, repeatMs: 300,
    tones: [
      { hz: 523.25, duration: 0.35, peak: 0.1 },
      { at: 0.17, hz: 784, duration: 0.62, peak: 0.11 },
      { at: 0.2, hz: 1046.5, duration: 0.53, peak: 0.035 },
    ] },
  powerLow: { duration: 1.25, wet: 0.07, repeatMs: 2200,
    tones: [
      { hz: 680, duration: 0.18, peak: 0.12, wave: 'triangle', release: 0.05 },
      { at: 0.33, hz: 680, duration: 0.18, peak: 0.12, wave: 'triangle', release: 0.05 },
      { at: 0.66, hz: 510, duration: 0.35, peak: 0.11, wave: 'triangle', release: 0.14 },
    ] },
  powerOut: { duration: 2.2, wet: 0.24, repeatMs: 1800,
    tones: [
      { hz: 820, endHz: 23, duration: 1.7, peak: 0.12, wave: 'sawtooth', filter: { type: 'lowpass', hz: 1400, endHz: 80 } },
      { at: 1.35, hz: 67, endHz: 25, duration: 0.75, peak: 0.28 },
    ], noises: [
      { duration: 0.7, peak: 0.13, filter: { type: 'lowpass', hz: 1900, endHz: 100 } },
      { at: 1.35, duration: 0.18, peak: 0.21, color: 'brown' },
    ] },
  sabotage: { duration: 1.4, wet: 0.24, repeatMs: 350,
    tones: [
      { hz: 190, endHz: 37, duration: 0.82, peak: 0.15, wave: 'sawtooth', drive: 2.8, filter: { type: 'bandpass', hz: 900, endHz: 120, q: 3 } },
      { at: 0.23, hz: 1840, endHz: 240, duration: 0.58, peak: 0.06, wave: 'square', filter: { type: 'lowpass', hz: 2400 } },
    ], noises: [
      { duration: 0.15, peak: 0.23, filter: { type: 'highpass', hz: 2800 } },
      { at: 0.2, duration: 0.8, peak: 0.15, filter: { type: 'bandpass', hz: 1700, endHz: 350, q: 1.6 } },
      { at: 0.86, duration: 0.09, peak: 0.17 },
    ] },
  decoy: { duration: 1.7, wet: 0.65, repeatMs: 500,
    tones: [
      { hz: 209, endHz: 127, duration: 1.3, peak: 0.085, wave: 'triangle', attack: 0.24 },
      { at: 0.22, hz: 213, endHz: 131, duration: 1.25, peak: 0.055, attack: 0.25 },
    ], noises: [{ at: 0.15, duration: 1.1, peak: 0.09, attack: 0.23, filter: { type: 'bandpass', hz: 740, endHz: 380, q: 4 } }] },
  monsterDistant: { duration: 2.7, wet: 0.78, repeatMs: 1400, creature: 'distant' },
  monsterNear: { duration: 2.1, wet: 0.2, repeatMs: 1000, creature: 'near' },
  monsterScreech: { duration: 1.8, wet: 0.34, repeatMs: 1200, creature: 'screech' },
  commandIssued: { duration: 0.5, wet: 0.16, bus: 'ui', repeatMs: 100,
    tones: [
      { hz: 247, endHz: 164, duration: 0.32, peak: 0.1, wave: 'triangle' },
      { at: 0.09, hz: 493, endHz: 329, duration: 0.25, peak: 0.045 },
    ] },
  abilityReady: { duration: 1.1, wet: 0.4, bus: 'ui', repeatMs: 400,
    tones: [
      { hz: 185, endHz: 370, duration: 0.8, peak: 0.07, attack: 0.16, wave: 'triangle' },
      { at: 0.28, hz: 740, duration: 0.65, peak: 0.085, attack: 0.02 },
      { at: 0.28, hz: 747, duration: 0.65, peak: 0.025 },
    ] },
  countdownTick: { duration: 0.18, wet: 0.09, repeatMs: 200,
    tones: [{ hz: 760, duration: 0.095, peak: 0.11 }],
    noises: [{ duration: 0.015, peak: 0.07, filter: { type: 'highpass', hz: 2500 } }] },
  matchStart: { duration: 2.5, wet: 0.42, repeatMs: 1800,
    tones: [
      { hz: 41.2, endHz: 32.7, duration: 2.1, peak: 0.2, attack: 0.03 },
      { hz: 164.8, duration: 1.9, peak: 0.09, attack: 0.18, wave: 'triangle' },
      { at: 0.27, hz: 246.94, duration: 1.8, peak: 0.065, attack: 0.25 },
    ], noises: [{ duration: 1.1, peak: 0.13, filter: { type: 'lowpass', hz: 1400, endHz: 180 } }] },
  phaseChange: { duration: 2.2, wet: 0.52, repeatMs: 1200,
    tones: [
      { hz: 73.4, endHz: 55, duration: 1.8, peak: 0.15, wave: 'triangle', attack: 0.12 },
      { at: 0.1, hz: 293.7, endHz: 220, duration: 1.6, peak: 0.07, attack: 0.2 },
      { at: 0.1, hz: 311.1, endHz: 233, duration: 1.8, peak: 0.035, attack: 0.3 },
    ], noises: [{ duration: 1.7, peak: 0.07, attack: 0.4, filter: { type: 'bandpass', hz: 1200, endHz: 180, q: 2 } }] },
};

const CREATURE = {
  distant: { duration: 2.5, attack: 0.32, fundamental: 52, endHz: 33, level: 0.085, breath: 0.095, formants: [280, 720, 1230], vibrato: 3.1, cents: 34, scrapeHz: 1150 },
  near: { duration: 1.9, attack: 0.13, fundamental: 67, endHz: 31, level: 0.15, breath: 0.16, formants: [370, 940, 1720], vibrato: 4.8, cents: 58, scrapeHz: 1920 },
  screech: { duration: 1.65, attack: 0.045, fundamental: 510, endHz: 118, level: 0.12, breath: 0.17, formants: [920, 2180, 3100], vibrato: 13, cents: 95, scrapeHz: 3300 },
} as const;
const CREATURE_SHAPE = { q: 4.5, drive: 2.5, formantFall: 0.58, formantScale: 0.65, scrapeAt: 0.3, scrapeDuration: 0.8, scrapeLevel: 0.035, scrapeQ: 11 } as const;

export function renderCreature(voice: Voice, kind: NonNullable<SoundDesign['creature']>): void {
  const c = CREATURE[kind];
  const groan = voice.tone({ hz: c.fundamental, endHz: c.endHz, duration: c.duration, peak: c.level,
    attack: c.attack, wave: 'sawtooth', drive: CREATURE_SHAPE.drive,
    filter: { type: 'lowpass', hz: c.formants[1], endHz: c.formants[0] } });
  const modulation = voice.own(voice.context.createGain());
  modulation.gain.value = c.cents;
  modulation.connect(groan.detune);
  voice.oscillator(c.vibrato, 'sine', modulation, 0, c.duration);
  for (const hz of c.formants) voice.noise({ duration: c.duration, peak: c.breath * CREATURE_SHAPE.formantScale,
    attack: c.attack, drive: CREATURE_SHAPE.drive,
    filter: { type: 'bandpass', hz, endHz: hz * CREATURE_SHAPE.formantFall, q: CREATURE_SHAPE.q } });
  voice.noise({ at: CREATURE_SHAPE.scrapeAt, duration: CREATURE_SHAPE.scrapeDuration, peak: CREATURE_SHAPE.scrapeLevel,
    attack: c.attack, filter: { type: 'bandpass', hz: c.scrapeHz, endHz: c.scrapeHz * CREATURE_SHAPE.formantFall, q: CREATURE_SHAPE.scrapeQ } });
}

export function renderDesign(voice: Voice, design: SoundDesign): void {
  for (const tone of design.tones ?? []) voice.tone(tone);
  for (const noise of design.noises ?? []) voice.noise(noise);
  if (design.creature) renderCreature(voice, design.creature);
}
