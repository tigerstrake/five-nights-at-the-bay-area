// Contextual hints derived from real game state. Pure functions: given what the player can see right now, which
// hints apply? The coach layer shows the first one (highest priority) that has not been shown yet.
//
// Copy markup: `{X}` renders as a key cap. Anchors are CSS selectors inside the game screen; `side` is where the
// card sits relative to the anchor and is chosen so the card never covers the control it points at.
import { DEFAULT_CONFIG, type DefenderView, type Headquarters, type MonsterView } from '@fnab/shared';
import { graph, nodeName } from '../lib/data';

export type HintSide = 'top' | 'bottom' | 'left' | 'right';

export interface Hint {
  id: string;
  title: string;
  body: string;
  /** Selectors tried in order; the first one present on screen is the anchor. */
  anchor: string | string[];
  side: HintSide;
  tone: 'info' | 'warn' | 'alert';
}

const CFG = DEFAULT_CONFIG;
const DOOR_KEYS = ['Q', 'W', 'E'];
/** How fresh a sighting must be to count as "it is there now". */
const FRESH_MS = 12_000;

export interface DefenderCoachCtx {
  view: DefenderView;
  t: number;
  hq: Headquarters;
  /** Node shown on the main monitor. */
  mainNodeId: string | null;
  /** Hint ids already shown (some hints only follow others). */
  seen: ReadonlySet<string>;
}

/** The approach a node is on or next to (for "it is at the door" hints). */
export function approachNear(hq: Headquarters, nodeId: string): { index: number; door: string; approachId: string } | null {
  let i = hq.approaches.findIndex((a) => a.fromNode === nodeId);
  if (i < 0) {
    const nb = new Set(graph.neighbors(nodeId));
    i = hq.approaches.findIndex((a) => nb.has(a.fromNode));
  }
  const ap = hq.approaches[i];
  return ap ? { index: i, door: ap.door, approachId: ap.id } : null;
}

