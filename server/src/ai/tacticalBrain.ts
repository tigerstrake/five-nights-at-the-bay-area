import { edgeTravelMs, type HqApproach, type MonsterAction, type Rng } from '@fnab/shared';
import { TacticalPlanner, type Plan } from './pathfinding';
import type { BrainInput, MonsterBrain, MonsterIntent } from './types';

type Mode = 'stalk' | 'investigate' | 'creep' | 'wait' | 'circle' | 'commit' | 'batter' | 'escape' | 'recover';
interface Candidate { goal: string; plan: Plan; score: number; ap?: HqApproach }
export type AbilityOrder = Extract<MonsterAction, { type: 'sabotage' | 'decoy' }>;
export interface AbilityPlan extends MonsterIntent {
  stage: 'invalid' | 'cooldown' | 'position' | 'ready';
  /** Only returned when an explicitly requested ability is legal at the current position. */
  action?: AbilityOrder;
}

/** One instance per match. Memory contains only previous legitimate inputs and our own intentions. */
export class TacticalBrain implements MonsterBrain {
  private graph?: BrainInput['graph'];
  private lastT = -Infinity;
  private command = '';
  private mode: Mode = 'stalk';
  private goal: string | null = null;
  private approachId: string | null = null;
  private decisionToken = '';
  private pauseUntil = 0;
  private obviousNodes = new Set<string>();
  private investigated = new Set<string>();
  private batterSince: number | null = null;

