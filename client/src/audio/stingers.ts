import type { StingerKind } from './types';
import type { SoundDesign } from './sfx';

export const STINGER_DESIGNS: Record<StingerKind, SoundDesign> = {
  victory: { duration: 5.8, wet: 0.68, tones: [
    { hz: 130.81, duration: 5.5, peak: 0.1, attack: 0.65, release: 2.6, wave: 'triangle' },
    { hz: 196, duration: 5.3, peak: 0.075, attack: 0.9, release: 2.6 },
    { at: 0.1, hz: 311.13, endHz: 329.63, duration: 1.1, peak: 0.055, attack: 0.3 },
    { at: 1.1, hz: 329.63, duration: 4.1, peak: 0.075, attack: 0.45, release: 2.8 },
    { at: 0.75, hz: 523.25, duration: 4.5, peak: 0.055, attack: 1.2, release: 2.6 },
    { at: 1.2, hz: 65.41, duration: 4.2, peak: 0.11, attack: 0.5 },
  ], noises: [{ duration: 3.8, peak: 0.035, attack: 0.7, filter: { type: 'lowpass', hz: 1100, endHz: 340 } }] },
  defeat: { duration: 5.4, wet: 0.66, tones: [
    { hz: 59, endHz: 23, duration: 4.4, peak: 0.3, attack: 0.012 },
    { hz: 123.47, endHz: 110, duration: 4.8, peak: 0.12, attack: 0.11, wave: 'triangle' },
    { hz: 130.81, endHz: 113, duration: 4.6, peak: 0.095, attack: 0.16, wave: 'triangle' },
    { hz: 174.61, endHz: 146.83, duration: 4.9, peak: 0.065, attack: 0.3, wave: 'sawtooth', filter: { type: 'lowpass', hz: 630, endHz: 180 } },
    { at: 0.08, hz: 261.63, endHz: 207.65, duration: 4.4, peak: 0.055, attack: 0.2 },
  ], noises: [{ duration: 2.7, peak: 0.2, filter: { type: 'lowpass', hz: 2100, endHz: 100 } }] },
  breach: { duration: 3.15, wet: 0.36, creature: 'screech', tones: [
    { hz: 83, endHz: 24, duration: 2.8, peak: 0.3 },
    { at: 0.08, hz: 177, endHz: 43, duration: 1.2, peak: 0.14, wave: 'sawtooth', filter: { type: 'lowpass', hz: 800 } },
  ], noises: [
    { duration: 0.28, peak: 0.32, color: 'brown', filter: { type: 'lowpass', hz: 2400 } },
    { at: 0.16, duration: 2.85, peak: 0.18, attack: 0.06, filter: { type: 'bandpass', hz: 2700, endHz: 260, q: 0.7 } },
    { at: 0.62, duration: 0.12, peak: 0.12, filter: { type: 'highpass', hz: 3100 } },
  ] },
  contained: { duration: 3.6, wet: 0.42, tones: [
    { hz: 79, endHz: 34, duration: 1.2, peak: 0.27 },
    { hz: 310, endHz: 240, duration: 0.45, peak: 0.1, wave: 'triangle' },
    { at: 0.48, hz: 261.63, endHz: 523.25, duration: 1.2, peak: 0.1, attack: 0.2 },
    { at: 1.6, hz: 523.25, duration: 1.7, peak: 0.09, attack: 0.025 },
    { at: 1.6, hz: 784, duration: 1.8, peak: 0.055, attack: 0.08 },
  ], noises: [
    { duration: 0.22, peak: 0.27, filter: { type: 'bandpass', hz: 820, q: 1.6 } },
    { at: 0.21, duration: 0.12, peak: 0.15, filter: { type: 'bandpass', hz: 1900, q: 3 } },
  ] },
};
