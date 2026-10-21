// Monster player's strategic command interface: the creature's mind. Map + command deck + what it knows.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MonsterCommand, MonsterStance, MonsterView, RoomView } from '@fnab/shared';
import { useGame, matchNow } from '../state/store';
import { sendAction } from '../net/socket';
import { MapPanel } from '../map/MapPanel';
import type { MarkKind } from '../map/TacticalMap';
import { Badge, Label } from '../ui/kit';
import { TopBar, hqShortName } from './hud';
import { hqById, nodeName } from '../lib/data';
import { useNow } from '../hooks/useNow';
import { audio } from '../audio';
import { isReducedMotion } from '../fx';
import { situation, STANCE_INFO, STANCE_ORDER, ABILITY_INFO } from './monster/model';
import { CommandDeck, useReadyEdges } from './monster/CommandDeck';
import { LensPanel } from './monster/LensPanel';
import { EmergencePanel, IntentStream, NightBar, SituationPanel } from './monster/SidePanels';
import { BreachBanner, Legend, PositionPlate, TargetingBar, TrappedOverlay } from './monster/MapOverlays';
import './monster/monster.css';

const FONT_ID = 'mx-display-font';
function useDisplayFont() {
  useEffect(() => {
    if (document.getElementById(FONT_ID)) return;
    const l = document.createElement('link');
    l.id = FONT_ID;
    l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@600;700;800&display=swap';
    document.head.appendChild(l);
  }, []);
}

function useCalm(): boolean {
  const [calm, setCalm] = useState(() => isReducedMotion());
  useEffect(() => {
    const id = setInterval(() => setCalm(isReducedMotion()), 1000);
    return () => clearInterval(id);
  }, []);
  return calm;
}

type Pending = { nodeId: string; target: 'camera' | 'sensor' } | null;

