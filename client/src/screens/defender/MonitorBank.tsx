// Monitor bank: a 4×3 wall of thumbnails with label plates, paging (AUTO priority + numbered pages),
// optional auto-cycle, pins and sighting alerts.
import clsx from 'clsx';
import type { CameraView } from '@fnab/shared';
import { CameraFeed } from '../../feeds/CameraFeed';
import { graph } from '../../lib/data';
import { Bay, FOCUS, Kbd, P, camLabel, type RoomCtx } from './common';
import { PinGlyph } from './MainFeed';

export const BANK_SIZE = 12;
export type BankPage = 'auto' | number;

export function MonitorBank({
  ctx,
  cams,
  page,
  pages,
  setPage,
  pageAlerts,
  cycle,
  setCycle,
  mainId,
  pinned,
  alertNodes,
  className,
}: {
  ctx: RoomCtx;
  cams: CameraView[];
  page: BankPage;
  pages: number;
  setPage: (p: BankPage) => void;
  pageAlerts: Set<BankPage>;
  cycle: boolean;
  setCycle: (v: boolean) => void;
  mainId: string | undefined;
  pinned: string[];
  alertNodes: Set<string>;
  className?: string;
}) {
  const { view } = ctx;
  const faults = view.cameras.filter((c) => c.status !== 'ok').length;
  const pageBtn = (p: BankPage, label: string) => (
    <button
      key={String(p)}
      type="button"
      onClick={() => setPage(p)}
      aria-pressed={page === p}
      data-testid={`bank-${p}`}
      className={clsx(
        'relative h-5 border px-1.5 font-mono text-[10px] uppercase tracking-[0.12em]',
        page === p ? 'border-cyan/70 bg-cyan-dim/60 text-[#b5f3fa]' : 'border-edge text-mute hover:border-mute hover:text-text',
        FOCUS,
      )}
    >
      {label}
      {pageAlerts.has(p) && page !== p && (
        <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-alert shadow-[0_0_6px_#c8323a]" />
      )}
    </button>
  );
  return (
    <Bay
      title={
        <span>
          Monitor bank{' '}
          <span className="text-dim">
            {view.cameras.length - faults}/{view.cameras.length} online
          </span>
        </span>
      }
      led={faults ? 'warn' : 'ok'}
      right={
        <div className="flex items-center gap-1">
          {pageBtn('auto', 'Auto')}
          {Array.from({ length: pages }, (_, i) => pageBtn(i, String(i + 1)))}
          <button
            type="button"
            onClick={() => setCycle(!cycle)}
            aria-pressed={cycle}
            title="Cycle through the bank pages every few seconds (O)"
            data-testid="bank-cycle"
            className={clsx(
              'ml-1 h-5 border px-1.5 font-mono text-[10px] uppercase tracking-[0.12em]',
              cycle ? 'border-warn/70 bg-[#3a2a0c]/70 text-[#f3d28d]' : 'border-edge text-mute hover:border-mute hover:text-text',
              FOCUS,
            )}
          >
            {cycle ? 'Cycling' : 'Cycle'}
          </button>
        </div>
      }
      className={className}
      bodyClass="overflow-hidden"
    >
      <div className="grid h-full grid-cols-4 grid-rows-3 gap-1.5 p-1.5" data-testid="monitor-bank">
        {cams.map((c, i) => (
          <Thumb
            key={c.cameraId}
            ctx={ctx}
            cam={c}
            slot={i + 1}
            selected={c.cameraId === mainId}
            pinned={pinned.includes(c.cameraId)}
            alert={alertNodes.has(c.nodeId) || !!c.manifestation}
          />
        ))}
      </div>
    </Bay>
  );
}

function Thumb({
  ctx,
  cam,
  slot,
  selected,
  pinned,
  alert,
}: {
  ctx: RoomCtx;
  cam: CameraView;
  slot: number;
  selected: boolean;
  pinned: boolean;
  alert: boolean;
}) {
  const { view } = ctx;
  const no = ctx.camNo.get(cam.cameraId);
  const hops = graph.hopsToHq(cam.nodeId, view.hqId);
  const approach = ctx.hq.approaches.find((a) => a.fromNode === cam.nodeId);
  const sensor = view.sensors.find((s) => s.nodeId === cam.nodeId);
  const trap = view.traps.find((s) => s.nodeId === cam.nodeId);
  const broken = cam.status === 'sabotaged' || cam.status === 'static';
  const statusTone =
    cam.status === 'ok' ? 'text-[#9fe8bf]' : cam.status === 'repairing' ? 'text-[#b5f3fa]' : cam.status === 'static' ? 'text-[#f3d28d]' : 'text-[#ff8a93]';
  const statusWord = { ok: 'OK', sabotaged: 'TAMPERED', repairing: 'REPAIR', static: 'NOISE', blackout: 'NO PWR' }[cam.status];
  return (
    <div
      className={clsx(
        'relative flex min-h-0 min-w-0 flex-col border bg-ink',
        selected ? 'border-cyan shadow-[0_0_0_1px_#3bc6d6]' : 'border-edge-hi',
        alert && 'fnab-alert-ring border-alert',
      )}
    >
      <div className="relative min-h-0 flex-1">
        <CameraFeed
          cameraId={cam.cameraId}
          nodeId={cam.nodeId}
          variant="thumb"
          status={cam.status}
          interference={cam.interference}
          manifestation={cam.manifestation}
          repairProgress={cam.repairProgress}
          t0Epoch={view.t0Epoch}
          selected={selected}
          alert={alert}
          className="absolute inset-0 h-full w-full"
        />
        <button
          type="button"
          onClick={() => ctx.selectCamera(cam.cameraId)}
          className={clsx('absolute inset-0 z-[1] cursor-pointer', FOCUS, 'focus-visible:-outline-offset-2')}
          aria-label={`View ${camLabel(no)} on main monitor (key ${slot <= 9 ? slot : '—'})`}
          data-testid={`thumb-${cam.cameraId}`}
        />
      </div>
      {/* label plate */}
      <div
        className={clsx(
          'flex h-[18px] shrink-0 items-center gap-1 overflow-hidden whitespace-nowrap border-t px-1 font-mono text-[9.5px] leading-none',
          selected ? 'border-cyan bg-cyan-dim' : 'border-edge bg-panel-2',
        )}
      >
        {slot <= 9 && <Kbd className={selected ? 'border-cyan text-[#d7fbff]' : ''}>{slot}</Kbd>}
        <span className="text-bright" title={camLabel(no)}>{String(no ?? 0).padStart(2, '0')}</span>
        <span className={clsx('font-semibold', statusTone)}>{statusWord}</span>
        {approach && <span className="text-[#f3d28d]" title={`Approach ${approach.door}`}>▲</span>}
        <span className="text-dim" title="Hops to HQ">
          {hops}h
        </span>
        <span className="ml-auto flex items-center gap-1">
          {sensor && (
            <span className={sensor.disabledUntil ? 'text-dim line-through' : 'text-cyan'} title="Motion sensor">
              S
            </span>
          )}
          {trap && (
            <span className={trap.live ? 'text-[#ff8a93]' : 'text-[#f3d28d]'} title={trap.live ? 'Trap live' : 'Trap arming'}>
              T
            </span>
          )}
          {pinned && (
            <span className="text-cyan" title="Pinned">
              <PinGlyph on />
            </span>
          )}
          {broken && !ctx.spectator && (
            <button
              type="button"
              disabled={ctx.prep || view.repairs.length >= view.limits.repairsConcurrent}
              onClick={() => void ctx.act({ type: 'repair', cameraId: cam.cameraId })}
              title={`Repair (${P.repairCost} power)`}
              data-testid={`repair-thumb-${cam.cameraId}`}
              className={clsx('border border-cyan/60 bg-cyan-dim/60 px-1 text-[9px] text-[#d7fbff] disabled:opacity-40', FOCUS)}
            >
              FIX
            </button>
          )}
        </span>
      </div>
    </div>
  );
}
