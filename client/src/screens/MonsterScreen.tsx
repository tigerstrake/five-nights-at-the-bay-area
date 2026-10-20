import { useEffect, useMemo } from 'react';
import clsx from 'clsx';
import type { MonsterCommand, MonsterStance, MonsterView, RoomView } from '@fnab/shared';
import { DEFAULT_CONFIG } from '@fnab/shared';
import { useGame, matchNow } from '../state/store';
import { sendAction } from '../net/socket';
import { MapPanel } from '../map/MapPanel';
import type { MarkKind } from '../map/TacticalMap';
import { Badge, Button, Label, Meter, Panel } from '../ui/kit';
import { EventLog, TopBar } from './hud';
import { graph, hqById, nodeName } from '../lib/data';
import { useNow } from '../hooks/useNow';
import { CameraFeed } from '../feeds/CameraFeed';

const STANCES: Array<{ id: MonsterStance; desc: string }> = [
  { id: 'HUNT', desc: 'Stalk the HQ; drawn to disturbances. Breaches once the night escalates.' },
  { id: 'HIDE', desc: 'Slow. Very hard to see. Creeps between blind spots. Never breaches.' },
  { id: 'FLANK', desc: 'Route to the least-defended door, avoiding known sensors.' },
  { id: 'ATTACK', desc: 'Fast and loud. Go straight for a door and breach it.' },
  { id: 'RETREAT', desc: 'Fall back away from HQ. When trapped: struggle free.' },
];

