// Pure deterministic simulation. No sockets, IO, timers or Date.now() in here.
//   step(ctx, state, dtMs, rng)               advance the world by dtMs (called at cfg.tickMs)
//   applyAction(ctx, state, actor, action, rng) validate + apply one player action
// The state is mutated in place; determinism = same seed + same action sequence at same ticks ⇒ same match.
import type {
  ActionResult,
  DefenderAction,
  GameEvent,
  Graph,
  ManifestationKind,
  MatchResult,
  MonsterAction,
  MonsterStance,
  Rng,
  Team,
  WinReason,
} from '@fnab/shared';
import { edgeTravelMs, spawnCandidates } from '@fnab/shared';
import type { MonsterBrain } from '../ai/types';
import { buildMonsterKnowledge } from '../ai/knowledge';
import type { GameState, Sighting } from './state';
import { isOutage, matchEndT, monsterEffectiveNode, phaseAt, pushEvent } from './state';

export interface EngineCtx {
  graph: Graph;
  brain: MonsterBrain;
  /** Camera placement region counts by camera id (for manifestation regionIndex). */
  placementCount: (cameraId: string) => number;
}

export type Actor = { team: 'defenders'; playerId: string } | { team: 'monster'; playerId: string };

const ok: ActionResult = { ok: true };
const fail = (error: string): ActionResult => ({ ok: false, error });

// ───────────────────────────── helpers ─────────────────────────────

function nodeName(ctx: EngineCtx, id: string): string {
  return ctx.graph.nodes.get(id)?.name ?? id;
}

function cameraAtNode(ctx: EngineCtx, s: GameState, nodeId: string) {
  const camId = ctx.graph.nodes.get(nodeId)?.cameraId;
  return camId ? (s.cameras[camId] ?? null) : null;
}

function camWorking(s: GameState, cam: { status: string; repair: unknown } | null): boolean {
  return !!cam && cam.status === 'ok' && !isOutage(s);
}

function spendPower(s: GameState, amount: number): boolean {
  if (isOutage(s) || s.power.value < amount) return false;
  s.power.value -= amount;
  s.stats.powerSpent += amount;
  return true;
}

function hq(ctx: EngineCtx, s: GameState) {
  return ctx.graph.hqs.get(s.hqId)!;
}

function travelMultiplier(s: GameState, stance: MonsterStance): number {
  return s.cfg.monster.stanceSpeed[stance] * s.cfg.monster.phaseSpeed[s.phase];
}

function hopsToHq(ctx: EngineCtx, s: GameState, nodeId: string): number {
  return ctx.graph.hopsToHq(nodeId, s.hqId);
}

function byHops<T>(arr: readonly T[], hops: number): T {
  return arr[Math.min(arr.length - 1, Math.max(0, hops))]!;
}

export function threatLevel(ctx: EngineCtx, s: GameState): number {
  const floor = s.cfg.threat.phaseFloor[s.phase];
  const node = monsterEffectiveNode(s);
  let prox = 0;
  if (node) {
    const H = s.cfg.threat.horizonHops;
    prox = 1 - Math.min(H, hopsToHq(ctx, s, node)) / H;
    if (s.monster.stance === 'HIDE') prox *= s.cfg.threat.hideDampen;
  }
  if (s.breach) prox = 1;
  const raw = Math.max(floor, prox);
  const steps = s.cfg.threat.steps;
  return Math.round(raw * steps) / steps;
}

function addManifestation(ctx: EngineCtx, s: GameState, cameraId: string, nodeId: string, confidence: number, rng: Rng) {
  const hops = hopsToHq(ctx, s, nodeId);
  let kind: ManifestationKind = byHops(s.cfg.detection.manifestationByHops, hops);
  // Low-confidence glimpses are never clearer than a silhouette.
  if (confidence < 0.6 && (kind === 'figure' || kind === 'closeup')) kind = 'silhouette';
  const H = s.cfg.threat.horizonHops;
  const strength = Math.max(0.15, Math.min(1, (1 - Math.min(H, hops) / H) * 0.85 + confidence * 0.25));
  const regions = Math.max(1, ctx.placementCount(cameraId));
  const [dmin, dmax] = s.cfg.detection.manifestationMs;
  s.manifestations[cameraId] = {
    kind,
    strength: Math.round(strength * 100) / 100,
    regionIndex: rng.int(0, regions - 1),
    startedAtT: s.t,
    durationMs: Math.round(rng.range(dmin, dmax)),
    seed: rng.int(0, 2 ** 31 - 1),
  };
}

function addSighting(s: GameState, nodeId: string, confidence: number, source: Sighting['source'], isDecoy: boolean): Sighting {
  const sg: Sighting = {
    id: s.nextId++,
    nodeId,
    t: s.t,
    confidence: Math.round(confidence * 100) / 100,
    source,
    flaggedFalse: false,
    isDecoy,
  };
  s.sightings.push(sg);
  if (source === 'camera') s.stats.sightings++;
  if (isDecoy) s.stats.falseSightings++;
  return sg;
}

/** Camera sighting text — identical for real and decoy sightings by design. */
function sightingText(ctx: EngineCtx, nodeId: string, confidence: number): string {
  const label = confidence >= 0.8 ? 'Figure confirmed' : confidence >= 0.6 ? 'Movement' : 'Possible movement';
  return `${label} on CAM ${nodeName(ctx, nodeId)} (${Math.round(confidence * 100)}%)`;
}