export function defenderHints({ view: v, t, hq, mainNodeId, seen }: DefenderCoachCtx): Hint[] {
  if (v.role === 'spectator' || v.ended) return [];
  const out: Hint[] = [];
  const prep = v.phase === 'preparation';
  const outage = v.power.outageUntil !== null;
  const fresh = [...v.sightings].reverse().find((s) => !s.flaggedFalse && t - s.t < FRESH_MS && s.source !== 'sensor');
  const freshAny = [...v.sightings].reverse().find((s) => !s.flaggedFalse && t - s.t < FRESH_MS);

  if (v.held && !v.containment) {
    out.push({
      id: 'd-trapped',
      title: 'It’s trapped. Engage containment now',
      body: `Press {H} or ENGAGE. Hold the field for ${CFG.containment.captureMs / 1000} s to capture it before it struggles free.`,
      anchor: '[data-testid=containment-console] [data-testid=contain]',
      side: 'top',
      tone: 'alert',
    });
  }
  if (v.containment && v.held?.struggling) {
    out.push({
      id: 'd-struggle',
      title: 'It’s fighting the field',
      body: 'Keep containment on. If power runs out or you let go, it breaks free.',
      anchor: '[data-testid=containment-console]',
      side: 'top',
      tone: 'warn',
    });
  }
  if (v.breach && !outage) {
    const i = v.doors.findIndex((d) => d.approachId === v.breach!.approachId);
    const d = v.doors[i];
    const ap = hq.approaches.find((a) => a.id === v.breach!.approachId);
    if (d && !d.closed) {
      out.push({
        id: 'd-breach',
        title: `It’s breaking in at ${ap?.door ?? 'a door'}`,
        body: `Seal that door now with {${DOOR_KEYS[i] ?? 'Q'}}. A sealed door stalls the breach, but it heats up and jams open if you hold it too long.`,
        anchor: '[data-testid=doors]',
        side: 'bottom',
        tone: 'alert',
      });
    }
  }
  if (!prep && !outage && !v.breach && freshAny) {
    const near = approachNear(hq, freshAny.nodeId);
    const door = near ? v.doors.find((d) => d.approachId === near.approachId) : undefined;
    if (near && door && !door.closed) {
      out.push({
        id: 'd-door',
        title: `It’s close to ${near.door}`,
        body: `Seal that door with {${DOOR_KEYS[near.index]}} while it’s near. Doors drain power and overheat if held, so open them again once it moves off.`,
        anchor: '[data-testid=doors]',
        side: 'bottom',
        tone: 'warn',
      });
    }
  }
  if (!outage && !prep && v.power.value <= Math.max(CFG.power.lowThreshold + 5, v.power.max * 0.25)) {
    out.push({
      id: 'd-power',
      title: 'Power is running low',
      body: `Open the doors you don’t need and hold off on scans. At zero the room goes dark for ${CFG.power.outageMs / 1000} s and every door opens.`,
      anchor: '[data-testid=doors]',
      side: 'bottom',
      tone: 'warn',
    });
  }
  const broken = v.cameras.find((c) => c.status === 'sabotaged');
  if (broken && !outage && !prep) {
    out.push({
      id: 'd-repair',
      title: `${nodeName(broken.nodeId)} was tampered with`,
      body: 'Sabotage means it was within a hop of that camera. Click FIX on its monitor, or put it on the big screen and press {R}.',
      anchor: [`[data-testid="thumb-${broken.cameraId}"]`, '[data-testid=monitor-bank]'],
      side: 'top',
      tone: 'warn',
    });
  }
  if (fresh && fresh.nodeId !== mainNodeId) {
    const cam = v.cameras.find((c) => c.nodeId === fresh.nodeId);
    out.push({
      id: 'd-sighting',
      title: `Sighting at ${nodeName(fresh.nodeId)}`,
      body: 'Click its monitor or the alert, or press {V}, to put that camera on the big screen. A sighting is a glimpse, not a track: it keeps moving.',
      anchor: [cam ? `[data-testid="thumb-${cam.cameraId}"]` : '', '[data-testid=alert-ticker]'].filter(Boolean),
      side: cam ? 'top' : 'bottom',
      tone: 'warn',
    });
  }
  if (!prep && seen.has('d-sighting') && v.lastKnown && t - v.lastKnown.t < 40_000 && t >= v.cooldowns.scanReadyAt && !v.held) {
    out.push({
      id: 'd-scan',
      title: 'Not sure it was real?',
      body: 'Press {C}, then click near the last sighting. A scan shows it exactly, or flags the sighting as a decoy.',
      anchor: '[data-testid=tool-scan]',
      side: 'top',
      tone: 'info',
    });
  }
  if (prep && v.traps.length === 0) {
    // Sit beside the whole dock: above an individual tool would obscure the map/HQ.
    out.push({
      id: 'd-prep-traps',
      title: 'Lay traps on its likely routes',
      body: 'Press {T}, then click nodes on the roads into your doors. The entity starts far away, so cover the approaches.',
      anchor: '[data-testid=map-tools]',
      side: 'left',
      tone: 'info',
    });
  }
  if (prep && v.traps.length > 0 && v.sensors.length === 0) {
    out.push({
      id: 'd-prep-sensors',
      title: 'Add a motion sensor or two',
      body: 'Press {S} and click a node. Sensors ping when it passes nearby, even where no camera is watching.',
      anchor: '[data-testid=map-tools]',
      side: 'left',
      tone: 'info',
    });
  }
  if (!prep && !v.sightings.length && t - CFG.match.prepMs < 25_000) {
    out.push({
      id: 'd-watch',
      title: 'It’s in the network now',
      body: 'Watch the bank for a flicker or a figure. Number keys {1}–{9} put a monitor on the big screen.',
      anchor: '[data-testid=monitor-bank]',
      side: 'top',
      tone: 'info',
    });
  }
  // In a crisis (held, breach, blackout) only the hints about the crisis itself are worth the attention.
  return v.held || v.breach || outage ? out.filter((h) => h.tone !== 'info') : out;
}

export interface MonsterCoachCtx {
  view: MonsterView;
  t: number;
  hq: Headquarters;
  /** Hops from the creature to the HQ (null before it spawns). */
  hopsToHq: number | null;
  /** A working camera watches the creature's node. */
  watchedHere: boolean;
  /** The player has issued at least one stance command. */
  commanded: boolean;
  seen: ReadonlySet<string>;
}

