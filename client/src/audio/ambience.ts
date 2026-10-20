import { ATMOSPHERE as A, MIX } from './constants';
import { renderCreature } from './sfx';
import { clamp } from './state';
import { smooth, Voice, type AudioGraph, type SynthResources } from './synthesis';
import type { AmbienceKind } from './types';

const ROOM = {
  lobby: { hz: [65.41, 98, 130.97], level: 0.018, cutoff: 440, lfoHz: 0.057, depth: 0.009 },
  defender: { mains: [50, 60, 120], level: 0.012, fan: 0.025, fanHz: 670, fanQ: 0.45 },
  monster: { hz: [28.5, 42.8], level: 0.025, breath: 0.044, breathHz: 410, breathQ: 2.2, lfoHz: 0.19, depth: 0.019 },
  fadeSeconds: MIX.roomFade, lowpassQ: 0.7,
  tensionWet: 0.24, lobbyWet: 0.55, roomWet: 0.18,
  droneMinimum: 0.2, droneTension: 1.5, bedMinimum: 0.2, bedTension: 1.8,
  whineBandwidth: 5, whineLfoHz: 0.31, whineDetune: 13,
  beatMinimum: 0.015, beatTension: 0.13, beatSecondLevel: 0.55, beatEndHz: 29,
  beatWet: 0.05,
  crackleDuration: 0.09, crackleLevel: 0.07, crackleHz: 3300, crackleWet: 0.08,
  relayDuration: 0.045, relayLevel: 0.036, relayHz: 1700, relayQ: 2, relayWet: 0.08,
  distantMinimum: 0.12, distantLevel: 0.44, distantWet: 0.85, distantWetReduction: 0.68,
  distantPan: 0.85, nearThreshold: 0.75, nearChance: 0.38,
  distantMinInterval: 3.5, distantVoiceSeconds: 2.8, heartbeatVoiceSeconds: 0.55,
} as const;

export type AmbientTransient = (duration: number, volume: number, pan: number, wet: number) => Voice | undefined;

export class AmbienceDirector {
  private kind: AmbienceKind = 'none';
  private tension = 0;
  private readonly beds = new Set<Voice>();
  private currentBed?: Voice;
  private readonly tensionVoice: Voice;
  private readonly drone: GainNode;
  private readonly noise: GainNode;
  private readonly whine: GainNode;
  private nextBeat = 0;
  private nextCrackle = 0;
  private nextDistant = 0;
  private nextRelay = 0;
  private override?: AudioBuffer;

  constructor(private readonly resources: SynthResources, private readonly graph: AudioGraph, private readonly transient: AmbientTransient) {
    const context = resources.context;
    graph.buses.ambience.input.gain.value = 0;
    const voice = new Voice(resources, graph.buses.ambience, Infinity, 1, 0, ROOM.tensionWet);
    this.tensionVoice = voice;
    this.drone = voice.gain(A.droneGain * ROOM.droneMinimum);
    const lowpass = voice.filter('lowpass', A.bedCutoff, ROOM.lowpassQ, this.drone);
    A.droneHz.forEach((hz, index) => voice.oscillator(hz, index === 2 ? 'triangle' : 'sine', lowpass));
    const slow = voice.gain(A.droneLfoDepth, this.drone);
    // Amplitude modulation is applied to the gain parameter, not mixed into the signal.
    slow.disconnect();
    slow.connect(this.drone.gain);
    voice.oscillator(A.droneLfoHz, 'sine', slow);
    this.noise = voice.gain(A.bedGain * ROOM.bedMinimum);
    const noiseFilter = voice.filter('lowpass', A.bedCutoff, ROOM.lowpassQ, this.noise);
    voice.noiseLoop('brown', noiseFilter);
    this.whine = voice.gain(0);
    const whineFilter = voice.filter('bandpass', A.whineHz, ROOM.whineBandwidth, this.whine);
    const whineOsc = voice.oscillator(A.whineHz, 'sine', whineFilter);
    const vibrato = voice.own(context.createGain());
    vibrato.gain.value = ROOM.whineDetune;
    vibrato.connect(whineOsc.detune);
    voice.oscillator(ROOM.whineLfoHz, 'sine', vibrato);
  }

  setTension(level: number): void {
    const previous = this.tension;
    this.tension = clamp(level);
    const now = this.resources.context.currentTime;
    if (this.tension > previous) this.nextDistant = Math.min(this.nextDistant, now + this.distantDelay());
    smooth(this.drone.gain, A.droneGain * (ROOM.droneMinimum + ROOM.droneTension * this.tension), now, MIX.tensionSmoothing);
    smooth(this.noise.gain, A.bedGain * (ROOM.bedMinimum + ROOM.bedTension * this.tension), now, MIX.tensionSmoothing);
    const high = clamp((this.tension - A.whineThreshold) / (1 - A.whineThreshold));
    smooth(this.whine.gain, A.whineGain * high * high, now, MIX.tensionSmoothing);
  }

