// HQ security systems: shared power bus and the three approach doors.
import clsx from 'clsx';
import { nodeName } from '../../lib/data';
import { Bay, CFG, FOCUS, Kbd, Led, P, camLabel, sec1, secs, type RoomCtx } from './common';

export function PowerPanel({ ctx }: { ctx: RoomCtx }) {
  const { view, t, outage } = ctx;
  const pw = view.power;
  const frac = pw.value / pw.max;
  const low = pw.value <= P.lowThreshold;
  const doorsShut = view.doors.filter((d) => d.closed).length;
  const sensorsLive = view.sensors.filter((s) => !s.disabledUntil || s.disabledUntil <= t).length;
  const lines: Array<{ label: string; v: number }> = [];
  if (!outage && !ctx.prep) {
    if (doorsShut) lines.push({ label: `Doors ×${doorsShut}`, v: -doorsShut * P.doorDrainPerSec });
    if (sensorsLive) lines.push({ label: `Sensors ×${sensorsLive}`, v: -sensorsLive * P.sensorUpkeepPerSec });
    if (view.containment) lines.push({ label: 'Containment', v: -P.containmentDrainPerSec });
    lines.push({ label: 'Generator', v: P.regenPerSec });
  }
  const net = -pw.drainPerSec; // server-authoritative net (+ = charging)
  const eta =
    outage || ctx.prep
      ? null
      : net < -0.005
        ? { text: `Empty in ${fmtDur(pw.value / -net)}`, bad: pw.value / -net < 30 }
        : pw.value >= pw.max - 0.5
          ? { text: 'Fully charged', bad: false }
          : { text: `Full in ${fmtDur((pw.max - pw.value) / Math.max(net, 0.001))}`, bad: false };
  const restoreLeft = outage ? pw.outageUntil! - t : 0;

  return (
    <Bay
      title="Power bus"
      led={outage ? 'alert' : low ? 'warn' : 'ok'}
      right={
        <span className={clsx('font-mono text-[10.5px] tabular-nums', net < 0 ? 'text-[#f3d28d]' : 'text-[#9fe8bf]')}>
          {ctx.prep ? 'idle' : outage ? '—' : `${net >= 0 ? '+' : '−'}${Math.abs(net).toFixed(2)}/s`}
        </span>
      }
      className="shrink-0"
      testid="power-panel"
    >
      <div className="flex flex-col gap-1.5 px-2.5 py-2">
        {outage ? (
          <div className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between">
              <span className={clsx('font-mono text-[15px] font-semibold tracking-[0.2em] text-[#ff8a93]', !ctx.reduced && 'animate-pulse')}>BLACKOUT</span>
              <span className="font-mono text-[11px] tabular-nums text-mute">aux in {sec1(restoreLeft)}s</span>
            </div>
            <div className="h-2 overflow-hidden border border-alert/50 bg-ink">
              <div className="h-full bg-alert/70" style={{ width: `${(1 - restoreLeft / CFG.power.outageMs) * 100}%` }} />
            </div>
            <div className="text-[11px] leading-snug text-mute">Cameras dark, doors forced open, sensors dead. Restores to {P.restoreTo}.</div>
          </div>
        ) : (
          <>
            <div className="flex items-end gap-2">
              <span className={clsx('font-mono text-[26px] font-semibold leading-none tabular-nums', low ? 'text-[#f3d28d]' : 'text-bright')}>
                {Math.floor(pw.value)}
              </span>
              <span className="pb-0.5 font-mono text-[11px] text-dim">/ {pw.max}</span>
              {eta && <span className={clsx('ml-auto pb-0.5 font-mono text-[11px]', eta.bad ? 'text-[#ff8a93]' : 'text-mute')}>{eta.text}</span>}
            </div>
            {/* segmented bus meter with low-power mark */}
            <div className="relative flex h-3 gap-px" aria-label={`Power ${Math.round(frac * 100)} percent`}>
              {Array.from({ length: 20 }, (_, i) => {
                const on = frac * 20 > i + 0.15;
                return (
                  <span
                    key={i}
                    className={clsx(
                      'flex-1',
                      on ? (low ? 'bg-warn' : frac < 0.5 ? 'bg-cyan' : 'bg-ok') : 'bg-ink',
                      'border border-black/40',
                    )}
                  />
                );
              })}
              <span className="absolute -bottom-0.5 -top-0.5 w-px bg-[#f3d28d]" style={{ left: `${(P.lowThreshold / pw.max) * 100}%` }} title="Low-power warning" />
            </div>
            {lines.length > 0 && (
              <div className="grid grid-cols-2 gap-x-3 font-mono text-[10.5px] tabular-nums">
                {lines.map((l) => (
                  <div key={l.label} className="flex justify-between">
                    <span className="text-mute">{l.label}</span>
                    <span className={l.v < 0 ? 'text-[#f3d28d]' : 'text-[#9fe8bf]'}>
                      {l.v < 0 ? '−' : '+'}
                      {Math.abs(l.v).toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {ctx.prep && <div className="text-[11px] text-mute">No drain during preparation.</div>}
          </>
        )}
      </div>
    </Bay>
  );
}

function fmtDur(s: number): string {
  if (!isFinite(s)) return '—';
  if (s < 60) return `${Math.ceil(s)}s`;
  return `${Math.floor(s / 60)}m ${String(Math.ceil(s % 60)).padStart(2, '0')}s`;
}

const DOOR_KEYS = ['Q', 'W', 'E'];

export function DoorsPanel({ ctx }: { ctx: RoomCtx }) {
  const { view, t, hq } = ctx;
  const sealed = view.doors.filter((d) => d.closed).length;
  return (
    <Bay
      title={<span title={hq.name}>HQ doors</span>}
      led={view.breach ? 'alert' : view.doors.some((d) => d.battering) ? 'alert' : sealed ? 'cyan' : 'off'}
      right={<span className="font-mono text-[10.5px] text-dim">{sealed}/3 sealed</span>}
      className="shrink-0"
    >
      <div className="flex flex-col divide-y divide-edge" data-testid="doors">
        {view.doors.map((d, i) => {
          const ap = hq.approaches.find((a) => a.id === d.approachId)!;
          const jammed = d.jammedUntil !== null && d.jammedUntil > t;
          const cam = ctx.camByNode.get(ap.fromNode);
          const breach = view.breach?.approachId === d.approachId ? view.breach : null;
          const heatRate = CFG.doors.heatPerSecClosed + (d.battering ? CFG.doors.heatPerSecBattered : 0);
          const jamIn = d.closed ? (1 - d.heat) / heatRate : null;
          const locked = ctx.spectator || ctx.outage || ctx.prep || jammed;
          return (
            <div
              key={d.approachId}
              className={clsx('relative px-2.5 py-1.5', (d.battering || breach) && 'bg-alert-dim/35', breach && !breach.stalled && !ctx.reduced && 'animate-pulse')}
            >
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5">
                    <span className="truncate text-[12.5px] font-semibold text-bright">{ap.door}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => cam && ctx.selectCamera(cam.cameraId)}
                    className={clsx('flex max-w-full items-center gap-1 truncate text-left font-mono text-[10.5px] text-mute hover:text-text', FOCUS)}
                    title="Show the approach camera"
                  >
                    {cam && <Led tone={cam.status === 'ok' ? 'ok' : cam.status === 'repairing' ? 'cyan' : 'alert'} />}
                    <span className="truncate">
                      {cam ? camLabel(ctx.camNo.get(cam.cameraId)) : ''} {nodeName(ap.fromNode)}
                    </span>
                  </button>
                </div>
                <DoorSwitch
                  closed={d.closed}
                  jammed={jammed}
                  disabled={locked}
                  hotkey={DOOR_KEYS[i]!}
                  onClick={() => void ctx.act({ type: 'door', approachId: d.approachId, closed: !d.closed })}
                  testid={`door-${d.approachId}`}
                  label={ap.door}
                />
              </div>
              {/* heat */}
              <div className="mt-1 flex items-center gap-2">
                <div className="relative h-1.5 flex-1 overflow-hidden border border-edge bg-ink" aria-label="Door heat">
                  <div
                    className={clsx('h-full transition-[width] duration-200', d.heat > 0.8 ? 'bg-alert' : d.heat > 0.5 ? 'bg-warn' : 'bg-cyan/80')}
                    style={{ width: `${d.heat * 100}%` }}
                  />
                </div>
                <span className={clsx('w-[92px] shrink-0 text-right font-mono text-[10px] tabular-nums', jammed || d.heat > 0.8 ? 'text-[#ff8a93]' : 'text-dim')}>
                  {jammed
                    ? `jammed ${secs(d.jammedUntil! - t)}s`
                    : d.closed
                      ? `jams in ${Math.ceil(jamIn!)}s`
                      : d.heat > 0.02
                        ? `heat ${Math.round(d.heat * 100)}%`
                        : ctx.prep
                          ? 'locked (prep)'
                          : 'cool'}
                </span>
              </div>
              {(d.battering || breach) && (
                <div className="mt-1 flex items-center gap-2 font-mono text-[10.5px] text-[#ffc9cc]">
                  <span className={clsx(!ctx.reduced && 'fnab-blink')}>{breach ? (breach.stalled ? 'BREACH STALLED' : 'BREACH — SEAL IT') : 'IMPACTS'}</span>
                  {breach && (
                    <div className="h-1.5 flex-1 overflow-hidden border border-alert/60 bg-ink">
                      <div className="h-full bg-alert" style={{ width: `${breach.progress * 100}%` }} />
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Bay>
  );
}

function DoorSwitch({
  closed,
  jammed,
  disabled,
  onClick,
  hotkey,
  testid,
  label,
}: {
  closed: boolean;
  jammed: boolean;
  disabled: boolean;
  onClick: () => void;
  hotkey: string;
  testid: string;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={closed}
      aria-label={`${label}: ${closed ? 'sealed' : 'open'}`}
      disabled={disabled}
      onClick={onClick}
      data-testid={testid}
      title={`${closed ? 'Open' : 'Seal'} (${hotkey}) · ${P.doorDrainPerSec}/s while sealed`}
      className={clsx(
        'group flex shrink-0 items-center gap-2 border py-1 pl-1 pr-2 transition-colors disabled:cursor-not-allowed',
        jammed
          ? 'border-alert/70 bg-alert-dim/60'
          : closed
            ? 'border-ok/60 bg-ok-dim/40 hover:bg-ok-dim/60'
            : 'border-edge-hi bg-panel-2 hover:border-mute',
        disabled && !jammed && 'opacity-50',
        FOCUS,
      )}
    >
      <span className={clsx('relative h-[22px] w-[38px] border', closed ? 'border-ok/60 bg-[#0d2418]' : 'border-edge-hi bg-ink')}>
        <span
          className={clsx(
            'absolute top-[2px] h-[16px] w-[16px] border transition-[left] duration-150',
            closed ? 'left-[18px] border-ok bg-ok shadow-[0_0_8px_#3ec47a]' : 'left-[2px] border-mute bg-[#4a535c]',
            jammed && 'border-alert bg-alert shadow-[0_0_8px_#c8323a]',
          )}
        />
      </span>
      <span className="flex flex-col items-start leading-none">
        <span
          className={clsx(
            'font-mono text-[11px] font-semibold uppercase tracking-[0.14em]',
            jammed ? 'text-[#ffc9cc]' : closed ? 'text-[#a6f0c6]' : 'text-text',
          )}
        >
          {jammed ? 'Jammed' : closed ? 'Sealed' : 'Open'}
        </span>
        <span className="mt-0.5 flex items-center gap-1 font-mono text-[9.5px] text-dim">
          <Kbd>{hotkey}</Kbd>
          {closed ? `−${P.doorDrainPerSec}/s` : ''}
        </span>
      </span>
    </button>
  );
}
