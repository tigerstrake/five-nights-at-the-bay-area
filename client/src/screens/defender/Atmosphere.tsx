// Room-level atmosphere: threat vignette, phase announcements, alert ticker, blackout curtain, help sheet.
import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import type { DefenderView, GameEventKind, VisibleEvent } from '@fnab/shared';
import { nodeName } from '../../lib/data';
import { ago } from '../../lib/format';
import { CFG, FOCUS, Kbd, PHASE_COPY, sec1, type RoomCtx } from './common';

/** Red edge vignette tied to defender-visible threat; pulses at high threat / during a breach. */
export function ThreatVignette({ view, reduced }: { view: DefenderView; reduced: boolean }) {
  const breach = !!view.breach;
  const level = breach ? 1 : view.threat;
  if (level < 0.55 && !view.held) return null;
  const held = !!view.held && !breach;
  const a = held ? 0.35 : Math.min(0.75, (level - 0.45) * 1.2);
  const color = held ? '212,154,42' : '200,30,40';
  return (
    <div
      aria-hidden
      data-testid="threat-vignette"
      className={clsx('pointer-events-none fixed inset-0 z-30', !reduced && (breach || level >= 0.79) && 'fnab-vig')}
      style={{ boxShadow: `inset 0 0 ${breach ? 160 : 110}px ${breach ? 30 : 12}px rgba(${color},${a})` }}
    />
  );
}

/** Big centred phase card for a few seconds whenever the phase changes. */
export function PhaseAnnouncer({ phase }: { phase: DefenderView['phase'] }) {
  const [shown, setShown] = useState<{ phase: DefenderView['phase']; key: number } | null>(null);
  const prev = useRef(phase);
  useEffect(() => {
    if (prev.current !== phase) {
      setShown({ phase, key: Date.now() });
      const id = setTimeout(() => setShown(null), 4300);
      prev.current = phase;
      return () => clearTimeout(id);
    }
  }, [phase]);
  if (!shown) return null;
  const c = PHASE_COPY[shown.phase];
  return (
    <div key={shown.key} className="pointer-events-none fixed inset-x-0 top-[28%] z-[35] flex justify-center" data-testid="phase-announce" role="status">
      <div className="fnab-announce flex flex-col items-center bg-black/80 px-10 py-4 shadow-[0_0_60px_rgba(0,0,0,.9)]">
        <span className="font-mono text-[11px] uppercase tracking-[0.4em] text-dim">Phase change</span>
        <span
          className={clsx(
            'font-mono text-[34px] font-semibold uppercase',
            c.tone === 'alert' ? 'text-[#ff8a93]' : c.tone === 'warn' ? 'text-[#f3d28d]' : 'text-cyan',
          )}
        >
          {c.title}
        </span>
        <span className="mt-1 text-[13px] tracking-normal text-text">{c.line}</span>
      </div>
    </div>
  );
}

const TICKER_KINDS: GameEventKind[] = [
  'sighting', 'sensorPing', 'scan', 'decoyExposed', 'sabotage', 'cameraFailure', 'breachStart', 'doorJammed', 'doorBattered',
  'trapTriggered', 'powerLow', 'powerOut', 'powerRestored', 'struggle', 'freed', 'containmentBroken', 'repairDone', 'phase',
  'connectionLost', 'connectionRestored',
];

