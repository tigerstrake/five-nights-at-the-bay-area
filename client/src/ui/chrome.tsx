import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { audio } from '../audio';
import { isReducedMotion, setFxReducedMotion } from '../fx';
import { useGame } from '../state/store';

/** Re-render whenever volume / mute change. */
function useAudioSettings() {
  const [, force] = useState(0);
  useEffect(() => audio.subscribe(() => force((x) => x + 1)), []);
  return { muted: audio.isMuted(), volume: audio.getMasterVolume() };
}

/** Poll until the Web Audio context has been unlocked by a gesture. */
export function useAudioUnlocked(): boolean {
  const [on, setOn] = useState(() => audio.isUnlocked());
  useEffect(() => {
    if (on) return;
    const id = setInterval(() => audio.isUnlocked() && setOn(true), 400);
    return () => clearInterval(id);
  }, [on]);
  return on;
}

export function AudioControls() {
  const { muted, volume } = useAudioSettings();
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
        value={Math.round(volume * 100)}
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

const flashListeners = new Set<() => void>();
function setReduceFlashing(v: boolean) {
  setFxReducedMotion(v);
  try {
    localStorage.setItem(RM_KEY, v ? '1' : '0');
  } catch {
    /* ignore */
  }
  flashListeners.forEach((l) => l());
}
/** Current "reduce flashing" preference (FX reduced motion), reactive. */
export function useReduceFlashing(): boolean {
  const [on, setOn] = useState(() => isReducedMotion());
  useEffect(() => {
    const l = () => setOn(isReducedMotion());
    flashListeners.add(l);
    return () => void flashListeners.delete(l);
  }, []);
  return on;
}

/** "Reduce flashing" toggle (FX reduced motion), persisted per browser. */
export function FlashToggle() {
  const on = useReduceFlashing();
  return (
    <button
      className={clsx(
        'border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest',
        on ? 'border-cyan text-cyan' : 'border-edge text-mute hover:border-mute hover:text-text',
      )}
      onClick={() => setReduceFlashing(!on)}
      title="Reduce flashing and screen shake"
      aria-pressed={on}
    >
      {on ? 'FLASH LOW' : 'FLASH STD'}
    </button>
  );
}

function Switch({ on, onChange, label, hint, testId }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string; testId?: string }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      data-testid={testId}
      className="flex w-full items-center justify-between gap-4 py-1.5 text-left"
    >
      <span>
        <span className="block text-[13px] text-text">{label}</span>
        {hint && <span className="block text-[11px] text-dim">{hint}</span>}
      </span>
      <span className={clsx('relative h-4 w-8 shrink-0 border transition-colors', on ? 'border-cyan/70 bg-cyan-dim' : 'border-edge-hi bg-ink')}>
        <span className={clsx('absolute top-0.5 h-2.5 w-2.5 transition-[left]', on ? 'left-[17px] bg-cyan' : 'left-0.5 bg-dim')} />
      </span>
    </button>
  );
}

function GearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" />
    </svg>
  );
}
function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <path d="M4 9h4l5-4v14l-5-4H4z" />
      {muted ? <path d="M16.5 9.5l5 5M21.5 9.5l-5 5" /> : <path d="M16.5 8.5a5 5 0 010 7M19 6a8.5 8.5 0 010 12" />}
    </svg>
  );
}

/**
 * Compact settings control: a mute toggle plus a popover with master volume, mute and reduced flashing.
 * Use this in dense bars; `AudioControls` remains for inline layouts.
 */