export function monsterHints({ view: v, t, hopsToHq, watchedHere, commanded, seen }: MonsterCoachCtx): Hint[] {
  if (v.ended) return [];
  const out: Hint[] = [];
  const s = v.self;
  const prep = v.phase === 'preparation';
  const ready = (c: keyof typeof s.cooldowns) => s.cooldowns[c] <= t;
  const nightAge = t - CFG.match.prepMs;

  if (s.held && !s.held.struggling) {
    out.push({
      id: 'm-trapped',
      title: 'You’re caught. Struggle',
      body: 'Press {Space} to start struggling. If they switch on containment it becomes a race. DECOY {D} still works while you’re held.',
      anchor: '[data-testid=monster-struggle]',
      side: 'bottom',
      tone: 'alert',
    });
  }
  if (v.breach?.stalled) {
    out.push({
      id: 'm-sealed',
      title: 'They sealed the door',
      body: 'Keep battering and it overheats and jams open, or FLANK {F} to another door while this one is hot.',
      anchor: '[data-testid=monster-breach]',
      side: 'top',
      tone: 'warn',
    });
  }
  if (!prep && s.spawned && !s.held && !v.breach && hopsToHq === 0 && !s.moving) {
    out.push({
      id: 'm-at-door',
      title: 'You’re at their door',
      body:
        v.phase === 'infiltration'
          ? 'This early, only ATTACK {A} breaks a door. HUNT and FLANK start breaching from Escalation.'
          : 'ATTACK {A} to break in. If they seal it, keep battering or switch doors.',
      anchor: '[data-testid=cmd-ATTACK]',
      side: 'top',
      tone: 'alert',
    });
  }
  const seenAt = [...v.exposures].sort((a, b) => b.t - a.t)[0];
  if (!prep && !s.held && seenAt && t - seenAt.t < 10_000) {
    out.push({
      id: 'm-seen',
      title: 'They may have seen you',
      body: `HIDE {C} to go quiet, or FLANK {F} to swing round to a door they aren’t watching. Spotted at ${nodeName(seenAt.nodeId)}.`,
      anchor: '[data-testid=cmd-HIDE]',
      side: 'top',
      tone: 'warn',
    });
  }
  if (!prep && s.spawned && !s.held && watchedHere && ready('SABOTAGE') && nightAge > 8_000) {
    out.push({
      id: 'm-sabotage',
      title: 'A camera is watching you',
      body: 'SABOTAGE {S}, then click a camera within 1 hop. It goes dark for 45 s, but they’ll see the feed was tampered with.',
      anchor: '[data-testid=ability-SABOTAGE]',
      side: 'top',
      tone: 'info',
    });
  }
  if (!prep && s.spawned && ready('DECOY') && (seen.has('m-sabotage') || nightAge > 45_000) && nightAge > 20_000) {
    out.push({
      id: 'm-decoy',
      title: 'Plant a false sighting',
      body: 'DECOY {D} fakes a sighting on a working camera up to 3 hops away. Pull their eyes off your real route.',
      anchor: '[data-testid=ability-DECOY]',
      side: 'top',
      tone: 'info',
    });
  }
  if (prep && !s.spawnChoice) {
    out.push({
      id: 'm-spawn',
      title: 'Choose where you emerge',
      body: 'Click a ringed point on the map or a place in this list. Every point is equally far from their HQ.',
      anchor: '[data-testid=monster-spawns]',
      side: 'left',
      tone: 'info',
    });
  }
  if (!commanded && (!prep || s.spawnChoice)) {
    out.push({
      id: 'm-first-command',
      title: prep ? 'Pick an opening stance' : 'Give your first order',
      body: 'You set the strategy and the creature finds the path. HUNT {H} stalks the HQ, FLANK {F} finds the weakest door, HIDE {C} creeps unseen.',
      anchor: '[data-testid=cmd-HUNT]',
      side: 'top',
      tone: 'info',
    });
  }
  if (!prep && commanded && s.spawned && !s.held && nightAge > 15_000 && seen.has('m-first-command')) {
    out.push({
      id: 'm-target-door',
      title: 'Choose a door, or let it choose',
      body: 'Keys {1}–{3} aim HUNT, FLANK and ATTACK at one door. {0} lets the creature pick the weakest.',
      anchor: '[data-testid=target-ai]',
      side: 'top',
      tone: 'info',
    });
  }
  return s.held || v.breach ? out.filter((h) => h.tone !== 'info') : out;
}