/** Single-line alert strip under the top bar: breach/hold status, else the newest notable event, else idle status. */
export function AlertTicker({ ctx, onLocate, onJump }: { ctx: RoomCtx; onLocate: (e: VisibleEvent) => void; onJump: () => void }) {
  const { view, t, hq } = ctx;
  const latest = [...view.events].reverse().find((e) => TICKER_KINDS.includes(e.kind));
  const fresh = latest && t - latest.t < 9000 ? latest : null;
  const last = view.lastKnown;
  let body: React.ReactNode;
  let tone: 'alert' | 'warn' | 'ok' | 'idle' = 'idle';
  if (view.breach) {
    tone = 'alert';
    const ap = hq.approaches.find((a) => a.id === view.breach!.approachId);
    body = (
      <>
        <span className="font-semibold tracking-[0.2em]">BREACH IN PROGRESS · {ap?.door}</span>
        <span className="h-1.5 w-40 overflow-hidden border border-alert/60 bg-ink">
          <span className="block h-full bg-alert" style={{ width: `${view.breach.progress * 100}%` }} />
        </span>
        <span>{view.breach.stalled ? 'Door holding' : 'Door open. Seal it now.'}</span>
      </>
    );
  } else if (ctx.outage) {
    tone = 'alert';
    body = <span className="font-semibold tracking-[0.2em]">POWER FAILURE · auxiliary restore in {sec1(view.power.outageUntil! - t)}s</span>;
  } else if (view.held) {
    tone = 'warn';
    body = (
      <span className="font-semibold tracking-[0.16em]">
        {view.containment ? 'CONTAINMENT HOLDING' : 'TARGET IMMOBILISED'} AT {nodeName(view.held.nodeId).toUpperCase()}
        {!view.containment && ' · ENGAGE CONTAINMENT (H)'}
      </span>
    );
  } else if (fresh) {
    tone = fresh.severity === 'alert' ? 'alert' : fresh.severity === 'good' ? 'ok' : 'warn';
    body = (
      <button key={fresh.id} type="button" onClick={() => onLocate(fresh)} className={clsx('fnab-tick-in flex items-center gap-2 hover:underline', FOCUS)}>
        <span className="tabular-nums text-dim">{ago(t - fresh.t)}</span>
        <span>{fresh.text}</span>
        {(fresh.nodeId || fresh.cameraId) && (
          <span className="flex items-center gap-1 text-dim">
            view <Kbd>V</Kbd>
          </span>
        )}
      </button>
    );
  } else if (ctx.prep) {
    body = <span>Preparation. Place sensors (S) and traps (T) on likely routes. Doors, scans and lures unlock at nightfall.</span>;
  } else {
    body = (
      <span className="flex items-center gap-2">
        <span className="fnab-blink">●</span>
        Monitoring {view.cameras.filter((c) => c.status === 'ok').length} cameras.
        {last ? (
          <button type="button" className={clsx('hover:underline', FOCUS)} onClick={onJump}>
            Last confirmed sighting {nodeName(last.nodeId)}, {ago(t - last.t)}.
          </button>
        ) : (
          ' No confirmed sightings.'
        )}
      </span>
    );
  }
  return (
    <div
      className={clsx(
        'flex h-7 shrink-0 items-center justify-center gap-3 overflow-hidden whitespace-nowrap border-b px-3 font-mono text-[11.5px]',
        tone === 'alert' && 'border-alert bg-alert-dim/70 text-[#ffd0d4]',
        tone === 'alert' && view.breach && !ctx.reduced && 'animate-pulse',
        tone === 'warn' && 'border-warn/60 bg-[#2c2008] text-[#f3d28d]',
        tone === 'ok' && 'border-ok/40 bg-ok-dim/40 text-[#b6f2cf]',
        tone === 'idle' && 'border-edge bg-ink text-mute',
      )}
      data-testid="alert-ticker"
      role="status"
      aria-live="polite"
    >
      {body}
    </div>
  );
}

/** Dims the room during a power outage; controls stay visible but inert. */
export function BlackoutCurtain({ ctx }: { ctx: RoomCtx }) {
  if (!ctx.outage) return null;
  const left = ctx.view.power.outageUntil! - ctx.t;
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-black/55" data-testid="blackout">
      <div className="flex flex-col items-center gap-2 border border-alert/50 bg-black/85 px-10 py-5">
        <span className={clsx('font-mono text-[28px] font-semibold tracking-[0.3em] text-[#ff8a93]', !ctx.reduced && 'animate-pulse')}>POWER FAILURE</span>
        <span className="text-[13px] text-text">Cameras dark. Doors forced open. Sensors offline.</span>
        <span className="font-mono text-[13px] tabular-nums text-mute">Auxiliary power in {sec1(left)}s</span>
        <span className="h-1.5 w-64 overflow-hidden border border-alert/50 bg-ink">
          <span className="block h-full bg-alert/80" style={{ width: `${(1 - left / CFG.power.outageMs) * 100}%` }} />
        </span>
      </div>
    </div>
  );
}

export const SHORTCUTS: Array<[string, string]> = [
  ['1–9', 'Show monitor 1–9 on the main screen'],
  ['← → ↑ ↓', 'Move through the monitor bank'],
  ['[  ]', 'Previous / next bank page'],
  ['O', 'Auto-cycle bank pages'],
  ['P', 'Pin / unpin the main camera'],
  ['R', 'Repair the main camera'],
  ['V', 'View the latest sighting'],
  ['Q W E', 'Seal / open doors 1–3'],
  ['H', 'Engage / disengage containment'],
  ['I S T C L', 'Map tool: inspect, sensor, trap, scan, lure'],
  ['Esc', 'Back to inspect / close this sheet'],
  ['?', 'Show this sheet'],
];

export function HelpSheet({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[45] flex items-center justify-center bg-black/70" onClick={onClose} data-testid="shortcut-help">
      <div role="dialog" aria-label="Keyboard shortcuts" className="w-[420px] max-w-[92vw] border border-edge-hi bg-panel p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-mono text-[12px] uppercase tracking-[0.2em] text-bright">Console shortcuts</h2>
          <button type="button" onClick={onClose} className={clsx('font-mono text-[11px] text-mute hover:text-text', FOCUS)}>
            Close <Kbd>Esc</Kbd>
          </button>
        </div>
        <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 text-[12.5px]">
          {SHORTCUTS.map(([k, d]) => (
            <div key={k} className="contents">
              <dt className="font-mono text-cyan">{k}</dt>
              <dd className="text-text">{d}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
