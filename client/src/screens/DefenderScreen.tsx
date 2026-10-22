// Defender control room (also used read-only for spectators). Composition:
//   top bar · alert ticker
//   [ main monitor / monitor bank (or containment console) ] [ tactical map / tools / inspector ] [ power / doors / containment / log ]
// Sub-panels live in ./defender/. Everything shown is derived from the DefenderView only (no secrets).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import type { CameraView, DefenderAction, DefenderView, RoomView, VisibleEvent } from '@fnab/shared';
import { useGame, matchNow } from '../state/store';
import { sendAction } from '../net/socket';
import { MapPanel } from '../map/MapPanel';
import type { MarkKind } from '../map/TacticalMap';
import { TeamSignalBanner, TopBar } from './hud';
import { graph, hqById } from '../lib/data';
import { useNow } from '../hooks/useNow';
import { audio, type SfxName } from '../audio';
import { isReducedMotion } from '../fx';
import { isLiveCapable, liveFirst, preferLive } from '../feeds/liveBudget';
import { Bay, CFG, DefenderStyles, FOCUS, THREAT_WORD, type RoomCtx } from './defender/common';
import { MainFeed } from './defender/MainFeed';
import { BANK_SIZE, MonitorBank, type BankPage } from './defender/MonitorBank';
import { DoorsPanel, PowerPanel } from './defender/Systems';
import { NodeInspector, TOOL_KEYS, ToolDock } from './defender/Devices';
import { ContainmentConsole, ContainmentStandby } from './defender/Containment';
import { TeamLog } from './defender/TeamLog';
import { AlertTicker, BlackoutCurtain, HelpSheet, PhaseAnnouncer, ThreatVignette } from './defender/Atmosphere';
import { DefenderMoments } from './shell/Moments';
import { CoachLayer } from '../coach/Coach';
import { defenderHints } from '../coach/rules';
import { useCoachPrefs, useHintsOn } from '../coach/store';

const ALERT_MS = 8000;
const CYCLE_MS = 7000;
const MAX_PINS = 4;
const DOOR_KEYS = ['q', 'w', 'e'];

const ACTION_SFX: Partial<Record<DefenderAction['type'], SfxName>> = {
  placeSensor: 'sensorPing',
  lure: 'alarm',
  removeSensor: 'uiClick',
  disarmTrap: 'uiClick',
};

