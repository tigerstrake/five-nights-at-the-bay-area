// The night's big beats, made to land: first contact, the thing at the door, a sprung trap, a breach, dawn.
// A short band across the screen (pointer-events none, ~2 s) plus a sound, once per beat. Reduced flashing
// keeps the band but drops the flash and the slam.
import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import type { DefenderView, Headquarters, MonsterView } from '@fnab/shared';
import { audio, type SfxName } from '../../audio';
import { nodeName } from '../../lib/data';
import { useReduceFlashing } from '../../ui/chrome';

const SHOW_MS = 2300;
/** Seconds before dawn that get their own beat. */
const DAWN_WARN_MS = 60_000;

export interface Moment {
  id: string;
  word: string;
  line: string;
  tone: 'alert' | 'warn' | 'ok' | 'cyan';
  sfx?: SfxName;
}

/** How long the phase-change card holds the centre of the screen (beats wait for it). */
const PHASE_CARD_MS = 4400;

function useMomentQueue(phase: string) {
  const [cur, setCur] = useState<(Moment & { key: number }) | null>(null);
  const queue = useRef<Moment[]>([]);
  const fired = useRef(new Set<string>());
  const busy = useRef(false);
  const holdUntil = useRef(0);
  const lastPhase = useRef(phase);
  if (lastPhase.current !== phase) {
    lastPhase.current = phase;
    holdUntil.current = Date.now() + PHASE_CARD_MS;
  }
  const pump = () => {
    if (busy.current) return;
    const wait = holdUntil.current - Date.now();
    if (wait > 0 && queue.current.length) {
      busy.current = true;
      setTimeout(() => {
        busy.current = false;
        pump();
      }, wait);
      return;
    }
    const next = queue.current.shift();
    if (!next) return;
    busy.current = true;
    setCur({ ...next, key: Date.now() });
    if (next.sfx) audio.play(next.sfx, { volume: 0.9 });
    setTimeout(() => {
      busy.current = false;
      setCur(null);
      pump();
    }, SHOW_MS);
  };
  /** Fire a beat once per id. Beats that pile up wait their turn; stale ones are dropped. */
  const fire = (m: Moment) => {
    if (fired.current.has(m.id)) return;
    fired.current.add(m.id);
    queue.current = [...queue.current.filter((q) => q.tone === 'alert'), m].slice(-2);
    pump();
  };
  /** Record a beat as already happened (state that existed before this screen opened). */
  const skip = (id: string) => fired.current.add(id);
  return { cur, fire, skip };
}

function MomentBand({
  m,
  team,
  contained,
}: {
  m: (Moment & { key: number }) | null;
  team: 'defender' | 'monster';
  /** Render inside a positioned panel (the monster's map) instead of over the whole screen. */
  contained?: boolean;
}) {
  const calm = useReduceFlashing();
  if (!m) return null;
  const color = { alert: '#ff5a63', warn: '#f3d28d', ok: '#7fe8b0', cyan: '#7ff0d0' }[m.tone];
  const flash = { alert: 'rgba(200,30,40,0.28)', warn: 'rgba(212,154,42,0.18)', ok: 'rgba(62,196,122,0.16)', cyan: 'rgba(59,198,214,0.16)' }[m.tone];
  return (
    <>
      {!calm && (
        <div
          key={`f${m.key}`}
          aria-hidden
          className={clsx('fnab-moment-flash pointer-events-none inset-0 z-[36]', contained ? 'absolute' : 'fixed')}
          style={{ background: `radial-gradient(ellipse at center, transparent 30%, ${flash} 100%)` }}
        />
      )}
      <div
        key={m.key}
        role="status"
        aria-live="assertive"
        className={clsx('pointer-events-none inset-x-0 z-[37] flex justify-center', contained ? 'absolute top-[38%]' : 'fixed top-[40%]')}
        data-testid="moment"
        data-moment={m.id}
      >
        <div
          className={clsx(
            'flex w-full max-w-[min(620px,calc(100%-32px))] flex-col items-center border bg-black/85 px-6 py-3 text-center shadow-[0_0_80px_rgba(0,0,0,0.9)]',
            calm ? 'fnab-moment-calm' : 'fnab-moment',
          )}
          style={{ borderColor: `${color}66` }}
        >
          <span
            className={clsx(
              'leading-none',
              team === 'monster'
                ? 'mx-slab-title !text-[clamp(34px,5vw,58px)]'
                : 'font-mono text-[clamp(24px,3.4vw,38px)] font-semibold uppercase tracking-[0.24em]',
            )}
            style={{ color }}
          >
            {m.word}
          </span>
          <span className={clsx('mt-1.5 text-[14px]', team === 'monster' ? 'text-[#eadfcf]' : 'text-text')}>{m.line}</span>
        </div>
      </div>
    </>
  );
}

