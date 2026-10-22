import { describe, expect, it } from 'vitest';
import { StallWatchdog, liveRetryDelay, type PlaybackSample, type WatchAction } from '../stallWatchdog';

const base = (over: Partial<PlaybackSample> = {}): PlaybackSample => ({
  now: 0,
  currentTime: 0,
  frames: 0,
  paused: false,
  readyState: 4,
  bufferedEnd: 20,
  seekableEnd: 30,
  hidden: false,
  ...over,
});

/** Drive a watchdog with 500 ms samples; `advance(t)` says whether the video moved in that step. */
function drive(wd: StallWatchdog, fromMs: number, toMs: number, advance: (t: number) => boolean, start = { ct: 0, frames: 0 }) {
  const actions: Array<{ t: number; a: WatchAction; advancing: boolean }> = [];
  let ct = start.ct;
  let frames = start.frames;
  let last = null as ReturnType<StallWatchdog['sample']> | null;
  for (let t = fromMs; t <= toMs; t += 500) {
    if (advance(t)) {
      ct += 0.5;
      frames += 12;
    }
    last = wd.sample(base({ now: t, currentTime: ct, frames, seekableEnd: ct + 15 }));
    actions.push({ t, a: last.action, advancing: last.advancing });
  }
  return { actions, last: last!, ct, frames };
}

