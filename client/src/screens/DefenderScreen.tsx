import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import type { CameraView, DefenderView, RoomView } from '@fnab/shared';
import { useGame, matchNow } from '../state/store';
import { sendAction } from '../net/socket';
import { CameraFeed } from '../feeds/CameraFeed';
import { MapPanel } from '../map/MapPanel';
import type { MarkKind } from '../map/TacticalMap';
import { Badge, Button, Label, Meter, Panel } from '../ui/kit';
import { EventLog, TopBar } from './hud';
import { graph, hqById, nodeName } from '../lib/data';
import { useNow } from '../hooks/useNow';
import { ago } from '../lib/format';
import { audio } from '../audio';
import { DEFAULT_CONFIG } from '@fnab/shared';

const BANK_SIZE = 12;
const P = DEFAULT_CONFIG.power;

type Tool = 'inspect' | 'sensor' | 'trap' | 'scan' | 'lure';
const TOOLS: Array<{ id: Tool; label: string; cost: string; key: string }> = [
  { id: 'inspect', label: 'Inspect', cost: '', key: '1' },
  { id: 'sensor', label: 'Sensor', cost: `${P.sensorPlaceCost}⚡`, key: '2' },
  { id: 'trap', label: 'Trap', cost: `${P.trapArmCost}⚡`, key: '3' },
  { id: 'scan', label: 'Scan', cost: `${P.scanCost}⚡`, key: '4' },
  { id: 'lure', label: 'Lure', cost: `${P.lureCost}⚡`, key: '5' },
];

