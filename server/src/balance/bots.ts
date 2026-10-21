// Policies deliberately receive only role projections, public rules and the public graph.
// No authoritative state, knowledge adapter, engine or visibility imports belong in this module.
import type { BalanceConfig, DefenderAction, DefenderView, Graph, MonsterAction, MonsterStance, MonsterView, Rng, SightingView } from '@fnab/shared';

export const SKILLS = ['novice', 'competent', 'expert'] as const;
export type DefenderSkill = typeof SKILLS[number] | 'lockdown';
export const POLICIES = ['rusher', 'stalker', 'flanker', 'trickster', 'adaptive'] as const;
export type MonsterPolicy = typeof POLICIES[number] | 'hide';

export class DefenderBot {
  private nextAction = 0;
  private nextWatch = 0;
  private watched = new Set<string>();
  private seen = new Set<number>();
  private contacts: SightingView[] = [];
  private heldAt = Infinity;
  private heldNode: string | null = null;
  private breachAt = Infinity;
  private breachId: string | null = null;
  private order: string[] = [];
  private lastTrapAt = -Infinity;
  private lastRepairAt = -Infinity;
  private lastScanAt = -Infinity;
  private readonly attention: number;
  private readonly reaction: number;

  constructor(readonly skill: DefenderSkill, private graph: Graph, private cfg: BalanceConfig, private rng: Rng, count: number) {
    // Independent operators help, with diminishing returns; shared resources stay shared.
    this.attention = 1 + 0.22 * (count - 1);
    this.reaction = (skill === 'novice' ? rng.range(3_000, 6_000) : skill === 'expert' ? rng.range(350, 1_000) : rng.range(1_200, 3_600)) / this.attention;
  }