export function SettingsMenu({
  align = 'right',
  className,
  labelClassName,
}: {
  align?: 'left' | 'right';
  className?: string;
  /** Classes for the "Settings" word (e.g. hide it on narrow bars). */
  labelClassName?: string;
}) {
  const { muted, volume } = useAudioSettings();
  const flash = useReduceFlashing();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const btn = 'flex h-7 items-center gap-1.5 border border-edge bg-black/30 px-2 text-mute transition-colors hover:border-edge-hi hover:text-text';
  return (
    <div ref={ref} className={clsx('relative flex items-center gap-1', className)}>
      <button
        className={btn}
        onClick={() => {
          void audio.unlock();
          audio.setMuted(!muted);
        }}
        aria-label={muted ? 'Unmute sound' : 'Mute sound'}
        title={muted ? 'Unmute sound' : 'Mute sound'}
        data-testid="mute-toggle"
      >
        <SpeakerIcon muted={muted} />
      </button>
      <button
        className={clsx(btn, open && 'border-edge-hi text-text')}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="settings-open"
      >
        <GearIcon />
        <span className={clsx('font-mono text-[10px] uppercase tracking-[0.14em]', labelClassName)}>Settings</span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Settings"
          className={clsx(
            'absolute top-full z-[60] mt-2 w-72 border border-edge-hi bg-panel/98 p-4 shadow-[0_18px_50px_rgba(0,0,0,0.6)] backdrop-blur motion-safe:animate-rise',
            align === 'right' ? 'right-0' : 'left-0',
          )}
          data-testid="settings-panel"
        >
          <div className="mb-3 font-display text-sm font-bold text-bright">Settings</div>
          <label className="block">
            <span className="flex items-baseline justify-between text-[13px] text-text">
              Master volume <span className="font-mono text-[11px] tabular-nums text-mute">{Math.round(volume * 100)}%</span>
            </span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(volume * 100)}
              onChange={(e) => {
                void audio.unlock();
                audio.setMasterVolume(Number(e.target.value) / 100);
              }}
              onPointerUp={() => audio.play('uiClick')}
              className="mt-2 h-1 w-full cursor-pointer accent-cyan"
              aria-label="Master volume"
            />
          </label>
          <div className="mt-3 divide-y divide-edge border-t border-edge">
            <Switch
              on={muted}
              onChange={(v) => {
                void audio.unlock();
                audio.setMuted(v);
              }}
              label="Mute all sound"
            />
            <Switch on={flash} onChange={setReduceFlashing} label="Reduce flashing" hint="Softer static, no screen shake or strobes" testId="reduce-flashing" />
          </div>
        </div>
      )}
    </div>
  );
}

export function ConnectionBadge({ textClassName }: { textClassName?: string } = {}) {
  const c = useGame((s) => s.connection);
  const rtt = useGame((s) => s.rtt);
  return (
    <div
      className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest"
      title={c === 'online' ? `Connected to the game server · ${Math.round(rtt)} ms` : 'Connection to the game server'}
    >
      <span className={clsx('h-1.5 w-1.5 rounded-full', c === 'online' ? 'bg-ok' : 'animate-pulse bg-warn')} />
      <span className={clsx(c === 'online' ? 'text-mute' : 'text-warn', c === 'online' && textClassName)}>
        {c === 'online' ? `LINK ${Math.round(rtt)}ms` : c === 'reconnecting' ? 'RECONNECTING…' : 'CONNECTING…'}
      </span>
    </div>
  );
}

/** Full-width banner while the socket is down. Appears after a short grace so blips don't flash it. */
export function ReconnectBanner() {
  const c = useGame((s) => s.connection);
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (c === 'online') return setShow(false);
    const id = setTimeout(() => setShow(true), c === 'reconnecting' ? 600 : 2500);
    return () => clearTimeout(id);
  }, [c]);
  if (!show) return null;
  return (
    <div
      role="status"
      aria-live="assertive"
      className="pointer-events-none fixed inset-x-0 top-0 z-[70] flex justify-center"
      data-testid="reconnect-banner"
    >
      <div className="relative mt-2 flex items-center gap-3 overflow-hidden border border-warn/60 bg-[#191208]/95 px-4 py-2 shadow-[0_10px_40px_rgba(0,0,0,0.6)]">
        <div aria-hidden className="fnab-noise absolute inset-0 opacity-[0.12]" />
        <span className="relative h-2 w-2 rounded-full bg-warn motion-safe:animate-blink" />
        <span className="relative font-mono text-[11px] uppercase tracking-[0.22em] text-[#f3d28d]">
          {c === 'reconnecting' ? 'Signal lost — reconnecting' : 'Contacting server'}
        </span>
        <span className="relative text-[11px] text-mute">Your seat is held for 60 seconds.</span>
      </div>
    </div>
  );
}

