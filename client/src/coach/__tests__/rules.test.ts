import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type DefenderView, type MonsterView } from '@fnab/shared';
import { graph, hqById } from '../../lib/data';
import { approachNear, defenderHints, monsterHints } from '../rules';
import { AUTO_MATCHES, hintsOnFor, type CoachPrefs } from '../store';

const hq = hqById('hq-sf')!;
const PREP = DEFAULT_CONFIG.match.prepMs;

function defView(over: Partial<DefenderView> = {}): DefenderView {
  return {
    role: 'defender',
    t: PREP + 30_000,
    t0Epoch: 0,
    serverNow: 0,
    phase: 'infiltration',
    phaseEndsAt: PREP + 200_000,
    matchEndsAt: PREP + 480_000,
    hqId: 'hq-sf',
    defenderCount: 1,
    events: [],
    ended: false,
    power: { value: 90, max: 94, outageUntil: null, drainPerSec: 0 },
    threat: 0.2,
    doors: hq.approaches.map((a) => ({ approachId: a.id, closed: false, heat: 0, jammedUntil: null, battering: false })),
    sensors: [],
    traps: [],
    lures: [],
    cameras: [],
    sightings: [],
    lastKnown: null,
    held: null,
    containment: null,
    breach: null,
    repairs: [],
    cooldowns: { scanReadyAt: 0, lureReadyAt: 0 },
    limits: { sensors: 4, traps: 3, repairsConcurrent: 2 },
    lastScan: null,
    ...over,
  } as DefenderView;
}

const ids = (h: { id: string }[]) => h.map((x) => x.id);
const ctx = (view: DefenderView, seen: string[] = []) => ({ view, t: view.t, hq, mainNodeId: null, seen: new Set(seen) });

describe('defender coaching rules', () => {
  it('asks for traps during preparation, then sensors once a trap is down', () => {
    const prep = defView({ phase: 'preparation', t: 5_000 });
    expect(ids(defenderHints(ctx(prep)))).toContain('d-prep-traps');
    const trapped = defView({ phase: 'preparation', t: 5_000, traps: [{ id: 'x', nodeId: hq.approaches[0]!.fromNode, live: true }] as DefenderView['traps'] });
    const h = ids(defenderHints(ctx(trapped)));
    expect(h).not.toContain('d-prep-traps');
    expect(h).toContain('d-prep-sensors');
  });

  it('places preparation tips beside the whole tool dock, clear of the map above it', () => {
    const prep = defView({ phase: 'preparation', t: 5_000 });
    const trap = defenderHints(ctx(prep)).find((h) => h.id === 'd-prep-traps');
    const sensors = defenderHints(ctx({
      ...prep,
      traps: [{ id: 'x', nodeId: hq.approaches[0]!.fromNode, live: true }] as DefenderView['traps'],
    })).find((h) => h.id === 'd-prep-sensors');
    for (const hint of [trap, sensors]) {
      expect(hint).toMatchObject({ anchor: '[data-testid=map-tools]', side: 'left' });
    }
  });

  it('points at the door when a fresh sighting is on an approach, and drops it once the door is sealed', () => {
    const ap = hq.approaches[1]!;
    const sighting = { id: 1, nodeId: ap.fromNode, t: PREP + 29_000, confidence: 0.8, source: 'camera' as const, flaggedFalse: false };
    const v = defView({ sightings: [sighting] });
    const door = defenderHints(ctx(v)).find((x) => x.id === 'd-door');
    expect(door?.body).toContain('{W}');
    const sealed = defView({ sightings: [sighting], doors: v.doors.map((d) => ({ ...d, closed: d.approachId === ap.id })) });
    expect(ids(defenderHints(ctx(sealed)))).not.toContain('d-door');
  });

  it('puts the trap hint first and never coaches spectators', () => {
    const v = defView({ held: { nodeId: hq.approaches[0]!.fromNode, until: PREP + 38_000, struggling: false } });
    expect(defenderHints(ctx(v))[0]?.id).toBe('d-trapped');
    expect(defenderHints(ctx({ ...v, role: 'spectator' }))).toEqual([]);
  });

  it('offers a scan only after the sighting hint has been shown', () => {
    const v = defView({ lastKnown: { nodeId: 'n-octavia', t: PREP + 20_000 } });
    expect(ids(defenderHints(ctx(v)))).not.toContain('d-scan');
    expect(ids(defenderHints(ctx(v, ['d-sighting'])))).toContain('d-scan');
  });

  it('finds the approach next to a node', () => {
    const ap = hq.approaches[2]!;
    const nb = graph.neighbors(ap.fromNode).find((n) => !hq.approaches.some((a) => a.fromNode === n));
    expect(approachNear(hq, ap.fromNode)?.approachId).toBe(ap.id);
    if (nb) expect(approachNear(hq, nb)).not.toBeNull();
  });
});

