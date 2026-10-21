import clsx from 'clsx';
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';
import { audio } from '../audio';

/**
 * Design-token primitives shared by every screen. Props are a contract with the game screens:
 * extend additively, never rename or remove.
 */

export type PanelTone = 'default' | 'team' | 'defender' | 'monster';

export function Panel({
  title,
  right,
  children,
  className,
  bodyClass,
  tone = 'default',
  brackets,
  testId,
}: {
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClass?: string;
  /** Frame accent. `team` follows the root data-team theme. */
  tone?: PanelTone;
  /** Viewfinder corner brackets in the accent colour. */
  brackets?: boolean;
  testId?: string;
}) {
  const edge = {
    default: 'border-edge',
    team: 'border-edge',
    defender: 'border-cyan/25',
    monster: 'border-blood/50',
  }[tone];
  const head = {
    default: 'border-edge bg-panel-2/80 text-mute',
    team: 'border-edge bg-panel-2/80 text-mute',
    defender: 'border-cyan/20 bg-[#0d1a1d]/85 text-[#9fd9e0]',
    monster: 'border-blood/40 bg-[#1a0a0d]/85 text-bone',
  }[tone];
  const bracket = { default: undefined, team: undefined, defender: 'var(--color-cyan)', monster: 'var(--color-blood-hi)' }[tone];
  return (
    <section
      className={clsx(
        'flex min-h-0 flex-col border',
        tone === 'monster' ? 'bg-[#0d0809]/92' : 'bg-panel/90',
        edge,
        brackets && 'fnab-brackets',
        className,
      )}
      style={bracket ? ({ '--bracket': bracket } as CSSProperties) : undefined}
      data-testid={testId}
    >
      {title !== undefined && (
        <header className={clsx('flex items-center justify-between gap-2 border-b px-2.5 py-1.5', head)}>
          <h2 className="font-mono text-[10px] font-medium uppercase tracking-[0.18em]">{title}</h2>
          {right}
        </header>
      )}
      <div className={clsx('min-h-0 flex-1', bodyClass)}>{children}</div>
    </section>
  );
}

export type Tone = 'neutral' | 'alert' | 'ok' | 'cyan' | 'warn' | 'monster' | 'ghost' | 'bone' | 'blood' | 'team';
const toneClass: Record<Tone, string> = {
  neutral: 'border-edge-hi bg-panel-2 text-text hover:border-mute hover:bg-[#1e2328]',
  alert: 'border-alert/70 bg-alert-dim/60 text-[#ffb3b8] hover:bg-alert-dim',
  ok: 'border-ok/60 bg-ok-dim/50 text-[#a6f0c6] hover:bg-ok-dim',
  cyan: 'border-cyan/60 bg-cyan-dim/50 text-[#b5f3fa] hover:bg-cyan-dim',
  warn: 'border-warn/60 bg-[#3a2a0c]/60 text-[#f3d28d] hover:bg-[#3a2a0c]',
  monster: 'border-monster/70 bg-[#2a0b12]/80 text-[#ffc2cc] hover:bg-[#3a0f19]',
  ghost: 'border-transparent bg-transparent text-mute hover:text-text hover:border-edge',
  bone: 'border-bone/50 bg-[#1b1814]/80 text-bone hover:border-bone/80 hover:bg-[#25211b]',
  blood: 'border-blood-hi/70 bg-blood/40 text-[#f1d6d0] hover:bg-blood/60',
  team: 'border-team/60 bg-team-dim/60 text-bright hover:bg-team-dim',
};

export function Button({
  tone = 'neutral',
  active,
  className,
  onClick,
  size = 'md',
  silent,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: Tone;
  active?: boolean;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Skip the UI click sound (for controls that play their own). */
  silent?: boolean;
}) {
  return (
    <button
      {...rest}
      onClick={(e) => {
        if (!silent) audio.play('uiClick', { volume: 0.5 });
        onClick?.(e);
      }}
      className={clsx(
        'select-none border font-mono uppercase tracking-[0.12em] transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        size === 'sm' && 'px-2 py-1 text-[10px]',
        size === 'md' && 'px-3 py-1.5 text-[11px]',
        size === 'lg' && 'px-5 py-2.5 text-xs',
        size === 'xl' && 'px-6 py-3.5 text-[13px] tracking-[0.18em]',
        toneClass[tone],
        active && 'ring-1 ring-cyan ring-offset-1 ring-offset-void',
        className,
      )}
    />
  );
}

export function Badge({
  tone = 'neutral',
  children,
  className,
  pulse,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  /** Blinking status lamp before the label. */
  pulse?: boolean;
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 border px-1.5 py-px font-mono text-[9px] font-semibold uppercase tracking-[0.14em]',
        toneClass[tone],
        'hover:bg-inherit',
        className,
      )}
    >
      {pulse && <span className="h-1 w-1 rounded-full bg-current motion-safe:animate-pulse" />}
      {children}
    </span>
  );
}