export function DefenderScreen({ room, view }: { room: RoomView; view: DefenderView }) {
  useNow(250);
  const t = matchNow(view);
  const spectator = view.role === 'spectator';
  const selectedCamera = useGame((s) => s.selectedCamera);
  const selectedNode = useGame((s) => s.selectedNode);
  const tool = useGame((s) => s.mapTool);
  const set = useGame((s) => s.set);
  const [bank, setBank] = useState<'auto' | number>('auto');
  const hq = hqById(view.hqId)!;
  const outage = view.power.outageUntil !== null;

  const camByNode = useMemo(() => new Map(view.cameras.map((c) => [c.nodeId, c])), [view.cameras]);
  const camById = useMemo(() => new Map(view.cameras.map((c) => [c.cameraId, c])), [view.cameras]);
  const approachCams = hq.approaches.map((a) => camByNode.get(a.fromNode)).filter(Boolean) as CameraView[];

  const mainCam = (selectedCamera && camById.get(selectedCamera)) || approachCams[0] || view.cameras[0];

  // Auto bank: HQ approaches, then recent sightings, then faulted cams, then nearest to HQ.
  const autoBank = useMemo(() => {
    const ids: string[] = [];
    const add = (id?: string) => id && !ids.includes(id) && ids.length < BANK_SIZE && ids.push(id);
    approachCams.forEach((c) => add(c.cameraId));
    [...view.sightings].reverse().forEach((s) => add(camByNode.get(s.nodeId)?.cameraId));
    view.cameras.filter((c) => c.status !== 'ok').forEach((c) => add(c.cameraId));
    [...view.cameras]
      .sort((a, b) => graph.hopsToHq(a.nodeId, view.hqId) - graph.hopsToHq(b.nodeId, view.hqId))
      .forEach((c) => add(c.cameraId));
    return ids;
  }, [view, approachCams, camByNode]);
  const banks = Math.ceil(view.cameras.length / BANK_SIZE);
  const bankCams =
    bank === 'auto' ? autoBank.map((id) => camById.get(id)!).filter(Boolean) : view.cameras.slice(bank * BANK_SIZE, (bank + 1) * BANK_SIZE);

  const recentSightingNodes = new Set(view.sightings.filter((s) => t - s.t < 8000 && !s.flaggedFalse).map((s) => s.nodeId));

  // keyboard shortcuts for tools
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      const tl = TOOLS.find((x) => x.key === e.key);
      if (tl) set({ mapTool: tl.id });
      if (e.key === 'Escape') set({ mapTool: 'inspect' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [set]);

  const selectCamera = (id: string) => {
    if (id !== selectedCamera) audio.play('cameraSwitch');
    const cam = camById.get(id);
    set({ selectedCamera: id, selectedNode: cam?.nodeId ?? selectedNode });
  };

  const act = async (a: Parameters<typeof sendAction>[0]) => {
    if (spectator) return;
    await sendAction(a);
  };

  const onNodeClick = (nodeId: string) => {
    if (spectator || tool === 'inspect') {
      const cam = camByNode.get(nodeId);
      set({ selectedNode: nodeId });
      if (cam) selectCamera(cam.cameraId);
      return;
    }
    set({ selectedNode: nodeId });
    if (tool === 'sensor') void act({ type: 'placeSensor', nodeId });
    if (tool === 'trap') void act({ type: 'armTrap', nodeId });
    if (tool === 'scan') void act({ type: 'scan', nodeId });
    if (tool === 'lure') void act({ type: 'lure', nodeId });
  };

  // map layers
  const marks: Record<string, MarkKind[]> = {};
  const addMark = (n: string, m: MarkKind) => (marks[n] ??= []).push(m);
  view.sensors.forEach((s) => addMark(s.nodeId, s.disabledUntil ? 'sensorOff' : 'sensor'));
  view.traps.forEach((tr) => addMark(tr.nodeId, tr.live ? 'trap' : 'trapArming'));
  view.lures.forEach((l) => addMark(l.nodeId, 'lure'));
  const cameraStatus = Object.fromEntries(view.cameras.map((c) => [c.nodeId, c.status]));
  const sightings = view.sightings.map((s) => ({
    id: s.id,
    nodeId: s.nodeId,
    age: (t - s.t) / 60_000,
    confidence: s.confidence,
    flagged: s.flaggedFalse,
    source: s.source,
  }));
  const rings =
    view.lastScan && t - view.lastScan.t < 4000
      ? [
          {
            nodeId: view.lastScan.nodeId,
            hops: view.lastScan.radiusHops,
            tone: view.lastScan.found ? ('alert' as const) : ('cyan' as const),
          },
        ]
      : [];
  const scanPreview = tool === 'scan' && selectedNode ? new Set(graph.within(selectedNode, DEFAULT_CONFIG.scan.radiusHops)) : undefined;

  const powerFrac = view.power.value / view.power.max;
  const scanLeft = Math.max(0, view.cooldowns.scanReadyAt - t);
  const lureLeft = Math.max(0, view.cooldowns.lureReadyAt - t);

  return (
    <div className="flex h-full flex-col" data-testid="defender-screen">
      <TopBar room={room} view={view} accent="cyan">
        <div className="flex min-w-[180px] flex-1 items-center gap-2">
          <Label>Power</Label>
          <Meter value={powerFrac} tone={outage ? 'alert' : powerFrac < 0.25 ? 'warn' : 'ok'} className="h-2.5 max-w-[220px]" />
          <span className={clsx('font-mono text-xs tabular-nums', outage ? 'text-alert' : 'text-bright')} data-testid="power">
            {outage ? `OUT ${Math.ceil((view.power.outageUntil! - t) / 1000)}s` : `${Math.round(view.power.value)}/${view.power.max}`}
          </span>
          <span className={clsx('font-mono text-[10px]', view.power.drainPerSec > 0 ? 'text-warn' : 'text-ok')}>
            {view.power.drainPerSec > 0 ? `−${view.power.drainPerSec.toFixed(2)}/s` : `+${(-view.power.drainPerSec).toFixed(2)}/s`}
          </span>
        </div>
        <div className="flex min-w-[160px] items-center gap-2">
          <Label>Threat</Label>
          <div className="flex gap-0.5" data-testid="threat">
            {[0.2, 0.4, 0.6, 0.8, 1].map((lv) => (
              <span
                key={lv}
                className={clsx(
                  'h-3 w-4 border border-edge',
                  view.threat >= lv - 0.01 ? (lv >= 0.8 ? 'bg-alert' : lv >= 0.6 ? 'bg-warn' : 'bg-cyan/70') : 'bg-ink',
                )}
              />
            ))}
          </div>
        </div>
        {spectator && <Badge tone="neutral">Spectating</Badge>}
      </TopBar>

      {(view.breach || view.held) && (
        <div
          className={clsx(
            'flex items-center justify-center gap-4 border-b px-3 py-1.5 font-mono text-xs uppercase tracking-[0.2em]',
            view.breach ? 'animate-pulse border-alert bg-alert-dim/70 text-[#ffd0d4]' : 'border-warn bg-[#2c2008] text-[#f3d28d]',
          )}
        >
          {view.breach && (
            <>
              <span>⚠ Breach in progress — {hq.approaches.find((a) => a.id === view.breach!.approachId)?.door}</span>
              <Meter value={view.breach.progress} tone="alert" className="w-48" />
              <span>{view.breach.stalled ? 'DOOR HOLDING' : 'DOOR OPEN — SEAL IT'}</span>
            </>
          )}
          {!view.breach && view.held && !view.containment && (
            <span>Target immobilised at {nodeName(view.held.nodeId)} — engage containment!</span>
          )}
          {!view.breach && view.held && view.containment && (
            <>
              <span>Containment field holding · {nodeName(view.containment.nodeId)}</span>
              <Meter value={view.containment.progress} tone="ok" className="w-48" />
              <span>{view.held.struggling ? 'TARGET STRUGGLING' : `${Math.round(view.containment.progress * 100)}%`}</span>
            </>
          )}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 p-2 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_300px]">
        {/* LEFT: feeds */}
        <div className="flex min-h-0 flex-col gap-2">
          <Panel
            title={
              <span>
                Main feed · <span className="text-bright">{nodeName(mainCam?.nodeId)}</span>
              </span>
            }
            right={
              mainCam && mainCam.status !== 'ok' && mainCam.status !== 'repairing' && mainCam.status !== 'blackout' && !spectator ? (
                <Button
                  size="sm"
                  tone="cyan"
                  onClick={() => void act({ type: 'repair', cameraId: mainCam.cameraId })}
                  data-testid="repair-main"
                >
                  Repair ({P.repairCost}⚡ · 10s)
                </Button>
              ) : null
            }
            className="min-h-0 flex-[1.5]"
          >
            {mainCam && (
              <CameraFeed
                key={mainCam.cameraId}
                cameraId={mainCam.cameraId}
                nodeId={mainCam.nodeId}
                variant="main"
                status={mainCam.status}
                interference={mainCam.interference}
                manifestation={mainCam.manifestation}
                repairProgress={mainCam.repairProgress}
                t0Epoch={view.t0Epoch}
                className="h-full w-full"
              />
            )}
          </Panel>
          <Panel
            title="Monitor bank"
            right={
              <div className="flex gap-1">
                <Button size="sm" tone={bank === 'auto' ? 'cyan' : 'ghost'} onClick={() => setBank('auto')}>
                  Auto
                </Button>
                {Array.from({ length: banks }, (_, i) => (
                  <Button key={i} size="sm" tone={bank === i ? 'cyan' : 'ghost'} onClick={() => setBank(i)}>
                    {i + 1}
                  </Button>
                ))}
              </div>
            }
            className="min-h-0 flex-1"
            bodyClass="overflow-hidden"
          >
            <div className="grid h-full grid-cols-4 grid-rows-3 gap-1 p-1">
              {bankCams.map((c) => (
                <CameraFeed
                  key={c.cameraId}
                  cameraId={c.cameraId}
                  nodeId={c.nodeId}
                  variant="thumb"
                  status={c.status}
                  interference={c.interference}
                  manifestation={c.manifestation}
                  repairProgress={c.repairProgress}
                  t0Epoch={view.t0Epoch}
                  selected={c.cameraId === mainCam?.cameraId}
                  alert={recentSightingNodes.has(c.nodeId)}
                  onClick={() => selectCamera(c.cameraId)}
                  className="h-full min-h-[56px] w-full"
                />
              ))}
            </div>
          </Panel>
        </div>

        {/* CENTER: map */}
        <Panel
          title="Tactical map"
          right={
            !spectator && (
              <div className="flex gap-1" data-testid="map-tools">
                {TOOLS.map((tl) => (
                  <Button
                    key={tl.id}
                    size="sm"
                    tone={tool === tl.id ? 'cyan' : 'ghost'}
                    onClick={() => set({ mapTool: tl.id })}
                    title={`Hotkey ${tl.key}`}
                    data-testid={`tool-${tl.id}`}
                  >
                    {tl.label}
                    {tl.cost && <span className="ml-1 text-dim">{tl.cost}</span>}
                  </Button>
                ))}
              </div>
            )
          }
        >
          <MapPanel
            hqId={view.hqId}
            cameraStatus={cameraStatus}
            marks={marks}
            sightings={sightings}
            lastKnown={view.lastKnown?.nodeId ?? null}
            held={view.held?.nodeId ?? null}
            rings={rings}
            highlight={scanPreview}
            breachApproachId={view.breach?.approachId ?? null}
            doorClosed={Object.fromEntries(view.doors.map((d) => [d.approachId, d.closed]))}
            selectedNode={selectedNode}
            onNodeClick={onNodeClick}
            cursorHint={tool !== 'inspect' && !spectator ? `${tool.toUpperCase()} — click a node · Esc to cancel` : undefined}
          />
        </Panel>

        {/* RIGHT: controls */}
        <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
          <Panel title={`${hq.name} · doors`} className="shrink-0">
            <div className="flex flex-col divide-y divide-edge" data-testid="doors">
              {view.doors.map((d) => {
                const ap = hq.approaches.find((a) => a.id === d.approachId)!;
                const jammed = d.jammedUntil !== null;
                return (
                  <div key={d.approachId} className={clsx('flex items-center gap-2 px-2 py-1.5', d.battering && 'bg-alert-dim/40')}>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-[11px] text-bright">{ap.door}</span>
                        <span className="truncate text-[11px] text-mute">{ap.label}</span>
                      </div>
                      <Meter
                        value={d.heat}
                        tone={d.heat > 0.75 ? 'alert' : d.heat > 0.45 ? 'warn' : 'cyan'}
                        className="mt-1 h-1.5"
                        label="Door heat"
                      />
                    </div>
                    {jammed ? (
                      <Badge tone="alert">Jammed {Math.ceil((d.jammedUntil! - t) / 1000)}s</Badge>
                    ) : (
                      <Button
                        size="sm"
                        tone={d.closed ? 'ok' : 'neutral'}
                        disabled={spectator || outage}
                        onClick={() => void act({ type: 'door', approachId: d.approachId, closed: !d.closed })}
                        data-testid={`door-${d.approachId}`}
                      >
                        {d.closed ? 'Sealed' : 'Open'}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </Panel>
          <Panel title="Containment" className="shrink-0">
            <div className="flex flex-col gap-1.5 p-2">
              {view.containment ? (
                <>
                  <div className="font-mono text-[11px] text-[#ff8a93]">FIELD ACTIVE · {nodeName(view.containment.nodeId)}</div>
                  <Meter value={view.containment.progress} tone="ok" />
                  <div className="flex items-center justify-between font-mono text-[10px] text-mute">
                    <span>
                      {Math.round(view.containment.progress * 100)}% · −{P.containmentDrainPerSec}/s
                    </span>
                    {view.held?.struggling && <span className="animate-pulse text-alert">STRUGGLING</span>}
                  </div>
                  <Button size="sm" tone="ghost" disabled={spectator} onClick={() => void act({ type: 'containment', engage: false })}>
                    Disengage
                  </Button>
                </>
              ) : (
                <>
                  <div className="text-[11px] text-mute">
                    {view.held ? `Target held at ${nodeName(view.held.nodeId)}` : 'Requires a trapped target. Hold 15 s to capture.'}
                  </div>
                  <Button
                    tone="alert"
                    disabled={!view.held || spectator || outage}
                    onClick={() => void act({ type: 'containment', engage: true })}
                    data-testid="contain"
                  >
                    Engage containment
                  </Button>
                </>
              )}
            </div>
          </Panel>
          <NodeInspector
            view={view}
            t={t}
            nodeId={selectedNode}
            act={act}
            spectator={spectator}
            scanLeft={scanLeft}
            lureLeft={lureLeft}
            onViewFeed={selectCamera}
          />
          <Panel title="Event log" className="min-h-[180px] flex-1" bodyClass="overflow-auto">
            <EventLog events={view.events} view={view} />
          </Panel>
        </div>
      </div>
    </div>
  );
}

function NodeInspector({
  view,
  t,
  nodeId,
  act,
  spectator,
  scanLeft,
  lureLeft,
  onViewFeed,
}: {
  view: DefenderView;
  t: number;
  nodeId: string | null;
  act: (a: Parameters<typeof sendAction>[0]) => Promise<void>;
  spectator: boolean;
  scanLeft: number;
  lureLeft: number;
  onViewFeed: (id: string) => void;
}) {
  if (!nodeId) {
    return (
      <Panel title="Node" className="shrink-0">
        <div className="p-2 text-[11px] text-mute">Select a node on the map.</div>
      </Panel>
    );
  }
  const node = graph.nodes.get(nodeId)!;
  const cam = view.cameras.find((c) => c.nodeId === nodeId);
  const sensor = view.sensors.find((s) => s.nodeId === nodeId);
  const trap = view.traps.find((x) => x.nodeId === nodeId);
  const last = [...view.sightings].reverse().find((s) => s.nodeId === nodeId);
  const prep = view.phase === 'preparation';
  return (
    <Panel
      title={
        <span>
          Node · <span className="text-bright">{node.name}</span>
        </span>
      }
      className="shrink-0"
    >
      <div className="flex flex-col gap-1.5 p-2 text-[11px]">
        <div className="flex flex-wrap gap-1">
          {cam && <Badge tone={cam.status === 'ok' ? 'ok' : cam.status === 'repairing' ? 'cyan' : 'alert'}>CAM {cam.status}</Badge>}
          {sensor && <Badge tone={sensor.disabledUntil ? 'ghost' : 'cyan'}>Sensor{sensor.disabledUntil ? ' offline' : ''}</Badge>}
          {trap && <Badge tone="alert">{trap.live ? 'Trap live' : 'Trap arming'}</Badge>}
          {last && <Badge tone="warn">Seen {ago(t - last.t)}</Badge>}
        </div>
        {!spectator && (
          <div className="grid grid-cols-2 gap-1">
            {cam && (
              <Button size="sm" onClick={() => onViewFeed(cam.cameraId)}>
                View feed
              </Button>
            )}
            {cam && cam.status !== 'ok' && cam.status !== 'repairing' && cam.status !== 'blackout' && (
              <Button
                size="sm"
                tone="cyan"
                disabled={prep}
                onClick={() => void act({ type: 'repair', cameraId: cam.cameraId })}
                data-testid="repair-node"
              >
                Repair {P.repairCost}⚡
              </Button>
            )}
            {sensor ? (
              <Button size="sm" tone="ghost" onClick={() => void act({ type: 'removeSensor', sensorId: sensor.id })}>
                Remove sensor
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={view.sensors.length >= view.limits.sensors}
                onClick={() => void act({ type: 'placeSensor', nodeId })}
              >
                Sensor {view.sensors.length}/{view.limits.sensors}
              </Button>
            )}
            {trap ? (
              <Button size="sm" tone="ghost" onClick={() => void act({ type: 'disarmTrap', trapId: trap.id })}>
                Disarm trap
              </Button>
            ) : (
              <Button
                size="sm"
                tone="alert"
                disabled={view.traps.length >= view.limits.traps}
                onClick={() => void act({ type: 'armTrap', nodeId })}
                data-testid="arm-trap"
              >
                Trap {view.traps.length}/{view.limits.traps}
              </Button>
            )}
            <Button
              size="sm"
              tone="cyan"
              disabled={prep || scanLeft > 0}
              onClick={() => void act({ type: 'scan', nodeId })}
              data-testid="scan-node"
            >
              {scanLeft > 0 ? `Scan ${Math.ceil(scanLeft / 1000)}s` : `Scan ${P.scanCost}⚡`}
            </Button>
            <Button size="sm" tone="warn" disabled={prep || lureLeft > 0} onClick={() => void act({ type: 'lure', nodeId })}>
              {lureLeft > 0 ? `Lure ${Math.ceil(lureLeft / 1000)}s` : `Lure ${P.lureCost}⚡`}
            </Button>
          </div>
        )}
      </div>
    </Panel>
  );
}
