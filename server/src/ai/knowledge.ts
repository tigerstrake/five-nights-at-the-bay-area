// Builds the monster's legitimate knowledge model from the full state. This is the ONLY bridge from
// GameState to the AI and to MonsterView, so anything not copied here is invisible to the monster side.
import type { CameraGameStatus, Graph, PowerLevel } from '@fnab/shared';
import type { GameState } from '../engine/state';
import { isOutage } from '../engine/state';
import type { MonsterKnowledge } from './types';

export function coarsePower(s: GameState): PowerLevel {
  if (isOutage(s)) return 'out';
  const f = s.power.value / s.cfg.power.max;
  if (f > 0.6) return 'high';
  if (f > 0.3) return 'medium';
  return 'low';
}

export function publicCameraStatus(s: GameState, cameraId: string): CameraGameStatus {
  const c = s.cameras[cameraId];
  if (!c) return 'blackout';
  if (isOutage(s)) return 'blackout';
  if (c.repair) return 'repairing';
  return c.status;
}

export function buildMonsterKnowledge(s: GameState, graph: Graph): MonsterKnowledge {
  const m = s.monster;
  const k = m.knowledge;
  const cameraStatusByNode: Record<string, CameraGameStatus> = {};
  for (const c of Object.values(s.cameras)) cameraStatusByNode[c.nodeId] = publicCameraStatus(s, c.cameraId);
  return {
    t: s.t,
    phase: s.phase,
    hqId: s.hqId,
    stance: m.stance,
    targetApproachId: m.targetApproachId,
    position: {
      nodeId: m.nodeId,
      moving: m.moving
        ? { from: m.moving.from, to: m.moving.to, edgeId: m.moving.edgeId, progress: m.moving.elapsed / m.moving.duration }
        : null,
    },
    held: m.held !== null,
    cameraStatusByNode,
    // Remember observations and our own sabotage. Remote removal/status changes are NOT an oracle.
    knownSensors: Object.entries(k.knownSensors).map(([id, v]) => ({
      id, nodeId: v.nodeId, seenAt: v.seenAt,
      disabled: (v.disabledUntil ?? 0) > s.t,
      disabledUntil: (v.disabledUntil ?? 0) > s.t ? v.disabledUntil : null,
    })),
    knownDoors: Object.fromEntries(Object.entries(k.knownDoors).map(([id, d]) => [id, { ...d }])),
    disturbances: k.disturbances.filter((d) => d.expiresAt > s.t).map((d) => ({ ...d })),
    scanPulses: k.scanPulses.map((d) => ({ ...d })),
    exposures: k.exposures.map((d) => ({ ...d })),
    recentNodes: m.visited.slice(-8),
    powerLevel: coarsePower(s),
    remainingMs: Math.max(0, s.prepMs + s.durationMs - s.t),
    cooldowns: { ...m.cooldowns },
    // trapTriggered is an explicit public notification about our own position. Never read s.traps.
    trapEncounters: s.events.filter((e) => e.kind === 'trapTriggered' && e.audience === 'all'
      && e.nodeId && graph.has(e.nodeId) && s.t - e.t < s.cfg.visibility.monsterMemoryMs)
      .map((e) => ({ nodeId: e.nodeId!, t: e.t })),
  };
}