  act(v: DefenderView): DefenderAction | null {
    const { rng, cfg, graph, skill } = this;
    const expert = skill === 'expert', novice = skill === 'novice';
    const aps = graph.hqs.get(v.hqId)!.approaches;
    if (!this.order.length) this.order = aps.map(a => a.fromNode); // public order, then seeded shuffle
    if (v.t === 0) for (let i = this.order.length - 1; i > 0; i--) {
      const j = rng.int(0, i); [this.order[i], this.order[j]] = [this.order[j], this.order[i]];
    }
    if (v.t >= this.nextWatch) {
      this.nextWatch = v.t + (novice ? 10_000 : expert ? 3_000 : 6_000);
      const nodes = novice ? graph.data.nodes.map(n => n.id) : [...this.order, ...graph.data.nodes.filter(n => graph.hopsToHq(n.id, v.hqId) <= 2).map(n => n.id)];
      this.watched = new Set(Array.from({ length: Math.ceil((novice ? 1 : 2) * this.attention) }, () => rng.pick(nodes)));
    }
    // Map notifications can also draw attention. A sighting is sampled once, never re-rolled until noticed.
    for (const sight of v.sightings) if (!this.seen.has(sight.id)) {
      this.seen.add(sight.id);
      if (sight.flaggedFalse) continue;
      if (sight.source !== 'camera' || this.watched.has(sight.nodeId) || rng.chance(novice ? 0.18 : expert ? 0.95 : 0.65)) this.contacts.push({ ...sight });
    }
    const falseIds = new Set(v.sightings.filter(s => s.flaggedFalse).map(s => s.id));
    this.contacts = this.contacts.filter(s => v.t - s.t < (expert ? 25_000 : 18_000) && !falseIds.has(s.id));
    if (v.held?.nodeId !== this.heldNode) {
      this.heldNode = v.held?.nodeId ?? null;
      this.heldAt = v.held ? v.t + this.reaction * rng.range(0.8, 1.2) : Infinity;
    }
    if (v.breach?.approachId !== this.breachId) {
      this.breachId = v.breach?.approachId ?? null;
      this.breachAt = v.breach ? v.t + this.reaction : Infinity;
    }
    if (v.t < this.nextAction || v.power.outageUntil !== null || v.ended) return null;
    this.nextAction = v.t + (novice ? 2_400 : expert ? 650 : 1_100) * rng.range(0.8, 1.2) / this.attention;
    if (skill === 'lockdown') {
      if (v.phase === 'preparation') return null;
      const door = v.doors.find(d => !d.closed && d.jammedUntil === null);
      return door ? { type: 'door', approachId: door.approachId, closed: true } : null;
    }
    const reserve = cfg.power.containmentStartCost + cfg.containment.captureMs / 1000 * Math.max(0, cfg.power.containmentDrainPerSec - cfg.power.regenPerSec) + 4;
    if (v.held && !v.containment && v.t >= this.heldAt && v.power.value >= (novice ? cfg.power.containmentStartCost : reserve - 5)) return { type: 'containment', engage: true };
    // An ongoing capture gets all attention; do not burn its reserved power on optional actions.
    if (v.containment) {
      const closed = v.doors.find(d => d.closed);
      return closed ? { type: 'door', approachId: closed.approachId, closed: false } : null;
    }
    if (v.phase === 'preparation') {
      const sensors = novice ? 1 : 3;
      if (v.sensors.length < sensors) {
        const node = novice ? rng.pick(graph.data.nodes).id : this.order.find(n => !v.sensors.some(s => s.nodeId === n));
        if (node) return { type: 'placeSensor', nodeId: node };
      }
      const traps = novice ? 1 : expert ? 3 : 2;
      if (v.traps.length < traps) {
        const node = novice ? rng.pick(graph.data.nodes).id : this.order.find(n => !v.traps.some(t => t.nodeId === n));
        if (node) return { type: 'armTrap', nodeId: node };
      }
      return null;
    }
    const contact = [...this.contacts].reverse().find(s => v.t - s.t >= this.reaction);
    const near = contact && graph.hopsToHq(contact.nodeId, v.hqId) <= 1;
    for (const d of v.doors) if (d.closed && (!v.breach || v.breach.approachId !== d.approachId) && (!near || v.power.value < reserve)) return { type: 'door', approachId: d.approachId, closed: false };
    // A human expert spends the last battery on a bare hold when capture is no longer affordable.
    // Keeping an impossible capture reserve while an observed breach completes would be an artificial bot weakness.
    if (expert && v.breach && v.t >= this.breachAt && v.power.value >= cfg.power.trapArmCost && v.power.value < reserve + cfg.power.trapArmCost) {
      const node = aps.find(a => a.id === v.breach!.approachId)!.fromNode;
      if (!v.traps.some(t => t.nodeId === node)) {
        if (v.traps.length < v.limits.traps) return { type: 'armTrap', nodeId: node };
        const remote = v.traps.filter(t => t.nodeId !== node).sort((a, b) => graph.hops(b.nodeId, node) - graph.hops(a.nodeId, node))[0];
        if (remote) return { type: 'disarmTrap', trapId: remote.id };
      }
    }
    if (v.breach && v.t >= this.breachAt) {
      const door = v.doors.find(d => d.approachId === v.breach!.approachId)!;
      if (!door.closed && door.jammedUntil === null && v.power.value > 2) return { type: 'door', approachId: door.approachId, closed: true };
    }
    // Anticipate a route using only the reported position and graph, without seeing the movement edge.
    if (!novice && contact && v.t - this.lastTrapAt > (expert ? 6_000 : 12_000) && v.traps.length < v.limits.traps && v.power.value > reserve + cfg.power.trapArmCost) {
      const candidates = expert && contact.source === 'sensor'
        ? graph.within(contact.nodeId, 1).sort((a, b) => graph.hopsToHq(a, v.hqId) - graph.hopsToHq(b, v.hqId))
        : [contact.nodeId, ...graph.neighbors(contact.nodeId).filter(n => graph.hopsToHq(n, v.hqId) < graph.hopsToHq(contact.nodeId, v.hqId))];
      const node = candidates.find(n => !v.traps.some(t => t.nodeId === n));
      if (node) { this.lastTrapAt = v.t; return { type: 'armTrap', nodeId: node }; }
    }
    if (expert && contact && v.t >= v.cooldowns.lureReadyAt && v.power.value > reserve + cfg.power.lureCost + 8) {
      const trap = v.traps.find(t => t.live && graph.hops(contact.nodeId, t.nodeId) <= 2 && !v.lures.some(l => l.nodeId === t.nodeId));
      if (trap) return { type: 'lure', nodeId: trap.nodeId };
    }
    if (contact && v.t >= v.cooldowns.scanReadyAt && v.t - this.lastScanAt > (novice ? 20_000 : expert ? 35_000 : 50_000) && v.power.value > (novice ? 15 : reserve + cfg.power.scanCost + 15)) {
      this.lastScanAt = v.t;
      return { type: 'scan', nodeId: novice ? rng.pick(graph.data.nodes).id : contact.nodeId };
    }
    if (v.t - this.lastRepairAt > (novice ? 12_000 : 25_000) && v.repairs.length < v.limits.repairsConcurrent && v.power.value > (novice ? 10 : reserve + cfg.power.repairCost + 15)) {
      const cam = v.cameras.find(c => (c.status === 'sabotaged' || novice && c.status === 'static') && (novice || graph.hopsToHq(c.nodeId, v.hqId) <= 1 || contact && graph.hops(contact.nodeId, c.nodeId) <= 1));
      if (cam) { this.lastRepairAt = v.t; return { type: 'repair', cameraId: cam.cameraId }; }
    }
    if (novice && rng.chance(0.18)) {
      const d = rng.pick(v.doors);
      if (d.jammedUntil === null) return { type: 'door', approachId: d.approachId, closed: !d.closed };
    }
    return null;
  }
}

