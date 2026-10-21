// Shared bits for the defender control room: context object, small primitives, copy tables.
import clsx from 'clsx';
import type { ReactNode } from 'react';
import type { CameraView, DefenderAction, DefenderView, Headquarters } from '@fnab/shared';
import { DEFAULT_CONFIG } from '@fnab/shared';

export const CFG = DEFAULT_CONFIG;
export const P = DEFAULT_CONFIG.power;

/** Everything a control-room sub-panel needs, computed once per render in DefenderScreen. */
export interface RoomCtx {
  view: DefenderView;
  t: number;
  hq: Headquarters;
  spectator: boolean;
  prep: boolean;
  outage: boolean;
  reduced: boolean;
  act: (a: DefenderAction) => Promise<boolean>;
  camById: Map<string, CameraView>;
  camByNode: Map<string, CameraView>;
  /** Stable 1-based camera numbers (CAM 01 …). */
  camNo: Map<string, number>;
  selectCamera: (id: string) => void;
  selectNode: (id: string) => void;
}

export const FOCUS =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan';

export const secs = (ms: number) => Math.max(0, Math.ceil(ms / 1000));
export const sec1 = (ms: number) => Math.max(0, ms / 1000).toFixed(1);
export const camLabel = (n: number | undefined) => `CAM ${String(n ?? 0).padStart(2, '0')}`;

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={clsx(
        'inline-flex h-[15px] min-w-[15px] items-center justify-center border border-edge-hi bg-ink px-1 font-mono text-[9px] leading-none text-mute',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/** Panel header used across the control room: engraved label + optional status LED + right slot. */
export function Bay({
  title,
  led,
  right,
  children,
  className,
  bodyClass,
  testid,
}: {
  title: ReactNode;
  led?: 'ok' | 'warn' | 'alert' | 'cyan' | 'off';
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClass?: string;
  testid?: string;
}) {
  return (
    <section
      className={clsx('relative flex min-h-0 flex-col border border-edge bg-panel/95 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]', className)}
      data-testid={testid}
    >
      <header className="flex h-7 shrink-0 items-center gap-2 border-b border-edge bg-gradient-to-b from-panel-2 to-panel px-2.5">
        {led && <Led tone={led} />}
        <h2 className="min-w-0 flex-1 truncate font-mono text-[10.5px] font-medium uppercase tracking-[0.16em] text-mute">{title}</h2>
        {right}
      </header>
      <div className={clsx('min-h-0 flex-1', bodyClass)}>{children}</div>
    </section>
  );
}

export function Led({ tone, blink }: { tone: 'ok' | 'warn' | 'alert' | 'cyan' | 'off'; blink?: boolean }) {
  const c = {
    ok: 'bg-ok shadow-[0_0_6px_#3ec47a]',
    warn: 'bg-warn shadow-[0_0_6px_#d49a2a]',
    alert: 'bg-alert shadow-[0_0_7px_#c8323a]',
    cyan: 'bg-cyan shadow-[0_0_6px_#3bc6d6]',
    off: 'bg-edge-hi',
  }[tone];
  return <span aria-hidden className={clsx('inline-block h-[7px] w-[7px] shrink-0 rounded-full', c, blink && 'fnab-blink')} />;
}

export const THREAT_WORD = (v: number) =>
  v >= 0.99 ? 'Critical' : v >= 0.79 ? 'High' : v >= 0.59 ? 'Elevated' : v >= 0.39 ? 'Guarded' : v >= 0.19 ? 'Low' : 'Quiet';

export const PHASE_COPY: Record<DefenderView['phase'], { title: string; line: string; tone: 'cyan' | 'warn' | 'alert' }> = {
  preparation: { title: 'Preparation', line: 'Place sensors and traps before it arrives.', tone: 'cyan' },
  infiltration: {
    title: 'Infiltration',
    line: 'Something has entered the network. Doors, scans, lures and repairs are online.',
    tone: 'warn',
  },
  escalation: { title: 'Escalation', line: 'It moves faster now and will try the doors.', tone: 'warn' },
  final: { title: 'Final assault', line: 'It is coming for the doors. Hold until dawn.', tone: 'alert' },
};

/** Keyframes used by the control room (scoped names, injected once). */
export function DefenderStyles() {
  return (
    <style>{`
@keyframes fnab-blink { 0%, 55% { opacity: 1 } 56%, 100% { opacity: .25 } }
.fnab-blink { animation: fnab-blink 1.6s steps(1) infinite; }
@keyframes fnab-alert-ring { 0%, 100% { box-shadow: 0 0 0 1px #c8323a, 0 0 0 0 rgba(200,50,58,.0) } 50% { box-shadow: 0 0 0 2px #ff5a63, 0 0 14px 2px rgba(200,50,58,.55) } }
.fnab-alert-ring { animation: fnab-alert-ring 0.9s ease-in-out infinite; }
@keyframes fnab-vig { 0%, 100% { opacity: .55 } 50% { opacity: 1 } }
.fnab-vig { animation: fnab-vig 1.4s ease-in-out infinite; }
@keyframes fnab-shake { 0%,100% { transform: translate(0,0) } 20% { transform: translate(-2px,1px) } 40% { transform: translate(2px,-1px) } 60% { transform: translate(-1px,-1px) } 80% { transform: translate(1px,1px) } }
.fnab-shake { animation: fnab-shake .28s linear infinite; }
@keyframes fnab-announce { 0% { opacity: 0; letter-spacing: .6em } 12% { opacity: 1; letter-spacing: .32em } 82% { opacity: 1 } 100% { opacity: 0 } }
.fnab-announce { animation: fnab-announce 4.2s ease-out forwards; }
@keyframes fnab-sweep { 0% { transform: translateY(-100%) } 100% { transform: translateY(100%) } }
.fnab-sweep { animation: fnab-sweep 7s linear infinite; }
@keyframes fnab-tick-in { 0% { transform: translateY(6px); opacity: 0 } 100% { transform: none; opacity: 1 } }
.fnab-tick-in { animation: fnab-tick-in .25s ease-out; }
@media (prefers-reduced-motion: reduce) {
  .fnab-blink, .fnab-alert-ring, .fnab-vig, .fnab-shake, .fnab-sweep { animation: none !important; }
}
.fnab-reduced .fnab-blink, .fnab-reduced .fnab-vig, .fnab-reduced .fnab-shake, .fnab-reduced .fnab-sweep { animation: none !important; }
.fnab-reduced .fnab-alert-ring { animation: none !important; box-shadow: 0 0 0 2px #ff5a63; }
.fnab-reduced .fnab-announce { animation-duration: 4.2s; letter-spacing: .32em; }
`}</style>
  );
}