/** Tasteful prompt until the first gesture unlocks audio (browsers block sound before that). */
export function AudioUnlockPrompt({ className }: { className?: string }) {
  const unlocked = useAudioUnlocked();
  const { muted } = useAudioSettings();
  const [dismissed, setDismissed] = useState(false);
  if (unlocked || dismissed || muted) return null;
  return (
    <div
      className={clsx('pointer-events-auto flex items-center gap-3 border border-edge bg-black/70 py-1.5 pl-3 pr-1.5 backdrop-blur', className)}
      data-testid="audio-unlock"
    >
      <SpeakerIcon muted />
      <span className="text-[12px] text-mute">Sound is off until you interact.</span>
      <button
        className="border border-edge-hi px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-text hover:border-cyan hover:text-cyan"
        onClick={() => {
          void audio.unlock().then(() => audio.play('uiClick'));
        }}
      >
        Enable sound
      </button>
      <button className="px-1 text-dim hover:text-text" aria-label="Dismiss" onClick={() => setDismissed(true)}>
        ×
      </button>
    </div>
  );
}

const TOAST_TAG: Record<'info' | 'warn' | 'error' | 'good', string> = { info: 'NOTE', warn: 'WARN', error: 'ERR', good: 'OK' };

export function Toasts() {
  const toasts = useGame((s) => s.toasts);
  const dismiss = useGame((s) => s.dismiss);
  return (
    <div
      className="pointer-events-none fixed bottom-4 left-1/2 z-[80] flex w-[min(560px,calc(100vw-32px))] -translate-x-1/2 flex-col items-center gap-1.5"
      aria-live="polite"
      data-testid="toasts"
    >
      {toasts.map((t) => (
        <button
          key={t.id}
          onClick={() => dismiss(t.id)}
          className={clsx(
            'pointer-events-auto flex max-w-full items-center gap-2.5 border py-1.5 pl-2 pr-3 text-left text-[12px] shadow-[0_10px_30px_rgba(0,0,0,0.55)] backdrop-blur motion-safe:animate-rise',
            t.kind === 'error' && 'border-alert/70 bg-[#220b0d]/95 text-[#ffc9cc]',
            t.kind === 'warn' && 'border-warn/60 bg-[#211807]/95 text-[#f3d28d]',
            t.kind === 'good' && 'border-ok/60 bg-[#0b1f15]/95 text-[#b6f2cf]',
            t.kind === 'info' && 'border-edge-hi bg-panel-2/95 text-text',
          )}
        >
          <span
            className={clsx(
              'shrink-0 border px-1 font-mono text-[9px] font-semibold tracking-[0.14em]',
              t.kind === 'error' && 'border-alert/60 text-alert',
              t.kind === 'warn' && 'border-warn/60 text-warn',
              t.kind === 'good' && 'border-ok/60 text-ok',
              t.kind === 'info' && 'border-edge-hi text-mute',
            )}
          >
            {TOAST_TAG[t.kind]}
          </span>
          <span className="min-w-0">{t.text}</span>
        </button>
      ))}
    </div>
  );
}

/** Subtle full-screen CRT scanline + vignette + grain layer. */
export function ScreenGrain() {
  const reduced = useReduceFlashing();
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-40"
        style={{
          background:
            'repeating-linear-gradient(0deg, rgba(255,255,255,0.018) 0px, rgba(255,255,255,0.018) 1px, transparent 1px, transparent 3px), radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.55) 100%)',
        }}
      />
      <div aria-hidden className={clsx('pointer-events-none fixed inset-0 z-40 opacity-[0.035] mix-blend-screen', !reduced && 'fnab-noise')} />
    </>
  );
}
