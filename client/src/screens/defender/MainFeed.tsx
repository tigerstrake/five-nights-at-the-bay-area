// The enlarged monitor: selected camera with CCTV framing, OSD strip, switch cut, and in-feed repair.
import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import type { CameraView } from '@fnab/shared';
import { CameraFeed } from '../../feeds/CameraFeed';
import { SignalLostTransition } from '../../fx';
import { cameraRecord, graph, nodeName } from '../../lib/data';
import { ago } from '../../lib/format';
import { Bay, CFG, FOCUS, Kbd, P, camLabel, secs, type RoomCtx } from './common';

export function MainFeed({ ctx, cam, pinned, onPin }: { ctx: RoomCtx; cam: CameraView | undefined; pinned: boolean; onPin: () => void }) {
  const { view, t, hq } = ctx;
  // Short static cut whenever the main monitor changes channel.
  const [cut, setCut] = useState(0);
  const prev = useRef(cam?.cameraId);
  useEffect(() => {
    if (cam?.cameraId && prev.current && prev.current !== cam.cameraId) setCut((x) => x + 1);
    prev.current = cam?.cameraId;
  }, [cam?.cameraId]);

  if (!cam) return <Bay title="Main monitor">{null}</Bay>;
  const rec = cameraRecord(cam.cameraId);
  const hops = graph.hopsToHq(cam.nodeId, view.hqId);
  const approach = hq.approaches.find((a) => a.fromNode === cam.nodeId);
  const lastSeen = [...view.sightings].reverse().find((s) => s.nodeId === cam.nodeId && !s.flaggedFalse);
  const fresh = lastSeen && t - lastSeen.t < 8000;
  const held = view.held?.nodeId === cam.nodeId;
  const repair = view.repairs.find((r) => r.cameraId === cam.cameraId);
  const broken = cam.status === 'sabotaged' || cam.status === 'static';
  const repairsBusy = view.repairs.length >= view.limits.repairsConcurrent;
  const trap = view.traps.find((x) => x.nodeId === cam.nodeId);
  const sensor = view.sensors.find((x) => x.nodeId === cam.nodeId);

  return (
    <Bay
      led={cam.manifestation || fresh ? 'alert' : cam.status === 'ok' ? 'ok' : cam.status === 'repairing' ? 'cyan' : 'warn'}
      title={
        <span className="flex items-baseline gap-2 normal-case tracking-normal">
          <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-cyan">{camLabel(ctx.camNo.get(cam.cameraId))}</span>
          <span className="truncate font-sans text-[13px] font-semibold text-bright" data-testid="main-feed-name">
            {nodeName(cam.nodeId)}
          </span>
          <span className="hidden truncate font-mono text-[10.5px] text-mute xl:inline">{rec?.route ?? ''}</span>
        </span>
      }
      right={
        <div className="flex items-center gap-1.5">
          <span
            className={clsx(
              'font-mono text-[10.5px] tabular-nums',
              hops <= 1 ? 'text-[#ff8a93]' : hops <= 2 ? 'text-[#f3d28d]' : 'text-mute',
            )}
            title="Network hops from this camera to HQ"
          >
            {approach ? `Approach ${approach.door}` : `${hops} hop${hops === 1 ? '' : 's'} to HQ`}
          </span>
          <button
            type="button"
            onClick={onPin}
            aria-pressed={pinned}
            title="Pin this camera to the front of the monitor bank (P)"
            data-testid="pin-main"
            className={clsx(
              'flex h-5 items-center gap-1 border px-1.5 font-mono text-[10px] uppercase tracking-[0.12em]',
              pinned ? 'border-cyan/70 bg-cyan-dim/60 text-[#b5f3fa]' : 'border-edge text-mute hover:border-mute hover:text-text',
              FOCUS,
            )}
          >
            <PinGlyph on={pinned} />
            {pinned ? 'Pinned' : 'Pin'}
          </button>
        </div>
      }
      className="min-h-0 flex-1"
      bodyClass="relative bg-black"
    >
      <div className={clsx('absolute inset-0', held && 'outline outline-2 -outline-offset-2 outline-warn')}>
        <CameraFeed
          key={cam.cameraId}
          cameraId={cam.cameraId}
          nodeId={cam.nodeId}
          variant="main"
          status={cam.status}
          interference={cam.interference}
          manifestation={cam.manifestation}
          alert={!!fresh || held}
          repairProgress={cam.repairProgress}
          t0Epoch={view.t0Epoch}
          className="h-full w-full"
        />
        <Brackets tone={cam.manifestation || fresh ? 'alert' : 'dim'} />
        {!ctx.reduced && <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden opacity-[0.07]"><div className="fnab-sweep h-1/3 w-full bg-gradient-to-b from-transparent via-white to-transparent" /></div>}

        {/* right-side OSD: REC, device markers, last-seen */}
        <div className="pointer-events-none absolute right-4 top-12 flex flex-col items-end gap-1 font-mono text-[10.5px] text-[#dfe6e2] [text-shadow:0_0_4px_#000]">
          <span className="flex items-center gap-1.5">
            <span className={clsx('h-2 w-2 rounded-full bg-alert', cam.status === 'ok' && 'fnab-blink')} /> REC
          </span>
          {repair && <span className="bg-cyan-dim/90 px-1 text-[#d7fbff]">REPAIR CREW ON SITE · {secs(repair.endsAt - t)}s</span>}
          {sensor && <span className="bg-black/60 px-1 text-cyan">SENSOR {sensor.disabledUntil ? 'OFFLINE' : 'ARMED'}</span>}
          {trap && <span className="bg-black/60 px-1 text-[#ff8a93]">TRAP {trap.live ? 'LIVE' : 'ARMING'}</span>}
          {lastSeen && <span className="bg-black/60 px-1 text-[#f3d28d]">LAST SIGHTING {ago(t - lastSeen.t).toUpperCase()}</span>}
        </div>

        {(cam.manifestation || fresh) && !held && cam.status !== 'blackout' && (
          <div className="pointer-events-none absolute left-1/2 top-11 -translate-x-1/2">
            <span className={clsx('border border-alert bg-alert-dim/85 px-2 py-0.5 font-mono text-[11px] font-semibold tracking-[0.3em] text-[#ffd0d4]', !ctx.reduced && 'animate-pulse')}>
              MOTION DETECTED
            </span>
          </div>
        )}

        {held && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="relative h-[46%] aspect-square">
              <div className={clsx('absolute inset-0 rounded-full border-2 border-warn/80', !ctx.reduced && 'animate-ping [animation-duration:2s]')} />
              <div className="absolute inset-[18%] rounded-full border border-warn/70" />
              <div className="absolute left-1/2 top-0 h-full w-px bg-warn/50" />
              <div className="absolute left-0 top-1/2 h-px w-full bg-warn/50" />
            </div>
            <span className="absolute bottom-10 bg-black/75 px-2 py-0.5 font-mono text-[12px] font-semibold tracking-[0.3em] text-[#f3d28d]">
              TARGET IMMOBILISED
            </span>
          </div>
        )}

        {/* In-feed repair console */}
        {broken && !repair && !ctx.outage && (
          <div className="absolute inset-x-0 bottom-9 flex justify-center px-3">
            <div className="flex min-w-[260px] max-w-[92%] items-center gap-3 border border-edge-hi bg-black/80 px-3 py-2 backdrop-blur-[2px]">
              {repair ? null : (
                <>
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[11.5px] font-semibold text-[#ffc9cc]">
                      {cam.status === 'sabotaged' ? 'Feed tampered with' : 'Signal interference'}
                    </div>
                    <div className="text-[11px] text-mute">
                      {ctx.prep ? 'Repairs unlock when the night starts.' : repairsBusy ? `All ${view.limits.repairsConcurrent} crews busy.` : `Send a crew: ${P.repairCost} power, ${CFG.repair.durationMs / 1000}s.`}
                    </div>
                  </div>
                  {!ctx.spectator && (
                    <button
                      type="button"
                      disabled={ctx.prep || repairsBusy || view.power.value < P.repairCost}
                      onClick={() => void ctx.act({ type: 'repair', cameraId: cam.cameraId })}
                      data-testid="repair-main"
                      className={clsx(
                        'flex shrink-0 items-center gap-1.5 border border-cyan/70 bg-cyan-dim/70 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-[#d7fbff] hover:bg-cyan-dim disabled:cursor-not-allowed disabled:opacity-40',
                        FOCUS,
                      )}
                    >
                      Repair {P.repairCost}⚡ <Kbd>R</Kbd>
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        )}
        {cut > 0 && <SignalLostTransition key={cut} durationMs={300} onDone={() => setCut(0)} />}
      </div>
    </Bay>
  );
}

function Brackets({ tone }: { tone: 'alert' | 'dim' }) {
  const c = tone === 'alert' ? 'border-alert/90' : 'border-white/35';
  const s = 'pointer-events-none absolute h-5 w-5';
  return (
    <>
      <span aria-hidden className={clsx(s, c, 'left-2 top-10 border-l-2 border-t-2')} />
      <span aria-hidden className={clsx(s, c, 'right-2 top-10 border-r-2 border-t-2')} />
      <span aria-hidden className={clsx(s, c, 'bottom-6 left-2 border-b-2 border-l-2')} />
      <span aria-hidden className={clsx(s, c, 'bottom-6 right-2 border-b-2 border-r-2')} />
    </>
  );
}

export function PinGlyph({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 10 10" className="h-2.5 w-2.5" aria-hidden>
      <path d="M3 1h4l-.6 3L8 6H2l1.6-2z M5 6v3.5" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}
