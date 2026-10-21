import { MIX } from './constants';
import { clamp } from './state';
import type { BusName } from './types';

const SYNTH = {
  minHz: 10, maxHz: 18000, defaultAttack: 0.005, stopPadding: 0.03,
  brownLeak: 0.985, brownStep: 0.055, brownScale: 3.5,
  impulseLowpass: 0.42, impulsePredelay: 0.019,
  shaperPoints: 1024, dryReduction: 0.35,
  defaultFilterQ: 1, nyquistRatio: 0.45, impulseChannels: 2,
} as const;

export interface Bus { input: GainNode; reverb: ConvolverNode }
export interface AudioGraph {
  master: GainNode;
  buses: Record<BusName, Bus>;
  dispose(): void;
}

export function smooth(param: AudioParam, value: number, time: number, seconds: number): void {
  if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(time);
  else {
    param.cancelScheduledValues(time);
    param.setValueAtTime(param.value, time);
  }
  param.setTargetAtTime(value, time, seconds);
}

export class SynthResources {
  readonly white: AudioBuffer;
  readonly brown: AudioBuffer;
  readonly impulse: AudioBuffer;
  constructor(readonly context: AudioContext) {
    const noiseLength = Math.ceil(context.sampleRate * MIX.noiseSeconds);
    this.white = context.createBuffer(1, noiseLength, context.sampleRate);
    this.brown = context.createBuffer(1, noiseLength, context.sampleRate);
    const white = this.white.getChannelData(0);
    const brown = this.brown.getChannelData(0);
    let previous = 0;
    for (let i = 0; i < noiseLength; i++) {
      const random = Math.random() * 2 - 1;
      white[i] = random;
      previous = previous * SYNTH.brownLeak + random * SYNTH.brownStep;
      brown[i] = Math.tanh(previous * SYNTH.brownScale);
    }
    const impulseLength = Math.ceil(context.sampleRate * MIX.impulseSeconds);
    this.impulse = context.createBuffer(SYNTH.impulseChannels, impulseLength, context.sampleRate);
    const predelay = Math.floor(context.sampleRate * SYNTH.impulsePredelay);
    for (let channel = 0; channel < this.impulse.numberOfChannels; channel++) {
      const data = this.impulse.getChannelData(channel);
      let low = 0;
      for (let i = predelay; i < impulseLength; i++) {
        low += SYNTH.impulseLowpass * (Math.random() * 2 - 1 - low);
        data[i] = low * Math.pow(1 - i / impulseLength, MIX.impulseDecay);
      }
    }
  }
}

/** Identity below -3 dBFS, then a smooth knee that tops out near -0.6 dBFS at full scale. */
function ceilingCurve(): Float32Array<ArrayBuffer> {
  const knee = 0.708;
  const curve = new Float32Array(SYNTH.shaperPoints * 2 + 1);
  for (let i = 0; i < curve.length; i++) {
    const x = i * 2 / (curve.length - 1) - 1;
    const magnitude = Math.abs(x);
    curve[i] = Math.sign(x) * (magnitude <= knee ? magnitude : knee + (1 - knee) * Math.tanh((magnitude - knee) / (1 - knee)));
  }
  return curve;
}

export function createGraph(context: AudioContext, resources: SynthResources, volume: number): AudioGraph {
  const nodes: AudioNode[] = [];
  const master = context.createGain();
  master.gain.value = volume;
  // Chain: master -> DC/sub high-pass -> air low-pass -> glue compressor -> fast limiter
  // -> soft ceiling. The ceiling guarantees no clipping however many voices overlap.
  const highpass = context.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = MIX.masterHighpassHz;
  highpass.Q.value = 0.5;
  const lowpass = context.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = Math.min(MIX.masterLowpassHz, context.sampleRate * SYNTH.nyquistRatio);
  lowpass.Q.value = 0.6;
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = MIX.compressorThreshold;
  compressor.knee.value = MIX.compressorKnee;
  compressor.ratio.value = MIX.compressorRatio;
  compressor.attack.value = MIX.compressorAttack;
  compressor.release.value = MIX.compressorRelease;
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = MIX.limiterThreshold;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = MIX.limiterRelease;
  const ceiling = context.createWaveShaper();
  ceiling.curve = ceilingCurve();
  ceiling.oversample = '2x';
  master.connect(highpass);
  highpass.connect(lowpass);
  lowpass.connect(compressor);
  compressor.connect(limiter);
  limiter.connect(ceiling);
  ceiling.connect(context.destination);
  nodes.push(master, highpass, lowpass, compressor, limiter, ceiling);
  const bus = (name: BusName): Bus => {
    const input = context.createGain();
    input.gain.value = MIX[name];
    input.connect(master);
    const reverb = context.createConvolver();
    reverb.buffer = resources.impulse;
    reverb.connect(input);
    nodes.push(input, reverb);
    return { input, reverb };
  };
  const buses = { ambience: bus('ambience'), sfx: bus('sfx'), ui: bus('ui'), stinger: bus('stinger') };
  return { master, buses, dispose: () => nodes.forEach(node => node.disconnect()) };
}

