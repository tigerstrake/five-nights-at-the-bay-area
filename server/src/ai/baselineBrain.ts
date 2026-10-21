// Baseline monster brain: Dijkstra/A* over the camera graph with utility-weighted costs per stance.
// Uses only MonsterKnowledge (legitimate information). The wave-2 AI agent may replace/extend this.
import type { HqApproach, MonsterStance, NetworkEdge, Rng } from '@fnab/shared';
import { edgeTravelMs } from '@fnab/shared';
import type { BrainInput, MonsterBrain, MonsterIntent, MonsterKnowledge } from './types';
import { TacticalBrain } from './tacticalBrain';

const EXPOSURE_UNIT_MS = 8_000;
const STANCE_EXPOSURE_WEIGHT: Record<MonsterStance, number> = { HUNT: 0.4, HIDE: 3, FLANK: 1.2, ATTACK: 0, RETREAT: 1 };

/** How risky it is to pass through a node, from the monster's point of view (0 = safe). */
export function nodeExposure(input: BrainInput, nodeId: string): number {
  const { knowledge: k, graph, cfg } = input;
  let e = 0;
  const cam = k.cameraStatusByNode[nodeId];
  if (cam === 'ok' || cam === 'repairing') e += 1;
  else if (cam) e -= 0.4; // dead camera: a blind spot to exploit
  const near = new Set([nodeId, ...graph.neighbors(nodeId)]);
  for (const s of k.knownSensors) if (!s.disabled && near.has(s.nodeId)) e += s.nodeId === nodeId ? 1.5 : 0.8;
  const memory = cfg.visibility.monsterMemoryMs;
  for (const x of k.exposures) if (k.t - x.t < memory && near.has(x.nodeId)) e += x.nodeId === nodeId ? 2 : 0.8;
  for (const p of k.scanPulses) if (k.t - p.t < memory && near.has(p.nodeId)) e += 0.8;
  return Math.max(0, e);
}

function approachDefense(input: BrainInput, ap: HqApproach): number {
  const k = input.knowledge;
  let d = nodeExposure(input, ap.fromNode);
  const door = k.knownDoors[ap.id];
  if (door) {
    const fresh = k.t - door.seenAt < input.cfg.visibility.monsterMemoryMs;
    if (fresh && door.jammed) d -= 2;
    else if (fresh && door.closed) d += 3;
  }
  return d;
}

interface Plan {
  path: string[];
  cost: number;
}