export function endMatch(s: GameState, winner: Team, reason: WinReason, approachId: string | null = null): void {
  if (s.result) return;
  const ev: GameEvent = pushEvent(
    s,
    reason === 'breach' ? 'breached' : reason === 'capture' ? 'captured' : 'timer',
    'all',
    reason === 'breach'
      ? 'HEADQUARTERS BREACHED'
      : reason === 'capture'
        ? 'MONSTER CONTAINED — capture complete'
        : reason === 'timer'
          ? 'Dawn breaks — the defenders survived'
          : `${winner === 'monster' ? 'Defenders' : 'Monster'} forfeited`,
    { severity: winner === 'defenders' ? 'good' : 'alert', approachId: approachId ?? undefined },
  );
  void ev;
  s.stats.durationMs = Math.max(0, s.t - s.prepMs);
  s.stats.monsterNodesVisited = new Set(s.monster.visited).size;
  // Post-match reveal: annotate decoy sightings in the timeline.
  const decoyIds = new Set(s.sightings.filter((x) => x.isDecoy).map((x) => x.t + ':' + x.nodeId));
  const timeline = s.events.map(({ audience: _a, ...rest }) => {
    if (rest.kind === 'sighting' && rest.nodeId && decoyIds.has(rest.t + ':' + rest.nodeId)) {
      return { ...rest, text: rest.text + ' [DECOY]' };
    }
    return rest;
  });
  const result: MatchResult = {
    winner,
    reason,
    hqId: s.hqId,
    approachId,
    endedAtT: s.t,
    stats: { ...s.stats },
    timeline,
    monsterPath: [...s.monsterPath],
  };
  s.result = result;
}

export function forfeit(s: GameState, team: Team): void {
  endMatch(s, team === 'monster' ? 'defenders' : 'monster', 'forfeit');
}

// ───────────────────────────── step ─────────────────────────────

export function step(ctx: EngineCtx, s: GameState, dtMs: number, rng: Rng): void {
  if (s.result) return;
  s.t += dtMs;
  const dt = dtMs / 1000;

  // Phases
  const phase = phaseAt(s, s.t);
  if (phase !== s.phase) {
    const prev = s.phase;
    s.phase = phase;
    if (prev === 'preparation') spawnMonster(ctx, s, rng);
    const label = { preparation: 'Preparation', infiltration: 'Infiltration', escalation: 'Escalation', final: 'Final Assault' }[phase];
    pushEvent(s, 'phase', 'all', `Phase: ${label}`, { severity: phase === 'final' ? 'alert' : 'warn' });
  }
  if (s.t >= matchEndT(s)) {
    endMatch(s, 'defenders', 'timer');
    return;
  }
  if (s.phase === 'preparation') return; // nothing simulates during preparation

  stepPower(s, dt);
  stepDoors(ctx, s, dt);
  stepCameras(ctx, s, dtMs, rng);
  stepDevices(ctx, s);
  stepMonster(ctx, s, dtMs, rng);
  if (s.result) return;
  stepContainment(ctx, s, dtMs);
  if (s.result) return;
  stepDetection(ctx, s, rng);
  stepDecoys(ctx, s, rng);
  prune(s);
}

function spawnMonster(ctx: EngineCtx, s: GameState, rng: Rng) {
  const m = s.monster;
  const spawns = spawnCandidates(ctx.graph, s.hqId, s.cfg.spawn);
  const node =
    m.spawnChoice && spawns.includes(m.spawnChoice) ? m.spawnChoice : rng.pick(spawns.length ? spawns : [...ctx.graph.nodes.keys()]);
  m.spawned = true;
  m.nodeId = node;
  m.arrivedAt = s.t;
  m.nextDecisionAt = s.t;
  m.nextDetectAt = s.t + s.cfg.detection.rollEveryMs;
  m.visited.push(node);
  s.monsterPath.push({ nodeId: node, t: s.t });
  pushEvent(s, 'spawn', 'monster', `You emerge at ${nodeName(ctx, node)}`, { nodeId: node, severity: 'warn' });
  pushEvent(s, 'info', 'defenders', 'Something has entered the network.', { severity: 'warn' });
}

function stepPower(s: GameState, dt: number) {
  const p = s.power;
  const cfg = s.cfg.power;
  if (p.outageUntil !== null) {
    if (s.t >= p.outageUntil) {
      p.outageUntil = null;
      p.value = cfg.restoreTo;
      p.lowWarned = false;
      pushEvent(s, 'powerRestored', 'all', 'Auxiliary power restored', { severity: 'good' });
    } else return;
  }
  const drain = powerDrainPerSec(s);
  p.value = Math.min(cfg.max, p.value + cfg.regenPerSec * dt - drain * dt);
  s.stats.powerSpent += drain * dt;
  if (!p.lowWarned && p.value < cfg.lowThreshold) {
    p.lowWarned = true;
    pushEvent(s, 'powerLow', 'defenders', 'Power reserves low', { severity: 'warn' });
  }
  if (p.value > cfg.lowThreshold + 5) p.lowWarned = false;
  if (p.value <= 0) triggerOutage(s);
}

export function powerDrainPerSec(s: GameState): number {
  if (isOutage(s)) return 0;
  const cfg = s.cfg.power;
  let d = 0;
  for (const door of Object.values(s.doors)) if (door.closed) d += cfg.doorDrainPerSec;
  d += s.sensors.filter((x) => !x.disabledUntil || x.disabledUntil <= s.t).length * cfg.sensorUpkeepPerSec;
  if (s.containment) d += cfg.containmentDrainPerSec;
  return d;
}

function triggerOutage(s: GameState) {
  const p = s.power;
  p.value = 0;
  p.outageUntil = s.t + s.cfg.power.outageMs;
  s.stats.powerOutages++;
  for (const door of Object.values(s.doors)) door.closed = false;
  for (const cam of Object.values(s.cameras)) cam.repair = null;
  pushEvent(s, 'powerOut', 'all', 'POWER FAILURE — cameras and doors offline', { severity: 'alert' });
  if (s.containment) breakContainment(s, 'Containment field collapsed (power failure)');
}