interface Shape {
  at?: number;
  duration: number;
  peak: number;
  attack?: number;
  release?: number;
  filter?: { type: BiquadFilterType; hz: number; endHz?: number; q?: number };
  drive?: number;
}
export interface Tone extends Shape {
  hz: number;
  endHz?: number;
  wave?: OscillatorType;
  detune?: number;
}
export interface Noise extends Shape { color?: 'white' | 'brown' }

/** A voice owns every node it allocates. An audio-clock sentinel cleans it up even
 * when the tab throttles timers; sustained beds use the same path when faded out. */
export class Voice {
  readonly level: GainNode;
  private readonly trimNode: GainNode;
  readonly start: number;
  private readonly nodes = new Set<AudioNode>();
  private readonly sources = new Set<AudioScheduledSourceNode>();
  private readonly sentinel: ConstantSourceNode;
  private finished = false;
  private stopping = false;

  constructor(
    readonly resources: SynthResources,
    bus: Bus,
    duration: number,
    volume = 1,
    pan = 0,
    wet = 0,
    private readonly onFinish: (voice: Voice) => void = () => {},
  ) {
    const context = resources.context;
    this.start = context.currentTime + MIX.sourceLead;
    this.level = this.own(context.createGain());
    this.level.gain.value = clamp(volume);
    const panner = this.own(context.createStereoPanner());
    panner.pan.value = clamp(pan, -1, 1);
    const dry = this.own(context.createGain());
    dry.gain.value = 1 - clamp(wet) * SYNTH.dryReduction;
    this.trimNode = this.own(context.createGain());
    this.level.connect(this.trimNode);
    this.trimNode.connect(panner);
    panner.connect(dry);
    dry.connect(bus.input);
    if (wet > 0) {
      const send = this.own(context.createGain());
      send.gain.value = clamp(wet);
      panner.connect(send);
      send.connect(bus.reverb);
    }
    this.sentinel = this.own(context.createConstantSource());
    this.sentinel.offset.value = 0;
    this.sentinel.connect(this.level);
    this.sentinel.onended = () => this.dispose();
    this.sentinel.start(this.start);
    if (Number.isFinite(duration)) this.sentinel.stop(this.start + duration + SYNTH.stopPadding);
  }

  /** Static level trim in dB (may boost; `level` itself is clamped to 0-1). */
  setTrim(db: number): void { this.trimNode.gain.value = Math.pow(10, db / 20); }

  get context(): AudioContext { return this.resources.context; }
  own<T extends AudioNode>(node: T): T { this.nodes.add(node); return node; }

  gain(value: number, destination: AudioNode = this.level): GainNode {
    const node = this.own(this.context.createGain());
    node.gain.value = value;
    node.connect(destination);
    return node;
  }

  filter(type: BiquadFilterType, hz: number, q: number = SYNTH.defaultFilterQ, destination: AudioNode = this.level): BiquadFilterNode {
    const node = this.own(this.context.createBiquadFilter());
    node.type = type;
    node.frequency.value = this.frequency(hz);
    node.Q.value = q;
    node.connect(destination);
    return node;
  }

  private frequency(hz: number): number {
    return clamp(hz, SYNTH.minHz, Math.min(SYNTH.maxHz, this.context.sampleRate * SYNTH.nyquistRatio));
  }

  oscillator(hz: number, wave: OscillatorType, destination: AudioNode | AudioParam, at = 0, duration = Infinity): OscillatorNode {
    const node = this.own(this.context.createOscillator());
    node.type = wave;
    node.frequency.value = hz;
    if ('setValueAtTime' in destination) node.connect(destination);
    else node.connect(destination);
    this.schedule(node, at, duration);
    return node;
  }

  noiseLoop(color: 'white' | 'brown', destination: AudioNode, at = 0, duration = Infinity): AudioBufferSourceNode {
    const node = this.own(this.context.createBufferSource());
    node.buffer = this.resources[color];
    node.loop = true;
    node.connect(destination);
    this.sources.add(node);
    node.start(this.start + at, Math.random() * MIX.noiseSeconds);
    if (Number.isFinite(duration)) node.stop(this.start + at + duration);
    return node;
  }