export type MeterTone = 'cyan' | 'alert' | 'ok' | 'warn' | 'monster' | 'bone' | 'blood' | 'team';
export function Meter({
  value,
  tone = 'cyan',
  className,
  label,
  segments,
}: {
  value: number;
  tone?: MeterTone;
  className?: string;
  label?: string;
  /** Draw the bar as N discrete cells (power-cell look). */
  segments?: number;
}) {
  const color = {
    cyan: 'bg-cyan',
    alert: 'bg-alert',
    ok: 'bg-ok',
    warn: 'bg-warn',
    monster: 'bg-monster-hi',
    bone: 'bg-bone',
    blood: 'bg-blood-hi',
    team: 'bg-team',
  }[tone];
  const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return (
    <div
      className={clsx('relative h-2 overflow-hidden border border-edge bg-ink', !/(^|\s)w-/.test(className ?? '') && 'w-full', className)}
      aria-label={label}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={Math.round(v * 100) / 100}
    >
      <div className={clsx('h-full transition-[width] duration-200', color)} style={{ width: `${v * 100}%` }} />
      {segments && segments > 1 && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background: `repeating-linear-gradient(90deg, transparent 0, transparent calc(${100 / segments}% - 2px), var(--color-ink) calc(${100 / segments}% - 2px), var(--color-ink) ${100 / segments}%)`,
          }}
        />
      )}
    </div>
  );
}

export function Dot({ tone }: { tone: 'ok' | 'alert' | 'warn' | 'dim' | 'cyan' | 'blood' | 'bone' }) {
  const c = { ok: 'bg-ok', alert: 'bg-alert', warn: 'bg-warn', dim: 'bg-dim', cyan: 'bg-cyan', blood: 'bg-blood-hi', bone: 'bg-bone' }[tone];
  return <span className={clsx('inline-block h-1.5 w-1.5 shrink-0 rounded-full', c, tone !== 'dim' && 'shadow-[0_0_6px_currentColor]')} />;
}

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx('font-mono text-[9px] uppercase tracking-[0.2em] text-dim', className)}>{children}</div>;
}

/** Keyboard key cap. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex min-w-[1.4em] items-center justify-center border border-edge-hi border-b-2 bg-panel-2 px-1 font-mono text-[10px] leading-[1.5] text-text">
      {children}
    </kbd>
  );
}

/** A labelled readout: big value, small caption. */
export function Stat({
  label,
  value,
  sub,
  tone = 'neutral',
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'neutral' | 'cyan' | 'ok' | 'warn' | 'alert' | 'bone' | 'blood';
  className?: string;
}) {
  const vc = {
    neutral: 'text-bright',
    cyan: 'text-cyan',
    ok: 'text-ok',
    warn: 'text-warn',
    alert: 'text-[#ff8a93]',
    bone: 'text-bone',
    blood: 'text-[#e36b74]',
  }[tone];
  return (
    <div className={clsx('flex min-w-0 flex-col gap-0.5', className)}>
      <div className="truncate text-[11px] text-mute">{label}</div>
      <div className={clsx('font-mono text-xl font-semibold tabular-nums leading-tight', vc)}>{value}</div>
      {sub !== undefined && <div className="truncate font-mono text-[10px] text-dim">{sub}</div>}
    </div>
  );
}

/** Segmented choice control (radio group semantics). */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  disabled,
  tone = 'cyan',
  className,
  testIdPrefix,
}: {
  options: Array<{ value: T; label: ReactNode; title?: string }>;
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
  tone?: 'cyan' | 'bone' | 'team';
  className?: string;
  testIdPrefix?: string;
}) {
  const on = { cyan: 'bg-cyan-dim text-[#c9f6fb] border-cyan/60', bone: 'bg-[#25211b] text-bone border-bone/60', team: 'bg-team-dim text-bright border-team/60' }[tone];
  return (
    <div role="radiogroup" className={clsx('flex border border-edge bg-ink', className)}>
      {options.map((o) => {
        const sel = o.value === value;
        return (
          <button
            key={String(o.value)}
            role="radio"
            aria-checked={sel}
            disabled={disabled}
            title={o.title}
            data-testid={testIdPrefix ? `${testIdPrefix}-${o.value}` : undefined}
            onClick={() => {
              if (sel) return;
              audio.play('uiClick', { volume: 0.5 });
              onChange(o.value);
            }}
            className={clsx(
              'flex-1 border px-2 py-1.5 font-mono text-[11px] tabular-nums transition-colors disabled:cursor-not-allowed',
              sel ? on : 'border-transparent text-mute hover:text-text',
              disabled && !sel && 'opacity-40',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