export function MonsterScreen({ room, view }: { room: RoomView; view: MonsterView }) {
  useNow(200);
  useDisplayFont();
  const calm = useCalm();
  const t = matchNow(view);
  const tool = useGame((s) => s.monsterTool);
  const set = useGame((s) => s.set);
  const hq = hqById(view.hqId)!;
  const self = view.self;
  const prep = view.phase === 'preparation';
  const sit = useMemo(() => situation(view, t), [view, Math.floor(t / 500)]); // eslint-disable-line react-hooks/exhaustive-deps

  const [pending, setPending] = useState<Pending>(null);
  const [doorPref, setDoorPref] = useState<string | null>(self.targetApproachId);
  const [hoverSpawn, setHoverSpawn] = useState<string | null>(null);
  const [stamps, setStamps] = useState<Partial<Record<MonsterCommand, number>>>({});
  const lastIssue = useRef(0);
  const [, force] = useState(0);
  const gapLeft = Math.max(0, lastIssue.current + sit.cfg.monster.globalCommandGapMs - Date.now());
  useEffect(() => {
    if (gapLeft > 0) {
      const id = setTimeout(() => force((x) => x + 1), gapLeft + 20);
      return () => clearTimeout(id);
    }
  }, [gapLeft]);

  // keep door preference in sync with what the server says the creature is doing
  useEffect(() => setDoorPref(self.targetApproachId), [self.targetApproachId]);

  const stamp = (c: MonsterCommand) => setStamps((s) => ({ ...s, [c]: Date.now() }));
  const cd = useCallback((c: MonsterCommand) => Math.max(0, view.self.cooldowns[c] - t), [view, t]);

  useReadyEdges(view, t, (c) => {
    if (c === 'SABOTAGE' || c === 'DECOY' || (c === 'RETREAT' && view.self.held)) audio.play('abilityReady', { volume: 0.6 });
  });

  const setTool = useCallback(
    (next: 'move' | 'sabotage' | 'decoy') => {
      setPending(null);
      set({ monsterTool: next });
    },
    [set],
  );
  // leaving the match or losing the ability's validity drops targeting
  useEffect(() => {
    if (prep && tool !== 'move') setTool('move');
  }, [prep, tool, setTool]);

  const issue = useCallback(
    (s: MonsterStance, approachId?: string | null) => {
      const ap = approachId === undefined ? (s === 'HUNT' || s === 'FLANK' || s === 'ATTACK' ? doorPref : null) : approachId;
      lastIssue.current = Date.now();
      force((x) => x + 1);
      void sendAction({ type: 'command', command: s, approachId: ap ?? undefined }).then((r) => {
        if (r.ok) {
          audio.play('commandIssued');
          stamp(s);
        } else lastIssue.current = 0;
      });
    },
    [doorPref],
  );

  const stanceBlocked = (s: MonsterStance) => {
    const active = self.stance === s && !self.held;
    if (!active && cd(s) > 0) return true;
    if (self.held && s === 'RETREAT' && self.held.struggling) return true;
    return gapLeft > 0;
  };

  const onStance = (s: MonsterStance) => {
    if (stanceBlocked(s)) return;
    if (tool !== 'move') setTool('move');
    issue(s);
  };

  const onDoor = (approachId: string | null) => {
    setDoorPref(approachId);
    audio.play('uiClick', { volume: 0.5 });
    // Re-issuing the active advancing stance retargets for free; otherwise the choice waits for the next advance.
    if ((self.stance === 'HUNT' || self.stance === 'FLANK' || self.stance === 'ATTACK') && !self.held && gapLeft === 0) {
      issue(self.stance, approachId);
    }
  };

  const inflight = useRef(false);
  const confirmTarget = useCallback(() => {
    // Enter can reach both a focused map node and the window handler; send once.
    if (!pending || inflight.current) return;
    inflight.current = true;
    setTimeout(() => (inflight.current = false), 400);
    if (tool === 'sabotage') {
      void sendAction({ type: 'sabotage', nodeId: pending.nodeId, target: pending.target }).then((r) => {
        if (r.ok) {
          audio.play('sabotage');
          stamp('SABOTAGE');
          setTool('move');
        }
      });
    } else if (tool === 'decoy') {
      void sendAction({ type: 'decoy', nodeId: pending.nodeId }).then((r) => {
        if (r.ok) {
          audio.play('decoy');
          stamp('DECOY');
          setTool('move');
        }
      });
    }
  }, [pending, tool, setTool]);

  const toggleAbility = useCallback(
    (id: 'sabotage' | 'decoy') => {
      if (tool === id) return setTool('move');
      const c: MonsterCommand = id === 'sabotage' ? 'SABOTAGE' : 'DECOY';
      if (prep || !self.spawned || cd(c) > 0) return;
      if (id === 'sabotage' && self.held) return;
      audio.play('uiClick', { volume: 0.5 });
      setTool(id);
    },
    [tool, prep, self.spawned, self.held, cd, setTool],
  );

  const onNodeClick = (nodeId: string) => {
    if (prep) {
      if (view.spawnOptions.includes(nodeId)) pickSpawn(nodeId);
      return;
    }
    if (tool === 'sabotage') {
      const tg = sit.sabotageTargets.get(nodeId);
      if (!tg) return audio.play('uiHover', { volume: 0.4 });
      if (pending?.nodeId === nodeId) return confirmTarget();
      setPending({ nodeId, target: tg.camera ? 'camera' : 'sensor' });
      audio.play('uiClick', { volume: 0.5 });
    } else if (tool === 'decoy') {
      if (!sit.decoyTargets.has(nodeId)) return audio.play('uiHover', { volume: 0.4 });
      if (pending?.nodeId === nodeId) return confirmTarget();
      setPending({ nodeId, target: 'camera' });
      audio.play('uiClick', { volume: 0.5 });
    } else {
      // Clicking a door's approach node targets that door.
      const ap = hq.approaches.find((a) => a.fromNode === nodeId);
      set({ selectedNode: nodeId });
      if (ap) onDoor(ap.id);
    }
  };

  const pickSpawn = (nodeId: string) => {
    void sendAction({ type: 'chooseSpawn', nodeId }).then((r) => r.ok && audio.play('uiClick'));
  };

  // hotkeys
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyRef.current = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    const k = e.key.toLowerCase();
    if (k === 'escape') {
      if (pending) setPending(null);
      else setTool('move');
      return;
    }
    if (e.repeat) return;
    if (k === 'enter' && pending) {
      e.preventDefault();
      return confirmTarget();
    }
    if (k === ' ' && self.held) {
      e.preventDefault();
      return onStance('RETREAT');
    }
    const stance = STANCE_ORDER.find((s) => STANCE_INFO[s].key.toLowerCase() === k);
    if (stance) return onStance(stance);
    if (k === ABILITY_INFO.SABOTAGE.key.toLowerCase()) return toggleAbility('sabotage');
    if (k === ABILITY_INFO.DECOY.key.toLowerCase()) return toggleAbility('decoy');
    if (k === '0') return onDoor(null);
    const di = Number(k);
    if (di >= 1 && di <= hq.approaches.length) return onDoor(hq.approaches[di - 1]!.id);
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // ── map layers ───────────────────────────────────────
  const camStatusByNode = useMemo(() => Object.fromEntries(view.cameras.map((c) => [c.nodeId, c.status])), [view.cameras]);
  const marks: Record<string, MarkKind[]> = {};
  const addMark = (n: string, m: MarkKind) => (marks[n] ??= []).push(m);
  view.knownSensors.forEach((s) => addMark(s.nodeId, s.disabledUntil ? 'sensorOff' : 'knownSensor'));
  view.disturbances.forEach((d) => addMark(d.nodeId, 'disturbance'));
  view.scanPulses.filter((p) => t - p.t < 20_000).forEach((p) => addMark(p.nodeId, 'scanPulse'));
  view.exposures.filter((p) => t - p.t < 30_000).forEach((p) => addMark(p.nodeId, 'exposure'));
  if (prep) view.spawnOptions.forEach((n) => addMark(n, 'spawn'));

  const here = self.nodeId;
  const path = self.moving ? [self.moving.from, self.moving.to, ...self.path] : here ? [here, ...self.path] : [];
  const highlight = prep
    ? new Set(view.spawnOptions)
    : tool === 'sabotage'
      ? new Set(sit.sabotageTargets.keys())
      : tool === 'decoy'
        ? sit.decoyTargets
        : undefined;
  const rings =
    tool === 'sabotage' || tool === 'decoy'
      ? sit.origins.map((o) => ({
          nodeId: o,
          hops: tool === 'sabotage' ? sit.cfg.monster.sabotageRangeHops : sit.cfg.monster.decoyRangeHops,
          tone: 'alert' as const,
        }))
      : undefined;
  const doors = Object.fromEntries(view.knownDoors.map((d) => [d.approachId, { closed: d.closed, jammed: d.jammed }]));
  const nodeNotes: Record<string, string[]> = {};
  view.knownSensors.forEach((s) => (nodeNotes[s.nodeId] ??= []).push(s.disabledUntil ? 'Sensor (silenced)' : 'Motion sensor you found'));
  view.exposures.filter((p) => t - p.t < 30_000).forEach((p) => (nodeNotes[p.nodeId] ??= []).push('You may have been seen here'));
  hq.approaches.forEach((a) => (nodeNotes[a.fromNode] ??= []).push(`Approach to ${a.door} — click to target`));
  // Wave-2 map props (optional; ignored by maps that don't support them yet).
  const extraLayers = {
    theme: 'monster' as const,
    doors,
    nodeNotes,
    attackPaths: !prep,
    onNodeHover: prep ? setHoverSpawn : undefined,
    breachProgress: view.breach?.progress,
  };

  // lens: where the creature is (nearer endpoint while moving), or the emergence point in prep
  const lensNode = prep ? (hoverSpawn ?? self.spawnChoice) : sit.focusNode;
  const lensCaption = prep
    ? lensNode
      ? `Emergence · ${nodeName(lensNode)}`
      : ''
    : self.moving
      ? `${self.moving.progress < 0.5 ? 'Leaving' : 'Nearing'} ${nodeName(lensNode)}`
      : nodeName(lensNode);

  const pendingInfo = pending && tool === 'sabotage' ? sit.sabotageTargets.get(pending.nodeId) : null;

  return (
    <div className="mx flex h-full flex-col" data-calm={calm ? '1' : '0'} data-testid="monster-screen">
      <TopBar room={room} view={view} accent="monster">
        <div className="flex min-w-0 items-center gap-2">
          <Label>Prey</Label>
          <span className="max-w-[260px] truncate text-sm font-semibold text-[var(--mx-bone)]" title={hq.name}>
            <span className="hidden min-[1400px]:inline">{hq.name}</span>
            <span className="min-[1400px]:hidden">{hqShortName(hq.id)}</span>
          </span>
        </div>
        <div className="flex items-center gap-2" title="A rough sense of how much power the defenders have left">
          <Label>Power</Label>
          <Badge tone={view.powerLevel === 'high' ? 'neutral' : view.powerLevel === 'medium' ? 'warn' : 'alert'}>{view.powerLevel}</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Label>Stance</Label>
          <Badge tone="monster">
            <span data-testid="stance">{self.stance}</span>
          </Badge>
        </div>
      </TopBar>
      <NightBar view={view} sit={sit} t={t} />

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 p-2 lg:grid-cols-[minmax(0,1fr)_minmax(320px,380px)] lg:grid-rows-[minmax(0,1fr)_auto] 2xl:grid-cols-[minmax(0,1fr)_440px]">
        <section className="mx-slab relative min-h-[340px] overflow-hidden lg:col-start-1 lg:row-start-1">
          <MapPanel
            hqId={view.hqId}
            cameraStatus={camStatusByNode}
            marks={marks}
            monster={self.spawned ? { nodeId: self.nodeId, moving: self.moving } : null}
            path={path}
            highlight={highlight}
            highlightTone="monster"
            rings={rings}
            breachApproachId={view.breach?.approachId ?? null}
            doorClosed={Object.fromEntries(view.knownDoors.map((d) => [d.approachId, d.closed]))}
            selectedNode={prep ? self.spawnChoice : (pending?.nodeId ?? null)}
            onNodeClick={onNodeClick}
            {...extraLayers}
          />
          {prep ? (
            <div className="pointer-events-none absolute left-2 top-2 z-[2] max-w-[60%] border border-[var(--mx-scar)] bg-[#070404e6] px-2.5 py-1.5">
              <div className="mx-slab-title !text-[18px]">Choose where you emerge</div>
              <div className="text-[11px] text-[var(--mx-ash)]">
                Click a ringed point, then pick an opening stance below.{' '}
                {self.spawnChoice ? `Emerging at ${nodeName(self.spawnChoice)}.` : 'Undecided: you will emerge at random.'}
              </div>
            </div>
          ) : (
            tool === 'move' && <PositionPlate view={view} sit={sit} hq={hq} />
          )}
          {(tool === 'sabotage' || tool === 'decoy') && (
            <TargetingBar
              mode={tool}
              pendingName={pending ? nodeName(pending.nodeId) : null}
              pendingKind={pending?.target ?? 'camera'}
              canSwitchKind={!!pendingInfo && pendingInfo.camera && !!pendingInfo.sensor}
              onSwitchKind={() => setPending((p) => (p ? { ...p, target: p.target === 'camera' ? 'sensor' : 'camera' } : p))}
              onConfirm={confirmTarget}
              onCancel={() => setTool('move')}
              range={tool === 'sabotage' ? sit.cfg.monster.sabotageRangeHops : sit.cfg.monster.decoyRangeHops}
              count={tool === 'sabotage' ? sit.sabotageTargets.size : sit.decoyTargets.size}
            />
          )}
          <Legend prep={prep} />
          <BreachBanner view={view} hq={hq} />
          {self.held && tool !== 'decoy' && (
            <TrappedOverlay view={view} t={t} retreatLeft={cd('RETREAT')} calm={calm} onStruggle={() => onStance('RETREAT')} />
          )}
        </section>

        <aside className="flex min-h-0 flex-col gap-2 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <LensPanel view={view} nodeId={lensNode} caption={lensCaption} />
          {prep ? (
            <EmergencePanel view={view} hq={hq} onPick={pickSpawn} onHover={setHoverSpawn} />
          ) : (
            <>
              <SituationPanel view={view} sit={sit} t={t} hq={hq} />
              <IntentStream view={view} />
            </>
          )}
        </aside>

        <div className="lg:col-start-1 lg:row-start-2">
          <CommandDeck
            view={view}
            sit={sit}
            t={t}
            hq={hq}
            tool={tool}
            doorPref={doorPref}
            gapLeft={gapLeft}
            stamps={stamps}
            onStance={onStance}
            onTool={(next) => (next === 'move' ? setTool('move') : toggleAbility(next))}
            onDoor={onDoor}
          />
        </div>
      </div>
    </div>
  );
}
