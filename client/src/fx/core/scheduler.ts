// One shared requestAnimationFrame loop for every FX surface on the page. Each surface declares a
// target fps; it is skipped while offscreen (IntersectionObserver) and the whole loop sleeps while
// the tab is hidden. Also collects lightweight perf stats (see getFxPerfStats).
import { isRenderLite } from './settings';

export interface FxTask {
  /** Element used for visibility tracking. */
  el: Element;
  /** Target frames per second (read every tick, may change). */
  fps(): number;
  render(perfNow: number): void;
}

interface Entry {
  task: FxTask;
  last: number;
  visible: boolean;
}

export interface FxPerfStats {
  surfaces: number;
  activeSurfaces: number;
  /** Mean JS work per animation frame spent in FX renders (ms). */
  avgWorkMs: number;
  /** 95th percentile of FX work per animation frame (ms). */
  p95WorkMs: number;
  maxWorkMs: number;
  /** Mean interval between animation frames (ms). */
  avgFrameIntervalMs: number;
  /** Renders per second summed over all surfaces. */
  rendersPerSec: number;
  samples: number;
}

const entries = new Set<Entry>();
const byEl = new Map<Element, Set<Entry>>();
let io: IntersectionObserver | null = null;
let rafId = 0;
let running = false;

const WORK_SAMPLES = 240;
const work: number[] = [];
const intervals: number[] = [];
let lastTick = 0;
let renderCount = 0;
let renderCountSince = 0;

function observer(): IntersectionObserver | null {
  if (io || typeof IntersectionObserver === 'undefined') return io;
  io = new IntersectionObserver(
    (records) => {
      for (const r of records) {
        const set = byEl.get(r.target);
        if (!set) continue;
        for (const e of set) e.visible = r.isIntersecting;
      }
    },
    { rootMargin: '64px' },
  );
  return io;
}

function tick(now: number) {
  rafId = 0;
  if (!running) return;
  if (lastTick) {
    intervals.push(now - lastTick);
    if (intervals.length > WORK_SAMPLES) intervals.shift();
  }
  lastTick = now;
  const t0 = performance.now();
  const lite = isRenderLite();
  for (const e of entries) {
    if (!e.visible) continue;
    // Keep repainting gameplay transitions in test builds; only reduce animation cadence.
    const fps = lite ? Math.min(e.task.fps(), 4) : e.task.fps();
    if (fps <= 0) continue;
    const minDt = 1000 / fps;
    if (now - e.last < minDt - 3) continue;
    // keep cadence stable without drifting
    e.last = lite ? now : now - Math.min(minDt, Math.max(0, now - e.last - minDt));
    try {
      e.task.render(now);
    } catch (err) {
      console.error('[fx] render failed', err);
    }
    renderCount++;
  }
  work.push(performance.now() - t0);
  if (work.length > WORK_SAMPLES) work.shift();
  schedule();
}

function schedule() {
  if (!running || rafId || entries.size === 0) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  rafId = requestAnimationFrame(tick);
}

function onVisibility() {
  if (document.hidden) {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    lastTick = 0;
  } else {
    schedule();
  }
}

let visHooked = false;

export function addFxTask(task: FxTask): () => void {
  const entry: Entry = { task, last: 0, visible: true };
  entries.add(entry);
  let set = byEl.get(task.el);
  if (!set) {
    set = new Set();
    byEl.set(task.el, set);
    observer()?.observe(task.el);
  }
  set.add(entry);
  if (!visHooked && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
    visHooked = true;
  }
  if (!running) {
    running = true;
    renderCountSince = performance.now();
    renderCount = 0;
  }
  schedule();
  return () => {
    entries.delete(entry);
    const s = byEl.get(task.el);
    if (s) {
      s.delete(entry);
      if (s.size === 0) {
        byEl.delete(task.el);
        io?.unobserve(task.el);
      }
    }
    if (entries.size === 0) {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      lastTick = 0;
    }
  };
}

export function getFxPerfStats(): FxPerfStats {
  const sorted = [...work].sort((a, b) => a - b);
  const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
  const secs = Math.max(0.001, (performance.now() - renderCountSince) / 1000);
  let active = 0;
  for (const e of entries) if (e.visible) active++;
  return {
    surfaces: entries.size,
    activeSurfaces: active,
    avgWorkMs: mean(work),
    p95WorkMs: sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0,
    maxWorkMs: sorted.length ? sorted[sorted.length - 1] : 0,
    avgFrameIntervalMs: mean(intervals),
    rendersPerSec: renderCount / secs,
    samples: work.length,
  };
}

export function resetFxPerfStats(): void {
  work.length = 0;
  intervals.length = 0;
  renderCount = 0;
  renderCountSince = performance.now();
}