  private schedule(node: AudioScheduledSourceNode, at: number, duration: number): void {
    this.sources.add(node);
    node.start(this.start + at);
    if (Number.isFinite(duration)) node.stop(this.start + at + duration);
  }

  private envelope(shape: Shape): AudioNode {
    const at = this.start + (shape.at ?? 0);
    const attack = Math.min(shape.attack ?? SYNTH.defaultAttack, shape.duration / 2);
    const release = Math.min(shape.release ?? shape.duration - attack, shape.duration - attack);
    const envelope = this.own(this.context.createGain());
    envelope.gain.setValueAtTime(0, at);
    envelope.gain.linearRampToValueAtTime(Math.max(MIX.minimumGain, shape.peak), at + attack);
    envelope.gain.setValueAtTime(Math.max(MIX.minimumGain, shape.peak), at + shape.duration - release);
    envelope.gain.exponentialRampToValueAtTime(MIX.minimumGain, at + shape.duration);
    envelope.connect(this.level);
    let input: AudioNode = envelope;
    if (shape.drive) {
      const shaper = this.own(this.context.createWaveShaper());
      const curve = new Float32Array(SYNTH.shaperPoints);
      const amount = shape.drive;
      for (let i = 0; i < curve.length; i++) {
        const x = i * 2 / (curve.length - 1) - 1;
        curve[i] = Math.tanh(x * amount) / Math.tanh(amount);
      }
      shaper.curve = curve;
      shaper.oversample = '2x';
      shaper.connect(input);
      input = shaper;
    }
    if (shape.filter) {
      const spec = shape.filter;
      const filter = this.filter(spec.type, spec.hz, spec.q, input);
      if (spec.endHz !== undefined) {
        filter.frequency.setValueAtTime(this.frequency(spec.hz), at);
        filter.frequency.exponentialRampToValueAtTime(this.frequency(spec.endHz), at + shape.duration);
      }
      input = filter;
    }
    return input;
  }

  tone(spec: Tone): OscillatorNode {
    const node = this.oscillator(this.frequency(spec.hz), spec.wave ?? 'sine', this.envelope(spec), spec.at ?? 0, spec.duration);
    if (spec.detune !== undefined) node.detune.value = spec.detune;
    if (spec.endHz !== undefined) {
      node.frequency.setValueAtTime(this.frequency(spec.hz), this.start + (spec.at ?? 0));
      node.frequency.exponentialRampToValueAtTime(this.frequency(spec.endHz), this.start + (spec.at ?? 0) + spec.duration);
    }
    return node;
  }

  noise(spec: Noise): AudioBufferSourceNode {
    return this.noiseLoop(spec.color ?? 'white', this.envelope(spec), spec.at ?? 0, spec.duration);
  }

  sample(buffer: AudioBuffer, loop = false): void {
    const source = this.own(this.context.createBufferSource());
    source.buffer = buffer;
    source.loop = loop;
    source.connect(this.level);
    this.schedule(source, 0, loop ? Infinity : buffer.duration);
  }

  fadeIn(seconds: number, level = 1): void {
    this.level.gain.value = 0;
    this.level.gain.setValueAtTime(0, this.start);
    this.level.gain.linearRampToValueAtTime(level, this.start + seconds);
  }

  stop(seconds: number = MIX.voiceFade): void {
    if (this.finished || this.stopping) return;
    this.stopping = true;
    const now = this.context.currentTime;
    const end = Math.max(now, this.start) + seconds;
    // cancelAndHold preserves an in-flight crossfade when a rapid room change steals it.
    if (typeof this.level.gain.cancelAndHoldAtTime === 'function') this.level.gain.cancelAndHoldAtTime(now);
    else {
      this.level.gain.cancelScheduledValues(now);
      this.level.gain.setValueAtTime(this.level.gain.value, now);
    }
    this.level.gain.linearRampToValueAtTime(0, end);
    this.sentinel.stop(end + SYNTH.stopPadding);
  }

  dispose(): void {
    if (this.finished) return;
    this.finished = true;
    this.sentinel.onended = null;
    for (const source of this.sources) {
      try { source.stop(); } catch { /* Already ended. */ }
    }
    try { this.sentinel.stop(); } catch { /* Already ended. */ }
    for (const node of this.nodes) node.disconnect();
    this.sources.clear();
    this.nodes.clear();
    this.onFinish(this);
  }
}