function stepDoors(ctx: EngineCtx, s: GameState, dt: number) {
  const cfg = s.cfg.doors;
  for (const door of Object.values(s.doors)) {
    if (door.jammedUntil !== null && s.t >= door.jammedUntil) door.jammedUntil = null;
    if (door.closed) {
      s.stats.doorCloseSeconds += dt;
      door.heat += cfg.heatPerSecClosed * dt + (door.battering ? cfg.heatPerSecBattered * dt : 0);
      if (door.heat >= 1) {
        door.closed = false;
        door.heat = cfg.heatAfterJam;
        door.jammedUntil = s.t + cfg.jamMs;
        const ap = hq(ctx, s).approaches.find((a) => a.id === door.approachId);
        pushEvent(s, 'doorJammed', 'all', `${ap?.door ?? 'Door'} overheated and jammed OPEN`, {
          approachId: door.approachId,
          severity: 'alert',
        });
      }
    } else {
      door.heat = Math.max(0, door.heat - cfg.coolPerSecOpen * dt);
    }
    door.battering = false; // re-set each tick by the breach logic
  }
}

function stepCameras(ctx: EngineCtx, s: GameState, dtMs: number, rng: Rng) {
  for (const cam of Object.values(s.cameras)) {
    if (cam.repair && s.t >= cam.repair.endsAt) {
      cam.repair = null;
      cam.status = 'ok';
      cam.until = null;
      s.stats.repairs++;
      pushEvent(s, 'repairDone', 'all', `CAM ${nodeName(ctx, cam.nodeId)} restored`, {
        cameraId: cam.cameraId,
        nodeId: cam.nodeId,
        severity: 'good',
      });
    }
    if (cam.status !== 'ok' && cam.until !== null && s.t >= cam.until) {
      cam.status = 'ok';
      cam.until = null;
      cam.repair = null;
      pushEvent(s, 'cameraRestored', 'all', `CAM ${nodeName(ctx, cam.nodeId)} signal recovered`, {
        cameraId: cam.cameraId,
        nodeId: cam.nodeId,
        severity: 'info',
      });
    }
  }
  // Random fictional failures (game status only — the real camera source is untouched).
  const p = (s.cfg.failures.perMinute * dtMs) / 60_000;
  if (!isOutage(s) && rng.chance(p)) {
    const healthy = Object.values(s.cameras).filter((c) => c.status === 'ok' && !c.repair);
    if (healthy.length) {
      const cam = rng.pick(healthy);
      const [a, b] = s.cfg.failures.durationMs;
      cam.status = 'static';
      cam.until = s.t + Math.round(rng.range(a, b));
      s.stats.cameraFailures++;
      pushEvent(s, 'cameraFailure', 'all', `CAM ${nodeName(ctx, cam.nodeId)} — signal interference`, {
        cameraId: cam.cameraId,
        nodeId: cam.nodeId,
        severity: 'warn',
      });
    }
  }
  for (const [id, mf] of Object.entries(s.manifestations)) if (s.t > mf.startedAtT + mf.durationMs) delete s.manifestations[id];
}

function stepDevices(ctx: EngineCtx, s: GameState) {
  for (const sn of s.sensors) if (sn.disabledUntil !== null && s.t >= sn.disabledUntil) sn.disabledUntil = null;
  s.lures = s.lures.filter((l) => l.expiresAt > s.t);
  const m = s.monster;
  // A trap that goes live under an idle monster springs immediately.
  if (m.spawned && !m.moving && !m.held && m.nodeId) {
    const trap = s.traps.find((tr) => tr.nodeId === m.nodeId && s.t >= tr.armedAt);
    if (trap && s.t >= m.trapImmuneUntil) springTrap(ctx, s, trap.id);
  }
  void ctx;
}

function springTrap(ctx: EngineCtx, s: GameState, trapId: string) {
  const trap = s.traps.find((t) => t.id === trapId);
  if (!trap) return;
  s.traps = s.traps.filter((t) => t.id !== trapId);
  const m = s.monster;
  m.moving = null;
  m.nodeId = trap.nodeId;
  m.path = [];
  m.held = { until: s.t + s.cfg.traps.holdMs, contained: false, struggle: 0, struggling: false };
  if (s.breach) s.breach = null;
  s.stats.trapsTriggered++;
  addSighting(s, trap.nodeId, 1, 'trap', false);
  pushEvent(s, 'trapTriggered', 'all', `TRAP TRIGGERED at ${nodeName(ctx, trap.nodeId)} — target immobilised`, {
    nodeId: trap.nodeId,
    severity: 'alert',
  });
}

function breakContainment(s: GameState, text: string) {
  if (!s.containment) return;
  const nodeId = s.containment.nodeId;
  s.containment = null;
  pushEvent(s, 'containmentBroken', 'all', text, { nodeId, severity: 'alert' });
  const m = s.monster;
  if (m.held) {
    m.held = null;
    m.trapImmuneUntil = s.t + s.cfg.monster.freedTrapImmunityMs;
    m.nextDecisionAt = s.t;
  }
}

