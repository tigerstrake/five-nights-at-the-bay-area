// Anti-cheat boundary: projects the full GameState into role-specific views.
// Rules:
//  • Defenders/spectators never get: monster position/path/stance/cooldowns, decoy flags, monster knowledge.
//    The only location info they get is from sightings, sensor pings, scans, traps (held) and breaches.
//  • The monster never gets: trap positions, undiscovered sensors, exact power, door states it has not observed,
//    defender sightings/last-known, scan cooldowns.
// Every field is copied explicitly (no object spreading of server state) so new server fields don't leak.
import type { CameraView, DefenderView, Graph, MonsterCommand, MonsterView, VisibleEvent, ViewBase, GameEvent } from '@fnab/shared';
import { MONSTER_COMMANDS, spawnCandidates } from '@fnab/shared';
import type { GameState } from '../engine/state';
import { isOutage, matchEndT, phaseBounds } from '../engine/state';
import { powerDrainPerSec, threatLevel, type EngineCtx } from '../engine/engine';
import { buildMonsterKnowledge, coarsePower, publicCameraStatus } from '../ai/knowledge';

export interface ViewClock {
  t0Epoch: number;
  serverNow: number;
}

function visibleEvents(s: GameState, audience: 'defenders' | 'monster', limit: number): VisibleEvent[] {
  const out: VisibleEvent[] = [];
  for (let i = s.events.length - 1; i >= 0 && out.length < limit; i--) {
    const e: GameEvent = s.events[i]!;
    if (e.audience !== 'all' && e.audience !== audience) continue;
    const v: VisibleEvent = { id: e.id, t: e.t, kind: e.kind, text: e.text, severity: e.severity };
    if (e.nodeId !== undefined) v.nodeId = e.nodeId;
    if (e.cameraId !== undefined) v.cameraId = e.cameraId;
    if (e.approachId !== undefined) v.approachId = e.approachId;
    if (e.by !== undefined && audience === 'defenders') v.by = e.by;
    out.push(v);
  }
  return out.reverse();
}

function base(s: GameState, clock: ViewClock, defenders: boolean): ViewBase {
  const b = phaseBounds(s);
  return {
    t: s.t,
    t0Epoch: clock.t0Epoch,
    serverNow: clock.serverNow,
    phase: s.phase,
    phaseEndsAt: b[s.phase].end,
    matchEndsAt: matchEndT(s),
    hqId: s.hqId,
    defenderCount: s.defenderCount,
    events: visibleEvents(s, defenders ? 'defenders' : 'monster', s.cfg.visibility.eventsInView),
    ended: s.result !== null,
  };
}

export function projectDefenderView(
  ctx: EngineCtx,
  s: GameState,
  clock: ViewClock,
  role: 'defender' | 'spectator' = 'defender',
): DefenderView {
  const threat = threatLevel(ctx, s);
  const outage = isOutage(s);
  const phaseI = s.cfg.visibility.phaseInterference[s.phase];
  const cameras: CameraView[] = Object.values(s.cameras).map((c) => {
    const status = publicCameraStatus(s, c.cameraId);
    const mf = s.manifestations[c.cameraId];
    const manifestation = mf && !outage && status === 'ok' && s.t <= mf.startedAtT + mf.durationMs ? { ...mf } : null;
    const interference = Math.min(
      1,
      phaseI + threat * 0.3 + (status === 'ok' ? 0 : 0.35) + (manifestation ? 0.35 * manifestation.strength : 0),
    );
    return {
      cameraId: c.cameraId,
      nodeId: c.nodeId,
      status,
      repairProgress: c.repair ? Math.min(1, (s.t - c.repair.startedAt) / (c.repair.endsAt - c.repair.startedAt)) : null,
      interference: Math.round(interference * 100) / 100,
      manifestation,
    };
  });
  const visibleSightings = s.sightings
    .filter((x) => s.t - x.t < s.cfg.detection.sightingTtlMs)
    .slice(-s.cfg.visibility.sightingsInView)
    .map((x) => ({ id: x.id, nodeId: x.nodeId, t: x.t, confidence: x.confidence, source: x.source, flaggedFalse: x.flaggedFalse }));
  const lastReal = [...visibleSightings].reverse().find((x) => !x.flaggedFalse && x.source !== 'sensor');
  const m = s.monster;
  const hq = ctx.graph.hqs.get(s.hqId)!;
  return {
    ...base(s, clock, true),
    role,
    power: {
      value: Math.round(s.power.value * 10) / 10,
      max: s.cfg.power.max,
      outageUntil: outage ? s.power.outageUntil : null,
      drainPerSec: Math.round((powerDrainPerSec(s) - (outage ? 0 : s.cfg.power.regenPerSec)) * 100) / 100,
    },
    threat,
    doors: hq.approaches.map((ap) => {
      const d = s.doors[ap.id]!;
      return {
        approachId: ap.id,
        closed: d.closed,
        heat: Math.round(d.heat * 100) / 100,
        jammedUntil: d.jammedUntil !== null && d.jammedUntil > s.t ? d.jammedUntil : null,
        battering: !!s.breach && s.breach.approachId === ap.id && s.breach.stalled,
      };
    }),
    sensors: s.sensors.map((x) => ({
      id: x.id,
      nodeId: x.nodeId,
      disabledUntil: x.disabledUntil !== null && x.disabledUntil > s.t ? x.disabledUntil : null,
      lastPingAt: x.lastPingAt,
    })),
    traps: s.traps.map((x) => ({ id: x.id, nodeId: x.nodeId, armedAt: x.armedAt, live: s.t >= x.armedAt })),
    lures: s.lures.map((x) => ({ id: x.id, nodeId: x.nodeId, expiresAt: x.expiresAt })),
    cameras,
    sightings: visibleSightings,
    lastKnown: lastReal ? { nodeId: lastReal.nodeId, t: lastReal.t } : null,
    held: m.held && m.nodeId ? { nodeId: m.nodeId, until: m.held.until, struggling: m.held.struggling } : null,
    containment: s.containment
      ? { nodeId: s.containment.nodeId, active: true, progress: Math.min(1, s.containment.elapsed / s.cfg.containment.captureMs) }
      : null,
    breach: s.breach ? { approachId: s.breach.approachId, progress: s.breach.progress, stalled: s.breach.stalled } : null,
    repairs: Object.values(s.cameras)
      .filter((c) => c.repair)
      .map((c) => ({ cameraId: c.cameraId, endsAt: c.repair!.endsAt })),
    cooldowns: { scanReadyAt: s.scan.readyAt, lureReadyAt: s.lureReadyAt },
    limits: { sensors: s.cfg.sensors.maxCount, traps: s.cfg.traps.maxCount, repairsConcurrent: s.cfg.repair.maxConcurrent },
    lastScan: s.scan.last ? { ...s.scan.last } : null,
  };
}