export function DefenderScreen({ room, view }: { room: RoomView; view: DefenderView }) {
  useNow(250);
  const t = matchNow(view);
  const spectator = view.role === 'spectator';
  const selectedCamera = useGame((s) => s.selectedCamera);
  const selectedNode = useGame((s) => s.selectedNode);
  const tool = useGame((s) => s.mapTool);
  const set = useGame((s) => s.set);
  const [page, setPage] = useState<BankPage>('auto');
  const [cycle, setCycle] = useState(false);
  const [pinned, setPinned] = useState<string[]>([]);
  const [help, setHelp] = useState(false);
  const hq = hqById(view.hqId)!;
  const outage = view.power.outageUntil !== null;
  const prep = view.phase === 'preparation';
  const reduced = isReducedMotion();

  const camByNode = useMemo(() => new Map(view.cameras.map((c) => [c.nodeId, c])), [view.cameras]);
  const camById = useMemo(() => new Map(view.cameras.map((c) => [c.cameraId, c])), [view.cameras]);
  const camNo = useMemo(() => new Map(view.cameras.map((c, i) => [c.cameraId, i + 1])), [view.cameras]);
  const sources = useGame((s) => s.cameraStatuses);
  // Live-capable cameras first among equals (approaches, then equal hop distance): stills stay, just after them.
  const approachCams = liveFirst(hq.approaches.map((a) => camByNode.get(a.fromNode)).filter(Boolean) as CameraView[], (c) => c.cameraId, () => 0, sources);
  // Default main monitor (until the player picks one): a live-capable approach camera when there is one. Latched, and
  // only ever upgraded still -> live, so it never flips back and forth as camera health changes.
  const defaultMain = useRef<string | null>(null);
  const preferred = preferLive(approachCams, (c) => c.cameraId, sources);
  if (preferred && (!defaultMain.current || (!isLiveCapable(sources[defaultMain.current]) && isLiveCapable(sources[preferred.cameraId]))))
    defaultMain.current = preferred.cameraId;
  const mainCam =
    (selectedCamera && camById.get(selectedCamera)) || (defaultMain.current ? camById.get(defaultMain.current) : undefined) || approachCams[0] || view.cameras[0];

  const alertNodes = useMemo(
    () => new Set(view.sightings.filter((s) => t - s.t < ALERT_MS && !s.flaggedFalse).map((s) => s.nodeId)),
    [view.sightings, t],
  );

  // AUTO bank: pins, HQ approaches, recent sightings, faulted cameras, then nearest to HQ.
  const autoBank = useMemo(() => {
    const ids: string[] = [];
    const add = (id?: string) => id && !ids.includes(id) && ids.length < BANK_SIZE && ids.push(id);
    pinned.forEach(add);
    approachCams.forEach((c) => add(c.cameraId));
    [...view.sightings].reverse().forEach((s) => add(camByNode.get(s.nodeId)?.cameraId));
    view.cameras.filter((c) => c.status !== 'ok').forEach((c) => add(c.cameraId));
    liveFirst(view.cameras, (c) => c.cameraId, (c) => graph.hopsToHq(c.nodeId, view.hqId), sources).forEach((c) => add(c.cameraId));
    return ids.map((id) => camById.get(id)!).filter(Boolean);
  }, [view, approachCams, camByNode, camById, pinned, sources]);
  const pages = Math.ceil(view.cameras.length / BANK_SIZE);
  const pageCams = (p: BankPage) => (p === 'auto' ? autoBank : view.cameras.slice(p * BANK_SIZE, (p + 1) * BANK_SIZE));
  const bankCams = pageCams(page);
  const pageAlerts = new Set<BankPage>();
  (['auto', ...Array.from({ length: pages }, (_, i) => i)] as BankPage[]).forEach((p) => {
    if (pageCams(p).some((c) => alertNodes.has(c.nodeId) || c.manifestation)) pageAlerts.add(p);
  });

  useEffect(() => {
    if (!cycle) return;
    const id = setInterval(() => setPage((p) => (p === 'auto' ? 0 : (p + 1) % pages)), CYCLE_MS);
    return () => clearInterval(id);
  }, [cycle, pages]);

  const selectCamera = useCallback(
    (id: string) => {
      const st = useGame.getState();
      if (id !== st.selectedCamera) audio.play('cameraSwitch');
      const cam = camById.get(id);
      set({ selectedCamera: id, selectedNode: cam?.nodeId ?? st.selectedNode });
    },
    [camById, set],
  );
  const selectNode = useCallback(
    (nodeId: string) => {
      set({ selectedNode: nodeId });
      const cam = camByNode.get(nodeId);
      if (cam) selectCamera(cam.cameraId);
    },
    [camByNode, selectCamera, set],
  );

  const act = useCallback(
    async (a: DefenderAction): Promise<boolean> => {
      if (spectator) return false;
      const res = await sendAction(a);
      if (res.ok) {
        const sfx = ACTION_SFX[a.type];
        if (sfx) audio.play(sfx, { volume: 0.55 });
      } else audio.play('doorBlocked', { volume: 0.35 });
      return res.ok;
    },
    [spectator],
  );

  const togglePin = useCallback((id: string) => {
    audio.play('uiClick', { volume: 0.5 });
    setPinned((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(-MAX_PINS)));
  }, []);

  const locate = useCallback(
    (e: VisibleEvent) => {
      const ap = e.approachId ? hq.approaches.find((a) => a.id === e.approachId) : undefined;
      const camId =
        e.cameraId ?? (e.nodeId ? camByNode.get(e.nodeId)?.cameraId : undefined) ?? (ap ? camByNode.get(ap.fromNode)?.cameraId : undefined);
      if (camId) selectCamera(camId);
      if (e.nodeId) set({ selectedNode: e.nodeId });
    },
    [camByNode, hq, selectCamera, set],
  );

  const jumpToLatest = useCallback(() => {
    const s = [...view.sightings].reverse().find((x) => !x.flaggedFalse && t - x.t < 30_000);
    const nodeId = s?.nodeId ?? view.lastKnown?.nodeId ?? view.held?.nodeId;
    if (nodeId) selectNode(nodeId);
  }, [view, t, selectNode]);

  // When a trap springs, put the held node on the main monitor once.
  const heldAt = view.held?.nodeId ?? null;
  const prevHeld = useRef<string | null>(null);
  useEffect(() => {
    if (heldAt && heldAt !== prevHeld.current) {
      const cam = camByNode.get(heldAt);
      if (cam) selectCamera(cam.cameraId);
    }
    prevHeld.current = heldAt;
  }, [heldAt, camByNode, selectCamera]);

  // Keyboard: see SHORTCUTS in ./defender/Atmosphere. The handler is refreshed every render through a ref and
  // the window listener is bound once (re-binding at the 10 Hz view rate churned listeners for nothing).
  const keyState = useRef({ bankCams, mainCam, view, pages });
  keyState.current = { bankCams, mainCam, view, pages };
  const onKeyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  onKeyRef.current = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const { bankCams: bc, mainCam: mc, view: v, pages: pg } = keyState.current;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === 'Escape') {
      setHelp(false);
      set({ mapTool: 'inspect' });
      return;
    }
    if (k === '?') return setHelp((h) => !h);
    if (/^[1-9]$/.test(k)) {
      const c = bc[Number(k) - 1];
      if (c) selectCamera(c.cameraId);
      return;
    }
    if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') {
      if (el && el.closest('[role=tablist],[role=toolbar]')) return;
      e.preventDefault();
      const i = Math.max(
        0,
        bc.findIndex((c) => c.cameraId === mc?.cameraId),
      );
      const d = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -4, ArrowDown: 4 }[k];
      const n = bc[(i + d + bc.length) % bc.length];
      if (n) selectCamera(n.cameraId);
      return;
    }
    if (k === '[' || k === ']') {
      const order: BankPage[] = ['auto', ...Array.from({ length: pg }, (_, i) => i)];
      setPage((p) => order[(order.indexOf(p) + (k === ']' ? 1 : -1) + order.length) % order.length]!);
      audio.play('uiHover', { volume: 0.5 });
      return;
    }
    if (k === 'o') return setCycle((c) => !c);
    if (k === 'v') return jumpToLatest();
    if (k === 'p' && mc) return togglePin(mc.cameraId);
    if (spectator) return;
    if (k in TOOL_KEYS) return set({ mapTool: TOOL_KEYS[k]! });
    if (k === 'r' && mc && (mc.status === 'sabotaged' || mc.status === 'static'))
      return void act({ type: 'repair', cameraId: mc.cameraId });
    const di = DOOR_KEYS.indexOf(k);
    if (di >= 0 && v.doors[di]) {
      const d = v.doors[di]!;
      return void act({ type: 'door', approachId: d.approachId, closed: !d.closed });
    }
    if (k === 'h' && v.held) return void act({ type: 'containment', engage: !v.containment });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => onKeyRef.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onNodeClick = (nodeId: string) => {
    if (spectator || tool === 'inspect') return selectNode(nodeId);
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
  const doorClosed = Object.fromEntries(view.doors.map((d) => [d.approachId, d.closed]));
  const doors = Object.fromEntries(
    view.doors.map((d) => [
      d.approachId,
      { closed: d.closed, heat: d.heat, jammed: d.jammedUntil !== null && d.jammedUntil > t, battering: d.battering },
    ]),
  );
  const scanPreview = tool === 'scan' && selectedNode ? new Set(graph.within(selectedNode, CFG.scan.radiusHops)) : undefined;

  const ctx: RoomCtx = { view, t, hq, spectator, prep, outage, reduced, act, camById, camByNode, camNo, selectCamera, selectNode };
  const powerFrac = view.power.value / view.power.max;
  const showConsole = !!view.held;

  // First-match coaching: hints tied to what is on screen right now (see src/coach).
  const rootRef = useRef<HTMLDivElement>(null);
  const hintsOn = useHintsOn('defender') && !spectator;
  const coachSeen = useCoachPrefs().seen;
  const hints = hintsOn
    ? defenderHints({ view, t, hq, mainNodeId: mainCam?.nodeId ?? null, seen: new Set(coachSeen) })
    : [];

  return (
    <div
      ref={rootRef}
      className={clsx('relative flex flex-col', reduced && 'fnab-reduced')}
      style={{ height: '100%' }}
      data-testid="defender-screen"
    >
      <DefenderStyles />
      <TopBar room={room} view={view} accent="cyan">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-dim">Power</span>
          <div className="relative h-2.5 w-14 min-w-8 max-w-[200px] shrink border border-edge bg-ink min-[1360px]:w-auto min-[1360px]:flex-1">
            <div
              className={clsx('h-full transition-[width] duration-200', outage ? 'bg-alert' : powerFrac < 0.25 ? 'bg-warn' : 'bg-ok')}
              style={{ width: `${Math.max(0, powerFrac) * 100}%` }}
            />
          </div>
          <span
            className={clsx('shrink-0 whitespace-nowrap font-mono text-[12px] tabular-nums', outage ? 'text-[#ff8a93]' : 'text-bright')}
            data-testid="power"
          >
            {outage ? `OUT ${Math.ceil((view.power.outageUntil! - t) / 1000)}s` : `${Math.round(view.power.value)}/${view.power.max}`}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2" title="Threat from sightings and sensor reports">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-dim">Threat</span>
          <div className="flex gap-0.5" data-testid="threat">
            {[0.2, 0.4, 0.6, 0.8, 1].map((lv) => (
              <span
                key={lv}
                className={clsx(
                  'h-3 w-3.5 border border-edge',
                  view.threat >= lv - 0.01 ? (lv >= 0.8 ? 'bg-alert' : lv >= 0.6 ? 'bg-warn' : 'bg-cyan/70') : 'bg-ink',
                  view.threat >= 0.79 && lv >= 0.8 && view.threat >= lv - 0.01 && !reduced && 'animate-pulse',
                )}
              />
            ))}
          </div>
          <span
            className={clsx(
              'hidden w-[68px] whitespace-nowrap font-mono text-[11px] uppercase tracking-[0.1em] min-[1360px]:inline',
              view.threat >= 0.79 ? 'text-[#ff8a93]' : view.threat >= 0.59 ? 'text-[#f3d28d]' : 'text-mute',
            )}
          >
            {THREAT_WORD(view.threat)}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setHelp(true)}
          className={clsx('h-6 border border-edge px-1.5 font-mono text-[10.5px] text-mute hover:border-mute hover:text-text', FOCUS)}
          title="Keyboard shortcuts (?)"
          data-testid="shortcuts"
        >
          ?<span className="hidden min-[1360px]:inline"> Keys</span>
        </button>
      </TopBar>
      <TeamSignalBanner view={view} perspective="defenders" />

      <AlertTicker ctx={ctx} onLocate={locate} onJump={jumpToLatest} />

      <div
        className="relative grid min-h-0 flex-1 grid-cols-1 gap-1.5 p-1.5 max-lg:auto-rows-max max-lg:overflow-y-auto md:max-lg:grid-cols-2 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_clamp(300px,24vw,460px)]"
        data-testid="defender-grid"
      >
        <BlackoutCurtain ctx={ctx} />
        {/* LEFT: monitors */}
        <div className="flex min-h-0 flex-col gap-1.5 max-lg:contents">
          <div className="flex min-h-0 flex-[1.2] flex-col max-lg:order-1 max-lg:min-h-[260px]">
            <MainFeed
              ctx={ctx}
              cam={mainCam}
              pinned={!!mainCam && pinned.includes(mainCam.cameraId)}
              onPin={() => mainCam && togglePin(mainCam.cameraId)}
            />
          </div>
          {showConsole ? (
            <ContainmentConsole ctx={ctx} className="flex-1 max-lg:order-3 max-lg:min-h-[380px] md:max-lg:col-span-2" />
          ) : (
            <MonitorBank
              ctx={ctx}
              cams={bankCams}
              page={page}
              pages={pages}
              setPage={(p) => {
                audio.play('uiHover', { volume: 0.5 });
                setPage(p);
              }}
              pageAlerts={pageAlerts}
              cycle={cycle}
              setCycle={setCycle}
              mainId={mainCam?.cameraId}
              pinned={pinned}
              alertNodes={alertNodes}
              className="flex-1 max-lg:order-5 max-lg:h-[400px] md:max-lg:col-span-2"
            />
          )}
        </div>

        {/* CENTER: map + field devices */}
        <Bay
          title="Tactical map"
          led={view.lastScan && t - view.lastScan.t < 4000 ? 'cyan' : alertNodes.size ? 'alert' : 'ok'}
          right={
            <span className="font-mono text-[10.5px] text-dim">
              {view.sightings.filter((s) => !s.flaggedFalse).length} sightings · {view.sensors.length} sensors · {view.traps.length} traps
            </span>
          }
          bodyClass="flex flex-col"
          className="max-lg:order-4 max-lg:h-[clamp(540px,110vw,720px)] md:max-lg:col-span-2"
        >
          <div className="relative min-h-0 flex-1">
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
              breachProgress={view.breach?.progress}
              doorClosed={doorClosed}
              doors={doors}
              threat={view.threat}
              containmentProgress={view.containment?.active ? view.containment.progress : null}
              selectedNode={selectedNode}
              onNodeClick={onNodeClick}
              cursorHint={tool !== 'inspect' && !spectator ? `${tool.toUpperCase()}: click a node · Esc to cancel` : undefined}
            />
          </div>
          {!spectator && <ToolDock ctx={ctx} tool={tool} setTool={(x) => set({ mapTool: x })} />}
          <NodeInspector ctx={ctx} nodeId={selectedNode} />
        </Bay>

        {/* RIGHT: HQ systems */}
        <div className="flex min-h-0 flex-col gap-1.5 overflow-y-auto max-lg:contents">
          {/* Below lg these wrappers become grid cells (doors stay near the top); on desktop they vanish. */}
          <div className="flex flex-col gap-1.5 max-lg:order-2 lg:contents">
            <PowerPanel ctx={ctx} />
            <DoorsPanel ctx={ctx} />
          </div>
          <div className="flex flex-col gap-1.5 max-lg:order-6 max-lg:h-[420px] md:max-lg:col-span-2 lg:contents">
            {!showConsole && <ContainmentStandby ctx={ctx} />}
            <TeamLog ctx={ctx} room={room} onLocate={locate} />
          </div>
        </div>
      </div>

      <ThreatVignette view={view} reduced={reduced} />
      <PhaseAnnouncer phase={view.phase} />
      <DefenderMoments view={view} t={t} hq={hq} spectator={spectator} />
      {hintsOn && <CoachLayer role="defender" hints={hints} rootRef={rootRef} paused={help} />}
      {help && <HelpSheet onClose={() => setHelp(false)} />}
    </div>
  );
}