function stepMonster(ctx: EngineCtx, s: GameState, dtMs: number, rng: Rng) {
  const m = s.monster;
  if (!m.spawned) return;

  if (m.held) {
    const h = m.held;
    if (h.struggling) {
      const mult = s.containment ? s.cfg.containment.containedStruggleMult : 1;
      h.struggle = Math.min(1, h.struggle + (dtMs / s.cfg.containment.struggleBreakMs) * mult);
      if (h.struggle >= 1) {
        if (s.containment) breakContainment(s, 'The monster tore free of containment!');
        else {
          m.held = null;
          m.trapImmuneUntil = s.t + s.cfg.monster.freedTrapImmunityMs;
          pushEvent(s, 'freed', 'all', 'The monster broke out of the trap', { nodeId: m.nodeId ?? undefined, severity: 'warn' });
        }
        m.nextDecisionAt = s.t;
        return;
      }
    }
    if (!s.containment && s.t >= h.until) {
      m.held = null;
      m.trapImmuneUntil = s.t + s.cfg.monster.freedTrapImmunityMs;
      m.nextDecisionAt = s.t;
      pushEvent(s, 'freed', 'all', 'Trap released — the monster is moving again', { nodeId: m.nodeId ?? undefined, severity: 'warn' });
    }
    return;
  }

  // Movement along the current edge
  if (m.moving) {
    m.moving.elapsed += dtMs;
    if (m.moving.elapsed >= m.moving.duration) {
      const edge = ctx.graph.edges.get(m.moving.edgeId);
      const arrived = m.moving.to;
      m.moving = null;
      m.nodeId = arrived;
      s.stats.monsterDistanceKm += edge?.lengthKm ?? 0;
      onArrive(ctx, s, arrived, rng);
      if (m.held || s.result) return;
    }
  }

  // Decide when idle (or when a forced re-plan is due)
  if (s.t >= m.nextDecisionAt) decide(ctx, s, rng);

  // Start the next edge if idle and a path exists
  if (!m.moving && m.nodeId && m.path.length) {
    const next = m.path.shift()!;
    const edge = ctx.graph.edgeBetween(m.nodeId, next);
    if (edge) {
      m.moving = {
        from: m.nodeId,
        to: next,
        edgeId: edge.id,
        elapsed: 0,
        duration: edgeTravelMs(edge, s.cfg.monster, travelMultiplier(s, m.stance)),
      };
      if (s.breach) s.breach = null;
    } else m.path = [];
  }

  // Breach
  stepBreach(ctx, s, dtMs);
}

function onArrive(ctx: EngineCtx, s: GameState, nodeId: string, rng: Rng) {
  const m = s.monster;
  m.arrivedAt = s.t;
  m.visited.push(nodeId);
  if (m.visited.length > 200) m.visited.splice(0, m.visited.length - 200);
  s.monsterPath.push({ nodeId, t: s.t });
  m.nextDetectAt = Math.min(m.nextDetectAt, s.t + 200); // quick roll after arriving

  // Traps
  const trap = s.traps.find((t) => t.nodeId === nodeId && s.t >= t.armedAt);
  if (trap && s.t >= m.trapImmuneUntil) {
    springTrap(ctx, s, trap.id);
    return;
  }

  // Motion sensors at the node or adjacent
  const near = new Set([nodeId, ...ctx.graph.neighbors(nodeId)]);
  if (!isOutage(s)) {
    for (const sn of s.sensors) {
      if (!near.has(sn.nodeId)) continue;
      if (sn.disabledUntil !== null && sn.disabledUntil > s.t) continue;
      if (sn.lastPingAt !== null && s.t - sn.lastPingAt < s.cfg.sensors.pingCooldownMs) continue;
      if (m.stance === 'HIDE' && !rng.chance(s.cfg.sensors.hideDetectChance)) continue;
      sn.lastPingAt = s.t;
      s.stats.sensorPings++;
      addSighting(s, sn.nodeId, sn.nodeId === nodeId ? 0.5 : 0.3, 'sensor', false);
      pushEvent(s, 'sensorPing', 'defenders', `Motion sensor tripped near ${nodeName(ctx, sn.nodeId)}`, {
        nodeId: sn.nodeId,
        severity: 'warn',
      });
      if (sn.nodeId === nodeId || rng.chance(s.cfg.sensors.revealChance)) discoverSensor(ctx, s, sn.id, sn.nodeId);
    }
  }
  for (const sn of s.sensors) if (sn.nodeId === nodeId) discoverSensor(ctx, s, sn.id, sn.nodeId);

  // Door observation
  observeDoors(ctx, s, nodeId);
  m.nextDecisionAt = s.t; // re-plan at every node
}

function discoverSensor(ctx: EngineCtx, s: GameState, id: string, nodeId: string) {
  const k = s.monster.knowledge;
  const isNew = !k.knownSensors[id];
  const sensor = s.sensors.find((sn) => sn.id === id);
  k.knownSensors[id] = { nodeId, seenAt: s.t, disabledUntil: sensor?.disabledUntil ?? null };
  if (isNew) pushEvent(s, 'sensorFound', 'monster', `You sense a motion sensor at ${nodeName(ctx, nodeId)}`, { nodeId, severity: 'warn' });
}

function observeDoors(ctx: EngineCtx, s: GameState, nodeId: string) {
  const k = s.monster.knowledge;
  for (const ap of hq(ctx, s).approaches) {
    if (ctx.graph.hops(nodeId, ap.fromNode) <= s.cfg.visibility.doorObserveHops) {
      const d = s.doors[ap.id]!;
      k.knownDoors[ap.id] = { closed: d.closed, jammed: d.jammedUntil !== null && d.jammedUntil > s.t, seenAt: s.t };
    }
  }
}