  decide(input: BrainInput, rng: Rng): MonsterIntent {
    const { graph, knowledge: k, cfg } = input;
    const here = k.position.nodeId;
    const origin = k.position.moving?.to ?? here;
    if (!origin || !here || !graph.has(origin) || !graph.hqs.has(k.hqId))
      return { path: here ? [here] : [], breachApproachId: null, reason: 'Waiting in the dark.' };

    const command = `${k.hqId}:${k.stance}:${k.targetApproachId ?? ''}`;
    if (this.graph !== graph || k.t < this.lastT) {
      this.command = '';
      this.investigated.clear();
      this.decisionToken = '';
    }
    this.graph = graph;
    this.lastT = k.t;
    if (this.command !== command) {
      this.command = command;
      this.goal = null;
      this.approachId = null;
      this.pauseUntil = 0;
      this.batterSince = null;
      this.obviousNodes = new Set();
      if (k.stance === 'FLANK') {
        const paths = graph.hqs.get(k.hqId)!.approaches.map((ap) => graph.aStar(origin, ap.fromNode,
          (_a, _b, e) => edgeTravelMs(e, cfg.monster))).filter((p): p is Plan => p !== null);
        paths.sort((a, b) => a.cost - b.cost);
        this.obviousNodes = new Set(paths[0]?.path.slice(1) ?? []);
      }
    }
    const planner = new TacticalPlanner(input, { obviousNodes: this.obviousNodes });
    const c = planner.tuning;
    const token = `${command}:${k.recentNodes.join(',')}:${origin}`;
    const canVary = token !== this.decisionToken && !k.position.moving;
    this.decisionToken = token;
    const variation = cfg.monster.unpredictability > 0
      ? Math.min(c.variationChanceMax, Math.max(c.variationChanceMin, cfg.monster.unpredictability * input.aggression)) : 0;
    const name = (n: string) => graph.node(n).name;
    const hold = (reason: string, mode: Mode = 'wait'): MonsterIntent => {
      this.mode = mode;
      return { path: [origin], breachApproachId: null, reason, replanInMs: cfg.monster.replanMs };
    };
    if (k.held) return hold(k.stance === 'RETREAT'
      ? 'RETREAT: tearing at the restraints; find cover when free.' : 'Restrained. Waiting for your command.', 'escape');

    const choose = (candidates: Candidate[], vary = true): Candidate | undefined => {
      candidates.sort((a, b) => a.score - b.score || a.goal.localeCompare(b.goal));
      let best = candidates[0];
      if (!best) return;
      const budget = Math.max(cfg.monster.baseEdgeMs, Math.abs(best.score));
      const previous = candidates.find((r) => r.goal === this.goal && r.ap?.id === this.approachId);
      // Hysteresis prevents 2.5-second replans from repeatedly reversing a committed route.
      if (previous && previous.score <= best.score + budget * c.switchMargin) best = previous;
      const alternatives = candidates.filter((r) => r !== best && r.score <= best!.score + budget * (c.variationCostRatio - 1));
      if (vary && canVary && alternatives.length && rng.chance(variation)) best = rng.pick(alternatives);
      this.goal = best.goal;
      this.approachId = best.ap?.id ?? null;
      return best;
    };
    const move = (r: Candidate, reason: string, mode: Mode, breach: string | null = null, creep = false): MonsterIntent => {
      this.mode = mode;
      return { path: creep ? r.plan.path.slice(0, 2) : r.plan.path, breachApproachId: breach, reason };
    };
    const nearby = () => graph.within(origin, cfg.monster.retreatHops + 1).flatMap((goal) => {
      const plan = planner.plan(goal);
      return plan ? [{ goal, plan, score: plan.cost + planner.exposure(goal) * c.exposureMs * c.safetyWeight }] : [];
    });
    const danger = planner.risk(origin).danger;
    const relocating = danger >= c.relocationDanger;

    if (k.stance === 'HIDE') {
      if (this.mode === 'wait' && k.t < this.pauseUntil && !relocating)
        return hold(`HIDE: holding in the shadows at ${name(origin)}.`);
      const candidates = nearby().filter((r) => !relocating || r.goal !== origin);
      const r = choose(candidates);
      if (!r || (r.goal === origin && !k.position.moving))
        return hold(`HIDE: lying low at ${name(origin)}; listening for a gap.`);
      const next = r.plan.path[1] ?? r.plan.path[0];
      if (!relocating && !k.position.moving && canVary && rng.chance(variation)) this.pauseUntil = k.t + cfg.monster.replanMs;
      if (!relocating && k.t < this.pauseUntil) return hold(`HIDE: pausing in the shadows at ${name(origin)}.`);
      return move(r, relocating ? `HIDE: this corridor drew attention. Slipping toward ${name(next)}.`
        : `HIDE: creeping toward ${name(next)}; ${this.blind(planner, r.goal) ? 'a blind spot ahead' : 'keeping to the shadows'}.`, 'creep', null, true);
    }

    if (k.stance === 'RETREAT') {
      const r = choose(nearby().map((r) => ({ ...r,
        score: r.score - graph.hopsToHq(r.goal, k.hqId) * cfg.monster.maxEdgeMs,
      })).filter((r) => !relocating || r.goal !== origin), false);
      if (!r || r.goal === origin && !k.position.moving)
        return hold(`RETREAT: recovering at ${name(origin)}; keeping clear of HQ.`, 'recover');
      return move(r, `RETREAT: falling back to ${name(r.goal)}; away from HQ and remembered danger.`, 'escape');
    }

    const canBreach = k.stance === 'ATTACK' || k.phase === 'escalation' || k.phase === 'final';
    // Probing commands relocate after a sweep; ATTACK and an active breach remain committed.
    if (relocating && !canBreach) {
      const r = choose(nearby().filter((r) => r.goal !== origin), false);
      if (r) return move(r, `${k.stance}: this corridor drew attention. Repositioning at ${name(r.goal)}.`, 'circle');
    }

    const ranked: Candidate[] = [];
    for (const ap of graph.hqs.get(k.hqId)!.approaches) {
      if (k.targetApproachId && k.targetApproachId !== ap.id) continue;
      const plan = planner.plan(ap.fromNode);
      if (!plan) continue;
      const door = k.knownDoors[ap.id];
      const fresh = door && k.t - door.seenAt < cfg.visibility.monsterMemoryMs;
      let defense = 0;
      if (fresh && door.closed && !door.jammed) {
        // We know our own battering time, never the defender's hidden heat value.
        const batteringHere = this.approachId === ap.id && origin === ap.fromNode && !k.position.moving;
        const elapsed = batteringHere && this.batterSince !== null ? k.t - this.batterSince : 0;
        defense += Math.max(0, 1_000 / (cfg.doors.heatPerSecClosed + cfg.doors.heatPerSecBattered) - elapsed);
      } else if (fresh) defense -= c.openDoorCredit * c.exposureMs;
      const approachRisk = k.stance === 'ATTACK' ? planner.risk(ap.fromNode).danger : planner.exposure(ap.fromNode);
      ranked.push({ goal: ap.fromNode, plan, ap, score: plan.cost + defense
        + approachRisk * c.exposureMs * c.stanceExposure[k.stance] / planner.aggression });
    }

    if (k.stance === 'HUNT') {
      // Lures are real perceived disturbances: investigate rather than identifying them as fake.
      // Each signal is investigated once; its continuing sound must not freeze the monster forever.
      const signals = k.disturbances.filter((d) => d.expiresAt > k.t && graph.hops(origin, d.nodeId) <= c.lureHops);
      for (const d of signals) if (d.nodeId === here && !k.position.moving) this.investigated.add(`${d.nodeId}:${d.t}`);
      if (this.mode === 'investigate' && this.goal === here && !k.position.moving) {
        this.pauseUntil = k.t + cfg.monster.replanMs;
        return hold(`HUNT: listening at ${name(here)}. Something called from here.`);
      }
      if (this.mode === 'wait' && k.t < this.pauseUntil)
        return hold(`HUNT: stalking the disturbance at ${name(origin)}.`);
      const lures = signals.filter((d) => !this.investigated.has(`${d.nodeId}:${d.t}`)).flatMap((d) => {
        const plan = planner.plan(d.nodeId);
        const freshness = Math.min(1, (d.expiresAt - k.t) / cfg.lure.durationMs);
        return plan ? [{ goal: d.nodeId, plan, score: plan.cost - c.lureAttractionMs * freshness / planner.aggression }] : [];
      });
      const bestDoor = Math.min(...ranked.map((r) => r.score));
      const r = choose(lures.filter((r) => r.score < bestDoor), false);
      if (r) return move(r, `HUNT: a disturbance at ${name(r.goal)}. Following the sound.`, 'investigate');
    }

    const r = choose(ranked, !k.targetApproachId && k.stance !== 'ATTACK');
    if (!r?.ap) return hold(`${k.stance}: no credible route to that approach.`);
    const atDoor = !k.position.moving && here === r.goal;
    const door = k.knownDoors[r.ap.id];
    const closed = door && k.t - door.seenAt < cfg.visibility.monsterMemoryMs && door.closed && !door.jammed;
    if (atDoor && canBreach) {
      if (closed) this.batterSince ??= k.t;
      else this.batterSince = null;
      return move(r, closed ? `${k.stance}: ${r.ap.door} was sealed. Battering until it gives.`
        : `${k.stance}: committing to ${r.ap.door}. The threshold is within reach.`, closed ? 'batter' : 'commit', r.ap.id);
    }
    this.batterSince = null;
    if (atDoor) return hold(`${k.stance}: stalking ${r.ap.door}; waiting for escalation.`, 'stalk');
    const next = r.plan.path[1] ?? r.plan.path[0];
    const divergent = r.plan.path.slice(1).some((n) => !this.obviousNodes.has(n) && !k.recentNodes.includes(n));
    const why = k.stance === 'FLANK' ? (divergent ? 'leaving the obvious corridor' : 'the least exposed route available')
      : this.blind(planner, next) ? 'the camera there is blind' : closed ? 'the door was last seen sealed' : 'the clearest approach';
    return move(r, `${k.stance}: ${r.ap.door} via ${name(next)}; ${why}.`, k.stance === 'ATTACK' ? 'commit' : 'stalk', canBreach ? r.ap.id : null);
  }