export class BaselineBrain implements MonsterBrain {
  decide(input: BrainInput, rng: Rng): MonsterIntent {
    const { graph, knowledge: k } = input;
    const hq = graph.hqs.get(k.hqId);
    const here = k.position.nodeId;
    if (!hq || !here) return { path: here ? [here] : [], breachApproachId: null, reason: 'Waiting' };

    const stance = k.stance;
    const w = STANCE_EXPOSURE_WEIGHT[stance];
    const speed = input.cfg.monster.stanceSpeed[stance] * input.cfg.monster.phaseSpeed[k.phase];
    const edgeCost = (_a: string, b: string, e: NetworkEdge) =>
      edgeTravelMs(e, input.cfg.monster, speed) + w * EXPOSURE_UNIT_MS * nodeExposure(input, b) + rng.next() * 500;

    const plan = (goal: string | ((id: string) => boolean)): Plan | null => {
      const m = k.position.moving;
      if (!m) return graph.aStar(here, goal, edgeCost);
      // While moving we may continue to `to` or turn back to `from`.
      const edge = graph.edges.get(m.edgeId)!;
      const full = edgeTravelMs(edge, input.cfg.monster, speed);
      const a = graph.aStar(m.to, goal, edgeCost);
      const b = graph.aStar(m.from, goal, edgeCost);
      const ca = a ? a.cost + full * (1 - m.progress) : Infinity;
      const cb = b ? b.cost + full * m.progress : Infinity;
      if (!a && !b) return null;
      return ca <= cb ? { path: a!.path, cost: ca } : { path: b!.path, cost: cb };
    };

    const rankApproaches = (exposureWeight: number): Array<{ ap: HqApproach; plan: Plan; score: number }> => {
      const out: Array<{ ap: HqApproach; plan: Plan; score: number }> = [];
      for (const ap of hq.approaches) {
        const p = plan(ap.fromNode);
        if (!p) continue;
        out.push({ ap, plan: p, score: p.cost + exposureWeight * EXPOSURE_UNIT_MS * approachDefense(input, ap) });
      }
      return out.sort((x, y) => x.score - y.score);
    };

    const pickApproach = (exposureWeight: number) => {
      const ranked = rankApproaches(exposureWeight);
      if (!ranked.length) return null;
      if (k.targetApproachId) {
        const chosen = ranked.find((r) => r.ap.id === k.targetApproachId);
        if (chosen) return chosen;
      }
      // Occasional tactical change keeps the monster unpredictable.
      if (ranked.length > 1 && rng.chance(input.cfg.monster.unpredictability * input.aggression)) return ranked[1]!;
      return ranked[0]!;
    };

    const via = (p: Plan) => (p.path.length > 1 ? graph.node(p.path[Math.min(1, p.path.length - 1)]!).name : graph.node(p.path[0]!).name);
    const hopsLeft = (p: Plan) => Math.max(0, p.path.length - 1);

    switch (stance) {
      case 'RETREAT': {
        const radius = input.cfg.monster.retreatHops + 1;
        const origin = k.position.moving?.to ?? here;
        let best: { node: string; score: number } | null = null;
        for (const n of graph.within(origin, radius)) {
          const score = graph.hopsToHq(n, k.hqId) * 2 - nodeExposure(input, n) + rng.next() * 0.5;
          if (!best || score > best.score) best = { node: n, score };
        }
        const p = best ? plan(best.node) : null;
        if (!p) return { path: [here], breachApproachId: null, reason: 'RETREAT: nowhere to run' };
        return { path: p.path, breachApproachId: null, reason: `RETREAT → falling back to ${graph.node(best!.node).name}` };
      }
      case 'ATTACK': {
        const r = pickApproach(0.5);
        if (!r) return { path: [here], breachApproachId: null, reason: 'ATTACK: no route to HQ' };
        return {
          path: r.plan.path,
          breachApproachId: r.ap.id,
          reason: hopsLeft(r.plan)
            ? `ATTACK → ${r.ap.door} (${r.ap.label}) via ${via(r.plan)}, ${hopsLeft(r.plan)} hops`
            : `ATTACK → breaching ${r.ap.door} (${r.ap.label})`,
        };
      }
      case 'HUNT': {
        const lure = k.disturbances.filter((d) => d.expiresAt > k.t && graph.hops(here, d.nodeId) <= 4).sort((a, b) => b.t - a.t)[0];
        if (lure && lure.nodeId !== here) {
          const p = plan(lure.nodeId);
          if (p)
            return { path: p.path, breachApproachId: null, reason: `HUNT → investigating disturbance at ${graph.node(lure.nodeId).name}` };
        }
        const r = pickApproach(0.3);
        if (!r) return { path: [here], breachApproachId: null, reason: 'HUNT: no route' };
        const breach = k.phase === 'escalation' || k.phase === 'final' ? r.ap.id : null;
        return {
          path: r.plan.path,
          breachApproachId: breach,
          reason: `HUNT → stalking ${r.ap.door} (${r.ap.label})${breach ? ' — will breach' : ' — probing'}, ${hopsLeft(r.plan)} hops`,
        };
      }
      case 'FLANK': {
        const r = pickApproach(1.5);
        if (!r) return { path: [here], breachApproachId: null, reason: 'FLANK: no route' };
        const breach = k.phase === 'infiltration' ? null : r.ap.id;
        return {
          path: r.plan.path,
          breachApproachId: breach,
          reason: `FLANK → least-defended ${r.ap.door} (${r.ap.label}) via ${via(r.plan)}`,
        };
      }
      case 'HIDE': {
        const r = pickApproach(3);
        if (!r) return { path: [here], breachApproachId: null, reason: 'HIDE: holding still' };
        // Creep: only advance one step when the next node is not more exposed than here.
        const path = r.plan.path;
        const next = path[1];
        if (next && nodeExposure(input, next) > nodeExposure(input, path[0]!) + 0.5) {
          return {
            path: [path[0]!],
            breachApproachId: null,
            reason: `HIDE → holding; ${graph.node(next).name} is watched`,
            replanInMs: 4_000,
          };
        }
        return {
          path: path.slice(0, 2),
          breachApproachId: null,
          reason: next ? `HIDE → creeping toward ${graph.node(next).name}` : 'HIDE → lying in wait',
        };
      }
    }
  }
}

export function defaultBrain(): TacticalBrain {
  return new TacticalBrain();
}

export type { MonsterKnowledge };