export class MonsterBot {
  private nextAction = 0;
  private struggleAt = Infinity;
  private wasHeld = false;
  private resumeAt = 0;
  private spawnChosen = false;
  private trapped = 0;
  constructor(readonly policy: MonsterPolicy, private graph: Graph, private cfg: BalanceConfig, private rng: Rng) {}

  act(v: MonsterView): MonsterAction | null {
    const { policy, graph, cfg, rng } = this;
    if (v.self.held && !this.wasHeld) {
      this.trapped++;
      this.struggleAt = v.t + (policy === 'rusher' ? rng.range(2_000, 5_000) : policy === 'trickster' ? rng.range(1_000, 2_500) : rng.range(250, 1_250));
    }
    if (!v.self.held && this.wasHeld) this.resumeAt = v.t + (policy === 'adaptive' ? 1_500 : 6_000);
    this.wasHeld = !!v.self.held;
    if (v.t < this.nextAction || v.ended) return null;
    this.nextAction = v.t + rng.range(500, policy === 'adaptive' ? 1_000 : 1_500);
    if (!v.self.spawned && !this.spawnChosen) {
      this.spawnChosen = true;
      return { type: 'chooseSpawn', nodeId: rng.pick(v.spawnOptions) };
    }
    if (v.self.held) {
      if (!v.self.held.struggling && v.t >= this.struggleAt && v.t >= v.self.cooldowns.RETREAT) return { type: 'command', command: 'RETREAT' };
      return null;
    }
    const elapsed = v.t - cfg.match.prepMs;
    const duration = v.matchEndsAt - cfg.match.prepMs;
    let stance: MonsterStance = 'HUNT';
    if (policy === 'hide') stance = 'HIDE';
    else if (policy === 'rusher') stance = 'ATTACK';
    else if (policy === 'stalker') stance = elapsed < duration * 0.32 ? 'HIDE' : elapsed < duration * 0.72 ? 'HUNT' : 'ATTACK';
    else if (policy === 'flanker') stance = elapsed < duration * 0.65 ? 'FLANK' : 'ATTACK';
    else if (policy === 'trickster') stance = elapsed < duration * 0.68 ? 'HUNT' : 'ATTACK';
    else {
      const exposed = v.exposures.some(e => v.t - e.t < 6_000);
      const sealed = v.knownDoors.some(d => d.closed && v.t - d.seenAt < 8_000);
      stance = v.powerLevel === 'out' || v.powerLevel === 'low' || v.phase === 'final' ? 'ATTACK' : sealed || this.trapped > 0 ? 'FLANK' : exposed && v.phase === 'infiltration' ? 'HIDE' : 'HUNT';
    }
    if (v.self.stance === 'RETREAT' && v.t < this.resumeAt) return null;
    if (v.self.stance !== stance && v.t >= v.self.cooldowns[stance]) return { type: 'command', command: stance };
    if (!v.self.spawned || policy === 'rusher' || policy === 'hide') return null;
    // Abilities target only feeds/sensors shown in the monster projection, including both legal edge endpoints.
    const origins = v.self.moving ? [v.self.moving.from, v.self.moving.to] : v.self.nodeId ? [v.self.nodeId] : [];
    const inRange = (node: string, hops: number) => origins.some(o => graph.hops(o, node) <= hops);
    if (v.t >= v.self.cooldowns.SABOTAGE) {
      const sensor = v.knownSensors.find(s => (s.disabledUntil === null || s.disabledUntil <= v.t) && inRange(s.nodeId, cfg.monster.sabotageRangeHops));
      if (sensor && policy === 'adaptive') return { type: 'sabotage', nodeId: sensor.nodeId, target: 'sensor' };
      const cam = v.cameras.filter(c => c.status === 'ok' && inRange(c.nodeId, cfg.monster.sabotageRangeHops))
        .sort((a, b) => graph.hopsToHq(a.nodeId, v.hqId) - graph.hopsToHq(b.nodeId, v.hqId))[0];
      if (cam) return { type: 'sabotage', nodeId: cam.nodeId, target: 'camera' };
    }
    if ((policy === 'trickster' || policy === 'adaptive') && v.t >= v.self.cooldowns.DECOY) {
      const cams = v.cameras.filter(c => c.status === 'ok' && !origins.includes(c.nodeId) && inRange(c.nodeId, cfg.monster.decoyRangeHops));
      if (cams.length) return { type: 'decoy', nodeId: rng.pick(cams).nodeId };
    }
    return null;
  }
}