export const projectSpectatorView = (ctx: EngineCtx, s: GameState, clock: ViewClock): DefenderView =>
  projectDefenderView(ctx, s, clock, 'spectator');

export function projectMonsterView(ctx: EngineCtx, s: GameState, clock: ViewClock): MonsterView {
  const m = s.monster;
  const k = buildMonsterKnowledge(s, ctx.graph);
  const cooldowns = Object.fromEntries(MONSTER_COMMANDS.map((c) => [c, m.cooldowns[c]])) as Record<MonsterCommand, number>;
  return {
    ...base(s, clock, false),
    role: 'monster',
    spawnOptions: m.spawned ? [] : spawnCandidates(ctx.graph, s.hqId, s.cfg.spawn),
    self: {
      spawned: m.spawned,
      spawnChoice: m.spawnChoice,
      nodeId: m.nodeId,
      moving: m.moving
        ? { from: m.moving.from, to: m.moving.to, edgeId: m.moving.edgeId, progress: Math.min(1, m.moving.elapsed / m.moving.duration) }
        : null,
      path: [...m.path],
      stance: m.stance,
      targetApproachId: m.targetApproachId,
      held: m.held ? { until: m.held.until, contained: m.held.contained, struggle: m.held.struggle, struggling: m.held.struggling } : null,
      cooldowns,
    },
    cameras: Object.values(s.cameras).map((c) => ({ cameraId: c.cameraId, nodeId: c.nodeId, status: publicCameraStatus(s, c.cameraId) })),
    knownSensors: k.knownSensors.map((x) => ({
      id: x.id,
      nodeId: x.nodeId,
      disabledUntil: x.disabled ? (x.disabledUntil ?? null) : null,
    })),
    knownDoors: Object.entries(k.knownDoors).map(([approachId, d]) => ({
      approachId,
      closed: d.closed,
      jammed: d.jammed,
      seenAt: d.seenAt,
    })),
    disturbances: k.disturbances.map((d) => ({ ...d })),
    scanPulses: k.scanPulses.map((d) => ({ ...d })),
    exposures: k.exposures.map((d) => ({ ...d })),
    powerLevel: coarsePower(s),
    breach: s.breach ? { approachId: s.breach.approachId, progress: s.breach.progress, stalled: s.breach.stalled } : null,
    containment: s.containment ? { active: true, progress: Math.min(1, s.containment.elapsed / s.cfg.containment.captureMs) } : null,
  };
}

export function projectView(ctx: EngineCtx, s: GameState, role: 'defender' | 'monster' | 'spectator', clock: ViewClock) {
  if (role === 'monster') return projectMonsterView(ctx, s, clock);
  return projectDefenderView(ctx, s, clock, role);
}

export type { Graph };