function decide(ctx: EngineCtx, s: GameState, rng: Rng) {
  const m = s.monster;
  const knowledge = buildMonsterKnowledge(s, ctx.graph);
  const intent = ctx.brain.decide({ graph: ctx.graph, cfg: s.cfg, knowledge, aggression: s.cfg.monster.phaseAggression[s.phase] }, rng);
  m.nextDecisionAt = s.t + (intent.replanInMs ?? s.cfg.monster.replanMs);
  m.breachApproachId = intent.breachApproachId;
  const path = intent.path;
  if (!path.length) {
    m.path = [];
    return;
  }
  // Validate path adjacency
  for (let i = 1; i < path.length; i++) if (!ctx.graph.edgeBetween(path[i - 1]!, path[i]!)) return;
  if (m.moving) {
    if (path[0] === m.moving.to) m.path = path.slice(1);
    else if (path[0] === m.moving.from) {
      // turn around
      const mv = m.moving;
      m.moving = { from: mv.to, to: mv.from, edgeId: mv.edgeId, elapsed: mv.duration - mv.elapsed, duration: mv.duration };
      m.path = path.slice(1);
    }
  } else if (path[0] === m.nodeId) {
    m.path = path.slice(1);
  }
  if (intent.reason && intent.reason !== m.lastReason) {
    m.lastReason = intent.reason;
    pushEvent(s, 'command', 'monster', intent.reason, { severity: 'info' });
  }
}

/** Re-time the current edge after a stance change, keeping fractional progress. */
function retime(s: GameState, ctx: EngineCtx) {
  const m = s.monster;
  if (!m.moving) return;
  const edge = ctx.graph.edges.get(m.moving.edgeId);
  if (!edge) return;
  const frac = m.moving.elapsed / m.moving.duration;
  m.moving.duration = edgeTravelMs(edge, s.cfg.monster, travelMultiplier(s, m.stance));
  m.moving.elapsed = frac * m.moving.duration;
}

function stepBreach(ctx: EngineCtx, s: GameState, dtMs: number) {
  const m = s.monster;
  const apId = m.breachApproachId;
  const ap = apId ? hq(ctx, s).approaches.find((a) => a.id === apId) : undefined;
  const canBreach = !!ap && !m.moving && !m.held && m.nodeId === ap.fromNode && m.path.length === 0;
  if (!canBreach) {
    if (s.breach) s.breach = null;
    return;
  }
  const door = s.doors[ap.id]!;
  if (!s.breach || s.breach.approachId !== ap.id) {
    s.breach = { approachId: ap.id, progress: 0, stalled: false };
    addSighting(s, ap.fromNode, 1, 'breach', false);
    pushEvent(s, 'breachStart', 'all', `BREACH ATTEMPT — ${ap.door} (${ap.label})`, {
      approachId: ap.id,
      nodeId: ap.fromNode,
      severity: 'alert',
    });
  }
  const b = s.breach;
  if (door.closed) {
    door.battering = true;
    if (!b.stalled) pushEvent(s, 'doorBattered', 'all', `${ap.door} is being battered`, { approachId: ap.id, severity: 'alert' });
    b.stalled = true;
    b.progress = Math.max(0, b.progress - s.cfg.breach.decayPerSecWhenStalled * (dtMs / 1000));
    observeDoors(ctx, s, m.nodeId!);
    return;
  }
  b.stalled = false;
  const dur = s.cfg.breach.durationMs * s.cfg.breach.phaseMult[s.phase];
  b.progress = Math.min(1, b.progress + dtMs / dur);
  if (b.progress >= 1) endMatch(s, 'monster', 'breach', ap.id);
}

function stepContainment(ctx: EngineCtx, s: GameState, dtMs: number) {
  const c = s.containment;
  if (!c) return;
  if (!s.monster.held || s.monster.nodeId !== c.nodeId) {
    s.containment = null;
    return;
  }
  c.elapsed += dtMs;
  if (c.elapsed >= s.cfg.containment.captureMs) endMatch(s, 'defenders', 'capture');
  void ctx;
}

function stepDetection(ctx: EngineCtx, s: GameState, rng: Rng) {
  const m = s.monster;
  if (!m.spawned || m.held || s.t < m.nextDetectAt) return;
  const justArrived = !m.moving && s.t - m.arrivedAt <= s.cfg.detection.rollEveryMs;
  m.nextDetectAt = s.t + s.cfg.detection.rollEveryMs;
  const node = monsterEffectiveNode(s);
  if (!node) return;
  const cam = cameraAtNode(ctx, s, node);
  if (!camWorking(s, cam)) return;
  const d = s.cfg.detection;
  const hops = hopsToHq(ctx, s, node);
  let chance = d.baseChance * d.stanceMult[m.stance] * d.phaseMult[s.phase] * byHops(d.proximityMult, hops);
  if (m.moving) chance *= d.movingMult;
  if (justArrived) chance += d.arrivalBonus * d.stanceMult[m.stance];
  if (!rng.chance(Math.min(0.95, chance))) return;
  const maxC = m.stance === 'HIDE' ? d.confidence.hideMax : d.confidence.max;
  const conf = rng.range(d.confidence.min, maxC);
  addSighting(s, node, conf, 'camera', false);
  addManifestation(ctx, s, cam!.cameraId, node, conf, rng);
  pushEvent(s, 'sighting', 'defenders', sightingText(ctx, node, conf), {
    nodeId: node,
    cameraId: cam!.cameraId,
    severity: conf >= 0.8 ? 'alert' : 'warn',
  });
  if (rng.chance(d.exposureNoticeChance)) {
    m.knowledge.exposures.push({ nodeId: node, t: s.t });
    pushEvent(s, 'exposed', 'monster', `A lens turns toward you — CAM ${nodeName(ctx, node)} may have seen you`, {
      nodeId: node,
      severity: 'warn',
    });
  }
}

function stepDecoys(ctx: EngineCtx, s: GameState, rng: Rng) {
  const m = s.monster;
  const due = m.pendingDecoys.filter((d) => s.t >= d.at);
  if (!due.length) return;
  m.pendingDecoys = m.pendingDecoys.filter((d) => s.t < d.at);
  for (const d of due) emitDecoySighting(ctx, s, d.nodeId, rng);
}