export function MonsterScreen({ room, view }: { room: RoomView; view: MonsterView }) {
  useNow(200);
  const t = matchNow(view);
  const tool = useGame((s) => s.monsterTool);
  const selectedNode = useGame((s) => s.selectedNode);
  const set = useGame((s) => s.set);
  const hq = hqById(view.hqId)!;
  const self = view.self;
  const prep = view.phase === 'preparation';
  const here = self.nodeId;
  const origins = self.moving ? [self.moving.from, self.moving.to] : here ? [here] : [];
  const camStatusByNode = useMemo(() => Object.fromEntries(view.cameras.map((c) => [c.nodeId, c.status])), [view.cameras]);

  const inRange = (hops: number) => {
    const s = new Set<string>();
    for (const o of origins) for (const n of graph.within(o, hops)) s.add(n);
    return s;
  };
  const sabotageRange = inRange(DEFAULT_CONFIG.monster.sabotageRangeHops);
  const decoyRange = new Set([...inRange(DEFAULT_CONFIG.monster.decoyRangeHops)].filter((n) => camStatusByNode[n] === 'ok'));
  const reachable = new Set(origins.flatMap((o) => graph.neighbors(o)));

  const cd = (c: MonsterCommand) => Math.max(0, self.cooldowns[c] - t);

  const issue = (command: MonsterStance, approachId?: string) => void sendAction({ type: 'command', command, approachId });
  const targetStance: MonsterStance =
    self.stance === 'HUNT' || self.stance === 'FLANK' || self.stance === 'ATTACK' ? self.stance : 'ATTACK';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') set({ monsterTool: 'move' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [set]);

  const onNodeClick = (nodeId: string) => {
    set({ selectedNode: nodeId });
    if (prep) {
      if (view.spawnOptions.includes(nodeId)) void sendAction({ type: 'chooseSpawn', nodeId });
      return;
    }
    if (tool === 'sabotage') {
      const known = view.knownSensors.find((s) => s.nodeId === nodeId);
      const camOk = camStatusByNode[nodeId] && camStatusByNode[nodeId] !== 'sabotaged';
      void sendAction({ type: 'sabotage', nodeId, target: camOk || !known ? 'camera' : 'sensor' }).then(
        (r) => r.ok && set({ monsterTool: 'move' }),
      );
    } else if (tool === 'decoy') {
      void sendAction({ type: 'decoy', nodeId }).then((r) => r.ok && set({ monsterTool: 'move' }));
    }
  };

  const marks: Record<string, MarkKind[]> = {};
  const addMark = (n: string, m: MarkKind) => (marks[n] ??= []).push(m);
  view.knownSensors.forEach((s) => addMark(s.nodeId, s.disabledUntil ? 'sensorOff' : 'knownSensor'));
  view.disturbances.forEach((d) => addMark(d.nodeId, 'disturbance'));
  view.scanPulses.filter((p) => t - p.t < 20_000).forEach((p) => addMark(p.nodeId, 'scanPulse'));
  view.exposures.filter((p) => t - p.t < 30_000).forEach((p) => addMark(p.nodeId, 'exposure'));
  if (prep) view.spawnOptions.forEach((n) => addMark(n, 'spawn'));

  const path = self.moving ? [self.moving.from, self.moving.to, ...self.path] : here ? [here, ...self.path] : [];
  const highlight = prep ? new Set(view.spawnOptions) : tool === 'sabotage' ? sabotageRange : tool === 'decoy' ? decoyRange : reachable;
  const hereCam = here ? view.cameras.find((c) => c.nodeId === here) : undefined;
  const risk = here ? riskAt(view, here, t) : 0;
  const knownDoor = (id: string) => view.knownDoors.find((d) => d.approachId === id);

  return (
    <div className="flex h-full flex-col bg-[radial-gradient(ellipse_at_30%_20%,#14070b_0%,#050607_60%)]" data-testid="monster-screen">
      <TopBar room={room} view={view} accent="monster">
        <div className="flex items-center gap-2">
          <Label>Target</Label>
          <span className="text-sm font-semibold text-monster-hi">{hq.name}</span>
        </div>
        <div className="flex items-center gap-2">
          <Label>Their power</Label>
          <Badge tone={view.powerLevel === 'high' ? 'ok' : view.powerLevel === 'medium' ? 'warn' : 'alert'}>{view.powerLevel}</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Label>Stance</Label>
          <Badge tone="monster">
            <span data-testid="stance">{self.stance}</span>
          </Badge>
        </div>
      </TopBar>

      {(view.breach || self.held) && (
        <div
          className={clsx(
            'flex items-center justify-center gap-4 border-b px-3 py-1.5 font-mono text-xs uppercase tracking-[0.2em]',
            self.held ? 'animate-pulse border-alert bg-alert-dim/70 text-[#ffd0d4]' : 'border-monster bg-[#2a0b12] text-[#ffc2cc]',
          )}
        >
          {self.held ? (
            <>
              <span>{self.held.contained ? 'CONTAINMENT FIELD — break free!' : 'TRAPPED'}</span>
              {view.containment && <Meter value={view.containment.progress} tone="alert" className="w-40" label="capture" />}
              <span>struggle</span>
              <Meter value={self.held.struggle} tone="monster" className="w-40" />
              {!self.held.struggling && (
                <Button size="sm" tone="monster" disabled={cd('RETREAT') > 0} onClick={() => issue('RETREAT')}>
                  {cd('RETREAT') > 0 ? `Struggle ${Math.ceil(cd('RETREAT') / 1000)}s` : 'Struggle (RETREAT)'}
                </Button>
              )}
            </>
          ) : (
            view.breach && (
              <>
                <span>Breaching {hq.approaches.find((a) => a.id === view.breach!.approachId)?.door}</span>
                <Meter value={view.breach.progress} tone="monster" className="w-56" />
                <span>{view.breach.stalled ? 'DOOR SEALED — battering' : 'TEARING THROUGH'}</span>
              </>
            )
          )}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 p-2 xl:grid-cols-[minmax(0,1.6fr)_minmax(360px,1fr)]">
        <Panel
          title={prep ? 'Choose where you emerge' : 'The network'}
          right={
            <span className="font-mono text-[10px] text-mute">
              {prep
                ? `Spawn: ${nodeName(self.spawnChoice) || 'random'}`
                : self.moving
                  ? `${nodeName(self.moving.from)} → ${nodeName(self.moving.to)}`
                  : `At ${nodeName(here)}`}
            </span>
          }
          className="min-h-[360px]"
        >
          <MapPanel
            hqId={view.hqId}
            cameraStatus={camStatusByNode}
            marks={marks}
            monster={self.spawned ? { nodeId: self.nodeId, moving: self.moving } : null}
            path={path}
            highlight={highlight}
            highlightTone={tool === 'move' && !prep ? 'monster' : 'warn'}
            breachApproachId={view.breach?.approachId ?? null}
            doorClosed={Object.fromEntries(view.knownDoors.map((d) => [d.approachId, d.closed]))}
            selectedNode={prep ? self.spawnChoice : selectedNode}
            onNodeClick={onNodeClick}
            cursorHint={
              prep
                ? 'Click a red-ringed spawn point'
                : tool !== 'move'
                  ? `${tool.toUpperCase()} — click a highlighted node · Esc`
                  : undefined
            }
          />
        </Panel>

        <div className="flex min-h-0 flex-col gap-2 overflow-auto">
          <Panel title="Commands" className="shrink-0">
            <div className="flex flex-col gap-1.5 p-2" data-testid="commands">
              {STANCES.map((s) => {
                const left = cd(s.id);
                const active = self.stance === s.id;
                return (
                  <div
                    key={s.id}
                    className={clsx(
                      'flex items-center gap-2 border px-2 py-1.5',
                      active ? 'border-monster bg-[#2a0b12]' : 'border-edge bg-panel-2/60',
                    )}
                  >
                    <Button
                      tone={active ? 'monster' : 'neutral'}
                      className="w-24"
                      disabled={left > 0 && !active}
                      onClick={() =>
                        issue(
                          s.id,
                          s.id === 'ATTACK' || s.id === 'FLANK' || s.id === 'HUNT' ? (self.targetApproachId ?? undefined) : undefined,
                        )
                      }
                      data-testid={`cmd-${s.id}`}
                    >
                      {left > 0 ? `${Math.ceil(left / 1000)}s` : s.id}
                    </Button>
                    <div className="min-w-0 flex-1 text-[11px] leading-snug text-mute">{s.desc}</div>
                  </div>
                );
              })}
              <div className="mt-1">
                <Label>Door target (HUNT / FLANK / ATTACK)</Label>
                <div className="mt-1 grid grid-cols-4 gap-1">
                  <Button
                    size="sm"
                    tone={!self.targetApproachId ? 'monster' : 'ghost'}
                    onClick={() => issue(targetStance)}
                    disabled={targetStance !== self.stance && cd(targetStance) > 0}
                  >
                    AI pick
                  </Button>
                  {hq.approaches.map((ap) => {
                    const d = knownDoor(ap.id);
                    return (
                      <Button
                        key={ap.id}
                        size="sm"
                        tone={self.targetApproachId === ap.id ? 'monster' : 'ghost'}
                        disabled={targetStance !== self.stance && cd(targetStance) > 0}
                        onClick={() => issue(targetStance, ap.id)}
                        title={ap.label}
                        data-testid={`target-${ap.id}`}
                      >
                        {ap.door.replace('Door ', '')}
                        {d && (
                          <span className={d.jammed ? 'text-warn' : d.closed ? 'text-ok' : 'text-dim'}>
                            {' '}
                            {d.jammed ? 'J' : d.closed ? '■' : '□'}
                          </span>
                        )}
                      </Button>
                    );
                  })}
                </div>
              </div>
            </div>
          </Panel>

          <Panel title="Abilities" className="shrink-0">
            <div className="grid grid-cols-2 gap-2 p-2">
              <AbilityButton
                name="SABOTAGE"
                left={cd('SABOTAGE')}
                active={tool === 'sabotage'}
                disabled={prep || !!self.held}
                desc={`Kill a camera or known sensor within ${DEFAULT_CONFIG.monster.sabotageRangeHops} hop`}
                onClick={() => set({ monsterTool: tool === 'sabotage' ? 'move' : 'sabotage' })}
              />
              <AbilityButton
                name="DECOY"
                left={cd('DECOY')}
                active={tool === 'decoy'}
                disabled={prep}
                desc={`Fake sighting on a working camera ≤${DEFAULT_CONFIG.monster.decoyRangeHops} hops`}
                onClick={() => set({ monsterTool: tool === 'decoy' ? 'move' : 'decoy' })}
              />
            </div>
          </Panel>

          <div className="grid shrink-0 grid-cols-2 gap-2">
            <Panel title="Risk here">
              <div className="flex flex-col gap-1.5 p-2 text-[11px]">
                <Meter value={risk} tone={risk > 0.6 ? 'alert' : risk > 0.3 ? 'warn' : 'ok'} />
                <div className="text-mute">
                  CAM:{' '}
                  <span className={hereCam?.status === 'ok' ? 'text-alert' : 'text-ok'}>
                    {hereCam ? (hereCam.status === 'ok' ? 'WATCHING' : hereCam.status.toUpperCase()) : 'none'}
                  </span>
                </div>
                <div className="text-mute">
                  Known sensors nearby:{' '}
                  {here ? view.knownSensors.filter((s) => s.nodeId === here || graph.neighbors(here).includes(s.nodeId)).length : 0}
                </div>
                <div className="text-mute">Hops to HQ: {here ? graph.hopsToHq(here, view.hqId) : '—'}</div>
              </div>
            </Panel>
            <Panel title="Through the lens" bodyClass="relative min-h-[110px]">
              {hereCam ? (
                <CameraFeed
                  cameraId={hereCam.cameraId}
                  nodeId={hereCam.nodeId}
                  variant="thumb"
                  status={hereCam.status}
                  interference={0.5}
                  manifestation={null}
                  t0Epoch={view.t0Epoch}
                  className="absolute inset-0"
                />
              ) : (
                <div className="p-2 text-[11px] text-dim">{self.spawned ? 'No camera here' : 'Not yet emerged'}</div>
              )}
            </Panel>
          </div>

          <Panel title="Objectives" className="shrink-0">
            <ul className="flex flex-col gap-1 p-2 text-[11px] text-mute">
              <li>
                ▸ Breach a door of <span className="text-bright">{hq.name}</span> before dawn.
              </li>
              <li>
                ▸ Doors you've seen:{' '}
                {view.knownDoors.length
                  ? view.knownDoors
                      .map(
                        (d) =>
                          `${hq.approaches.find((a) => a.id === d.approachId)?.door.replace('Door ', '')}:${d.jammed ? 'jammed' : d.closed ? 'sealed' : 'open'}`,
                      )
                      .join(' · ')
                  : 'none yet'}
              </li>
              <li>▸ Traps are invisible to you. Vary your route.</li>
            </ul>
          </Panel>

          <Panel title="AI feedback" className="min-h-[160px] flex-1" bodyClass="overflow-auto">
            <EventLog events={view.events} view={view} />
          </Panel>
        </div>
      </div>
    </div>
  );
}

function AbilityButton({
  name,
  left,
  active,
  disabled,
  desc,
  onClick,
}: {
  name: string;
  left: number;
  active: boolean;
  disabled?: boolean;
  desc: string;
  onClick: () => void;
}) {
  const total = DEFAULT_CONFIG.monster.cooldownMs[name as MonsterCommand];
  return (
    <button
      onClick={onClick}
      disabled={disabled || left > 0}
      data-testid={`ability-${name}`}
      className={clsx(
        'relative overflow-hidden border px-2 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        active ? 'border-monster-hi bg-[#3a0f19]' : 'border-edge bg-panel-2 hover:border-monster',
      )}
    >
      {left > 0 && <span className="absolute inset-y-0 left-0 bg-monster/20" style={{ width: `${(left / total) * 100}%` }} />}
      <div className="relative font-mono text-xs uppercase tracking-[0.18em] text-bright">
        {name} {left > 0 && <span className="text-dim">{Math.ceil(left / 1000)}s</span>}
        {active && <span className="ml-1 text-monster-hi">· targeting</span>}
      </div>
      <div className="relative mt-0.5 text-[10px] leading-snug text-mute">{desc}</div>
    </button>
  );
}

function riskAt(view: MonsterView, node: string, t: number): number {
  let r = 0;
  const cam = view.cameras.find((c) => c.nodeId === node);
  if (cam?.status === 'ok') r += 0.35;
  const near = new Set([node, ...graph.neighbors(node)]);
  r += 0.2 * view.knownSensors.filter((s) => !s.disabledUntil && near.has(s.nodeId)).length;
  if (view.exposures.some((e) => near.has(e.nodeId) && t - e.t < 20_000)) r += 0.3;
  if (view.scanPulses.some((e) => near.has(e.nodeId) && t - e.t < 20_000)) r += 0.2;
  return Math.min(1, r);
}