  private blind(planner: TacticalPlanner, node: string): boolean {
    const status = planner.input.knowledge.cameraStatusByNode[node];
    return !status || status === 'sabotaged' || status === 'static' || status === 'blackout';
  }

  /**
   * Explicit-order planner for targeted abilities. Existing engine actions are instantaneous and
   * reject out-of-range requests; this API supplies positioning without firing unsolicited abilities.
   * The caller may follow its path, then submit `action` through the existing validated action API.
   */
  planAbility(input: BrainInput, order: AbilityOrder): AbilityPlan {
    const { graph, knowledge: k, cfg } = input;
    const origin = k.position.moving?.to ?? k.position.nodeId;
    const command = order.type === 'sabotage' ? 'SABOTAGE' : 'DECOY';
    const base = { path: origin ? [origin] : [], breachApproachId: null };
    if (!origin || !graph.has(order.nodeId) || k.held && order.type === 'sabotage')
      return { ...base, stage: 'invalid', reason: `${command}: cannot reach that target while restrained or off the map.` };
    if ((k.cooldowns?.[command] ?? Infinity) > k.t)
      return { ...base, stage: 'cooldown', reason: `${command}: waiting for the ability to recover.` };
    const status = k.cameraStatusByNode[order.nodeId];
    const knownSensor = k.knownSensors.find((s) => s.nodeId === order.nodeId && !s.disabled);
    const valid = order.type === 'decoy' ? status === 'ok'
      : order.target === 'sensor' ? !!knownSensor : status === 'ok' || status === 'static';
    if (!valid) return { ...base, stage: 'invalid', reason: `${command}: no suitable known target there.` };
    const range = order.type === 'decoy' ? cfg.monster.decoyRangeHops : cfg.monster.sabotageRangeHops;
    const origins = k.position.moving ? [k.position.moving.from, k.position.moving.to] : [origin];
    if (origins.some((n) => graph.hops(n, order.nodeId) <= range))
      return { ...base, stage: 'ready', action: { ...order }, reason: `${command}: ${graph.node(order.nodeId).name} is in reach.` };
    if (k.held) return { ...base, stage: 'invalid', reason: `${command}: restrained; cannot move into range.` };
    const planner = new TacticalPlanner(input);
    const choices = graph.within(order.nodeId, range).flatMap((n) => {
      const plan = planner.plan(n);
      return plan ? [{ node: n, plan, score: plan.cost + planner.exposure(n) * planner.tuning.exposureMs }] : [];
    }).sort((a, b) => a.score - b.score || a.node.localeCompare(b.node));
    const best = choices[0];
    return best ? { path: best.plan.path, breachApproachId: null, stage: 'position',
      reason: `${command}: approaching ${graph.node(best.node).name} to bring the target within reach.` }
      : { ...base, stage: 'invalid', reason: `${command}: no route into range.` };
  }
}
