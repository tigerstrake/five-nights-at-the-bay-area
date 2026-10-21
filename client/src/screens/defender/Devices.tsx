// Field devices: map tool dock (sensor / trap / scan / lure with costs, counts, cooldowns) and the node inspector.
import clsx from 'clsx';
import type { MapTool } from '../../state/store';
import { graph, nodeName } from '../../lib/data';
import { ago } from '../../lib/format';
import { CFG, FOCUS, Kbd, Led, P, camLabel, secs, type RoomCtx } from './common';

export const TOOL_KEYS: Record<string, MapTool> = { i: 'inspect', s: 'sensor', t: 'trap', c: 'scan', l: 'lure' };

interface ToolInfo {
  id: MapTool;
  label: string;
  key: string;
  cost?: number;
  stat: string;
  /** 0..1 cooldown remaining fraction */
  cool?: number;
  blocked?: string;
  tone: 'cyan' | 'alert' | 'warn' | 'neutral';
}

export function ToolDock({ ctx, tool, setTool }: { ctx: RoomCtx; tool: MapTool; setTool: (t: MapTool) => void }) {
  const { view, t, prep } = ctx;
  const scanLeft = Math.max(0, view.cooldowns.scanReadyAt - t);
  const lureLeft = Math.max(0, view.cooldowns.lureReadyAt - t);
  const tools: ToolInfo[] = [
    { id: 'inspect', label: 'Inspect', key: 'I', stat: 'look', tone: 'neutral' },
    {
      id: 'sensor',
      label: 'Sensor',
      key: 'S',
      cost: P.sensorPlaceCost,
      stat: `${view.sensors.length}/${view.limits.sensors}`,
      blocked: view.sensors.length >= view.limits.sensors ? 'all placed' : undefined,
      tone: 'cyan',
    },
    {
      id: 'trap',
      label: 'Trap',
      key: 'T',
      cost: P.trapArmCost,
      stat: `${view.traps.length}/${view.limits.traps}`,
      blocked: view.traps.length >= view.limits.traps ? 'all armed' : undefined,
      tone: 'alert',
    },
    {
      id: 'scan',
      label: 'Scan',
      key: 'C',
      cost: P.scanCost,
      stat: prep ? 'locked' : scanLeft > 0 ? `${secs(scanLeft)}s` : 'ready',
      cool: scanLeft / CFG.scan.cooldownMs,
      blocked: prep ? 'after prep' : scanLeft > 0 ? 'cooling' : undefined,
      tone: 'cyan',
    },
    {
      id: 'lure',
      label: 'Lure',
      key: 'L',
      cost: P.lureCost,
      stat: prep ? 'locked' : lureLeft > 0 ? `${secs(lureLeft)}s` : `${view.lures.length}/${CFG.lure.maxActive}`,
      cool: lureLeft / CFG.lure.cooldownMs,
      blocked: prep ? 'after prep' : lureLeft > 0 ? 'cooling' : undefined,
      tone: 'warn',
    },
  ];
  return (
    <div
      className="grid shrink-0 grid-cols-5 gap-1 border-t border-edge bg-panel-2/70 p-1.5"
      data-testid="map-tools"
      role="toolbar"
      aria-label="Map tools"
    >
      {tools.map((tl) => {
        const on = tool === tl.id;
        const poor = tl.cost !== undefined && view.power.value < tl.cost;
        return (
          <button
            key={tl.id}
            type="button"
            disabled={ctx.spectator}
            onClick={() => setTool(on && tl.id !== 'inspect' ? 'inspect' : tl.id)}
            aria-pressed={on}
            data-testid={`tool-${tl.id}`}
            title={`${tl.label} (${tl.key})`}
            className={clsx(
              'relative flex min-w-0 flex-col items-start gap-0.5 overflow-hidden border px-1.5 py-1 text-left transition-colors',
              on
                ? {
                    cyan: 'border-cyan bg-cyan-dim/60',
                    alert: 'border-alert bg-alert-dim/60',
                    warn: 'border-warn bg-[#3a2a0c]/70',
                    neutral: 'border-mute bg-[#1e2328]',
                  }[tl.tone]
                : 'border-edge bg-panel hover:border-edge-hi',
              (tl.blocked || poor) && !on && 'opacity-60',
              FOCUS,
            )}
          >
            {tl.cool !== undefined && tl.cool > 0 && (
              <span aria-hidden className="absolute inset-y-0 left-0 bg-white/[0.06]" style={{ width: `${tl.cool * 100}%` }} />
            )}
            <span className="flex w-full items-center gap-1">
              <span
                className={clsx(
                  'min-w-0 truncate font-mono text-[11px] font-semibold uppercase tracking-[0.04em] min-[1600px]:tracking-[0.1em]',
                  on ? 'text-bright' : 'text-text',
                )}
              >
                {tl.label}
              </span>
              {/* Narrow docks drop the key cap (it is in the tooltip and the ? sheet) rather than clip it. */}
              <Kbd className="ml-auto shrink-0 max-[1359px]:hidden">{tl.key}</Kbd>
            </span>
            <span className="flex w-full items-center justify-between gap-1 font-mono text-[10px] tabular-nums">
              <span className={clsx('truncate', tl.blocked ? 'text-dim' : 'text-mute')}>{tl.stat}</span>
              {/* Locked until nightfall: the cost is irrelevant, so give the word the room. */}
              {tl.cost !== undefined && !(prep && tl.blocked === 'after prep') && (
                <span className={clsx('shrink-0', poor ? 'text-[#ff8a93]' : 'text-[#f3d28d]')}>{tl.cost}⚡</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function NodeInspector({ ctx, nodeId }: { ctx: RoomCtx; nodeId: string | null }) {
  const { view, t, prep, spectator } = ctx;
  if (!nodeId) {
    return (
      <div className="flex h-[66px] shrink-0 items-center border-t border-edge px-2.5 text-[11.5px] text-mute">
        Click a node on the map, or pick a camera, to see what's there.
      </div>
    );
  }
  const node = graph.nodes.get(nodeId)!;
  const cam = ctx.camByNode.get(nodeId);
  const sensor = view.sensors.find((s) => s.nodeId === nodeId);
  const trap = view.traps.find((x) => x.nodeId === nodeId);
  const lure = view.lures.find((x) => x.nodeId === nodeId);
  const last = [...view.sightings].reverse().find((s) => s.nodeId === nodeId);
  const hops = graph.hopsToHq(nodeId, view.hqId);
  const scanLeft = Math.max(0, view.cooldowns.scanReadyAt - t);
  const lureLeft = Math.max(0, view.cooldowns.lureReadyAt - t);
  const btn = 'h-6 border px-1.5 font-mono text-[10.5px] uppercase tracking-[0.1em] disabled:cursor-not-allowed disabled:opacity-40';
  return (
    <div
      className="flex min-h-[66px] shrink-0 flex-col justify-center gap-1 border-t border-edge px-2.5 py-1.5"
      data-testid="node-inspector"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-[12.5px] font-semibold text-bright">{node.name}</span>
        <span className="shrink-0 font-mono text-[10.5px] text-dim">
          {hops === 0 ? 'at an HQ door' : `${hops} hop${hops === 1 ? '' : 's'} to HQ`}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[10.5px]">
          {cam && (
            <span className="flex items-center gap-1 text-mute">
              <Led tone={cam.status === 'ok' ? 'ok' : cam.status === 'repairing' ? 'cyan' : 'alert'} />
              {camLabel(ctx.camNo.get(cam.cameraId))}
            </span>
          )}
          {sensor && (
            <span className={sensor.disabledUntil ? 'text-dim' : 'text-cyan'}>sensor{sensor.disabledUntil ? ' offline' : ''}</span>
          )}
          {trap && <span className="text-[#ff8a93]">trap {trap.live ? 'live' : `arming ${secs(trap.armedAt - t)}s`}</span>}
          {lure && <span className="text-[#f3d28d]">lure {secs(lure.expiresAt - t)}s</span>}
          {last && <span className={last.flaggedFalse ? 'text-dim line-through' : 'text-[#f3d28d]'}>seen {ago(t - last.t)}</span>}
        </span>
      </div>
      {!spectator && (
        <div className="flex flex-wrap gap-1">
          {cam && (
            <button
              type="button"
              className={clsx(btn, 'border-edge-hi bg-panel-2 text-text hover:border-mute', FOCUS)}
              onClick={() => ctx.selectCamera(cam.cameraId)}
            >
              View feed
            </button>
          )}
          {cam && (cam.status === 'sabotaged' || cam.status === 'static') && (
            <button
              type="button"
              disabled={prep}
              className={clsx(btn, 'border-cyan/60 bg-cyan-dim/50 text-[#b5f3fa]', FOCUS)}
              onClick={() => void ctx.act({ type: 'repair', cameraId: cam.cameraId })}
              data-testid="repair-node"
            >
              Repair {P.repairCost}⚡
            </button>
          )}
          {sensor ? (
            <button
              type="button"
              className={clsx(btn, 'border-edge text-mute hover:text-text', FOCUS)}
              onClick={() => void ctx.act({ type: 'removeSensor', sensorId: sensor.id })}
            >
              Remove sensor
            </button>
          ) : (
            <button
              type="button"
              disabled={view.sensors.length >= view.limits.sensors}
              className={clsx(btn, 'border-cyan/50 bg-panel-2 text-[#b5f3fa]', FOCUS)}
              onClick={() => void ctx.act({ type: 'placeSensor', nodeId })}
            >
              Sensor {P.sensorPlaceCost}⚡
            </button>
          )}
          {trap ? (
            <button
              type="button"
              className={clsx(btn, 'border-edge text-mute hover:text-text', FOCUS)}
              onClick={() => void ctx.act({ type: 'disarmTrap', trapId: trap.id })}
            >
              Disarm trap
            </button>
          ) : (
            <button
              type="button"
              disabled={view.traps.length >= view.limits.traps}
              className={clsx(btn, 'border-alert/60 bg-alert-dim/40 text-[#ffb3b8]', FOCUS)}
              onClick={() => void ctx.act({ type: 'armTrap', nodeId })}
              data-testid="arm-trap"
            >
              Trap {P.trapArmCost}⚡
            </button>
          )}
          <button
            type="button"
            disabled={prep || scanLeft > 0}
            className={clsx(btn, 'border-cyan/60 bg-cyan-dim/40 text-[#b5f3fa]', FOCUS)}
            onClick={() => void ctx.act({ type: 'scan', nodeId })}
            data-testid="scan-node"
          >
            {scanLeft > 0 ? `Scan ${secs(scanLeft)}s` : `Scan ${P.scanCost}⚡`}
          </button>
          <button
            type="button"
            disabled={prep || lureLeft > 0}
            className={clsx(btn, 'border-warn/60 bg-[#3a2a0c]/50 text-[#f3d28d]', FOCUS)}
            onClick={() => void ctx.act({ type: 'lure', nodeId })}
            data-testid="lure-node"
          >
            {lureLeft > 0 ? `Lure ${secs(lureLeft)}s` : `Lure ${P.lureCost}⚡`}
          </button>
        </div>
      )}
      {spectator && <div className="text-[11px] text-dim">Spectating {nodeName(nodeId)}</div>}
    </div>
  );
}
