import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { audio } from '../audio';
import { isReducedMotion, setFxReducedMotion } from '../fx';
import { useGame } from '../state/store';

export function AudioControls() {
  const [, force] = useState(0);
  useEffect(() => audio.subscribe(() => force((x) => x + 1)), []);
  const muted = audio.isMuted();
  return (
    <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-mute">
      <button
        className="border border-edge px-1.5 py-0.5 hover:border-mute hover:text-text"
        onClick={() => {
          void audio.unlock();
          audio.setMuted(!muted);
        }}
        aria-label={muted ? 'Unmute' : 'Mute'}
        title={muted ? 'Unmute' : 'Mute'}
      >
        {muted ? 'SND OFF' : 'SND ON'}
      </button>
      <input
        type="range"
        min={0}
        max={100}
        value={Math.round(audio.getMasterVolume() * 100)}
        onChange={(e) => {
          void audio.unlock();
          audio.setMasterVolume(Number(e.target.value) / 100);
        }}
        className="h-1 w-20 cursor-pointer accent-cyan"
        aria-label="Master volume"
      />
      <FlashToggle />
    </div>
  );
}

const RM_KEY = 'fnab.reduceFlashing';
try {
  const saved = localStorage.getItem(RM_KEY);
  if (saved !== null) setFxReducedMotion(saved === '1');
} catch {
  /* storage unavailable */
}

/** "Reduce flashing" toggle (FX reduced motion), persisted per browser. */
export function FlashToggle() {
  const [on, setOn] = useState(() => isReducedMotion());
  return (
    <button
      className={clsx(
        'border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest',
        on ? 'border-cyan text-cyan' : 'border-edge text-mute hover:border-mute hover:text-text',
      )}
      onClick={() => {
        const v = !on;
        setFxReducedMotion(v);
        setOn(v);
        try {
          localStorage.setItem(RM_KEY, v ? '1' : '0');
        } catch {
          /* ignore */
        }
      }}
      title="Reduce flashing and screen shake"
      aria-pressed={on}
    >
      {on ? 'FLASH LOW' : 'FLASH STD'}
    </button>
  );
}

export function ConnectionBadge() {
  const c = useGame((s) => s.connection);
  const rtt = useGame((s) => s.rtt);
  return (
    <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest">
      <span className={clsx('h-1.5 w-1.5 rounded-full', c === 'online' ? 'bg-ok' : 'animate-pulse bg-warn')} />
      <span className={c === 'online' ? 'text-mute' : 'text-warn'}>
        {c === 'online' ? `LINK ${Math.round(rtt)}ms` : c === 'reconnecting' ? 'RECONNECTING…' : 'CONNECTING…'}
      </span>
    </div>
  );
}

export function Toasts() {
  const toasts = useGame((s) => s.toasts);
  const dismiss = useGame((s) => s.dismiss);
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-1.5">
      {toasts.map((t) => (
        <button
          key={t.id}
          onClick={() => dismiss(t.id)}
          className={clsx(
            'pointer-events-auto border px-3 py-1.5 font-mono text-[11px] tracking-wide shadow-lg backdrop-blur',
            t.kind === 'error' && 'border-alert/70 bg-alert-dim/80 text-[#ffc9cc]',
            t.kind === 'warn' && 'border-warn/60 bg-[#2c2008]/90 text-[#f3d28d]',
            t.kind === 'good' && 'border-ok/60 bg-ok-dim/80 text-[#b6f2cf]',
            t.kind === 'info' && 'border-edge-hi bg-panel-2/90 text-text',
          )}
        >
          {t.text}
        </button>
      ))}
    </div>
  );
}

/** Subtle full-screen CRT scanline + vignette layer. */
export function ScreenGrain() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-40"
      style={{
        background:
          'repeating-linear-gradient(0deg, rgba(255,255,255,0.018) 0px, rgba(255,255,255,0.018) 1px, transparent 1px, transparent 3px), radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.55) 100%)',
      }}
    />
  );
}