describe('StallWatchdog', () => {
  it('is not LIVE until the video has actually advanced', () => {
    const wd = new StallWatchdog();
    expect(wd.sample(base({ now: 0 })).advancing).toBe(false);
    expect(wd.sample(base({ now: 500 })).advancing).toBe(false); // same currentTime, same frames
    const v = wd.sample(base({ now: 1000, currentTime: 0.5, frames: 12 }));
    expect(v.advancing).toBe(true);
    expect(v.started).toBe(true);
  });

  it('tolerates a short segment-boundary hiccup without flickering the badge', () => {
    const wd = new StallWatchdog();
    const r = drive(wd, 0, 20_000, (t) => !(t > 10_000 && t <= 12_000)); // 2 s hiccup
    expect(r.actions.filter((x) => x.t > 1000).every((x) => x.advancing)).toBe(true);
    expect(r.actions.every((x) => x.a === 'none')).toBe(true);
    expect(wd.stats.stalls).toBe(0);
  });

  it('drops LIVE after frozenMs of no progress and walks the recovery ladder once per episode', () => {
    const wd = new StallWatchdog();
    drive(wd, 0, 5_000, () => true);
    const r = drive(wd, 5_500, 110_000, () => false, { ct: 5, frames: 120 });
    const at = (a: WatchAction) => r.actions.filter((x) => x.a === a).map((x) => x.t);
    // Not advancing from 2.5 s of freeze on.
    expect(r.actions.find((x) => x.t === 8_000)!.advancing).toBe(false);
    expect(r.actions.find((x) => x.t === 7_000)!.advancing).toBe(true);
    // Ladder order and timing (stall began at the 5 s sample), each rung exactly once.
    expect(at('nudge')).toEqual([8_000]);
    expect(at('restart-load')).toEqual([11_000]);
    expect(at('recover-media')).toEqual([15_000]);
    // Then a source reload every 10 s (Caltrans outages last 30-110 s), and only then give up.
    expect(at('reload-source')).toEqual([20_000, 30_000, 40_000, 50_000, 60_000, 70_000, 80_000]);
    expect(at('fail')).toEqual([95_000]);
    expect(wd.stats.stalls).toBe(1);
  });

  it('a source reload keeps the stall clock running but credits no progress for the restart', () => {
    const wd = new StallWatchdog();
    drive(wd, 0, 5_000, () => true);
    drive(wd, 5_500, 20_000, () => false, { ct: 5, frames: 120 }); // reload fired at 20 s
    wd.resetBaseline();
    const v = wd.sample(base({ now: 20_500, currentTime: 0, frames: 0 }));
    expect(v.advancing).toBe(false);
    expect(v.stalledMs).toBe(15_500);
    // New stream plays: progress again.
    expect(wd.sample(base({ now: 21_000, currentTime: 0.5, frames: 12 })).advancing).toBe(true);
    expect(wd.stats.recoveries).toBe(1);
  });

  it('counts a recovery and resets the ladder when frames advance again', () => {
    const wd = new StallWatchdog();
    drive(wd, 0, 5_000, () => true);
    drive(wd, 5_500, 12_000, () => false, { ct: 5, frames: 120 }); // nudge + restart-load fired
    const back = wd.sample(base({ now: 12_500, currentTime: 5.5, frames: 132 }));
    expect(back.advancing).toBe(true);
    expect(wd.stats.recoveries).toBe(1);
    expect(wd.stats.stallDurations[0]).toBe(7_500);
    // A second stall starts the ladder from the first rung again.
    const r = drive(wd, 13_000, 17_000, () => false, { ct: 5.5, frames: 132 });
    expect(r.actions.some((x) => x.a === 'nudge')).toBe(true);
    expect(wd.stats.stalls).toBe(2);
  });

  it('counts decoded frames as progress even if currentTime reporting lags', () => {
    const wd = new StallWatchdog();
    wd.sample(base({ now: 0, currentTime: 1, frames: 10 }));
    expect(wd.sample(base({ now: 500, currentTime: 1, frames: 22 })).advancing).toBe(true);
  });

  it('never counts a hidden tab as a stall, and re-baselines on return', () => {
    const wd = new StallWatchdog();
    drive(wd, 0, 3_000, () => true);
    for (let t = 3_500; t <= 60_000; t += 500) expect(wd.sample(base({ now: t, currentTime: 3, frames: 72, hidden: true })).action).toBe('none');
    const v = wd.sample(base({ now: 60_500, currentTime: 3, frames: 72 }));
    expect(v.action).toBe('none');
    expect(wd.stats.stalls).toBe(0);
  });

  it('asks for play() when the browser paused the video', () => {
    const wd = new StallWatchdog();
    drive(wd, 0, 3_000, () => true);
    wd.sample(base({ now: 3_500, currentTime: 3, frames: 72, paused: true }));
    const v = wd.sample(base({ now: 4_500, currentTime: 3, frames: 72, paused: true }));
    expect(v.action).toBe('play');
  });

  it('jumps back to the live edge when far behind real time', () => {
    const wd = new StallWatchdog();
    wd.sample(base({ now: 0, currentTime: 10, frames: 0, seekableEnd: 100 }));
    const v = wd.sample(base({ now: 500, currentTime: 10.5, frames: 12, seekableEnd: 100 }));
    expect(v.action).toBe('seek-live');
    expect(v.advancing).toBe(true);
    // Rate-limited: not again immediately.
    expect(wd.sample(base({ now: 1000, currentTime: 11, frames: 24, seekableEnd: 100 })).action).toBe('none');
  });

  it('start phase: one reload after startReloadMs, then gives up at startTimeoutMs', () => {
    const wd = new StallWatchdog();
    const acts: WatchAction[] = [];
    for (let t = 0; t <= 21_000; t += 500) acts.push(wd.sample(base({ now: t })).action);
    expect(acts.filter((a) => a === 'reload-source')).toHaveLength(1);
    expect(acts.indexOf('reload-source')).toBe(20); // 10 s
    expect(acts.indexOf('fail')).toBe(40); // 20 s
  });

  it('a seek backwards (reload) is not mistaken for progress', () => {
    const wd = new StallWatchdog();
    drive(wd, 0, 3_000, () => true);
    const v = wd.sample(base({ now: 3_500, currentTime: 0.2, frames: 72 }));
    expect(v.advancing).toBe(true); // still within the hiccup grace, but…
    const later = wd.sample(base({ now: 6_500, currentTime: 0.2, frames: 72 }));
    expect(later.advancing).toBe(false); // …no progress was credited for the jump
  });
});

describe('liveRetryDelay', () => {
  it('backs off 30 s, 60 s, 120 s … capped at 5 min', () => {
    expect(liveRetryDelay(1)).toBe(30_000);
    expect(liveRetryDelay(2)).toBe(60_000);
    expect(liveRetryDelay(3)).toBe(120_000);
    expect(liveRetryDelay(10)).toBe(300_000);
    expect(liveRetryDelay(0)).toBe(30_000);
  });
});
