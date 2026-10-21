// Drives the audio engine from game state: ambience per screen, sfx per new events, tension, stingers.
import { useEffect, useRef } from 'react';
import type { GameEventKind, PlayerView } from '@fnab/shared';
import { audio, type SfxName } from '../audio';
import { SeenIds, useGame } from '../state/store';

const EVENT_SFX: Partial<Record<GameEventKind, SfxName>> = {
  sighting: 'monsterDistant',
  sensorPing: 'sensorPing',
  scan: 'scanPing',
  scanClear: 'scanPing',
  trapArmed: 'trapArm',
  trapTriggered: 'trapTrigger',
  containmentStart: 'alarm',
  containmentBroken: 'monsterScreech',
  doorClosed: 'doorClose',
  doorOpened: 'doorOpen',
  doorJammed: 'doorBlocked',
  doorBattered: 'doorBlocked',
  breachStart: 'alarm',
  sabotage: 'staticBurst',
  cameraFailure: 'staticBurst',
  repairStart: 'repairStart',
  repairDone: 'repairDone',
  powerLow: 'powerLow',
  powerOut: 'powerOut',
  phase: 'phaseChange',
  spawn: 'monsterNear',
  exposed: 'staticBurst',
  ability: 'commandIssued',
  disturbance: 'alarm',
  struggle: 'monsterScreech',
  freed: 'monsterNear',
  // reconnection grace: a dropped side is a jolt, a restored link a soft confirmation
  connectionLost: 'staticBurst',
  connectionRestored: 'repairDone',
  forfeit: 'phaseChange',
};

function tensionOf(v: PlayerView): number {
  if (v.role === 'monster') {
    const base = { preparation: 0.1, infiltration: 0.25, escalation: 0.5, final: 0.75 }[v.phase];
    return Math.min(1, base + (v.breach ? 0.25 : 0) + (v.self.held ? 0.2 : 0));
  }
  return Math.min(1, v.threat + (v.breach ? 0.3 : 0));
}

export function useGameAudio() {
  const room = useGame((s) => s.room);
  const view = useGame((s) => s.view);
  const result = useGame((s) => s.result);
  // Event ids are opaque: dedupe with a bounded seen-set, never `id > last`.
  const seen = useRef(new SeenIds<number>(1024));
  const primed = useRef(false);
  const lastResultKey = useRef<string | null>(null);
  const lastCountdown = useRef<number | null>(null);

  // unlock on first gesture
  useEffect(() => {
    const unlock = () => {
      void audio.unlock();
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  // ambience
  const stage = room?.stage ?? 'title';
  const role = view?.role;
  useEffect(() => {
    if (stage === 'playing' && role) audio.setAmbience(role === 'monster' ? 'monster' : 'defender');
    else if (stage === 'results') audio.setAmbience('none');
    else audio.setAmbience('lobby');
    if (stage !== 'playing') audio.setTension(stage === 'countdown' ? 0.2 : 0);
  }, [stage, role]);

  // countdown ticks
  useEffect(() => {
    if (room?.stage !== 'countdown' || !room.countdownEndsAt) {
      lastCountdown.current = null;
      return;
    }
    const id = setInterval(() => {
      const left = Math.ceil((room.countdownEndsAt! - (Date.now() + useGame.getState().clockOffset)) / 1000);
      if (left !== lastCountdown.current && left >= 0) {
        lastCountdown.current = left;
        audio.play(left === 0 ? 'matchStart' : 'countdownTick');
      }
    }, 100);
    return () => clearInterval(id);
  }, [room?.stage, room?.countdownEndsAt]);

  // events + tension
  useEffect(() => {
    if (!view) {
      seen.current.clear();
      primed.current = false;
      return;
    }
    audio.setTension(tensionOf(view));
    const fresh = view.events.filter((e) => seen.current.add(e.id));
    if (!primed.current) {
      // first view after (re)join: don't replay history
      primed.current = true;
      return;
    }
    let played = 0;
    for (const e of fresh) {
      // The monster screen plays its own sound when it fires SABOTAGE / DECOY; don't double it.
      if (e.kind === 'ability' && view.role === 'monster') continue;
      const sfx = e.kind === 'sighting' && view.role !== 'monster' && view.threat >= 0.6 ? 'monsterNear' : EVENT_SFX[e.kind];
      if (sfx && played < 3) {
        audio.play(sfx);
        played++;
      }
    }
  }, [view]);

  // stingers
  useEffect(() => {
    if (!result || !room) return;
    const key = `${room.code}:${result.endedAtT}:${result.reason}`;
    if (lastResultKey.current === key) return;
    lastResultKey.current = key;
    const me = room.players.find((p) => p.id === room.youId);
    const myTeam = me?.role === 'monster' ? 'monster' : 'defenders';
    if (result.reason === 'breach') audio.playStinger('breach');
    else if (result.reason === 'capture') audio.playStinger('contained');
    setTimeout(
      () => audio.playStinger(result.winner === myTeam || me?.role === 'spectator' ? 'victory' : 'defeat'),
      result.reason === 'breach' ? 3500 : 1200,
    );
  }, [result, room]);
}