function emitDecoySighting(ctx: EngineCtx, s: GameState, nodeId: string, rng: Rng) {
  const cam = cameraAtNode(ctx, s, nodeId);
  if (!camWorking(s, cam)) return;
  const d = s.cfg.detection;
  const conf = rng.range(d.confidence.min + 0.1, d.confidence.max);
  addSighting(s, nodeId, conf, 'camera', true);
  addManifestation(ctx, s, cam!.cameraId, nodeId, conf, rng);
  pushEvent(s, 'sighting', 'defenders', sightingText(ctx, nodeId, conf), {
    nodeId,
    cameraId: cam!.cameraId,
    severity: conf >= 0.8 ? 'alert' : 'warn',
  });
}

function prune(s: GameState) {
  const ttl = s.cfg.detection.sightingTtlMs;
  if (s.sightings.length > 200) s.sightings = s.sightings.slice(-200);
  s.sightings = s.sightings.filter((x) => s.t - x.t < ttl * 3);
  const k = s.monster.knowledge;
  const mem = s.cfg.visibility.monsterMemoryMs;
  k.exposures = k.exposures.filter((x) => s.t - x.t < mem);
  k.scanPulses = k.scanPulses.filter((x) => s.t - x.t < mem);
  k.disturbances = k.disturbances.filter((x) => x.expiresAt > s.t);
}

// ───────────────────────────── actions ─────────────────────────────

export function applyAction(ctx: EngineCtx, s: GameState, actor: Actor, action: DefenderAction | MonsterAction, rng: Rng): ActionResult {
  if (s.result) return fail('Match is over');
  if (actor.team === 'monster') return applyMonsterAction(ctx, s, action as MonsterAction, rng);
  const before = s.events.length;
  const res = applyDefenderAction(ctx, s, action as DefenderAction, rng);
  // Attribute events caused by this action to the acting defender (shown in the team log).
  for (let i = before; i < s.events.length; i++) if (s.events[i]!.audience !== 'monster') s.events[i]!.by = actor.playerId;
  return res;
}

function applyMonsterAction(ctx: EngineCtx, s: GameState, a: MonsterAction, rng: Rng): ActionResult {
  const m = s.monster;
  const g = ctx.graph;
  switch (a.type) {
    case 'chooseSpawn': {
      if (s.phase !== 'preparation') return fail('Spawn can only be chosen during preparation');
      if (!spawnCandidates(g, s.hqId, s.cfg.spawn).includes(a.nodeId)) return fail('Not a valid spawn point for this HQ');
      m.spawnChoice = a.nodeId;
      pushEvent(s, 'info', 'monster', `You will emerge at ${nodeName(ctx, a.nodeId)}`, { nodeId: a.nodeId });
      return ok;
    }
    case 'command': {
      const retarget = a.command === m.stance && !m.held;
      if (!retarget && m.cooldowns[a.command] > s.t) return fail(`${a.command} on cooldown`);
      if (s.t - m.lastCommandAt < s.cfg.monster.globalCommandGapMs) return fail('Too fast — the beast needs a moment');
      if (a.approachId && !hq(ctx, s).approaches.some((x) => x.id === a.approachId)) return fail('Unknown approach');
      m.lastCommandAt = s.t;
      s.stats.commandsIssued++;
      if (m.held && a.command === 'RETREAT') {
        // The human ordered a retreat, including recovery after breaking free.
        m.stance = 'RETREAT';
        m.targetApproachId = null;
        m.breachApproachId = null;
        m.held.struggling = true;
        m.cooldowns.RETREAT = s.t + s.cfg.monster.cooldownMs.RETREAT;
        pushEvent(s, 'struggle', 'all', 'The monster is struggling against its restraints', {
          nodeId: m.nodeId ?? undefined,
          severity: 'alert',
        });
        return ok;
      }
      const changed = m.stance !== a.command;
      m.stance = a.command;
      m.targetApproachId = a.approachId ?? null;
      // Only stance *changes* start the cooldown (re-issuing to re-target is free).
      if (changed) m.cooldowns[a.command] = s.t + s.cfg.monster.cooldownMs[a.command];
      m.nextDecisionAt = s.t;
      m.lastReason = '';
      retime(s, ctx);
      pushEvent(
        s,
        'command',
        'monster',
        `Command: ${a.command}${a.approachId ? ' → ' + (hq(ctx, s).approaches.find((x) => x.id === a.approachId)?.door ?? '') : ''}`,
        { severity: 'info' },
      );
      return ok;
    }
    case 'sabotage': {
      if (!m.spawned) return fail('Not on the map yet');
      if (m.held) return fail('You are restrained');
      if (m.cooldowns.SABOTAGE > s.t) return fail('SABOTAGE on cooldown');
      if (!g.has(a.nodeId)) return fail('Unknown node');
      if (!withinRange(ctx, s, a.nodeId, s.cfg.monster.sabotageRangeHops)) return fail('Target out of range');
      if (a.target === 'camera') {
        const cam = cameraAtNode(ctx, s, a.nodeId);
        if (!cam) return fail('No camera there');
        if (cam.status === 'sabotaged') return fail('Already sabotaged');
        cam.status = 'sabotaged';
        cam.until = s.t + s.cfg.monster.sabotageDurationMs;
        cam.repair = null;
        delete s.manifestations[cam.cameraId];
        pushEvent(s, 'sabotage', 'defenders', `CAM ${nodeName(ctx, a.nodeId)} — feed tampered`, {
          cameraId: cam.cameraId,
          nodeId: a.nodeId,
          severity: 'alert',
        });
        pushEvent(s, 'ability', 'monster', `SABOTAGE: CAM ${nodeName(ctx, a.nodeId)} goes dark`, { nodeId: a.nodeId, severity: 'good' });
      } else {
        const known = Object.entries(m.knowledge.knownSensors).find(([, v]) => v.nodeId === a.nodeId);
        const sensor = known ? s.sensors.find((x) => x.id === known[0]) : undefined;
        if (!sensor) return fail('No known sensor there');
        sensor.disabledUntil = s.t + s.cfg.monster.sensorSabotageDurationMs;
        m.knowledge.knownSensors[known![0]]!.disabledUntil = sensor.disabledUntil;
        pushEvent(s, 'sabotage', 'defenders', `Motion sensor at ${nodeName(ctx, a.nodeId)} stopped reporting`, {
          nodeId: a.nodeId,
          severity: 'alert',
        });
        pushEvent(s, 'ability', 'monster', `SABOTAGE: sensor at ${nodeName(ctx, a.nodeId)} silenced`, {
          nodeId: a.nodeId,
          severity: 'good',
        });
      }
      m.cooldowns.SABOTAGE = s.t + s.cfg.monster.cooldownMs.SABOTAGE;
      s.stats.sabotages++;
      s.stats.commandsIssued++;
      return ok;
    }
    case 'decoy': {
      if (!m.spawned) return fail('Not on the map yet');
      if (m.cooldowns.DECOY > s.t) return fail('DECOY on cooldown');
      if (!g.has(a.nodeId)) return fail('Unknown node');
      if (!withinRange(ctx, s, a.nodeId, s.cfg.monster.decoyRangeHops)) return fail('Target out of range');
      const cam = cameraAtNode(ctx, s, a.nodeId);
      if (!camWorking(s, cam)) return fail('That camera cannot be fooled (no working feed)');
      emitDecoySighting(ctx, s, a.nodeId, rng);
      const [lo, hi] = s.cfg.monster.decoyFollowupMs;
      m.pendingDecoys.push({ nodeId: a.nodeId, at: s.t + Math.round(rng.range(lo, hi)) });
      m.cooldowns.DECOY = s.t + s.cfg.monster.cooldownMs.DECOY;
      s.stats.commandsIssued++;
      pushEvent(s, 'ability', 'monster', `DECOY: a false shape stirs on CAM ${nodeName(ctx, a.nodeId)}`, {
        nodeId: a.nodeId,
        severity: 'good',
      });
      return ok;
    }
  }
}

