import clsx from 'clsx';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { audio } from '../audio';

export function Panel({
  title,
  right,
  children,
  className,
  bodyClass,
}: {
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClass?: string;
}) {
  return (
    <section className={clsx('flex min-h-0 flex-col border border-edge bg-panel/90', className)}>
      {title !== undefined && (
        <header className="flex items-center justify-between gap-2 border-b border-edge bg-panel-2/80 px-2.5 py-1.5">
          <h2 className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-mute">{title}</h2>
          {right}
        </header>
      )}
      <div className={clsx('min-h-0 flex-1', bodyClass)}>{children}</div>
    </section>
  );
}

type Tone = 'neutral' | 'alert' | 'ok' | 'cyan' | 'warn' | 'monster' | 'ghost';
const toneClass: Record<Tone, string> = {
  neutral: 'border-edge-hi bg-panel-2 text-text hover:border-mute hover:bg-[#1e2328]',
  alert: 'border-alert/70 bg-alert-dim/60 text-[#ffb3b8] hover:bg-alert-dim',
  ok: 'border-ok/60 bg-ok-dim/50 text-[#a6f0c6] hover:bg-ok-dim',
  cyan: 'border-cyan/60 bg-cyan-dim/50 text-[#b5f3fa] hover:bg-cyan-dim',
  warn: 'border-warn/60 bg-[#3a2a0c]/60 text-[#f3d28d] hover:bg-[#3a2a0c]',
  monster: 'border-monster/70 bg-[#2a0b12]/80 text-[#ffc2cc] hover:bg-[#3a0f19]',
  ghost: 'border-transparent bg-transparent text-mute hover:text-text hover:border-edge',
};

export function Button({
  tone = 'neutral',
  active,
  className,
  onClick,
  size = 'md',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; active?: boolean; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <button
      {...rest}
      onClick={(e) => {
        audio.play('uiClick', { volume: 0.5 });
        onClick?.(e);
      }}
      className={clsx(
        'select-none border font-mono uppercase tracking-[0.12em] transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        size === 'sm' && 'px-2 py-1 text-[10px]',
        size === 'md' && 'px-3 py-1.5 text-[11px]',
        size === 'lg' && 'px-5 py-2.5 text-xs',
        toneClass[tone],
        active && 'ring-1 ring-cyan ring-offset-1 ring-offset-void',
        className,
      )}
    />
  );
}

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 border px-1.5 py-px font-mono text-[9px] font-semibold uppercase tracking-[0.14em]',
        toneClass[tone],
        'hover:bg-inherit',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Meter({
  value,
  tone = 'cyan',
  className,
  label,
}: {
  value: number;
  tone?: 'cyan' | 'alert' | 'ok' | 'warn' | 'monster';
  className?: string;
  label?: string;
}) {
  const color = { cyan: 'bg-cyan', alert: 'bg-alert', ok: 'bg-ok', warn: 'bg-warn', monster: 'bg-monster-hi' }[tone];
  return (
    <div
      className={clsx('relative h-2 overflow-hidden border border-edge bg-ink', !/(^|\s)w-/.test(className ?? '') && 'w-full', className)}
      aria-label={label}
    >
      <div
        className={clsx('h-full transition-[width] duration-200', color)}
        style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }}
      />
    </div>
  );
}

export function Dot({ tone }: { tone: 'ok' | 'alert' | 'warn' | 'dim' | 'cyan' }) {
  const c = { ok: 'bg-ok', alert: 'bg-alert', warn: 'bg-warn', dim: 'bg-dim', cyan: 'bg-cyan' }[tone];
  return <span className={clsx('inline-block h-1.5 w-1.5 rounded-full', c, tone !== 'dim' && 'shadow-[0_0_6px_currentColor]')} />;
}

export function Label({ children }: { children: ReactNode }) {
  return <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-dim">{children}</div>;
}