export function DefenderMoments({ view, t, hq, spectator }: { view: DefenderView; t: number; hq: Headquarters; spectator: boolean }) {
  const { cur, fire, skip } = useMomentQueue(view.phase);
  const prevHeld = useRef<string | null>(view.held?.nodeId ?? null);
  const prevBreach = useRef<string | null>(view.breach?.approachId ?? null);
  const primed = useRef(false);
  useEffect(() => {
    // The first view after a (re)join only records state; beats are for things that happen while you watch.
    if (!primed.current) {
      primed.current = true;
      if (view.sightings.some((s) => !s.flaggedFalse && s.source === 'camera')) skip('contact');
      if (view.matchEndsAt - t < DAWN_WARN_MS) skip('dawn');
      return;
    }
    if (view.ended) return;
    const first = view.sightings.find((s) => !s.flaggedFalse && s.source === 'camera');
    if (first)
      fire({ id: 'contact', word: 'Contact', line: `Something on the camera at ${nodeName(first.nodeId)}`, tone: 'warn', sfx: 'monsterNear' });
    const atDoor = [...view.sightings].reverse().find((s) => !s.flaggedFalse && t - s.t < 6000 && hq.approaches.some((a) => a.fromNode === s.nodeId));
    if (atDoor && !view.breach && !view.held) {
      const ap = hq.approaches.find((a) => a.fromNode === atDoor.nodeId)!;
      fire({ id: `door:${ap.id}:${Math.floor(t / 45_000)}`, word: 'At the door', line: `${ap.door}. Seal it.`, tone: 'alert' });
    }
    const held = view.held?.nodeId ?? null;
    if (held && held !== prevHeld.current)
      fire({
        id: `trap:${Math.floor(t / 1000)}`,
        word: 'Trap sprung',
        line: spectator ? `Held at ${nodeName(held)}` : `Held at ${nodeName(held)}. Engage containment.`,
        tone: 'warn',
      });
    prevHeld.current = held;
    const breach = view.breach?.approachId ?? null;
    if (breach && breach !== prevBreach.current) {
      const ap = hq.approaches.find((a) => a.id === breach);
      fire({ id: `breach:${Math.floor(t / 1000)}`, word: 'Breach', line: `${ap?.door ?? 'A door'} is being forced`, tone: 'alert' });
    }
    prevBreach.current = breach;
    if (view.phase !== 'preparation' && view.matchEndsAt - t < DAWN_WARN_MS && view.matchEndsAt - t > 0)
      fire({ id: 'dawn', word: 'Dawn in 60 s', line: 'Hold the doors. It will rush them now.', tone: 'ok', sfx: 'phaseChange' });
  });
  return <MomentBand m={cur} team="defender" />;
}

export function MonsterMoments({
  view,
  t,
  hq,
  hopsToHq,
}: {
  view: MonsterView;
  t: number;
  hq: Headquarters;
  hopsToHq: number | null;
}) {
  const { cur, fire, skip } = useMomentQueue(view.phase);
  const prevBreach = useRef<string | null>(view.breach?.approachId ?? null);
  const primed = useRef(false);
  useEffect(() => {
    if (!primed.current) {
      primed.current = true;
      if (view.exposures.length) skip('seen');
      if (view.matchEndsAt - t < DAWN_WARN_MS) skip('dawn');
      if (hopsToHq === 0) skip('door');
      return;
    }
    if (view.ended) return;
    const seen = view.exposures[0];
    if (seen) fire({ id: 'seen', word: 'Seen', line: `They may have caught you at ${nodeName(seen.nodeId)}`, tone: 'warn' });
    if (hopsToHq === 0 && view.self.spawned && !view.self.moving) {
      const ap = hq.approaches.find((a) => a.fromNode === view.self.nodeId);
      fire({ id: 'door', word: 'Their door', line: ap ? `${ap.door}. Break it.` : 'Break it.', tone: 'alert', sfx: 'monsterNear' });
    }
    // A sprung trap needs no band here: the trapped overlay takes over the map at once.
    const breach = view.breach?.approachId ?? null;
    if (breach && breach !== prevBreach.current) {
      const ap = hq.approaches.find((a) => a.id === breach);
      fire({ id: `breach:${Math.floor(t / 1000)}`, word: 'Breaking in', line: `${ap?.door ?? 'The door'} is giving way`, tone: 'alert' });
    }
    prevBreach.current = breach;
    if (view.phase !== 'preparation' && view.matchEndsAt - t < DAWN_WARN_MS && view.matchEndsAt - t > 0)
      fire({ id: 'dawn', word: 'Dawn in 60 s', line: 'Break in before the sun comes up.', tone: 'warn', sfx: 'phaseChange' });
  });
  return <MomentBand m={cur} team="monster" contained />;
}