  setKind(kind: AmbienceKind, override?: AudioBuffer): void {
    if (kind === this.kind && override === this.override) return;
    this.kind = kind;
    this.override = override;
    const context = this.resources.context;
    const now = context.currentTime;
    smooth(this.graph.buses.ambience.input.gain, kind === 'none' ? 0 : MIX.ambience, now, ROOM.fadeSeconds / 3);
    this.currentBed?.stop(ROOM.fadeSeconds);
    this.currentBed = undefined;
    // Bound rapid selector changes, including beds still releasing.
    if (this.beds.size >= MIX.maximumRoomBeds) this.beds.values().next().value?.dispose();
    if (kind === 'none') return;
    const voice = new Voice(this.resources, this.graph.buses.ambience, Infinity, 1, 0, kind === 'lobby' ? ROOM.lobbyWet : ROOM.roomWet,
      finished => this.beds.delete(finished));
    this.beds.add(voice);
    this.currentBed = voice;
    voice.fadeIn(ROOM.fadeSeconds);
    if (override) voice.sample(override, true);
    else this.renderBed(voice, kind);
    this.nextDistant = now + this.distantDelay();
    this.nextBeat = now;
    this.nextRelay = now + A.relayBaseSeconds;
  }

  private renderBed(voice: Voice, kind: Exclude<AmbienceKind, 'none'>): void {
    if (kind === 'lobby') {
      const c = ROOM.lobby;
      for (const hz of c.hz) {
        const level = voice.gain(c.level);
        const filter = voice.filter('lowpass', c.cutoff, ROOM.lowpassQ, level);
        voice.oscillator(hz, 'triangle', filter);
        const mod = voice.own(voice.context.createGain());
        mod.gain.value = c.depth;
        mod.connect(level.gain);
        voice.oscillator(c.lfoHz * (hz / c.hz[0]), 'sine', mod);
      }
    } else if (kind === 'defender') {
      const c = ROOM.defender;
      for (const hz of c.mains) voice.oscillator(hz, 'sine', voice.gain(c.level));
      const fanFilter = voice.filter('bandpass', c.fanHz, c.fanQ, voice.gain(c.fan));
      voice.noiseLoop('brown', fanFilter);
    } else {
      const c = ROOM.monster;
      for (const hz of c.hz) voice.oscillator(hz, 'sine', voice.gain(c.level));
      const breath = voice.gain(c.breath);
      const filter = voice.filter('bandpass', c.breathHz, c.breathQ, breath);
      voice.noiseLoop('brown', filter);
      const mod = voice.own(voice.context.createGain());
      mod.gain.value = c.depth;
      mod.connect(breath.gain);
      voice.oscillator(c.lfoHz, 'sine', mod);
    }
  }

  tick(): void {
    const context = this.resources.context;
    if (this.kind === 'none' || context.state !== 'running') return;
    const now = context.currentTime;
    const t = this.tension;
    // Schedule only the next pulse, so resume never produces a backlog of sounds.
    if (now >= this.nextBeat) {
      this.nextBeat = now + 1 / (A.heartbeatBaseHz + A.heartbeatRiseHz * t);
      if (t > 0) {
        const voice = this.transient(ROOM.heartbeatVoiceSeconds, 1, 0, ROOM.beatWet);
        const peak = ROOM.beatMinimum + ROOM.beatTension * t * t;
        voice?.tone({ hz: A.heartbeatTone, endHz: ROOM.beatEndHz, duration: A.heartbeatDuration, peak });
        voice?.tone({ at: A.heartbeatDoubleDelay, hz: A.heartbeatTone, endHz: ROOM.beatEndHz, duration: A.heartbeatDuration, peak: peak * ROOM.beatSecondLevel });
      }
    }
    if (now >= this.nextCrackle && t > A.crackleThreshold) {
      this.nextCrackle = now + A.crackleBaseSeconds + Math.random() * A.crackleRandomSeconds * (1 - t / 2);
      const voice = this.transient(ROOM.crackleDuration, t, Math.random() * 2 - 1, ROOM.crackleWet);
      voice?.noise({ duration: ROOM.crackleDuration, peak: ROOM.crackleLevel, filter: { type: 'highpass', hz: ROOM.crackleHz } });
    }
    if (this.kind === 'defender' && now >= this.nextRelay) {
      this.nextRelay = now + A.relayBaseSeconds + Math.random() * A.relayRandomSeconds;
      this.transient(ROOM.relayDuration, 1, Math.random() - 0.5, ROOM.relayWet)?.noise({ duration: ROOM.relayDuration, peak: ROOM.relayLevel,
        filter: { type: 'bandpass', hz: ROOM.relayHz, q: ROOM.relayQ } });
    }
    if (now >= this.nextDistant) {
      this.nextDistant = now + this.distantDelay();
      const variant = t > ROOM.nearThreshold && Math.random() < ROOM.nearChance ? 'near' : 'distant';
      const voice = this.transient(ROOM.distantVoiceSeconds, ROOM.distantMinimum + ROOM.distantLevel * t,
        (Math.random() * 2 - 1) * ROOM.distantPan, ROOM.distantWet - ROOM.distantWetReduction * t);
      if (voice) renderCreature(voice, variant);
    }
  }

  private distantDelay(): number {
    return Math.max(ROOM.distantMinInterval, A.distantBaseSeconds - A.distantTensionReduction * this.tension)
      + Math.random() * A.distantRandomSeconds * (1 - this.tension);
  }

  dispose(): void {
    this.tensionVoice.dispose();
    for (const voice of this.beds) voice.dispose();
    this.beds.clear();
  }
}