function monView(over: Partial<MonsterView> = {}, self: Partial<MonsterView['self']> = {}): MonsterView {
  return {
    role: 'monster',
    t: PREP + 30_000,
    t0Epoch: 0,
    serverNow: 0,
    phase: 'infiltration',
    phaseEndsAt: PREP + 200_000,
    matchEndsAt: PREP + 480_000,
    hqId: 'hq-sf',
    defenderCount: 1,
    events: [],
    ended: false,
    self: {
      spawned: true,
      spawnChoice: null,
      nodeId: 'n-octavia',
      moving: null,
      path: [],
      stance: 'HUNT',
      targetApproachId: null,
      held: null,
      cooldowns: { HUNT: 0, HIDE: 0, FLANK: 0, ATTACK: 0, RETREAT: 0, SABOTAGE: 0, DECOY: 0 },
      ...self,
    },
    spawnOptions: [],
    cameras: [],
    knownSensors: [],
    knownDoors: [],
    disturbances: [],
    scanPulses: [],
    exposures: [],
    powerLevel: 'high',
    breach: null,
    containment: null,
    ...over,
  } as MonsterView;
}

const mctx = (view: MonsterView, o: { hopsToHq?: number | null; watchedHere?: boolean; commanded?: boolean; seen?: string[] } = {}) => ({
  view,
  t: view.t,
  hq,
  hopsToHq: o.hopsToHq ?? 3,
  watchedHere: o.watchedHere ?? false,
  commanded: o.commanded ?? true,
  seen: new Set(o.seen ?? []),
});

describe('monster coaching rules', () => {
  it('coaches struggle and does not advertise DECOY while restrained', () => {
    const held = monView({ t: PREP + 60_000 }, { held: { until: PREP + 68_000, contained: false, struggle: 0, struggling: false } });
    const hints = monsterHints(mctx(held, { seen: ['m-sabotage'], watchedHere: true }));
    expect(hints[0]).toMatchObject({ id: 'm-trapped' });
    expect(hints[0].body).toContain('Abilities are unavailable until you break free');
    expect(hints.some(h => h.body.includes('DECOY'))).toBe(false);
  });
  it('walks through spawn → first order in preparation', () => {
    const prep = monView({ phase: 'preparation', t: 3_000 }, { spawned: false, nodeId: null });
    expect(ids(monsterHints(mctx(prep, { commanded: false })))).toEqual(['m-spawn']);
    const picked = monView({ phase: 'preparation', t: 3_000 }, { spawned: false, nodeId: null, spawnChoice: 'n-octavia' });
    expect(ids(monsterHints(mctx(picked, { commanded: false })))).toEqual(['m-first-command']);
  });

  it('reacts to being seen, being trapped and reaching a door', () => {
    const seen = monView({ exposures: [{ nodeId: 'n-octavia', t: PREP + 26_000 }] });
    expect(ids(monsterHints(mctx(seen)))).toContain('m-seen');
    const held = monView({}, { held: { until: PREP + 38_000, contained: false, struggle: 0, struggling: false } });
    expect(monsterHints(mctx(held))[0]?.id).toBe('m-trapped');
    const door = monView({}, { nodeId: hq.approaches[0]!.fromNode });
    const h = monsterHints(mctx(door, { hopsToHq: 0 })).find((x) => x.id === 'm-at-door');
    expect(h?.body).toMatch(/only ATTACK/);
  });

  it('suggests sabotage only while a camera is watching and the ability is ready', () => {
    expect(ids(monsterHints(mctx(monView(), { watchedHere: true })))).toContain('m-sabotage');
    const cooling = monView({}, { cooldowns: { HUNT: 0, HIDE: 0, FLANK: 0, ATTACK: 0, RETREAT: 0, SABOTAGE: PREP + 60_000, DECOY: 0 } });
    expect(ids(monsterHints(mctx(cooling, { watchedHere: true })))).not.toContain('m-sabotage');
  });
});

describe('coach preferences', () => {
  const base: CoachPrefs = { mode: 'auto', matches: { defender: 0, monster: 0 }, seen: [] };
  it(`is on automatically for the first ${AUTO_MATCHES} matches in each role`, () => {
    expect(hintsOnFor(base, 'defender')).toBe(true);
    const after = { ...base, matches: { defender: AUTO_MATCHES, monster: 0 } };
    expect(hintsOnFor(after, 'defender')).toBe(false);
    expect(hintsOnFor(after, 'monster')).toBe(true);
  });
  it('respects an explicit choice and stays off on automated test pages', () => {
    expect(hintsOnFor({ ...base, mode: 'off' }, 'monster')).toBe(false);
    expect(hintsOnFor({ ...base, mode: 'on', matches: { defender: 9, monster: 9 } }, 'monster')).toBe(true);
    expect(hintsOnFor(base, 'defender', true)).toBe(false);
  });
});
