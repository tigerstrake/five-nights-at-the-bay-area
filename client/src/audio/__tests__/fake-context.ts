import { vi } from 'vitest';

export class FakeParam {
  value = 0;
  readonly events: { method: string; value?: number; time: number }[] = [];
  setValueAtTime(value: number, time: number): this { return this.record('set', value, time); }
  linearRampToValueAtTime(value: number, time: number): this { return this.record('linear', value, time); }
  exponentialRampToValueAtTime(value: number, time: number): this { return this.record('exponential', value, time); }
  setTargetAtTime(value: number, time: number, _constant: number): this { return this.record('target', value, time); }
  cancelScheduledValues(time: number): this { this.events.push({ method: 'cancel', time }); return this; }
  cancelAndHoldAtTime(time: number): this { this.events.push({ method: 'hold', time }); return this; }
  private record(method: string, value: number, time: number): this {
    this.value = value;
    this.events.push({ method, value, time });
    return this;
  }
}

export class FakeNode {
  readonly gain = new FakeParam();
  readonly frequency = new FakeParam();
  readonly detune = new FakeParam();
  readonly Q = new FakeParam();
  readonly pan = new FakeParam();
  readonly offset = new FakeParam();
  readonly threshold = new FakeParam();
  readonly knee = new FakeParam();
  readonly ratio = new FakeParam();
  readonly attack = new FakeParam();
  readonly release = new FakeParam();
  readonly connections = new Set<FakeNode | FakeParam>();
  disconnected = false;
  type = 'sine';
  buffer: FakeBuffer | null = null;
  loop = false;
  curve: Float32Array | null = null;
  oversample = 'none';
  constructor(readonly kind: string) {}
  connect<T extends FakeNode | FakeParam>(target: T): T { this.connections.add(target); return target; }
  disconnect(): void { this.connections.clear(); this.disconnected = true; }
}

export class FakeSource extends FakeNode {
  started = false;
  ended = false;
  stopTime = Infinity;
  onended: (() => void) | null = null;
  constructor(kind: string, private readonly context: FakeAudioContext) { super(kind); }
  start(_when = 0, _offset = 0): void { this.started = true; }
  stop(when = this.context.currentTime): void { this.stopTime = when; }
}

export class FakeBuffer {
  readonly duration: number;
  private readonly channels: Float32Array[];
  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) {
    this.duration = length / sampleRate;
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  getChannelData(channel: number): Float32Array { return this.channels[channel]; }
}

/** Only graph plumbing and audio-clock source completion are modeled, never DSP. */
export class FakeAudioContext {
  currentTime = 0;
  readonly sampleRate = 8000;
  state: AudioContextState = 'suspended';
  readonly nodes: FakeNode[] = [];
  readonly destination = this.node('destination');
  readonly resume = vi.fn(async () => { this.state = 'running'; });
  readonly close = vi.fn(async () => { this.state = 'closed'; });
  readonly decodeAudioData = vi.fn(async () => this.createBuffer(1, this.sampleRate, this.sampleRate));
  createGain = (): FakeNode => this.node('gain');
  createStereoPanner = (): FakeNode => this.node('panner');
  createDynamicsCompressor = (): FakeNode => this.node('compressor');
  createConvolver = (): FakeNode => this.node('convolver');
  createBiquadFilter = (): FakeNode => this.node('filter');
  createWaveShaper = (): FakeNode => this.node('shaper');
  createOscillator = (): FakeSource => this.source('oscillator');
  createBufferSource = (): FakeSource => this.source('buffer');
  createConstantSource = (): FakeSource => this.source('sentinel');
  createBuffer(channels: number, length: number, sampleRate: number): FakeBuffer { return new FakeBuffer(channels, length, sampleRate); }
  private node(kind: string): FakeNode {
    const node = new FakeNode(kind);
    this.nodes.push(node);
    return node;
  }
  private source(kind: string): FakeSource {
    const source = new FakeSource(kind, this);
    this.nodes.push(source);
    return source;
  }
  get starts(): number { return this.nodes.filter(node => node instanceof FakeSource && node.started).length; }
  get live(): number { return this.nodes.filter(node => !node.disconnected).length; }
  advance(seconds: number): void {
    this.currentTime += seconds;
    for (const node of this.nodes) {
      if (node instanceof FakeSource && !node.ended && node.stopTime <= this.currentTime) {
        node.ended = true;
        node.onended?.();
      }
    }
  }
  asContext(): AudioContext { return this as unknown as AudioContext; }
}