function withinRange(ctx: EngineCtx, s: GameState, target: string, hops: number): boolean {
  const m = s.monster;
  const origins = m.moving ? [m.moving.from, m.moving.to] : m.nodeId ? [m.nodeId] : [];
  return origins.some((o) => ctx.graph.hops(o, target) <= hops);
}

function applyDefenderAction(ctx: EngineCtx, s: GameState, a: DefenderAction, rng: Rng): ActionResult {
  void rng;
  const g = ctx.graph;
  const cfg = s.cfg;
  if (isOutage(s)) return fail('POWER OUT — systems rebooting');
  const prepAllowed = a.type === 'placeSensor' || a.type === 'armTrap' || a.type === 'removeSensor' || a.type === 'disarmTrap';
  if (s.phase === 'preparation' && !prepAllowed) return fail('Only sensors and traps can be set up during preparation');
  switch (a.type) {
    case 'door': {
      const door = s.doors[a.approachId];
      if (!door) return fail('Unknown door');
      const ap = hq(ctx, s).approaches.find((x) => x.id === a.approachId)!;
      if (a.closed) {
        if (door.closed) return ok;
        if (door.jammedUntil !== null && door.jammedUntil > s.t) return fail('Door is jammed');
        if (s.power.value < 1) return fail('Not enough power');
        door.closed = true;
        pushEvent(s, 'doorClosed', 'defenders', `${ap.door} (${ap.label}) sealed`, { approachId: ap.id, severity: 'info' });
      } else {
        if (!door.closed) return ok;
        door.closed = false;
        pushEvent(s, 'doorOpened', 'defenders', `${ap.door} (${ap.label}) opened`, { approachId: ap.id, severity: 'info' });
      }
      return ok;
    }
    case 'placeSensor': {
      if (!g.has(a.nodeId)) return fail('Unknown node');
      if (s.sensors.length >= cfg.sensors.maxCount) return fail(`Sensor limit reached (${cfg.sensors.maxCount})`);
      if (s.sensors.some((x) => x.nodeId === a.nodeId)) return fail('Sensor already there');
      if (!spendPower(s, cfg.power.sensorPlaceCost)) return fail('Not enough power');
      s.sensors.push({ id: `s${s.nextId++}`, nodeId: a.nodeId, disabledUntil: null, lastPingAt: null });
      pushEvent(s, 'info', 'defenders', `Motion sensor placed at ${nodeName(ctx, a.nodeId)}`, { nodeId: a.nodeId });
      return ok;
    }
    case 'removeSensor': {
      const before = s.sensors.length;
      s.sensors = s.sensors.filter((x) => x.id !== a.sensorId);
      return before === s.sensors.length ? fail('Unknown sensor') : ok;
    }
    case 'armTrap': {
      if (!g.has(a.nodeId)) return fail('Unknown node');
      if (s.traps.length >= cfg.traps.maxCount) return fail(`Trap limit reached (${cfg.traps.maxCount})`);
      if (s.traps.some((x) => x.nodeId === a.nodeId)) return fail('Trap already there');
      if (!spendPower(s, cfg.power.trapArmCost)) return fail('Not enough power');
      const armDelay = s.phase === 'preparation' ? 0 : cfg.traps.armDelayMs;
      s.traps.push({ id: `t${s.nextId++}`, nodeId: a.nodeId, armedAt: s.t + armDelay });
      s.stats.trapsArmed++;
      pushEvent(s, 'trapArmed', 'defenders', `Trap arming at ${nodeName(ctx, a.nodeId)}`, { nodeId: a.nodeId });
      return ok;
    }
    case 'disarmTrap': {
      const before = s.traps.length;
      s.traps = s.traps.filter((x) => x.id !== a.trapId);
      return before === s.traps.length ? fail('Unknown trap') : ok;
    }
    case 'scan': {
      if (!g.has(a.nodeId)) return fail('Unknown node');
      if (s.scan.readyAt > s.t) return fail('Scanner recharging');
      if (!spendPower(s, cfg.power.scanCost)) return fail('Not enough power');
      s.scan.readyAt = s.t + cfg.scan.cooldownMs;
      s.stats.scans++;
      const r = cfg.scan.radiusHops;
      const area = new Set(g.within(a.nodeId, r));
      const mNode = monsterEffectiveNode(s);
      const found = !!mNode && area.has(mNode);
      s.scan.last = { nodeId: a.nodeId, t: s.t, radiusHops: r, found };
      if (found) {
        addSighting(s, mNode!, 1, 'scan', false);
        pushEvent(s, 'scan', 'defenders', `SCAN CONTACT at ${nodeName(ctx, mNode!)}`, { nodeId: mNode!, severity: 'alert' });
      } else {
        pushEvent(s, 'scanClear', 'defenders', `Scan around ${nodeName(ctx, a.nodeId)}: no contact`, {
          nodeId: a.nodeId,
          severity: 'info',
        });
      }
      for (const sg of s.sightings) {
        if (
          sg.isDecoy &&
          !sg.flaggedFalse &&
          area.has(sg.nodeId) &&
          s.t - sg.t < cfg.scan.decoyExposeWindowMs &&
          !(found && sg.nodeId === mNode)
        ) {
          sg.flaggedFalse = true;
          s.stats.decoysExposed++;
          pushEvent(s, 'decoyExposed', 'defenders', `Sighting at ${nodeName(ctx, sg.nodeId)} was FALSE — signal spoofed`, {
            nodeId: sg.nodeId,
            severity: 'good',
          });
        }
      }
      if (mNode && g.hops(mNode, a.nodeId) <= r + 1) {
        s.monster.knowledge.scanPulses.push({ nodeId: a.nodeId, t: s.t });
        pushEvent(s, 'scanFelt', 'monster', `A surveillance sweep pulses near ${nodeName(ctx, a.nodeId)}`, {
          nodeId: a.nodeId,
          severity: found ? 'alert' : 'warn',
        });
      }
      return ok;
    }
    case 'repair': {
      const cam = s.cameras[a.cameraId];
      if (!cam) return fail('Unknown camera');
      if (cam.status === 'ok') return fail('Camera is working');
      if (cam.repair) return fail('Already repairing');
      const active = Object.values(s.cameras).filter((c) => c.repair).length;
      if (active >= cfg.repair.maxConcurrent) return fail(`Repair crews busy (max ${cfg.repair.maxConcurrent})`);
      if (!spendPower(s, cfg.power.repairCost)) return fail('Not enough power');
      cam.repair = { startedAt: s.t, endsAt: s.t + cfg.repair.durationMs };
      pushEvent(s, 'repairStart', 'defenders', `Repair crew dispatched to CAM ${nodeName(ctx, cam.nodeId)}`, {
        cameraId: cam.cameraId,
        nodeId: cam.nodeId,
      });
      return ok;
    }
    case 'lure': {
      if (!g.has(a.nodeId)) return fail('Unknown node');
      if (s.lureReadyAt > s.t) return fail('Lure emitter recharging');
      if (s.lures.length >= cfg.lure.maxActive) return fail('Too many active lures');
      if (!spendPower(s, cfg.power.lureCost)) return fail('Not enough power');
      s.lureReadyAt = s.t + cfg.lure.cooldownMs;
      const lure = { id: `l${s.nextId++}`, nodeId: a.nodeId, t: s.t, expiresAt: s.t + cfg.lure.durationMs };
      s.lures.push(lure);
      s.monster.knowledge.disturbances.push({ nodeId: a.nodeId, t: s.t, expiresAt: lure.expiresAt });
      pushEvent(s, 'lure', 'defenders', `Alarm lure sounding at ${nodeName(ctx, a.nodeId)}`, { nodeId: a.nodeId });
      pushEvent(s, 'disturbance', 'monster', `A disturbance echoes from ${nodeName(ctx, a.nodeId)}…`, {
        nodeId: a.nodeId,
        severity: 'warn',
      });
      return ok;
    }
    case 'containment': {
      if (!a.engage) {
        if (!s.containment) return ok;
        s.containment = null;
        pushEvent(s, 'containmentCancelled', 'all', 'Containment disengaged', { severity: 'warn' });
        const m = s.monster;
        if (m.held && m.held.until <= s.t) {
          m.held = null;
          m.trapImmuneUntil = s.t + cfg.monster.freedTrapImmunityMs;
        } else if (m.held) m.held.contained = false;
        return ok;
      }
      const m = s.monster;
      if (!m.held || !m.nodeId) return fail('Nothing is held — containment needs a trapped target');
      if (s.containment) return ok;
      if (!spendPower(s, cfg.power.containmentStartCost)) return fail('Not enough power');
      s.containment = { nodeId: m.nodeId, startedAt: s.t, elapsed: 0 };
      m.held.contained = true;
      s.stats.containmentAttempts++;
      pushEvent(s, 'containmentStart', 'all', `CONTAINMENT ENGAGED at ${nodeName(ctx, m.nodeId)}`, { nodeId: m.nodeId, severity: 'alert' });
      return ok;
    }
  }
}
