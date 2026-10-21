// Containment: compact standby card normally; a full console that takes over the monitor bank while the
// monster is held (trap hold timer, capture progress, power burn, struggle feedback).
import clsx from 'clsx';
import { nodeName } from '../../lib/data';
import { Bay, CFG, FOCUS, Kbd, P, camLabel, sec1, type RoomCtx } from './common';

export function ContainmentStandby({ ctx }: { ctx: RoomCtx }) {
  const { view } = ctx;
  const traps = view.traps.length;
  const live = view.traps.filter((x) => x.live).length;
  return (
    <Bay title="Containment" led="off" className="shrink-0" right={<span className="font-mono text-[10.5px] text-dim">standby</span>}>
      <div className="flex items-center gap-2 px-2.5 py-1.5 text-[11.5px] leading-snug text-mute">
        <span className="min-w-0 flex-1">
          Spring a trap, then hold the target {CFG.containment.captureMs / 1000}s to capture it.{' '}
          <span className="text-dim">
            {traps ? `${live}/${traps} trap${traps === 1 ? '' : 's'} live.` : 'No traps set.'}
          </span>
        </span>
        <button
          type="button"
          disabled
          data-testid="contain"
          className="h-6 shrink-0 border border-alert/40 bg-alert-dim/30 px-2 font-mono text-[10.5px] uppercase tracking-[0.1em] text-[#ffb3b8] disabled:opacity-40"
        >
          Engage
        </button>
      </div>
    </Bay>
  );
}

export function ContainmentConsole({ ctx, className }: { ctx: RoomCtx; className?: string }) {
  const { view, t } = ctx;
  const held = view.held!;
  const c = view.containment;
  const cam = ctx.camByNode.get(held.nodeId);
  const holdLeft = Math.max(0, held.until - t);
  const captureLeft = c ? (1 - c.progress) * CFG.containment.captureMs : CFG.containment.captureMs;
  const projected = view.power.drainPerSec + (c ? 0 : P.containmentDrainPerSec); // net drain with the field on
  const usable = view.power.value - (c ? 0 : P.containmentStartCost);
  const powerSecs = projected > 0 ? Math.max(0, usable) / projected : Infinity;
  const powerShort = powerSecs * 1000 < captureLeft;
  const canEngage = !ctx.spectator && !ctx.outage && view.power.value >= P.containmentStartCost;
  const struggling = held.struggling;
  return (
    <section
      className={clsx(
        'relative flex min-h-0 flex-col overflow-hidden border-2',
        c ? 'border-ok/70 bg-[#07140d]' : 'border-warn/80 bg-[#171006]',
        struggling && 'border-alert',
        className,
      )}
      data-testid="containment-console"
      aria-live="polite"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{
          background: `repeating-linear-gradient(135deg, transparent 0 14px, ${c ? 'rgba(62,196,122,.07)' : 'rgba(212,154,42,.08)'} 14px 28px)`,
        }}
      />
      <header className="relative flex h-8 shrink-0 items-center gap-2 border-b border-white/10 px-3">
        <span className={clsx('h-2 w-2 rounded-full', c ? 'bg-ok' : 'bg-warn', !ctx.reduced && 'fnab-blink')} />
        <h2 className="font-mono text-[12px] font-semibold uppercase tracking-[0.24em] text-bright">
          {c ? 'Containment field holding' : 'Target immobilised'}
        </h2>
        <span className="ml-1 truncate text-[12px] text-mute">at {nodeName(held.nodeId)}</span>
        {cam && (
          <button
            type="button"
            className={clsx('ml-auto h-5 border border-edge-hi px-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-mute hover:text-text', FOCUS)}
            onClick={() => ctx.selectCamera(cam.cameraId)}
          >
            {camLabel(ctx.camNo.get(cam.cameraId))}
          </button>
        )}
      </header>
      <div className="relative grid min-h-0 flex-1 grid-cols-[1.1fr_1fr] gap-4 p-3">
        <div className={clsx('flex min-w-0 flex-col justify-center gap-2', struggling && !ctx.reduced && 'fnab-shake')}>
          <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-mute">{c ? 'Capture in' : 'Trap releases in'}</div>
          <div
            className={clsx(
              'font-mono text-[54px] font-semibold leading-none tabular-nums',
              c ? 'text-[#a6f0c6]' : holdLeft < 3000 ? 'text-[#ff8a93]' : 'text-[#f3d28d]',
            )}
            data-testid="containment-timer"
          >
            {sec1(c ? captureLeft : holdLeft)}
            <span className="ml-1 text-[20px] text-dim">s</span>
          </div>
          <div className="h-3 w-full overflow-hidden border border-white/15 bg-black/60">
            <div
              className={clsx('h-full transition-[width] duration-200', c ? 'bg-ok' : 'bg-warn')}
              style={{ width: `${(c ? c.progress : holdLeft / CFG.traps.holdMs) * 100}%` }}
            />
          </div>
          <div className={clsx('font-mono text-[12px] font-semibold tracking-[0.16em]', struggling ? 'text-[#ff8a93]' : 'text-dim')}>
            {struggling ? (c ? 'TARGET STRUGGLING · RESTRAINTS STRAINING' : 'TARGET STRUGGLING · IT WILL BREAK FREE') : 'Target still'}
          </div>
        </div>
        <div className="flex min-w-0 flex-col justify-center gap-2">
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[11px] tabular-nums">
            <span className="text-mute">Field cost</span>
            <span className="text-right text-[#f3d28d]">
              {P.containmentStartCost}⚡ + {P.containmentDrainPerSec}/s
            </span>
            <span className="text-mute">Power</span>
            <span className={clsx('text-right', powerShort ? 'text-[#ff8a93]' : 'text-bright')}>{Math.floor(view.power.value)}</span>
            <span className="text-mute">{c ? 'Power lasts' : 'Would last'}</span>
            <span className={clsx('text-right', powerShort ? 'text-[#ff8a93]' : 'text-[#a6f0c6]')}>{isFinite(powerSecs) ? `${Math.floor(powerSecs)}s` : 'indefinitely'}</span>
          </div>
          {powerShort && (
            <div className={clsx('border border-alert/60 bg-alert-dim/50 px-2 py-1 font-mono text-[11px] text-[#ffc9cc]', !ctx.reduced && 'animate-pulse')}>
              {view.doors.some((d) => d.closed) ? 'Power runs out before capture. Open sealed doors to save power.' : 'Not enough power to hold it until capture.'}
            </div>
          )}
          {c ? (
            <button
              type="button"
              disabled={ctx.spectator}
              onClick={() => void ctx.act({ type: 'containment', engage: false })}
              data-testid="contain-release"
              className={clsx('h-8 border border-edge-hi bg-panel-2 font-mono text-[11px] uppercase tracking-[0.14em] text-mute hover:text-text disabled:opacity-40', FOCUS)}
            >
              Disengage <Kbd>H</Kbd>
            </button>
          ) : (
            <button
              type="button"
              disabled={!canEngage}
              onClick={() => void ctx.act({ type: 'containment', engage: true })}
              data-testid="contain"
              className={clsx(
                'flex h-12 items-center justify-center gap-2 border-2 border-alert bg-alert-dim font-mono text-[14px] font-semibold uppercase tracking-[0.2em] text-[#ffe1e3] shadow-[0_0_24px_rgba(200,50,58,.45)] hover:bg-[#7a1f25] disabled:opacity-40',
                !ctx.reduced && canEngage && 'fnab-alert-ring',
                FOCUS,
              )}
            >
              Engage containment <Kbd className="border-alert/60 bg-black/40 text-[#ffd0d4]">H</Kbd>
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
